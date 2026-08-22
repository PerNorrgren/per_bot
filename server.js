// ── BUILD MARKER: nl-contacts-v1 — 2026-07-02 19:40 UTC ──
// (Delete this comment any time — it's just here so you can confirm the
// copy you grabbed from Downloads is actually this version, not a stale one.)

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const fs         = require('fs');
const fsp        = require('fs/promises');
const os         = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const multer     = require('multer');
const { parse: csvParse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { v4: uuidv4 } = require('uuid');
const fetch      = require('node-fetch');
const cookieParser = require('cookie-parser');
const crypto       = require('crypto');

// ── Stripe ──
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;

const db         = require('./db');
const auth       = require('./auth');
const prompts    = require('./prompts');
const { startCronJobs } = require('./cron');
const media      = require('./media');
const { convertPdfToEpub } = require('./pdf-to-epub');
const { convertPptxToSlides } = require('./pptx-to-slides');
const sms        = require('./sms');

// ── Config ──
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
// Per Bot 33f — was hardcoded to claude-opus-4-6 below in anthropicFetch().
// Switched to Sonnet 5 by default (currently $2/$10 per MTok introductory
// pricing through Aug 31 2026, vs Opus's $5/$25) to stretch API credits
// further — this one call is shared by every Claude request the app makes
// (Talk conversations, Tomte, legal doc translation, MOTD generation), so
// this single line controls all of it. Override with an env var on
// Railway if quality on a specific workload ever needs Opus back, with no
// code change or redeploy required.
const ANTHROPIC_MODEL     = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID           = process.env.VOICE_ID;
// Tomte-specific default (Per Bot 8) — used when a person's language is
// Dutch and they haven't explicitly picked their own voice. Trying this
// out with Mare's existing (non-professionally-sampled) voice first; if
// it works well this just stays as-is, no further change needed since
// it's already a proper env var rather than anything hardcoded.
const MARE_VOICE_ID      = process.env.MARE_VOICE_ID;
// Per Bot 9: Tomte's voice is opt-in per person now, defaulting to off —
// each connection tracks its own preference (see `voiceRequested` in the
// tomteWss connection handler below), sent by the widget's speaker toggle.
// This flag stays as a global kill-switch in case voice needs disabling
// app-wide again for any reason (e.g. overlap with Talk audio turns out to
// be a bigger problem than expected) — leave it true for normal operation.
const TOMTE_VOICE_ENABLED = true;
const DEEPGRAM_API_KEY   = process.env.DEEPGRAM_API_KEY;
const VOICE_SPEED        = parseFloat(process.env.VOICE_SPEED || '0.82');
// Per Bot 34 — signal scripts (pre-cached guided practices) read noticeably
// faster than the slow, contemplative pace they're written for, once
// actually heard. Ordinary conversation speed (0.82) is fine for Talk's
// live back-and-forth, but a guided practice — counted breaths, moving
// attention from one part of the body to another — needs real room to
// breathe that conversational pace doesn't give it. Deliberately slower.
const SIGNAL_SCRIPT_VOICE_SPEED = parseFloat(process.env.SIGNAL_SCRIPT_VOICE_SPEED || '0.72');
const PORT               = process.env.PORT || 3000;
// ── 1:1 calling (Per Bot 12) — TURN relay ──
// A public STUN server (Google's) is enough for most direct browser-to-
// browser connections, but roughly 15-20% of real-world calls sit behind
// a NAT/firewall strict enough that direct connection fails outright —
// those need a TURN server to relay media instead. TURN needs real UDP
// ports open, which isn't something this Railway app itself can provide
// (Railway's networking model is built around HTTP/WS, not arbitrary UDP
// relay) — it wants its own small VPS running Coturn, configured here via
// env vars once that's set up. Calls still work without these set (STUN-
// only), just with that same 15-20% failure rate for anyone whose network
// can't connect directly.
const TURN_URL           = process.env.TURN_URL || null;       // e.g. turn:your-vps-ip:3478
const TURN_USERNAME      = process.env.TURN_USERNAME || null;
const TURN_CREDENTIAL    = process.env.TURN_CREDENTIAL || null;

// ── Voice picker (Per Bot 7) ── Backs the My Account voice picker: rather
// than hand-maintain a curated list of voice_ids in code (which drifts the
// moment Per adds/removes a voice in ElevenLabs), fetch the real list from
// ElevenLabs's own /v1/voices — this naturally returns only voices Per's
// account actually has access to (premade defaults + anything he's added
// or cloned), not the entire public voice library. Cached in memory for an
// hour since this doesn't change often and there's no reason to hit
// ElevenLabs on every account-page load.
let voicesCache = { data: null, fetchedAt: 0 };
const VOICES_CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchElevenLabsVoices() {
  if (voicesCache.data && (Date.now() - voicesCache.fetchedAt) < VOICES_CACHE_TTL_MS) {
    return voicesCache.data;
  }
  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Connection': 'close' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`ElevenLabs voices fetch failed: ${response.status}`);
  const json = await response.json();
  const voices = (json.voices || []).map(v => ({
    voice_id:    v.voice_id,
    name:        v.name,
    preview_url: v.preview_url || null,
    category:    v.category || null
  }));
  voicesCache = { data: voices, fetchedAt: Date.now() };
  return voices;
}
// Scaleway Transactional Email (TEM) — EU-sovereign, transactional-only,
// no US subprocessors. Replaces Brevo. SCW_SECRET_KEY and SCW_PROJECT_ID
// come from an IAM application's API key in the Scaleway console; the
// sending domain must be verified there first (SPF/DKIM/MX records) before
// any email will actually deliver — that's a one-time console setup step,
// not something this code can do on its own.
const SCW_SECRET_KEY     = process.env.SCW_SECRET_KEY;
const SCW_PROJECT_ID     = process.env.SCW_PROJECT_ID;
const SCW_TEM_REGION     = process.env.SCW_TEM_REGION || 'fr-par';
const EMAIL_FROM         = process.env.EMAIL_FROM || 'per@deepermindfulness.org';
const APP_URL            = process.env.APP_URL || 'https://mirror-production-018d.up.railway.app';
// Per Bot 22 — OpenAI's GPT Image API, for the sumi-e generator in the
// newsletter editor's "Generate & insert" button (see
// /api/admin/comms-ai-generate). Nothing else in this app calls OpenAI —
// this is the one place. Needs API Organization Verification completed
// in the OpenAI developer console before the GPT Image models will
// actually respond, separate from just having a valid key.
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;

// ── Express + HTTP server ──
const app    = express();
const server = http.createServer(app);

// ── Stripe webhook — MUST be registered before app.use(express.json()) below. ──
// Stripe signature verification needs the exact raw request bytes; if the global
// json() parser runs first, it consumes the body and re-parses it into an object,
// and stripe.webhooks.constructEvent() can never verify against that — it silently
// fails signature verification on every single webhook call. Confirmed this by
// testing directly: with json() registered first, req.body inside a route with its
// own express.raw() middleware was already a parsed object, not a Buffer. Moving
// this route above the global parser (Express runs middleware/routes in
// registration order, and a route that sends a response stops the chain there)
// fixes it without needing changes anywhere else.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.json({ received: true });

  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
      console.warn('[stripe webhook] no STRIPE_WEBHOOK_SECRET set — skipping signature verification');
    }
  } catch(e) {
    console.error('[stripe webhook] signature verification failed:', e.message);
    return res.status(400).json({ error: 'Webhook signature verification failed.' });
  }

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId  = session.client_reference_id || session.metadata?.user_id;
        if (!userId) break;

        // Course enrolment payment — separate flow from the membership
        // upgrade below, branched on metadata.type set when the session was
        // created (see /api/client/enrol).
        if (session.metadata?.type === 'course_enrolment') {
          const courseInstanceId = session.metadata?.course_instance_id;
          if (!courseInstanceId) break;
          const alreadyEnrolled = db.getEnrolmentForUserAndInstance(userId, courseInstanceId);
          if (alreadyEnrolled) { console.log(`[stripe] course_enrolment — user ${userId} already enrolled in ${courseInstanceId}, skipping duplicate`); break; }

          const enrolId = uuidv4();
          db.createEnrolment(enrolId, userId, courseInstanceId, 'paid', session.amount_total || 0, session.payment_intent || null);

          const user = db.getUser(userId);
          const instance = db.getCourseInstance(courseInstanceId);
          if (user?.email && instance) {
            const b = brand();
            await sendEmail(user.email, `You're enrolled — ${instance.title}`,
              `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
                <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:24px">${b.name}</div>
                <h2 style="font-weight:normal;font-size:22px;margin-bottom:16px">You're in, ${user.name}.</h2>
                <p style="font-size:15px;line-height:1.8;margin-bottom:20px">Payment received — you're enrolled in <strong>${instance.title}</strong>. Start whenever you're ready.</p>
                <a href="${APP_URL}/client/" style="display:inline-block;padding:12px 28px;border-radius:8px;background:#2d7873;color:#fff;text-decoration:none;font-size:13px;letter-spacing:0.08em">Go to your course</a>
                <hr style="border:none;border-top:1px solid #e8e8e8;margin:32px 0"/>
                <p style="font-size:12px;color:#aaa">${b.tagline}</p>
              </div>`
            );
          }
          console.log(`[stripe] course_enrolment completed — user ${userId} → instance ${courseInstanceId}`);
          break;
        }

        // Membership upgrade (existing flow, unchanged).
        const tier    = parseInt(session.metadata?.tier || '1');
        const billing = session.metadata?.billing;

        let expiresAt = null;
        if (billing === 'monthly') {
          const d = new Date(); d.setMonth(d.getMonth() + 1);
          expiresAt = d.toISOString();
        } else if (billing === 'annual') {
          const d = new Date(); d.setFullYear(d.getFullYear() + 1);
          expiresAt = d.toISOString();
        }
        // lifetime: no expiry

        const subId = session.subscription || null;
        db.setMemberTier(userId, tier, expiresAt, null, session.customer, subId);
        // Per Bot 18 — same reasoning as invoice.payment_succeeded above:
        // a fresh subscription is just as unambiguous a resolution as a
        // renewal, whether this is a Savers case resubscribing or someone
        // upgrading who was never flagged at all (harmless no-op then).
        db.clearSaversState(userId);

        // Referral reward (Per Bot 22) — this is genuinely this person's
        // FIRST payment turning into a real membership (not a renewal;
        // those go through invoice.payment_succeeded below, which doesn't
        // touch referrals at all), so it's the one moment a referral
        // reward can fire. referral_rewarded is the idempotency guard —
        // sending this webhook twice for the same event (which Stripe
        // does do) or the person later cancelling and resubscribing both
        // hit this same code path, but only the very first time actually
        // credits anyone.
        try {
          const referredUser = db.getUser(userId);
          if (referredUser && referredUser.referred_by && !referredUser.referral_rewarded) {
            const referrer = db.getUser(referredUser.referred_by);
            if (referrer) {
              const base = referrer.member_expires_at && new Date(referrer.member_expires_at) > new Date()
                ? new Date(referrer.member_expires_at) : new Date();
              base.setDate(base.getDate() + 30);
              // setMemberTier, not setMemberExpiry — a referrer who's
              // never paid (tier 0) needs an actual tier granted, not
              // just a date with nothing behind it; Math.max keeps an
              // already-paying referrer at whatever tier they're on
              // rather than downgrading them to the base tier.
              db.setMemberTier(referrer.id, Math.max(referrer.member_tier || 0, 1), base.toISOString(), referrer.trial_ends_at, null, null);
              db.markReferralRewarded(userId);
              db.createReferralEvent(uuidv4(), referrer.id, userId, referredUser.name, 30);
              console.log(`[referral] ${referrer.id} credited 30 days — referred ${userId} just paid for the first time`);
              // Per Bot 18 — the reward itself already fired above; this is
              // just the notification. Before this, a referrer only found
              // out via a small in-app badge next time they happened to
              // open the app — worth an actual email given it's genuinely
              // good news for them.
              if (referrer.email) {
                const b = brand();
                sendEmail(referrer.email, `${referredUser.name} joined — you've got a free month`,
                  `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
                    <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
                    <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Thank you, ${referrer.name}.</h1>
                    <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:20px">${referredUser.name} joined using your link, and just became a member. A month's been added to your own membership, on the house — nothing for you to do, it's already there.</p>
                    <p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/account" style="color:#2d6a4f">See it in your account →</a></p>
                    <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
                    <p style="font-size:12px;color:#aaa">${b.name}</p>
                  </div>`
                ).catch(e => console.error('[referral] thank-you email failed:', e.message));
              }
            }
          }
        } catch (e) { console.error('[referral] reward error:', e.message); }

        // Send welcome email
        const user = db.getUser(userId);
        if (user?.email) {
          const b = brand();
          await sendEmail(user.email,
            `Welcome to ${b.name} — you're a Member`,
            `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
              <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:24px">${b.name}</div>
              <h2 style="font-weight:normal;font-size:22px;margin-bottom:16px">You're in, ${user.name}.</h2>
              <p style="font-size:15px;line-height:1.8;margin-bottom:20px">Your membership is active. The full practice library is open, and your daily message starts tomorrow morning.</p>
              <a href="${APP_URL}/client/" style="display:inline-block;padding:12px 28px;border-radius:8px;background:#2d7873;color:#fff;text-decoration:none;font-size:13px;letter-spacing:0.08em">Go to your practice space</a>
              <hr style="border:none;border-top:1px solid #e8e8e8;margin:32px 0"/>
              <p style="font-size:12px;color:#aaa">${b.tagline} · <a href="${APP_URL}/account" style="color:#888">Manage my account</a></p>
            </div>`
          );
        }
        console.log(`[stripe] checkout.session.completed — user ${userId} → tier ${tier}`);
        break;
      }

      case 'invoice.payment_succeeded': {
        // Subscription renewal — extend expiry
        const invoice = event.data.object;
        const subId   = invoice.subscription;
        if (!subId) break;
        // Find user by stripe_subscription_id
        const userRec = db.getUserByStripeSubscription ? db.getUserByStripeSubscription(subId) : null;
        if (userRec) {
          const d = new Date(); d.setMonth(d.getMonth() + 1);
          db.setMemberTier(userRec.id, userRec.member_tier || 1, d.toISOString(), null, null, null);
          // Per Bot 18 — a real payment landing resolves any Savers
          // tracking outright, cancellation or payment-failure alike. No
          // partial credit for "still checking in" — a successful renewal
          // is unambiguous.
          //
          // Per's request, after a real customer got confused by exactly
          // this gap — clearing the tracking here was always correct for
          // access, but silent. Specifically for the payment_failure case
          // (not cancellation — someone who chose to leave and then pays
          // again is a different, better story that doesn't need this
          // particular email), this now sends a short "all sorted" email
          // before clearing state, so whoever got the earlier "didn't go
          // through" notice — including cases where Stripe's own retry
          // resolves it within minutes, before they've done anything —
          // gets an equally direct follow-up instead of being left to
          // wonder, the way Jude was.
          if (userRec.savers_type === 'payment_failure' && userRec.email) {
            await emailSaversFailureResolved(userRec);
          }
          if (userRec.savers_type) db.clearSaversState(userRec.id);
        }
        break;
      }

      // Per Bot 18 — Savers Protocol, cancellation path, part 1: fires the
      // moment someone SCHEDULES a cancellation (cancel_at_period_end
      // flips true), which is well before customer.subscription.deleted
      // below — that only fires once the term actually ends. This is
      // where the day-0 acknowledgment goes out; their paid time is
      // completely untouched here, this is just acknowledging the
      // decision. Also handles someone changing their mind before the
      // term ends (cancel_at_period_end flips back to false) by clearing
      // the tracking outright.
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const prevCancelFlag = event.data.previous_attributes?.cancel_at_period_end;
        const userRec = db.getUserByStripeCustomer ? db.getUserByStripeCustomer(sub.customer) : null;
        if (!userRec) break;
        if (sub.cancel_at_period_end && prevCancelFlag === false && !userRec.savers_type) {
          const periodEndStr = sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
            : 'the end of your current term';
          db.startSaversCancellation(userRec.id, sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null, userRec.member_tier || 1);
          if (userRec.email) await emailSaversCancelDay0(userRec, periodEndStr);
        } else if (!sub.cancel_at_period_end && prevCancelFlag === true && userRec.savers_type === 'cancellation' && !userRec.savers_grace_started_at) {
          // Changed their mind before the term even ended — grace never
          // started, safe to just clear it, nothing to undo.
          db.clearSaversState(userRec.id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        // Per Bot 18 — this now only means "real access has actually
        // ended," for either reason (explicit cancellation reaching term
        // end, or Stripe's own retries finally being exhausted on a
        // payment-failure case we may not have caught in time). Rather
        // than downgrading immediately, this starts the BONUS 14-day
        // grace period — a genuine extension beyond what was ever paid
        // for, not a continuation of it. Only falls through to an
        // immediate downgrade if Savers is already resolved/not
        // applicable for this person (e.g. someone with no subscription
        // history at all being cleaned up some other way).
        const sub    = event.data.object;
        const custId = sub.customer;
        const userRec = db.getUserByStripeCustomer ? db.getUserByStripeCustomer(custId) : null;
        if (userRec) {
          if (userRec.savers_type === 'payment_failure' && userRec.savers_grace_started_at) {
            // Already being handled via the failure path (which starts
            // its own countdown immediately on first failure, faster than
            // Stripe's own retry schedule) — nothing new to do here.
            break;
          }
          const priorTier = userRec.savers_last_prior_tier || userRec.member_tier || 1;
          db.startSaversGrace(userRec.id, 'cancellation', priorTier);
          if (userRec.email) await emailSaversCancelGrace0(userRec);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const custId  = invoice.customer;
        const userRec = db.getUserByStripeCustomer ? db.getUserByStripeCustomer(custId) : null;
        if (userRec?.email) {
          const b = brand();
          // Generate a real billing portal session for THIS customer rather
          // than a static link — a fixed URL can't be correct per-customer
          // anyway, and was previously hardcoded to one specific Stripe
          // account's test-mode portal.
          let portalUrl = `${APP_URL}/account`;
          try {
            if (stripe && custId) {
              const portal = await stripe.billingPortal.sessions.create({ customer: custId, return_url: `${APP_URL}/account` });
              portalUrl = portal.url;
            }
          } catch(e) { console.error('[stripe billing portal]', e.message); }
          await sendEmail(userRec.email,
            `Payment issue with your ${b.name} membership`,
            `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
              <p style="font-size:15px;line-height:1.8;margin-bottom:20px">We couldn't process your membership payment. Please update your payment details to keep your access.</p>
              <a href="${portalUrl}" style="display:inline-block;padding:12px 28px;border-radius:8px;background:#2d7873;color:#fff;text-decoration:none;font-size:13px">Update payment details</a>
            </div>`
          );
          // Per Bot 18 — Savers Protocol, payment-failure path. Only
          // treated as a genuine failure (distinct 14-day grace, warm
          // day-0 email) if this person isn't already mid-cancellation —
          // a failed renewal attempt on a subscription someone already
          // chose to end isn't a new signal, it's just Stripe's normal
          // behaviour for a cancel-at-period-end subscription reaching
          // its date. Also only triggers once per episode — repeated
          // retry failures on the same underlying issue don't restart the
          // clock, since savers_type is already set after the first one.
          if (!userRec.savers_type) {
            db.startSaversGrace(userRec.id, 'payment_failure', userRec.member_tier || 1);
            await emailSaversFailureDay0(userRec);
          }
        }
        break;
      }

      default:
        console.log(`[stripe webhook] unhandled event: ${event.type}`);
    }
  } catch(e) {
    console.error('[stripe webhook] handler error:', e.message);
  }

  res.json({ received: true });
});


app.use(express.json());
app.use(cookieParser());
// NOTE: uploads are served exclusively via the auth-checked /uploads/:filename route below.
// (Previously this also had an unguarded express.static('/uploads') line ahead of that route,
// which meant any file could be fetched by anyone who knew or guessed the filename, regardless
// of tier — Express matches middleware in registration order, so the static middleware served
// the file before the auth check ever ran. Removed as part of the R2 migration security pass.)

// ── Staging environment marker (Per Bot 34) ──
// Set APP_ENV=staging in Railway's staging environment (only) and two
// things happen automatically, with zero effect on production where this
// var is unset: (1) an unmissable banner on every single HTML page, so
// nobody testing here mistakes it for the live app — patches
// res.sendFile once, here, rather than editing every page individually,
// so it applies everywhere automatically, including pages added later;
// (2) all cron jobs are skipped entirely (see the startCronJobs() call
// at the bottom of this file) — no scheduled emails/SMS can ever fire
// from a staging deployment, even if it were accidentally pointed at
// real subscriber data.
const IS_STAGING = (process.env.APP_ENV || '').toLowerCase() === 'staging';
if (IS_STAGING) {
  console.log('[staging] APP_ENV=staging — banner injection active, cron jobs disabled');
  app.use((req, res, next) => {
    const originalSendFile = res.sendFile.bind(res);
    res.sendFile = function (filePath, ...args) {
      if (typeof filePath === 'string' && filePath.endsWith('.html')) {
        fs.readFile(filePath, 'utf8', (err, html) => {
          if (err) return originalSendFile(filePath, ...args);
          const banner = `<div style="position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c0392b;color:#fff;text-align:center;font-family:sans-serif;font-size:12px;padding:5px 8px;letter-spacing:0.05em;box-shadow:0 1px 6px rgba(0,0,0,0.4)">STAGING — not the live app. Test data only, nothing here is real.</div><div style="height:24px"></div>`;
          const injected = /<body[^>]*>/i.test(html)
            ? html.replace(/<body([^>]*)>/i, `<body$1>${banner}`)
            : banner + html;
          res.set('Content-Type', 'text/html; charset=UTF-8');
          res.send(injected);
        });
      } else {
        originalSendFile(filePath, ...args);
      }
    };
    next();
  });
}

// ── File upload ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => { cb(null, uuidv4() + path.extname(file.originalname)); }
});
// NOTE: this limit only matters for the legacy disk-upload fallback path (used if R2 isn't
// configured, or if the presign step fails). The primary path — browser uploads directly to
// R2 via a presigned URL — never passes through multer/Express at all, so it has no size
// ceiling here. Raised generously so the fallback isn't a silent trap during the migration.
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── Helpers ──
function stripMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/#{1,6} */g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^[\-\*] +/gm, '')
    .replace(/\n\n\n+/g, '\n\n')
    .trim();
}

// ── Email ──
// Reads this deployment's own identity (Path A: one deployment per
// facilitator/org) so email templates never hardcode a specific
// organization's name — db.getAppConfig() is synchronous (sql.js is
// in-memory), so this is safe to call anywhere without await.
// ── Shared test-send destination (Per Bot 7) ──
// Every test-send button (MOTD/Reminders/Renewal/Newsletter, email and SMS)
// resolves its target the same way: an explicit override typed into that
// specific field wins every time; otherwise fall back to the one saved
// test_email/test_phone in Settings (so QA can point everything at one
// inbox/number without retyping it into every modal); otherwise fall back
// to the logged-in admin's own email/phone, same as before this existed.
function resolveTestEmail(explicit, reqUserEmail) {
  if (explicit && explicit.trim()) return explicit.trim();
  const cfg = db.getAppConfig() || {};
  if (cfg.test_email) return cfg.test_email;
  return reqUserEmail || '';
}
function resolveTestPhone(explicit, adminPhone) {
  if (explicit && explicit.trim()) return explicit.trim();
  const cfg = db.getAppConfig() || {};
  if (cfg.test_phone) return cfg.test_phone;
  return adminPhone || '';
}

// Fills {{token}} placeholders in an admin-editable message body. Unknown
// tokens are dropped rather than left literal — a stray {{typo}} disappears
// instead of showing up in a real client's inbox.
function fillTemplate(str, tokens) {
  return String(str || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (tokens[k] !== undefined ? tokens[k] : ''));
}

// ── Unified message editor (Per Bot 19) ── One real token set, reused by
// every context that sends an admin-editable message to a specific person
// — Newsletters, Trial sequence, Savers Protocol, Campaign steps,
// Reminder, Renewal reminder, Birthday. Previously each of these built its
// own version of this logic (or, for Trial/Savers/Campaign/Reminder/
// Renewal/Birthday, didn't build it at all — those six only ever
// substituted {{name}}). Consolidating here means {{invite_link}} and
// {{expiry_date}} now work identically everywhere, and any future fix
// (like the has_login/password_hash check below) only has to happen once.
//
// opts.offerId/opts.sourceTag: only meaningful for a non-logged-in
// recipient's invite_link — carries a real offer's trial length and shows
// up in the Funnel report, the same query-string shape /promo/<code>
// already uses. Omit both for a single-recipient context (trial/savers/
// reminder/renewal/birthday all trigger per-user, with no offer to tie
// to); pass them through for batch sends tied to a campaign or offer.
//
// expiry_date checks trial_ends_at first, then member_expires_at — the
// newsletter-only version of this logic (before this consolidation) only
// ever checked trial_ends_at, so a paying member's real renewal/expiry
// date would have rendered blank. Genuine fix, not just a relocation.
function buildMessageTokens(user, opts = {}) {
  // A preview-only "user" (test-send with no matching real account) has
  // no real id — nothing to write an invite token against, so this
  // returns the same obviously-fake placeholder every preview always used.
  if (!user || !user.id || user.id === 'test') {
    return {
      name: user?.name || 'there',
      invite_link: `${APP_URL}/join/EXAMPLE-TOKEN-not-a-real-link`,
      expiry_date: '[example date]',
      ...(opts.extra || {}),
    };
  }
  const hasLogin = !!(user.has_login || user.password_hash);
  const linkParams = new URLSearchParams();
  if (opts.offerId) {
    const offer = db.getOffer(opts.offerId);
    if (offer) linkParams.set('promoCode', offer.code);
  }
  if (opts.sourceTag) linkParams.set('src', opts.sourceTag);
  const linkQuery = linkParams.toString() ? ('?' + linkParams.toString()) : '';
  const inviteLink = hasLogin
    ? `${APP_URL}/login?email=${encodeURIComponent(user.email || '')}`
    : `${APP_URL}/join/${db.ensureInviteToken(user.id)}${linkQuery}`;
  const rawExpiry = user.trial_ends_at || user.member_expires_at;
  const expiryDate = rawExpiry
    ? new Date(rawExpiry).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  // Per's request — a reminder/confirmation email needs a link that
  // "opens the app to the course page," which for someone not currently
  // logged in means surviving login/join first (see the next= handling
  // added to login.html and join.html). Deliberately reuses the exact
  // same hasLogin branch already computed above for inviteLink, rather
  // than a second parallel link-building path — the only difference is
  // appending next= pointing at the course.
  let courseLink = null;
  if (opts.courseInstanceId) {
    const nextParam = encodeURIComponent(`/client/?course=${opts.courseInstanceId}`);
    courseLink = hasLogin
      ? `${APP_URL}/login?email=${encodeURIComponent(user.email || '')}&next=${nextParam}`
      : `${APP_URL}/join/${db.ensureInviteToken(user.id)}${linkQuery}${linkQuery ? '&' : '?'}next=${nextParam}`;
  }
  return { name: user.name || 'there', invite_link: inviteLink, expiry_date: expiryDate, ...(courseLink ? { course_link: courseLink } : {}), ...(opts.extra || {}) };
}

// Per Bot 19 — generalizes the newsletter test-send's "if this address is
// a real account, send them a genuine working message" logic so every
// test-send button across the app behaves the same way: a real account
// gets its own real invite link/expiry date (a genuine one-off send, not
// just a wording check); anything else falls back to an obviously-fake
// preview so {{tokens}} are still visibly working before a real send.
function resolveTestRecipientTokens(toEmail, adminUser) {
  const realUser = db.getUserByEmail((toEmail || '').toLowerCase());
  if (realUser) {
    return { toEmail, isReal: true, tokens: buildMessageTokens(realUser) };
  }
  return {
    toEmail,
    isReal: false,
    tokens: {
      name: adminUser?.name || 'there',
      invite_link: `${APP_URL}/join/EXAMPLE-TOKEN-not-a-real-link`,
      expiry_date: '[example date]',
    },
  };
}

// Per Bot 18 — renders admin-editable email body text as one <p> per
// blank-line-separated paragraph, rather than forcing everything into a
// single block like the older reminder templates do. Lets the trial
// sequence's default copy actually use the felt-experience → what-it-is →
// invitation shape as three real paragraphs, and an admin editing it later
// gets the same shape back, not one run-on block.
function renderEmailParagraphs(text) {
  return String(text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:20px">${p}</p>`).join('');
}

// Small helper — an R2 object's .Body is a readable stream; this reads
// it fully into a string, used where the content itself needs parsing
// (the EPUB OPF manifest, offline-manifest route below) rather than
// piping straight through to a response.
function streamToString(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (c) => chunks.push(c));
    readable.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    readable.on('error', reject);
  });
}

function brand() {
  const cfg = db.getAppConfig() || {};
  return {
    name: cfg.brand_name || 'Deeper Mindfulness',
    tagline: cfg.tagline || 'Making the practices land and last for life.',
    contactEmail: cfg.contact_email || EMAIL_FROM,
    logoUrl: cfg.logo_url || null,
  };
}

// ── Localized email templates ──
// Translates an English template ONCE per (template, language) pair and
// caches it — every subsequent send just interpolates that specific user's
// details into the cached result, English or translated. Placeholders use
// {{token}} syntax deliberately, not JS template-literal ${...} — the whole
// point is the template string itself gets sent to Claude for translation
// as literal text, so it can't already be interpolated by the time that
// happens.
async function getLocalizedTemplate(templateKey, language, subjectTemplate, htmlTemplate) {
  if (!language || language === 'en') return { subject: subjectTemplate, html: htmlTemplate };

  const cached = db.getTranslatedTemplate(templateKey, language);
  if (cached) return { subject: cached.subject, html: cached.html };

  try {
    const languageName = LANGUAGE_NAMES[language] || language;
    const raw = await callClaude(
      'You translate email templates. Preserve every {{placeholder}} token exactly as written, character for character, and every HTML tag and attribute exactly as written. Only translate the human-readable text content. Respond with ONLY a JSON object: {"subject":"...","html":"..."} — no preamble, no markdown fences, no commentary.',
      [{ role: 'user', content: `Translate this email template into ${languageName}.\n\nSUBJECT: ${subjectTemplate}\n\nHTML:\n${htmlTemplate}` }],
      2000
    );
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); }
    if (!parsed.subject || !parsed.html) throw new Error('Translation response missing subject or html.');
    db.saveTranslatedTemplate(uuidv4(), templateKey, language, parsed.subject, parsed.html);
    return parsed;
  } catch(e) {
    console.error(`[template translation] ${templateKey}/${language}:`, e.message);
    return { subject: subjectTemplate, html: htmlTemplate }; // fall back to English rather than fail the send entirely
  }
}

function interpolate(str, values) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => (values[key] ?? ''));
}

// englishTemplate: { subject, html } using {{token}} placeholders.
// values: the actual data for THIS send — filled in after translation, so
// the same cached translated template serves every recipient.
async function sendLocalizedEmail(templateKey, language, englishTemplate, values, toEmail) {
  const { subject, html } = await getLocalizedTemplate(templateKey, language, englishTemplate.subject, englishTemplate.html);
  return sendEmail(toEmail, interpolate(subject, values), interpolate(html, values));
}

// Rough plain-text fallback derived from the HTML body — Scaleway's API
// accepts both text and html, and providing a text alternative is good
// deliverability practice regardless of provider (some spam filters
// penalise HTML-only mail). Doesn't need to be pretty, just present.
function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

// meta: { kind, newsletterId, userId, logId } — all optional. logId is only
// passed by the newsletter batch sender below, which pre-writes a 'pending'
// row for every recipient before this function ever runs; every other
// caller (welcome emails, password resets, reminders, message alerts —
// anything calling sendEmail directly) gets a fresh log row created and
// resolved right here, with zero changes needed at any of those call
// sites. Returns {ok, id, error} — id is Scaleway's own email id, useful
// later for asking Scaleway directly what happened to this specific send.
async function sendEmail(to, subject, html, meta = {}) {
  const kind = meta.kind || 'other';
  const id = meta.logId || uuidv4();
  if (!meta.logId) db.logEmailPending(id, kind, to, subject, meta.newsletterId, meta.userId);
  if (!SCW_SECRET_KEY || !SCW_PROJECT_ID) {
    console.log('SCW_SECRET_KEY/SCW_PROJECT_ID not set — skipping email to', to);
    db.updateEmailLogResult(id, 'failed', null, 'Email not configured (missing Scaleway credentials).', html);
    return { ok: false, error: 'Email not configured.' };
  }
  try {
    const res = await fetch(`https://api.scaleway.com/transactional-email/v1alpha1/regions/${SCW_TEM_REGION}/emails`, {
      method: 'POST',
      headers: { 'X-Auth-Token': SCW_SECRET_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: { name: brand().name, email: EMAIL_FROM },
        to: [{ email: to }],
        subject,
        text: htmlToText(html),
        html,
        project_id: SCW_PROJECT_ID,
      })
    });
    const data = await res.json().catch(() => {});
    if (!res.ok) {
      console.error('Scaleway TEM error:', res.status, data);
      const errMsg = (data && (data.message || JSON.stringify(data))) || `HTTP ${res.status}`;
      db.updateEmailLogResult(id, 'failed', null, errMsg, html);
      return { ok: false, error: errMsg };
    }
    // Scaleway wraps the result in an `emails` array (even for a single
    // recipient) on send, but returns a bare object on GET-by-id later —
    // handling both shapes here rather than assuming one.
    const scalewayId = (data && data.emails && data.emails[0] && data.emails[0].id) || (data && data.id) || null;
    console.log('Email sent to', to);
    db.updateEmailLogResult(id, 'sent', scalewayId, null, html);
    return { ok: true, id: scalewayId };
  } catch (e) {
    console.error('Email error:', e.message);
    db.updateEmailLogResult(id, 'failed', null, e.message, html);
    return { ok: false, error: e.message };
  }
}

// ── Scaleway TEM lookups (Per Bot 8) ──
// Direct per-email status check, used once we already have a
// scaleway_email_id on file (from the log above) — the reliable path
// going forward, since it asks about one specific email by its own id
// rather than guessing from a subject-line search.
async function scwGetEmailStatus(scalewayEmailId) {
  if (!SCW_SECRET_KEY) return null;
  try {
    const res = await fetch(`https://api.scaleway.com/transactional-email/v1alpha1/regions/${SCW_TEM_REGION}/emails/${scalewayEmailId}`, {
      headers: { 'X-Auth-Token': SCW_SECRET_KEY }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) { return null; }
}
// Retroactive reconciliation only — for sends that happened before this
// logging existed (the "Finding Calm" send), where we have no
// scaleway_email_id on file at all and the only option is asking Scaleway
// "what emails with this subject went out since this time", paginating
// through its list endpoint. Not needed for anything sent after this
// change, which always has a direct id to check instead.
async function scwListEmailsBySubjectSince(subject, sinceISO) {
  if (!SCW_SECRET_KEY) return [];
  const results = [];
  // Our own db stores 'YYYY-MM-DD HH:MM:SS' (no T/Z), Scaleway returns full
  // ISO-8601 with a T and a Z — comparing those two formats as raw strings
  // is unreliable (a space character sorts differently than 'T' regardless
  // of actual time), so both get parsed to real Date objects here instead.
  const sinceMs = new Date(sinceISO.replace(' ', 'T') + 'Z').getTime();
  let page = 1;
  const pageSize = 100;
  for (let i = 0; i < 20; i++) { // hard cap — 2000 emails is far more than one newsletter batch
    let data;
    try {
      const res = await fetch(`https://api.scaleway.com/transactional-email/v1alpha1/regions/${SCW_TEM_REGION}/emails?page=${page}&page_size=${pageSize}&project_id=${SCW_PROJECT_ID}`, {
        headers: { 'X-Auth-Token': SCW_SECRET_KEY }
      });
      if (!res.ok) break;
      data = await res.json();
    } catch(e) { break; }
    const emails = (data && data.emails) || [];
    if (!emails.length) break;
    for (const e of emails) {
      if (e.created_at && new Date(e.created_at).getTime() < sinceMs) continue;
      if (subject && e.subject && e.subject !== subject) continue;
      // Only a genuinely successful send counts as "reached" — anything
      // still processing, bounced, or failed gets treated as missing and
      // retried, since re-sending to someone whose bounce turns out to
      // have been permanent is a much smaller problem than skipping
      // someone who never actually got it.
      if (e.status === 'sent') results.push(e);
    }
    if (emails.length < pageSize) break; // last page
    page++;
  }
  return results;
}

function emailWelcomeFacilitator(name, email, tempPassword) {
  const b = brand();
  return sendEmail(email, `Welcome to ${b.name} — your facilitator account`,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Welcome, ${name}</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">Your facilitator account has been created.</p>
      <div style="background:#f5f5f0;border-radius:10px;padding:20px;margin-bottom:24px">
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Login URL</div>
        <div style="font-size:15px;color:#1a1a1a;margin-bottom:16px"><a href="${APP_URL}" style="color:#2d6a4f">${APP_URL}</a></div>
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Email</div>
        <div style="font-size:15px;color:#1a1a1a;margin-bottom:16px">${email}</div>
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Temporary password</div>
        <div style="font-size:18px;font-family:monospace;color:#1a1a1a;letter-spacing:0.05em">${tempPassword}</div>
      </div>
      <p style="font-size:14px;line-height:1.7;color:#666">You will be asked to set a new password when you first sign in.</p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <div style="font-size:12px;color:#aaa">${b.name}</div>
    </div>`
  );
}

// Per Bot 19 — the warm, permanent counterpart to emailWelcomeClient,
// used ONLY when the person being activated was a genuine newsletter-only
// contact (member_tier=0, no password at all — see
// NEWSLETTER_AUDIENCE_CLAUSES in db.js) becoming a real account for the
// first time. Deliberately doesn't set or email a temporary password —
// {{invite_link}} is a self-service /join/:token link they use to set
// their own, same mechanism Newsletters already use for anyone without a
// login yet. Every other activation path (facilitator adding a client,
// bulk import, lead conversion) is a different psychological moment —
// "someone set this account up for you" — and keeps emailWelcomeClient's
// original immediate-password behaviour unchanged.
function emailWelcomeFromNewsletter(user, override) {
  const b = brand();
  const tokens = buildMessageTokens(user);
  // Per Bot 19h — no more fixed "Dear {{name}}, Hope you're well" greeting
  // or fixed "Sign in and set up your password →" button below it. Per
  // writes the whole thing himself now, including his own greeting,
  // sign-off, and a real clickable link (via the rich editor's link
  // tool, targeting {{invite_link}}) rather than a plain-text mention of
  // the token, which just showed the raw URL as visible text. This
  // plain-text fallback only matters until Per saves his own version —
  // it's deliberately readable-but-plain, since a plain-text body can't
  // have a custom-labelled link, only a bare URL.
  const defaultBody = `Dear {{name}},

Hope you're well, and that things are good with you.

A short note to welcome you to the new, rebuilt Deeper Mindfulness — genuinely rebuilt, not just refreshed, and we hope you feel that the moment you're in it.

If you have an existing subscription to Deeper Mindfulness, it has carried over in full, nothing to renew or reconsider. All you need to do is follow this link: {{invite_link}}

Once you're in, everything is open to you — courses, practices, poems, blogs, whitepapers, all of it, fully. If you find something missing, just let me know and I will add it promptly.

One new thing worth knowing about: Talk. It's not a scripted practice — it's somewhere to think something through out loud, and it listens and responds to whatever you're actually carrying in that moment, not a fixed script. I'd love to know what you make of it.

You can also set up practice reminders — a small message once a day, by email or text, whichever suits you.

Hope this lands well, and that the new app becomes a good place for you.

Warmly,
Per`;
  // Per Bot 24 — switched over to message_versions (see
  // resolveMessageContent) — subject and body now come from the active
  // saved version if one exists, same hardcoded fallback text above
  // otherwise. override lets the generic test-send endpoint preview
  // exactly what's currently typed in comms2's form, saved or not.
  const content = resolveMessageContent('newsletter_welcome', { subject: `Welcome to ${b.name} — you're in`, body: defaultBody }, override);
  const subject = fillTemplate(content.subject, tokens);
  const body = fillTemplate(content.body, tokens);
  return sendEmail(user.email, subject,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      ${renderMessageBody(body, content.format)}
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name} · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`
  );
}

// Per Bot 42 — rebuilt on the same shared infrastructure as every other
// admin-editable message (buildMessageTokens/fillTemplate/renderMessageBody
// — see the big comment on buildMessageTokens above), rather than a
// standalone fixed template. Falls back to a sensible built-in default
// until Per writes his own custom one in Settings, same "unset means
// default, not broken" convention every template in this family follows.
// {{invite_link}} already resolves smartly via buildMessageTokens: a
// proper /join/:token self-service link for anyone with no password set
// yet (an admin-added account, still on its temp password), or a plain
// /login link for anyone who already has one. It doesn't yet distinguish
// "has a password but has never actually logged in" (a self-registered
// trial user who set a password at signup and simply never came back) —
// that's a real, separate gap worth fixing in buildMessageTokens itself
// since every template using {{invite_link}} would benefit, not just
// this one; noted rather than silently solved here.
function emailTrialUpdated(user, days, messageType, isRestart, override) {
  const b = brand();
  const tokens = buildMessageTokens(user, { extra: { days: String(days) } });
  const actionPhrase = isRestart ? `started a new ${days}-day trial for you` : `extended your trial by ${days} days`;
  const defaultBody = messageType === 'simple'
    ? `Hi {{name}},\n\nJust a quick note — we've ${actionPhrase}. Your access now runs until {{expiry_date}}.\n\nSign in at {{invite_link}} whenever you're ready.`
    : `Hi {{name}},\n\nWe've been rolling out a lot of new things lately, so we've ${actionPhrase} — until {{expiry_date}} — to give you a proper chance to see and try what's new.\n\nSign in at {{invite_link}} whenever you're ready.`;
  const subjectDefault = isRestart ? `A fresh trial, on us` : `Your trial's been extended`;
  // Per Bot 24 — switched over to message_versions. Note the same custom
  // text applies regardless of messageType/isRestart once someone saves
  // a version — that's unchanged from how the old app_config field
  // already worked, just carried forward rather than newly introduced.
  const content = resolveMessageContent('trial_extended', { subject: subjectDefault, body: defaultBody }, override);
  const subject = fillTemplate(content.subject, tokens);
  const body = fillTemplate(content.body, tokens);
  return sendEmail(user.email, subject,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      ${renderMessageBody(body, content.format)}
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <div style="font-size:12px;color:#aaa">${b.name}</div>
    </div>`
  );
}

function emailWelcomeClient(name, email, tempPassword, language, skinId, trialEndsAt, manualExpiresAt) {
  const b = brand();
  // Per Bot 33r — a member added directly to a skin (individually or via
  // bulk import) needs the welcome email pointing at that skin's own
  // /login/:slug, not the plain login page — otherwise they'd never see
  // that skin's branding at all until someone manually sent them the
  // right link separately. Validated against a real skin rather than
  // trusting the id outright.
  const loginUrl = (skinId && db.getSkin(skinId)) ? `${APP_URL}/login/${skinId}` : APP_URL;
  // Per Bot 22 — a manual paid-until date (legacy subscriber, set at
  // creation instead of a trial) previously showed nothing here at all,
  // same gap as the trial case had before Per Bot 20 fixed it. Both are
  // "access ends on a real date" — only the wording differs, since a
  // manual expiry isn't a trial and shouldn't be called one.
  const accessUntil = trialEndsAt || manualExpiresAt || null;
  const isTrial = !!trialEndsAt;
  const trialLine = accessUntil
    ? `<div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Full access until</div>
       <div style="font-size:15px;color:#1a1a1a">${new Date(accessUntil).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}</div>`
    : '';
  return sendLocalizedEmail('welcome_client', language, {
    subject: `Welcome to {{brand}}`,
    html: `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">{{brand}}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Welcome, {{name}}</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">Your account is ready${accessUntil ? (isTrial ? ' — with full access to everything, as a trial' : ' — with full access to everything') : ''}.</p>
      <div style="background:#f5f5f0;border-radius:10px;padding:20px;margin-bottom:24px">
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Sign in at</div>
        <div style="font-size:15px;color:#1a1a1a;margin-bottom:16px"><a href="{{appUrl}}" style="color:#2d6a4f">{{appUrl}}</a></div>
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Email</div>
        <div style="font-size:15px;color:#1a1a1a;margin-bottom:16px">{{email}}</div>
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Temporary password</div>
        <div style="font-size:18px;font-family:monospace;color:#1a1a1a;letter-spacing:0.05em;${accessUntil ? 'margin-bottom:16px' : ''}">{{tempPassword}}</div>
        ${trialLine}
      </div>
      <p style="font-size:14px;line-height:1.7;color:#666">You will be asked to choose a new password when you sign in.</p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <div style="font-size:12px;color:#aaa">{{brand}}</div>
    </div>`
  }, { brand: b.name, name, email, tempPassword, appUrl: loginUrl }, email);
}

// Per Bot 15e — someone being marked as a Client (is_client=1 + a
// facilitator assigned) didn't generate any notification at all before —
// they'd just quietly start seeing session/practice features next time
// they logged in, with no idea it had happened or who their facilitator
// now was. This fires from markAsClient's route (assign-facilitator),
// same visual template as the other account emails.
function emailBecameClient(name, email, facilitatorName, language) {
  const b = brand();
  return sendLocalizedEmail('became_client', language, {
    subject: `You're now working with a facilitator on {{brand}}`,
    html: `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">{{brand}}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello, {{name}}</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">Your account has been set up to work directly with a facilitator.</p>
      <div style="background:#f5f5f0;border-radius:10px;padding:20px;margin-bottom:24px">
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Your facilitator</div>
        <div style="font-size:16px;color:#1a1a1a">{{facilitatorName}}</div>
      </div>
      <p style="font-size:14px;line-height:1.7;color:#666">Sign in as usual at {{appUrl}} to see what's new.</p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <div style="font-size:12px;color:#aaa">{{brand}}</div>
    </div>`
  }, { brand: b.name, name, facilitatorName, appUrl: APP_URL }, email);
}

// ── Password reset emails (Per Bot 8) ──
// Self-service link (1-hour token) vs an admin-triggered temp password —
// same visual template, different content block, so the difference in
// what the recipient needs to do is obvious at a glance.
function emailPasswordResetLink(name, email, token, language) {
  const b = brand();
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;
  return sendLocalizedEmail('password_reset_link', language, {
    subject: `Reset your {{brand}} password`,
    html: `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">{{brand}}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Reset your password</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">Hi {{name}}, someone (hopefully you) asked to reset the password for {{email}}. This link works once and expires in an hour.</p>
      <a href="{{resetUrl}}" style="display:inline-block;background:#2d6a4f;color:#fff;padding:13px 24px;border-radius:8px;text-decoration:none;font-size:14px;margin-bottom:24px">Choose a new password</a>
      <p style="font-size:13px;line-height:1.6;color:#888">If you didn't request this, you can safely ignore this email — your password won't change.</p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <div style="font-size:12px;color:#aaa">{{brand}}</div>
    </div>`
  }, { brand: b.name, name, email, resetUrl }, email);
}
function emailAdminPasswordReset(name, email, tempPassword, language, isFirstEverPassword, trialEndsAt, manualExpiresAt) {
  const b = brand();
  // Per Bot 20 — two fixes at once, both flagged earlier this session:
  // (1) "Your facilitator has reset your password" was always shown even
  // for someone who never had one before — accurate for a real reset,
  // odd and slightly confusing for a genuine first-time grant. (2) When
  // this is the moment someone gets bumped to a trial (see
  // grantFirstPasswordTrialIfEligible), the email previously said nothing
  // about it at all — same gap as emailWelcomeClient had, fixed there
  // earlier this session, now fixed here too.
  // Per Bot 22 — extended the same way emailWelcomeClient was: a manual
  // paid-until date set at creation (legacy subscriber, no trial
  // involved) previously showed nothing here either, since this only
  // ever looked at a trial freshly granted at this exact reset moment.
  // This is specifically the email that fires when Per collapses
  // create+expiry into one step and then resets the password straight
  // after — it needs to reflect the real date, not just a fresh trial.
  const accessUntil = trialEndsAt || manualExpiresAt || null;
  const isTrial = !!trialEndsAt;
  const introLine = isFirstEverPassword
    ? `Your account is ready${accessUntil ? (isTrial ? ' — with full access to everything, as a trial' : ' — with full access to everything') : ''}. Sign in with the temporary password below — you'll be asked to choose your own straight after.`
    : `Your facilitator has reset your password. Sign in with the temporary password below — you'll be asked to choose your own straight after.`;
  const trialLine = accessUntil
    ? `<div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Full access until</div>
       <div style="font-size:15px;color:#1a1a1a">${new Date(accessUntil).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}</div>`
    : '';
  return sendLocalizedEmail('admin_password_reset', language, {
    subject: `Your {{brand}} password has been reset`,
    html: `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">{{brand}}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hi {{name}}</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">${introLine}</p>
      <div style="background:#f5f5f0;border-radius:10px;padding:20px;margin-bottom:24px">
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Sign in at</div>
        <div style="font-size:15px;color:#1a1a1a;margin-bottom:16px"><a href="{{loginUrl}}" style="color:#2d6a4f">{{appUrl}}</a></div>
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Temporary password</div>
        <div style="font-size:18px;font-family:monospace;color:#1a1a1a;letter-spacing:0.05em;${accessUntil ? 'margin-bottom:16px' : ''}">{{tempPassword}}</div>
        ${trialLine}
      </div>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <div style="font-size:12px;color:#aaa">{{brand}}</div>
    </div>`
  }, { brand: b.name, name, email, tempPassword, appUrl: APP_URL,
    // Per Bot 24 — same pre-fill mechanism login.html already supports
    // for the newsletter-welcome email's {{invite_link}} — this just
    // wasn't using it. The visible link text still shows the plain
    // appUrl, only the actual href carries the email.
    loginUrl: `${APP_URL}/login?email=${encodeURIComponent(email)}` }, email);
}

// ── Trial email sequence (Per Bot 5, item 4) ──
// Day 3: what you've unlocked. Day 10: 4 days left. Day 14: trial ended.
function emailTrialDay3(user, override) {
  const b = brand();
  const tokens = buildMessageTokens(user);
  const content = resolveMessageContent('trial_day3', {
    subject: "The parts of this you haven't found yet",
    body: `A few days in is usually when people find the one thing that works and quietly stop looking any further. That's completely fine — but there's more here than the first thing you landed on.

Everything is actually open to you right now, not just what's free to try — the full library, and Talk, for the days nothing scripted quite fits what you're carrying.

No pressure to go looking. Just wanted you to know it's there.`,
  }, override);
  const subject = fillTemplate(content.subject, tokens);
  const body = fillTemplate(content.body, tokens);
  return sendEmail(user.email, subject,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${user.name},</h1>
      ${renderMessageBody(body, content.format)}
      <p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/client/" style="color:#2d6a4f">Visit your practice space →</a></p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name} · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`
  );
}

// Per Bot 18 — fills the previously-empty week between day 3 and day 10.
// Purpose is different from day 3 (which points at what's unopened) — this
// one is about return frequency, since short-and-often is what actually
// makes a practice stick, not one long session.
function emailTrialDay7(user, override) {
  const b = brand();
  const tokens = buildMessageTokens(user);
  const content = resolveMessageContent('trial_day7', {
    subject: 'The five minutes that actually add up',
    body: `The people who keep this going long after a trial ends aren't usually the ones who did one long session — they're the ones who came back for five minutes, a few times a week.

If you haven't yet, that's really all Talk or a short practice needs to be. Not a commitment. Just a few minutes, whenever the day happens to call for it.

However you've used it so far is fine — this is just a nudge that short and often counts for more than it seems.`,
  }, override);
  const subject = fillTemplate(content.subject, tokens);
  const body = fillTemplate(content.body, tokens);
  return sendEmail(user.email, subject,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${user.name},</h1>
      ${renderMessageBody(body, content.format)}
      <p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/client/" style="color:#2d6a4f">Try a few minutes now →</a></p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name} · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`
  );
}

function emailTrialDay10(user, override) {
  const b = brand();
  const cfg = db.getAppConfig() || {};
  const paymentsOn = cfg.payments_enabled !== 0;
  const tokens = buildMessageTokens(user);
  const defaultBody = paymentsOn
    ? `Your trial ends in four days. After that, your account moves to the free Explorer tier — your history stays, but full access doesn't.

If this has found a place in your week, membership just means it stays there. Nothing else changes, and there's no pressure either way.`
    : `Your trial ends in four days. After that, your account moves to the free Explorer tier — your history stays, and the free content stays fully available too.`;
  const content = resolveMessageContent('trial_day10', { subject: 'Four days left, and what happens after', body: defaultBody }, override);
  const subject = fillTemplate(content.subject, tokens);
  const body = fillTemplate(content.body, tokens);
  return sendEmail(user.email, subject,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${user.name},</h1>
      ${renderMessageBody(body, content.format)}
      ${paymentsOn ? `<p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/membership" style="color:#2d6a4f">See membership options →</a></p>` : ''}
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name} · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`
  );
}

function emailTrialDay14(user, override) {
  const b = brand();
  const cfg = db.getAppConfig() || {};
  const paymentsOn = cfg.payments_enabled !== 0;
  const tokens = buildMessageTokens(user);
  const defaultBody = paymentsOn
    ? `Your 14-day trial has come to an end. Your account is now on the free Explorer tier — your history and the free content are both still there.

If you'd like full access back, you're welcome any time. No explanation needed, and nothing about coming back later is complicated.`
    : `Your 14-day trial has come to an end. Your account is now on the free Explorer tier — your history and the free content are both still there.`;
  const content = resolveMessageContent('trial_day14', { subject: "Your trial has ended — here's where things stand", body: defaultBody }, override);
  const subject = fillTemplate(content.subject, tokens);
  const body = fillTemplate(content.body, tokens);
  return sendEmail(user.email, subject,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${user.name},</h1>
      ${renderMessageBody(body, content.format)}
      ${paymentsOn ? `<p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/membership" style="color:#2d6a4f">See membership options →</a></p>` : ''}
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name} · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`
  );
}

// Per Bot 18 — daily cron job for campaign email steps. Social steps are
// scheduled directly with BulkPublish at go-live time (see the /activate
// route) and need no further attention here — this only ever touches
// email, the one channel with no external scheduler of its own.
// Deliberately a straightforward per-recipient loop rather than the
// newsletter system's fuller pending/status job-queue machinery — fine
// for a mailing list at today's size; worth revisiting if a single
// campaign step's audience ever grows very large.
// Per Bot 18 — Savers Protocol email builder. One shared wrapper (same
// admin-editable-with-fallback-default pattern as the trial sequence)
// plus seven thin touchpoint functions. Two genuinely different voices
// by design, not the same message reused: cancellation was a decision,
// so it's acknowledged as one, never treated as a mistake to be
// corrected; payment failure is usually nobody's fault, so it stays
// practical and warm rather than reading like a sales attempt.
async function sendSaversEmail(user, cfgKeyPrefix, defaultSubject, defaultBody, extraTokens = {}, override) {
  const b = brand();
  const tokens = buildMessageTokens(user, { extra: extraTokens });
  // Per Bot 24 — switched over to message_versions. cfgKeyPrefix doubles
  // as the message_versions `type` key too — the seven Savers types were
  // already named to match (savers_cancel_day0, savers_failure_mid, etc.)
  // from when this wrapper was first built, so no separate mapping
  // needed here.
  const content = resolveMessageContent(cfgKeyPrefix, { subject: defaultSubject, body: defaultBody }, override);
  const subject = fillTemplate(content.subject, tokens);
  const body = fillTemplate(content.body, tokens);
  return sendEmail(user.email, subject,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      ${renderMessageBody(body, content.format)}
      <p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/membership" style="color:#2d6a4f">See membership options →</a></p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name} · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`
  );
}

function emailSaversCancelDay0(user, periodEndStr, override) {
  return sendSaversEmail(user, 'savers_cancel_day0', "Got it — no questions asked",
    `You've let us know you're moving on, and that's completely fine — no explanation needed.

Nothing changes for now. You've got full access exactly as already paid for, through {{period_end}}. We're genuinely glad you spent time here at all.`,
    { period_end: periodEndStr }, override);
}
function emailSaversCancelGrace0(user, override) {
  return sendSaversEmail(user, 'savers_cancel_grace0', "We've kept the door open a little longer",
    `Your paid time wrapped up — but rather than closing things off right away, we've kept full access open for another two weeks, no charge.

No pressure either way. Just wanted you to have the option, in case the timing was the only thing wrong.`,
    {}, override);
}
function emailSaversCancelMid(user, override) {
  return sendSaversEmail(user, 'savers_cancel_mid', "A week left of the extra time",
    `Just flagging it — there's about a week left of the extra access we set aside after your membership wrapped up.

Nothing you need to do. If it's found a place in your week again, membership's there whenever suits.`,
    {}, override);
}
function emailSaversCancelFinal(user, override) {
  return sendSaversEmail(user, 'savers_cancel_final', "Last day, and that's alright too",
    `This is the last day of the extra time we set aside. After today your account settles into the free Explorer tier — which is a real, permanent place, not a dead end.

If you'd like to come back properly at some point, you're always welcome, any time.`,
    {}, override);
}
function emailSaversFailureDay0(user, override) {
  return sendSaversEmail(user, 'savers_failure_day0', "Your last payment didn't go through",
    `Wanted to flag this from an actual person, not just the automated notice — your last payment didn't process. This happens for all sorts of ordinary reasons, most often just a card that's expired or been reissued.

Your access hasn't changed. You've got two full weeks to sort it out, no rush.`,
    {}, override);
}
function emailSaversFailureMid(user, override) {
  return sendSaversEmail(user, 'savers_failure_mid', "Still showing a payment issue",
    `A gentle follow-up — the payment issue from last week is still showing on our end. No drama, just didn't want it to quietly slip by.

Full access is still there while this gets sorted.`,
    {}, override);
}
function emailSaversFailureFinal(user, override) {
  return sendSaversEmail(user, 'savers_failure_final', "One more day before things settle",
    `Last day of full access before your account moves to the free Explorer tier — if it's just a card that needs updating, this is the moment to catch it.

If it's genuinely time to step back for now, that's completely fine too — Explorer keeps the free content open regardless.`,
    {}, override);
}
// Per's request, prompted by a real customer (Jude) getting confused and
// emailing to check whether her payment had actually gone through — it
// had, and quickly (Stripe's own automatic retry succeeding within a
// minute of the initial decline is completely normal and not something
// this app has any control over), but nothing ever told HER that. The
// account-level fix (clearSaversState, right where this is called from)
// was already correct — access was never actually at risk — this closes
// the purely human gap: whoever got the "didn't go through" email and
// then quietly had it resolve in the background deserves an equally
// direct "it's sorted" follow-up, not silence.
function emailSaversFailureResolved(user, override) {
  return sendSaversEmail(user, 'savers_failure_resolved', "All sorted — that payment went through",
    `Good news — the payment issue from before has resolved itself, and everything's back to normal. No action needed from you.

If you already went looking for somewhere to update a card, sorry for the runaround — nothing was actually needed after all.`,
    {}, override);
}

// Per's request — course enrolment confirmation and the three session
// reminders (3 days / 1 day / 1 hour before), plus a genuine "opens the
// app to the course page" link. sendCourseEmail is the course-specific
// sibling of sendSaversEmail above — same resolveMessageContent/
// fillTemplate/renderMessageBody pipeline, so these are just as
// admin-editable via Comms as every Savers type, only the closing CTA
// differs (a link straight to the course, not a membership-options link).
async function sendCourseEmail(user, type, defaultSubject, defaultBody, extraTokens, courseInstanceId, override) {
  const b = brand();
  const tokens = buildMessageTokens(user, { extra: extraTokens, courseInstanceId });
  const content = resolveMessageContent(type, { subject: defaultSubject, body: defaultBody }, override);
  const subject = fillTemplate(content.subject, tokens);
  const body = fillTemplate(content.body, tokens);
  return sendEmail(user.email, subject,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      ${renderMessageBody(body, content.format)}
      <p style="font-size:14px;line-height:1.7"><a href="${tokens.course_link}" style="color:#2d6a4f">Open your course →</a></p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name}</p>
    </div>`
  );
}
function emailEnrolmentConfirmed(user, courseTitle, instanceTitle, courseInstanceId, override) {
  return sendCourseEmail(user, 'enrolment_confirmed', `You're confirmed — {{course_title}}`,
    `You're all set for {{course_title}} — {{instance_title}}.

We'll send you a couple of reminders as your first session gets closer. In the meantime, everything you need is already waiting for you in the app.`,
    { course_title: courseTitle, instance_title: instanceTitle }, courseInstanceId, override);
}
function emailSessionReminder3Day(user, courseTitle, sessionTitle, sessionDateStr, courseInstanceId, override) {
  return sendCourseEmail(user, 'session_reminder_3day', `{{course_title}} — starting in 3 days`,
    `Just a heads up — {{session_title}} is coming up on {{session_date}}.`,
    { course_title: courseTitle, session_title: sessionTitle, session_date: sessionDateStr }, courseInstanceId, override);
}
function emailSessionReminder1Day(user, courseTitle, sessionTitle, sessionDateStr, courseInstanceId, override) {
  return sendCourseEmail(user, 'session_reminder_1day', `{{course_title}} — tomorrow`,
    `{{session_title}} is tomorrow, {{session_date}}.`,
    { course_title: courseTitle, session_title: sessionTitle, session_date: sessionDateStr }, courseInstanceId, override);
}
function emailSessionReminder1Hour(user, courseTitle, sessionTitle, sessionDateStr, courseInstanceId, override) {
  return sendCourseEmail(user, 'session_reminder_1hour', `{{course_title}} — starting in about an hour`,
    `{{session_title}} starts in about an hour, at {{session_date}}.`,
    { course_title: courseTitle, session_title: sessionTitle, session_date: sessionDateStr }, courseInstanceId, override);
}

// Per Bot 18 — fires when a manually-honoured membership period (set by
// hand in People admin, not tied to any Stripe subscription — the
// carried-over-legacy-member case) actually runs out. Distinct from
// both the trial sequence (that's a brand new trial ending) and Savers
// (that's a real Stripe subscription lapsing) — this is specifically
// "the free time we gave you has now been used up."
async function emailMembershipHonouredEnded(user) {
  const b = brand();
  return sendEmail(user.email, `Your access has come to an end`,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${user.name},</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:20px">The membership time we carried over for you has now come to an end. Your account is on the free Explorer tier — your history's still there, and so is the free content.</p>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:20px">If you'd like full access again, you're welcome to subscribe whenever suits — no rush, and nothing about picking it back up later is complicated.</p>
      <p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/membership" style="color:#2d6a4f">See membership options →</a></p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name} · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`
  );
}

const SAVERS_MID_SENDERS = { cancellation: emailSaversCancelMid, payment_failure: emailSaversFailureMid };
const SAVERS_FINAL_SENDERS = { cancellation: emailSaversCancelFinal, payment_failure: emailSaversFailureFinal };

// Per Bot 18 — daily cron: the two mid-grace touchpoints (day0/grace0
// already fired inline in the webhook handlers themselves, not here).
async function sendDueSaversEmails() {
  let sent = 0;
  for (const stage of ['mid', 'final']) {
    const senders = stage === 'mid' ? SAVERS_MID_SENDERS : SAVERS_FINAL_SENDERS;
    const due = db.getUsersDueForSaversEmail(stage);
    for (const user of due) {
      const sender = senders[user.savers_type];
      if (!sender || !user.email) continue;
      try { await sender(user); db.markSaversEmailSent(user.id, stage); sent++; }
      catch (e) { console.error(`[savers] ${stage} email failed for ${user.email}:`, e.message); }
    }
  }
  return sent;
}

// Per Bot 18 — daily cron: the actual downgrade once a grace window (of
// either type) has fully elapsed with nobody resolving it via a real
// payment. Genuinely the last resort — every earlier step in both
// lifecycles exists to avoid ever reaching this.
async function processDueSaversDowngrades() {
  const due = db.getUsersDueForSaversDowngrade();
  for (const user of due) {
    try {
      db.downgradeToExplorer(user.id);
      db.clearSaversState(user.id);
      console.log(`[savers] ${user.id} downgraded to Explorer — ${user.savers_type} grace window elapsed`);
    } catch (e) { console.error(`[savers] downgrade failed for ${user.id}:`, e.message); }
  }
  return due.length;
}

async function sendDueCampaignEmailSteps() {
  const dueSteps = db.getDueCampaignEmailSteps();
  for (const step of dueSteps) {
    try {
      const recipients = db.getNewsletterRecipients(step.audience);
      const b = brand();
      let sent = 0;
      for (const user of recipients) {
        try {
          const tokens = buildMessageTokens(user, { offerId: step.offer_id, sourceTag: step.source_tag });
          await sendEmail(user.email, fillTemplate(step.subject || b.name, tokens),
            `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
              <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
              ${renderMessageBody(fillTemplate(step.content, tokens), step.format)}
              <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
              <p style="font-size:12px;color:#aaa">${b.name} · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
            </div>`);
          sent++;
        } catch (e) { console.error(`[campaign] send failed for ${user.email}:`, e.message); }
      }
      db.setCampaignStepResult(step.id, 'sent');
      console.log(`[campaign] step ${step.id} sent to ${sent}/${recipients.length} recipients`);
    } catch (e) {
      db.setCampaignStepResult(step.id, 'failed', { error: e.message });
      console.error(`[campaign] step ${step.id} failed:`, e.message);
    }
  }
  return dueSteps.length;
}

// ── message_versions switch-over (Per Bot 24, per the comms2 handover) ──
// Resolves the live content for a message type: the active saved version
// in message_versions if one exists, otherwise the exact same hardcoded
// fallback each send function has always used — so a type nobody's ever
// customized keeps behaving identically, and the OLD app_config-driven
// settings form (comms.html, not yet retired) simply stops being read
// for whichever type has been switched over. Reused for every type as
// each gets switched, one at a time, per the handover's ordering.
// Per Bot 24 — override (optional, third param) lets a caller test
// exactly what's currently typed in the comms2 form, not just the saved
// active version — the whole point of a "test" button while editing.
// Takes priority over the active version, which takes priority over the
// hardcoded fallback, same layering either way.
function resolveMessageContent(type, fallback, override) {
  if (override) {
    return {
      subject: override.subject || fallback.subject,
      body: override.body || fallback.body,
      format: override.format || fallback.format || 'plain',
      extra: Object.assign({}, fallback.extra || {}, override.extra || {}),
    };
  }
  const active = db.getActiveMessageVersion(type);
  if (!active) return { subject: fallback.subject, body: fallback.body, format: fallback.format || 'plain', extra: fallback.extra || {} };
  return {
    subject: active.subject || fallback.subject,
    body: active.body || fallback.body,
    format: active.format || fallback.format || 'plain',
    extra: Object.assign({}, fallback.extra || {}, active.extra || {}),
  };
}

// ── Inactivity reminder (Per Bot 5, item 8) ──
// ── Inactivity reminder — shared HTML, used by both the real send and the ──
// admin test-send endpoint, so a test email matches a real one exactly.
// Per Bot 24 — switched over to message_versions (see resolveMessageContent
// above). This is the FIRST of the 16 types being switched, per the
// handover's plan — Renewal, Birthday, and the rest still read the old
// app_config columns for now, one at a time, each tested before moving on.
function buildReminderHtml(user, b, override) {
  const tokens = buildMessageTokens(user);
  const content = resolveMessageContent('reminder', {
    body: "It's been a little while. No pressure at all — just wanted to leave the door open, in case a few minutes today would help.",
  }, override);
  const bodyText = fillTemplate(content.body, tokens);
  return `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${tokens.name},</h1>
      ${renderMessageBody(bodyText, content.format)}
      <p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/client/" style="color:#2d6a4f">Visit your practice space →</a></p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name} · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`;
}

function emailInactivityReminder(user) {
  const b = brand();
  const content = resolveMessageContent('reminder', { subject: "Whenever you're ready" });
  const subject = fillTemplate(content.subject, buildMessageTokens(user));
  return sendEmail(user.email, subject, buildReminderHtml(user, b));
}

function buildReminderSms(userName, b, override) {
  const content = resolveMessageContent('reminder', {
    extra: { sms_body: "It's been a little while, {{name}}. No pressure — a few minutes today might help. {{link}}" },
  }, override);
  const bodyText = fillTemplate(
    content.extra.sms_body,
    { name: userName, link: `${APP_URL}/client/` }
  );
  return `${b.name}: ${bodyText}`;
}

// ── Inactivity reminders — scheduled, config-driven ── Run daily by cron
// (see cron.js). Threshold and subject line come from app_config
// (reminder_days / reminder_subject, editable in the admin comms panel) —
// previously these were hardcoded (4 days, a different fixed subject) even
// though the admin panel showed editable fields for both. Now sends SMS
// too, for anyone who's opted into pref_sms_reminders and has a phone
// number on file — independent of whether they also want the email.
async function sendInactivityReminders() {
  // Per Bot 24 — days threshold now also comes from the active
  // message_versions row (extra.days) via resolveMessageContent, same
  // switch-over as the subject/body/SMS above.
  const content = resolveMessageContent('reminder', { extra: { days: 4 } });
  const days = Number.isInteger(content.extra.days) ? content.extra.days : parseInt(content.extra.days, 10) || 4;
  const inactive = db.getInactiveUsers(days);
  const b = brand();
  const nowUtc = new Date();
  let sentEmail = 0, sentSms = 0, matchedHour = 0;
  // Per Bot 24 (activity/engagement, group 1) — this job now runs hourly
  // (see cron.js) rather than once at a fixed daily UTC time, and only
  // actually sends to someone when it's currently their own likely hour
  // — their learned pattern from real engagement if there's history to
  // learn from, else their explicit motd_hour setting, else 9am their
  // time as a last resort. getInactiveUsers' existing 7-day cooldown
  // (last_reminder_sent_at) already prevents this from re-firing every
  // subsequent hour once someone's actually been sent to today — no
  // extra "already sent today" tracking needed on top of that.
  for (const user of inactive) {
    let local;
    try { local = getLocalDayHourDate(user.timezone || 'Europe/London', nowUtc); }
    catch (e) { local = getLocalDayHourDate('Europe/London', nowUtc); } // bad/missing timezone — fall back rather than skip this person entirely
    const learnedHour = getPreferredLocalHour(user.id, user.timezone || 'Europe/London');
    const targetHour = learnedHour !== null ? learnedHour : Number(user.motd_hour ?? 9);
    if (local.hour !== targetHour) continue;
    matchedHour++;
    if (user.pref_email_reminders && user.email) { await emailInactivityReminder(user); sentEmail++; }
    if (user.pref_sms_reminders && user.phone) {
      const result = await sms.sendSms(user.phone, buildReminderSms(user.name, b));
      if (result.ok) sentSms++;
    }
    db.markReminderSent(user.id);
  }
  return { ok: true, matched: matchedHour, candidatePool: inactive.length, sentEmail, sentSms, thresholdDays: days };
}

// Minimal inline escape for user-typed free text going into HTML email —
// specifically the custom reminder's own label, right below. Nothing
// else in this file has needed this before (every other place a person
// can type free text either goes through Quill/comms2's own sanitizing,
// or isn't inserted raw into an HTML attribute/element the way a bare
// label is here).
function escapeHtmlText(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Custom reminders — hourly, :20 past (see cron.js) ── Per Bot 50 —
// a person's own reminder(s), each independently timed and channelled,
// unlike sendInactivityReminders above there's no "have they gone
// quiet" gate here at all: someone set this reminder deliberately, so
// it fires on its own schedule regardless of activity.
// Hourly frequency needs no extra de-dup beyond the cron tick itself
// (already once an hour); daily/weekly compare last_sent_date_str
// against today's local date so a matching hour can't double-fire, and
// naturally won't fire again until the same day-of-week comes back
// around for weekly.
async function sendCustomReminders() {
  const reminders = db.getAllActiveCustomReminders();
  const b = brand();
  const nowUtc = new Date();
  let sentEmail = 0, sentSms = 0, matched = 0;
  for (const r of reminders) {
    let local;
    try { local = getLocalDayHourDate(r.user_timezone || 'Europe/London', nowUtc); }
    catch (e) { local = getLocalDayHourDate('Europe/London', nowUtc); }

    let due = false;
    if (r.frequency === 'hourly') {
      // Sensible waking-hours window even for "every hour" — a 3am ping
      // helps nobody, regardless of how the reminder's phrased.
      due = local.hour >= 7 && local.hour <= 21;
    } else if (r.frequency === 'daily') {
      const targetHour = parseInt((r.time_of_day || '09:00').split(':')[0], 10);
      due = local.hour === targetHour && r.last_sent_date_str !== local.dateStr;
    } else if (r.frequency === 'weekly') {
      const targetHour = parseInt((r.time_of_day || '09:00').split(':')[0], 10);
      due = local.day === r.day_of_week && local.hour === targetHour && r.last_sent_date_str !== local.dateStr;
    }
    if (!due) continue;
    matched++;

    const label = r.label || 'Practice Reminder';
    const link = `${APP_URL}/client/`;
    if (r.channel_email && r.user_email) {
      const html = `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
          <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
          <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">${escapeHtmlText(label)}</h1>
          <p style="font-size:15px;line-height:1.7">A reminder you set for yourself.</p>
          <p style="font-size:14px;line-height:1.7"><a href="${link}" style="color:#2d6a4f">Visit your practice space →</a></p>
          <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
          <p style="font-size:12px;color:#aaa">${b.name} · <a href="${APP_URL}/account" style="color:#aaa">Manage reminders</a></p>
        </div>`;
      try { await sendEmail(r.user_email, label, html); sentEmail++; } catch (e) { console.error('[custom-reminder] email failed:', e.message); }
    }
    if (r.channel_sms && r.user_phone) {
      try {
        const result = await sms.sendSms(r.user_phone, `${b.name}: ${label} — ${link}`);
        if (result.ok) sentSms++;
      } catch (e) { console.error('[custom-reminder] sms failed:', e.message); }
    }
    db.markCustomReminderSent(r.id, local.dateStr);
  }
  return { ok: true, matched, totalActive: reminders.length, sentEmail, sentSms };
}

// ── Renewal reminders ── Genuinely new (Per Bot 6) — pref_email_renewal
// existed as a column before this, but nothing ever checked subscription
// expiry or sent anything for it. Built on member_expires_at, which the
// Stripe webhook handler already keeps in sync (extended on
// invoice.payment_succeeded, cleared on cancellation) — see
// getUpcomingRenewals in db.js for why only active subscriptions match
// (lifetime members have no expiry to remind about).
function buildRenewalReminderHtml(user, expiresAt, b, override) {
  const dateStr = new Date(expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  const tokens = buildMessageTokens(user, { extra: { date: dateStr } });
  const content = resolveMessageContent('renewal', {
    body: "Just a heads up — your membership renews on <strong>{{date}}</strong>. Nothing to do if that's expected; if you'd like to make changes first, you can manage your subscription any time.",
  }, override);
  const bodyText = fillTemplate(content.body, tokens);
  return `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${tokens.name},</h1>
      ${renderMessageBody(bodyText, content.format)}
      <p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/account" style="color:#2d6a4f">Manage my membership →</a></p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name} · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`;
}
function buildRenewalReminderSms(userName, expiresAt, b, override) {
  const dateStr = new Date(expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const content = resolveMessageContent('renewal', {
    extra: { sms_body: 'Hi {{name}}, your membership renews on {{date}}. Manage it any time at {{link}}' },
  }, override);
  const bodyText = fillTemplate(
    content.extra.sms_body,
    { name: userName, date: dateStr, link: `${APP_URL}/account` }
  );
  return `${b.name}: ${bodyText}`;
}

async function sendRenewalReminders() {
  // Per Bot 24 — days threshold and subject now come from the active
  // message_versions row too, same switch-over as Reminder.
  const content = resolveMessageContent('renewal', { subject: 'Your membership renews soon', extra: { days: 5 } });
  const days = Number.isInteger(content.extra.days) ? content.extra.days : parseInt(content.extra.days, 10) || 5;
  const upcoming = db.getUpcomingRenewals(days);
  const b = brand();
  let sentEmail = 0, sentSms = 0;
  for (const user of upcoming) {
    if (user.pref_email_renewal && user.email) {
      const subject = fillTemplate(content.subject, buildMessageTokens(user));
      await sendEmail(user.email, subject, buildRenewalReminderHtml(user, user.member_expires_at, b));
      sentEmail++;
    }
    if (user.pref_sms_renewal && user.phone) {
      const result = await sms.sendSms(user.phone, buildRenewalReminderSms(user.name, user.member_expires_at, b));
      if (result.ok) sentSms++;
    }
    db.markRenewalReminderSent(user.id, user.member_expires_at);
  }
  return { ok: true, matched: upcoming.length, sentEmail, sentSms, thresholdDays: days };
}

// ── Birthday messages (Per Bot 7) ── Providing a DOB at all is the consent
// to send this — there's no separate preference toggle to check, unlike
// every other message type in this file. Month/day only, everywhere —
// nothing here ever sees or uses a birth year.
function buildBirthdayHtml(user, b, override) {
  const tokens = buildMessageTokens(user);
  const content = resolveMessageContent('birthday', {
    body: "Just a little note to say happy birthday, {{name}}! Wishing you a day with a bit of extra ease in it.",
  }, override);
  const bodyText = fillTemplate(content.body, tokens);
  return `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Happy birthday, ${tokens.name}!</h1>
      ${renderMessageBody(bodyText, content.format)}
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name} · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`;
}
function buildBirthdaySms(userName, b, override) {
  const content = resolveMessageContent('birthday', {
    extra: { sms_body: "Happy birthday, {{name}}! Wishing you a great day, from all of us at {{brand}}." },
  }, override);
  const bodyText = fillTemplate(content.extra.sms_body, { name: userName, brand: b.name });
  return bodyText;
}

// Run once daily by cron. Deliberately does not check pref_email_* /
// pref_sms_* — see note above. Still requires a phone/email to actually be
// on file, same as every other send path.
async function sendBirthdayMessages() {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day   = today.getDate();
  const matches = db.getUsersWithBirthdayToday(month, day);
  const b = brand();
  // Per Bot 24 — subject now comes from the active message_versions row
  // too, same switch-over as Reminder/Renewal.
  const content = resolveMessageContent('birthday', { subject: 'Happy birthday from all of us' });
  let sentEmail = 0, sentSms = 0;
  for (const user of matches) {
    if (user.email) {
      const subject = fillTemplate(content.subject, buildMessageTokens(user));
      await sendEmail(user.email, subject, buildBirthdayHtml(user, b));
      sentEmail++;
    }
    if (user.phone) { const result = await sms.sendSms(user.phone, buildBirthdaySms(user.name, b)); if (result.ok) sentSms++; }
    db.markBirthdaySent(user.id);
  }
  return { ok: true, matched: matches.length, sentEmail, sentSms };
}

// ── Facilitator requests (Per Bot 5, item 11) ──
function emailFacilitatorRequestReceivedToAdmin(request) {
  const memberNote = request.user_id
    ? `Existing member (tier ${request.member_tier}, since ${request.member_since || 'unknown'}).`
    : `⚠️ Not currently a member — submitted via the public link.`;
  return sendEmail(process.env.ADMIN_EMAIL || 'per@deepermindfulness.org',
    `New facilitator request — ${request.name}`,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px">
      <h2 style="font-weight:normal">New facilitator request</h2>
      <p><strong>${request.name}</strong> · ${request.email}</p>
      <p style="color:#666">${memberNote}</p>
      ${request.message ? `<p style="background:#f5f5f0;border-radius:8px;padding:14px 16px;color:#333">${request.message}</p>` : ''}
      <p><a href="${APP_URL}/admin/">Review in admin →</a></p>
    </div>`
  );
}

// Per Bot 15o — this never existed at all: a new guest enquiry generated
// no admin notification of any kind, unlike facilitator requests just
// above. Same pattern, pointing at the People page's Enquiries section.
function emailGuestLeadReceivedToAdmin(lead) {
  return sendEmail(process.env.ADMIN_EMAIL || 'per@deepermindfulness.org',
    `New enquiry — ${lead.name}`,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px">
      <h2 style="font-weight:normal">New enquiry</h2>
      <p><strong>${lead.name}</strong> · ${lead.email}</p>
      <p><a href="${APP_URL}/admin/">Review in admin →</a></p>
    </div>`
  );
}

function emailFacilitatorRequestApproved(request) {
  const b = brand();
  return sendEmail(request.email, 'Your facilitator request has been approved',
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${request.name},</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">Your request to become a facilitator has been approved. Your account now has facilitator access.</p>
      <p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/facilitator/" style="color:#2d6a4f">Go to your facilitator dashboard →</a></p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name}</p>
    </div>`
  );
}

function emailFacilitatorRequestDeclined(request) {
  const b = brand();
  return sendEmail(request.email, 'About your facilitator request',
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${request.name},</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:20px">Thank you for your interest in facilitating. We're not able to move forward with this right now.</p>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">If you haven't yet spent time with the practice as a member yourself, that's usually the best next step — we'd genuinely welcome hearing from you again once you have.</p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name}</p>
    </div>`
  );
}

function emailFacilitatorRequestDeferred(request) {
  const b = brand();
  return sendEmail(request.email, 'About your facilitator request',
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${request.name},</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">Thank you for your request to become a facilitator. We need a little more time to consider it — no action needed from you, we'll follow up before too long.</p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">${b.name}</p>
    </div>`
  );
}


app.get('/login',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));

// Per Bot 17 (phase 3) — public marketing landing page. Reads ?promoCode=
// itself client-side (same pattern as register.html) to show the right
// offer copy before anyone commits to signing up.
// Per Bot 18 — also logs a funnel hit here (not on /promo/:code below),
// since /promo/:code is just a redirect straight through to this same
// route — logging in both places would double-count every visit that
// arrived via a promo link.
app.get('/promotions', (req, res) => {
  try {
    const promoCode = req.query.promoCode || null;
    const offer = promoCode ? db.getOfferByCode(promoCode) : null;
    const skinId = req.query.skin || offer?.skin_id || null;
    db.logPromoHit(offer?.id || null, promoCode, req.query.src || null, skinId);
  } catch (e) { console.error('promo hit log error:', e.message); }
  res.sendFile(path.join(__dirname, 'public', 'promotions.html'));
});

// Short promo link. Now points at the real landing page instead of
// jumping straight to the form — the page's own CTA carries the code
// through to /register from there. src/skin (platform/message attribution,
// Per Bot 18) pass straight through untouched if present on the original
// link, so a link like /promo/insta-launch?src=instagram-post-3 keeps its
// tag all the way to the hit log above and, if they register, to the
// account itself.
app.get('/promo/:code', (req, res) => {
  const params = new URLSearchParams({ promoCode: req.params.code });
  if (req.query.src) params.set('src', req.query.src);
  if (req.query.skin) params.set('skin', req.query.skin);
  res.redirect('/promotions?' + params.toString());
});
// Multi-skin branding (Per Bot 20) — same files, same everything, just a
// slug in the URL for the page's own JS to notice and brand itself
// against (see skin-inject.js). The slug isn't validated here — an
// unknown one just means skin-inject.js's fetch to /api/skins/:slug
// comes back empty and the page quietly falls back to standard branding,
// same as no slug at all.
app.get('/login/:skinSlug',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register/:skinSlug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
// Per Bot 18 — logs a funnel hit the same way /promotions does, when the
// link carries promoCode/src (i.e. this join link came from a tracked
// newsletter send, not the untracked legacy flow). No offer/src on the
// link just means no hit logged, same as any other untagged visit.
app.get('/join/:token', (req, res) => {
  try {
    if (req.query.promoCode || req.query.src) {
      const offer = req.query.promoCode ? db.getOfferByCode(req.query.promoCode) : null;
      db.logPromoHit(offer?.id || null, req.query.promoCode || null, req.query.src || null, null);
    }
  } catch (e) { console.error('join hit log error:', e.message); }
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

// ── One-click unsubscribe ── Public, no auth — has to work for newsletter-
// only contacts too, who have no password and no way to log into My Account
// at all. Idempotent and immediate: a GET request unsubscribes on the spot,
// matching how virtually every real newsletter unsubscribe link behaves.
// Doesn't touch pref_email_motd/reminders/renewal — only the newsletter
// preference this link was actually about.
app.get('/unsubscribe/:token', (req, res) => {
  const b = brand();
  const user = db.getUserByUnsubscribeToken(req.params.token);
  const page = (heading, message) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Unsubscribe — ${b.name}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;} html,body{height:100%;font-family:Georgia,serif;background:#0a0f0d;color:rgba(255,255,255,0.82);display:flex;align-items:center;justify-content:center;}
  .card{max-width:420px;padding:40px 32px;text-align:center;}
  .wordmark{font-size:11px;letter-spacing:0.25em;text-transform:uppercase;color:rgba(255,255,255,0.35);margin-bottom:20px;}
  h1{font-size:20px;font-weight:normal;color:rgba(255,255,255,0.85);margin-bottom:14px;}
  p{font-size:14px;line-height:1.7;color:rgba(255,255,255,0.5);}
  a{color:rgba(180,230,200,0.7);text-decoration:none;}
</style></head>
<body><div class="card"><div class="wordmark">${b.name}</div><h1>${heading}</h1><p>${message}</p></div></body></html>`;

  if (!user) return res.status(404).send(page('Link not found', "This unsubscribe link isn't valid — it may have been copied incorrectly."));

  db.updateUserPreferences(user.id, { pref_email_news: 0 });
  res.send(page('You\'re unsubscribed', `You won't receive any more newsletters from ${b.name}. If that was a mistake, you can turn it back on any time from <a href="${APP_URL}/account">My Account</a>.`));
});
app.get('/register/',(req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/change-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'change-password.html')));
// Shared client-side brand injection — see public/brand-inject.js. This is the
// first external asset file in the app (everything else is inlined per page);
// served the same explicit-route way as every other static file here rather
// than adding an express.static() mount, so it doesn't change how the rest
// of the app serves files.
app.get('/brand-inject.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'brand-inject.js')));
// Per's report — the exact same symptom message-editor.js's no-store fix
// below was written for: a real deploy landed correctly (git confirmed
// nothing left to commit), but the browser kept running the old cached
// copy with no visible sign anything was wrong. tomte-widget.js just
// never got this same treatment applied to it before now, despite
// carrying exactly the same risk — it's under just as active iteration
// right now (the view-my-practices action fix two rounds back is what
// surfaced this gap) as message-editor.js was when that fix was written.
app.get('/tomte-widget.js', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'tomte-widget.js')); });
// Per's request — a genuinely public download, deliberately no auth check
// at all, since the whole point is reaching someone who isn't a member or
// facilitator yet (the "Teaching The FELT Way" page below, and any
// What's New item that links here). No express.static() mount exists in
// this app by design (see the note on that near the top of this file) —
// every servable file needs its own explicit route, same reasoning as
// tomte-widget.js just above.
app.get('/downloads/teaching-the-felt-way-guide.pdf', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'downloads', 'Teaching_With_Deeper_Mindfulness_Facilitator_Guide.pdf'));
});
// ── Public course catalog (Per's request) ── No auth on any of these
// four — the whole point is reaching someone who isn't a member,
// student, or facilitator yet. Each one calls a db function that already
// does its own filtering for what's safe to show publicly (see the
// comment on getPublicFacilitator/getPublicSchedule/etc. in db.js) — this
// layer doesn't re-check anything, it trusts that filtering completely.
app.get('/api/public/schedule', (req, res) => {
  try { res.json(db.getPublicSchedule()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/public/courses/:id', (req, res) => {
  try {
    const course = db.getPublicCourseOverview(req.params.id);
    if (!course) return res.status(404).json({ error: 'Not found.' });
    res.json(course);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/public/instances/:id', (req, res) => {
  try {
    const instance = db.getPublicInstanceOverview(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Not found.' });
    res.json({ ...instance, facilitators: instance.facilitators.map(f => ({ ...f, photoUrl: f.photo_filename ? tomteImageUrl(f.photo_filename) : null })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/public/facilitators/:id', (req, res) => {
  try {
    const fac = db.getPublicFacilitator(req.params.id);
    if (!fac) return res.status(404).json({ error: 'Not found.' });
    res.json({ ...fac, photoUrl: fac.photo_filename ? tomteImageUrl(fac.photo_filename) : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/assets/tomte.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'assets', 'tomte.png')));
app.get('/assets/bulk-import-sample.xlsx', (req, res) => res.sendFile(path.join(__dirname, 'public', 'assets', 'bulk-import-sample.xlsx')));
// Per Bot 17 fix: these two were missing entirely. This app has no
// express.static() mount by design (see comment above) — every file
// genuinely needs its own explicit route, and dialogs.js/call.js never
// got one when they were added in Per Bot 11/12. Both script tags were
// silently 404ing since then, which meant window.appAlert/appConfirm/
// appPrompt and window.PerBotCall were undefined everywhere they were
// used — every delete/confirm dialog across the whole app, and the
// entire video/audio calling feature, back to the sessions that
// introduced them.
app.get('/js/dialogs.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'js', 'dialogs.js')));
app.get('/js/call.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'js', 'call.js')));
// Per Bot 51 — offline caching's service worker. Must be reachable at
// the site root (not e.g. /js/service-worker.js) — a service worker's
// default control scope is everything at or below its own URL path, and
// this one needs to intercept /api/content/library/... requests, which
// a /js/-scoped worker never could. no-store for the same reason as
// message-editor.js below: this file is what the browser checks on
// every page load to see whether a new version needs installing, and a
// cached stale copy of the CHECKER ITSELF would mean an update never
// gets noticed at all.
app.get('/service-worker.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'service-worker.js'));
});
// Per Bot 24 — explicit no-store here, unlike the other static routes
// above. This file is under active iteration (comms2's shared editor) —
// without this, a deploy that changes it can leave a browser silently
// running a stale cached copy with no visible sign anything's wrong,
// which is exactly what happened testing the Reminder switch-over: a
// real deploy landed, but the old file kept being served/executed
// client-side. no-store forces a real fetch every time, at the cost of
// one small request per page load — worth it for a file that changes
// this often right now.
app.get('/js/message-editor.js', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'js', 'message-editor.js')); });
app.get('/',                (req, res) => res.redirect('/login'));

function roleRouter(allowedRoles, file) {
  return (req, res) => {
    const token = req.cookies?.[auth.COOKIE_NAME];
    const user  = token ? auth.verifyToken(token) : null;
    if (!user) return res.redirect('/login');
    if (!allowedRoles.includes(user.role)) {
      const map = { admin: '/admin/', facilitator: '/facilitator/', client: '/client/' };
      return res.redirect(map[user.role] || '/login');
    }
    // A fresh clone's admin panel would otherwise show default branding —
    // send them to /setup instead of a half-configured dashboard, even if
    // they navigated here directly rather than via a fresh login.
    if (user.role === 'admin' && !db.isSetupComplete()) return res.redirect('/setup');
    res.sendFile(path.join(__dirname, file));
  };
}

app.get('/admin',       roleRouter(['admin'], 'public/admin/index.html'));
app.get('/admin/',      roleRouter(['admin'], 'public/admin/index.html'));
app.get('/facilitator', roleRouter(['admin','facilitator'], 'public/facilitator/index.html'));
app.get('/facilitator/',roleRouter(['admin','facilitator'], 'public/facilitator/index.html'));
app.get('/client',      roleRouter(['client'], 'public/client/index.html'));
app.get('/client/',     roleRouter(['client'], 'public/client/index.html'));

// ── Auth API ──
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ error: 'Email and password required.' });
  const user = await auth.login(email, password);
  if (!user) return res.json({ error: 'Email or password not recognised.' });
  // Per Bot 18 — this was documented as happening ("checkTrialExpiry()
  // called on login" — see the comment above its definition in db.js) but
  // was never actually wired up anywhere in the app. Practical effect:
  // nobody's trial or manually-set membership period has ever actually
  // auto-expired — someone whose access should have lapsed just stayed at
  // their prior tier indefinitely, silently, until this was found and
  // fixed. Restoring it here for real, plus on /api/my/profile below for
  // long-lived sessions that don't re-login often.
  if (user.role === 'client') {
    const checked = db.checkTrialExpiry(user.id);
    if (checked._enteredSaversGrace) emailSaversCancelGrace0(checked).catch(e => console.error('[expiry] savers grace-entry email failed:', e.message));
  }
  const token = auth.createToken(user);
  res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
  try { db.logLogin(user.id, user.role, 'login'); } catch(e) { console.error('[login_log] failed:', e.message); }
  if (user.mustChangePassword) return res.json({ redirect: '/change-password' });

  // A fresh clone (Path A: one deployment per facilitator/org) sends its
  // first admin straight to setup rather than an empty, unbranded dashboard.
  if (user.role === 'admin' && !db.isSetupComplete()) return res.json({ redirect: '/setup' });

  // Check if facilitator/admin also has a client record — show role chooser
  if (user.role === 'facilitator' || user.role === 'admin') {
    const userRecord = db.getUserByEmail(user.email.toLowerCase());
    if (userRecord) {
      return res.json({ chooseRole: true, name: user.name });
    }
  }

  const redirectMap = { admin: '/admin/', facilitator: '/facilitator/', client: '/client/?justLoggedIn=1' };
  res.json({ redirect: redirectMap[user.role] || '/login' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(auth.COOKIE_NAME);
  res.json({ ok: true });
});

// ── Forgot password (Per Bot 8) — self-service, works for both client and
// facilitator/admin accounts. Always returns the same generic response
// regardless of whether the email matched anything, so this can't be used
// to probe which addresses have accounts. ──
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    if (email) {
      const token     = uuidv4() + uuidv4();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const user = db.getUserByEmail(email);
      const fac  = user ? null : db.getFacilitatorByEmail(email);
      if (user) { db.setUserResetToken(user.id, token, expiresAt); emailPasswordResetLink(user.name, user.email, token, user.language); }
      else if (fac) { db.setFacilitatorResetToken(fac.id, token, expiresAt); emailPasswordResetLink(fac.name, fac.email, token); }
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('forgot-password error:', e);
    res.json({ ok: true }); // still don't leak anything on error
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Missing token or password.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const hash = await auth.hashPassword(password);
    const user = db.getUserByResetToken(token);
    if (user) {
      const grantedTrial = grantFirstPasswordTrialIfEligible(user);
      db.updateClientPassword(user.id, hash);
      db.clearUserResetToken(user.id);
      // Per Bot 24 — passwordless/silent login: clicking a valid reset
      // link and choosing a new password now signs the person straight
      // in, the same way a real /api/login success does (same token
      // shape, same cookie) — no separate trip to the sign-in page where
      // they'd have had to type their email (and now their brand-new
      // password) all over again immediately after just setting it.
      const freshUser = db.getUser(user.id);
      const authToken = auth.createToken({ role: 'client', id: freshUser.id, name: freshUser.name, email: freshUser.email });
      res.cookie(auth.COOKIE_NAME, authToken, auth.COOKIE_OPTIONS);
      try { db.logLogin(freshUser.id, 'client', 'login'); } catch(e) { console.error('[login_log] failed:', e.message); }
      return res.json({ ok: true, grantedTrial, loggedIn: true, redirect: '/client/' });
    }
    const fac = db.getFacilitatorByResetToken(token);
    if (fac) {
      db.updateFacilitatorPassword(fac.id, hash);
      db.clearFacilitatorResetToken(fac.id);
      const freshFac = db.getFacilitatorById ? db.getFacilitatorById(fac.id) : fac;
      const role = freshFac.role || fac.role;
      const authToken = auth.createToken({ role, id: freshFac.id, name: freshFac.name, email: freshFac.email });
      res.cookie(auth.COOKIE_NAME, authToken, auth.COOKIE_OPTIONS);
      try { db.logLogin(freshFac.id, role, 'login'); } catch(e) { console.error('[login_log] failed:', e.message); }
      const redirectMap = { admin: '/admin/', facilitator: '/facilitator/' };
      return res.json({ ok: true, loggedIn: true, redirect: redirectMap[role] || '/login' });
    }
    res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one from the login page.' });
  } catch(e) {
    console.error('reset-password error:', e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ── Admin-triggered immediate reset (Per Bot 8) — for when someone can't
// get to their email, or an admin just wants to hand over a password
// directly. Generates a temp password the same way Add Member does,
// forces a change on next login, and returns the temp password in the
// response too (not just the email) so it's still usable if the email
// bounces or the admin wants to read it out over the phone. ──
app.patch('/api/admin/users/:id/reset-password', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const user = db.getUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const isFirstEverPassword = !user.password_hash;
    const tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
    const hash = await auth.hashPassword(tempPassword);
    // Per Bot 20 — same rule as the self-service reset-password route:
    // if this Explorer has never had a password before, giving them one
    // now (however it happens — their own link, forgot-password, or an
    // admin doing it directly) is the same "first real login" moment, so
    // it gets the same standard trial. A real Member or Explorer with an
    // existing password getting a fresh temp password from an admin is
    // untouched — this only ever fires once, the genuine first time.
    const grantedTrial = grantFirstPasswordTrialIfEligible(user);
    db.adminResetUserPassword(req.params.id, hash);
    const sendEmail = req.body.sendEmail !== false;
    const freshUser = db.getUser(req.params.id);
    const trialEndsAt = grantedTrial ? freshUser.trial_ends_at : null;
    // Per Bot 22 — a manual expiry set earlier (at creation, or via the
    // Upgrade flow) wasn't being surfaced here at all before, only a
    // trial freshly granted at this exact moment. See emailAdminPasswordReset.
    const manualExpiresAt = !grantedTrial ? freshUser.member_expires_at : null;
    if (sendEmail) emailAdminPasswordReset(user.name, user.email, tempPassword, user.language, isFirstEverPassword, trialEndsAt, manualExpiresAt);
    res.json({ ok: true, tempPassword, emailSent: sendEmail, grantedTrial });
  } catch(e) {
    console.error('admin reset-password error:', e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});
app.patch('/api/admin/facilitators/:id/reset-password', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const fac = db.getFacilitatorById(req.params.id);
    if (!fac) return res.status(404).json({ error: 'Facilitator not found.' });
    const tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
    const hash = await auth.hashPassword(tempPassword);
    db.adminResetFacilitatorPassword(req.params.id, hash);
    const sendEmail = req.body.sendEmail !== false;
    if (sendEmail) emailAdminPasswordReset(fac.name, fac.email, tempPassword);
    res.json({ ok: true, tempPassword, emailSent: sendEmail });
  } catch(e) {
    console.error('admin reset-password error:', e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ── Offers (Per Bot 17) ── Resolves what trial length + attribution a
// self-registration should get: an explicit, currently-valid promo code
// wins; otherwise the standing default offer if one exists and is valid;
// otherwise the pre-Offers hardcoded fallback (14 days, no attribution) so
// registration never breaks even if the offers table is ever empty.
function resolveOfferForSignup(promoCode) {
  if (promoCode) {
    const offer = db.getOfferByCode(promoCode);
    if (offer && db.isOfferCurrentlyValid(offer)) return { trialDays: offer.trial_days, offerId: offer.id };
  }
  const def = db.getDefaultOffer();
  if (def && db.isOfferCurrentlyValid(def)) return { trialDays: def.trial_days, offerId: def.id };
  return { trialDays: 14, offerId: null };
}

// Per Bot 20 — the same "first real password → standard trial" grant the
// invite-claim route already does, pulled out into one shared place so it
// applies identically wherever else someone can set their very first
// password: the self-service "Forgot password" flow, and an admin-
// triggered reset. Both of those previously just set a password with no
// tier change at all — meaning anyone from the newsletter migration who
// used "Forgot password" instead of their personal invite link (a very
// findable, very normal thing to do) quietly ended up permanent Explorer
// with no promo, with no way for them or Per to know anything had been
// missed.
//
// The condition is deliberately narrow: password_hash must have been
// genuinely NULL before this call (never had one — not "forgot an
// existing one") AND tier must be EXACTLY 0 — genuinely already invited
// to Explorer, not -1. That second part matters more here than it does
// for the invite-claim route: this same check backs the public
// "Forgot password" form, which anyone can trigger for any email address
// that exists in the system at all, invited or not. Without pinning it to
// exactly 0, a raw newsletter contact who was never invited to anything
// could self-escalate into a full trial just by guessing their own email
// works there — worse than the thing Per asked to fix, not better. A real
// Explorer or Member resetting an existing forgotten password never has a
// null password_hash to begin with, so this never touches their tier
// either way.
function grantFirstPasswordTrialIfEligible(userBeforePasswordSet) {
  const eligible = !userBeforePasswordSet.password_hash && userBeforePasswordSet.member_tier === 0;
  if (!eligible) return false;
  const { trialDays, offerId } = resolveOfferForSignup(null);
  const trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString();
  db.setMemberTier(userBeforePasswordSet.id, 1, null, trialEndsAt, null, null);
  if (offerId) db.setSignupOfferId(userBeforePasswordSet.id, offerId);
  return true;
}

// Public lookup — used by the promo/signup page (and safe to hit directly
// for testing) to show an offer's headline/trial length before anyone
// registers. Returns only what's safe to show publicly; never the admin
// fields (cloned_from, active flag internals) or offers that have expired
// or aren't active, since those shouldn't be advertised even if someone
// still has the old link.
app.get('/api/public/offers/:code', (req, res) => {
  const offer = db.getOfferByCode(req.params.code);
  if (!offer || !db.isOfferCurrentlyValid(offer)) return res.status(404).json({ error: 'This offer is no longer available.' });
  res.json({
    code: offer.code, name: offer.name, headline: offer.headline,
    description: offer.description, trial_days: offer.trial_days,
  });
});

// Public lookup for the standing default offer (no code) — used by the
// promotions landing page when someone arrives with no specific campaign
// link, so the page still has real headline/trial copy to show rather
// than a hardcoded fallback that could drift out of sync with whatever
// the default offer actually says in the admin UI.
app.get('/api/public/default-offer', (req, res) => {
  const offer = db.getDefaultOffer();
  if (!offer || !db.isOfferCurrentlyValid(offer)) return res.status(404).json({ error: 'No active default offer.' });
  res.json({
    code: offer.code, name: offer.name, headline: offer.headline,
    description: offer.description, trial_days: offer.trial_days,
  });
});

// Public — every free, currently open course, for the /promotions
// "what's included" section. See getPublicOpenCourses for why this is
// broader than the featured-courses carousel.
app.get('/api/public/open-courses', (req, res) => {
  try { res.json(db.getPublicOpenCourses()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Per Bot 18 — /promotions showcase clip. Genuinely public, zero login —
// only ever serves a file an admin explicitly picked as an offer's (or the
// global default's) showcase, never anything else in the library. Same
// r2/disk URL branching as the authenticated playback-url route, just
// without any access check beyond "is this file currently a showcase".
app.get('/api/public/showcase-file', async (req, res) => {
  try {
    const file = db.resolveShowcaseFile(req.query.promoCode || null);
    if (!file) return res.status(404).json({ error: 'No showcase file set.' });
    if (file.storage_type === 'r2') {
      const url = await media.getPlaybackUrl(file.filename, {});
      return res.json({ url, title: file.title, fileType: file.file_type, expiresIn: 600 });
    }
    res.json({ url: `/uploads/${file.filename}`, title: file.title, fileType: file.file_type, expiresIn: null });
  } catch (e) {
    console.error('showcase-file error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Self-registration ──
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, language, skinSlug, consent, marketingOptIn } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!email.includes('@')) return res.status(400).json({ error: 'Please enter a valid email.' });
    // The client already blocks submission without this, but that's just
    // UX — the actual requirement has to be enforced here too, or it's not
    // really a requirement.
    if (!consent) return res.status(400).json({ error: 'Please agree to your name and email being stored to continue.' });
    // Anything outside the supported set falls back to English rather than
    // storing a value nothing downstream (Talk's language instruction,
    // localized email templates) knows how to handle.
    const safeLanguage = (language && LANGUAGE_NAMES[language]) ? language : 'en';

    const emailLower = email.toLowerCase().trim();

    const existingFac = db.getFacilitatorByEmail(emailLower);
    if (existingFac) return res.status(400).json({ error: 'An account with this email already exists.' });

    const existingUser = db.getUserByEmail(emailLower);
    if (existingUser) return res.status(400).json({ error: 'An account with this email already exists.' });

    const id   = uuidv4();
    const hash = await auth.hashPassword(password);
    const { promoCode, source } = req.body;
    const { trialDays, offerId } = resolveOfferForSignup(promoCode);
    db.registerUser(id, name.trim(), emailLower, hash, safeLanguage, {
      consentGiven: !!consent,
      consentVersion: 'self-registration-v2',
      marketingOptIn: !!marketingOptIn,
    }, trialDays, offerId, source || null);

    // If there's a pending invitation, link them to the facilitator
    const { inviteToken } = req.body;
    let invitationSkin = null;
    if (inviteToken) {
      const inv = db.getInvitationByToken(inviteToken);
      if (inv && !inv.accepted_at && new Date(inv.expires_at) > new Date() && inv.email === emailLower) {
        db.markAsClient(id, inv.facilitator_id);
        db.acceptInvitation(inviteToken, new Date().toISOString());
        invitationSkin = inv.skin_id;
      }
    }
    // Skin assignment is permanent from here — set once at account
    // creation, then persists regardless of which URL someone later logs
    // in from (see the skins table comment in db.js). An invitation's own
    // skin wins over the plain URL slug, since that reflects a deliberate
    // choice by whoever sent it, not just whichever link happened to be
    // clicked.
    const resolvedSkin = invitationSkin || (skinSlug && db.getSkin(skinSlug) ? skinSlug : null);
    if (resolvedSkin) db.setUserSkin(id, resolvedSkin);

    // Referral (Per Bot 22) — captured once, here, same as the skin above.
    // ref is just another client's own user id; a self-referral or a
    // reference to a non-existent/non-client account is silently dropped
    // rather than erroring the whole registration over it.
    const { ref } = req.body;
    if (ref && ref !== id) {
      const referrer = db.getUser(ref);
      if (referrer) db.setReferredBy(id, ref);
    }

    // Log them in immediately
    const token = auth.createToken({ role: 'client', id, name: name.trim(), email: emailLower });
    res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
    try { db.logLogin(id, 'client', 'register'); } catch(e) { console.error('[login_log] failed:', e.message); }

    // Per's request — instance-aware registration. Someone arriving from
    // a course-instance page's "Register" button should land enrolled,
    // not just signed up needing a second step to find and join the same
    // course again. Reuses attemptEnrolUser exactly as-is (skin/tier
    // checks, capacity, payment-or-free branch, confirmation email) —
    // the same function the in-app Enrol button itself calls — rather
    // than a second implementation here.
    const { instanceId } = req.body;
    if (instanceId) {
      try {
        const newUser = db.getUser(id);
        const enrolResult = await attemptEnrolUser(newUser, instanceId);
        if (enrolResult.requiresPayment) {
          // Priced instance — straight to Stripe rather than the app, same
          // as the in-app Enrol button's own requiresPayment handling.
          return res.json({ redirect: enrolResult.checkoutUrl });
        }
        // Free enrol succeeded, already enrolled, or a soft error (e.g.
        // cohort just filled up) — any of these, land them in the app on
        // the course itself via the same deep-link the reminder emails
        // use, rather than the generic welcome screen. A soft error here
        // isn't worth failing the whole registration over — the account
        // itself was created successfully either way.
        return res.json({ redirect: `/client/?justLoggedIn=1&course=${instanceId}` });
      } catch(e) {
        console.error('[post-register enrol]', e.message);
      }
    }
    res.json({ redirect: '/client/?justLoggedIn=1' });
  } catch(e) {
    console.error('register error:', e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Magic-link invite claim (Per Bot 6) ── A newsletter-only contact clicks
// their personal /join/:token link from a newsletter and lands as a real
// Member — trial is fixed at 14 days, but critically the clock only starts
// HERE, at the moment they actually claim it, not when the link was
// generated or the newsletter was sent. The token itself never expires on
// a timer; only using it does (invite_token_used_at) — someone opening the
// link two weeks after it arrived still gets a full, fresh trial.
app.get('/api/invite/:token', (req, res) => {
  try {
    const user = db.getUserByInviteToken(req.params.token);
    if (!user) return res.status(404).json({ error: 'invalid' });
    if (user.invite_token_used_at) return res.status(410).json({ error: 'used' });
    res.json({ name: user.name, email: user.email });
  } catch(e) {
    console.error('invite lookup error:', e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/invite/:token/claim', async (req, res) => {
  try {
    const user = db.getUserByInviteToken(req.params.token);
    if (!user) return res.status(404).json({ error: 'invalid' });
    if (user.invite_token_used_at) return res.status(410).json({ error: 'used' });

    let { name, password, promoCode, source } = req.body;
    name = (name && name.trim()) || user.name;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const hash = await auth.hashPassword(password);
    db.updateClientPassword(user.id, hash);
    if (name !== user.name) db.updateUserName(user.id, name);

    // Per Bot 18 — trial/offer logic only applies if this person was
    // genuinely still at Explorer (tier 0) before clicking. Someone an
    // admin has already manually moved to a paid tier with a real expiry
    // set — e.g. a lapsed legacy member being brought back in at the
    // membership they already have time left on — keeps exactly what was
    // set. Without this check, every claim would blindly recalculate a
    // fresh trial from today and silently overwrite that expiry the
    // moment they clicked the link, which is never what's wanted for an
    // already-configured account.
    if ((user.member_tier ?? 0) < 1) {
      const { trialDays, offerId } = resolveOfferForSignup(promoCode);
      const trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString();
      db.setMemberTier(user.id, 1, null, trialEndsAt, null, null);
      if (offerId) db.setSignupOfferId(user.id, offerId);
      if (source) db.setSignupSource(user.id, source);
    }
    db.markInviteTokenUsed(user.id);

    const token = auth.createToken({ role: 'client', id: user.id, name, email: user.email });
    res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
    try { db.logLogin(user.id, 'client', 'invite_claim'); } catch(e) { console.error('[login_log] failed:', e.message); }
    res.json({ ok: true, redirect: '/client/' });
  } catch(e) {
    console.error('invite claim error:', e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Switch to client role — swaps session cookie for dual-role users ──
app.post('/api/switch-to-client', auth.requireAuthApi(['facilitator', 'admin']), (req, res) => {
  try {
    const fac  = db.getFacilitatorById(req.user.id);
    const user = fac ? db.getUserByEmail(fac.email) : null;
    if (!user) return res.status(404).json({ error: 'No user record found for this email.' });
    const token = auth.createToken({ role: 'client', id: user.id, name: user.name, email: user.email });
    res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
    try { db.logLogin(user.id, 'client', 'role_switch'); } catch(e) { console.error('[login_log] failed:', e.message); }
    res.json({ redirect: '/client/' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/change-password', auth.requireAuthApi(), async (req, res) => {
  const { password, currentPassword } = req.body;
  if (!password || password.length < 8) return res.json({ error: 'Password must be at least 8 characters.' });
  const user = req.user;
  if (currentPassword) {
    const record = user.role === 'client' ? db.getUser(user.id) : db.getFacilitatorById(user.id);
    const valid = record ? await auth.verifyPassword(currentPassword, record.password_hash) : false;
    if (!valid) return res.json({ error: 'Current password is incorrect.' });
  }
  const hash = await auth.hashPassword(password);
  if (user.role === 'client') db.updateClientPassword(user.id, hash);
  else db.updateFacilitatorPassword(user.id, hash);
  if (!currentPassword) {
    const redirectMap = { admin: '/admin/', facilitator: '/facilitator/', client: '/client/' };
    return res.json({ redirect: redirectMap[user.role] || '/login' });
  }
  res.json({ ok: true });
});

// ── Admin API ──
app.get('/api/admin/facilitators', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getAllFacilitators(req.query.archived === '1'));
});
app.get('/api/admin/admins', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getAllAdmins());
});
app.patch('/api/admin/facilitators/:id', auth.requireAuthApi(['admin']), async (req, res) => {
  const { name, email, action, bio, credentials, publicProfile } = req.body;
  if (action === 'archive')   { db.archiveFacilitator(req.params.id); return res.json({ ok: true }); }
  if (action === 'unarchive') { db.unarchiveFacilitator(req.params.id); return res.json({ ok: true }); }
  if (action === 'reset_password') {
    const fac = db.getFacilitatorById(req.params.id);
    if (!fac) return res.status(404).json({ error: 'Not found.' });
    const tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
    const hash = await auth.hashPassword(tempPassword);
    db.updateFacilitatorPassword(req.params.id, hash);
    sendEmail(fac.email, `Your ${brand().name} password has been reset`,
      `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px">
        <h1 style="font-size:22px;font-weight:normal">Password reset</h1>
        <p>Your temporary password: <strong style="font-family:monospace;font-size:18px">${tempPassword}</strong></p>
        <p><a href="${APP_URL}/login?email=${encodeURIComponent(fac.email)}">${APP_URL}</a></p>
      </div>`
    );
    return res.json({ ok: true, tempPassword });
  }
  // Per's request — public bio-page fields, alongside the existing name/
  // email path below rather than a separate route, since these are all
  // just "edit this facilitator" from the same admin modal. Checked
  // independently of name/email so this can be saved on its own (the
  // bio form doesn't necessarily touch name/email at the same time).
  if (bio !== undefined || credentials !== undefined || publicProfile !== undefined) {
    db.updateFacilitatorProfile(req.params.id, { bio, credentials, publicProfile });
    return res.json({ ok: true });
  }
  if (name && email) { db.updateFacilitatorDetails(req.params.id, name.trim(), email.trim()); return res.json({ ok: true }); }
  res.status(400).json({ error: 'Invalid request.' });
});
// Per's request — a facilitator's public bio-page photo. Own route since
// this needs multipart handling, unlike the plain-JSON fields just
// above. Same R2-backed upload pattern as onboarding tour slides
// (uploadTomteImageToR2/tomteImageUrl) — deliberately reused rather than
// a parallel image-handling path.
app.post('/api/admin/facilitators/:id/photo', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  if (!db.getFacilitatorById(req.params.id)) return res.status(404).json({ error: 'Facilitator not found.' });
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const stored = await uploadTomteImageToR2(req.file);
    db.updateFacilitatorProfile(req.params.id, { photoFilename: stored });
    res.json({ ok: true, url: tomteImageUrl(stored) });
  } catch (e) {
    console.error('facilitator photo upload error:', e.message);
    res.status(500).json({ error: 'Could not upload photo right now — please try again.' });
  }
});
// ── Facilitator self-service (Per's request — "facilitators must be
// self-sufficient and able to edit own information") ── Deliberately
// separate from the admin routes above rather than reusing them with a
// role check bolted on: these three never take an id param at all, they
// always act on req.user.id — there is no way to construct a request
// here that touches anyone else's profile, by design, not by a
// permission check that could have a gap in it.
app.get('/api/facilitator/profile', auth.requireAuthApi(['facilitator']), (req, res) => {
  const fac = db.getFacilitatorById(req.user.id);
  if (!fac) return res.status(404).json({ error: 'Not found.' });
  res.json({ bio: fac.bio, credentials: fac.credentials, public_profile: fac.public_profile,
    photoUrl: fac.photo_filename ? tomteImageUrl(fac.photo_filename) : null });
});
app.patch('/api/facilitator/profile', auth.requireAuthApi(['facilitator']), (req, res) => {
  const { bio, credentials, publicProfile } = req.body;
  db.updateFacilitatorProfile(req.user.id, { bio, credentials, publicProfile });
  res.json({ ok: true });
});
app.post('/api/facilitator/profile/photo', auth.requireAuthApi(['facilitator']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const stored = await uploadTomteImageToR2(req.file);
    db.updateFacilitatorProfile(req.user.id, { photoFilename: stored });
    res.json({ ok: true, url: tomteImageUrl(stored) });
  } catch (e) {
    console.error('facilitator self photo upload error:', e.message);
    res.status(500).json({ error: 'Could not upload photo right now — please try again.' });
  }
});
app.post('/api/admin/facilitators', auth.requireAuthApi(['admin']), async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
  if (db.getFacilitatorByEmail(email)) return res.status(400).json({ error: 'Email already in use.' });
  const tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
  const hash = await auth.hashPassword(tempPassword);
  const id = uuidv4();
  db.createFacilitator(id, name.trim(), email.trim(), hash, 'facilitator');
  emailWelcomeFacilitator(name.trim(), email.trim(), tempPassword);
  res.json({ id, name, tempPassword });
});
app.delete('/api/admin/facilitators/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteFacilitator(req.params.id); res.json({ ok: true });
});
app.get('/api/admin/clients', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getAllUsersAdmin(req.query.archived === '1'));
});

// ── Message versions (Per Bot 54) — comms2 foundation ── Generic
// list/create(duplicate)/update/activate/delete for every registry type
// in db.MESSAGE_TYPE_REGISTRY. One set of routes serves all of them —
// the type-specific field shape (SMS body, day-threshold) lives in
// MESSAGE_TYPE_REGISTRY.extraCols, not in separate routes per type.
// /types is what comms2's front-end reads to build its list of tables
// and know which extra fields to render for each.
app.get('/api/admin/message-versions/types', auth.requireAuthApi(['admin']), (req, res) => {
  const types = Object.keys(db.MESSAGE_TYPE_REGISTRY).map(type => ({
    type, label: db.MESSAGE_TYPE_REGISTRY[type].label,
    extraFields: Object.keys(db.MESSAGE_TYPE_REGISTRY[type].extraCols || {}),
    hasActive: db.hasActiveMessageVersion(type),
  }));
  res.json(types);
});
app.get('/api/admin/message-versions', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const type = req.query.type;
    if (!db.isKnownMessageType(type)) return res.status(400).json({ error: 'Unknown message type: ' + type });
    res.json(db.listMessageVersions(type));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/message-versions', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { type, label, subject, body, format, extra, makeActive } = req.body;
    if (!db.isKnownMessageType(type)) return res.status(400).json({ error: 'Unknown message type: ' + type });
    const row = db.createMessageVersion(type, { label, subject, body, format, extra }, !!makeActive);
    res.json({ ok: true, version: row });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/message-versions/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const row = db.updateMessageVersion(req.params.id, req.body || {});
    if (!row) return res.status(404).json({ error: 'Version not found.' });
    res.json({ ok: true, version: row });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/message-versions/:id/activate', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const row = db.activateMessageVersion(req.params.id);
    if (!row) return res.status(404).json({ error: 'Version not found.' });
    res.json({ ok: true, version: row });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/message-versions/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const result = db.deleteMessageVersion(req.params.id);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Bulk trial extension (Per Bot 38) — "everyone currently on trial
// gets N more days," in one action, rather than editing people one at a
// time. GET returns a live count for the confirmation prompt; POST does
// the actual extension and returns how many were affected.
app.get('/api/admin/trials/active-count', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const userIds = req.query.userIds ? String(req.query.userIds).split(',').filter(Boolean) : null;
    res.json({ count: db.countActiveTrials(userIds) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/trials/extend-all', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const days = Number(req.body.days);
    if (!days || days <= 0 || days > 365) return res.status(400).json({ error: 'Enter a number of days between 1 and 365.' });
    const userIds = Array.isArray(req.body.userIds) && req.body.userIds.length ? req.body.userIds : null;
    const emailType = ['features', 'simple', 'none'].includes(req.body.emailType) ? req.body.emailType : 'none';
    const affectedRows = db.extendAllActiveTrials(days, userIds);
    if (emailType !== 'none') {
      // Fire-and-forget per person — a slow or failed send to one
      // person shouldn't hold up the response or fail the whole batch;
      // the data change has already happened either way. Re-fetches the
      // full user record since buildMessageTokens (inside
      // emailTrialUpdated) needs more than the handful of fields the
      // db.js update function itself returns.
      affectedRows.forEach(u => {
        const fullUser = db.getUser(u.id);
        if (fullUser?.email) emailTrialUpdated(fullUser, days, emailType, false)
          .catch(e => console.error('[trial-extend email]', fullUser.email, e.message));
      });
    }
    res.json({ ok: true, affected: affectedRows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Per Bot 40, broadened Per Bot 54 — grants a fresh trial to selected
// Explorers (member_tier=0), whether their trial lapsed before or they
// never had one. Always requires an explicit selection — no
// bulk-everyone mode, since that's the safety check now doing the work
// instead of trial history: only whoever the admin actually picked.
app.get('/api/admin/trials/lapsed-count', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const userIds = req.query.userIds ? String(req.query.userIds).split(',').filter(Boolean) : [];
    res.json({ count: db.countLapsedTrialUsers(userIds) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/trials/regrant', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const days = Number(req.body.days);
    if (!days || days <= 0 || days > 365) return res.status(400).json({ error: 'Enter a number of days between 1 and 365.' });
    const userIds = Array.isArray(req.body.userIds) ? req.body.userIds : [];
    if (!userIds.length) return res.status(400).json({ error: 'Select at least one person first.' });
    const emailType = ['features', 'simple', 'none'].includes(req.body.emailType) ? req.body.emailType : 'none';
    const affectedRows = db.regrantTrialForLapsedUsers(userIds, days);
    if (emailType !== 'none') {
      affectedRows.forEach(u => {
        const fullUser = db.getUser(u.id);
        if (fullUser?.email) emailTrialUpdated(fullUser, days, emailType, true)
          .catch(e => console.error('[trial-regrant email]', fullUser.email, e.message));
      });
    }
    res.json({ ok: true, affected: affectedRows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Add Member ──
// Mirrors self-registration: same fields, same email-confirmation-with-password-change flow.
// GDPR: consent is recorded as given by the admin on the member's behalf at creation time,
// since this mirrors the same consent checkbox shown on self-registration.
// Per Bot 19j — single-person counterpart to /api/admin/members/bulk-import,
// same tier/trial/offer/skin/welcome-email shape. Built for the unified
// "Add User" interface (one person or a whole file, same settings either
// way) — replaces /api/admin/members and /api/admin/explorers as the
// entry point for creating a real account or a newsletter-only contact
// from the admin UI, though those two older routes are left in place
// untouched in case anything else still calls them directly.
app.post('/api/admin/users/create', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { name, email, tier: tierRaw, trialWeeks, offerId, skinId, sendWelcomeEmail, manualExpiryDate } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required.' });
    if (!email || !email.trim()) return res.status(400).json({ error: 'Email required.' });
    const emailLower = email.trim().toLowerCase();

    if (db.getFacilitatorByEmail(emailLower) || db.getUserByEmail(emailLower)) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    const isNewsletterOnly = tierRaw === 'newsletter_only';
    const tier = isNewsletterOnly ? null : parseInt(tierRaw, 10);
    if (!isNewsletterOnly && ![0, 1, 2, 3].includes(tier)) return res.status(400).json({ error: 'Invalid level.' });

    // Per Bot 22 — manual expiry date, for a legacy paid subscriber with
    // no live Stripe subscription (e.g. a WordPress/MemberPress carry-
    // over). Mutually exclusive with the trial fields below — a person
    // is either on a trial or has a real paid-until date, not both.
    // Only meaningful for a real membership tier, same restriction as
    // trialWeeks already has (Explorer/newsletter-only never expire this way).
    if (manualExpiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(manualExpiryDate)) {
      return res.status(400).json({ error: 'manualExpiryDate must be YYYY-MM-DD.' });
    }
    if (manualExpiryDate && (isNewsletterOnly || tier === 0)) {
      return res.status(400).json({ error: 'A manual expiry date only applies to a paid membership level.' });
    }

    if (isNewsletterOnly) {
      const id = uuidv4();
      db.createMailingListContact(id, name.trim(), emailLower);
      return res.json({ id, name: name.trim(), email: emailLower, newsletterOnly: true });
    }

    const validSkinId = (skinId && db.getSkin(skinId)) ? skinId : null;
    const offer = offerId ? db.getOffer(offerId) : null;
    const offerTrialDays = (offer && db.isOfferCurrentlyValid(offer)) ? offer.trial_days : null;

    const id = uuidv4();
    const tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
    const passwordHash = await auth.hashPassword(tempPassword);

    db.createUser(id, name.trim(), null, emailLower, passwordHash, null, null, {
      // Per Bot 24 — was hardcoded consentGiven:true, recording that
      // this person had agreed to something they were never actually
      // shown — an admin ticking a box on their behalf isn't their own
      // consent. Left unset here; the mandatory first-login consent
      // gate (client/index.html) now catches this correctly the first
      // time they actually log in themselves, and records their real
      // agreement then, same as every other account-creation path.
      lawfulBasis: 'consent'
    });
    if (validSkinId) db.setUserSkin(id, validSkinId);
    if (offerTrialDays !== null) db.setSignupOfferId(id, offerId);

    let trialEndsAt = null;
    if (manualExpiryDate && tier > 0) {
      // Straight into member_expires_at — same field the Upgrade-flow
      // expiry route (/api/admin/users/:id/expiry) already writes to —
      // rather than computing a trialEndsAt. No trial involved here.
      db.setMemberTier(id, tier, manualExpiryDate, null, null, null);
    } else if (tier > 0) {
      // Same rule as bulk import: a valid offer's own trial length wins
      // over the manual weeks field, since a batch/person tied to a named
      // campaign should reflect that campaign's real trial length.
      const effectiveDays = offerTrialDays !== null ? offerTrialDays : (Math.max(0, parseInt(trialWeeks, 10) || 0) * 7);
      trialEndsAt = effectiveDays > 0 ? new Date(Date.now() + effectiveDays * 24 * 60 * 60 * 1000).toISOString() : null;
      db.setMemberTier(id, tier, null, trialEndsAt, null, null);
    }

    if (sendWelcomeEmail !== false) {
      emailWelcomeClient(name.trim(), emailLower, tempPassword, null, validSkinId, trialEndsAt, manualExpiryDate || null);
    }

    res.json({ id, name: name.trim(), email: emailLower, tempPassword });
  } catch(e) {
    console.error('add user error:', e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/admin/members', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { name, email, skinId } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
    const emailLower = email.toLowerCase().trim();

    if (db.getFacilitatorByEmail(emailLower)) return res.status(400).json({ error: 'An account with this email already exists.' });
    if (db.getUserByEmail(emailLower))      return res.status(400).json({ error: 'An account with this email already exists.' });

    const id = uuidv4();
    const tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
    const passwordHash = await auth.hashPassword(tempPassword);

    db.createUser(id, name.trim(), null, emailLower, passwordHash, null, null, {
      // Per Bot 24 — see the identical comment on /api/admin/members
      // above for why consentGiven is no longer hardcoded true here.
      lawfulBasis:     'consent'
    });
    db.upgradeToMember(id, 'member');
    if (skinId && db.getSkin(skinId)) db.setUserSkin(id, skinId);

    emailWelcomeClient(name.trim(), emailLower, tempPassword, null, skinId);
    res.json({ id, name: name.trim(), email: emailLower, tempPassword });
  } catch(e) {
    console.error('add member error:', e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
// Per Bot 15i — same shape as /api/admin/members, minus the Member-tier
// upgrade: creates a real account with login, staying at Explorer (tier
// 0) rather than being bumped to Member. Distinct from newsletter-only
// contacts (no login at all) — this person can sign in immediately.
app.post('/api/admin/explorers', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { name, email, skinId } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
    const emailLower = email.toLowerCase().trim();

    if (db.getFacilitatorByEmail(emailLower)) return res.status(400).json({ error: 'An account with this email already exists.' });
    if (db.getUserByEmail(emailLower))      return res.status(400).json({ error: 'An account with this email already exists.' });

    const id = uuidv4();
    const tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
    const passwordHash = await auth.hashPassword(tempPassword);

    db.createUser(id, name.trim(), null, emailLower, passwordHash, null, null, {
      // Per Bot 24 — see the identical comment on /api/admin/members above.
      lawfulBasis:     'consent'
    });
    if (skinId && db.getSkin(skinId)) db.setUserSkin(id, skinId);

    emailWelcomeClient(name.trim(), emailLower, tempPassword, null, skinId);
    res.json({ id, name: name.trim(), email: emailLower, tempPassword });
  } catch(e) {
    console.error('add explorer error:', e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Bulk member import ── CSV upload, applied as one batch: every valid row
// becomes an account at the SAME tier, with the SAME trial length, and
// either all get a welcome email or none do — this is a batch tool for
// "here's a spreadsheet of people, bring them in at level X", not a
// per-row-customisable importer. Column headers are matched flexibly
// (name/Name/Full Name, email/Email/Subscriber) so exports from different
// places don't need reformatting first.
//
// tier can be 0/1/2/3 (a real Explorer/Member account, password + optional
// welcome email) OR the string 'newsletter_only' — passive contacts with no
// password and no login, same as createMailingListContact used by the
// one-off mailing-list import script. No welcome email is ever sent for
// newsletter_only, regardless of what the form sends, since there's no
// password to tell anyone about.
//
// Welcome emails (real-account tiers only) are sent AFTER responding to the
// request, not awaited inline — a few hundred individual Scaleway sends
// would otherwise risk the request itself timing out. The response tells
// you how many were created immediately; the emails follow shortly after.
// Per Bot 18 — live Stripe lookup for a batch of people, for the People
// admin "Get Subscriptions" action. Uses stripe_customer_id if the user
// already has one on file (fastest, exact); falls back to searching
// Stripe by email otherwise — which is genuinely the only way to find a
// legacy customer the app's own webhooks never touched (e.g. paid
// through the old app, never synced here). Sequential, not parallel — a
// deliberately gentle pace against Stripe's rate limits since this is an
// admin-triggered batch action, not a hot path. Capped at 100 people per
// call; the front-end enforces this too so the error reads clearly if hit.
app.post('/api/admin/stripe/lookup-subscriptions', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Stripe isn\'t configured (no STRIPE_SECRET_KEY set).' });
    const ids = Array.isArray(req.body.userIds) ? req.body.userIds : [];
    if (!ids.length) return res.status(400).json({ error: 'No people selected.' });
    if (ids.length > 100) return res.status(400).json({ error: 'Please select 100 people or fewer at a time.' });

    const rows = [];
    for (const id of ids) {
      const user = db.getUser(id);
      if (!user) continue;
      const base = { userId: user.id, name: user.name, email: user.email };
      try {
        let customerId = user.stripe_customer_id || null;
        if (!customerId) {
          const found = await stripe.customers.list({ email: user.email, limit: 1 });
          customerId = found.data[0]?.id || null;
        }
        if (!customerId) { rows.push({ ...base, status: 'no Stripe customer found' }); continue; }

        const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
        if (!subs.data.length) { rows.push({ ...base, stripeCustomerId: customerId, status: 'customer exists, no subscriptions' }); continue; }

        for (const sub of subs.data) {
          const item = sub.items.data[0];
          const price = item?.price;
          rows.push({
            ...base,
            stripeCustomerId: customerId,
            subscriptionId: sub.id,
            status: sub.status,
            interval: price?.recurring?.interval || '',
            amount: price ? (price.unit_amount / 100).toFixed(2) : '',
            currency: (price?.currency || '').toUpperCase(),
            currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString().slice(0, 10) : '',
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          });
        }
      } catch (e) {
        rows.push({ ...base, status: 'error: ' + e.message });
      }
    }
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per Bot 18 — links a real, live Stripe subscription to a Per Bot
// account: sets their tier, sets member_expires_at to the subscription's
// actual current period end (re-fetched fresh here, not trusting
// whatever the lookup table showed a minute ago), and — this is the part
// that matters most — stores the customer/subscription IDs so every
// future Stripe webhook (renewal, cancellation, payment failure, the
// whole Savers Protocol) recognizes and correctly manages this person
// from here on, exactly like anyone who subscribed through the new app
// directly. This is a one-way "adopt" action, not a sync — it doesn't
// run again on its own; if the subscription changes later, the webhooks
// take over from this point forward.
app.post('/api/admin/stripe/link-subscription', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Stripe isn\'t configured (no STRIPE_SECRET_KEY set).' });
    const { userId, stripeCustomerId, stripeSubscriptionId, tier } = req.body;
    if (!userId || !stripeCustomerId || !stripeSubscriptionId) return res.status(400).json({ error: 'userId, stripeCustomerId, and stripeSubscriptionId are all required.' });
    const parsedTier = parseInt(tier, 10);
    if (![1, 2, 3].includes(parsedTier)) return res.status(400).json({ error: 'tier must be 1, 2, or 3.' });
    const user = db.getUser(userId);
    if (!user) return res.status(404).json({ error: 'Person not found.' });

    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    if (sub.customer !== stripeCustomerId) return res.status(400).json({ error: 'That subscription doesn\'t belong to that customer — please re-check the lookup.' });
    if (!['active', 'trialing', 'past_due'].includes(sub.status)) return res.status(400).json({ error: `That subscription's status is "${sub.status}" — not something safe to link as active.` });

    const expiresAt = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
    db.setMemberTier(userId, parsedTier, expiresAt, null, stripeCustomerId, stripeSubscriptionId);
    res.json({ ok: true, tier: parsedTier, expiresAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/members/bulk-import', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const tierRaw = req.body.tier;
    const isNewsletterOnly = tierRaw === 'newsletter_only';
    const tier = isNewsletterOnly ? null : parseInt(tierRaw, 10);
    if (!isNewsletterOnly && ![0, 1, 2, 3].includes(tier)) return res.status(400).json({ error: 'Invalid tier.' });

    const trialWeeks = Math.max(0, parseInt(req.body.trialWeeks, 10) || 0);
    // Per Bot 17 — optional Offer for the whole batch. When set, its
    // trial_days wins over the manual trialWeeks field (so a batch tied to
    // a named campaign always reflects that campaign's actual trial
    // length, not whatever was left in the weeks box) and every real
    // account created in this run is tagged with signup_offer_id for
    // reporting. Silently ignored if the id doesn't resolve to a real,
    // currently-valid offer — the batch still imports at the manually
    // specified tier/trialWeeks rather than failing outright.
    const batchOfferId = req.body.offerId || null;
    const batchOffer = batchOfferId ? db.getOffer(batchOfferId) : null;
    const offerTrialDays = (batchOffer && db.isOfferCurrentlyValid(batchOffer)) ? batchOffer.trial_days : null;
    const sendWelcomeEmail = !isNewsletterOnly && (req.body.sendWelcomeEmail === 'true' || req.body.sendWelcomeEmail === '1');
    // Per Bot 33r — only applies to real accounts (a newsletter-only
    // contact never logs in at all, so a skin's login link is meaningless
    // to them). Validated once here rather than per-row.
    const skinId = (req.body.skinId && db.getSkin(req.body.skinId)) ? req.body.skinId : null;

    let rows;
    try {
      const origName = (req.file.originalname || '').toLowerCase();
      const isExcel = origName.endsWith('.xlsx') || origName.endsWith('.xls');
      if (isExcel) {
        // Per Bot 33p — most people doing a bulk import have their contacts
        // in Excel, not CSV, and were previously stuck manually
        // re-saving-as-CSV first (or just gave up). SheetJS reads the first
        // sheet and converts it to the exact same {columns:true}-shaped
        // array csv-parse produces, so everything below this point (column
        // matching, row processing) doesn't need to know or care which
        // format the file actually was.
        const wb = XLSX.readFile(req.file.path);
        const firstSheet = wb.SheetNames[0];
        if (!firstSheet) throw new Error('That spreadsheet has no sheets.');
        rows = XLSX.utils.sheet_to_json(wb.Sheets[firstSheet], { defval: '', raw: false });
      } else {
        const content = fs.readFileSync(req.file.path, 'utf8');
        rows = csvParse(content, { columns: true, skip_empty_lines: true, trim: true });
      }
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Could not read that file: ' + e.message });
    }

    // Matches header variants like "Full Name", "email_address", "Subscriber"
    // by stripping everything but letters and comparing lowercase.
    const findCol = (row, candidates) => {
      const keys = Object.keys(row);
      for (const c of candidates) {
        const match = keys.find(k => k.toLowerCase().replace(/[^a-z]/g, '') === c);
        if (match && row[match]) return row[match].trim();
      }
      return '';
    };

    let created = 0, alreadyExisted = 0, invalid = 0;
    const toEmail = [];

    for (const row of rows) {
      const email = findCol(row, ['email', 'subscriber', 'emailaddress']).toLowerCase();
      if (!email || !email.includes('@')) { invalid++; continue; }

      if (db.getFacilitatorByEmail(email) || db.getUserByEmail(email)) { alreadyExisted++; continue; }

      const first = findCol(row, ['name', 'fullname', 'firstname']);
      const last  = findCol(row, ['lastname']);
      const name  = [first, last].filter(Boolean).join(' ').trim() || email;

      if (isNewsletterOnly) {
        db.createMailingListContact(uuidv4(), name, email);
        created++;
        continue;
      }

      const id = uuidv4();
      const tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
      const passwordHash = await auth.hashPassword(tempPassword);

      db.createUser(id, name, null, email, passwordHash, null, null, {
        // Per Bot 24 — see the identical comment on /api/admin/members above.
        lawfulBasis: 'consent'
      });
      if (skinId) db.setUserSkin(id, skinId);
      if (offerTrialDays !== null) db.setSignupOfferId(id, batchOfferId);

      let trialEndsAt = null;
      if (tier > 0) {
        // Offer's trial length wins over the manual field when a valid
        // offer is set for this batch — see the comment on offerTrialDays
        // above. A batch offer with trial_days=0 still means "no trial",
        // same as leaving trialWeeks at 0 would.
        const effectiveDays = offerTrialDays !== null ? offerTrialDays : trialWeeks * 7;
        trialEndsAt = effectiveDays > 0 ? new Date(Date.now() + effectiveDays * 24 * 60 * 60 * 1000).toISOString() : null;
        db.setMemberTier(id, tier, null, trialEndsAt, null, null);
      }

      created++;
      if (sendWelcomeEmail) toEmail.push({ name, email, tempPassword, trialEndsAt });
    }

    fs.unlink(req.file.path, () => {});

    res.json({
      ok: true,
      created, alreadyExisted, invalid,
      totalRows: rows.length,
      emailQueueCount: toEmail.length,
    });

    if (toEmail.length) {
      (async () => {
        let sent = 0;
        for (const u of toEmail) {
          try { await emailWelcomeClient(u.name, u.email, u.tempPassword, null, skinId, u.trialEndsAt); sent++; }
          catch (e) { console.error('bulk-import welcome email failed for', u.email, e.message); }
        }
        console.log(`[bulk-import] welcome emails sent: ${sent}/${toEmail.length}`);
      })();
    }
  } catch (e) {
    console.error('bulk import error:', e);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Something went wrong during import.' });
  }
});

// ── Clients API ──
app.get('/api/clients', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const facilitatorId = req.user.role === 'admin' ? req.query.facilitator_id : req.user.id;
  if (!facilitatorId) return res.json([]);
  res.json(db.getAllClients(facilitatorId, req.query.archived === '1'));
});
app.post('/api/clients', auth.requireAuthApi(['admin','facilitator']), async (req, res) => {
  const { name, email, categoryId, subcategoryId } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required.' });
  const facilitatorId = req.user.role === 'admin' ? req.body.facilitator_id : req.user.id;
  const id = uuidv4();
  let passwordHash = null, tempPassword = null;
  if (email) {
    tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2,4).toUpperCase();
    passwordHash = await auth.hashPassword(tempPassword);
  }
  db.createUser(id, name.trim(), facilitatorId, email?.trim() || null, passwordHash, categoryId || null, subcategoryId || null);
  // Per Bot 15e — createUser alone never set is_client (defaults to 0) or
  // member_tier (defaults to 0/Explorer), so a "client" added through this
  // admin flow existed in the users table but was invisible to the actual
  // client list (which correctly filters on is_client=1) — created
  // successfully every time, appeared nowhere, forever, no matter how many
  // times the page was refreshed. Per the actual model: a Client is a
  // Member with a facilitator relationship, not its own separate kind of
  // signup — so this now also lifts them to Member tier.
  db.markAsClient(id, facilitatorId);
  db.upgradeToMember(id);
  if (email && tempPassword) {
    emailWelcomeClient(name.trim(), email.trim(), tempPassword)
      .catch(e => console.error('welcome email failed for new client', id, ':', e.message));
  }
  res.json({ id, name: name.trim(), tempPassword });
});
app.get('/api/clients/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  // Per Bot 19 fix: this only ever checked the legacy single facilitator_id
  // column, so a facilitator assigned to this client ONLY as an additional
  // facilitator (via the newer client_facilitators table — see Per Bot 13)
  // was wrongly blocked from opening them at all. Either relationship now
  // grants access, same as the messaging/practices endpoints already do.
  const isAssigned = user.facilitator_id === req.user.id || db.isFacilitatorAssignedToClient(user.id, req.user.id);
  if (req.user.role !== 'admin' && !isAssigned) return res.status(403).json({ error: 'Access denied' });
  res.json({ ...user, sessions: db.getSessionsForClient(req.params.id), practices: db.getPracticesForClient(req.params.id), journalEntries: db.getSharedJournalEntriesForFacilitator(req.params.id) });
});
app.patch('/api/clients/:id/arc', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  db.updateArc(req.params.id, req.body.arc); res.json({ ok: true });
});
app.patch('/api/clients/:id/archive', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  db.archiveClient(req.params.id); res.json({ ok: true });
});
app.get('/api/my/profile', auth.requireAuthApi(['client']), (req, res) => {
  // Per Bot 18 — same reasoning as the login route above: this is what
  // catches someone whose session has stayed valid for a long time
  // without a fresh login, so an expired trial/membership doesn't sit
  // silently un-downgraded until they happen to log out and back in.
  const checked = db.checkTrialExpiry(req.user.id);
  if (checked._enteredSaversGrace) emailSaversCancelGrace0(checked).catch(e => console.error('[expiry] savers grace-entry email failed:', e.message));
  res.json({ ...db.getUser(req.user.id), sessions: db.getClientSessionsForClient(req.user.id), practices: db.getPracticesForClient(req.user.id) });
});

// ── Referrals (Per Bot 22) — give someone their first month, get a free
// month yourself once they actually pay for it (not on registration —
// see the checkout.session.completed webhook handler for where the
// actual reward happens). No cap on how many; each one stacks.
app.get('/api/my/referrals', auth.requireAuthApi(['client']), (req, res) => {
  const events = db.getReferralEventsForReferrer(req.user.id);
  res.json({
    referralLink: `${APP_URL}/register?ref=${req.user.id}`,
    monthsEarned: events.length,
    events: events.map(e => ({ referredName: e.referred_name, daysCredited: e.days_credited, createdAt: e.created_at, seen: !!e.seen_at })),
    unseenCount: db.getUnseenReferralCount(req.user.id),
  });
});
app.patch('/api/my/referrals/seen', auth.requireAuthApi(['client']), (req, res) => {
  db.markReferralEventsSeen(req.user.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════
// ── Client-facing courses — browse, enrol, resume, progress, quizzes ──
// ══════════════════════════════════════════════════════════════════════════

// Browse — every open instance, flagged with the current user's enrolment
// status (and % complete, if already enrolled) so the UI can show
// "Enrol" vs "Continue" without a second round trip.
// Curated shelves for the calm landing screen (Per Bot 28) — courses and
// library content grouped separately, content further grouped by its own
// content_type client-side into one row per type (meditations, practices,
// etc.) rather than this endpoint hardcoding which types exist.
// Per Bot 29 — the Practices theme shelf below used to only ever show
// files an admin had separately, manually flagged Featured — meaning a
// freshly-tagged batch (like the August meditation upload) needed a
// second round of individual "mark as Featured" clicks before anyone
// could actually find it by theme, on top of already being tagged. Per:
// tags should be the thing that drives this, not a second manual flag —
// every meditation/practice file the person is permitted to see (same
// tier/one-to-one rules as the Meditations tab itself) now shows up here,
// grouped straight from its tags. 'Featured' still exists and still
// gates the separate Courses row below, untouched.
app.get('/api/client/featured', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const favIds = new Set(db.getFavourites(req.user.id).map(f => f.id));
    const userRecord = db.getUser(req.user.id);
    const userFlags = db.userFlagsFromRecord(userRecord, 'client');
    const practiceContentTypes = ['meditation', 'practice'];
    // Per Bot 16's convention elsewhere (see contentItemHTML): tier-locked
    // content stays in the list with accessible:false rather than being
    // filtered out — shows with a lock/upgrade prompt instead of
    // vanishing. Keeping that here too, rather than hiding locked files
    // from the shelf entirely.
    const content = db.getAllLibraryFilesWithAccess(userFlags, req.user.id)
      .filter(f => practiceContentTypes.includes(f.content_type))
      .map(f => ({ ...f, tags: db.getFileTags(f.id), is_favourite: favIds.has(f.id) }));
    res.json({
      courses: db.getFeaturedCourses({ userTier: userRecord?.member_tier || 0, skinId: userRecord?.skin_id || null, userId: req.user.id }),
      content,
      recentPoems: db.getRecentStandaloneFiles('poem', 5, userFlags, req.user.id).map(f => ({ ...f, is_favourite: favIds.has(f.id) })),
      recentPosts: db.getRecentStandaloneFiles('blog', 5, userFlags, req.user.id).map(f => ({ ...f, is_favourite: favIds.has(f.id) })),
      recentBooks: db.getRecentStandaloneFiles('book', null, userFlags, req.user.id).map(f => ({ ...f, is_favourite: favIds.has(f.id) })),
      liveMeetings: db.getLiveMeetings(true), // Per Bot 38 — its own shelf, Books then Live Meetings
      shelfCounts: db.getShelfCounts(), // Per Bot 44 — Explorer+Member totals shown in each shelf heading
      carouselSpeedSeconds: db.getAppConfig()?.carousel_speed_seconds ?? 3.5, // Per Bot 48
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// The Home shelves only ever show 5 recent poems/posts as cards — "More
// poems/posts" needs the actual full catalog, not just those same 5
// again. Same standalone-only scoping (excludes anything already
// embedded in a course) as the Home shelf query.
app.get('/api/client/library/:type', auth.requireAuthApi(['client']), (req, res) => {
  try {
    if (!['poem', 'blog'].includes(req.params.type)) return res.status(400).json({ error: 'Unsupported type.' });
    const favIds = new Set(db.getFavourites(req.user.id).map(f => f.id));
    const userFlags = db.userFlagsFromRecord(db.getUser(req.user.id), 'client');
    const files = db.getRecentStandaloneFiles(req.params.type, null, userFlags, req.user.id).map(f => ({ ...f, is_favourite: favIds.has(f.id) }));
    res.json(files);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Live meetings admin CRUD (Per Bot 38) ── Recurring group calls
// (Zoom etc.) shown as their own carousel under Books on the splash
// screen. Simple list — no separate detail page, matching how small the
// feature actually is right now (one meeting, maybe a few more later).
app.get('/api/admin/live-meetings', auth.requireAuthApi(['admin', 'facilitator']), (req, res) => {
  try { res.json(db.getLiveMeetings(false)); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/live-meetings', auth.requireAuthApi(['admin', 'facilitator']), (req, res) => {
  try {
    const { title, schedule_text, meeting_url, sort_order, active } = req.body || {};
    if (!title || !schedule_text || !meeting_url) return res.status(400).json({ error: 'Title, schedule text, and meeting URL are all required.' });
    const id = db.createLiveMeeting({ title, schedule_text, meeting_url, sort_order: sort_order || 0, active: active !== false });
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/live-meetings/:id', auth.requireAuthApi(['admin', 'facilitator']), (req, res) => {
  try { db.updateLiveMeeting(req.params.id, req.body || {}); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/live-meetings/:id', auth.requireAuthApi(['admin', 'facilitator']), (req, res) => {
  try { db.deleteLiveMeeting(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/client/courses', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const instances = db.getAllCourseInstances({ status: 'open' });
    const user = db.getUser(req.user.id);
    const userTier = user?.member_tier || 0;
    const myEnrolments = db.getEnrolmentsForUser(req.user.id);
    const byInstance = {};
    myEnrolments.forEach(e => { byInstance[e.course_instance_id] = e; });
    // Per Bot 18 — tier gating, revised: membership sells access to the
    // app, not a permanent licence to a course the moment someone's
    // touched it. Two separate questions here, deliberately answered
    // differently:
    // - Should it vanish from the list entirely (isTierGatedForHiding)?
    //   Still exempts someone already enrolled — losing access to a
    //   course you were partway through is one thing, having it silently
    //   disappear from "My Courses" with no explanation is another and
    //   worse. It stays visible, just locked.
    // - Should it show (and actually be) locked (isTierGatedForAccess)?
    //   Applies to everyone, enrolled or not — this is the real,
    //   enforced answer, matching what /api/client/courses/:instanceId
    //   and /api/client/lessons/:lessonId now actually check before
    //   letting the content itself open.
    const hasTierRequirement = i => i.course_required_tier !== null && i.course_required_tier !== undefined && userTier < i.course_required_tier;
    const isTierGatedForHiding = i => hasTierRequirement(i) && !byInstance[i.id];
    const isTierGatedForAccess = i => hasTierRequirement(i);
    // Per Bot 33l — a course restricted to a skin (course_skin_id set) only
    // shows to users belonging to that same skin. Unrestricted courses
    // (the overwhelming majority — course_skin_id null) show to everyone,
    // same as before this existed.
    // Per Bot 16 — a hidden course (course_access_status='hidden') is
    // excluded entirely, same as a skin mismatch; a locked one still shows
    // (tagged `locked: true`) so people can see it exists, just not open it
    // — enrol is blocked separately below.
    const visible = instances
      .filter(i => !i.course_skin_id || i.course_skin_id === user?.skin_id)
      .filter(i => i.course_access_status !== 'hidden')
      .filter(i => !(isTierGatedForHiding(i) && i.course_hide_when_locked));
    res.json(visible.map(i => {
      const enrolment = byInstance[i.id];
      return {
        ...i,
        enrolled: !!enrolment,
        enrolment_id: enrolment?.id || null,
        percent_complete: enrolment?.percent_complete ?? null,
        locked: i.course_access_status === 'locked' || isTierGatedForAccess(i),
      };
    }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// My enrolments — "My Courses" list, % complete computed live.
app.get('/api/client/enrolments', auth.requireAuthApi(['client']), (req, res) => {
  try { res.json(db.getEnrolmentsForUser(req.user.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// The dashboard "Continue Lesson X" card — one pointer across every active,
// incomplete enrolment, or null if there's nothing to resume.
app.get('/api/client/resume', auth.requireAuthApi(['client']), (req, res) => {
  try { res.json(db.getDashboardResumeCard(req.user.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Per Bot 24 (activity/engagement, group 4) — the You page rebuild.
app.get('/api/client/activity-home', auth.requireAuthApi(['client']), (req, res) => {
  try { res.json(db.getActivityHome(req.user.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Per Bot 21 — an admin or facilitator's own linked client identity
// (the "choose role" duality — same person, two separate account rows,
// matched by email) previewing course content shouldn't need a real
// paid/free enrolment first. This checks for an existing enrolment as
// normal, and only for a staff email, auto-creates a free one on the
// spot rather than blocking with "You are not enrolled" — an ordinary
// client's account is completely unaffected, since isStaffEmail would
// never match theirs.
function ensureEnrolmentForStaffPreview(userId, instanceId) {
  const existing = db.getEnrolmentForUserAndInstance(userId, instanceId);
  if (existing) return existing;
  const user = db.getUser(userId);
  if (!user || !user.email || !db.isStaffEmail(user.email)) return null;
  db.createEnrolment(uuidv4(), userId, instanceId, 'free', 0, null);
  return db.getEnrolmentForUserAndInstance(userId, instanceId);
}

// Per's request — instance-aware registration needs this exact same
// enrol logic (skin/tier checks, capacity, payment-or-free branch)
// available from two places: the direct in-app "Enrol" button below, and
// the post-registration auto-enrol path in /api/register further down.
// Pulled out into its own function so both call one real implementation
// rather than risk two copies quietly drifting apart over time.
async function attemptEnrolUser(user, courseInstanceId) {
  const instance = db.getCourseInstance(courseInstanceId);
  if (!instance) return { error: 'Course instance not found.', status: 404 };
  if (instance.status !== 'open') return { error: 'This course is not currently open for enrolment.', status: 400 };

  const course = db.getCourse(instance.course_id);
  if (course?.access_status === 'locked') return { error: 'This course is not currently available.', status: 403 };
  if (course?.access_status === 'hidden') return { error: 'Course instance not found.', status: 404 };

  const existing = db.getEnrolmentForUserAndInstance(user.id, courseInstanceId);
  if (existing) return { ok: true, enrolmentId: existing.id, note: 'Already enrolled.' };

  if (instance.mode === 'cohort' && instance.capacity) {
    const currentCount = db.getEnrolmentsForInstance(courseInstanceId).length;
    if (currentCount >= instance.capacity) return { error: 'This cohort is full.', status: 400 };
  }

  if (instance.course_skin_id && instance.course_skin_id !== user?.skin_id) {
    return { error: 'This course is not available on your account.', status: 403 };
  }
  if (course?.required_tier !== null && course?.required_tier !== undefined && (user?.member_tier || 0) < course.required_tier) {
    return { error: 'This course requires a higher membership tier.', status: 403 };
  }
  const isMember = (user.member_tier || 0) >= 1;

  if (!isMember && instance.price_cents > 0) {
    if (!stripe) return { error: "Payment isn't set up yet — please check back soon.", status: 503 };
    try {
      let customerId = user.stripe_customer_id || null;
      if (!customerId) {
        const customer = await stripe.customers.create({ email: user.email, name: user.name, metadata: { user_id: user.id } });
        customerId = customer.id;
        db.setMemberTier(user.id, user.member_tier || 0, null, null, customerId, null);
      }
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [instance.stripe_price_id
          ? { price: instance.stripe_price_id, quantity: 1 }
          : { price_data: { currency: (db.getAppConfig()?.currency || 'gbp'), product_data: { name: `${instance.title} — ${brand().name}` }, unit_amount: instance.price_cents }, quantity: 1 }
        ],
        mode: 'payment',
        success_url: `${APP_URL}/client/?enrolled=1`,
        cancel_url:  `${APP_URL}/client/?enrolled=0`,
        metadata: { type: 'course_enrolment', user_id: user.id, course_instance_id: courseInstanceId },
        client_reference_id: user.id,
      });
      return { ok: true, requiresPayment: true, checkoutUrl: session.url };
    } catch(e) {
      console.error('[stripe course checkout]', e.message);
      return { error: 'Could not start checkout. Please try again.', status: 500 };
    }
  }

  const id = uuidv4();
  db.createEnrolment(id, user.id, courseInstanceId, 'free', 0, null);
  // Per's request — confirmation email, a real registered message type
  // (see MESSAGE_TYPE_REGISTRY's enrolment_confirmed), fired here so
  // every path into a free enrolment gets it identically.
  try { await emailEnrolmentConfirmed(user, course.title, instance.title, courseInstanceId); }
  catch(e) { console.error('[enrolment confirmation email]', e.message); }
  return { ok: true, enrolmentId: id };
}

// Enrol — free immediately for Members regardless of instance price; for
// Explorers, free instances enrol immediately too, but a priced instance
// requires payment first (Stripe integration is the next build — this
// deliberately returns a clear "payment required" error rather than
// pretending to enrol someone who hasn't paid).
app.post('/api/client/enrol', auth.requireAuthApi(['client']), async (req, res) => {
  try {
    const { courseInstanceId } = req.body;
    if (!courseInstanceId) return res.status(400).json({ error: 'courseInstanceId is required.' });
    const user = db.getUser(req.user.id);
    const result = await attemptEnrolUser(user, courseInstanceId);
    if (result.error) return res.status(result.status || 500).json({ error: result.error });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Course detail for an enrolled user — every lesson with this user's own
// progress and the single resume pointer, in one call for the course player.
app.get('/api/client/courses/:instanceId', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const instance = db.getCourseInstance(req.params.instanceId);
    if (!instance) return res.status(404).json({ error: 'Not found.' });
    const enrolment = ensureEnrolmentForStaffPreview(req.user.id, req.params.instanceId);
    if (!enrolment) return res.status(403).json({ error: 'You are not enrolled in this course.' });

    const course = db.getCourse(instance.course_id);
    // Per Bot 16 — a locked course can't be opened at all, even by someone
    // already enrolled from before it was locked; a hidden one behaves the
    // same as "not found" here too, for anyone hitting the URL directly.
    if (course?.access_status === 'locked') return res.status(403).json({ error: 'This course is not currently available.' });
    if (course?.access_status === 'hidden') return res.status(404).json({ error: 'Not found.' });
    // Per Bot 18 — required_tier applies the same way: membership sells
    // access to the app, not a permanent licence to a specific course the
    // moment someone's touched it. Someone who started this while on a
    // qualifying tier and has since dropped below it (or the requirement
    // was raised after they joined) is blocked the same as anyone else —
    // their progress isn't deleted, just not reachable until they're back
    // at the required tier.
    const userTierForCourse = db.getUser(req.user.id)?.member_tier || 0;
    if (course?.required_tier !== null && course?.required_tier !== undefined && userTierForCourse < course.required_tier) {
      return res.status(403).json({ error: 'This course requires a higher membership tier to continue.', requiredTier: course.required_tier });
    }

    const allLessons = db.getLessonsForCourse(instance.course_id);
    // Hidden lessons are excluded entirely, same as a hidden course above —
    // sequencing below only ever sees the lessons that actually show, so a
    // hidden lesson doesn't leave a numbering gap in the "previous lesson"
    // chain either.
    const lessons = allLessons.filter(l => l.access_status !== 'hidden');
    const progressRows = db.getProgressForEnrolment(enrolment.id);
    const progressByLesson = {};
    progressRows.forEach(p => { progressByLesson[p.lesson_id] = p; });

    const resume = db.getResumePoint(enrolment.id, instance.course_id);

    // Sequencing (Per Bot 13) — same "previous lesson must be completed"
    // rule as the lesson-detail route, computed here too so the course
    // list itself can show a lock icon without a person needing to click
    // into a lesson first to discover it's locked.
    // Per Bot 16 — a lesson admin-locked directly (access_status='locked')
    // is locked regardless of sequence; the two reasons are surfaced
    // separately (lockReason) so the frontend can show the right message
    // rather than a generic one for both.
    let prevCompleted = true; // Lesson 1 (or whatever's first) is never locked
    const withProgress = lessons.map(l => {
      const progress = progressByLesson[l.id] || { status: 'not_started', last_position: null };
      const sequenceLocked = !!course?.enforce_lesson_sequence && !prevCompleted;
      const adminLocked = l.access_status === 'locked';
      prevCompleted = progress.status === 'completed';
      return {
        ...l, progress,
        locked: adminLocked || sequenceLocked,
        lockReason: adminLocked ? 'admin' : (sequenceLocked ? 'sequence' : null),
        fileProgress: db.getLessonFileProgress(req.user.id, l.id),
      };
    });

    res.json({ instance, enrolment, lessons: withProgress, resume });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Lesson detail — files, quiz (answer-safe), and this user's own progress.
// instanceId is required so we can verify the requester is actually
// enrolled — a lesson alone doesn't carry that, since one course can have
// several instances.
app.get('/api/client/lessons/:lessonId', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const { instanceId } = req.query;
    if (!instanceId) return res.status(400).json({ error: 'instanceId is required.' });
    const instance = db.getCourseInstance(instanceId);
    const enrolment = instance ? ensureEnrolmentForStaffPreview(req.user.id, instanceId) : null;
    if (!enrolment) return res.status(403).json({ error: 'You are not enrolled in this course.' });

    const lesson = db.getLesson(req.params.lessonId);
    if (!lesson || lesson.course_id !== instance.course_id) return res.status(404).json({ error: 'Lesson not found in this course.' });

    const course = db.getCourse(instance.course_id);
    // Per Bot 16 — a locked/hidden course blocks every lesson inside it,
    // and a hidden lesson behaves as if it doesn't exist even if someone
    // has the direct URL (e.g. from before it was hidden). A locked lesson
    // is allowed to reach here (the list still shows it) but the actual
    // open is refused below, once the response would otherwise return
    // real content — this is the enforcement point, not the list.
    if (course?.access_status === 'locked') return res.status(403).json({ error: 'This course is not currently available.' });
    if (course?.access_status === 'hidden') return res.status(404).json({ error: 'Lesson not found in this course.' });
    if (lesson.access_status === 'hidden') return res.status(404).json({ error: 'Lesson not found in this course.' });
    if (lesson.access_status === 'locked') return res.status(403).json({ error: 'This lesson is not currently available.' });
    // Per Bot 18 — same tier rule as the course-detail route above: applies
    // to everyone, already enrolled or not, same reasoning as access_status
    // just above it.
    const userTierForLesson = db.getUser(req.user.id)?.member_tier || 0;
    if (course?.required_tier !== null && course?.required_tier !== undefined && userTierForLesson < course.required_tier) {
      return res.status(403).json({ error: 'This course requires a higher membership tier to continue.', requiredTier: course.required_tier });
    }

    const quizRecord = db.getQuizForLesson(req.params.lessonId);
    const quiz = quizRecord ? db.getQuizForTaking(quizRecord.id) : null;
    const bestAttempt = quizRecord ? db.getBestAttempt(enrolment.id, quizRecord.id) : null;
    const progress = db.getLessonProgress(enrolment.id, req.params.lessonId) || { status: 'not_started', last_position: null };

    // Sequencing (Per Bot 13) — the lesson itself always stays viewable
    // (its own title/structure), but every file inside it counts as locked
    // if enforce_lesson_sequence is on and the lesson immediately before
    // this one hasn't been completed yet. Within an unlocked lesson, file
    // sequence (if this lesson's own override, or the course default when
    // there's no override, says to enforce it) locks file N+1 until file N
    // has actually been opened.
    const courseLessons = db.getLessonsForCourse(instance.course_id).filter(l => l.access_status !== 'hidden');
    const myIndex = courseLessons.findIndex(l => l.id === lesson.id);
    const prevLesson = myIndex > 0 ? courseLessons[myIndex - 1] : null;
    const prevLessonProgress = prevLesson ? db.getLessonProgress(enrolment.id, prevLesson.id) : null;
    const lessonLocked = !!course?.enforce_lesson_sequence && !!prevLesson && prevLessonProgress?.status !== 'completed';

    const effectiveFileSequence = lesson.file_sequence_override !== null && lesson.file_sequence_override !== undefined
      ? !!lesson.file_sequence_override
      : !!course?.enforce_file_sequence;

    const openedIds = db.getOpenedFileIds(req.user.id, req.params.lessonId);
    const rawFiles = db.getFilesForLesson(req.params.lessonId);
    const files = rawFiles.map((f, i) => ({
      ...f,
      opened: openedIds.has(f.id),
      locked: lessonLocked ? true : (effectiveFileSequence && i > 0 && !openedIds.has(rawFiles[i - 1].id)),
    }));

    res.json({
      lesson, files, quiz, bestAttempt, progress,
      enrolment_id: enrolment.id,
      lessonLocked,
      fileProgress: db.getLessonFileProgress(req.user.id, req.params.lessonId),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Logs a file open within a lesson — feeds the green-tick marker, the %
// complete shown per lesson, the mandatory-files completion gate, and file
// sequence unlocking. Separate from the general /api/client/history log
// (which is a flat "recently played" list) since this one is specifically
// scoped to lesson progress and needs the lessonId to make sense.
app.post('/api/client/lesson-file-opens', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const { lessonId, fileId } = req.body;
    if (!lessonId || !fileId) return res.status(400).json({ error: 'lessonId and fileId are required.' });
    db.logFileOpen(uuidv4(), req.user.id, lessonId, fileId);
    res.json({ ok: true, progress: db.getLessonFileProgress(req.user.id, lessonId) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Progress update — called when a lesson is opened (in_progress) and when
// it's finished (completed). Resolves the enrolment server-side from
// (user, instanceId) rather than trusting a client-supplied enrolmentId.
app.post('/api/client/progress', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const { instanceId, lessonId, status, lastPosition } = req.body;
    if (!instanceId || !lessonId || !status) return res.status(400).json({ error: 'instanceId, lessonId, and status are required.' });
    const enrolment = ensureEnrolmentForStaffPreview(req.user.id, instanceId);
    if (!enrolment) return res.status(403).json({ error: 'You are not enrolled in this course.' });

    db.upsertLessonProgress(uuidv4(), enrolment.id, lessonId, status, lastPosition || null);

    // If every lesson in the course is now complete, mark the enrolment itself completed.
    const instance = db.getCourseInstance(instanceId);
    const allLessons = db.getLessonsForCourse(instance.course_id);
    const progressRows = db.getProgressForEnrolment(enrolment.id);
    const completedCount = progressRows.filter(p => p.status === 'completed').length;
    if (allLessons.length && completedCount >= allLessons.length) db.markEnrolmentCompleted(enrolment.id);

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Quiz attempt — scored server-side against the real answer key, which the
// client was never sent (see getQuizForTaking). answers: { questionId: [optionId, ...] }.
app.post('/api/client/quizzes/:quizId/attempt', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const { instanceId, answers } = req.body;
    if (!instanceId || !answers) return res.status(400).json({ error: 'instanceId and answers are required.' });
    const enrolment = ensureEnrolmentForStaffPreview(req.user.id, instanceId);
    if (!enrolment) return res.status(403).json({ error: 'You are not enrolled in this course.' });

    const quiz = db.getFullQuiz(req.params.quizId);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });

    let correctCount = 0;
    quiz.questions.forEach(q => {
      const correctIds = q.options.filter(o => o.is_correct).map(o => o.id).sort();
      const submittedIds = (answers[q.id] || []).slice().sort();
      const isCorrect = correctIds.length === submittedIds.length && correctIds.every((id, i) => id === submittedIds[i]);
      if (isCorrect) correctCount++;
    });
    const scorePct = quiz.questions.length ? Math.round((correctCount / quiz.questions.length) * 100) : 0;
    const passed = scorePct >= quiz.pass_threshold_pct;

    const id = uuidv4();
    db.recordQuizAttempt(id, enrolment.id, req.params.quizId, scorePct, passed, JSON.stringify(answers));
    res.json({ ok: true, scorePct, passed, correctCount, totalQuestions: quiz.questions.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── My Space — check if facilitator has a client record ──
app.get('/api/my-space/status', auth.requireAuthApi(['facilitator', 'admin']), (req, res) => {
  const fac    = db.getFacilitatorById(req.user.id);
  const user   = fac ? db.getUserByEmail(fac.email) : null;
  res.json({ hasClientRecord: !!user });
});

// ── My Space — facilitator as system client ──
// Creates a system client record for the facilitator if one doesn't exist.
// Returns the client ID so the facilitator can use the full client interface.
app.post('/api/my-space', auth.requireAuthApi(['facilitator', 'admin']), async (req, res) => {
  try {
    const fac = db.getFacilitatorById(req.user.id);
    if (!fac) return res.status(404).json({ error: 'Facilitator not found' });

    // Check if a system client record already exists for this facilitator
    let user = db.getUserByEmail(fac.email);
    if (!user) {
      const id = uuidv4();
      const hash = await auth.hashPassword(Math.random().toString(36).slice(2, 18));
      db.createUser(id, fac.name, null, fac.email, hash, null, null);
        db.markAsSystemClient(id);
      user = db.getUser(id);
    }
    res.json({ clientId: user.id, name: user.name });
  } catch(e) {
    console.error('my-space error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Sessions API ──
app.post('/api/sessions', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const { client_id, type, summary, client_summary } = req.body;
  db.addSession(uuidv4(), client_id, req.user.id, type, summary, client_summary || '');
  res.json({ ok: true });
});

// ── Tomte language + action image defaults (Per Bot 8) — one row per
// (language, action); 'default' is both the plain neutral pose and the
// fallback for any action without its own image yet (see
// resolveTomteImage below for the actual fallback logic).
const TOMTE_ACTIONS = ['default', 'greeting', 'shrug', 'smile', 'thinking', 'wink', 'laugh', 'bow'];
// ── Tomte photo storage (Per Bot 9) — R2, not the Railway volume ──
// Local-disk uploads (the original Per Bot 8 behaviour) turned out to be
// unreliable: a 500 (not a clean 404) intermittently reading back a photo
// that had uploaded fine minutes earlier, consistent with the same volume-
// mount flakiness already seen elsewhere in this app. R2 is what every
// other upload in this app already moved to for exactly this durability
// reason — this brings Tomte's photo uploads in line with that, using the
// same "public object" pattern as newsletter images (no tier-gating makes
// sense for an app-helper avatar, so a plain public URL is fine here too).
//
// Backward compatible with anything uploaded before this migration: those
// rows hold a bare local filename with no slash in it (e.g. "abc123.png"),
// so tomteImageUrl() keeps serving those through the old /uploads/:filename
// route, while every new upload is stored as an R2 key with the
// "tomte-images/" prefix baked in (e.g. "tomte-images/abc123.png") and
// served through the new, durable /tomte-images/:key route below. No data
// migration needed — old references just keep working exactly as before,
// nothing gets migrated out from under them.
function tomteImageUrl(stored) {
  if (!stored) return null;
  return stored.includes('/') ? `/${stored}` : `/uploads/${stored}`;
}

// ── Call recordings (Per Bot 12) — uploaded the same way Tomte's images
// are (same underlying PutObjectCommand — media.js's "public" vs
// "private" distinction is about which SERVING route the app exposes
// afterward, not the upload itself) but NEVER given an authless serving
// route. Always read back through a short-lived presigned GET
// (media.getPlaybackUrl), issued only after checking who's asking —
// facilitator always, client only once that specific recording has been
// explicitly shared. See the /api/calls/:id/recording-url route below.
async function uploadCallRecordingToR2(buffer, mimeType) {
  if (!media.isConfigured()) throw new Error('R2 is not configured — call recording needs it.');
  const ext = mimeType && mimeType.includes('mp4') ? '.mp4' : '.webm';
  const key = `call-recordings/${uuidv4()}${ext}`;
  await media.uploadPublicObject(key, buffer, mimeType || 'video/webm');
  return key;
}

// Deepgram's prerecorded (batch) endpoint — a single POST with the whole
// recording's bytes, not the streaming/live endpoint everything else
// here uses. Takes the buffer directly (already in hand from the upload
// that just happened) rather than re-fetching the file back from R2.
// Runs fully async from the caller's point of view — updates the calls
// row itself when done, success or failure, rather than making anyone
// wait on a live request for however long transcription takes.
async function transcribeCallRecording(callId, buffer, mimeType) {
  try {
    if (!DEEPGRAM_API_KEY) { db.setCallTranscript(callId, null, 'failed'); return; }
    const transcript = await transcribeAudioBuffer(buffer, mimeType);
    db.setCallTranscript(callId, transcript || null, transcript ? 'done' : 'failed');
    console.log(`[calls] transcription ${transcript ? 'done' : 'came back empty'} for call ${callId}`);
  } catch(e) {
    console.error(`[calls] transcription error for ${callId}:`, e.message);
    db.setCallTranscript(callId, null, 'failed');
  }
}
// Per Bot 24 (activity/engagement, group 3 — quick capture) — extracted
// from transcribeCallRecording above so voice journal entries can use
// the exact same Deepgram call without duplicating it. Returns the raw
// transcript string, or null if Deepgram isn't configured or the call
// fails — callers decide what "no transcript" should mean for their
// own use case (calls mark themselves 'failed'; a voice journal entry
// falls back to a plain placeholder instead, since a failed transcript
// there shouldn't look like an error to the person, just "we couldn't
// transcribe it, but your recording is still safe").
async function transcribeAudioBuffer(buffer, mimeType) {
  if (!DEEPGRAM_API_KEY) return null;
  const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&language=multi&smart_format=true&punctuate=true', {
    method: 'POST',
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, 'Content-Type': mimeType || 'video/webm' },
    body: buffer,
  });
  const data = await res.json();
  return data && data.results && data.results.channels && data.results.channels[0]
    && data.results.channels[0].alternatives && data.results.channels[0].alternatives[0]
    ? data.results.channels[0].alternatives[0].transcript
    : '';
}
// Uploads req.file (multer's local temp copy) to R2 and returns the stored
// key to save in the DB, or null with the local filename as a fallback if
// R2 isn't configured — same "R2 preferred, disk as legacy fallback"
// pattern already used for content library files.
async function uploadTomteImageToR2(file) {
  if (!media.isConfigured()) return file.filename; // legacy disk fallback, unchanged behaviour
  const buffer = fs.readFileSync(file.path);
  const ext = path.extname(file.originalname) || path.extname(file.filename) || '';
  const key = `tomte-images/${uuidv4()}${ext}`;
  await media.uploadPublicObject(key, buffer, file.mimetype);
  fs.unlink(file.path, () => {});
  return key;
}
app.get('/tomte-images/:key', async (req, res) => {
  try {
    const obj = await media.getPublicObject(`tomte-images/${req.params.key}`);
    res.setHeader('Content-Type', obj.ContentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    obj.Body.pipe(res);
  } catch (e) {
    res.status(404).send('Not found');
  }
});

// ── App icon / favicon (Per Bot 11) ──
// Same R2-backed pattern as Tomte photos above — a small admin-uploaded
// image used for the browser tab icon, bookmarks, and the home-screen/PWA
// icon. Stored as an R2 key (favicon/<uuid><ext>) so it survives Railway
// volume flakiness the same way everything else here does.
async function uploadFaviconToR2(file) {
  if (!media.isConfigured()) return file.filename; // legacy disk fallback, unchanged behaviour
  const buffer = fs.readFileSync(file.path);
  const ext = path.extname(file.originalname) || path.extname(file.filename) || '';
  const key = `favicon/${uuidv4()}${ext}`;
  await media.uploadPublicObject(key, buffer, file.mimetype);
  fs.unlink(file.path, () => {});
  return key;
}
function faviconUrl(stored) {
  if (!stored) return null;
  // Files uploaded via uploadFaviconToR2() (site favicon, Talk's persona
  // photo) are stored under the R2 prefix 'favicon/<uuid><ext>', but the
  // only route listening for them is /favicon-asset/:key — a plain
  // '/favicon/<uuid><ext>' URL 404s, which is why the Talk persona photo
  // preview showed as a broken image after upload. Everything else that
  // reaches this function (skin-assets/..., a bare disk filename) still
  // matches its own existing route unchanged.
  if (stored.startsWith('favicon/')) return `/favicon-asset/${stored.slice('favicon/'.length)}`;
  return stored.includes('/') ? `/${stored}` : `/uploads/${stored}`;
}

// ── Skins (Per Bot 20) — multi-brand foundation, see db.js for the full
// reasoning. Same R2-backed asset pattern as the favicon above, just
// parameterized by which skin and which asset (logo/favicon/background)
// it belongs to.
async function uploadSkinAssetToR2(file, kind) {
  if (!media.isConfigured()) return file.filename;
  const buffer = fs.readFileSync(file.path);
  const ext = path.extname(file.originalname) || path.extname(file.filename) || '';
  const key = `skin-assets/${kind}/${uuidv4()}${ext}`;
  await media.uploadPublicObject(key, buffer, file.mimetype);
  fs.unlink(file.path, () => {});
  return key;
}
function slugify(s) {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Public — the pre-login page needs this before anyone's authenticated.
// Only ever the branding fields, nothing else about a skin is sensitive,
// so no auth gate.
app.get('/api/skins/:slug', (req, res) => {
  const skin = db.getSkin(req.params.slug);
  if (!skin) return res.status(404).json({ error: 'Unknown skin.' });
  res.json({
    id: skin.id, name: skin.name, logoUrl: faviconUrl(skin.logo_url), faviconUrl: faviconUrl(skin.favicon_url),
    primaryColor: skin.primary_color, contactName: skin.contact_name, contactEmail: skin.contact_email,
    backgroundImages: skin.background_images,
  });
});
app.get('/api/admin/skins', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getAllSkins());
});
app.post('/api/admin/skins', auth.requireAuthApi(['admin']), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const slug = slugify(req.body.slug || name);
  if (!slug) return res.status(400).json({ error: 'Could not derive a valid URL slug from that name — try setting one directly.' });
  if (db.getSkin(slug)) return res.status(400).json({ error: `A skin with the slug "${slug}" already exists.` });
  const skin = db.createSkin(slug, {
    name, primary_color: req.body.primaryColor, contact_name: req.body.contactName, contact_email: req.body.contactEmail,
  });
  res.json(skin);
});
app.patch('/api/admin/skins/:slug', auth.requireAuthApi(['admin']), (req, res) => {
  if (!db.getSkin(req.params.slug)) return res.status(404).json({ error: 'Skin not found.' });
  const fields = {};
  if (req.body.name !== undefined) fields.name = req.body.name.trim();
  if (req.body.primaryColor !== undefined) fields.primary_color = req.body.primaryColor;
  if (req.body.contactName !== undefined) fields.contact_name = req.body.contactName;
  if (req.body.contactEmail !== undefined) fields.contact_email = req.body.contactEmail;
  res.json(db.updateSkin(req.params.slug, fields));
});
app.delete('/api/admin/skins/:slug', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteSkin(req.params.slug);
  res.json({ ok: true });
});
app.post('/api/admin/skins/:slug/logo', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  if (!db.getSkin(req.params.slug)) return res.status(404).json({ error: 'Skin not found.' });
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const stored = await uploadSkinAssetToR2(req.file, 'logo');
    const skin = db.updateSkin(req.params.slug, { logo_url: stored });
    res.json({ ok: true, url: faviconUrl(skin.logo_url) });
  } catch (e) { res.status(500).json({ error: 'Could not upload logo right now.' }); }
});
app.post('/api/admin/skins/:slug/favicon', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  if (!db.getSkin(req.params.slug)) return res.status(404).json({ error: 'Skin not found.' });
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const stored = await uploadSkinAssetToR2(req.file, 'favicon');
    const skin = db.updateSkin(req.params.slug, { favicon_url: stored });
    res.json({ ok: true, url: faviconUrl(skin.favicon_url) });
  } catch (e) { res.status(500).json({ error: 'Could not upload favicon right now.' }); }
});
// Backgrounds are a list, not a single field — this adds one image to the
// list rather than replacing it, so the admin can build up a slideshow
// with repeat uploads.
app.post('/api/admin/skins/:slug/background', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  const skin = db.getSkin(req.params.slug);
  if (!skin) return res.status(404).json({ error: 'Skin not found.' });
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const stored = await uploadSkinAssetToR2(req.file, 'background');
    const images = [...skin.background_images, faviconUrl(stored)];
    const updated = db.updateSkin(req.params.slug, { background_images: images });
    res.json({ ok: true, backgroundImages: updated.background_images });
  } catch (e) { res.status(500).json({ error: 'Could not upload image right now.' }); }
});
app.delete('/api/admin/skins/:slug/background', auth.requireAuthApi(['admin']), (req, res) => {
  const skin = db.getSkin(req.params.slug);
  if (!skin) return res.status(404).json({ error: 'Skin not found.' });
  const images = skin.background_images.filter(url => url !== req.body.url);
  const updated = db.updateSkin(req.params.slug, { background_images: images });
  res.json({ ok: true, backgroundImages: updated.background_images });
});

app.get('/favicon-asset/:key', async (req, res) => {
  try {
    const obj = await media.getPublicObject(`favicon/${req.params.key}`);
    res.setHeader('Content-Type', obj.ContentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    obj.Body.pipe(res);
  } catch (e) {
    res.status(404).send('Not found');
  }
});
// Per Bot 33m — every other R2-backed asset type (favicon, Tomte images,
// newsletter images/video) has a matching GET route to serve it back.
// Skin logo/favicon/background never did — uploadSkinAssetToR2() stored
// under 'skin-assets/<kind>/...' and the URL built from that key pointed
// at this exact path, but nothing was listening on it, so every skin
// asset upload succeeded and then 404'd forever after. Same pattern as
// the favicon route above, just parameterized by kind.
app.get('/skin-assets/:kind/:key', async (req, res) => {
  try {
    const obj = await media.getPublicObject(`skin-assets/${req.params.kind}/${req.params.key}`);
    res.setHeader('Content-Type', obj.ContentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    obj.Body.pipe(res);
  } catch (e) {
    res.status(404).send('Not found');
  }
});
app.post('/api/admin/favicon', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const stored = await uploadFaviconToR2(req.file);
    db.updateAppConfig({ favicon_url: faviconUrl(stored) });
    res.json({ ok: true, url: faviconUrl(stored) });
  } catch (e) {
    console.error('favicon upload error:', e.message);
    res.status(500).json({ error: 'Could not upload favicon right now — please try again.' });
  }
});
// Per Bot 24 — Talk's persona photo (Per, by default). Stores the raw R2
// key, not a pre-resolved path — same convention as the skins assets
// below, resolved through faviconUrl() only at read time (unlike the
// plain favicon endpoint just above, which is an older, different
// convention — applying faviconUrl() twice on an already-resolved path
// would double up the leading slash).
app.post('/api/admin/talk-persona-photo', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const stored = await uploadFaviconToR2(req.file);
    db.updateAppConfig({ talk_persona_photo_url: stored });
    res.json({ ok: true, url: faviconUrl(stored) });
  } catch (e) {
    console.error('talk persona photo upload error:', e.message);
    res.status(500).json({ error: 'Could not upload photo right now — please try again.' });
  }
});
// Single stable URL every page's <link rel="icon"> can point to — resolves
// to whatever's actually configured right now (a 302, not a static file),
// so an admin's favicon change takes effect on next load everywhere
// without editing a single HTML file. Falls back to Tomte's own image
// rather than a browser-generated default (a plain coloured square with an
// initial letter) when nothing's been uploaded yet.
app.get('/favicon-dynamic', (req, res) => {
  const cfg = db.getAppConfig() || {};
  const skin = getRequestSkin(req);
  const skinFavicon = skin && skin.favicon_url ? faviconUrl(skin.favicon_url) : null;
  res.redirect(302, skinFavicon || cfg.favicon_url || '/assets/tomte.png');
});
// show the app's own configured name and icon instead of a browser-
// generated fallback (which is where the black-square default icon and
// stray placeholder name were coming from — there was no manifest at all
// before this). Regenerated on every request from live config rather than
// a static file, so an admin's name/icon change takes effect immediately
// without a redeploy.
app.get('/site.webmanifest', (req, res) => {
  const cfg = db.getAppConfig() || {};
  const skin = getRequestSkin(req);
  const name = (skin && skin.name) || cfg.app_name || cfg.brand_name || 'Deeper Mindfulness';
  const icon = (skin && skin.favicon_url ? faviconUrl(skin.favicon_url) : null) || cfg.favicon_url || '/assets/tomte.png';
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    start_url: '/',
    display: 'standalone',
    background_color: '#0d1210',
    theme_color: (skin && skin.primary_color) || cfg.primary_color || '#B4E6C8',
    icons: [
      { src: icon, sizes: '192x192', type: 'image/png' },
      { src: icon, sizes: '512x512', type: 'image/png' },
    ],
  });
});

app.get('/api/admin/tomte-defaults', auth.requireAuthApi(['admin']), (req, res) => {
  const rows = db.getTomteLanguageDefaults().map(r => ({ ...r, imageUrl: tomteImageUrl(r.image_filename) }));
  res.json({ rows, actions: TOMTE_ACTIONS, languages: LANGUAGE_NAMES });
});
// Per Bot 31 — the actual image library: upload here just adds a photo to
// the pool, nothing else. Assigning a library photo to a language+action
// (or removing one) is a separate step below — see /assign and DELETE.
app.get('/api/admin/tomte-library', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getTomteImageLibrary().map(r => ({ ...r, url: tomteImageUrl(r.filename) })));
});
app.post('/api/admin/tomte-library', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const stored = await uploadTomteImageToR2(req.file);
    const id = uuidv4();
    db.addTomteImageToLibrary(id, stored, (req.body.label || '').trim() || null);
    res.json({ ok: true, id, url: tomteImageUrl(stored) });
  } catch (e) {
    console.error('tomte-library upload error:', e.message);
    res.status(500).json({ error: 'Could not upload image right now — please try again.' });
  }
});
app.patch('/api/admin/tomte-library/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.updateTomteImageLabel(req.params.id, (req.body.label || '').trim());
  res.json({ ok: true });
});
app.delete('/api/admin/tomte-library/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteTomteImageFromLibrary(req.params.id);
  res.json({ ok: true });
});

// ── Tours (Per's request — a real multi-tour system, replacing the
// single fixed "welcome tour" this used to be) ── Each tour is a named,
// admin-authored slide walkthrough, referenced by a stable key
// ('welcome' for the one that already existed before this change — see
// the migration in db.js). Slide management below is unchanged in shape
// from the original Per Bot 21 routes, just scoped to a specific tour's
// id instead of assuming there's only ever one.
app.get('/api/admin/tours', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const tours = db.getTours().map(t => ({ ...t, slideCount: db.getOnboardingTourSlides(t.id).length }));
    res.json(tours);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/tours', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const key = (req.body.key || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) return res.status(400).json({ error: 'Name required.' });
    if (!key) return res.status(400).json({ error: 'Key required — used to link to this tour, e.g. from a What\'s New item.' });
    if (db.getTourByKey(key)) return res.status(400).json({ error: `"${key}" is already used by another tour — pick a different key.` });
    const id = uuidv4();
    db.addTour(id, key, name);
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/tours/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    if (!db.getTour(req.params.id)) return res.status(404).json({ error: 'Not found.' });
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required.' });
    // Key is deliberately not editable here once a tour exists — anything
    // that already links to it (a What's New item, say) by key would
    // silently break if it could be renamed out from under them.
    db.updateTourName(req.params.id, name);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/tours/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteTour(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/tours/:tourId/slides', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    if (!db.getTour(req.params.tourId)) return res.status(404).json({ error: 'Tour not found.' });
    res.json(db.getOnboardingTourSlides(req.params.tourId).map(r => ({ ...r, url: tomteImageUrl(r.filename) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/tours/:tourId/slides', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  if (!db.getTour(req.params.tourId)) return res.status(404).json({ error: 'Tour not found.' });
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const stored = await uploadTomteImageToR2(req.file);
    const id = uuidv4();
    db.addOnboardingTourSlide(id, req.params.tourId, stored, (req.body.caption || '').trim() || null);
    res.json({ ok: true, id, url: tomteImageUrl(stored) });
  } catch (e) {
    console.error('tour slide upload error:', e.message);
    res.status(500).json({ error: 'Could not upload image right now — please try again.' });
  }
});
app.patch('/api/admin/tour-slides/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.updateOnboardingTourSlideCaption(req.params.id, (req.body.caption || '').trim());
  res.json({ ok: true });
});
app.delete('/api/admin/tour-slides/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteOnboardingTourSlide(req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/tours/:tourId/slides/reorder', auth.requireAuthApi(['admin']), (req, res) => {
  db.reorderOnboardingTourSlides(Array.isArray(req.body.order) ? req.body.order : []);
  res.json({ ok: true });
});
// Client-facing read — what Tomte's tour overlay actually fetches when
// someone taps "Show me around" (or any What's New item linking to a
// tour by key). ?key= defaults to 'welcome' — the tour that already
// existed before this change — so every existing caller (the welcome-
// tour Tomte tip, anything that hasn't been updated to pass a key yet)
// keeps working exactly as before with zero changes needed on its part.
app.get('/api/onboarding-tour', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const key = (req.query.key || 'welcome').trim();
    const tour = db.getTourByKey(key);
    if (!tour) return res.json([]);
    res.json(db.getOnboardingTourSlides(tour.id).map(r => ({ id: r.id, url: tomteImageUrl(r.filename), caption: r.caption })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Assigns an EXISTING library photo to a language+action, no upload
// involved — this is what makes a photo able to just sit in the library
// without being forced to be something the moment it's added.
app.post('/api/admin/tomte-defaults/assign', auth.requireAuthApi(['admin']), (req, res) => {
  const language = (req.body.language || '').trim();
  const action = (req.body.action || 'default').trim();
  const filename = (req.body.filename || '').trim();
  if (!language) return res.status(400).json({ error: 'Choose a language.' });
  if (!TOMTE_ACTIONS.includes(action)) return res.status(400).json({ error: 'Unknown action.' });
  if (!filename) return res.status(400).json({ error: 'Choose an image from the library.' });
  db.setTomteLanguageDefaultImage(language, action, filename);
  res.json({ ok: true, url: tomteImageUrl(filename) });
});
// Every distinct Tomte photo already uploaded anywhere in the app — lets an
// admin pick an existing one instead of always uploading a fresh file
// (Per Bot 9).
app.get('/api/admin/tomte-images', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getAllTomteImages().map(filename => ({ filename, url: tomteImageUrl(filename) })));
});
app.post('/api/admin/tomte-defaults', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  const language = (req.body.language || '').trim();
  const action = (req.body.action || 'default').trim();
  if (!language) return res.status(400).json({ error: 'Choose a language.' });
  if (!TOMTE_ACTIONS.includes(action)) return res.status(400).json({ error: 'Unknown action.' });
  try {
    const stored = await uploadTomteImageToR2(req.file);
    // Per Bot 31 — this quick "upload straight into a slot" path still
    // exists, but the photo now also lands in the library like any other
    // upload, rather than only ever being reachable through this one
    // language+action pair.
    db.addTomteImageToLibrary(uuidv4(), stored, null);
    db.setTomteLanguageDefaultImage(language, action, stored);
    res.json({ ok: true, url: tomteImageUrl(stored) });
  } catch (e) {
    console.error('tomte-defaults image upload error:', e.message);
    res.status(500).json({ error: 'Could not upload image right now — please try again.' });
  }
});
app.delete('/api/admin/tomte-defaults/:language/:action', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteTomteLanguageDefault(req.params.language, req.params.action);
  res.json({ ok: true });
});

// ── Tomte skin defaults (Per Bot 33o) ──
app.get('/api/admin/tomte-skin-defaults', auth.requireAuthApi(['admin']), (req, res) => {
  const rows = db.getTomteSkinDefaults().map(r => ({ ...r, imageUrl: tomteImageUrl(r.image_filename) }));
  res.json({ rows, actions: TOMTE_ACTIONS, languages: LANGUAGE_NAMES, skins: db.getAllSkins().map(s => ({ id: s.id, name: s.name })) });
});
app.post('/api/admin/tomte-skin-defaults/assign', auth.requireAuthApi(['admin']), (req, res) => {
  const skinId = (req.body.skinId || '').trim();
  const language = (req.body.language || '').trim();
  const action = (req.body.action || 'default').trim();
  const filename = (req.body.filename || '').trim();
  if (!skinId || !db.getSkin(skinId)) return res.status(400).json({ error: 'Choose a skin.' });
  if (!language) return res.status(400).json({ error: 'Choose a language.' });
  if (!TOMTE_ACTIONS.includes(action)) return res.status(400).json({ error: 'Unknown action.' });
  if (!filename) return res.status(400).json({ error: 'Choose an image from the library.' });
  db.setTomteSkinDefaultImage(skinId, language, action, filename);
  res.json({ ok: true, url: tomteImageUrl(filename) });
});
app.post('/api/admin/tomte-skin-defaults', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  const skinId = (req.body.skinId || '').trim();
  const language = (req.body.language || '').trim();
  const action = (req.body.action || 'default').trim();
  if (!skinId || !db.getSkin(skinId)) return res.status(400).json({ error: 'Choose a skin.' });
  if (!language) return res.status(400).json({ error: 'Choose a language.' });
  if (!TOMTE_ACTIONS.includes(action)) return res.status(400).json({ error: 'Unknown action.' });
  try {
    const stored = await uploadTomteImageToR2(req.file);
    db.addTomteImageToLibrary(uuidv4(), stored, null);
    db.setTomteSkinDefaultImage(skinId, language, action, stored);
    res.json({ ok: true, url: tomteImageUrl(stored) });
  } catch (e) {
    console.error('tomte-skin-defaults image upload error:', e.message);
    res.status(500).json({ error: 'Could not upload image right now — please try again.' });
  }
});
app.delete('/api/admin/tomte-skin-defaults/:skinId/:language/:action', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteTomteSkinDefault(req.params.skinId, req.params.language, req.params.action);
  res.json({ ok: true });
});

// ── Talk signal scripts (Per Bot 33s) ──
app.get('/api/admin/signal-scripts', auth.requireAuthApi(['admin']), (req, res) => {
  res.json({ rows: db.getAllSignalScripts(), skins: db.getAllSkins().map(s => ({ id: s.id, name: s.name })) });
});
// ── Full database backup (Per Bot 25) ── Streams the live SQLite file as
// a direct download — Per asked where the code/DB actually live and
// wanted a way to pull a full copy himself, since Railway's persistent
// volume (where the real file lives) was never reachable any other way
// short of the Railway CLI. Same db.export() the app's own periodic
// save() already uses internally, just handed back as bytes instead of
// written to disk.
app.get('/api/admin/backup/download', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const bytes = db.exportDbBytes();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="perbot-backup-${stamp}.db"`);
    res.send(bytes);
  } catch (e) {
    console.error('db backup download error:', e.message);
    res.status(500).json({ error: 'Could not export the database right now.' });
  }
});

// Export everything as one CSV — for backup, or editing offline before a
// re-import. Audio-kind rows show the referenced library file's title in
// the Script column (there's no text to export for those), with Type
// making clear which is which. Same column names bulk-import expects
// (topic, situation, script) so a text-kind export round-trips straight
// back in if re-uploaded, minus the Skin/Type columns bulk-import doesn't
// read from a file (skin is chosen once for the whole import instead).
app.get('/api/admin/signal-scripts/export', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const rows = db.getAllSignalScripts();
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ['topic', 'situation', 'skin', 'type', 'length_minutes', 'script'];
    const lines = [header.join(',')];
    rows.forEach(r => {
      const type = r.kind === 'audio' ? 'audio' : 'text';
      const script = r.kind === 'audio' ? (r.file_title || '') : (r.script_text || '');
      lines.push([r.topic, r.situation, r.skin_name || '', type, r.length_minutes || 1, script].map(esc).join(','));
    });
    const csv = lines.join('\n');
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="signal-scripts-${stamp}.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/signal-scripts', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { topic, situation, skinId, kind, scriptText, fileId, lengthMinutes } = req.body;
    if (!topic || !situation) return res.status(400).json({ error: 'Topic and situation are both required.' });
    if (kind === 'audio' && !fileId) return res.status(400).json({ error: 'Choose a file from the library for an audio signal.' });
    if (kind !== 'audio' && !scriptText) return res.status(400).json({ error: 'Write the script text.' });
    const minutes = Number(lengthMinutes) === 5 ? 5 : 1;
    db.createSignalScript(uuidv4(), topic.trim(), situation.trim(), skinId || null, kind || 'text', scriptText, fileId, 0, minutes);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/signal-scripts/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { topic, situation, skinId, kind, scriptText, fileId, lengthMinutes } = req.body;
    if (!topic || !situation) return res.status(400).json({ error: 'Topic and situation are both required.' });
    const minutes = Number(lengthMinutes) === 5 ? 5 : 1;
    db.updateSignalScript(req.params.id, topic.trim(), situation.trim(), skinId || null, kind || 'text', scriptText, fileId, minutes);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/signal-scripts/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteSignalScript(req.params.id);
  res.json({ ok: true });
});
// Bulk upload — text scripts only (audio ones still need a real file
// picked per-row, which doesn't fit a spreadsheet). Columns: topic,
// situation, script, and an optional length_minutes (or length/minutes/
// duration) — anything other than exactly 5 defaults to 1. Skin applies
// to every row in the file, same as bulk member import.
app.post('/api/admin/signal-scripts/bulk-import', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const skinId = (req.body.skinId && db.getSkin(req.body.skinId)) ? req.body.skinId : null;

    let rows;
    try {
      const origName = (req.file.originalname || '').toLowerCase();
      if (origName.endsWith('.xlsx') || origName.endsWith('.xls')) {
        const wb = XLSX.readFile(req.file.path);
        rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
      } else {
        rows = csvParse(fs.readFileSync(req.file.path, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
      }
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Could not read that file: ' + e.message });
    }

    const findCol = (row, candidates) => {
      const keys = Object.keys(row);
      for (const c of candidates) {
        const match = keys.find(k => k.toLowerCase().replace(/[^a-z]/g, '') === c);
        if (match && row[match]) return row[match].trim();
      }
      return '';
    };

    let created = 0, invalid = 0;
    for (const row of rows) {
      const topic = findCol(row, ['topic']);
      const situation = findCol(row, ['situation']);
      const script = findCol(row, ['script', 'scripttext', 'text']);
      const lengthRaw = findCol(row, ['lengthminutes', 'length', 'minutes', 'duration']);
      const lengthMinutes = Number(lengthRaw) === 5 ? 5 : 1;
      if (!topic || !situation || !script) { invalid++; continue; }
      db.createSignalScript(uuidv4(), topic, situation, skinId, 'text', script, null, 0, lengthMinutes);
      created++;
    }
    fs.unlink(req.file.path, () => {});
    res.json({ ok: true, created, invalid, totalRows: rows.length });
  } catch(e) {
    console.error('signal-scripts bulk import error:', e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Talk context documents (Per Bot 33s) ──
app.get('/api/admin/context-documents', auth.requireAuthApi(['admin']), (req, res) => {
  res.json({ rows: db.getAllContextDocuments(), skins: db.getAllSkins().map(s => ({ id: s.id, name: s.name })) });
});
app.post('/api/admin/context-documents', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const title = (req.body.title || req.file.originalname || 'Untitled').trim();
    const skinId = (req.body.skinId && db.getSkin(req.body.skinId)) ? req.body.skinId : null;
    const origName = (req.file.originalname || '').toLowerCase();

    let content;
    try {
      if (origName.endsWith('.docx')) {
        const result = await mammoth.extractRawText({ path: req.file.path });
        content = result.value;
      } else {
        content = fs.readFileSync(req.file.path, 'utf8');
      }
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Could not read that file — only plain text (.txt) and Word (.docx) are supported.' });
    }
    fs.unlink(req.file.path, () => {});

    content = content.trim();
    if (!content) return res.status(400).json({ error: 'That file appears to be empty.' });

    db.createContextDocument(uuidv4(), skinId, title, content, req.file.originalname);
    res.json({ ok: true, charCount: content.length });
  } catch(e) {
    console.error('context-document upload error:', e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
app.delete('/api/admin/context-documents/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteContextDocument(req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// Sectioned knowledge (Per Bot 15p/q) — replaces Context documents as
// Talk's ongoing knowledge mechanism. See schema comments on
// knowledge_documents in db.js for the full picture.
// ══════════════════════════════════════════════════════════════

// -- Documents (source material) --
app.post('/api/admin/knowledge/documents', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const title = (req.body.title || req.file.originalname || 'Untitled').trim();
    const skinId = (req.body.skinId && db.getSkin(req.body.skinId)) ? req.body.skinId : null;
    const origName = (req.file.originalname || '').toLowerCase();

    let content;
    try {
      if (origName.endsWith('.docx')) {
        const result = await mammoth.extractRawText({ path: req.file.path });
        content = result.value;
      } else {
        content = fs.readFileSync(req.file.path, 'utf8');
      }
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Could not read that file — only plain text (.txt) and Word (.docx) are supported.' });
    }
    fs.unlink(req.file.path, () => {});

    content = content.trim();
    if (!content) return res.status(400).json({ error: 'That file appears to be empty.' });

    const id = uuidv4();
    db.createKnowledgeDocument(id, title, req.file.originalname, content, skinId);
    res.json({ id, charCount: content.length });
  } catch(e) {
    console.error('knowledge document upload error:', e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
app.get('/api/admin/knowledge/documents', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getKnowledgeDocuments());
});
app.patch('/api/admin/knowledge/documents/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.archiveKnowledgeDocument(req.params.id, !!req.body.archived);
  res.json({ ok: true });
});
app.delete('/api/admin/knowledge/documents/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteKnowledgeDocument(req.params.id);
  res.json({ ok: true });
});

// -- Levels --
app.get('/api/admin/knowledge/levels', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getKnowledgeLevels());
});
app.post('/api/admin/knowledge/levels', auth.requireAuthApi(['admin']), (req, res) => {
  const { name, sortOrder, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const id = (req.body.id || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (db.getKnowledgeLevels().some(l => l.id === id)) return res.status(400).json({ error: 'A level with that id already exists.' });
  db.addKnowledgeLevel(id, name, sortOrder || 99, description || '');
  res.json({ id });
});
app.patch('/api/admin/knowledge/levels/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.updateKnowledgeLevel(req.params.id, req.body);
  res.json({ ok: true });
});
app.delete('/api/admin/knowledge/levels/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteKnowledgeLevel(req.params.id);
  res.json({ ok: true });
});

// -- Topics --
app.get('/api/admin/knowledge/topics', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getAllKnowledgeTopicsAdmin());
});
app.get('/api/admin/knowledge/topics/:id', auth.requireAuthApi(['admin']), (req, res) => {
  const topic = db.getKnowledgeTopic(req.params.id);
  if (!topic) return res.status(404).json({ error: 'Not found.' });
  res.json({
    ...topic,
    content: db.getKnowledgeTopicAllContent(req.params.id),
    links: db.getLinkedKnowledgeTopics(req.params.id),
  });
});
app.patch('/api/admin/knowledge/topics/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.updateKnowledgeTopic(req.params.id, req.body);
  res.json({ ok: true });
});
app.delete('/api/admin/knowledge/topics/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteKnowledgeTopic(req.params.id);
  res.json({ ok: true });
});
app.put('/api/admin/knowledge/topics/:id/content/:levelId', auth.requireAuthApi(['admin']), (req, res) => {
  if (typeof req.body.content !== 'string') return res.status(400).json({ error: 'content is required.' });
  db.setKnowledgeTopicContent(req.params.id, req.params.levelId, req.body.content);
  res.json({ ok: true });
});
// Per Bot 15v — regenerate one existing topic's content directly, rather
// than needing to re-run the whole document (which would re-propose and
// duplicate every topic that already succeeded). Exactly the fix needed
// for a topic that failed to parse the first time around — same
// underlying call as the pipeline, just scoped to one topic. Synchronous
// rather than backgrounded: this is one API call, not a whole document's
// worth of them, so it comfortably fits in a normal request/response.
app.post('/api/admin/knowledge/topics/:id/generate-content', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const topic = db.getKnowledgeTopic(req.params.id);
    if (!topic) return res.status(404).json({ error: 'Topic not found.' });
    const levels = db.getKnowledgeLevels();
    if (!levels.length) return res.status(400).json({ error: 'No knowledge levels exist yet.' });

    let sourceTitle = topic.title;
    let sourceText = null;
    if (topic.document_id) {
      const doc = db.getKnowledgeDocument(topic.document_id);
      if (doc) { sourceTitle = doc.title; sourceText = doc.raw_text; }
    }
    if (!sourceText) {
      // No linked document (or it's since been deleted) — fall back to
      // whatever content already exists for this topic, same reasoning
      // as the level-backfill job.
      const existing = db.getKnowledgeTopicAllContent(topic.id);
      sourceText = existing.length ? existing.map(c => `[${c.level_name}]\n${c.content}`).join('\n\n') : topic.menu_line;
    }

    const { generated, missingLevels } = await generateContentForTopic(topic.id, sourceTitle, topic.title, topic.menu_line, levels, sourceText);
    res.json({ ok: true, levelsGenerated: Object.keys(generated), missingLevels });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/admin/knowledge/topics/:id/links/:linkedId', auth.requireAuthApi(['admin']), (req, res) => {
  db.linkKnowledgeTopics(req.params.id, req.params.linkedId);
  res.json({ ok: true });
});
app.delete('/api/admin/knowledge/topics/:id/links/:linkedId', auth.requireAuthApi(['admin']), (req, res) => {
  db.unlinkKnowledgeTopics(req.params.id, req.params.linkedId);
  res.json({ ok: true });
});

// -- Generation pipeline --
// Two-step, per Per's ask ("auto generated at all levels... just do it,
// no need to approve first"): (1) one call reads the whole document and
// proposes a deduplicated, well-scoped set of topics with links between
// them — this is the only point that ever sees the whole document at
// once; (2) one call per topic generates real content at every level,
// grounded back in the same source material. Everything is written
// straight to the DB as it's generated — nothing waits for review.
// Backgrounded (matches the epub-unpack/R2-sweep job pattern) since a
// real document can easily produce a dozen-plus topics, each needing
// its own API round-trip — this would time out as a synchronous request
// long before a real document finished.
// Per Bot 15v — parses the ===LEVEL:id===...===END=== format from
// KNOWLEDGE_GENERATE_LEVELS_PROMPT. Replaces JSON.parse for this specific
// response — see that prompt's own comment for why: real prose reliably
// broke strict JSON parsing (unescaped line breaks reading as invalid
// control characters), and a plain delimiter has no escaping rules to
// get wrong in the first place. Returns { levelId: content }, only for
// levels actually found in the response — a level missing from the
// output (rather than present-but-empty) just doesn't get a key, same
// as the old JSON version's `if (levelContent[level.id])` guard expected.
function parseLevelDelimitedResponse(text, levels) {
  const result = {};
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const startMarker = `===LEVEL:${level.id}===`;
    const startIdx = text.indexOf(startMarker);
    if (startIdx === -1) continue;
    const contentStart = startIdx + startMarker.length;
    // Content runs until the next level's marker, or ===END===, or the
    // end of the text — whichever comes first.
    const nextLevelIdx = i + 1 < levels.length ? text.indexOf(`===LEVEL:${levels[i + 1].id}===`, contentStart) : -1;
    const endIdx = text.indexOf('===END===', contentStart);
    const candidates = [nextLevelIdx, endIdx, text.length].filter(n => n !== -1);
    const contentEnd = Math.min(...candidates);
    const content = text.slice(contentStart, contentEnd).trim();
    if (content) result[level.id] = content;
  }
  return result;
}

// Per Bot 15v — the actual per-topic generation call, pulled out into its
// own function so it can be reused both by the full document pipeline
// (runKnowledgeGeneration) and by a standalone "regenerate this one
// topic's content" action — needed because a topic that failed to parse
// during a full run (see the delimiter-format comment above) shouldn't
// require re-running the whole document and duplicating every topic that
// already succeeded.
//
// Per Bot 15y — now reports which levels were actually found, not just
// whether *any* were. Before this, a response missing one or more level
// markers (as opposed to being malformed) silently "succeeded" with
// whatever partial content it had — no error, no warning, nothing in the
// log to show it wasn't complete. That's exactly how a topic could end up
// stuck at "1/4 levels" indefinitely: the call technically worked, it
// just never finished the job, and nothing said so.
async function generateContentForTopic(topicId, docTitle, topicTitle, menuLine, levels, rawText) {
  const levelsResponse = await anthropicFetch(
    'You are a careful, precise knowledge writer, grounded strictly in the source material given. Respond in the exact delimiter format requested — no JSON, no markdown fences, no commentary.',
    [{ role: 'user', content: prompts.KNOWLEDGE_GENERATE_LEVELS_PROMPT(docTitle, topicTitle, menuLine, levels, rawText) }],
    16000, 240000, true
  );
  const levelContent = parseLevelDelimitedResponse(levelsResponse, levels);
  if (!Object.keys(levelContent).length) throw new Error('No level content found in the response — check it came back in the expected format.');
  for (const level of levels) {
    if (levelContent[level.id]) db.setKnowledgeTopicContent(topicId, level.id, levelContent[level.id]);
  }
  const missing = levels.filter(l => !levelContent[l.id]).map(l => l.name);
  return { generated: levelContent, missingLevels: missing };
}

async function runKnowledgeGeneration(doc, log) {
  const levels = db.getKnowledgeLevels();
  if (!levels.length) throw new Error('No knowledge levels exist yet — nothing to generate content for.');

  // Defensive cap only — a whole book is still fine context-window-wise
  // (Sonnet 5's context window is 1M tokens), this just stops an
  // accidental multi-megabyte paste from becoming a silent runaway cost
  // across every one of the per-topic calls below. Raised from 400k
  // Per Bot 15u — the Science Foundation alone was already 305k
  // characters, 77% of that ceiling, with more large documents still to
  // come; 1M characters leaves real room without approaching the actual
  // context limit.
  const MAX_CHARS = 1000000;
  const rawText = doc.raw_text.length > MAX_CHARS ? doc.raw_text.slice(0, MAX_CHARS) : doc.raw_text;

  log(`Reading "${doc.title}" (${doc.raw_text.length.toLocaleString()} characters) and identifying topics...`);
  // Per Bot 15x — existing topics fetched across every skin/facilitator
  // scope (not just this document's own scope) since the point is
  // cross-document dedup regardless of who a topic happens to be scoped
  // to. See the prompt's own comment for why this matters — without it,
  // a second overlapping document reliably recreated the same concepts
  // under different names.
  const existingTopics = db.getAllKnowledgeTopicsAdmin()
    .filter(t => !t.archived && t.document_id !== doc.id)
    .map(t => ({ title: t.title, menu_line: t.menu_line }));

  // Per Bot 15u — widened again: the Signal Guide (172k chars) needed the
  // Per Bot 15t fix; the very next document (Science Foundation, 305k
  // chars) is nearly double that. max_tokens only costs money for tokens
  // actually generated, never for the ceiling itself, so there's no real
  // downside to generous headroom here — better to set this once with
  // real margin than keep reactively bumping it document by document.
  const extractionResponse = await anthropicFetch(
    'You are a careful, precise knowledge editor. Follow the instructions exactly and respond with valid JSON only — no preamble, no markdown fences.',
    [{ role: 'user', content: prompts.KNOWLEDGE_EXTRACT_TOPICS_PROMPT(doc.title, rawText, existingTopics) }],
    32000, 300000, true
  );
  let topicStubs;
  try {
    topicStubs = JSON.parse(extractionResponse.replace(/^```json\s*|```\s*$/g, '').trim());
  } catch(e) {
    throw new Error('Could not parse the topic-extraction response: ' + e.message);
  }
  if (!Array.isArray(topicStubs) || !topicStubs.length) throw new Error('No topics were identified in this document.');
  log(`Identified ${topicStubs.length} topic(s): ${topicStubs.map(t => t.title).join(', ')}`);

  // Create every topic row first, so link resolution (by title) below has
  // every id available regardless of which order topics were generated in.
  const createdTopics = [];
  for (const stub of topicStubs) {
    const id = uuidv4();
    db.createKnowledgeTopic(id, doc.id, stub.title, stub.menu_line || '', doc.skin_id, null);
    createdTopics.push({ id, title: stub.title, menuLine: stub.menu_line || '', links: stub.links || [] });
  }

  for (const topic of createdTopics) {
    log(`Generating depth content for "${topic.title}"...`);
    try {
      const { missingLevels } = await generateContentForTopic(topic.id, doc.title, topic.title, topic.menuLine, levels, rawText);
      if (missingLevels.length) {
        log(`  Partial — missing ${missingLevels.join(', ')}. Use "Regenerate" on this topic to fill in the rest.`);
      }
    } catch(e) {
      log(`  Could not generate content for "${topic.title}" (${e.message}) — the topic itself was still created; you can generate its content individually later.`);
    }
  }

  log('Linking related topics...');
  // Per Bot 15x — links can now point at a topic from a PREVIOUS document
  // too (the model was told it can reference the existing-topics list by
  // title), so resolution checks both this batch and every existing
  // topic, not just createdTopics.
  const allExisting = db.getAllKnowledgeTopicsAdmin().filter(t => !t.archived);
  let linkCount = 0;
  for (const topic of createdTopics) {
    for (const linkedTitle of topic.links) {
      const lower = String(linkedTitle).toLowerCase();
      const target = createdTopics.find(t => t.title.toLowerCase() === lower)
        || allExisting.find(t => t.title.toLowerCase() === lower);
      if (target && target.id !== topic.id) { db.linkKnowledgeTopics(topic.id, target.id); linkCount++; }
    }
  }

  log(`Done. ${createdTopics.length} topic(s) created, ${linkCount} link(s) made.`);
  return { topicsCreated: createdTopics.length, linksCreated: linkCount };
}

// Per Bot 15x — review-only scan for duplicates already sitting in the
// knowledge base (from before cross-document dedup existed). Returns
// groups for Per to review and act on individually — see the prompt's
// own comment for why this doesn't auto-delete anything.
async function runKnowledgeDuplicateScan(log) {
  const topics = db.getAllKnowledgeTopicsAdmin().filter(t => !t.archived);
  if (topics.length < 2) { log('Fewer than two topics exist — nothing to compare.'); return { groups: [] }; }
  log(`Comparing ${topics.length} topic(s) for genuine duplicates...`);
  const response = await anthropicFetch(
    'You are a careful, precise reviewer. Respond with valid JSON only — no preamble, no markdown fences.',
    [{ role: 'user', content: prompts.KNOWLEDGE_FIND_DUPLICATES_PROMPT(topics.map(t => ({ id: t.id, title: t.title, menu_line: t.menu_line }))) }],
    8000, 120000, true
  );
  let groups;
  try {
    groups = JSON.parse(response.replace(/^```json\s*|```\s*$/g, '').trim());
  } catch(e) {
    throw new Error('Could not parse the duplicate-scan response: ' + e.message);
  }
  if (!Array.isArray(groups)) throw new Error('Unexpected response shape from the duplicate scan.');
  // Enrich each group with the actual topic rows (title, menu_line, document_title)
  // so the admin UI has everything it needs without a second round-trip per group.
  const byId = Object.fromEntries(topics.map(t => [t.id, t]));
  const enriched = groups
    .map(g => ({
      topics: (g.topic_ids || []).map(id => byId[id]).filter(Boolean),
      recommendedKeepId: g.recommended_keep_id,
      reason: g.reason || '',
    }))
    .filter(g => g.topics.length >= 2); // guard against a hallucinated id collapsing a group to one real topic
  log(`Found ${enriched.length} duplicate group(s).`);
  return { groups: enriched };
}

let knowledgeDuplicateScanJob = null;
app.post('/api/admin/knowledge/scan-duplicates', auth.requireAuthApi(['admin']), (req, res) => {
  if (knowledgeDuplicateScanJob && !knowledgeDuplicateScanJob.done) {
    return res.json({ started: false, alreadyRunning: true, job: knowledgeDuplicateScanJob });
  }
  knowledgeDuplicateScanJob = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  const job = knowledgeDuplicateScanJob;
  runKnowledgeDuplicateScan((line) => { job.log.push(line); console.log(line); })
    .then((result) => { job.result = result; job.done = true; })
    .catch((e) => { console.error('duplicate scan error:', e.message); job.error = e.message; job.done = true; });
  res.json({ started: true, job });
});
app.get('/api/admin/knowledge/scan-duplicates/status', auth.requireAuthApi(['admin']), (req, res) => {
  if (!knowledgeDuplicateScanJob) return res.status(404).json({ error: 'No scan has been started yet.' });
  res.json(knowledgeDuplicateScanJob);
});

let knowledgeGenerateJob = null;
app.post('/api/admin/knowledge/documents/:id/generate', auth.requireAuthApi(['admin']), (req, res) => {
  if (knowledgeGenerateJob && !knowledgeGenerateJob.done) {
    return res.json({ started: false, alreadyRunning: true, job: knowledgeGenerateJob });
  }
  const doc = db.getKnowledgeDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  knowledgeGenerateJob = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  const job = knowledgeGenerateJob;
  runKnowledgeGeneration(doc, (line) => { job.log.push(line); console.log(line); })
    .then((result) => { job.result = result; job.done = true; })
    .catch((e) => { console.error('knowledge generation error:', e.message); job.error = e.message; job.done = true; });
  res.json({ started: true, job });
});
app.get('/api/admin/knowledge/documents/:id/generate-status', auth.requireAuthApi(['admin']), (req, res) => {
  if (!knowledgeGenerateJob) return res.status(404).json({ error: 'No generation job has been started yet.' });
  res.json(knowledgeGenerateJob);
});

// -- Backfill a level across every existing topic (Per: "ability to
// re-work existing information" when a level gets added later) --
// Uses whichever content already exists for each topic (any level, plus
// the menu_line) as grounding, since the original source document may no
// longer be the most accurate context once a topic's own content has
// been hand-edited since generation.
async function runKnowledgeLevelBackfill(level, log) {
  const topics = db.getAllKnowledgeTopicsAdmin().filter(t => !t.archived);
  log(`Backfilling "${level.name}" across ${topics.length} topic(s)...`);
  let done = 0;
  for (const topic of topics) {
    const existing = db.getKnowledgeTopicAllContent(topic.id);
    if (existing.some(c => c.level_id === level.id && c.content?.trim())) { done++; continue; } // already has this level
    const groundingText = existing.length
      ? existing.map(c => `[${c.level_name}]\n${c.content}`).join('\n\n')
      : topic.menu_line;
    try {
      await generateContentForTopic(topic.id, topic.document_title || topic.title, topic.title, topic.menu_line, [level], groundingText);
      done++;
    } catch(e) {
      log(`  Could not backfill "${topic.title}" (${e.message}).`);
    }
  }
  log(`Done. ${done}/${topics.length} topic(s) now have "${level.name}".`);
  return { levelId: level.id, topicsProcessed: done, totalTopics: topics.length };
}

let knowledgeBackfillJob = null;
app.post('/api/admin/knowledge/levels/:id/backfill', auth.requireAuthApi(['admin']), (req, res) => {
  if (knowledgeBackfillJob && !knowledgeBackfillJob.done) {
    return res.json({ started: false, alreadyRunning: true, job: knowledgeBackfillJob });
  }
  const level = db.getKnowledgeLevels().find(l => l.id === req.params.id);
  if (!level) return res.status(404).json({ error: 'Level not found.' });
  knowledgeBackfillJob = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  const job = knowledgeBackfillJob;
  runKnowledgeLevelBackfill(level, (line) => { job.log.push(line); console.log(line); })
    .then((result) => { job.result = result; job.done = true; })
    .catch((e) => { console.error('knowledge backfill error:', e.message); job.error = e.message; job.done = true; });
  res.json({ started: true, job });
});
app.get('/api/admin/knowledge/levels/:id/backfill-status', auth.requireAuthApi(['admin']), (req, res) => {
  if (!knowledgeBackfillJob) return res.status(404).json({ error: 'No backfill job has been started yet.' });
  res.json(knowledgeBackfillJob);
});

// ── Admin editing a user's own details directly (Per Bot 8) ──
app.patch('/api/admin/users/:id/details', auth.requireAuthApi(['admin']), async (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { name, email, phone, language } = req.body;
  const fields = { name, email, phone, language };

  // Tomte language override (Per Bot 9) — empty string means "same as
  // account language", stored as NULL, same convention as everywhere else
  // Tomte reads a nullable override.
  if (req.body.tomte_language !== undefined) {
    fields.tomte_language = req.body.tomte_language === '' ? null : req.body.tomte_language;
  }

  // Picking an existing Tomte photo from the admin gallery (Per Bot 9) —
  // distinct from POST .../tomte-image (an actual new upload). Never trust
  // an arbitrary filename straight from the request onto a field that gets
  // rendered back as an <img src>; only allow one that's a real, already-
  // uploaded image somewhere in the app.
  if (req.body.tomte_image_filename !== undefined) {
    if (req.body.tomte_image_filename === '' || req.body.tomte_image_filename === null) {
      fields.tomte_image_filename = null;
    } else if (db.getAllTomteImages().includes(req.body.tomte_image_filename)) {
      fields.tomte_image_filename = req.body.tomte_image_filename;
    } else {
      return res.status(400).json({ error: 'That image is not recognised.' });
    }
  }

  // Voice override — same validation as the self-service picker in
  // PATCH /api/account: never trust an arbitrary string straight from the
  // request, always check it against the live ElevenLabs voice list first.
  if (req.body.voice_id !== undefined) {
    if (req.body.voice_id === '' || req.body.voice_id === null) {
      fields.voice_id = null;
    } else {
      try {
        const voices = await fetchElevenLabsVoices();
        if (!voices.some(v => v.voice_id === req.body.voice_id)) {
          return res.status(400).json({ error: 'That voice is not currently available.' });
        }
        fields.voice_id = req.body.voice_id;
      } catch (e) {
        return res.status(500).json({ error: 'Could not verify that voice right now — please try again.' });
      }
    }
  }

  // Voice-output override (Per Bot 11) — admin can force a person's Tomte
  // voice replies on/off, same nullable-override convention as everything
  // else here. '' means "leave unset" (person's own self-service toggle
  // decides), not "off" — those are different states.
  if (req.body.tomte_voice_enabled !== undefined) {
    fields.tomte_voice_enabled = req.body.tomte_voice_enabled === '' ? null : (req.body.tomte_voice_enabled ? 1 : 0);
  }

  db.updateUserAdminDetails(req.params.id, fields);
  res.json({ ok: true });
});
app.patch('/api/admin/users/:id/tomte-name', auth.requireAuthApi(['admin']), (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  db.setTomteName('client', req.params.id, (req.body.name || '').trim().slice(0, 30));
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/tomte-image', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const stored = await uploadTomteImageToR2(req.file);
    db.setTomteImage('client', req.params.id, stored);
    res.json({ ok: true, url: tomteImageUrl(stored) });
  } catch (e) {
    console.error('tomte-image upload error:', e.message);
    res.status(500).json({ error: 'Could not upload photo right now — please try again.' });
  }
});


// ── Tomte personalization (Per Bot 8) — works for any logged-in role
// (client/facilitator/admin); public/logged-out visitors just get the
// default everywhere, since there's no account to read a preference from.
// Resolution order for "what image for this action, this person":
// 1. An exact (language, action) image, if one's been uploaded — no
//    cascading here, only a real match for that specific action.
// 2. Otherwise, the standard default chain: their own personal image,
//    then their language's default image, then null (widget uses the
//    generic /assets/tomte.png). This is also what governs the 'default'
//    action itself, and what showing a non-default request is meant to
//    fall back to.
function resolveTomteImage(personalImageFilename, language, action, skinId) {
  if (action && action !== 'default') {
    if (skinId) {
      const skinActionImg = db.getTomteSkinDefaultImage(skinId, language, action);
      if (skinActionImg) return tomteImageUrl(skinActionImg);
    }
    const actionImg = db.getTomteLanguageDefaultImage(language, action);
    if (actionImg) return tomteImageUrl(actionImg);
  }
  if (personalImageFilename) return tomteImageUrl(personalImageFilename);
  if (skinId) {
    const skinDefault = db.getTomteSkinDefaultImage(skinId, language, 'default');
    if (skinDefault) return tomteImageUrl(skinDefault);
  }
  const langDefault = db.getTomteLanguageDefaultImage(language, 'default');
  if (langDefault) return tomteImageUrl(langDefault);
  return null;
}

app.get('/api/my/tomte-settings', auth.requireAuthApi(), (req, res) => {
  const s = db.getTomteSettings(req.user.role, req.user.id);
  const imageUrl = resolveTomteImage(s.tomte_image_filename, s.tomte_language || s.language, 'default', s.skin_id);
  res.json({ name: s.tomte_name || null, imageUrl, voiceEnabled: !!s.tomte_voice_enabled });
});

// Per Bot 18 — Tomte proactive tips. Deliberately a small, hand-written
// list rather than anything generated — this is feature-discovery, not
// marketing copy, and every tip here should read like Tomte noticing
// something helpful, not selling anything. Same restraint as everywhere
// else in the app: no urgency, no hype, easy to ignore.
// Each tip: id (for the seen-tracking table), condition (userId -> bool,
// true means "this tip is relevant"), text, and an optional action
// link/label. Checked in order; the first unseen relevant one wins — so
// order here doubles as priority if more than one ever applies at once.
const TOMTE_TIPS = [
  // Per Bot 21 — deliberately first in the list (order = priority when
  // more than one tip could apply). Gated on slides actually existing so
  // this never fires and opens an empty tour before Per's uploaded
  // anything — see /api/admin/tours/:tourId/slides. condition ignores
  // userId since slide existence isn't per-person, but keeps the same
  // (userId) signature as every other tip here.
  //
  // Per's request — explicitly the 'welcome' tour by key now that
  // multiple tours can exist (see db.js's tours table), rather than
  // "however many slides exist in total across every tour", which would
  // have quietly changed this tip's meaning the moment a second tour got
  // created for something else entirely (e.g. an offline-setup one).
  {
    id: 'welcome-tour',
    condition: () => { const t = db.getTourByKey('welcome'); return !!t && db.getOnboardingTourSlides(t.id).length > 0; },
    text: "Welcome — I'm Tomte. If it would help, I can walk you through the app with a few pictures showing what everything does.",
    actionLabel: 'Show me around',
    action: 'open-tour',
  },
  {
    id: 'try-talk',
    condition: (userId) => !db.hasEverUsedTalk(userId),
    text: "Something I noticed: you haven't tried Talk yet. It's not a scripted practice — just a place to think something through out loud, any time, for as long or short as you need.",
    actionLabel: 'Try Talk',
    actionHref: '/client/',
  },
];
app.get('/api/my/tomte-tip', auth.requireAuthApi(['client']), (req, res) => {
  try {
    // Per Bot 22 — takes priority over the static list below, and needs
    // different seen-tracking: not "seen once, never again" like those,
    // but "seen for this batch, fires again once something new arrives".
    // Solved by folding the latest arrival timestamp into the tip's own
    // id — a genuinely new batch produces a genuinely new id, which
    // hasSeenTomteTip has never seen before. Zero changes needed to the
    // seen-tracking table or the widget's existing dismiss handling.
    const latestArrival = db.getLatestPracticeArrivalAt(req.user.id);
    if (latestArrival) {
      const tipId = `new-practices-${latestArrival}`;
      if (!db.hasSeenTomteTip(req.user.id, tipId)) {
        return res.json({
          tipId,
          text: 'New practices arrived in My Practices.',
          actionLabel: 'View',
          // Per's report — this used to be actionHref, rendered as a real
          // <a href>. Following it forced a genuine full-page navigation,
          // which meant reloading the ENTIRE app from scratch — including
          // the "tap to unlock audio" Begin screen, even when someone was
          // already mid-session (Per was mid-poem in Talk when this
          // happened). Worse, the follow-up [START] bot-greeting that
          // Begin triggers doesn't know or care that the URL asked for
          // My Practices specifically, and the two ended up racing,
          // leaving a genuinely blank screen with no way out but a force
          // quit. Switched to the same in-app 'action' pattern already
          // used for open-tour just below — an in-page tab switch, same
          // three calls the old ?view=my-practices URL param handling
          // already did, just without any reload at all. The URL param
          // itself is untouched and still works for a genuine cold-start
          // deep link (e.g. from outside the app) — this only changes
          // what happens when the link is clicked from within an
          // already-running session.
          action: 'view-my-practices',
        });
      }
    }
    const tip = TOMTE_TIPS.find(t => !db.hasSeenTomteTip(req.user.id, t.id) && t.condition(req.user.id));
    if (!tip) return res.json(null);
    res.json({ tipId: tip.id, text: tip.text, actionLabel: tip.actionLabel || null, actionHref: tip.actionHref || null, action: tip.action || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/my/tomte-tip/seen', auth.requireAuthApi(['client']), (req, res) => {
  try {
    if (!req.body.tipId) return res.status(400).json({ error: 'tipId required.' });
    db.markTomteTipSeen(req.user.id, req.body.tipId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Tomte live broadcast (Per Bot 21) ── Deliberately NOT a database
// table — this is genuinely ephemeral, in-the-moment only ("we're
// rebooting in 2 minutes"), never saved against any user, never meant
// to persist past a server restart or be seen by someone who opens the
// app later. A single in-memory slot: sending a new one just replaces
// whatever was there. Client widgets poll for it (see /api/tomte-
// broadcast below) rather than relying on Tomte's WebSocket, since that
// only connects once someone actually opens/uses Tomte — most people
// with the app merely open in a background tab wouldn't have one.
// Auto-expires after 30 minutes so a forgotten broadcast doesn't sit
// around confusing someone who opens the app hours later.
let currentTomteBroadcast = null; // { id, text, linkLabel, linkHref, createdAt } | null
const TOMTE_BROADCAST_TTL_MS = 30 * 60 * 1000;
// Active-browser tracking (Per Bot 21) — every poll carries a random
// per-tab id (see tomteTabId in tomte-widget.js), recorded here with a
// last-seen timestamp. Counted (and pruned of anything stale) whenever
// the admin checks — not on a timer, since nobody's reading the count
// except when the broadcast card is actually open. A generous window
// relative to the 15s poll interval absorbs normal network jitter
// without underselling the count.
const activeTomteTabs = new Map(); // tabId -> lastSeenTimestamp
const TOMTE_ACTIVE_TAB_WINDOW_MS = 40 * 1000;
function countActiveTomteTabs() {
  const cutoff = Date.now() - TOMTE_ACTIVE_TAB_WINDOW_MS;
  for (const [id, ts] of activeTomteTabs) {
    if (ts < cutoff) activeTomteTabs.delete(id);
  }
  return activeTomteTabs.size;
}
app.get('/api/admin/tomte-broadcast', auth.requireAuthApi(['admin']), (req, res) => {
  if (currentTomteBroadcast && Date.now() - currentTomteBroadcast.createdAt > TOMTE_BROADCAST_TTL_MS) currentTomteBroadcast = null;
  res.json({ broadcast: currentTomteBroadcast, activeCount: countActiveTomteTabs() });
});
app.post('/api/admin/tomte-broadcast', auth.requireAuthApi(['admin']), (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message required.' });
  // Per Bot 21 — an optional link, shown as a clickable action under the
  // message (same visual pattern as the proactive-tip action links
  // above). Both fields are optional but travel together — a URL with
  // no label has nothing to click on, a label with no URL has nowhere
  // to go, so either both are present or neither is.
  const linkLabel = (req.body.linkLabel || '').trim();
  const linkHref = (req.body.linkHref || '').trim();
  if ((linkLabel && !linkHref) || (linkHref && !linkLabel)) {
    return res.status(400).json({ error: 'A link needs both link text and a URL.' });
  }
  currentTomteBroadcast = { id: uuidv4(), text, linkLabel: linkLabel || null, linkHref: linkHref || null, createdAt: Date.now() };
  res.json({ ok: true, broadcast: currentTomteBroadcast });
});
app.delete('/api/admin/tomte-broadcast', auth.requireAuthApi(['admin']), (req, res) => {
  currentTomteBroadcast = null;
  res.json({ ok: true });
});
// Client-facing poll — any authenticated role (client, facilitator,
// admin), since anyone with the app open right now is exactly who this
// is for. No seen-tracking here at all, on purpose — each browser tab
// tracks what it's already shown itself, client-side only.
app.get('/api/tomte-broadcast', auth.requireAuthApi(), (req, res) => {
  if (currentTomteBroadcast && Date.now() - currentTomteBroadcast.createdAt > TOMTE_BROADCAST_TTL_MS) currentTomteBroadcast = null;
  const tabId = (req.query.tabId || '').toString().slice(0, 100);
  if (tabId) activeTomteTabs.set(tabId, Date.now());
  res.json(currentTomteBroadcast);
});


// Self-service voice-output toggle (Per Bot 11) — replaces the old
// per-browser localStorage flag. Any logged-in role can flip their own
// preference here; an admin can also set the same field from the user
// details panel (e.g. turning it on for someone who wouldn't think to look
// for the toggle themselves) — same single shared column either side can
// write to, same convention as tomte_language/tomte_image_filename above.
app.patch('/api/my/tomte-voice', auth.requireAuthApi(), (req, res) => {
  db.setTomteVoiceEnabled(req.user.role, req.user.id, !!req.body.enabled);
  res.json({ ok: true });
});
app.patch('/api/my/tomte-name', auth.requireAuthApi(), (req, res) => {
  db.setTomteName(req.user.role, req.user.id, (req.body.name || '').trim().slice(0, 30));
  res.json({ ok: true });
});
app.post('/api/my/tomte-image', auth.requireAuthApi(), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const stored = await uploadTomteImageToR2(req.file);
    db.setTomteImage(req.user.role, req.user.id, stored);
    res.json({ ok: true, url: tomteImageUrl(stored) });
  } catch (e) {
    console.error('my tomte-image upload error:', e.message);
    res.status(500).json({ error: 'Could not upload photo right now — please try again.' });
  }
});
// Per Bot 32 — lets anyone pick from whatever Per has already added to
// the Tomte library, not just upload their own. Read-only, so no reason
// to gate it to admin the way the library management endpoints are.
app.get('/api/my/tomte-library', auth.requireAuthApi(), (req, res) => {
  res.json(db.getTomteImageLibrary().map(r => ({ id: r.id, filename: r.filename, label: r.label, url: tomteImageUrl(r.filename) })));
});
app.post('/api/my/tomte-image/select', auth.requireAuthApi(), (req, res) => {
  const filename = (req.body.filename || '').trim();
  if (!filename) return res.status(400).json({ error: 'Choose a photo.' });
  // Confirms it's a real library entry rather than trusting an arbitrary
  // filename straight from the request body.
  if (!db.getTomteImageLibrary().some(r => r.filename === filename)) return res.status(400).json({ error: 'That photo is no longer available.' });
  db.setTomteImage(req.user.role, req.user.id, filename);
  res.json({ ok: true, url: tomteImageUrl(filename) });
});

// ── 1:1 video/audio calls (Per Bot 12) ──
// Signaling itself lives on the WebSocket router near the bottom of this
// file (same consolidated-upgrade pattern as Tomte/listen/facilitator
// co-pilot); everything here is the REST side — starting a call, the
// client noticing and responding to it, consent, ending, and the
// recording/transcript/share lifecycle afterward.

// Every browser needs the same ICE server list to attempt a WebRTC
// connection: a public STUN server always, plus a TURN relay if one's
// configured (see TURN_URL etc. near the top of this file) for the
// calls a direct connection can't reach. No auth needed — this is
// standard practice; the servers themselves don't grant access to
// anything, they're just how two already-authenticated peers find each
// other's media.
app.get('/api/ice-servers', (req, res) => {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (TURN_URL) {
    servers.push({ urls: TURN_URL, username: TURN_USERNAME || undefined, credential: TURN_CREDENTIAL || undefined });
  }
  res.json({ iceServers: servers });
});

// Facilitator starts a call — creates the 'ringing' row the client's
// poll below will pick up. One ringing call per client at a time is the
// practical assumption; nothing here enforces that strictly since a
// facilitator only ever has one client detail view open at once anyway.
app.post('/api/facilitator/calls', auth.requireAuthApi(['facilitator', 'admin']), (req, res) => {
  const client = db.getUser(req.body.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  const call = db.createCall(uuidv4(), req.user.id, client.id, req.body.callType);
  res.json(call);
});
// Facilitator polls this while waiting for the client to answer.
app.get('/api/facilitator/calls/:id', auth.requireAuthApi(['facilitator', 'admin']), (req, res) => {
  const call = db.getCall(req.params.id);
  if (!call || (req.user.role !== 'admin' && call.facilitator_id !== req.user.id)) return res.status(404).json({ error: 'Call not found.' });
  res.json(call);
});
// Client polls this quietly while the app is open — the only way an
// incoming call surfaces right now (see the parked note in chat about
// true push notifications for someone not currently in the app).
app.get('/api/client/calls/incoming', auth.requireAuthApi(['client']), (req, res) => {
  const call = db.getRingingCallForClient(req.user.id);
  if (!call) return res.json({ call: null });
  const facilitator = db.getFacilitatorById(call.facilitator_id);
  res.json({ call: { ...call, facilitatorName: (facilitator && facilitator.name) || 'Your facilitator' } });
});
app.patch('/api/calls/:id/respond', auth.requireAuthApi(['client']), (req, res) => {
  const call = db.getCall(req.params.id);
  if (!call || call.client_id !== req.user.id) return res.status(404).json({ error: 'Call not found.' });
  if (call.status !== 'ringing') return res.status(400).json({ error: 'This call is no longer ringing.' });
  if (req.body.accept) {
    db.updateCallStatus(call.id, 'active', { answered_at: new Date().toISOString() });
  } else {
    db.updateCallStatus(call.id, 'declined');
  }
  res.json(db.getCall(call.id));
});
// Recording consent — asked fresh at the start of every call (never a
// blanket setting), always answered by the client, since they're the
// one being recorded. The call itself proceeds either way; a decline
// just means the facilitator's browser won't start MediaRecorder.
app.patch('/api/calls/:id/consent', auth.requireAuthApi(['client']), (req, res) => {
  const call = db.getCall(req.params.id);
  if (!call || call.client_id !== req.user.id) return res.status(404).json({ error: 'Call not found.' });
  db.setCallConsent(call.id, req.body.granted ? 'granted' : 'declined');
  res.json(db.getCall(call.id));
});
app.patch('/api/calls/:id/end', auth.requireAuthApi(['client', 'facilitator', 'admin']), (req, res) => {
  const call = db.getCall(req.params.id);
  if (!call || (call.facilitator_id !== req.user.id && call.client_id !== req.user.id)) return res.status(404).json({ error: 'Call not found.' });
  if (!['ended', 'declined', 'missed'].includes(call.status)) {
    db.updateCallStatus(call.id, 'ended', { ended_at: new Date().toISOString() });
  }
  res.json(db.getCall(call.id));
});
// The facilitator's browser is the one that composites and uploads the
// recording (see the design note in chat — client-side MediaRecorder,
// not a server-side media relay), so this is facilitator-only. Kicks off
// transcription in the background rather than making the upload request
// wait for it.
// Per Bot 24 (maintenance rebuild, priority 2) — presigned direct-to-R2
// for call recordings, flagged as genuine risk (full session audio, no
// real size ceiling, previously browser → Node → R2 with the whole
// buffer loaded into memory along the way).
app.post('/api/calls/:id/recording/presign-upload', auth.requireAuthApi(['facilitator', 'admin']), async (req, res) => {
  try {
    const call = db.getCall(req.params.id);
    if (!call || (req.user.role !== 'admin' && call.facilitator_id !== req.user.id)) return res.status(404).json({ error: 'Call not found.' });
    if (call.recording_consent !== 'granted') return res.status(400).json({ error: 'This call was not consented to for recording.' });
    if (!media.isConfigured()) return res.status(503).json({ error: 'Media storage is not configured.' });
    const { mimeType } = req.body;
    const ext = mimeType && mimeType.includes('mp4') ? '.mp4' : '.webm';
    const key = `call-recordings/${uuidv4()}${ext}`;
    const uploadUrl = await media.getUploadUrl(key, mimeType || 'video/webm');
    res.json({ uploadUrl, key });
  } catch (e) {
    console.error('call recording presign-upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/calls/:id/recording', auth.requireAuthApi(['facilitator', 'admin']), upload.single('file'), async (req, res) => {
  const call = db.getCall(req.params.id);
  if (!call || (req.user.role !== 'admin' && call.facilitator_id !== req.user.id)) return res.status(404).json({ error: 'Call not found.' });
  if (call.recording_consent !== 'granted') return res.status(400).json({ error: 'This call was not consented to for recording.' });
  try {
    // Per Bot 24 — Path A: already uploaded directly to R2 (see
    // presign-upload above). Fetches the object back once here purely
    // to hand the buffer to transcription, which needs the raw audio —
    // still one R2 round-trip either way, but the original upload
    // itself (the part with no real size ceiling) never touches this
    // server at all now.
    if (req.body && req.body.r2Key) {
      const key = req.body.r2Key;
      if (!key.startsWith('call-recordings/')) return res.status(400).json({ error: 'Unexpected key.' });
      const exists = await media.objectExists(key).catch(() => false);
      if (!exists) return res.status(400).json({ error: 'Upload did not complete — try again.' });
      const mimeType = req.body.mimeType || (key.endsWith('.mp4') ? 'video/mp4' : 'video/webm');
      const durationSeconds = parseInt(req.body.durationSeconds, 10) || null;
      db.setCallRecording(call.id, key, durationSeconds);
      const obj = await media.getPublicObject(key);
      const chunks = [];
      for await (const chunk of obj.Body) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      transcribeCallRecording(call.id, buffer, mimeType); // fire-and-forget
      return res.json({ ok: true });
    }

    // Path B — legacy fallback, same as before this change.
    if (!req.file) return res.status(400).json({ error: 'No recording received.' });
    const buffer = fs.readFileSync(req.file.path);
    const stored = await uploadCallRecordingToR2(buffer, req.file.mimetype);
    const durationSeconds = parseInt(req.body.durationSeconds, 10) || null;
    db.setCallRecording(call.id, stored, durationSeconds);
    fs.unlink(req.file.path, () => {});
    transcribeCallRecording(call.id, buffer, req.file.mimetype); // fire-and-forget
    res.json({ ok: true });
  } catch (e) {
    console.error('call recording upload error:', e.message);
    res.status(500).json({ error: 'Could not save the recording right now.' });
  }
});
// Facilitator's own history for a client — everything, regardless of
// share status, since it's their recording to manage until shared.
app.get('/api/facilitator/clients/:id/calls', auth.requireAuthApi(['facilitator', 'admin']), (req, res) => {
  const calls = req.user.role === 'admin'
    ? db.getAllCallsForClient(req.params.id)
    : db.getCallsForFacilitatorClient(req.user.id, req.params.id);
  res.json(calls);
});
app.patch('/api/calls/:id/share', auth.requireAuthApi(['facilitator', 'admin']), (req, res) => {
  const call = db.getCall(req.params.id);
  if (!call || (req.user.role !== 'admin' && call.facilitator_id !== req.user.id)) return res.status(404).json({ error: 'Call not found.' });
  if (!call.recording_key) return res.status(400).json({ error: 'There is no recording on this call yet.' });
  db.setCallShared(call.id, !!req.body.shared);
  res.json(db.getCall(call.id));
});
// Client's own view — only ever the calls the facilitator has explicitly
// shared with them, nothing else.
app.get('/api/client/calls', auth.requireAuthApi(['client']), (req, res) => {
  res.json(db.getSharedCallsForClient(req.user.id));
});
// Presigned playback URL — the same short-lived, checked-access-first
// pattern the content library already uses. Facilitator can always play
// their own recordings back; a client only once shared_with_client is set.
app.get('/api/calls/:id/recording-url', auth.requireAuthApi(['client', 'facilitator', 'admin']), async (req, res) => {
  const call = db.getCall(req.params.id);
  if (!call || !call.recording_key) return res.status(404).json({ error: 'No recording found.' });
  const isFacilitator = req.user.role === 'admin' || call.facilitator_id === req.user.id;
  const isSharedClient = call.client_id === req.user.id && !!call.shared_with_client;
  if (!isFacilitator && !isSharedClient) return res.status(403).json({ error: 'Not authorised to view this recording.' });
  try {
    const url = await media.getPlaybackUrl(call.recording_key);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: 'Could not generate a playback link right now.' });
  }
});

// ── Tomte — the app-navigation helper (Per Bot 8) ──
// Lives in a corner of every page, public and logged-in alike, answering
// ONLY "how does this app work" questions — never clinical or personal
// content, which stays Talk's and the facilitator's territory. No auth
// gate (he has to work on the public pages too), so this is rate-limited
// per IP rather than per account — a blunt but real safeguard against an
// unauthenticated endpoint calling Claude/ElevenLabs on someone else's
// dime. Reuses the exact same Deepgram STT → Claude → ElevenLabs TTS
// pipeline the facilitator co-pilot below already uses, just with a much
// narrower system prompt and no session/client state to manage.
const tomteRateLog = new Map(); // ip -> [timestamps]
function tomteRateLimitOk(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000; // 10 minutes
  const maxRequests = 30;
  const recent = (tomteRateLog.get(ip) || []).filter(t => now - t < windowMs);
  if (recent.length >= maxRequests) return false;
  recent.push(now);
  tomteRateLog.set(ip, recent);
  return true;
}
function tomteSystemPrompt(page, focus, name, language) {
  const b = brand();
  const displayName = name || 'Tomte';
  const languageName = (language && LANGUAGE_NAMES[language]) || language || 'English';
  const resourceLine = prompts.CLIENT_CRISIS_RESOURCES(language || 'en').trim();
  return `You are ${displayName}, a small helper character who lives in the corner of every page of the ${b.name} app. You help with exactly one thing: how the app works — what a page is for, what a button or field does, where to find something, how a feature is used.

You do NOT answer questions about mindfulness practice, the nervous system, FELT·FIBRE content, therapy, or anything personal or clinical the person is going through, even briefly. If asked something like that, warmly redirect them instead: for anything reflective or practice-related, point them to Talk; for anything personal or clinical, suggest they reach out to their facilitator directly. Never attempt the answer yourself.

The one exception: if someone describes suicidal thoughts, intent to end their life, or self-harm, the redirect above is too slow — don't send them elsewhere first. Respond immediately as a person who is genuinely concerned, plainly and without alarm, and give them this: ${resourceLine}

Current page: ${page || 'unknown'}.
${focus ? `The person just interacted with: ${focus}. Start there — that's almost certainly what they want explained, not the whole page.` : 'Nothing specific in focus — if asked a general question, explain what this page is for.'}

Respond in ${languageName} — this is this specific person's own language preference, not necessarily the app owner's.
Keep answers short: a sentence or two for a simple question, a short paragraph at most for something more involved. Plain, warm, direct language, no jargon. Refer to yourself as ${displayName} and use "I" naturally.

Start every reply with exactly one tag on its own, chosen from: [[ACTION:default]] [[ACTION:shrug]] [[ACTION:smile]] [[ACTION:wink]] [[ACTION:laugh]] [[ACTION:bow]] — shrug for redirecting something you can't help with, bow for a closing/thank-you, wink for something playful, laugh for a delighted moment, smile for a normal helpful answer, default otherwise. Pick whichever actually fits the tone of what you're about to say. This tag is stripped before the person sees or hears anything, so it never affects your actual wording.`;
}

// Per Bot 9 debug: "Invalid frame header" errors right after a successful
// open are a known symptom of the permessage-deflate compression extension
// getting mangled by something in between (proxies/load balancers often
// don't pass that negotiation through cleanly) — the two sides end up
// disagreeing about whether frames are compressed, corrupting every one.
// Disabling it removes that whole failure mode.
// Per Bot 9 fix: every ws server bound via {server, path} attaches its OWN
// 'upgrade' listener to the same shared http.Server — and Node fires ALL
// of them for every single upgrade request, regardless of path. Each one's
// internal handleUpgrade() checks its own path and calls abortHandshake(400)
// if it doesn't match, which either kills a request meant for a DIFFERENT
// path before that server's own listener gets a turn, or — worse — writes
// a raw 400 response into a socket a DIFFERENT server already successfully
// upgraded moments earlier, corrupting the live WebSocket stream (surfacing
// to the browser as "Invalid frame header"). All four sockets in this app
// now use noServer:true and are routed explicitly by the single consolidated
// server.on('upgrade', ...) handler near the bottom of this section, the
// same pattern already used correctly for the facilitator socket.
const tomteWss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
tomteWss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  console.log(`[tomte] connection opened from ${ip}`);
  let history = [];
  let currentPage = '';
  let currentFocus = '';
  let dgWs = null;
  // Per Bot 9 fix: MediaRecorder puts the crucial WebM container header
  // (the ONLY chunk that tells Deepgram how to parse everything after it)
  // in the very first chunk emitted. Establishing our own outbound
  // connection to Deepgram takes a real network round-trip, and that first
  // chunk can easily arrive before it's open — silently dropping it left
  // Deepgram receiving only headerless continuation data it could never
  // make sense of (hence a Metadata reply with duration:0, channels:0, then
  // a clean close). Buffering anything that arrives before dgWs is OPEN,
  // then flushing it in order the moment it opens, closes that gap.
  let pendingAudioChunks = [];
  // Per Bot 9: tapping "stop" mid-sentence (rather than pausing long enough
  // for Deepgram's own endpointing to fire speech_final) was silently
  // discarding whatever had been transcribed so far — nothing ever reached
  // respond(). Tracking the latest interim transcript here means a manual
  // stop can fall back to "whatever we've got" instead of losing it.
  let lastTranscript = '';
  // Per Bot 9: opt-in voice replies — off by default each connection,
  // turned on only if the person flips the widget's speaker toggle. Set via
  // the 'set_voice' message below.
  let voiceRequested = false;

  // Per Bot 9 debug: a WebSocket with no 'error' listener attached can, in
  // some Node/ws versions, throw on an unhandled internal error and take
  // the whole process down with it — which would perfectly explain "every
  // connection just fails" with nothing obviously wrong in the request
  // logs (Railway would auto-restart, and the next person's attempt would
  // just fail the same way against a freshly-booted process). This should
  // have been here from the start regardless of what turns out to be
  // going on.
  ws.on('error', (e) => console.error(`[tomte] ws error (${ip}):`, e.message));

  // Identifying the logged-in user here is purely optional — Tomte works
  // fine for anonymous visitors on the public pages too. When there IS a
  // valid session cookie, this just looks up whether they've personalized
  // his name, so he refers to himself correctly in replies.
  let tomteName = null;
  let tomteLanguage = null;
  let tomteVoiceId = VOICE_ID;
  let tomtePersonalImage = null;
  let tomteSkinId = null;
  // Per Bot 21 — kept in scope (not just inside the try block below) so
  // greet() can re-resolve tomteName fresh right before speaking, rather
  // than trusting whatever was true the moment this connection first
  // opened. Real bug this fixes: a long-lived tab's WebSocket stays
  // open across opening/closing the panel — only a full page reload
  // used to pick up a name changed in My Account since connecting.
  let sessionPayload = null;
  try {
    const cookies = parseCookies(req.headers.cookie);
    sessionPayload = auth.verifyToken(cookies[auth.COOKIE_NAME]);
    const payload = sessionPayload;
    console.log(`[tomte] cookie present: ${!!cookies[auth.COOKIE_NAME]}, valid session: ${!!payload}${payload ? `, role=${payload.role} id=${payload.id}` : ''}`);
    if (payload) {
      const settings = db.getTomteSettings(payload.role, payload.id);
      tomteName = settings.tomte_name || null;
      // Per Bot 9: an explicit Tomte-only language override wins over the
      // account's own language field — lets someone get Tomte replies/voice
      // in a different language than the rest of their account (emails,
      // UI) without touching that account language at all.
      tomteLanguage = settings.tomte_language || settings.language || null;
      tomtePersonalImage = settings.tomte_image_filename || null;
      tomteSkinId = settings.skin_id || null;
      // Personal choice always wins; otherwise Dutch defaults to Mare
      // (if configured), otherwise the app's own default voice.
      tomteVoiceId = settings.voice_id || (tomteLanguage === 'nl' && MARE_VOICE_ID ? MARE_VOICE_ID : VOICE_ID);
      console.log(`[tomte] settings resolved OK — language=${tomteLanguage}, voice=${tomteVoiceId}`);
    }
  } catch(e) {
    console.error('[tomte] error resolving settings for this connection (falling back to defaults):', e.message);
  }

  function send(obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  // Shared by both a real reply and the first-contact greeting below —
  // sends the text immediately, then speaks it in the background once
  // ElevenLabs returns (never blocks the text arriving first).
  async function speak(text, action) {
    if (action) {
      send({ type: 'action', action, imageUrl: resolveTomteImage(tomtePersonalImage, tomteLanguage, action, tomteSkinId) });
    }
    send({ type: 'response_text', text });
    if (!TOMTE_VOICE_ENABLED || !voiceRequested) return;
    try {
      const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${tomteVoiceId}?output_format=mp3_44100_192`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY, 'Connection': 'close' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.65, similarity_boost: 0.80, speed: VOICE_SPEED }
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (ttsRes.ok) {
        const buf = await ttsRes.buffer();
        send({ type: 'audio', data: buf.toString('base64') });
      }
    } catch(e) { console.error('tomte tts error:', e.message); }
  }

  async function respond(userText) {
    if (!userText || !userText.trim()) return;
    if (!tomteRateLimitOk(ip)) {
      send({ type: 'response_text', text: "I've answered a lot of questions in a short time — give me a few minutes and ask again." });
      return;
    }
    // Thinking image, shown immediately while Claude generates the real
    // reply — swapped out for whatever action the reply actually tags
    // once it comes back, a moment later.
    send({ type: 'action', action: 'thinking', imageUrl: resolveTomteImage(tomtePersonalImage, tomteLanguage, 'thinking', tomteSkinId) });
    try {
      const systemPrompt = tomteSystemPrompt(currentPage, currentFocus, tomteName, tomteLanguage);
      history.push({ role: 'user', content: userText });
      if (history.length > 12) history = history.slice(-12); // keep it light — Tomte doesn't need deep memory
      const rawReply = await callClaude(systemPrompt, history, 1500);
      // Strip the leading [[ACTION:x]] tag Claude was asked to include —
      // this never reaches the person as text or speech, it just decides
      // which image accompanies the reply.
      const tagMatch = rawReply.match(/^\s*\[\[ACTION:(\w+)\]\]\s*/i);
      const action = tagMatch && TOMTE_ACTIONS.includes(tagMatch[1].toLowerCase()) ? tagMatch[1].toLowerCase() : 'default';
      const reply = tagMatch ? rawReply.slice(tagMatch[0].length) : rawReply;
      history.push({ role: 'assistant', content: reply });
      await speak(reply, action);
    } catch(e) {
      console.error('tomte respond error:', e.message);
      send({ type: 'response_text', text: 'Something went wrong there — try again in a moment.' });
    }
  }

  // First-contact greeting (Per Bot 8) — a short scripted intro rather
  // than a Claude call: faster, free, and there's nothing to get wrong
  // about "hi, I'm X" that benefits from an LLM generating it fresh each
  // time. Personalized with whatever name the person's set (or Tomte by
  // default) and the current page, so it doesn't feel like a canned popup.
  async function greet() {
    const name = tomteName || 'Tomte';
    const page = currentPage ? ` here on ${currentPage}` : '';
    const languageDisplayName = (tomteLanguage && LANGUAGE_NAMES[tomteLanguage]) || tomteLanguage || 'English';
    let text = `Hi, I'm ${name}. If you're not sure how something works${page}, just ask me — by typing or talking — and I'll walk you through it.`;
    // Only bother with a translation call when it's actually needed —
    // English stays the plain hardcoded line above, no extra round-trip.
    if (tomteLanguage && tomteLanguage !== 'en') {
      try {
        text = await callClaude(
          `Translate this greeting naturally into ${languageDisplayName}, keeping the same warm, casual tone. Respond with ONLY the translated sentence, nothing else — no quotes, no preamble.`,
          [{ role: 'user', content: text }],
          800
        );
      } catch(e) { /* fall back to the English version if translation fails */ }
    }
    history.push({ role: 'assistant', content: text });
    await speak(text, 'greeting');
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    console.log(`[tomte] message received: ${msg.type}`);
    switch (msg.type) {
      case 'context':
        currentPage = msg.page || currentPage;
        currentFocus = msg.focus || '';
        // Per Bot 33o — an anonymous visitor on a skin's own /login/:slug or
        // /register/:slug page has no account yet, so there's no skin_id to
        // read. This is the only way to know which skin's Tomte photo to
        // show them in that pre-login window — validated against a real
        // skin so a bogus slug can't be used to probe for anything. A
        // logged-in user's own tomteSkinId (set above, from their account)
        // always takes priority and is never overwritten here.
        if (!tomteSkinId && msg.skinSlug && db.getSkin(msg.skinSlug)) {
          tomteSkinId = msg.skinSlug;
        }
        break;
      case 'set_voice':
        voiceRequested = !!msg.enabled;
        break;
      case 'greet':
        currentPage = msg.page || currentPage;
        await greet();
        break;
      case 'text_input':
        await respond(msg.text);
        break;
      case 'start_listening': {
        send({ type: 'listening_started' });
        pendingAudioChunks = [];
        dgWs = new WebSocket(
          // Per Bot 9 fix: this stream is WebM (from MediaRecorder), a
          // containerized format that already declares its own codec and
          // sample rate. Explicitly setting encoding/sample_rate/channels
          // here was telling Deepgram to instead treat it as RAW, headerless
          // Opus — the two don't reconcile, so Deepgram accepted every audio
          // chunk without ever erroring, but never returned a transcript
          // either (per Deepgram's own docs: "if you're streaming
          // containerized audio... you should not set the encoding and
          // sample rate"). Let it auto-detect the container instead.
          'wss://api.deepgram.com/v1/listen?model=nova-2&language=multi&smart_format=true&endpointing=400&utterance_end_ms=3200&interim_results=true',
          { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
        );
        dgWs.on('open', () => {
          console.log('[tomte] deepgram connected');
          if (pendingAudioChunks.length) {
            console.log(`[tomte] flushing ${pendingAudioChunks.length} chunk(s) buffered while connecting`);
            pendingAudioChunks.forEach(buf => dgWs.send(buf));
            pendingAudioChunks = [];
          }
        });
        dgWs.on('unexpected-response', (req, res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => console.error(`[tomte] deepgram rejected connection — status=${res.statusCode} body=${body}`));
        });
        dgWs.on('message', async (data) => {
          try {
            const parsed = JSON.parse(data.toString('utf8'));
            console.log('[tomte] deepgram message:', JSON.stringify(parsed).slice(0, 300));
            const transcript = parsed?.channel?.alternatives?.[0]?.transcript;
            if (transcript && transcript.trim()) lastTranscript = transcript.trim();
            if (transcript && transcript.trim() && parsed.speech_final) {
              lastTranscript = '';
              send({ type: 'final_transcript', text: transcript });
              await respond(transcript);
            }
          } catch(e) { console.error('[tomte] deepgram message parse error:', e.message); }
        });
        dgWs.on('error', (e) => console.error('[tomte] deepgram error:', e.message));
        dgWs.on('close', (code, reason) => console.log(`[tomte] deepgram closed — code=${code} reason=${reason ? reason.toString() : ''}`));
        break;
      }
      case 'audio_chunk':
        if (msg.data) {
          const buf = Buffer.from(msg.data, 'base64');
          if (dgWs && dgWs.readyState === WebSocket.OPEN) {
            console.log(`[tomte] forwarding chunk: ${buf.length} bytes, starts with ${buf.subarray(0, 8).toString('hex')}`);
            dgWs.send(buf);
          } else if (dgWs && dgWs.readyState === WebSocket.CONNECTING) {
            console.log(`[tomte] buffering chunk (still connecting): ${buf.length} bytes`);
            pendingAudioChunks.push(buf);
          } else {
            console.log(`[tomte] audio_chunk dropped — dgWs state: ${dgWs ? dgWs.readyState : 'null (not created yet)'}`);
          }
        }
        break;
      case 'stop_listening':
        if (dgWs) { dgWs.close(); dgWs = null; }
        if (lastTranscript) {
          const t = lastTranscript;
          lastTranscript = '';
          send({ type: 'final_transcript', text: t });
          await respond(t);
        }
        break;
    }
  });
  ws.on('close', (code, reason) => {
    console.log(`[tomte] connection closed (${ip}) — code=${code} reason=${reason ? reason.toString() : ''}`);
    if (dgWs) dgWs.close();
  });
});

// ── Facilitator WebSocket Stage 2 — review / edit / regenerate / release ──
// Every session generated via the facilitator co-pilot lands with a DRAFT
// client-facing summary (client_summary_draft) that is never visible to the
// client until explicitly released. These endpoints are that review loop.
//
// Ownership: matches the existing check on /api/clients/:id (admin sees
// everything; a facilitator only their own sessions) — a single helper here
// so all five endpoints enforce it identically rather than each rolling
// their own version of the same check.
function canAccessSession(session, user) {
  return user.role === 'admin' || session.facilitator_id === user.id;
}

// List — for the facilitator's own "sessions awaiting review" workspace view.
app.get('/api/facilitator/sessions', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  try { res.json(db.getSessionsForFacilitatorReview(req.user.id, req.user.role === 'admin')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Review — full detail on one session, clinical + draft + released text.
app.get('/api/sessions/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  try {
    const session = db.getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (!canAccessSession(session, req.user)) return res.status(403).json({ error: 'Access denied.' });
    res.json(session);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Edit — the clinical record and/or the draft. Deliberately never touches
// client_summary, so an edit can never accidentally release something.
app.patch('/api/sessions/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  try {
    const session = db.getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (!canAccessSession(session, req.user)) return res.status(403).json({ error: 'Access denied.' });
    const { summary, client_summary_draft } = req.body;
    db.updateSessionDraft(req.params.id, summary, client_summary_draft);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Regenerate — asks Claude for a fresh client-facing draft from the current
// clinical summary. Overwrites the draft (not the released text) so a
// facilitator can iterate freely without affecting what the client sees
// until they're happy and release it.
app.post('/api/sessions/:id/regenerate', auth.requireAuthApi(['admin','facilitator']), async (req, res) => {
  try {
    const session = db.getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (!canAccessSession(session, req.user)) return res.status(403).json({ error: 'Access denied.' });
    const newDraft = await callClaude(
      'You are rewriting a clinical summary into a short, warm note for the client to read themselves.',
      [{ role: 'user', content: prompts.GENERATE_CLIENT_SUMMARY(session.summary) }],
      1000
    );
    db.updateSessionDraft(req.params.id, null, newDraft);
    res.json({ ok: true, client_summary_draft: newDraft });
  } catch(e) {
    console.error('session regenerate error:', e.message);
    res.status(500).json({ error: 'Could not regenerate. Please try again.' });
  }
});

// Release — copies the (possibly hand-edited) draft into client_summary,
// which is the field the client's own Sessions tab actually reads.
app.post('/api/sessions/:id/release', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  try {
    const session = db.getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (!canAccessSession(session, req.user)) return res.status(403).json({ error: 'Access denied.' });
    if (!session.client_summary_draft || !session.client_summary_draft.trim()) {
      return res.status(400).json({ error: 'There\'s no draft to release yet — write or regenerate one first.' });
    }
    db.releaseSession(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Unrelease — pulls a released summary back out of client view (the draft is
// untouched), for the rare case something was released by mistake.
app.post('/api/sessions/:id/unrelease', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  try {
    const session = db.getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (!canAccessSession(session, req.user)) return res.status(403).json({ error: 'Access denied.' });
    db.unreleaseSession(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Practices API ──
app.get('/api/clients/:id/practices', auth.requireAuthApi(['admin','facilitator','client']), (req, res) => {
  res.json(db.getPracticesForClient(req.user.role === 'client' ? req.user.id : req.params.id));
});
app.post('/api/practices/text', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const { client_id, title, content } = req.body;
  if (!client_id || !title) return res.status(400).json({ error: 'client_id and title required.' });
  // Per Bot 15c — this used to fall through to addPractice's own defaults
  // (source_type='talk', facilitator_id=null), making a practice the
  // facilitator deliberately added indistinguishable from something the
  // client saved themselves mid-Talk-conversation. Now properly
  // attributed, so it can show in its own place rather than blending in.
  db.addPractice(uuidv4(), client_id, title, 'text', content, '', 'facilitator', null, null, req.user.id);
  res.json({ ok: true });
});
// Per Bot 24 (maintenance rebuild, priority 2) — presigned direct-to-R2
// for practice audio, same reasoning as call recordings/newsletter
// videos. The practice id is generated here (not by the browser) since
// it doubles as part of the R2 key, same convention the existing
// server-relayed path already used.
app.post('/api/practices/audio/presign-upload', auth.requireAuthApi(['admin','facilitator']), async (req, res) => {
  try {
    if (!media.isConfigured()) return res.status(503).json({ error: 'Media storage is not configured.' });
    const { filename, contentType } = req.body;
    const id = uuidv4();
    const ext = (filename && filename.match(/\.[a-zA-Z0-9]+$/)) ? filename.match(/\.[a-zA-Z0-9]+$/)[0] : '.mp3';
    const key = `practices/${id}${ext}`;
    const uploadUrl = await media.getUploadUrl(key, contentType || 'audio/mpeg');
    res.json({ uploadUrl, key, practiceId: id });
  } catch (e) {
    console.error('practice audio presign-upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/practices/audio', auth.requireAuthApi(['admin','facilitator']), upload.single('file'), async (req, res) => {
  const { client_id, title } = req.body;
  if (!client_id || !title) return res.status(400).json({ error: 'Missing fields.' });

  // Per Bot 24 — Path A: already uploaded directly to R2 (see
  // presign-upload above) — no file bytes touch this server at all.
  if (req.body && req.body.r2Key && req.body.practiceId) {
    const key = req.body.r2Key;
    if (!key.startsWith('practices/') || !key.includes(req.body.practiceId)) return res.status(400).json({ error: 'Unexpected key.' });
    const exists = await media.objectExists(key).catch(() => false);
    if (!exists) return res.status(400).json({ error: 'Upload did not complete — try again.' });
    db.addPractice(req.body.practiceId, client_id, title, 'audio', '', key, 'facilitator', null, null, req.user.id, 'r2');
    return res.json({ id: req.body.practiceId, storageType: 'r2' });
  }

  // Path B — legacy fallback, same as before this change.
  if (!req.file) return res.status(400).json({ error: 'Missing fields.' });
  const id = uuidv4();
  // Per Bot 15c — this used to leave the uploaded file sitting in ./uploads
  // on the container's own filesystem and store just that filename —
  // fine right up until the next deploy or restart, at which point the
  // file is gone (only the sql.js DB file has a persistent volume; this
  // directory never did) while the practice row referencing it lives on
  // forever, permanently broken. Every audio practice ever added this way
  // was on borrowed time. Now relayed straight into R2 like every other
  // upload in this app, and the local temp copy is cleaned up right after.
  if (media.isConfigured()) {
    try {
      const buffer = fs.readFileSync(req.file.path);
      const key = `practices/${id}${path.extname(req.file.originalname || req.file.filename) || '.mp3'}`;
      await media.putObject(key, buffer, req.file.mimetype || 'audio/mpeg');
      fs.unlink(req.file.path, () => {}); // best effort — don't hold up the response on cleanup
      // See /api/practices/text above for why source_type/facilitator_id are set explicitly here.
      db.addPractice(id, client_id, title, 'audio', '', key, 'facilitator', null, null, req.user.id, 'r2');
      return res.json({ id, storageType: 'r2' });
    } catch (e) {
      console.error('practice audio R2 upload failed, falling back to local disk (not persistent — will not survive the next deploy):', e.message);
    }
  }
  db.addPractice(id, client_id, title, 'audio', '', req.file.filename, 'facilitator', null, null, req.user.id, 'disk');
  res.json({ id, storageType: 'disk' });
});
app.patch('/api/practices/:id/favourite', (req, res) => { db.toggleFavourite(req.params.id); res.json({ ok: true }); });
app.patch('/api/practices/:id/use',       (req, res) => { db.incrementUseCount(req.params.id); res.json({ ok: true }); });

// Per Bot 15c — resolves a real playback URL for an audio practice rather
// than the client hardcoding /uploads/:filename directly, which only ever
// worked for the (non-persistent, now-legacy) disk storage path. A client
// may only ever resolve their own practice; a facilitator/admin may
// resolve any (matching the same access shape as the library-files
// playback-url route).
app.get('/api/practices/:id/playback-url', auth.requireAuthApi(['client', 'facilitator', 'admin']), async (req, res) => {
  try {
    const p = db.getPractice(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found.' });
    if (req.user.role === 'client' && p.client_id !== req.user.id) return res.status(403).json({ error: 'Not yours.' });
    if (p.storage_type === 'r2') {
      const url = await media.getPlaybackUrl(p.filename);
      return res.json({ url });
    }
    // Legacy disk path — kept only so any practice added before this fix
    // that might still happen to have survived on disk isn't broken
    // outright; anything genuinely lost just 404s from here same as before.
    return res.json({ url: `/uploads/${p.filename}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Save something offered in Talk straight into the client's own Practices
// list — reuses the exact same practices table/tab that facilitator- and
// admin-added practices already use. type 'text' matches how those are
// already rendered (openPractice() in client/index.html).
app.post('/api/practices/save-from-talk', auth.requireAuthApi(['client']), (req, res) => {
  const { title, content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Nothing to save.' });
  const id = uuidv4();
  db.addPractice(id, req.user.id, (title || 'From a conversation').trim().slice(0, 120), 'text', content.trim(), '');
  res.json({ id });
});
app.delete('/api/practices/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  db.deletePractice(req.params.id); res.json({ ok: true });
});

// ── Messages (Per Bot 8) ──
// Two-way, tied optionally to a session (opened from that session's own
// record so context stays attached) or general otherwise. Built on a flat
// table with a reserved course_instance_id column so the future cohort/
// course-instance messaging (community + per-lesson channels) extends
// this same table rather than needing a second, parallel system.
function messageSummaryText(m) {
  if (m.deleted_at) return 'Message deleted';
  if (m.content_type === 'voice') return 'Sent a voice note';
  if (m.content_type === 'video') return 'Sent a video note';
  if (m.content_type === 'attachment') return `Sent a file${m.content ? ': ' + m.content : ''}`;
  return m.content;
}
async function notifyClientOfMessage(client, message) {
  try {
    const preview = messageSummaryText(message).slice(0, 140);
    if (client.pref_email_messages && client.email) {
      const b = brand();
      await sendEmail(client.email, `New message from your facilitator`, `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
        <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>
        <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:20px">Hi ${client.name || ''},</h1>
        <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">You have a new message: <em>"${preview}"</em></p>
        <a href="${APP_URL}" style="display:inline-block;background:#2d6a4f;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-size:14px">Open Per Bot</a>
        <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/><div style="font-size:12px;color:#aaa">${b.name}</div>
      </div>`);
    }
    if (client.pref_sms_messages && client.phone && sms.isConfigured()) {
      await sms.sendSms(client.phone, `${brand().name}: New message from your facilitator — "${preview}". Open the app to reply.`);
    }
  } catch(e) { console.error('notifyClientOfMessage error:', e.message); }
}

function requireClientOwnedByFacilitator(req, res, next) {
  const client = db.getUser(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  // Per Bot 19 fix: same gap as /api/clients/:id — only checked the legacy
  // single facilitator_id, wrongly blocking a facilitator assigned to this
  // client only via the newer client_facilitators table.
  //
  // Per's request — a third path added here: a facilitator who has no 1:1
  // relationship with this person at all, only a course one (they're
  // enrolled in something this facilitator teaches). Without this, a
  // student messaging a course-only facilitator (see resolveClientFacilitatorId's
  // own new branch) would send successfully from their side, but the
  // facilitator's own inbox would 403 trying to open that exact thread —
  // messages accepted into a black hole neither side could actually see.
  const isAssigned = client.facilitator_id === req.user.id
    || db.isFacilitatorAssignedToClient(client.id, req.user.id)
    || db.isFacilitatorAssignedToStudentViaCourse(client.id, req.user.id);
  if (req.user.role !== 'admin' && !isAssigned) return res.status(403).json({ error: 'Access denied.' });
  req.messageClient = client;
  next();
}

// Facilitator/admin side
app.get('/api/clients/:id/messages', auth.requireAuthApi(['admin','facilitator']), requireClientOwnedByFacilitator, (req, res) => {
  const sessionId = req.query.sessionId || null;
  res.json(db.getMessageThread(req.params.id, req.messageClient.facilitator_id || req.user.id, sessionId));
});
app.get('/api/clients/:id/messages/session-threads', auth.requireAuthApi(['admin','facilitator']), requireClientOwnedByFacilitator, (req, res) => {
  res.json(db.getSessionThreadsForClient(req.params.id, req.messageClient.facilitator_id || req.user.id));
});
app.post('/api/clients/:id/messages', auth.requireAuthApi(['admin','facilitator']), requireClientOwnedByFacilitator, async (req, res) => {
  const { session_id, content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message is empty.' });
  const facilitatorId = req.messageClient.facilitator_id || req.user.id;
  const msg = db.addMessage(uuidv4(), req.params.id, facilitatorId, session_id || null, 'facilitator', req.user.id, 'text', content.trim(), '', '');
  notifyClientOfMessage(req.messageClient, msg);
  res.json(msg);
});
// Per Bot 24 (maintenance rebuild, priority 1) — message attachments
// (voice/video/file) previously never left the container's local disk at
// all, which has no persistent volume — every attachment silently
// vanished on the next deploy or restart while the message referencing
// it lived on forever, permanently broken. Relayed to R2 now, same as
// call recordings and practice audio. Flat key (no folder prefix) is
// deliberate — /uploads/:filename below only matches a single path
// segment, and keeping the existing URL shape everywhere it's already
// embedded (client + facilitator message rendering, both hardcode
// /uploads/${filename}) meant nothing on the frontend needed to change.
async function uploadMessageAttachmentToR2(buffer, mimeType, originalName) {
  if (!media.isConfigured()) throw new Error('R2 is not configured.');
  const ext = (originalName && originalName.match(/\.[a-zA-Z0-9]+$/)) ? originalName.match(/\.[a-zA-Z0-9]+$/)[0] : '';
  const key = `message-${uuidv4()}${ext}`;
  await media.putObject(key, buffer, mimeType || 'application/octet-stream');
  return key;
}

app.post('/api/clients/:id/messages/upload', auth.requireAuthApi(['admin','facilitator']), requireClientOwnedByFacilitator, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  const { session_id, content_type, content } = req.body;
  const facilitatorId = req.messageClient.facilitator_id || req.user.id;
  let storedFilename = req.file.filename; // local-disk fallback if R2 isn't configured
  try {
    const buffer = fs.readFileSync(req.file.path);
    storedFilename = await uploadMessageAttachmentToR2(buffer, req.file.mimetype, req.file.originalname);
    fs.unlink(req.file.path, () => {});
  } catch (e) {
    console.error('message attachment R2 upload failed, falling back to local disk (not persistent — will not survive the next deploy):', e.message);
  }
  const msg = db.addMessage(uuidv4(), req.params.id, facilitatorId, session_id || null, 'facilitator', req.user.id,
    content_type || 'attachment', content || '', storedFilename, req.file.originalname);
  notifyClientOfMessage(req.messageClient, msg);
  res.json(msg);
});
app.patch('/api/clients/:id/messages/read', auth.requireAuthApi(['admin','facilitator']), requireClientOwnedByFacilitator, (req, res) => {
  const facilitatorId = req.messageClient.facilitator_id || req.user.id;
  db.markThreadRead(req.params.id, facilitatorId, req.body.session_id || null, 'facilitator');
  res.json({ ok: true });
});
app.get('/api/clients/:id/messages/unread-count', auth.requireAuthApi(['admin','facilitator']), requireClientOwnedByFacilitator, (req, res) => {
  res.json({ count: db.getUnreadMessageCountForFacilitator(req.messageClient.facilitator_id || req.user.id, req.params.id) });
});

// Client side — "my facilitator" is implicit from the logged-in client's own record
// ── Multiple facilitators per client (Per Bot 13) ──
// "Talk" is always first, synthetic (never a real facilitators row —
// nothing to log in as, no auth of its own), and always present even for
// a client with zero real facilitators assigned. Real facilitators come
// from the new client_facilitators join table, which also gets the
// client's legacy single facilitator_id folded in automatically via a
// boot-time backfill (see db.js) so nothing looks empty for existing
// clients on day one.
app.get('/api/client/facilitators', auth.requireAuthApi(['client']), (req, res) => {
  const real = db.getFacilitatorsForClient(req.user.id);
  // Per's request — "students see and interact with their facilitator,"
  // for a course as much as for 1:1 work. Merged into the same picker
  // the Talk menu already renders, rather than a separate UI — a course
  // facilitator is used exactly the same way (pick them, send a
  // message), it's only where the relationship comes from that differs.
  // De-duplicated by id: someone who happens to be both this student's
  // 1:1 facilitator AND a course facilitator only needs to appear once.
  const courseFacs = db.getCourseFacilitatorsForStudent(req.user.id);
  const realIds = new Set(real.map(f => f.id));
  const courseOnly = courseFacs.filter(f => !realIds.has(f.id))
    .map(f => ({ id: f.id, name: `${f.name} (${f.course_titles})` }));
  const list = [{ id: 'talk', name: 'Talk', isTalk: true }]
    .concat(real.map(f => ({ id: f.id, name: f.name, isTalk: false })))
    .concat(courseOnly.map(f => ({ ...f, isTalk: false })));
  res.json(list);
});
// The Arc is deliberately ONE shared field (users.arc) regardless of how
// many facilitators — human or Talk — read and add to it; nothing here
// splits it per relationship. Returned as plain text; the client renders
// it as a bullet list (it's already written in a bullet-friendly style by
// the same GENERATE_ARC_UPDATE prompt every facilitator/Talk session uses).
app.get('/api/client/arc', auth.requireAuthApi(['client']), (req, res) => {
  const me = db.getUser(req.user.id);
  res.json({ arc: (me && me.arc) || '' });
});
// Admin-managed for now (Per Bot 13) — assigning/removing an additional
// facilitator relationship. A facilitator-initiated version of this (e.g.
// a facilitator adding themselves, or a client requesting one) is a
// reasonable next step but isn't built yet; for now this covers the
// actual need (Per assigning a second facilitator to a client by hand).
app.post('/api/admin/users/:id/facilitators', auth.requireAuthApi(['admin']), (req, res) => {
  const facilitator = db.getFacilitatorById(req.body.facilitatorId);
  if (!facilitator) return res.status(404).json({ error: 'Facilitator not found.' });
  db.addClientFacilitator(req.params.id, req.body.facilitatorId);
  res.json({ ok: true });
});
app.get('/api/admin/users/:id/facilitators', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getFacilitatorsForClient(req.params.id));
});
app.delete('/api/admin/users/:id/facilitators/:facilitatorId', auth.requireAuthApi(['admin']), (req, res) => {
  db.removeClientFacilitator(req.params.id, req.params.facilitatorId);
  res.json({ ok: true });
});

// ── Resolving WHICH facilitator relationship a client-side messages call
// is about (Per Bot 13) ── Defaults to the legacy single facilitator_id
// when no facilitatorId is passed at all, so every existing call site
// that hasn't been updated yet keeps working exactly as before. When one
// IS passed, it must actually be a relationship this client has (legacy
// facilitator_id OR a client_facilitators row) — never trust the value
// from the request alone.
function resolveClientFacilitatorId(me, requestedId) {
  if (!requestedId) return me.facilitator_id || null;
  if (requestedId === me.facilitator_id) return requestedId;
  if (db.isFacilitatorAssignedToClient(me.id, requestedId)) return requestedId;
  // Per's request — a course facilitator is just as legitimate a
  // recipient as a 1:1 one; this is the same check the facilitator side
  // already relies on (isFacilitatorAssignedToInstance's underlying
  // relationship, checked here from the student's own direction instead).
  if (db.isFacilitatorAssignedToStudentViaCourse(me.id, requestedId)) return requestedId;
  return null;
}

// Scoped practices/session-summaries for the Facilitator Hub (Per Bot 18)
// — distinct from /api/clients/:id/practices (via /api/my/profile), which
// stays the unfiltered "everything I've collected" personal library view.
// No facilitatorId at all here means the same unfiltered view; 'talk'
// means specifically Talk's own self-guided sessions; anything else must
// be a real relationship this client actually has.
app.get('/api/client/practices', auth.requireAuthApi(['client']), (req, res) => {
  const requested = req.query.facilitatorId;
  if (!requested) return res.json(db.getPracticesForClient(req.user.id));
  if (requested === 'talk') return res.json(db.getPracticesForClient(req.user.id, 'talk'));
  const me = db.getUser(req.user.id);
  const facilitatorId = resolveClientFacilitatorId(me, requested);
  if (!facilitatorId) return res.json([]);
  res.json(db.getPracticesForClient(req.user.id, facilitatorId));
});

app.get('/api/my/messages', auth.requireAuthApi(['client']), (req, res) => {
  const me = db.getUser(req.user.id);
  const facilitatorId = resolveClientFacilitatorId(me, req.query.facilitatorId);
  if (!facilitatorId) return res.json([]);
  res.json(db.getMessageThread(req.user.id, facilitatorId, req.query.sessionId || null));
});
app.get('/api/my/messages/session-threads', auth.requireAuthApi(['client']), (req, res) => {
  const me = db.getUser(req.user.id);
  const facilitatorId = resolveClientFacilitatorId(me, req.query.facilitatorId);
  if (!facilitatorId) return res.json([]);
  res.json(db.getSessionThreadsForClient(req.user.id, facilitatorId));
});
app.post('/api/my/messages', auth.requireAuthApi(['client']), (req, res) => {
  const me = db.getUser(req.user.id);
  const facilitatorId = resolveClientFacilitatorId(me, req.body.facilitatorId);
  if (!facilitatorId) return res.status(400).json({ error: 'No facilitator assigned yet.' });
  const { session_id, content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message is empty.' });
  const msg = db.addMessage(uuidv4(), req.user.id, facilitatorId, session_id || null, 'client', req.user.id, 'text', content.trim(), '', '');
  res.json(msg);
});
app.post('/api/my/messages/upload', auth.requireAuthApi(['client']), upload.single('file'), async (req, res) => {
  const me = db.getUser(req.user.id);
  const facilitatorId = resolveClientFacilitatorId(me, req.body.facilitatorId);
  if (!facilitatorId) return res.status(400).json({ error: 'No facilitator assigned yet.' });
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  const { session_id, content_type, content } = req.body;
  let storedFilename = req.file.filename; // local-disk fallback if R2 isn't configured
  try {
    const buffer = fs.readFileSync(req.file.path);
    storedFilename = await uploadMessageAttachmentToR2(buffer, req.file.mimetype, req.file.originalname);
    fs.unlink(req.file.path, () => {});
  } catch (e) {
    console.error('message attachment R2 upload failed, falling back to local disk (not persistent — will not survive the next deploy):', e.message);
  }
  const msg = db.addMessage(uuidv4(), req.user.id, facilitatorId, session_id || null, 'client', req.user.id,
    content_type || 'attachment', content || '', storedFilename, req.file.originalname);
  res.json(msg);
});
app.patch('/api/my/messages/read', auth.requireAuthApi(['client']), (req, res) => {
  const me = db.getUser(req.user.id);
  const facilitatorId = resolveClientFacilitatorId(me, req.body.facilitatorId);
  if (!facilitatorId) return res.json({ ok: true });
  db.markThreadRead(req.user.id, facilitatorId, req.body.session_id || null, 'client');
  res.json({ ok: true });
});
app.get('/api/my/messages/unread-count', auth.requireAuthApi(['client']), (req, res) => {
  res.json({ count: db.getUnreadMessageCountForClient(req.user.id) });
});

// Edit/delete — facilitator only, and only their own messages (Per Bot 8
// explicitly scoped this to the facilitator; a client can't edit or
// retract what they've sent, same as the sessions clinical record).
app.patch('/api/messages/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const msg = db.getMessageById(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found.' });
  if (msg.sender_role !== 'facilitator' || (req.user.role !== 'admin' && msg.sender_id !== req.user.id)) return res.status(403).json({ error: 'Access denied.' });
  if (!req.body.content || !req.body.content.trim()) return res.status(400).json({ error: 'Message is empty.' });
  db.editMessage(req.params.id, req.body.content.trim());
  res.json(db.getMessageById(req.params.id));
});
app.delete('/api/messages/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const msg = db.getMessageById(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found.' });
  if (msg.sender_role !== 'facilitator' || (req.user.role !== 'admin' && msg.sender_id !== req.user.id)) return res.status(403).json({ error: 'Access denied.' });
  db.deleteMessage(req.params.id);
  res.json({ ok: true });
});

// ── Claude ──
// Shared low-level call — both callClaude and callClaudeRaw below delegate
// here, so this one fix applies everywhere (chat, legal translation, MOTD
// generation), not just wherever happened to get tested first.
//
// Connection: close — Node's built-in fetch (undici) pools and reuses
// keep-alive connections per host. If Railway's network (or any
// intermediary) silently closes a connection undici still considers alive,
// the next request that tries to reuse it fails with exactly the
// "Premature close" error seen in practice — a well-documented category of
// undici bug, not something specific to request size. This was the real
// fix; the earlier chunking change (still worth keeping, for other
// reasons) never addressed the actual cause, which is why it didn't help
// on its own.
//
// AbortSignal.timeout — fails fast rather than hanging indefinitely if a
// request genuinely stalls, so a bad connection burns a few seconds of a
// retry budget instead of the whole thing. Defaults to 25s (unchanged for
// every existing caller — a live chat reply should fail fast, not leave
// someone waiting). Callers processing something genuinely large — the
// knowledge-generation pipeline reading a whole document, say — pass a
// longer one explicitly; that's a real, slow-but-legitimate call, not a
// stall, and 25s was never going to be enough for it regardless of
// connection quality. The "Error: The user aborted a request" message
// this produces when it fires is Node's own generic AbortController
// wording — misleading in that it sounds like someone clicked cancel,
// but it's always this timeout, never an actual person aborting anything.
async function anthropicFetch(systemPrompt, messages, maxTokens, timeoutMs = 25000, disableThinking = false) {
  const requestBody = { model: ANTHROPIC_MODEL, max_tokens: maxTokens, system: systemPrompt, messages };
  // Per Bot 15t — Sonnet 5 runs with adaptive thinking on by default now
  // (a real behavior change from 4.6: a request with no `thinking` field
  // used to just run without it; on Sonnet 5 the same request now thinks
  // anyway), and thinking tokens draw from this same max_tokens budget —
  // it's a genuine hard limit on thinking PLUS the actual reply combined,
  // not a limit on the reply alone. For a strict "produce valid JSON, no
  // prose" task, thinking's own token spend is unpredictable and buys
  // little — worse, it can quietly eat most of the budget before any of
  // the actual JSON gets written, truncating the response mid-array. This
  // is exactly what happened generating knowledge-base topics from a
  // large document: the call succeeded, produced real text, and still
  // failed to parse because it never reached the closing bracket.
  if (disableThinking) requestBody.thinking = { type: 'disabled' };
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'Connection': 'close',
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json();
  if (!data.content) throw new Error(JSON.stringify(data));
  // Per Bot 33h — models with adaptive thinking on by default (Sonnet 5
  // and later) can return a 'thinking' content block ahead of the actual
  // 'text' block, so content[0] is no longer reliably the reply. Find the
  // text block explicitly rather than assuming position. If thinking used
  // up the whole max_tokens budget before any text was written at all,
  // there may be no text block — surface that clearly instead of silently
  // returning undefined (which would otherwise crash stripMarkdown()
  // further down the line and just look like "nothing happened").
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response (stop_reason=' + data.stop_reason + '): ' + JSON.stringify(data));
  // Per Bot 39 — a truncated reply used to come back here looking
  // exactly like a normal, complete one: textBlock.text was whatever
  // Claude had written before running out of room, with nothing to
  // distinguish it from a finished response. Every caller of this
  // function trusts what it gets back completely — several (ai-polish
  // chief among them) replace the user's existing content outright with
  // whatever comes back, no review step. A cut-off reply landing there
  // silently overwrote and lost real work rather than failing loudly.
  // Throwing here routes every caller into the try/catch + generic
  // "could not get a suggestion, try again" error path they already
  // have — turning silent data loss into a clean, visible failure,
  // with no new failure mode for any existing caller.
  if (data.stop_reason === 'max_tokens') {
    console.error(`anthropicFetch: response truncated at max_tokens (requested ${maxTokens}, thinking ${disableThinking ? 'disabled' : 'enabled — shares this budget'}) — ${textBlock.text.length} chars returned before cutoff`);
    throw new Error('Response was cut off before finishing — try again, or with a shorter message.');
  }
  return textBlock.text;
}

// Per Bot 15p — same shape as anthropicFetch, but with tools. Only
// get_knowledge needs resolving here — it's a custom tool, so the API
// pauses (stop_reason='tool_use') and hands control back to us. Native
// tools like web_search are resolved by Anthropic's own infrastructure
// inside the same call and never trigger this loop at all; they just
// show up already-resolved in the response's content blocks.
// toolResolvers is a map of { toolName: async (input) => resultString }.
// Bounded at 6 rounds — a real conversation calling get_knowledge more
// than a handful of times in one reply is very unlikely to be genuinely
// still going deeper rather than looping.
// Per Bot 17 phase 6 — same shape as anthropicFetch, but with Anthropic's
// native web_search tool enabled. This is a server-executed tool —
// Anthropic runs the search itself inside the same call and the results
// come back already resolved as extra content blocks ahead of the final
// text block, so this needs no tool-result loop (unlike
// anthropicFetchWithTools below, which is for custom client-side tools
// like get_knowledge that Anthropic can't resolve on its own).
async function anthropicFetchWithWebSearch(systemPrompt, messages, maxTokens, timeoutMs = 45000) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'Connection': 'close',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: maxTokens, system: systemPrompt, messages,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json();
  if (!data.content) throw new Error(JSON.stringify(data));
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response (stop_reason=' + data.stop_reason + '): ' + JSON.stringify(data));
  // Per Bot 39 — same truncation guard as anthropicFetch above; see that
  // comment for why silently returning a cut-off reply here is a real
  // data-loss bug, not a theoretical one.
  if (data.stop_reason === 'max_tokens') {
    console.error(`anthropicFetchWithWebSearch: response truncated at max_tokens (requested ${maxTokens}) — ${textBlock.text.length} chars returned before cutoff`);
    throw new Error('Response was cut off before finishing — try again, or with a shorter message.');
  }
  return textBlock.text;
}

async function anthropicFetchWithTools(systemPrompt, messages, tools, toolResolvers, maxTokens) {
  let convo = [...messages];
  for (let round = 0; round < 6; round++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Connection': 'close',
      },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system: systemPrompt, messages: convo, tools }),
      signal: AbortSignal.timeout(25000),
    });
    const data = await response.json();
    if (!data.content) throw new Error(JSON.stringify(data));

    if (data.stop_reason !== 'tool_use') {
      const textBlock = data.content.find(b => b.type === 'text');
      if (!textBlock) throw new Error('No text block in Claude response (stop_reason=' + data.stop_reason + '): ' + JSON.stringify(data));
      // Per Bot 39 — same truncation guard as anthropicFetch above.
      if (data.stop_reason === 'max_tokens') {
        console.error(`anthropicFetchWithTools: response truncated at max_tokens (requested ${maxTokens}) — ${textBlock.text.length} chars returned before cutoff`);
        throw new Error('Response was cut off before finishing — try again, or with a shorter message.');
      }
      return textBlock.text;
    }

    // Custom tool_use blocks need resolving; server_tool_use/web_search
    // blocks are already resolved and just get carried through as part
    // of the assistant message we echo back.
    const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
    convo.push({ role: 'assistant', content: data.content });
    const toolResults = await Promise.all(toolUseBlocks.map(async (block) => {
      const resolver = toolResolvers[block.name];
      let resultText;
      try {
        resultText = resolver ? await resolver(block.input) : `Unknown tool: ${block.name}`;
      } catch (e) {
        resultText = `Error resolving ${block.name}: ${e.message}`;
      }
      return { type: 'tool_result', tool_use_id: block.id, content: resultText };
    }));
    convo.push({ role: 'user', content: toolResults });
  }
  throw new Error('Too many tool-use rounds without a final answer.');
}

// Per Bot 15q — the actual get_knowledge tool Talk can reach for mid-reply.
// Schema kept deliberately simple: a topic id (from the menu already in
// the system prompt) and a level id (from whichever levels currently
// exist — Talk doesn't need to know the exact level names in advance,
// they're implied by what's in the menu's own framing).
const KNOWLEDGE_TOOL_DEF = {
  name: 'get_knowledge',
  description: 'Fetch real depth on one topic from the knowledge base, at a specific level. Use when a conversation genuinely goes deep enough to need it — not for every passing mention of a related idea.',
  input_schema: {
    type: 'object',
    properties: {
      topic_id: { type: 'string', description: 'The id of the topic, exactly as given in the knowledge menu.' },
      level: { type: 'string', description: 'Which depth level to fetch — e.g. overview, user, teacher, scientist.' },
    },
    required: ['topic_id', 'level'],
  },
};
async function resolveGetKnowledgeTool(input) {
  const topic = db.getKnowledgeTopic(input.topic_id);
  if (!topic || topic.archived) return `No such topic. Stay with what you already know rather than guessing at content.`;
  const row = db.getKnowledgeTopicContent(input.topic_id, input.level);
  if (!row || !row.content?.trim()) {
    const available = db.getKnowledgeTopicAllContent(input.topic_id).map(c => c.level_name).join(', ') || 'none yet';
    return `No content exists yet for "${topic.title}" at that level. Levels that do exist for this topic: ${available}.`;
  }
  return row.content;
}

// Per Bot 15r — the "go outside the boundary, but stay within the app's
// own material" fallback Per asked for. Deliberately a second, separate
// tool from get_knowledge rather than folded into it: get_knowledge is a
// direct, cheap lookup by (topic, level) — this one is a real search,
// genuinely slower and more expensive (it's its own Claude call), meant
// for the rarer case where the curated ladder above doesn't have
// something a conversation actually needs. Searches talk_context_documents
// — the old Context Documents feature, kept alive for exactly this,
// having stopped being injected into every turn (see its schema comment).
// Never reaches beyond the app's own uploaded material — no web search,
// nothing outside what's actually been fed into this app.
const SEARCH_SOURCE_TOOL_DEF = {
  name: 'search_source_material',
  description: "Search the full library of originally-uploaded source documents for something relevant that the curated knowledge base above doesn't cover. Slower than get_knowledge and only worth reaching for when a conversation genuinely needs depth that isn't in any topic yet — not a first resort, and not for anything the knowledge menu already has a topic for.",
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for — a real question or concept, not a single keyword.' },
    },
    required: ['query'],
  },
};
async function resolveSearchSourceMaterialTool(input, skinId) {
  const docs = db.getContextDocumentsForSkin(skinId);
  if (!docs.length) return 'No source material has been uploaded yet — nothing to search.';
  // Defensive cap only, same reasoning as the generation pipeline's own
  // MAX_CHARS — stops an accidental very-large corpus from becoming a
  // silent runaway cost on a tool call that can fire mid-conversation.
  const MAX_CHARS = 300000;
  let corpus = docs.map(d => `=== ${d.title} ===\n${d.content}`).join('\n\n');
  if (corpus.length > MAX_CHARS) corpus = corpus.slice(0, MAX_CHARS);
  const searchPrompt = `You are searching a library of source documents for material relevant to a specific query, on behalf of another AI mid-conversation with a real person. Read the documents below and extract only the passages genuinely relevant to the query — a paragraph or two per relevant point is plenty, not whole sections. If nothing here is genuinely relevant, say so plainly rather than including tangential material to seem useful.

QUERY: ${input.query}

SOURCE DOCUMENTS:
${corpus}`;
  try {
    // Per Bot 15s — 45s rather than the 25s default: this can search a
    // genuinely large corpus, and 25s was proving too tight even for the
    // backgrounded generation pipeline. Deliberately not as long as
    // generation's own 180s, though — this fires mid-conversation, with
    // someone actually waiting on a reply, not watching a progress log.
    return await anthropicFetch(
      'You are a precise research assistant. Extract only what is genuinely relevant to the query; never pad, never include tangential material just to have something to say.',
      [{ role: 'user', content: searchPrompt }],
      1200, 45000, true
    );
  } catch(e) {
    return `Search failed (${e.message}) — proceed with what you already know rather than waiting on this.`;
  }
}

// maxTokens defaults raised from 400 → 1500 (Per Bot 33h). On models with
// adaptive thinking on by default, thinking tokens are drawn from the same
// max_tokens budget as the visible reply — 400 was tight enough on Opus
// (no default thinking) but could let thinking alone consume the entire
// budget on Sonnet 5, leaving zero room for the actual reply text. Raising
// the ceiling doesn't cost more by itself — actual usage still bills only
// for tokens genuinely generated — it just stops silent truncation.
async function callClaude(systemPrompt, messages, maxTokens = 1500) {
  return stripMarkdown(await anthropicFetch(systemPrompt, messages, maxTokens));
}

// Per Bot 15q — same as callClaude, but with the get_knowledge tool
// available. Used only by the real client Talk conversation (not the
// facilitator co-pilot, session summaries, or guest chat — none of those
// need or currently offer a knowledge menu at all). Harmless to call even
// when no knowledge topics exist yet: the menu in the system prompt is
// empty, so there's nothing for the model to reach for.
// Per Bot 15r — now also offers search_source_material, scoped to the
// client's own skin via closure (the tool-resolver signature only ever
// receives the model's own input, not caller context, so skinId has to
// be captured here rather than threaded through the generic tool loop).
async function callClaudeWithKnowledge(systemPrompt, messages, maxTokens = 1500, skinId = null) {
  const text = await anthropicFetchWithTools(
    systemPrompt, messages,
    [KNOWLEDGE_TOOL_DEF, SEARCH_SOURCE_TOOL_DEF],
    {
      get_knowledge: resolveGetKnowledgeTool,
      search_source_material: (input) => resolveSearchSourceMaterialTool(input, skinId),
    },
    maxTokens
  );
  return stripMarkdown(text);
}

// Same as callClaude but WITHOUT stripMarkdown — needed anywhere the response
// itself is meant to contain literal Markdown syntax (e.g. translating a
// legal document that uses # headers, **bold**, - lists). Running that
// through stripMarkdown would silently mangle the formatting.
async function callClaudeRaw(systemPrompt, messages, maxTokens = 1500, disableThinking = false) {
  return anthropicFetch(systemPrompt, messages, maxTokens, 25000, disableThinking);
}

// ── AI Help / polish (Per Bot 8) — "make this more engaging" button shared
// across every rich editor in the app (newsletter, session drafts, journal,
// admin descriptions, lesson content, and the light message composers).
// Deliberately always uses the ADMIN's own account language, not the
// requesting user's — Per's own call, since this is meant to keep everything
// written in Per's working language regardless of which staff member
// triggers it (a facilitator polishing a session draft, say).
function getAdminLanguage() {
  try {
    const admins = db.getAllAdmins();
    const withLang = admins.find(a => a.language);
    return (withLang && withLang.language) || 'en';
  } catch(e) { return 'en'; }
}
// Per Bot 22 — the newsletter editor's "generate & insert at cursor"
// button, next to Insert Field. Four text generators share one shape
// (plain text, literal \n line breaks, converted to <br/> the same way
// MOTD content already is); the fifth (sumie) asks Claude for raw SVG
// markup instead and uploads it to R2 the same way an uploaded image
// would be, so the editor gets back a normal hosted image URL rather
// than an inline data URI (many email clients handle those poorly).
// Per Bot 22 — thinking disabled for these four: each prompt already
// spells out the compositional reasoning in detail (the kireji rule, the
// AABBA structure, the signal-hiding requirement), so extended thinking
// mostly just adds latency here rather than materially improving the
// result — and it draws from the same token budget as the reply itself,
// the same tradeoff already documented on anthropicFetch above. sumie
// keeps thinking on: composing a real multi-path SVG likely benefits
// from planning the composition before writing markup, and it's already
// a heavier call (plus an R2 upload after) where a few extra seconds
// matters less.
const COMMS_AI_GENERATORS = {
  motd:     { prompt: prompts.MOTD_GENERATION_PROMPT, userMessage: 'Write 1 new Message of the Day draft. Respond with only the JSON array (one element), nothing else.', parseJsonArray: true, disableThinking: true },
  limerick: { prompt: prompts.LIMERICK_GENERATION_PROMPT, userMessage: 'Write one limerick now.', disableThinking: true },
  haiku:    { prompt: prompts.HAIKU_GENERATION_PROMPT, userMessage: 'Write one haiku now.', disableThinking: true },
  poem:     { prompt: prompts.NATURE_POEM_GENERATION_PROMPT, userMessage: 'Write one four-stanza poem now.', hasTitle: true, disableThinking: true },
};
// Same short-retry reasoning as generateMotdChunk above — a transient
// network/proxy hiccup on a single call is common enough (and harmless
// enough to just redo) that it isn't worth surfacing as a failure to the
// person clicking the button.
async function callClaudeWithRetry(systemPrompt, userMessage, maxTokens, disableThinking = false, attempt = 1) {
  try {
    return await callClaudeRaw(systemPrompt, [{ role: 'user', content: userMessage }], maxTokens, disableThinking);
  } catch (e) {
    if (attempt >= 3) throw e;
    console.error(`comms-ai-generate call failed (attempt ${attempt}/3): ${e.name || 'Error'}: ${e.message} — retrying`);
    await new Promise(r => setTimeout(r, 1000 * attempt));
    return callClaudeWithRetry(systemPrompt, userMessage, maxTokens, disableThinking, attempt + 1);
  }
}
// Per Bot 22 — sumie now via OpenAI's GPT Image API instead of hand-
// composed SVG (the SVG approach genuinely couldn't produce something
// worth calling art). Claude still writes the actual prompt each time —
// fresh subject, vivid specific description, the disableThinking-fast
// path — OpenAI does the real rendering. The response comes back as
// base64 JSON, not a hosted URL, so this decodes and uploads to R2
// itself, same storage pattern as every other newsletter image, just a
// different source. gpt-image-2 is OpenAI's current flagship (April
// 2026) — quality:'high' since cost here is genuinely trivial per image
// and quality was the whole point of switching providers.
async function generateSumieImage(context) {
  if (!OPENAI_API_KEY) throw new Error('OpenAI is not configured on this deployment (missing OPENAI_API_KEY).');
  // Per Bot 22 — context is the newsletter's current body text (plain
  // text, stripped of HTML client-side), truncated defensively in case
  // someone triggers this on a very long draft — a few thousand
  // characters is more than enough for the model to spot a MOTD/poem/
  // limerick/haiku's theme, and keeps this fast text call cheap.
  const trimmedContext = (context || '').slice(0, 6000).trim();
  const userMessage = trimmedContext
    ? `<newsletter_context>\n${trimmedContext}\n</newsletter_context>\n\nWrite one sumi-e image prompt now.`
    : 'No newsletter content yet — <newsletter_context></newsletter_context> is empty. Write one sumi-e image prompt now.';
  const imagePrompt = (await callClaudeWithRetry(prompts.SUMIE_IMAGE_PROMPT_WRITING_PROMPT, userMessage, 500, true)).trim();

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: imagePrompt,
        size: '1024x1024',
        quality: 'high',
        background: 'opaque',
        output_format: 'png',
        n: 1,
      }),
      // OpenAI's own guidance: complex GPT Image prompts can take up to
      // roughly two minutes. Per Bot 22 — was 120000 (2 min), matching
      // that worst-case exactly, but too tight in practice: real
      // generation at quality:'high' sometimes ran past it, and the
      // timeout firing right as it finished threw node-fetch's own
      // "The user aborted a request" — technically accurate but reads
      // like a crash rather than what it actually was (a self-inflicted
      // timeout). Caught specifically below now instead of leaking that
      // raw message. This is already a background job (see
      // /api/admin/comms-ai-generate), so there's no UI cost to a more
      // generous margin either.
      signal: AbortSignal.timeout(280000),
    });
  } catch(e) {
    if (e.name === 'AbortError' || /aborted/i.test(e.message || '')) {
      throw new Error('Image generation took longer than expected (over 4.5 minutes) and was cancelled — please try again.');
    }
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    throw new Error(`Image generation failed: ${msg}`);
  }
  const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) throw new Error('No image came back — please try again.');
  return Buffer.from(b64, 'base64');
}
// Per Bot 22 — background job pattern, not a single long request. A GPT
// Image call can take up to ~2 minutes (OpenAI's own guidance), and
// Railway/Cloudflare's edge proxy times out well before that — the
// original synchronous version returned an HTML error page mid-request,
// which the frontend then tried to JSON.parse and crashed on. Also
// doubles as the mechanism for a proper preview-before-insert UX: the
// person isn't stuck watching a spinner, they can keep editing while a
// small panel polls in the background and shows the result — with
// Insert / Try again — once it's ready.
//
// DB-backed (ai_generate_jobs table), not an in-memory Map — a Map
// vanished if the server process restarted mid-generation, which
// happened twice in testing (each time producing a confusing crash: a
// 404 "Job not found" from the frontend poll, or the in-flight OpenAI
// request itself getting severed). See recoverPendingAiGenerateJobs
// below, called once at boot, for the other half of this fix.
async function runCommsAiGenerateJob(jobId, type, context) {
  try {
    if (type === 'sumie') {
      if (!media.isConfigured()) throw new Error('Image storage (R2) is not configured on this deployment.');
      const buffer = await generateSumieImage(context);
      const key = `newsletter-images/${uuidv4()}.png`;
      await media.uploadPublicObject(key, buffer, 'image/png');
      db.markAiGenerateJobDone(jobId, { imageUrl: `${APP_URL}/newsletter-images/${encodeURIComponent(key.replace('newsletter-images/', ''))}` });
      return;
    }

    const gen = COMMS_AI_GENERATORS[type];
    if (!gen) throw new Error('Unknown generator type.');
    // Per Bot 24 — optional topic/subject, typed in by the admin rather
    // than always generating something untargeted (previously every
    // haiku/poem/limerick came out about a fairly generic default
    // subject regardless of what the newsletter was actually about).
    // Appended to the existing userMessage rather than replacing it, so
    // the compositional rules already in the system prompt (kireji,
    // AABBA structure, signal-hiding, etc.) still apply in full.
    const userMessage = context && context.trim()
      ? `${gen.userMessage} Make it about: ${context.trim()}`
      : gen.userMessage;
    const raw = await callClaudeWithRetry(gen.prompt, userMessage, 2000, gen.disableThinking);
    let text;
    if (gen.parseJsonArray) {
      let arr;
      try { arr = JSON.parse(raw); }
      catch { arr = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); }
      text = arr[0];
    } else {
      text = raw.trim();
    }
    text = text || '';
    // Per Bot 22 — defence in depth alongside the prompt's own "exactly
    // three lines, no blank line" rule: haiku and limerick have a fixed
    // line count and should never have a blank line in them, unlike the
    // poem (which legitimately does, between stanzas). Collapsing any
    // stray blank line here means an occasional prompt slip still comes
    // out looking right, rather than relying on the model alone.
    if (type === 'haiku' || type === 'limerick') {
      text = text.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
    }
    let html;
    if (gen.hasTitle) {
      const parts = text.split(/\n\s*\n/);
      const title = (parts.shift() || '').trim();
      const body = parts.join('\n\n').trim();
      html = `<p style="font-weight:bold">${title}</p>` + body.replace(/\n/g, '<br/>');
    } else {
      html = text.replace(/\n/g, '<br/>');
    }
    db.markAiGenerateJobDone(jobId, { html });
  } catch(e) {
    console.error(`comms-ai-generate job ${jobId} (${type}) failed:`, e.message);
    db.markAiGenerateJobError(jobId, e.message || 'Could not generate that right now. Please try again.');
  }
}
// Per Bot 22 — called once at boot (see the bottom of this file where
// the server actually starts listening). Anything still 'pending' means
// the previous process died mid-generation — not a real failure, just
// an interrupted one — so it gets automatically re-run rather than left
// permanently stuck (which is exactly what produced the "Job not found"
// / severed-request errors seen in testing).
function recoverPendingAiGenerateJobs() {
  const pending = db.getPendingAiGenerateJobs();
  if (pending.length) {
    console.log(`[ai-generate] recovering ${pending.length} job(s) left pending by a previous process`);
    pending.forEach(job => runCommsAiGenerateJob(job.id, job.type, job.context));
  }
  db.pruneOldAiGenerateJobs();
}
app.post('/api/admin/comms-ai-generate', auth.requireAuthApi(['admin']), (req, res) => {
  const { type, context } = req.body;
  if (type === 'sumie' && !media.isConfigured()) return res.status(400).json({ error: 'Image storage (R2) is not configured on this deployment.' });
  if (type !== 'sumie' && !COMMS_AI_GENERATORS[type]) return res.status(400).json({ error: 'Unknown generator type.' });
  const jobId = uuidv4();
  db.createAiGenerateJob(jobId, type, context);
  runCommsAiGenerateJob(jobId, type, context); // deliberately not awaited — returns to the client immediately
  res.json({ jobId });
});
app.get('/api/admin/comms-ai-generate/:jobId', auth.requireAuthApi(['admin']), (req, res) => {
  const job = db.getAiGenerateJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found — it may have expired.' });
  res.json({ status: job.status, html: job.html, imageUrl: job.image_url, error: job.error });
});

app.post('/api/ai-polish', auth.requireAuthApi(), async (req, res) => {
  try {
    const { html } = req.body;
    const plain = (html || '').replace(/<[^>]+>/g, '').trim();
    if (!plain) return res.status(400).json({ error: 'Write something first.' });
    const b = brand();
    const language = getAdminLanguage();
    const systemPrompt = prompts.AI_POLISH_SIGNAL_PROMPT(b.name, language);
    // Per Bot 39 — bumped 2000 -> 6000 and thinking disabled (this task
    // doesn't need extended reasoning, and thinking draws from this same
    // budget — see the Per Bot 15t comment on anthropicFetch). At 2000
    // with thinking left on, anything longer than a short message could
    // run out of room mid-generation; a full newsletter with a couple of
    // poems in it easily needs more than that once HTML markup overhead
    // is counted too. Paired with the truncation guard now added to
    // anthropicFetch itself: if this ever does run out of room even at
    // 6000, it now throws instead of silently handing back a cut-off
    // reply — which matters here specifically, since the caller
    // (message-editor.js's runAiPolish) replaces the whole editor's
    // content outright with whatever comes back, no review step. A
    // thrown error here means that replace never happens and the
    // person's original message is left untouched; a truncated .html
    // used to mean it got silently overwritten and lost.
    const reply = await callClaudeRaw(systemPrompt, [{ role: 'user', content: html }], 6000, true);
    res.json({ html: reply.trim() });
  } catch(e) {
    console.error('ai-polish error:', e.message);
    res.status(500).json({ error: 'Could not get a suggestion right now. Please try again.' });
  }
});

// Per Bot 17 (session 2) — "Rewrite for selling" on the course editor.
// Separate from /api/ai-polish above (that one's a generic clarity pass
// shared by every rich editor and has no opinion about selling copy).
// Reads the description live from whatever's in the editor when clicked,
// so it always works from the actual current text — no separate database
// export/import step needed.
app.post('/api/admin/course-description-polish', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { title, html } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Give the course a title first.' });
    const plain = (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const language = getAdminLanguage();
    const userMessage = `WRITE IN LANGUAGE: ${language}\n\nCOURSE TITLE: ${title.trim()}\n\nCURRENT DESCRIPTION: ${plain || '(none yet — write one from the title alone)'}`;
    const reply = await callClaudeRaw(prompts.COURSE_DESCRIPTION_SELLING_PROMPT, [{ role: 'user', content: userMessage }], 500);
    res.json({ text: reply.trim() });
  } catch(e) {
    console.error('course-description-polish error:', e.message);
    res.status(500).json({ error: 'Could not get a suggestion right now. Please try again.' });
  }
});

// Per Bot 24 — "What's New" home promo's dedicated selling-copy
// generator, same pattern as course-description-polish above but for a
// one-line home-screen caption. Reads whatever's linked (title/type)
// for context, so the line can actually reference what it's pointing
// at rather than staying generic.
app.post('/api/admin/whats-new-polish', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { html, linkTitle, linkType } = req.body;
    const plain = (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const language = getAdminLanguage();
    const linkDesc = linkTitle ? `${linkType === 'course' ? 'a course' : 'a practice/book/poem'} titled "${linkTitle}"` : 'nothing (text-only, no link)';
    const userMessage = `WRITE IN LANGUAGE: ${language}\n\nCURRENTLY LINKS TO: ${linkDesc}\n\nCURRENT DRAFT LINE: ${plain || '(none yet — write one from the link alone)'}`;
    const reply = await callClaudeRaw(prompts.WHATS_NEW_PROMO_PROMPT, [{ role: 'user', content: userMessage }], 300);
    res.json({ text: reply.trim() });
  } catch(e) {
    console.error('whats-new-polish error:', e.message);
    res.status(500).json({ error: 'Could not get a suggestion right now. Please try again.' });
  }
});

// Per Bot 24 — CRUD for the "What's New" rotating set (see
// whats_new_items table comment in db.js). Straightforward and
// admin-only throughout — no is_active-single-row complexity like
// message_versions, since any number of items can be active at once
// here.
app.get('/api/admin/whats-new-items', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getAllWhatsNewItems()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/whats-new-items', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { body, format, linkType, linkId, linkTitle, active } = req.body;
    const id = uuidv4();
    db.addWhatsNewItem(id, body, format, linkType, linkId, linkTitle, active);
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/whats-new-items/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    if (!db.getWhatsNewItem(req.params.id)) return res.status(404).json({ error: 'Not found.' });
    const { body, format, linkType, linkId, linkTitle, active } = req.body;
    db.updateWhatsNewItem(req.params.id, body, format, linkType, linkId, linkTitle, active);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/whats-new-items/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteWhatsNewItem(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Per Bot 17 (session 3) — same idea, for Offers' headline/description.
app.post('/api/admin/offer-copy-polish', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { name, trialDays, headline, description } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Give the offer a name first.' });
    const language = getAdminLanguage();
    const userMessage = `WRITE IN LANGUAGE: ${language}\n\nOFFER NAME: ${name.trim()}\nTRIAL DAYS: ${trialDays || 14}\n\nCURRENT HEADLINE: ${(headline || '').trim() || '(none yet)'}\nCURRENT DESCRIPTION: ${(description || '').trim() || '(none yet)'}`;
    const raw = await callClaudeRaw(prompts.OFFER_COPY_SELLING_PROMPT, [{ role: 'user', content: userMessage }], 400);
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim(); parsed = JSON.parse(cleaned); }
    res.json(parsed);
  } catch(e) {
    console.error('offer-copy-polish error:', e.message);
    res.status(500).json({ error: 'Could not get a suggestion right now. Please try again.' });
  }
});

// ── /api/chat — Mare Bot architecture ──
// Client POSTs { message, sessionId, clientId } — server calls Claude and returns reply.
// Client then calls /api/speak with the reply text.
const chatSessions = new Map();

function getChatSession(sessionId, clientId) {
  if (!chatSessions.has(sessionId)) {
    chatSessions.set(sessionId, {
      history: [],
      transcript: [],
      clientId: clientId || null,
      systemPrompt: null,
      lastActivityAt: Date.now(),
      finalized: false,
    });
    // Per Bot 20 — session duration tracking for the Reports hub. This is
    // deliberately independent of pref_keep_history below: that's about
    // whether a clinical arc/summary gets built from the content, this is
    // just "someone used Talk for N minutes" — an operational usage
    // metric, not personal history, so it's recorded for every session
    // regardless of that opt-in.
    if (clientId) { try { db.startTalkSession(sessionId, clientId); } catch(e) { console.error('[talk_sessions] start failed:', e.message); } }
  }
  return chatSessions.get(sessionId);
}

// Language names for the handful of options offered at registration/account
// settings — used to phrase a natural instruction ("respond in Dutch") rather
// than passing a raw code, which models follow less reliably.
const LANGUAGE_NAMES = { en: 'English', nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish', pt: 'Portuguese' };
function languageInstruction(code) {
  if (!code || code === 'en') return ''; // English is the prompt's own native register — no instruction needed
  const name = LANGUAGE_NAMES[code] || code;
  return `\n\nRespond in ${name}. The person's preferred language is ${name} — write naturally in it, not as a translation of an English draft.`;
}

// Per Bot 33s — resolves any [[SIGNAL:id]] marker Talk drops into a reply.
// 'text' scripts get inlined directly into the reply text, so they just
// flow through the existing TTS pipeline like anything else Talk says —
// no client changes needed for that half. 'audio' scripts can't work that
// way (the client would need to actually play a specific file, not just
// speak text), so the marker is stripped from the spoken text and the
// file's URL comes back as a separate field instead, played after the
// main reply finishes rather than interleaved mid-sentence — simpler, and
// avoids overlapping TTS with a file. Reuses the exact same R2-vs-disk
// resolution as /api/content/library/:id/playback-url (signed URL for R2,
// plain path for legacy disk files) rather than building the URL from the
// filename directly. An unknown/deleted id, or one pointing at an
// archived file, strips silently rather than leaving a raw marker in what
// gets read aloud.
//
// Per Bot 33z — 'text' scripts also self-cache. requestVoiceId is the
// caller's resolved voice (see /api/chat below) — undefined/matching
// VOICE_ID means "the default voice". Only the default voice is cached:
// a script's cached_audio_key holds ONE rendition, so caching every
// custom voice a client might pick would mean serving the wrong voice to
// everyone else. Someone on a custom voice always gets live, uncached
// TTS exactly as before — no regression for them, just no cache hit.
// On the very first play in the default voice, this synthesizes once,
// right here, uploads the result to R2, and returns it as audioUrl for
// THIS turn too — so the very first play is never billed twice (once
// here, once again via the client's own /api/speak call).
async function synthesizeSignalSegment(text) {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_192`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY, 'Connection': 'close' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.65, similarity_boost: 0.80, speed: SIGNAL_SCRIPT_VOICE_SPEED }
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`ElevenLabs signal-cache segment synthesis failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function synthesizeAndCacheSignalAudio(script) {
  // Per Bot 35 — variable-duration pause markers, not a single fixed gap
  // for every transition. Real feedback from listening: a beat between
  // sentences needs to be short, a shift to a new body part needs
  // longer, and a line that says "for about ten seconds" needs to
  // actually last ten seconds, not the same 3s as everything else — one
  // fixed duration for every kind of gap couldn't satisfy all of that
  // at once. Scripts now use [[PAUSE:N]] (N in seconds) to mark exactly
  // where a gap belongs and how long it should be; [[PAUSE]] with no
  // number defaults to 2s, for an ordinary beat between sentences.
  // Splicing itself still goes through ffmpeg's concat demuxer — naive
  // Buffer.concat of separate MP3s produces corrupted, undecodable
  // audio, verified directly — so each segment is a real ElevenLabs
  // request, silence is generated fresh per gap at the exact requested
  // duration, and everything is properly re-muxed into one file.
  const raw = script.script_text || '';
  const parts = raw.split(/\[\[PAUSE(?::(\d+(?:\.\d+)?))?\]\]/g);
  // String.split with a capturing group interleaves the captured group
  // (the duration, or undefined if [[PAUSE]] had none) between each
  // text chunk: [text, duration, text, duration, text, ...]. Turn that
  // into { text, pauseAfter } pairs — pauseAfter is null for the last
  // chunk, since nothing follows it.
  const items = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = (parts[i] || '').replace(/\s+/g, ' ').trim();
    const pauseAfter = i + 1 < parts.length ? Number(parts[i + 1] || 2) : null;
    if (text) items.push({ text, pauseAfter });
  }
  // [[BREATH]] never had a matching mechanism here either way — strip it
  // as before, it's a live-conversation-only marker.
  items.forEach(item => { item.text = item.text.split('[[BREATH]]').join(' ').trim(); });
  const segments = items.filter(item => item.text);

  if (segments.length <= 1) {
    // Nothing to splice — a single short script (or one with no pause
    // markers at all) is just one request, same as before.
    const buffer = await synthesizeSignalSegment(segments[0]?.text || raw.replace(/\s+/g, ' ').trim());
    const key = `signal-audio/${script.id}-${uuidv4()}.mp3`;
    await media.uploadPublicObject(key, buffer, 'audio/mpeg');
    db.setSignalScriptCachedAudio(script.id, key, VOICE_ID);
    return media.getPlaybackUrl(key);
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'signal-audio-'));
  try {
    const partFiles = [];
    for (let i = 0; i < segments.length; i++) {
      const buf = await synthesizeSignalSegment(segments[i].text);
      const segPath = path.join(tmpDir, `seg${i}.mp3`);
      await fsp.writeFile(segPath, buf);
      partFiles.push(segPath);
      const gap = segments[i].pauseAfter;
      if (gap != null && i < segments.length - 1) {
        // Generated fresh each time via ffmpeg's own silence source
        // rather than a bundled asset, so the encoding always matches
        // exactly, and at the exact duration this specific gap called
        // for — no risk of a stray format mismatch, and no more forcing
        // every gap to the same length.
        const silPath = path.join(tmpDir, `sil${i}.mp3`);
        await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', String(gap), '-b:a', '192k', silPath]);
        partFiles.push(silPath);
      }
    }
    const listPath = path.join(tmpDir, 'list.txt');
    const listContent = partFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
    await fsp.writeFile(listPath, listContent);
    const outPath = path.join(tmpDir, 'combined.mp3');
    await execFileAsync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
    const buffer = await fsp.readFile(outPath);
    const key = `signal-audio/${script.id}-${uuidv4()}.mp3`;
    await media.uploadPublicObject(key, buffer, 'audio/mpeg');
    db.setSignalScriptCachedAudio(script.id, key, VOICE_ID);
    return media.getPlaybackUrl(key);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
// Per Bot 37 — the client's speak() function (client-index.html) only
// ever learned the bare [[PAUSE]] marker, not the newer [[PAUSE:N]]
// explicit-duration syntax used for pre-cached signal-script audio.
// Anywhere text with the newer marker format has to flow to the client
// for live speech (a synthesis failure, or a custom voice bypassing the
// cache entirely) needs this normalization first, or the client just
// reads the literal bracketed text aloud instead of pacing on it.
function normalizePauseMarkersForClient(text) {
  return (text || '').replace(/\[\[PAUSE(?::\d+(?:\.\d+)?)?\]\]/g, '[[PAUSE]]');
}

async function resolveSignalMarkers(text, requestVoiceId) {
  let audioUrl = null;
  const matches = [...text.matchAll(/\[\[SIGNAL:([a-zA-Z0-9_-]+)\]\]/g)];
  let resolved = text;
  const usingDefaultVoice = !requestVoiceId || requestVoiceId === VOICE_ID;
  for (const match of matches) {
    const [full, id] = match;
    const script = db.getSignalScript(id);
    let replacement = '';
    if (!script) {
      console.warn('[signal] unknown signal id in reply:', id);
    } else if (script.kind === 'audio' && script.file_filename && !script.file_archived) {
      audioUrl = script.file_storage_type === 'r2'
        ? await media.getPlaybackUrl(script.file_filename)
        : `/uploads/${script.file_filename}`;
    } else if (script.kind === 'text' && usingDefaultVoice && script.cached_audio_key && script.cached_audio_voice_id === VOICE_ID) {
      // Cache hit — reuse the audio generated on some earlier play.
      audioUrl = await media.getPlaybackUrl(script.cached_audio_key);
    } else if (script.kind === 'text' && usingDefaultVoice) {
      // Default voice, no valid cache yet (first play ever, or the
      // deployment's default voice changed since it was last cached) —
      // generate once now and serve that same result for this turn.
      try {
        audioUrl = await synthesizeAndCacheSignalAudio(script);
      } catch (e) {
        console.error('[signal] cache synthesis failed, falling back to live TTS:', e.message);
        // Per Bot 37 — the client's own speak() only ever learned the
        // bare [[PAUSE]] marker, not [[PAUSE:N]]'s explicit duration —
        // a [[PAUSE:5]] here would fail to match anything client-side
        // and get read aloud literally ("pause colon five"), which is
        // exactly what got reported. Normalizing down to the marker the
        // client already handles means this fallback still gets real,
        // if fixed-length, timed gaps instead of literal spoken
        // brackets — full variable-duration precision only applies to
        // the primary (successful, default-voice) synthesis path.
        replacement = normalizePauseMarkersForClient(script.script_text || '');
      }
    } else {
      // Custom voice — always live, uncached, exactly as before.
      replacement = normalizePauseMarkersForClient(script.script_text || '');
    }
    resolved = resolved.replace(full, replacement);
  }
  return { text: resolved.replace(/\s{2,}/g, ' ').trim(), audioUrl };
}

// Per Bot 15 — resolves a [[BREATHING:id]] marker Talk drops into a reply.
// Unlike [[SIGNAL:id]] (which inlines text or plays a file within the
// spoken reply), a breathing pattern opens its own guided timer view —
// so this just strips the marker from what gets spoken and returns the
// full pattern (with parsed phases) as a separate field for the client
// to act on. An unknown/archived id strips silently, same as an unknown
// signal id, rather than leaving a raw marker in what gets read aloud.
function resolveBreathingMarker(text) {
  const match = text.match(/\[\[BREATHING:([a-zA-Z0-9_-]+)\]\]/);
  if (!match) return { text, breathingPattern: null };
  const pattern = db.getBreathingPattern(match[1]);
  if (!pattern || pattern.archived) {
    console.warn('[breathing] unknown or archived pattern id in reply:', match[1]);
  }
  return {
    text: text.replace(match[0], '').replace(/\s{2,}/g, ' ').trim(),
    breathingPattern: (pattern && !pattern.archived) ? pattern : null,
  };
}

// ── Poem audio (Per Bot 25) ── "A listen option for poems that have
// linked audio [...] for poems without linked audio: [generate], and
// that generated audio is saved as the linked audio for future reuse
// (for this person and others)." Same cache-or-synthesize shape as
// synthesizeAndCacheSignalAudio above — a poem's audio_key/audio_voice_id
// on library_files plays the role signal_scripts.cached_audio_key/
// cached_audio_voice_id already do there. Poems are stored as real
// text/html files (see the file_type==='text/html' branch in the
// client's playback-url reader), not a short DB column — the text has
// to be fetched and stripped down to plain words before it can go to
// ElevenLabs at all.
async function getPoemPlainText(file) {
  const url = file.storage_type === 'r2' ? await media.getPlaybackUrl(file.filename, { noCache: true, forceUtf8: true }) : `${APP_URL}/uploads/${file.filename}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch poem content (${res.status}).`);
  const html = await res.text();
  // Prefer the <article> body if there is one (matches the client's own
  // reader, which does the same) — falls back to the whole document
  // otherwise. Strips tags crudely rather than pulling in a full HTML
  // parser just for this; good enough for the simple generated markup
  // these files actually contain (headings/paragraphs/line breaks).
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const body = articleMatch ? articleMatch[1] : html;
  return body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function synthesizeAndCachePoemAudio(file) {
  const text = await getPoemPlainText(file);
  if (!text) throw new Error('This poem has no readable text.');
  const buffer = await synthesizeSignalSegment(text);
  const key = `poem-audio/${file.id}-${uuidv4()}.mp3`;
  // Per Bot 25 — putObject, not uploadPublicObject: this is served back
  // out through the same signed/tier-checked getPlaybackUrl path every
  // other library file (meditations, audiobooks) already uses, not the
  // unauthenticated public route newsletter media uses. (The two upload
  // functions are actually identical PutObjectCommand calls underneath —
  // media.js has no real public/private storage distinction, R2 access
  // is uniformly private either way — but putObject is the one that
  // documents itself as backing this exact access pattern, so it's the
  // one that says what's actually true here.)
  await media.putObject(key, buffer, 'audio/mpeg');
  db.setPoemAudio(file.id, key, VOICE_ID);
  return key;
}

app.get('/api/client/poems/:id/audio-url', auth.requireAuthApi(['client', 'facilitator', 'admin']), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file || file.content_type !== 'poem') return res.status(404).json({ error: 'Not found.' });
    // Per Bot 25 — same access rule as playback-url itself: a client
    // below the tier this poem requires can't hear its narration either,
    // even though the audio_key/synthesis machinery has no tier concept
    // of its own — the poem's own text-access rule is what actually
    // governs this, not anything about the audio file.
    const userRec = req.user.role === 'client' ? db.getUser(req.user.id) : null;
    const userFlags = db.userFlagsFromRecord(userRec, req.user.role);
    const allowed = (req.user.role === 'facilitator' || req.user.role === 'admin')
      ? !file.archived
      : (db.canAccessFile(file, userFlags, req.user.id) || (!file.archived && db.fileHasFreePreview(file.id)));
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });
    // Cache hit — either an ElevenLabs synthesis under the deployment's
    // current default voice, or a real recording an admin uploaded
    // manually (audio_voice_id==='manual', see /api/admin/poems/:id/audio
    // below — a manual upload has no voice-staleness concept, it's just
    // always the right audio until someone replaces it). A synthesis
    // under a since-changed VOICE_ID is the one case that's stale and
    // gets regenerated below.
    if (file.audio_key && (file.audio_voice_id === VOICE_ID || file.audio_voice_id === 'manual')) {
      const url = await media.getPlaybackUrl(file.audio_key, {});
      return res.json({ url, cached: true });
    }
    const key = await synthesizeAndCachePoemAudio(file);
    const url = await media.getPlaybackUrl(key, {});
    res.json({ url, cached: false });
  } catch (e) {
    console.error('poem audio-url error:', e.message);
    res.status(500).json({ error: 'Could not prepare audio for this poem right now.' });
  }
});

// ── Poem audio admin management (Per Bot 25) ── the retrofit list: every
// poem, audio or not, searchable/sortable, with a manual upload/replace/
// remove/generate/preview per row — same makeSmartList component the
// signal-scripts admin table already uses.
app.get('/api/admin/poems', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json({ rows: db.getPoemsForAdmin() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/poems/:id/audio', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file || file.content_type !== 'poem') return res.status(404).json({ error: 'Not found.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    if (!(req.file.mimetype || '').startsWith('audio/')) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Only audio files are supported here.' });
    }
    const buffer = fs.readFileSync(req.file.path);
    const ext = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || ['.mp3'])[0];
    const key = `poem-audio/${file.id}-${uuidv4()}${ext}`;
    await media.putObject(key, buffer, req.file.mimetype);
    // 'manual' — see the cache-check comment above for why this sentinel
    // exists rather than reusing VOICE_ID here.
    db.setPoemAudio(file.id, key, 'manual');
    fs.unlink(req.file.path, () => {});
    res.json({ ok: true });
  } catch (e) {
    console.error('poem audio upload error:', e.message);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Could not upload: ' + e.message });
  }
});
app.delete('/api/admin/poems/:id/audio', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file || file.content_type !== 'poem') return res.status(404).json({ error: 'Not found.' });
    db.setPoemAudio(file.id, null, null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/poems/:id/generate-audio', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file || file.content_type !== 'poem') return res.status(404).json({ error: 'Not found.' });
    await synthesizeAndCachePoemAudio(file);
    res.json({ ok: true });
  } catch (e) {
    console.error('poem generate-audio error:', e.message);
    res.status(500).json({ error: 'Could not generate audio: ' + e.message });
  }
});

app.post('/api/chat', auth.requireAuthApi(['client']), async (req, res) => {
  try {
    const { message, sessionId, clientId } = req.body;
    const session = getChatSession(sessionId, clientId || req.user.id);
    session.lastActivityAt = Date.now();

    // Build system prompt once per session
    if (!session.systemPrompt) {
      let sp = prompts.CLIENT_SYSTEM_PROMPT;
      const cId = session.clientId;
      if (cId) {
        const client = db.getUser(cId);
        // Per Bot 43 — this session's own row was already inserted by
        // startTalkSession before we ever get here (see getChatSession
        // above), so this has to exclude sessionId itself or a genuine
        // first-timer would already see one "prior" session: their own.
        if (!db.hasEverUsedTalk(cId, sessionId)) {
          sp += prompts.CLIENT_FIRST_TIME_INTRO;
        }
        // Arc, framework, presentation, and shared journal entries are all
        // facilitator-set (or facilitator-relationship-derived) clinical
        // context — they apply regardless of pref_keep_history, which is
        // a separate consent specifically about whether THIS automated,
        // self-serve conversation gets summarised and folded into the arc
        // afterward (see finalizeChatSession below). Journal entries carry
        // their own per-entry share_with_bot consent already (see
        // getJournalEntriesForBot), so there's no double-gating needed here.
        const sessions = db.getSessionsForClient(cId);
        const arc = client?.arc || '';
        if (arc || sessions.length > 0) {
          sp += prompts.CLIENT_ARC_PREFIX(arc, sessions.length);
          sp += prompts.CLIENT_ADAPTIVE_CONTEXT(sessions.length);
        }
        sp += prompts.CLIENT_FRAMEWORK_CONTEXT(client?.framework);
        sp += prompts.CLIENT_PRESENTATION_CONTEXT(client?.presentation_flags);
        if (arc || sessions.length > 0 || client?.presentation_flags) {
          sp += prompts.CLIENT_INTEGRATION_INSTRUCTION;
        }
        const journalEntries = db.getJournalEntriesForBot(cId, 5);
        sp += prompts.CLIENT_JOURNAL_CONTEXT(journalEntries);
        // Per Bot 33s — skin-scoped knowledge and the signal-script menu.
        // Both use client?.skin_id — null for anyone not on a skin, which
        // getContextDocumentsForSkin/getSignalScriptMenu already treat as
        // "universal items only", same as everywhere else skins appear.
        // Per Bot 15p — Context documents no longer injected live (see
        // schema comment on knowledge_documents) — replaced by the
        // sectioned knowledge menu below, which only ever costs the menu
        // line per topic; real depth is fetched on demand via the
        // get_knowledge tool, not carried on every turn regardless of
        // relevance.
        sp += prompts.CLIENT_SIGNAL_MENU(db.getSignalScriptMenu(client?.skin_id));
        sp += prompts.CLIENT_BREATHING_MENU(db.getBreathingPatternMenu());
        sp += prompts.CLIENT_KNOWLEDGE_MENU(db.getKnowledgeMenu(client?.skin_id, client?.facilitator_id));
        // Variety rotation applies to everyone, unconditionally — this is
        // about avoiding staleness across sessions, not sensitive clinical
        // context, so it doesn't need any of the gating above.
        sp += prompts.CLIENT_VARIETY_CONTEXT(db.getSignalRotation(cId, prompts.SIGNAL_VARIATIONS));
        sp += languageInstruction(client?.language);
        sp += prompts.CLIENT_CRISIS_RESOURCES(client?.language || 'en');
      }
      session.systemPrompt = sp;
    }

    const isStart = !message || message === 'begin';

    if (!isStart) {
      session.history.push({ role: 'user', content: message });
      session.transcript.push(`USER: ${message}`);
    }

    const messages = session.history.length
      ? session.history
      : [{ role: 'user', content: 'begin' }];

    // Per Bot 15r — fetched fresh via session.clientId, not the
    // block-scoped `client` above (which only exists the one time
    // systemPrompt gets built) — same reasoning as voiceClient below.
    const currentClient = session.clientId ? db.getUser(session.clientId) : null;
    const reply = await callClaudeWithKnowledge(session.systemPrompt, messages, 1500, currentClient?.skin_id);
    session.history.push({ role: 'assistant', content: reply });
    session.transcript.push(`BOT: ${reply}`);

    // Per Bot 33z — session.clientId (not the block-scoped `client` above,
    // which only exists the one time systemPrompt gets built) is the
    // source of truth for which voice this reply should be cached
    // against, checked fresh on every turn. Reuses currentClient fetched
    // just above rather than a second identical lookup.
    const voiceClient = currentClient;
    const { text: afterSignals, audioUrl: signalAudioUrl } = await resolveSignalMarkers(reply, voiceClient?.voice_id);
    const { text: cleanReply, breathingPattern } = resolveBreathingMarker(afterSignals);
    res.json({ reply: cleanReply, signalAudioUrl, breathingPattern });
  } catch(e) {
    console.error('chat error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Keep History — finalizing an automated self-serve conversation ──
// The facilitator-led flow (see case 'end_session' above) has an explicit
// end point where a summary and arc update get generated. The automated
// /api/chat flow has no equivalent moment — it's just a REST endpoint the
// client polls, with no "conversation over" signal — so this fills that
// gap for anyone who's opted into pref_keep_history.
//
// Only ever runs once per session (finalized flag) even though it can be
// triggered two ways: a best-effort beacon from the client when they
// leave the Talk view (see /api/chat/finalize below), and a periodic
// server-side sweep (see cron.js) that catches sessions where the beacon
// never fired — a crashed tab, a killed app, a phone that died mid-
// conversation. Reuses the exact same summary/arc prompts already proven
// by the facilitator flow, just with sessionType 'self' instead of
// 'facilitator', and auto-publishes the client-facing note immediately —
// there's no facilitator in the loop here to review and release it, so
// gating it behind a review step that will never happen would just mean
// the person never sees their own note.
async function finalizeChatSession(sessionId) {
  const session = chatSessions.get(sessionId);
  if (!session || session.finalized) return;
  session.finalized = true; // mark first — avoids a double-fire race between the beacon and the cron sweep
  try { db.endTalkSession(sessionId); } catch(e) { console.error('[talk_sessions] end failed:', e.message); }

  try {
    if (!session.clientId || !session.transcript.length) return;
    const client = db.getUser(session.clientId);
    if (!client || !client.pref_keep_history) return; // respect opt-out even if it changed mid-session

    const transcript = session.transcript.join('\n');
    const clinicalSummary = await callClaude(
      'You are generating a session summary for a self-guided practice conversation.',
      [{ role: 'user', content: prompts.GENERATE_SESSION_SUMMARY(transcript, client.arc, 'self') }],
      1000
    );
    const clientSummary = await callClaude(
      'You are rewriting a session summary into a short, warm note for the person to read themselves.',
      [{ role: 'user', content: prompts.GENERATE_CLIENT_SUMMARY(clinicalSummary) }],
      1000
    );
    const arcUpdate = await callClaude(
      'You are updating a person\'s ongoing developmental arc based on a recent self-guided session summary.',
      [{ role: 'user', content: prompts.GENERATE_ARC_UPDATE(client.arc, clinicalSummary) }],
      1000
    );

    db.updateArc(client.id, arcUpdate.trim());
    db.addSession(uuidv4(), client.id, null, 'self', clinicalSummary, clientSummary.trim(), '');
  } catch(e) {
    console.error('finalizeChatSession error:', e.message);
  } finally {
    chatSessions.delete(sessionId);
  }
}

// Public-facing but still requires the client auth cookie — sendBeacon
// includes same-origin cookies automatically, so this stays behind the
// normal client auth check like everything else here. Best-effort by
// design: if this never arrives (tab killed, app crashed), the cron sweep
// in cron.js catches it later instead.
app.post('/api/chat/finalize', auth.requireAuthApi(['client']), (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) finalizeChatSession(sessionId); // deliberately not awaited — response shouldn't wait on 3 Claude calls
  res.json({ ok: true });
});

// ── Keep History — safety-net sweep for the automated chat flow ──
// The client sends a best-effort beacon when leaving Talk (see
// /api/chat/finalize above), but beacons can be missed — a crashed tab, a
// killed app, a phone that died mid-conversation. This finds any
// in-memory session that's gone quiet for a while and finalizes it the
// same way, so an opted-in person's arc still gets built even if the
// clean-exit signal never arrived. Called by cron.js.
function sweepStaleChatSessions(staleMinutes = 20) {
  const cutoff = Date.now() - staleMinutes * 60 * 1000;
  let swept = 0;
  for (const [sessionId, session] of chatSessions.entries()) {
    if (!session.finalized && session.lastActivityAt < cutoff) {
      finalizeChatSession(sessionId);
      swept++;
    }
  }
  return { ok: true, swept };
}

// ── /api/guest/lead — capture name + email, issues the guest identity ──
// cookie on success. Per doesn't want anonymous browsing-only access — this
// used to accept empty submissions silently; now it's the actual gate that
// requireGuestIdentity() checks for on the content/chat endpoints below.
app.post('/api/guest/lead', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !name.trim())  return res.status(400).json({ error: 'Please enter your name.' });
    if (!email || !email.trim().includes('@')) return res.status(400).json({ error: 'Please enter a valid email.' });

    const trimmedName  = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    const leadId = uuidv4();

    db.addGuestLead(leadId, trimmedName, trimmedEmail, 'guest_page');
    emailGuestLeadReceivedToAdmin({ name: trimmedName, email: trimmedEmail })
      .catch(e => console.error('guest lead admin email failed:', e.message));

    const token = auth.createGuestToken({ type: 'guest', leadId, name: trimmedName, email: trimmedEmail });
    res.cookie(auth.GUEST_COOKIE_NAME, token, auth.GUEST_COOKIE_OPTIONS);

    res.json({ ok: true });
  } catch(e) {
    console.error('guest lead error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/guest/content — requires guest identity (see requireGuestIdentity ──
// above). A guest has no user record and no role, so we use the same flags
// an unregistered Explorer would have — level 0 ("registered" tier) — via
// userFlagsFromRecord(null, null). getAllLibraryFilesWithAccess tags every
// file with `accessible` rather than filtering, so locked (higher-tier) items
// still show up with the lock icon the guest page already renders for them —
// that's the existing frontend behaviour, this just supplies the data it expects.
app.get('/api/guest/content', auth.requireGuestIdentity(), (req, res) => {
  try {
    const userFlags = db.userFlagsFromRecord(null, null);
    const files = db.getAllLibraryFilesWithAccess(userFlags);
    res.json(files);
  } catch(e) {
    console.error('guest content error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/admin/guest-leads — view leads (admin only) ──
app.get('/api/admin/guest-leads', auth.requireAuthApi(['admin']), (req, res) => {
  const leads = db.getGuestLeads();
  // Per Bot 15o — viewing this list is what clears the "unseen enquiries"
  // badge; marked after fetching, not before, so the response the admin
  // is about to see still reflects what was actually new.
  db.markGuestLeadsSeen();
  res.json(leads);
});

// Per Bot 15o — powers the small badge on the People nav link across
// every admin page, for facilitator requests still pending and enquiries
// not yet viewed. Deliberately lightweight (two COUNT queries) since it's
// called on every admin page load, not just People itself.
app.get('/api/admin/notification-counts', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    res.json({
      pendingFacilitatorRequests: db.getPendingFacilitatorRequestCount(),
      unseenEnquiries: db.getUnseenGuestLeadCount(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Facilitator requests (Per Bot 5, item 11) ──
// Member → Facilitator (Member 3) is apply-then-approve. Anyone can submit —
// the button on /account (member-only) auto-fills from their own account;
// the public /become-a-facilitator page works for anyone, logged in or not,
// since it's meant to be linkable from outside the app. The gate is at
// approval time, not submission time: approve requires a linked member
// account (see actOnFacilitatorRequest below) — that's where Per's stated
// principle (facilitate only once you know the practice as a member) is
// actually enforced, since a public link has to stay open to anyone.
app.post('/api/facilitator-request', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
    if (!email || !email.trim() || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required.' });
    const emailLower = email.trim().toLowerCase();

    const existingPending = db.getPendingFacilitatorRequestByEmail(emailLower);
    if (existingPending) return res.json({ ok: true, note: 'You already have a request under review — we\'ll be in touch.' });

    // Optional auth — if a valid client session cookie is present, link the request
    // to their account so the admin table can see their membership status.
    let userId = null;
    const token = req.cookies?.[auth.COOKIE_NAME];
    if (token) {
      const payload = auth.verifyToken(token);
      if (payload && payload.role === 'client') userId = payload.id;
    }

    const id = uuidv4();
    db.createFacilitatorRequest(id, userId, name.trim(), emailLower, message?.trim() || null);
    const request = db.getFacilitatorRequestById(id);
    await emailFacilitatorRequestReceivedToAdmin(request);
    res.json({ ok: true });
  } catch(e) {
    console.error('facilitator request error:', e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Lets the account page (and the public request page, when logged in) check
// whether the current member already has a request in flight, so the button
// doesn't just invite duplicate submissions.
app.get('/api/facilitator-request/mine', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const request = db.getLatestFacilitatorRequestForUser(req.user.id);
    res.json({ request: request || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Single place all five actions live, so the single-row and bulk endpoints
// below can never drift apart from each other.
async function actOnFacilitatorRequest(id, action) {
  const request = db.getFacilitatorRequestById(id);
  if (!request) throw new Error('Request not found.');
  if (action === 'approve') {
    if (!request.user_id) throw new Error(`${request.name} isn't currently a member — they need to join first before this can be approved.`);
    db.setMemberTier(request.user_id, 3, null, null, null, null);
    db.setFacilitatorRequestStatus(id, 'approved');
    await emailFacilitatorRequestApproved(request);
  } else if (action === 'decline') {
    db.setFacilitatorRequestStatus(id, 'declined');
    await emailFacilitatorRequestDeclined(request);
  } else if (action === 'defer') {
    db.setFacilitatorRequestStatus(id, 'deferred');
    await emailFacilitatorRequestDeferred(request);
  } else if (action === 'archive') {
    db.setFacilitatorRequestStatus(id, 'archived');
  } else if (action === 'delete') {
    db.deleteFacilitatorRequest(id);
  } else {
    throw new Error('Unknown action: ' + action);
  }
}

app.get('/api/admin/facilitator-requests', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getFacilitatorRequests(req.query.status || null)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Bulk action — same five actions, applied to a list of ids. Partial failure
// (e.g. one selected request isn't a member yet and can't be approved)
// doesn't abort the rest; failures are reported back individually.
// MUST be registered before the /:id route below — otherwise Express matches
// the literal path segment "bulk" as if it were an :id parameter, and this
// route never gets hit at all. (Caught this exact bug in testing.)
app.patch('/api/admin/facilitator-requests/bulk', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { ids, action } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No requests selected.' });
    const results = { succeeded: 0, failed: [] };
    for (const id of ids) {
      try { await actOnFacilitatorRequest(id, action); results.succeeded++; }
      catch(e) { results.failed.push({ id, error: e.message }); }
    }
    res.json({ ok: true, ...results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Single-row ("line") action.
app.patch('/api/admin/facilitator-requests/:id', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    await actOnFacilitatorRequest(req.params.id, req.body.action);
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/admin/facilitator-requests/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteFacilitatorRequest(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Client edit / delete ──
const CLIENT_FRAMEWORKS = ['mbct','mbsr','mindfulness_for_life','yoga','micro_moves','cbt','emdr','felt_fibre_full'];
const CLIENT_PRESENTATIONS = ['adhd','audhd','autism','trauma','fibromyalgia','chronic_fatigue','inflammatory_focus'];
app.patch('/api/clients/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const { name, email, facilitator_id, framework, presentation_flags } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required.' });
  db.updateClientDetails(req.params.id, name.trim(), email?.trim()||null, facilitator_id||null);
  if (framework !== undefined || presentation_flags !== undefined) {
    if (framework !== undefined && framework && !CLIENT_FRAMEWORKS.includes(framework)) {
      return res.status(400).json({ error: 'Not a recognised framework.' });
    }
    // Comma-separated, each piece checked individually — never trust the
    // combined string as-is, in case something unexpected got appended.
    const flagsList = (presentation_flags || '').split(',').map(f => f.trim()).filter(Boolean);
    if (flagsList.some(f => !CLIENT_PRESENTATIONS.includes(f))) {
      return res.status(400).json({ error: 'Not a recognised presentation flag.' });
    }
    db.updateClientClinicalContext(req.params.id, framework || 'felt_fibre_full', flagsList.join(',') || null);
  }
  res.json({ ok: true });
});
app.delete('/api/clients/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteClient(req.params.id);
  res.json({ ok: true });
});

// ── Invitation flow ──
// Send invitation — facilitator invites a user by email
app.post('/api/invitations', auth.requireAuthApi(['facilitator','admin']), async (req, res) => {
  try {
    const { email, skinSlug } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required.' });
    if (skinSlug && !db.getSkin(skinSlug)) return res.status(400).json({ error: 'Unknown skin.' });

    const fac      = db.getFacilitatorById(req.user.id);
    if (!fac) return res.status(404).json({ error: 'Facilitator not found.' });

    const emailLower = email.toLowerCase().trim();
    const token      = crypto.randomBytes(32).toString('hex');
    const id         = uuidv4();
    const expiresAt  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    db.createInvitation(id, token, req.user.id, emailLower, expiresAt, skinSlug || null);

    const inviteUrl = `${APP_URL}/invite/${token}`;
    const existing  = db.getUserByEmail(emailLower);
    const isKnown   = !!existing;

    await sendEmail(emailLower,
      `${fac.name} has invited you to ${brand().name}`,
      `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
        <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${brand().name}</div>
        <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:16px">You've been invited</h1>
        <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">
          ${fac.name} has invited you to work together on ${brand().name} — a body-based practice companion.
        </p>
        <a href="${inviteUrl}" style="display:inline-block;padding:14px 28px;background:#2d6a4f;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;letter-spacing:0.05em">
          ${isKnown ? 'Accept invitation' : 'Create your account'}
        </a>
        <p style="font-size:13px;color:#888;margin-top:24px;line-height:1.6">
          This invitation expires in 7 days. If you didn't expect this, you can ignore it.
        </p>
        <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
        <div style="font-size:12px;color:#aaa">${brand().name}</div>
      </div>`
    );

    res.json({ ok: true, isKnown });
  } catch(e) {
    console.error('invitation error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Accept invitation — handles the /invite/:token link
app.get('/invite/:token', async (req, res) => {
  try {
    const inv = db.getInvitationByToken(req.params.token);
    if (!inv) return res.redirect('/login?error=invalid_invite');
    if (inv.accepted_at) return res.redirect('/client/?notice=already_accepted');
    if (new Date(inv.expires_at) < new Date()) return res.redirect('/login?error=expired_invite');

    // Check if user is already registered
    const existing = db.getUserByEmail(inv.email);
    if (existing) {
      // Link them to facilitator and mark as client
      db.markAsClient(existing.id, inv.facilitator_id);
      db.acceptInvitation(inv.token, new Date().toISOString());
      // Log them in as client
      const token = auth.createToken({ role: 'client', id: existing.id, name: existing.name, email: existing.email });
      res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
      try { db.logLogin(existing.id, 'client', 'facilitator_invite_accept'); } catch(e) { console.error('[login_log] failed:', e.message); }
      return res.redirect('/client/?notice=invitation_accepted');
    }

    // Not registered — redirect to register page with token
    res.redirect(`/register?invite=${req.params.token}&email=${encodeURIComponent(inv.email)}`);
  } catch(e) {
    console.error('invite accept error:', e);
    res.redirect('/login?error=invite_error');
  }
});

// ── Guest lead convert to registered ──
app.post('/api/admin/guest-leads/:id/convert', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const lead = db.getGuestLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    if (!lead.email) return res.status(400).json({ error: 'Lead has no email.' });
    // Check not already registered
    const existing = db.getUserByEmail(lead.email);
    if (existing) { db.deleteGuestLead(req.params.id); return res.json({ ok: true, note: 'Already registered.' }); }
    const tempPassword = Math.random().toString(36).slice(2,10) + Math.random().toString(36).slice(2,4).toUpperCase();
    const hash = await auth.hashPassword(tempPassword);
    const id   = uuidv4();
    db.registerUser(id, lead.name || 'Guest', lead.email, hash);
    emailWelcomeClient(lead.name || 'Guest', lead.email, tempPassword);
    db.deleteGuestLead(req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Client content endpoints ──
app.get('/api/client/content', auth.requireAuthApi(['client','facilitator','admin']), (req, res) => {
  try {
    const userRec = req.user.role === 'client' ? db.getUser(req.user.id) : null;
    const userFlags = db.userFlagsFromRecord(userRec, req.user.role);
    // Facilitators/admins previewing content should see everything regardless of tier.
    // Per Bot 16 — a logged-in Explorer/Member now sees locked-but-visible content
    // too, same as the guest content endpoint already did: everything is listed,
    // tagged with `accessible`, and the frontend renders a lock + upgrade prompt
    // for anything a person's tier doesn't reach yet, rather than hiding it. The
    // actual gate that matters is still enforced server-side at
    // /api/content/library/:id/playback-url regardless of what this list says,
    // so this is a presentation change only — nothing becomes newly accessible.
    // Per Bot 15 — a real client also never sees a preview edition once their own tier
    // already qualifies for its linked full edition (suppressAccessiblePreviews); admin/
    // facilitator keep seeing both, deliberately, since they're managing the content.
    const files = req.user.role === 'facilitator' || req.user.role === 'admin'
      ? db.getAllLibraryFilesWithAccess(userFlags, req.user.id)
      : db.suppressAccessiblePreviews(db.getAllLibraryFilesWithAccess(userFlags, req.user.id), db.userMaxLevel(userFlags));
    const favIds = new Set(db.getFavourites(req.user.id).map(f => f.id));
    let result = files.map(f => ({ ...f, tags: db.getFileTags(f.id), is_favourite: favIds.has(f.id) }));

    // Per Bot 22 — a file shared directly with this specific person (see
    // content_shares) is visible to them regardless of their own tier —
    // sharing a practice is person-level, not subscription-level, so it
    // bypasses the tier gating above rather than being filtered by it.
    // Merged in here so every existing consumer of this one endpoint
    // (Practices, Meditations, Read & watch) sees it without each
    // needing its own separate fetch, and marked shared_to_me on any
    // match — including files that were already present above — so the
    // client UI knows to offer a "remove from My Practices" action for
    // it specifically (different underlying call than un-favouriting).
    if (req.user.role === 'client') {
      const sharedIds = new Set(db.getSharedFilesForUser(req.user.id).map(f => f.id));
      result = result.map(f => sharedIds.has(f.id) ? { ...f, shared_to_me: true, accessible: true, locked: false } : f);
      const presentIds = new Set(result.map(f => f.id));
      const missing = db.getSharedFilesForUser(req.user.id).filter(f => !presentIds.has(f.id));
      result = result.concat(missing.map(f => ({ ...f, tags: db.getFileTags(f.id), is_favourite: favIds.has(f.id), accessible: true, shared_to_me: true })));
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Per Bot 22 — share one or more library files with one or more specific
// people, independent of tier and independent of facilitator assignment.
// Person-level, not subscription-level — see the content_shares table.
// Reuses /api/admin/users as the picker's own data source rather than a
// bespoke search endpoint, since that already returns every tier
// (Newsletter only through Member 3) in one call.
app.post('/api/admin/library-files/share', auth.requireAuthApi(['admin']), (req, res) => {
  const fileIds = Array.isArray(req.body.fileIds) ? req.body.fileIds : [];
  const userIds = Array.isArray(req.body.userIds) ? req.body.userIds : [];
  if (!fileIds.length) return res.status(400).json({ error: 'Select at least one file.' });
  if (!userIds.length) return res.status(400).json({ error: 'Select at least one person.' });
  fileIds.forEach(fileId => db.shareContentToUsers(fileId, userIds, 'admin', req.user.id, uuidv4));
  res.json({ ok: true, shared: fileIds.length * userIds.length });
});

// Favourites
// Per Bot 24 — was only ever used internally to tag other lists with
// is_favourite, never exposed as its own list. Now backs the "My
// Poems" redesign of the You→Poems tab (was showing the MOTD archive,
// mislabelled as Poems the whole time).
app.get('/api/client/favourites', auth.requireAuthApi(['client']), (req, res) => {
  try { res.json(db.getFavourites(req.user.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/client/favourites/:fileId', auth.requireAuthApi(['client']), (req, res) => {
  db.addFavourite(uuidv4(), req.user.id, req.params.fileId);
  res.json({ ok: true });
});
app.delete('/api/client/favourites/:fileId', auth.requireAuthApi(['client']), (req, res) => {
  db.removeFavourite(req.user.id, req.params.fileId);
  res.json({ ok: true });
});

// ── Offline marks (Per Bot 51) ── Mirrors favourites above exactly —
// same tick-a-file-and-it's-marked model, not a separate download
// manager. Marking triggers actual caching client-side (see
// client/index.html's toggleOfflineMark) — this route just records the
// intent; it doesn't itself touch R2 or a Service Worker, since a
// server request has no access to a browser's Cache Storage at all.
app.post('/api/client/offline-marks/:fileId', auth.requireAuthApi(['client']), (req, res) => {
  db.addOfflineMark(uuidv4(), req.user.id, req.params.fileId);
  res.json({ ok: true });
});
app.delete('/api/client/offline-marks/:fileId', auth.requireAuthApi(['client']), (req, res) => {
  db.removeOfflineMark(req.user.id, req.params.fileId);
  res.json({ ok: true });
});
// Every file this person has marked, each with the manifest of URLs it
// needs cached — one round trip covers everything the Offline Files tab
// needs to render itself AND (on first load / login) re-verify the
// cache is current, rather than the client looping a manifest fetch per
// file itself.
app.get('/api/client/offline-marks', auth.requireAuthApi(['client']), async (req, res) => {
  try {
    const files = db.getOfflineMarkedFiles(req.user.id);
    const withManifests = await Promise.all(files.map(async (f) => {
      try {
        const manifest = await buildOfflineManifest(f);
        return { id: f.id, title: f.title, content_type: f.content_type, file_type: f.file_type, urls: manifest.urls, approxBytes: manifest.approxBytes };
      } catch (e) {
        return { id: f.id, title: f.title, content_type: f.content_type, file_type: f.file_type, urls: [], approxBytes: null, error: e.message };
      }
    }));
    res.json(withManifests);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Bulk removal — deliberately the ONE place any bulk action exists for
// this feature (marking/unmarking elsewhere is always one file, or one
// lesson's worth, at a time). Only unmarks server-side; the client is
// still responsible for telling the Service Worker to actually clear
// the cached bytes, same as any single removal.
app.delete('/api/client/offline-marks', auth.requireAuthApi(['client']), (req, res) => {
  db.clearAllOfflineMarks(req.user.id);
  res.json({ ok: true });
});
// Mark every file currently in a lesson offline in one action — per
// Per's request, a lesson-level "mark whole lesson" is just a
// convenience for marking each of its files individually; nothing about
// a lesson itself gets recorded, so a file added to the lesson later
// simply isn't included until marked (here again, or on its own).
app.post('/api/client/offline-marks/lesson/:lessonId', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const files = db.getFilesForLesson(req.params.lessonId);
    files.forEach(f => db.addOfflineMark(uuidv4(), req.user.id, f.id));
    res.json({ ok: true, marked: files.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per Bot 22 — My Practices removal. Three different underlying sources
// feed that one view (an admin/facilitator share, a facilitator's direct
// single-client assignment, and a facilitator-added practice row), each
// needing its own removal action rather than one generic "remove"
// endpoint — the client only ever sees one "×" button, but what it does
// underneath depends on where the item actually came from. Removing
// never deletes anything for the facilitator/admin's own view — a
// shared file's content_shares row is scoped to this one person, and
// clearing assigned_client_id only ever affected this one person to
// begin with.
app.delete('/api/client/my-practices/shared/:fileId', auth.requireAuthApi(['client']), (req, res) => {
  db.removeContentShare(req.params.fileId, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/client/my-practices/assigned/:fileId', auth.requireAuthApi(['client']), (req, res) => {
  db.unassignFileFromClient(req.params.fileId, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/client/my-practices/practice/:id', auth.requireAuthApi(['client']), (req, res) => {
  db.deleteOwnPractice(req.params.id, req.user.id);
  res.json({ ok: true });
});

// User playlists
app.get('/api/client/playlists', auth.requireAuthApi(['client']), (req, res) => {
  res.json(db.getUserPlaylists(req.user.id));
});
app.post('/api/client/playlists', auth.requireAuthApi(['client']), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required.' });
  const id = uuidv4();
  db.createUserPlaylist(id, req.user.id, name.trim());
  res.json({ id, name: name.trim() });
});
app.patch('/api/client/playlists/:id', auth.requireAuthApi(['client']), (req, res) => {
  const { name } = req.body;
  if (name) db.renameUserPlaylist(req.params.id, name.trim());
  res.json({ ok: true });
});
app.delete('/api/client/playlists/:id', auth.requireAuthApi(['client']), (req, res) => {
  db.deleteUserPlaylist(req.params.id);
  res.json({ ok: true });
});
app.post('/api/client/playlists/:id/items', auth.requireAuthApi(['client']), (req, res) => {
  const { fileId, sortOrder } = req.body;
  db.addToUserPlaylist(uuidv4(), req.params.id, fileId, sortOrder || 0);
  res.json({ ok: true });
});
app.delete('/api/client/playlists/:id/items/:fileId', auth.requireAuthApi(['client']), (req, res) => {
  db.removeFromUserPlaylist(req.params.id, req.params.fileId);
  res.json({ ok: true });
});

// ── History — logs what a client listened to / watched / read ──
// contentType: 'audio' | 'video' | 'document'
app.post('/api/client/history', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const { contentType, contentId } = req.body;
    if (!contentType || !contentId) return res.status(400).json({ error: 'contentType and contentId required.' });
    db.recordPlay(uuidv4(), req.user.id, 'client', contentType, contentId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/client/history', auth.requireAuthApi(['client']), (req, res) => {
  try {
    res.json(db.getContentHistory(req.user.id, 100));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin user management ──
app.patch('/api/admin/users/:id/assign-facilitator', auth.requireAuthApi(['admin']), (req, res) => {
  const { facilitatorId } = req.body;
  const user = db.getUser(req.params.id);
  const wasAlreadyClient = user && user.is_client === 1;
  db.markAsClient(req.params.id, facilitatorId);
  // Per Bot 15e — this used to do nothing but the DB update. Only notify
  // on the actual transition into being a client (not a facilitator
  // reassignment for someone already one, and not if they have no email
  // to send to), naming whichever facilitator they're being assigned to.
  if (user && user.email && !wasAlreadyClient && facilitatorId) {
    const fac = db.getFacilitatorById(facilitatorId);
    if (fac) {
      emailBecameClient(user.name, user.email, fac.name, user.language)
        .catch(e => console.error('became-client email failed for', req.params.id, ':', e.message));
    }
  }
  res.json({ ok: true });
});

// ── Guest lead delete ──
app.delete('/api/admin/guest-leads/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteGuestLead(req.params.id);
  res.json({ ok: true });
});

// ── /api/guest/chat — requires guest identity, same bot, lighter system prompt ──
const guestSessions = new Map();

app.post('/api/guest/chat', auth.requireGuestIdentity(), async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!guestSessions.has(sessionId)) {
      guestSessions.set(sessionId, { history: [], systemPrompt: prompts.CLIENT_SYSTEM_PROMPT + prompts.CLIENT_CRISIS_RESOURCES('en') });
    }
    const session = guestSessions.get(sessionId);
    const isStart = !message || message === 'begin';
    if (!isStart) session.history.push({ role: 'user', content: message });
    const messages = session.history.length ? session.history : [{ role: 'user', content: 'begin' }];
    const reply = await callClaude(session.systemPrompt, messages, 1500);
    session.history.push({ role: 'assistant', content: reply });
    res.json({ reply });
  } catch(e) {
    console.error('guest chat error:', e);
    res.status(500).json({ error: e.message });
  }
});



// Never send password_hash to the browser — getAllUsersAdmin does `SELECT
// u.*`, which includes it. has_login (computed from the same fact) is what
// the frontend actually needs, to tell real accounts apart from passive
// newsletter-only contacts (createMailingListContact — no password at all).
// Per Bot 19j — real counts per level (Newsletter/Explorer/Member 1/2/3),
// for the small counts summary on the People page. A fresh COUNT(*) each
// time, not derived from whatever's currently loaded in the browser.
// Per Bot 19l — every sendEmail() call already logs to email_log
// (pending, then sent/failed) regardless of what happens elsewhere in
// the same request — this exposes that log directly, since it's the one
// record of what actually went out that doesn't depend on whether a
// tier change or anything else in the same request later got lost.
// Per Bot 19m — email_log only ever records 'sent', meaning Scaleway
// *accepted* the request — nothing has ever checked back on what
// actually happened afterward (delivered/bounced/complained). This asks
// Scaleway directly, for real, current status on a sample of recent
// sends — genuinely useful right now given zero newsletter replies ever,
// which could mean healthy-but-quiet delivery, or could mean silent
// bounces this app has never had visibility into either way.
// Per Bot 19o — cross-references every welcome email ever logged against
// the recipient's CURRENT live account state (not just "we sent it"),
// so it's possible to see, definitively, who actually completed their
// move and who's still stuck as newsletter-only despite having been
// emailed — the exact question that's been impossible to answer from
// email_log or the tier counts alone.
app.get('/api/admin/newsletter-migration-status', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const WELCOME_SUBJECTS = [
      'Welcome to the new Deeper Mindfulness experience',
      "Welcome to Deeper Mindfulness — you're in",
      'Welcome to the new app',
    ];
    const allLogs = db.getRecentEmailLog(5000, null)
      .filter(r => WELCOME_SUBJECTS.includes(r.subject));

    // Most recent send per email address — if someone got two attempts,
    // only the latest matters for "did it actually stick."
    const byEmail = new Map();
    for (const row of allLogs) {
      const existing = byEmail.get(row.email);
      if (!existing || row.created_at > existing.created_at) byEmail.set(row.email, row);
    }

    const succeeded = [], pending = [], noLongerExists = [];
    for (const [email, log] of byEmail) {
      const user = db.getUserByEmail(email);
      if (!user) { noLongerExists.push({ email, sent_at: log.created_at }); continue; }
      const row = { id: user.id, email, name: user.name, sent_at: log.created_at, member_tier: user.member_tier, has_password: !!user.password_hash };
      // Per Bot 20 — under the new tier scheme, -1 is the only "still
      // raw" state; 0 (Explorer) or above means the invite genuinely
      // took, whether or not they've clicked to set a password yet.
      if (user.member_tier > -1) succeeded.push(row);
      else pending.push(row);
    }

    res.json({
      totalEmailed: byEmail.size,
      succeededCount: succeeded.length,
      pendingCount: pending.length,
      noLongerExistsCount: noLongerExists.length,
      pending,     // ← this is the retry list
      succeeded,
      noLongerExists,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Per Bot 22 — per-recipient rows for one job from the Email Log report's
// jobs view (see db.getEmailJobs). newsletterId is the precise match when
// present; otherwise kind+subject+the exact first/last timestamps the
// jobs list already returned for that job narrow it back to just that
// batch's own rows.
app.get('/api/admin/email-log/job-rows', auth.requireAuthApi(['admin']), (req, res) => {
  const { kind, subject, from, to, newsletterId } = req.query;
  if (!newsletterId && (!kind || !subject || !from || !to)) {
    return res.status(400).json({ error: 'Missing job parameters.' });
  }
  res.json(db.getEmailJobRows(kind, subject, from, to, newsletterId || null));
});

app.get('/api/admin/email-log/check-status', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const kind = req.query.kind || null;
    const rows = db.getRecentEmailLog(limit, kind).filter(r => r.scaleway_email_id);
    if (!rows.length) return res.json({ note: 'No logged emails with a scaleway_email_id to check — either none match this kind/limit, or Scaleway credentials were missing at send time.', results: [] });
    const results = [];
    for (const row of rows) {
      const status = await scwGetEmailStatus(row.scaleway_email_id);
      results.push({
        email: row.email,
        subject: row.subject,
        sent_at: row.created_at,
        our_status: row.status,
        scaleway_status: status ? status.status : 'lookup failed (id not found, or credentials issue)',
        status_details: status ? status.status_details : null,
        // The actual SMTP response from the recipient's mail server —
        // code 250 is the standard "accepted" response, the most
        // concrete evidence delivery genuinely happened.
        last_smtp_response: status && status.last_tries && status.last_tries.length
          ? status.last_tries[status.last_tries.length - 1]
          : null,
      });
    }
    res.json({ results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/email-log', auth.requireAuthApi(['admin']), (req, res) => {
  const kind = req.query.kind || null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 2000);
  res.json(db.getRecentEmailLog(limit, kind));
});

// Per Bot 21 — the stored HTML body for one email log row, fetched on
// demand from the "View" action rather than bundled into the list above.
// Returns html:null (not a 404) for anything sent before body_html
// existed, or for a genuinely missing id, so the frontend can show one
// consistent "nothing stored for this one" message either way.
app.get('/api/admin/email-log/:id/body', auth.requireAuthApi(['admin']), (req, res) => {
  const row = db.getEmailLogById(req.params.id);
  if (!row) return res.json({ html: null });
  res.json({ id: row.id, email: row.email, subject: row.subject, created_at: row.created_at, status: row.status, html: row.body_html || null });
});

app.get('/api/admin/user-counts', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getUserTierCounts());
});

// Per Bot 22 — "logged in active users" for the People page summary bar.
// Count comes from auth.js's in-memory session tracker (see
// getActiveIdsForRole), not a database query — this is live presence,
// not a historical report (that's what the Logins report is for).
// Status/end-date logic mirrors emailWelcomeClient/emailAdminPasswordReset's
// access-until reasoning: trial_ends_at wins if present (a trial in
// progress), otherwise member_expires_at (paid subscription or manual
// expiry — labelled "Renews" if there's a live Stripe subscription
// behind it, "Paid until" if not), otherwise no end date at all
// (Explorer, or a permanent admin-granted membership).
app.get('/api/admin/active-users', auth.requireAuthApi(['admin']), (req, res) => {
  const ids = auth.getActiveIdsForRole('client');
  const users = ids.map(id => db.getUser(id)).filter(Boolean).map(u => {
    const statusLabel = u.member_tier > 0 ? `Member ${u.member_tier}` : 'Explorer';
    let endLabel = null, endDate = null;
    if (u.trial_ends_at) { endLabel = 'Trial ends'; endDate = u.trial_ends_at; }
    else if (u.member_expires_at) { endLabel = u.stripe_subscription_id ? 'Renews' : 'Paid until'; endDate = u.member_expires_at; }
    return { id: u.id, name: u.name, email: u.email, status: statusLabel, endLabel, endDate };
  });
  users.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ count: users.length, users });
});

// ── Reports hub (Per Bot 20) ──
// A registry, not a bespoke route per report — adding a new report later
// is one db.js function + one entry here, never a new endpoint or a new
// page. Each run() returns { tiles, table, note } (see the db.js report*
// functions for the exact shape); the routes below just look the id up
// and pass the result straight through.
const REPORTS = {
  migrations:         { title: 'Newsletter Migration', category: 'Growth',  run: () => db.reportMigrations() },
  registrations:       { title: 'Registrations',        category: 'Growth',  run: () => db.reportRegistrations() },
  logins:              { title: 'Logins',                category: 'Usage',   run: () => db.reportLogins() },
  membership:          { title: 'Membership',           category: 'Finance', run: () => db.reportMembership() },
  content_engagement:  { title: 'Content Engagement',    category: 'Usage',   run: () => db.reportContentEngagement() },
  talk_usage:          { title: 'Talk to Per Usage',     category: 'Usage',   run: () => db.reportTalkUsage() },
  uploads:             { title: 'Uploads',               category: 'Content', run: () => db.reportUploads() },
  cron_activity:       { title: 'Cron Job Activity',     category: 'System',  run: () => db.reportCronActivity() },
  email_log:           { title: 'Email Log',             category: 'System',  run: () => db.reportEmailLog() },
  generated_images:    { title: 'Generated Images',       category: 'System',  run: () => db.reportGeneratedImages() },
};

app.get('/api/admin/reports', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(Object.entries(REPORTS).map(([id, r]) => ({ id, title: r.title, category: r.category })));
});

app.get('/api/admin/reports/:id', auth.requireAuthApi(['admin']), (req, res) => {
  const report = REPORTS[req.params.id];
  if (!report) return res.status(404).json({ error: 'Unknown report.' });
  try {
    const data = report.run();
    res.json({ id: req.params.id, title: report.title, category: report.category, ...data });
  } catch (e) {
    console.error('[reports]', req.params.id, 'failed:', e.message, e.stack);
    res.status(500).json({ error: 'Could not generate this report: ' + e.message });
  }
});

// ── One-off (Per Bot 20) — reclassify existing member_tier=0/no-password
// rows down to -1 (raw, never invited), so the fixed /upgrade route's
// success-gated tier bump has a clean starting point to move them back up
// from. Safe to run more than once — idempotent, matches nothing the
// second time. Trigger from the browser console, not the Railway console
// tab (see deploy notes) — e.g.:
//   fetch('/api/admin/migrate-newsletter-tier', {method:'POST'}).then(r=>r.json()).then(console.log)
app.post('/api/admin/migrate-newsletter-tier', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const result = db.migrateNewsletterOnlyToRawTier();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('migrate-newsletter-tier error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── One-off backfill (Per Bot 20) — for the ~370 people already emailed
// (one or more times) under the old broken scheme: moves them straight
// to Explorer (or corrects a straggler to Member 1+trial if they already
// logged in) with NO email sent. Only ever looks at emails whose most
// recent welcome/invite send genuinely succeeded (status='sent'), never
// a failed one. Trigger from the browser console, logged in as admin:
//   fetch('/api/admin/backfill-newsletter-migration', {method:'POST'}).then(r=>r.json()).then(console.log)
app.post('/api/admin/backfill-newsletter-migration', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const WELCOME_SUBJECTS = [
      'Welcome to the new Deeper Mindfulness experience',
      "Welcome to Deeper Mindfulness — you're in",
      'Welcome to the new app',
    ];
    const sentLogs = db.getRecentEmailLog(5000, null)
      .filter(r => WELCOME_SUBJECTS.includes(r.subject) && r.status === 'sent');
    const emails = [...new Set(sentLogs.map(r => r.email))];
    const result = db.backfillNewsletterMigrationFromLog(emails);
    res.json({ ok: true, consideredEmails: emails.length, ...result });
  } catch (e) {
    console.error('backfill-newsletter-migration error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/users', auth.requireAuthApi(['admin']), (req, res) => {
  const users = db.getAllUsersAdmin(false).map(u => {
    const { password_hash, ...safe } = u;
    return { ...safe, has_login: !!password_hash };
  });
  res.json(users);
});

// ── /api/admin/users/:id/upgrade — set tier, activating a login if needed ──
// A newsletter-only contact (createMailingListContact) has no password at
// all — "moving them up" to Explorer or Member N isn't just a tier change
// for them, it's the moment they actually become a real account. This
// generates a password the same way Add Member / Bulk Import do whenever
// the target has none yet, sends the same welcome email, and simply
// changes tier for anyone who already had a real account (unchanged
// behaviour from before).
app.patch('/api/admin/users/:id/upgrade', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { level, tier, sendWelcomeEmail, trialDays } = req.body;
    console.log(`[upgrade] ${req.params.id} — received tier=${tier} level=${level} trialDays=${trialDays}`);
    // Per Bot 15l — level='registered' (the dropdown's actual value for
    // "Explorer (free)") isn't 'member' and isn't a parseable integer, so
    // this used to fall through to parseInt(level)||1 — NaN||1 is 1, so
    // choosing Explorer here silently set Member tier instead, every
    // time. That's exactly why a "downgrade to Explorer" never seemed to
    // take: the request went through, it just set the wrong tier.
    const memberTier = tier != null ? parseInt(tier)
      : level === 'member'     ? 1
      : level === 'registered' ? 0
      : parseInt(level) || 1;

    const user = db.getUser(req.params.id);
    if (!user) { console.log(`[upgrade] ${req.params.id} — NOT FOUND`); return res.status(404).json({ error: 'User not found.' }); }
    console.log(`[upgrade] ${req.params.id} (${user.email}) — before: member_tier=${user.member_tier} has_password=${!!user.password_hash}`);

    // Per Bot 20 — member_tier=-1 is a raw mailing-list import, never
    // invited (see NEWSLETTER_AUDIENCE_CLAUSES in db.js). This is the one
    // and only signal now; password_hash is no longer part of the
    // definition, since a genuinely-invited Explorer may still have no
    // password until they click their own link.
    const wasNewsletterOnly = user.member_tier === -1;
    console.log(`[upgrade] ${req.params.id} — wasNewsletterOnly=${wasNewsletterOnly}, target memberTier=${memberTier}`);

    // Per Bot 19i — moving someone directly to a paid tier (bypassing the
    // Explorer self-service claim, which is what normally grants a
    // trial_ends_at) previously left both expiry columns null —
    // permanent, open-ended access with nothing to expire. If the caller
    // passes trialDays, this sets trial_ends_at that many days out — the
    // same column the self-service claim route already uses, so the
    // existing daily expiry check treats it identically either way. 0,
    // omitted, or not a real number means genuinely permanent — an
    // explicit choice rather than an accidental default.
    let trialEndsAt = null;
    if (memberTier >= 1 && trialDays !== undefined) {
      const days = parseInt(trialDays, 10);
      if (Number.isFinite(days) && days > 0) {
        trialEndsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      }
    }

    if (wasNewsletterOnly) {
      // Per Bot 20 — this is the core fix for the migration that wouldn't
      // persist. Never email a temp password (Per's explicit call: no
      // password to find in an email, nothing to remember — they just
      // click their personal link, which auto-fills their email on the
      // sign-in page, and set whatever password they like themselves).
      // Because of that, the ONLY observable state change for this
      // person is the tier itself — so that write now happens only
      // after the invite email has genuinely sent (checked against
      // Scaleway's real response, not just "no exception was thrown").
      // Previously the tier changed unconditionally and immediately,
      // which for a tier-0-to-tier-0 "move to Explorer" was a pure
      // no-op regardless of whether the email sent — success in the UI
      // meant nothing had actually happened.
      let sendResult = { ok: true };
      if (sendWelcomeEmail !== false) {
        sendResult = await emailWelcomeFromNewsletter(user);
      }
      if (!sendResult || sendResult.ok !== true) {
        console.error(`[upgrade] ${req.params.id} — invite email failed to send, tier NOT changed:`, sendResult && sendResult.error);
        return res.status(502).json({ error: 'Invite email failed to send — tier was not changed, safe to retry. ' + (sendResult && sendResult.error || '') });
      }
      try {
        db.setMemberTier(req.params.id, memberTier, null, trialEndsAt, null, null);
      } catch (dbErr) {
        console.error(`[upgrade] ${req.params.id} — setMemberTier THREW:`, dbErr.message, dbErr.stack);
        return res.status(500).json({ error: 'Email sent, but could not save the tier change: ' + dbErr.message });
      }
      const after = db.getUser(req.params.id);
      console.log(`[upgrade] ${req.params.id} — after: member_tier=${after.member_tier} (expected ${memberTier})`);
      if (after.member_tier !== memberTier) {
        console.error(`[upgrade] ${req.params.id} — MISMATCH: tier did not actually change after setMemberTier ran`);
      }
      return res.json({ ok: true, activated: true, welcomeEmailSent: sendWelcomeEmail !== false });
    }

    // Not a newsletter-only contact — unchanged behaviour: tier changes
    // immediately, and a temp password is generated (and emailed) only
    // if this account has no login of its own yet.
    let tempPassword = null;
    if (!user.password_hash) {
      tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
      const passwordHash = await auth.hashPassword(tempPassword);
      db.updateClientPassword(req.params.id, passwordHash);
    }

    try {
      db.setMemberTier(req.params.id, memberTier, null, trialEndsAt, null, null);
    } catch (dbErr) {
      console.error(`[upgrade] ${req.params.id} — setMemberTier THREW:`, dbErr.message, dbErr.stack);
      return res.status(500).json({ error: 'Could not save tier change: ' + dbErr.message });
    }
    const after = db.getUser(req.params.id);
    console.log(`[upgrade] ${req.params.id} — after: member_tier=${after.member_tier} (expected ${memberTier})`);
    if (after.member_tier !== memberTier) {
      console.error(`[upgrade] ${req.params.id} — MISMATCH: tier did not actually change after setMemberTier ran`);
    }

    let welcomeEmailSent = false;
    if (tempPassword && sendWelcomeEmail !== false) {
      emailWelcomeClient(user.name, user.email, tempPassword, null, null, trialEndsAt);
      welcomeEmailSent = true;
    }

    res.json({ ok: true, activated: !!tempPassword, welcomeEmailSent });
  } catch (e) {
    console.error('upgrade error:', e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ── /api/admin/users/:id/expiry — manual membership expiry override ──
// For honouring existing WordPress subscribers: set their expiry date by hand
// to match their current subscription, without altering tier or trial state.
// expiresAt: 'YYYY-MM-DD' or null to clear (treat as non-expiring).
app.patch('/api/admin/users/:id/expiry', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { expiresAt } = req.body;
    if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
      return res.status(400).json({ error: 'expiresAt must be YYYY-MM-DD or null.' });
    }
    db.setMemberExpiry(req.params.id, expiresAt || null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── /api/voices — list of voices for the My Account picker ──
// Public (no login needed to browse/preview on the setup page, same as
// /api/speak already is). Never exposes the ElevenLabs API key itself.
app.get('/api/voices', async (req, res) => {
  try {
    const voices = await fetchElevenLabsVoices();
    // Flags whichever real voice matches the current VOICE_ID env var, so
    // the frontend doesn't need a separate synthetic "Default" row — the
    // default is one of these real entries (ElevenLabs's own /v1/voices
    // response includes their default/premade voices alongside anything
    // added or cloned), with its own name and real preview_url.
    res.json(voices.map(v => ({ ...v, is_default: v.voice_id === VOICE_ID })));
  } catch (e) {
    console.error('voices fetch error:', e.message);
    res.status(500).json({ error: 'Could not load voices right now.' });
  }
});

// ── /api/speak — ElevenLabs, piped directly (Mare Bot architecture) ──
app.post('/api/speak', async (req, res) => { // public — used by guest and client
  try {
    const { text, voice_id } = req.body;
    if (!text) return res.status(400).json({ error: 'No text' });

    // Resolve which voice to actually use. Priority:
    //  1. An explicit voice_id on the request — used by the account-page
    //     "try this voice" preview, and by a logged-in client's own Talk
    //     session once they've picked something in My Account (the client
    //     sends their saved choice with each request rather than the
    //     server re-querying the DB on every single TTS call).
    //  2. Otherwise, if a login cookie is present, the user's saved
    //     voice_id from the DB.
    //  3. Otherwise the global default (VOICE_ID env var — Per's voice).
    // Either way, an explicit voice_id is ALWAYS checked against the real
    // ElevenLabs voice list first — never pass an untrusted request value
    // straight through to the ElevenLabs API.
    let resolvedVoiceId = VOICE_ID;
    if (voice_id) {
      try {
        const voices = await fetchElevenLabsVoices();
        if (voices.some(v => v.voice_id === voice_id)) resolvedVoiceId = voice_id;
      } catch (e) { /* voice list unavailable — fall back to default below */ }
    } else {
      const token   = req.cookies?.[auth.COOKIE_NAME];
      const payload = token ? auth.verifyToken(token) : null;
      if (payload && payload.role === 'client') {
        const user = db.getUser(payload.id);
        if (user?.voice_id) resolvedVoiceId = user.voice_id;
      }
    }

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${resolvedVoiceId}?output_format=mp3_44100_192`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY, 'Connection': 'close' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.65, similarity_boost: 0.80, speed: VOICE_SPEED }
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: err });
    }
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-cache');
    response.body.pipe(res);
  } catch(e) {
    console.error('speak error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Cached TTS for fixed scripts (Per Bot 14) ── The three quick-practice
// buttons on the calm landing (Calm the body/mind/breath) speak a fixed
// script, not a live AI reply — no reason to regenerate the same audio
// from ElevenLabs on every single tap. First request for a given
// cacheKey generates and stores it in R2; every request after that just
// returns a presigned URL to the same file. Always Per's default voice
// (VOICE_ID), deliberately — these are meant to sound identical every
// time, like a real recording, not per-user-voice conversation replies.
app.post('/api/speak-cached', async (req, res) => {
  try {
    const { cacheKey, text } = req.body;
    if (!cacheKey || !text) return res.status(400).json({ error: 'cacheKey and text are required.' });
    if (!media.isConfigured()) return res.status(500).json({ error: 'R2 is not configured.' });

    let entry = db.getTtsCacheEntry(cacheKey);
    if (!entry) {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_192`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY, 'Connection': 'close' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.65, similarity_boost: 0.80, speed: VOICE_SPEED }
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        const err = await response.text();
        return res.status(500).json({ error: err });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const r2Key = `tts-cache/${cacheKey}.mp3`;
      await media.putObject(r2Key, buffer, 'audio/mpeg');
      db.setTtsCacheEntry(cacheKey, r2Key);
      entry = { cache_key: cacheKey, r2_key: r2Key };
    }
    const url = await media.getPlaybackUrl(entry.r2_key);
    res.json({ url });
  } catch (e) {
    console.error('speak-cached error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── /listen — Deepgram STT proxy (Mare Bot architecture) ──
const listenWss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

listenWss.on('connection', (clientWs) => {
  const dgWs = new WebSocket(
    'wss://api.deepgram.com/v1/listen?model=nova-2&language=multi&encoding=linear16&sample_rate=16000&channels=1&smart_format=true&endpointing=400&utterance_end_ms=3200&interim_results=true',
    { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
  );
  dgWs.on('open',    () => console.log('Deepgram connected'));
  dgWs.on('unexpected-response', (req, res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => console.error(`[listen] deepgram rejected connection — status=${res.statusCode} body=${body}`));
  });
  dgWs.on('message', (data) => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(typeof data === 'string' ? data : data.toString('utf8')); });
  dgWs.on('error',   (e) => console.error('Deepgram error:', e.message));
  dgWs.on('close',   () => console.log('Deepgram closed'));
  clientWs.on('message', (audioData) => { if (dgWs.readyState === WebSocket.OPEN) dgWs.send(audioData); });
  clientWs.on('close',   () => { if (dgWs.readyState === WebSocket.OPEN) dgWs.close(); });
});

// ── Facilitator clinical co-pilot — live WebSocket conversation during a session ──
// Connects at root path with ?type=facilitator&client=CLIENT_ID
// This is NOT a bridge to the client's own conversation — the client and facilitator
// are meeting separately (Zoom/Teams/in person). This is the facilitator's own private
// supervision-style conversation with Per Bot, running alongside that meeting.
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

const facilitatorWss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

// ── /call — WebRTC signaling relay for 1:1 video/audio calls (Per Bot 12) ──
// This socket carries NO media itself — media flows directly between the
// two browsers (or via the TURN relay) once connected. All this does is
// forward the SDP offer/answer and ICE candidates each side generates,
// verbatim, to the other participant in the same call — the same "dumb
// relay" role a signaling channel always plays in WebRTC. Each callId
// gets at most one facilitator socket and one client socket; whichever
// arrives is stored, and a message from either is forwarded to the other
// if it's currently connected (if not yet connected, the message is just
// dropped — the sender's own retry/renegotiation logic handles that, same
// as any WebRTC app).
const callRooms = new Map(); // callId -> { facilitator: ws|null, client: ws|null }
function getCallRoom(callId) {
  if (!callRooms.has(callId)) callRooms.set(callId, { facilitator: null, client: null });
  return callRooms.get(callId);
}
function cleanupCallRoom(callId) {
  const room = callRooms.get(callId);
  if (room && !room.facilitator && !room.client) callRooms.delete(callId);
}
const callWss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
callWss.on('connection', (ws, ctx) => {
  const { callId, role } = ctx;
  const room = getCallRoom(callId);
  room[role] = ws;
  console.log(`[call] ${role} joined room ${callId}`);

  ws.on('message', (raw) => {
    const other = room[role === 'facilitator' ? 'client' : 'facilitator'];
    if (other && other.readyState === WebSocket.OPEN) other.send(raw.toString());
  });
  ws.on('close', () => {
    room[role] = null;
    cleanupCallRoom(callId);
    const other = room[role === 'facilitator' ? 'client' : 'facilitator'];
    if (other && other.readyState === WebSocket.OPEN) other.send(JSON.stringify({ type: 'peer-left' }));
  });
  ws.on('error', (e) => console.error(`[call] ws error (${role}, room ${callId}):`, e.message));
});

// ── Single consolidated upgrade router (Per Bot 9) ──
// Every WebSocket path in the app funnels through here now, dispatched
// explicitly by pathname to exactly one server's handleUpgrade(). Multiple
// {server, path}-bound WebSocket.Server instances used to each attach
// their own 'upgrade' listener to this same shared http.Server, and Node
// fires every one of them on every upgrade request regardless of path —
// see the fuller explanation on tomteWss above. This single dispatcher
// replaced all of that.
server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/tomte') {
    tomteWss.handleUpgrade(req, socket, head, (ws) => tomteWss.emit('connection', ws, req));
    return;
  }

  if (pathname === '/listen') {
    listenWss.handleUpgrade(req, socket, head, (ws) => listenWss.emit('connection', ws, req));
    return;
  }

  if (pathname === '/call') {
    const callId = searchParams.get('callId');
    const call = callId ? db.getCall(callId) : null;
    if (!call) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
    const cookies = parseCookies(req.headers.cookie);
    const payload = auth.verifyToken(cookies[auth.COOKIE_NAME]);
    if (!payload) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    let role;
    if (payload.id === call.facilitator_id) role = 'facilitator';
    else if (payload.id === call.client_id) role = 'client';
    else { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    // 'ringing' is allowed too — the caller connects and waits before the
    // other side has answered yet, same as a phone ringing before pickup.
    if (!['ringing', 'active'].includes(call.status)) {
      socket.write('HTTP/1.1 410 Gone\r\n\r\n'); socket.destroy(); return;
    }
    callWss.handleUpgrade(req, socket, head, (ws) => callWss.emit('connection', ws, { callId, role }));
    return;
  }

  if (pathname !== '/' || searchParams.get('type') !== 'facilitator') {
    // Not a WebSocket path this app knows about at all.
    socket.destroy();
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const payload = auth.verifyToken(cookies[auth.COOKIE_NAME]);
  if (!payload || !['facilitator', 'admin'].includes(payload.role)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Per's request — a second connection shape, alongside the existing
  // ?client=CLIENT_ID one above: ?instance=INSTANCE_ID(&session=SESSION_ID),
  // for live teaching-mode support rather than 1:1 client work. Ownership
  // checked the same way every other facilitator-scoped instance route
  // does (isFacilitatorAssignedToInstance, admin bypasses) — a facilitator
  // can only open this for a course they're actually assigned to.
  const instanceId = searchParams.get('instance');
  if (instanceId) {
    const instance = db.getCourseInstance(instanceId);
    if (!instance) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
    if (payload.role !== 'admin' && !db.isFacilitatorAssignedToInstance(payload.id, instanceId)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }
    const course = db.getCourse(instance.course_id);
    const sessionId = searchParams.get('session');
    const teachingSession = sessionId ? db.getInstanceSession(sessionId) : null;
    facilitatorWss.handleUpgrade(req, socket, head, (ws) => {
      facilitatorWss.emit('connection', ws, { facilitatorId: payload.id, facilitatorName: payload.name, teaching: { course, instance, session: teachingSession } });
    });
    return;
  }

  const clientId = searchParams.get('client');
  const client = clientId ? db.getUser(clientId) : null;
  if (!client) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  facilitatorWss.handleUpgrade(req, socket, head, (ws) => {
    facilitatorWss.emit('connection', ws, { facilitatorId: payload.id, facilitatorName: payload.name, client });
  });
});

facilitatorWss.on('connection', (ws, ctx) => {
  const { facilitatorId, client, teaching } = ctx;
  let fogLevel = 12;
  let history = []; // { role: 'user'|'assistant', content: string } — this facilitator's own conversation, not the client's

  // Deepgram connection for this facilitator's voice input — opened lazily on start_listening
  let dgWs = null;
  // Per Bot 9 fix — same reasoning as Tomte's bridge: buffer chunks that
  // arrive before dgWs is OPEN (especially the crucial first, header-
  // bearing WebM chunk) instead of silently dropping them.
  let pendingAudioChunks = [];
  // Per Bot 9: same fix as Tomte's bridge — track the latest interim
  // transcript so a manual stop (rather than a natural pause) doesn't
  // silently discard whatever's been said so far.
  let lastTranscript = '';

  function send(obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  async function respond(userText, { explain = false } = {}) {
    try {
      // Per's request — teaching mode uses a different system prompt
      // (FACILITATOR_TEACHING_SYSTEM_PROMPT), reusing the exact same
      // fogLevel plain/clinical/technical toggle rather than building a
      // second one — it's already exactly the "simple plain language vs
      // detailed academic" switch he asked for, just needed pointing at
      // a new prompt.
      const systemPrompt = teaching
        ? prompts.FACILITATOR_TEACHING_SYSTEM_PROMPT(fogLevel, teaching.course?.title, teaching.session?.title, teaching.session?.facilitator_notes)
        : prompts.FACILITATOR_SYSTEM_PROMPT(fogLevel);
      const promptText = explain
        ? `Explain to me: ${userText || 'what is happening clinically right now, based on what I have described so far.'}`
        : userText;
      history.push({ role: 'user', content: promptText });
      const reply = await callClaude(systemPrompt, history, 1500);
      history.push({ role: 'assistant', content: reply });
      send({ type: explain ? 'explanation' : 'response_text', text: reply });

      // Voice playback for the facilitator, same TTS pipeline as the client uses
      try {
        const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_192`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY, 'Connection': 'close' },
          body: JSON.stringify({
            text: reply,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.65, similarity_boost: 0.80, speed: VOICE_SPEED }
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (ttsRes.ok) {
          const buf = await ttsRes.buffer();
          send({ type: 'audio', data: buf.toString('base64') });
        }
      } catch (e) { console.error('facilitator tts error:', e.message); }
    } catch (e) {
      console.error('facilitator respond error:', e.message);
      send({ type: 'response_text', text: 'Something went wrong generating that response. Please try again.' });
    }
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'set_fog':
        fogLevel = msg.level || 12;
        break;

      case 'text_input':
        await respond(msg.text, { explain: false });
        break;

      case 'explain':
        await respond('', { explain: true });
        break;

      case 'start_listening': {
        send({ type: 'listening_started' });
        pendingAudioChunks = [];
        dgWs = new WebSocket(
          // Per Bot 9 fix: same as Tomte's bridge — this is WebM (from
          // MediaRecorder), a containerized format. Explicit encoding params
          // were making Deepgram treat it as raw, headerless Opus instead,
          // which it silently couldn't reconcile — accepted every chunk,
          // never returned a transcript. Let it auto-detect the container.
          // Per Bot 32 — utterance_end_ms raised from 1200 to 3200: people
          // were getting cut off mid-thought during a natural pause,
          // before they'd actually finished what they wanted to say.
          // Raised uniformly across all three Deepgram connections in
          // this file (Tomte's own bridge and the /listen proxy too) for
          // consistent behavior, since the same premature-cutoff problem
          // would apply equally to any of them.
          'wss://api.deepgram.com/v1/listen?model=nova-2&language=multi&smart_format=true&endpointing=400&utterance_end_ms=3200&interim_results=true',
          { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
        );
        dgWs.on('open', () => {
          if (pendingAudioChunks.length) {
            pendingAudioChunks.forEach(buf => dgWs.send(buf));
            pendingAudioChunks = [];
          }
        });
        dgWs.on('unexpected-response', (req, res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => console.error(`[facilitator] deepgram rejected connection — status=${res.statusCode} body=${body}`));
        });
        dgWs.on('message', async (data) => {
          try {
            const parsed = JSON.parse(data.toString('utf8'));
            const transcript = parsed?.channel?.alternatives?.[0]?.transcript;
            if (transcript && transcript.trim()) lastTranscript = transcript.trim();
            if (transcript && transcript.trim() && parsed.speech_final) {
              lastTranscript = '';
              send({ type: 'final_transcript', text: transcript });
              await respond(transcript, { explain: false });
            }
          } catch { /* non-JSON or partial frame — ignore */ }
        });
        dgWs.on('error', (e) => console.error('facilitator deepgram error:', e.message));
        break;
      }

      case 'audio_chunk':
        if (msg.data) {
          const buf = Buffer.from(msg.data, 'base64');
          if (dgWs && dgWs.readyState === WebSocket.OPEN) {
            dgWs.send(buf);
          } else if (dgWs && dgWs.readyState === WebSocket.CONNECTING) {
            pendingAudioChunks.push(buf);
          }
        }
        break;

      case 'stop_listening':
        send({ type: 'listening_stopped' });
        if (dgWs) { try { dgWs.close(); } catch {} dgWs = null; }
        if (lastTranscript) {
          const t = lastTranscript;
          lastTranscript = '';
          send({ type: 'final_transcript', text: t });
          await respond(t, { explain: false });
        }
        break;

      case 'update_arc':
        if (msg.arc != null) {
          db.updateArc(client.id, msg.arc);
          send({ type: 'arc_updated' });
        }
        break;

      case 'end_session': {
        try {
          const transcript = history
            .filter(h => h.role === 'user')
            .map(h => h.content)
            .join('\n\n');

          if (!transcript.trim()) {
            send({ type: 'session_summary', summary: 'No notes were recorded during this session.', clientSummary: '', arcUpdate: null });
            break;
          }

          const clinicalSummary = await callClaude(
            'You are generating a clinical session summary. Be precise and factual.',
            [{ role: 'user', content: prompts.GENERATE_SESSION_SUMMARY(transcript, client.arc, 'facilitator') }],
            1000
          );

          const clientSummary = await callClaude(
            'You are rewriting a clinical summary into a short, warm note for the client to read themselves.',
            [{ role: 'user', content: prompts.GENERATE_CLIENT_SUMMARY(clinicalSummary) }],
            1000
          );

          const arcUpdate = await callClaude(
            'You are updating a clinical arc/development plan based on session notes.',
            [{ role: 'user', content: prompts.GENERATE_ARC_UPDATE(client.arc, clinicalSummary) }],
            1000
          );

          // Save now as the private clinical record. clientSummary lands as a DRAFT —
          // it only becomes visible to the client once the facilitator reviews and
          // explicitly releases it (see /api/sessions/:id/release below).
          const sessionId = uuidv4();
          db.addSession(sessionId, client.id, facilitatorId, 'facilitator', clinicalSummary, '', clientSummary);

          send({
            type: 'session_summary',
            sessionId,
            summary: clinicalSummary,
            clientSummary,
            arcUpdate
          });
        } catch (e) {
          console.error('end_session error:', e.message);
          send({ type: 'response_text', text: 'Something went wrong generating the session summary. Please try again.' });
        }
        break;
      }
    }
  });

  ws.on('close', () => { if (dgWs) { try { dgWs.close(); } catch {} } });
});

// ── Content API ──
app.get('/admin/content',  auth.requireAuth(['admin']), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'content.html')));
app.get('/admin/content/', auth.requireAuth(['admin']), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'content.html')));

app.get('/api/content/categories', auth.requireAuthApi(['admin','facilitator','client']), (req, res) => res.json(db.getAllCategories()));
app.post('/api/content/categories', auth.requireAuthApi(['admin']), (req, res) => {
  const { name, parentId } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required.' });
  db.createCategory(uuidv4(), name.trim(), name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now(), parentId || null, 0);
  res.json({ ok: true });
});
app.patch('/api/content/categories/:id', auth.requireAuthApi(['admin']), (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Name required.' });
  db.renameCategory(req.params.id, req.body.name.trim()); res.json({ ok: true });
});
app.delete('/api/content/categories/:id', auth.requireAuthApi(['admin']), (req, res) => { db.deleteCategory(req.params.id); res.json({ ok: true }); });

app.get('/api/content/kinds', auth.requireAuthApi(['admin','facilitator','client']), (req, res) => res.json(db.getAllContentKinds()));
app.post('/api/content/kinds', auth.requireAuthApi(['admin']), (req, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ error: 'Label required.' });
  const value = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '_' + Date.now();
  db.createContentKind(uuidv4(), value, label.trim(), 0);
  res.json({ ok: true });
});
app.patch('/api/content/kinds/:id', auth.requireAuthApi(['admin']), (req, res) => {
  if (!req.body.label) return res.status(400).json({ error: 'Label required.' });
  db.renameContentKind(req.params.id, req.body.label.trim()); res.json({ ok: true });
});
app.delete('/api/content/kinds/:id', auth.requireAuthApi(['admin']), (req, res) => { db.deleteContentKind(req.params.id); res.json({ ok: true }); });

app.get('/api/content/library', auth.requireAuthApi(['admin','facilitator']), (req, res) => res.json(db.getLibraryFiles(req.query)));

// ══════════════════════════════════════════════════════════════════════════
// ── Course instances / Enrolments / Quizzes — admin builder ──
// Course/lesson CRUD already exists above under /api/content/* with a working
// UI in admin/content.html — these are the genuinely new pieces (instances,
// cohort sessions, quizzes) plus the two edit endpoints /api/content/courses
// and /api/content/lessons were missing (create/delete existed, edit didn't).
// ══════════════════════════════════════════════════════════════════════════

// ── Course instances ──
app.get('/api/admin/course-instances', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    if (req.query.courseId) return res.json(db.getInstancesForCourse(req.query.courseId));
    res.json(db.getAllCourseInstances(req.query));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/course-instances', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { courseId, mode, title, startDate, endDate, capacity, priceCents, stripePriceId, status, scheduleDay, scheduleTime } = req.body;
    if (!courseId || !title || !title.trim()) return res.status(400).json({ error: 'courseId and title are required.' });
    const id = uuidv4();
    db.createCourseInstance(id, courseId, mode, title.trim(), startDate, endDate, capacity, priceCents, stripePriceId, status, scheduleDay, scheduleTime);
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/course-instances/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const instance = db.getCourseInstance(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Not found.' });
    res.json(instance);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/course-instances/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const fieldMap = { mode:'mode', title:'title', startDate:'start_date', endDate:'end_date',
      capacity:'capacity', priceCents:'price_cents', stripePriceId:'stripe_price_id', status:'status',
      scheduleDay:'schedule_day', scheduleTime:'schedule_time' };
    const fields = {};
    Object.keys(fieldMap).forEach(k => { if (req.body[k] !== undefined) fields[fieldMap[k]] = req.body[k]; });
    db.updateCourseInstance(req.params.id, fields);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/course-instances/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteCourseInstance(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/course-instances/:id/enrolments', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getEnrolmentsForInstance(req.params.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
// Per's request — n facilitators per instance, assignable from the admin
// side (Per said he'll do this part himself). GET/POST/DELETE rather
// than one PATCH with a full list, matching the pattern already used for
// lesson-file-refs elsewhere in this file — add/remove one at a time is
// simpler and safer than reconciling a whole list against what's there.
app.get('/api/admin/course-instances/:id/facilitators', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getFacilitatorsForInstance(req.params.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/course-instances/:id/facilitators', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    if (!db.getCourseInstance(req.params.id)) return res.status(404).json({ error: 'Instance not found.' });
    const { facilitatorId } = req.body;
    if (!facilitatorId) return res.status(400).json({ error: 'facilitatorId required.' });
    db.assignFacilitatorToInstance(uuidv4(), req.params.id, facilitatorId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/course-instances/:id/facilitators/:facilitatorId', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.removeFacilitatorFromInstance(req.params.id, req.params.facilitatorId); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Cohort live sessions ──
app.get('/api/admin/course-instances/:id/sessions', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getSessionsForInstance(req.params.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/course-instances/:id/sessions', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { sessionNumber, title, scheduledAt, facilitatorNotes, handout } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
    const id = uuidv4();
    db.addInstanceSession(id, req.params.id, sessionNumber || 1, title.trim(), scheduledAt, facilitatorNotes, handout);
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/instance-sessions/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const fieldMap = { title:'title', scheduledAt:'scheduled_at', facilitatorNotes:'facilitator_notes', handout:'handout' };
    const fields = {};
    Object.keys(fieldMap).forEach(k => { if (req.body[k] !== undefined) fields[fieldMap[k]] = req.body[k]; });
    db.updateInstanceSession(req.params.id, fields);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/instance-sessions/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteInstanceSession(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Facilitator-side course teaching (Per's request — allowing other
// people to facilitate a course, not just Per's own 1:1 clinical work).
// Everything below is scoped to instances this specific facilitator is
// actually assigned to (see instance_facilitators / getInstancesForFacilitator
// in db.js) — a facilitator can see every instance and student they're
// assigned to, nothing they're not, admin always able to see everything
// via the same routes (requireInstanceOwnedByFacilitator lets admin
// through unconditionally, same pattern as requireClientOwnedByFacilitator
// above for 1:1 clients).
function requireInstanceOwnedByFacilitator(req, res, next) {
  const instance = db.getCourseInstance(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instance not found.' });
  const isAssigned = db.isFacilitatorAssignedToInstance(req.user.id, instance.id);
  if (req.user.role !== 'admin' && !isAssigned) return res.status(403).json({ error: 'You are not assigned to this course instance.' });
  req.facilitatorInstance = instance;
  next();
}
app.get('/api/facilitator/instances', auth.requireAuthApi(['facilitator','admin']), (req, res) => {
  try { res.json(db.getInstancesForFacilitator(req.user.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/facilitator/instances/:id', auth.requireAuthApi(['facilitator','admin']), requireInstanceOwnedByFacilitator, (req, res) => {
  try {
    const instance = req.facilitatorInstance;
    const course = db.getCourse(instance.course_id);
    res.json({ ...instance, course_title: course ? course.title : null, facilitators: db.getFacilitatorsForInstance(instance.id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Roster — participants and their live progress. Reuses the exact same
// getEnrolmentsForInstance the admin route above already calls; the only
// difference here is the ownership gate.
app.get('/api/facilitator/instances/:id/roster', auth.requireAuthApi(['facilitator','admin']), requireInstanceOwnedByFacilitator, (req, res) => {
  try { res.json(db.getEnrolmentsForInstance(req.params.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
// Content — the course's own lessons, same list a student sees, so a
// facilitator can review exactly what students are working through.
app.get('/api/facilitator/instances/:id/content', auth.requireAuthApi(['facilitator','admin']), requireInstanceOwnedByFacilitator, (req, res) => {
  try { res.json(db.getLessonsForCourse(req.facilitatorInstance.course_id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
// Sessions — reuses the exact same instance_sessions functions the admin
// routes above already use (addInstanceSession/getSessionsForInstance/
// updateInstanceSession/deleteInstanceSession), just facilitator-scoped.
app.get('/api/facilitator/instances/:id/sessions', auth.requireAuthApi(['facilitator','admin']), requireInstanceOwnedByFacilitator, (req, res) => {
  try { res.json(db.getSessionsForInstance(req.params.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/facilitator/instances/:id/sessions', auth.requireAuthApi(['facilitator','admin']), requireInstanceOwnedByFacilitator, (req, res) => {
  try {
    const { sessionNumber, title, scheduledAt, facilitatorNotes, handout } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
    const id = uuidv4();
    db.addInstanceSession(id, req.params.id, sessionNumber || 1, title.trim(), scheduledAt, facilitatorNotes, handout);
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// PATCH/DELETE take only the session's own id, not also its instance id —
// ownership is checked by looking the session up first, then checking
// ITS instance, rather than reusing requireInstanceOwnedByFacilitator
// directly (which expects :id in the URL to already be an instance id).
app.patch('/api/facilitator/instance-sessions/:id', auth.requireAuthApi(['facilitator','admin']), (req, res) => {
  try {
    const session = db.getInstanceSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (req.user.role !== 'admin' && !db.isFacilitatorAssignedToInstance(req.user.id, session.course_instance_id)) return res.status(403).json({ error: 'You are not assigned to this course instance.' });
    const fieldMap = { title:'title', scheduledAt:'scheduled_at', facilitatorNotes:'facilitator_notes', handout:'handout' };
    const fields = {};
    Object.keys(fieldMap).forEach(k => { if (req.body[k] !== undefined) fields[fieldMap[k]] = req.body[k]; });
    db.updateInstanceSession(req.params.id, fields);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/facilitator/instance-sessions/:id', auth.requireAuthApi(['facilitator','admin']), (req, res) => {
  try {
    const session = db.getInstanceSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (req.user.role !== 'admin' && !db.isFacilitatorAssignedToInstance(req.user.id, session.course_instance_id)) return res.status(403).json({ error: 'You are not assigned to this course instance.' });
    db.deleteInstanceSession(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Student notes — a facilitator's own private notes on one participant
// within this instance (separate from the clinical `sessions` table,
// which is Per's own 1:1 client work and unrelated to a course).
app.get('/api/facilitator/instances/:id/notes', auth.requireAuthApi(['facilitator','admin']), requireInstanceOwnedByFacilitator, (req, res) => {
  try { res.json(db.getNotesForInstance(req.params.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/facilitator/instances/:id/students/:userId/notes', auth.requireAuthApi(['facilitator','admin']), requireInstanceOwnedByFacilitator, (req, res) => {
  try { res.json(db.getNotesForStudentInInstance(req.params.id, req.params.userId)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/facilitator/instances/:id/students/:userId/notes', auth.requireAuthApi(['facilitator','admin']), requireInstanceOwnedByFacilitator, (req, res) => {
  try {
    const note = (req.body.note || '').trim();
    if (!note) return res.status(400).json({ error: 'Note text required.' });
    // Admin acting here has no facilitator row of their own to attribute
    // this to — falls back to the instance's first assigned facilitator
    // so the note still has a real, valid facilitator_id rather than
    // one that doesn't exist in the facilitators table.
    let facilitatorId = req.user.id;
    if (req.user.role === 'admin') {
      const facs = db.getFacilitatorsForInstance(req.params.id);
      facilitatorId = facs.length ? facs[0].id : null;
      if (!facilitatorId) return res.status(400).json({ error: 'This instance has no facilitator assigned yet — assign one before adding notes.' });
    }
    db.addStudentNote(uuidv4(), req.params.id, req.params.userId, facilitatorId, note);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Quizzes ──
app.post('/api/admin/quizzes', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { lessonId, title, passThresholdPct } = req.body;
    if (!lessonId || !title || !title.trim()) return res.status(400).json({ error: 'lessonId and title are required.' });
    if (db.getQuizForLesson(lessonId)) return res.status(400).json({ error: 'This lesson already has a quiz — edit it instead.' });
    const id = uuidv4();
    db.createQuiz(id, lessonId, title.trim(), passThresholdPct);
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/quizzes/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const quiz = db.getFullQuiz(req.params.id);
    if (!quiz) return res.status(404).json({ error: 'Not found.' });
    res.json(quiz);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/quizzes/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { title, passThresholdPct } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
    db.updateQuiz(req.params.id, title.trim(), passThresholdPct);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/quizzes/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteQuiz(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/quizzes/:id/questions', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { questionText, questionType, sortOrder } = req.body;
    if (!questionText || !questionText.trim()) return res.status(400).json({ error: 'Question text is required.' });
    const id = uuidv4();
    db.addQuizQuestion(id, req.params.id, questionText.trim(), questionType, sortOrder);
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/quiz-questions/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { questionText, questionType, sortOrder } = req.body;
    if (!questionText || !questionText.trim()) return res.status(400).json({ error: 'Question text is required.' });
    db.updateQuizQuestion(req.params.id, questionText.trim(), questionType, sortOrder);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/quiz-questions/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteQuizQuestion(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/quiz-questions/:id/options', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { optionText, isCorrect, sortOrder } = req.body;
    if (!optionText || !optionText.trim()) return res.status(400).json({ error: 'Option text is required.' });
    const id = uuidv4();
    db.addQuizOption(id, req.params.id, optionText.trim(), !!isCorrect, sortOrder);
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/quiz-options/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { optionText, isCorrect, sortOrder } = req.body;
    if (!optionText || !optionText.trim()) return res.status(400).json({ error: 'Option text is required.' });
    db.updateQuizOption(req.params.id, optionText.trim(), !!isCorrect, sortOrder);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/quiz-options/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteQuizOption(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Facilitator Workspace resource shelf — fixed prep/reference material, not
// client-specific. Facilitators and Admins only. ──
app.get('/api/facilitator/resources', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  try { res.json(db.getFacilitatorResources()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── R2 upload — Step 1: get a presigned PUT URL. Browser uploads directly to R2, never through Express. ──
app.post('/api/content/library/presign-upload', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    if (!media.isConfigured()) return res.status(503).json({ error: 'Media storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME.' });
    const { filename, contentType } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required.' });
    const ext = path.extname(filename);
    const key = `library/${uuidv4()}${ext}`;
    const uploadUrl = await media.getUploadUrl(key, contentType || 'application/octet-stream');
    res.json({ uploadUrl, key });
  } catch (e) {
    console.error('presign-upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Upload queue (Per Bot 26) ── Persistent to-do list for large bulk
// uploads. A row is written the instant a file is added to the admin's
// queue (metadata only — see db.js comment on the table itself for why),
// and removed the instant that file's upload actually succeeds. This is
// what lets a big batch survive a closed tab, a crash, or a stopped-partway
// failure without losing track of what's left — reopen the upload screen,
// see exactly what's outstanding, drag the same source folder back in.
app.get('/api/admin/upload-queue', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getUploadQueueItems());
});
app.post('/api/admin/upload-queue', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'No items provided.' });
    const withIds = items.map(it => ({ ...it, id: it.id || uuidv4() }));
    db.addUploadQueueItems(withIds);
    res.json({ ids: withIds.map(it => it.id) });
  } catch (e) {
    console.error('upload-queue add error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.patch('/api/admin/upload-queue/:id/failed', auth.requireAuthApi(['admin']), (req, res) => {
  db.markUploadQueueItemFailed(req.params.id, req.body.errorMessage || '');
  res.json({ ok: true });
});
app.patch('/api/admin/upload-queue/:id/retry', auth.requireAuthApi(['admin']), (req, res) => {
  db.markUploadQueueItemPending(req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/upload-queue/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.removeUploadQueueItem(req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/upload-queue/remove-batch', auth.requireAuthApi(['admin']), (req, res) => {
  db.removeUploadQueueItems(Array.isArray(req.body.ids) ? req.body.ids : []);
  res.json({ ok: true });
});
app.delete('/api/admin/upload-queue', auth.requireAuthApi(['admin']), (req, res) => {
  db.clearUploadQueue();
  res.json({ ok: true });
});

// ── R2 upload — Step 2: browser has finished uploading directly to R2; save the metadata row. ──
// ── Audiobook chapter combining (Per Bot 53) ── Author's Republic (the
// audiobook distribution aggregator) requires separate per-chapter MP3
// files for submission — that's not optional, it's how their platform
// works. Rather than fighting that, this takes the same chapter files
// and does something useful with them here too: stitches them into one
// continuous file for in-app playback via ffmpeg (same technique
// already proven for the signal-script pause splicing — naive
// Buffer.concat of separate MP3s doesn't work, verified directly
// earlier this cycle), and computes each chapter's start time directly
// from where its source file actually started, rather than anyone
// typing timestamps by hand.
//
// This went through two earlier versions. The first did everything —
// upload, ffprobe, ffmpeg, storage upload — inside one HTTP request,
// which broke on a real 51-file, ~200MB book: Railway enforces a hard
// 5-minute limit on every public HTTP request, confirmed directly
// against Railway's own support documentation, not configurable at the
// application level. The second version made the server-side
// processing happen in the background after an immediate response —
// correct in principle, but it didn't fix the real bottleneck: the
// files were still being uploaded through this Node server via multer
// before that response could even happen, so a slow connection
// uploading ~200MB could itself exceed 5 minutes with nothing after the
// upload even having started yet.
//
// This version fixes the actual bottleneck: the browser uploads each
// chapter file DIRECTLY to R2 via a presigned URL first (the exact same
// mechanism /api/content/library/presign-upload already provides for
// every other upload in this app), never touching this Node server for
// the large transfer at all — R2 uploads aren't subject to Railway's
// proxy timeout in any way. This endpoint then only receives a small
// JSON payload (the R2 keys, in order, plus metadata), starts a
// background job, downloads each file back from R2 server-side (fast —
// R2-to-Railway is not bandwidth-constrained by anyone's home
// connection), and does the same ffprobe/ffmpeg/re-upload sequence as
// before, exactly as it did when working with locally-uploaded files.
const audiobookJobs = new Map();
app.post('/api/admin/library/audiobook-combine', auth.requireAuthApi(['admin']), async (req, res) => {
  const { title, description, categoryId, subcategoryId, visibility, chapters: chapterFiles } = req.body;
  if (!Array.isArray(chapterFiles) || !chapterFiles.length) return res.status(400).json({ error: 'No chapter files provided.' });
  if (!title || !categoryId) return res.status(400).json({ error: 'Title and category are required.' });

  const jobId = uuidv4();
  audiobookJobs.set(jobId, { status: 'processing', stage: 'Starting…' });
  res.json({ ok: true, jobId }); // respond immediately — this request never carried any file data, so it's always fast regardless of book size

  (async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'audiobook-'));
    try {
      // Download each chapter back from R2 into a local temp file —
      // ffmpeg/ffprobe need real files on disk, not R2 keys directly.
      // This step is fast: R2-to-Railway bandwidth isn't constrained by
      // anyone's home upload speed the way the original browser upload was.
      const localPaths = [];
      for (let i = 0; i < chapterFiles.length; i++) {
        audiobookJobs.set(jobId, { status: 'processing', stage: `Fetching chapter ${i + 1} of ${chapterFiles.length}` });
        const obj = await media.getPublicObject(chapterFiles[i].key);
        const localPath = path.join(tmpDir, `chapter${i}.mp3`);
        await new Promise((resolve, reject) => {
          const writeStream = fs.createWriteStream(localPath);
          obj.Body.pipe(writeStream);
          obj.Body.on('error', reject);
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
        });
        localPaths.push(localPath);
      }

      // Probe each file's real duration via ffprobe, in the same order
      // the chapters were uploaded/selected.
      const durations = [];
      for (let i = 0; i < localPaths.length; i++) {
        audiobookJobs.set(jobId, { status: 'processing', stage: `Checking file lengths — ${i + 1} of ${localPaths.length}` });
        const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', localPaths[i]]);
        durations.push(parseFloat(stdout.trim()) || 0);
      }

      audiobookJobs.set(jobId, { status: 'processing', stage: `Combining ${localPaths.length} chapter files into one` });
      // Concat demuxer needs a plain list file — same mechanism as the
      // signal-script splicing, just concatenating real chapter content
      // instead of TTS segments + generated silence.
      const listPath = path.join(tmpDir, 'list.txt');
      const listContent = localPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
      await fsp.writeFile(listPath, listContent);
      const outPath = path.join(tmpDir, 'combined.mp3');
      await execFileAsync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);

      const buffer = await fsp.readFile(outPath);
      audiobookJobs.set(jobId, { status: 'processing', stage: `Uploading the combined file (${(buffer.length / 1024 / 1024).toFixed(0)}MB)` });
      const key = `library/${uuidv4()}.mp3`;
      await media.uploadPublicObject(key, buffer, 'audio/mpeg');

      audiobookJobs.set(jobId, { status: 'processing', stage: 'Saving chapters' });
      const fileId = uuidv4();
      db.addLibraryFile(
        fileId, title.trim(), description || '', key, `${title.trim()}.mp3`,
        'audio/mpeg', buffer.length, categoryId, subcategoryId || null, visibility || 'client',
        'r2', false, 'book', null, null
      );

      // Chapter start times: chapter 0 starts at 0, each subsequent
      // chapter starts at the sum of every prior file's real duration —
      // exact, since it's derived from the same files that were just
      // concatenated in this same order, not estimated separately.
      let cumulative = 0;
      const chapters = [];
      for (let i = 0; i < chapterFiles.length; i++) {
        const chapterTitle = (chapterFiles[i].title || chapterFiles[i].originalname.replace(/\.[^.]+$/, '')).trim();
        const chapterId = uuidv4();
        db.createChapter(chapterId, fileId, chapterTitle, cumulative, i);
        chapters.push({ id: chapterId, title: chapterTitle, start_seconds: cumulative });
        cumulative += durations[i];
      }

      audiobookJobs.set(jobId, { status: 'done', fileId, chapters, totalDurationSeconds: cumulative });

      // The R2 originals were only ever needed to build the combined
      // file — safe to remove now rather than leaving 51 duplicate
      // chapter files sitting in storage permanently alongside the one
      // combined file that's actually used going forward.
      for (const cf of chapterFiles) {
        media.deleteObject(cf.key).catch(() => {});
      }
    } catch (e) {
      console.error('audiobook-combine background error:', e.message);
      audiobookJobs.set(jobId, { status: 'error', error: e.message });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      // Job results don't need to live forever — clear this one out well
      // after any reasonable polling window so audiobookJobs doesn't
      // grow without bound across many combines over time.
      setTimeout(() => audiobookJobs.delete(jobId), 30 * 60 * 1000);
    }
  })();
});
app.get('/api/admin/library/audiobook-combine/status/:jobId', auth.requireAuthApi(['admin']), (req, res) => {
  const job = audiobookJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found — it may have finished a while ago, or the server restarted since it started.' });
  res.json(job);
});

// Chapter list for a given file — used by both the admin editor and
// (later) the client player.
app.get('/api/admin/library/:id/chapters', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getChaptersForFile(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/library/chapters/:chapterId', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { title, startSeconds } = req.body;
    if (!title || startSeconds == null) return res.status(400).json({ error: 'Title and start time are required.' });
    db.updateChapter(req.params.chapterId, title.trim(), Number(startSeconds));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/library/chapters/:chapterId', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteChapter(req.params.chapterId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// Shared by all three call sites (upload Path A, upload Path B, and the
// on-demand/reconvert endpoint below) so the actual convert-upload-store
// sequence exists in exactly one place. Returns the slide count on
// success, or null on any failure — never throws, same conservative
// contract as convertPdfToEpub itself, since a failed conversion must
// never break the upload or the on-demand request that triggered it.
async function convertAndStorePptxSlides(fileId, pptxBuffer) {
  if (!media.isConfigured()) return null;
  try {
    const slides = await convertPptxToSlides(pptxBuffer);
    if (!slides || !slides.length) return null;
    const keys = [];
    for (const slide of slides) {
      const key = `library-slides/${fileId}/slide-${slide.slideNumber}.jpg`;
      await media.putObject(key, slide.buffer, 'image/jpeg');
      keys.push(key);
    }
    db.replaceLibraryFileSlides(fileId, keys);
    return keys.length;
  } catch (e) {
    console.error('[pptx-to-slides] convertAndStorePptxSlides failed:', e.message);
    return null;
  }
}

app.post('/api/content/library', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  try {
    const { title, categoryId, subcategoryId, visibility } = req.body;
    if (!title || !categoryId) return res.status(400).json({ error: 'Missing required fields.' });
    const facilitatorResource = req.body.facilitatorResource === 'true' || req.body.facilitatorResource === true;
    // contentKind is the new library taxonomy (meditation/blog/whitepaper/
    // poem/book/video_blog/etc, Per Bot 7) — named distinctly from the
    // existing contentType field just above, which is the file's MIME type
    // and already means something else in this same endpoint.
    const contentKind  = req.body.contentKind  || null;
    const externalLink = req.body.externalLink || null;
    // As with the PATCH endpoint below — an assigned person must be a
    // real user account, never trust an arbitrary id straight from the
    // request body onto a field that grants exclusive access. Per Bot 24
    // — no longer restricted to is_client specifically; any real person
    // (Explorer/Member/Client alike) can be the one-to-one target now.
    let assignedClientId = req.body.assignedClientId || null;
    if (assignedClientId) {
      const target = db.getUser(assignedClientId);
      if (!target) return res.status(400).json({ error: 'That is not a valid person.' });
    }
    // Per Bot 29 — tags are now the default way content gets organized
    // (theme shelves, admin filtering), so the upload path applies them
    // at creation time rather than needing a separate script run
    // afterward. Comma-separated from the bulk-upload form; lowercased
    // and trimmed to match the casing cleanup's canonical form.
    const tags = (req.body.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

    // Path A — R2 upload already completed client-side; just save the reference.
    if (req.body.r2Key) {
      const id = uuidv4();
      const uploadedContentType = req.body.contentType || 'application/octet-stream';
      // Per's request — PDF-to-EPUB conversion on upload. Attempted only
      // when R2 is actually configured (matches the same "legacy
      // fallback if not" reasoning as uploadTomteImageToR2 elsewhere) —
      // and wrapped so any failure here just falls through to storing
      // the PDF exactly as before, never blocks the upload itself.
      let mainFilename = req.body.r2Key, mainContentType = uploadedContentType, originalPdfKey = null;
      if (uploadedContentType === 'application/pdf' && media.isConfigured()) {
        try {
          const pdfObj = await media.getPublicObject(req.body.r2Key);
          const chunks = [];
          for await (const chunk of pdfObj.Body) chunks.push(chunk);
          const pdfBuffer = Buffer.concat(chunks);
          const epubBuffer = await convertPdfToEpub(pdfBuffer, title.trim(), brand().name);
          if (epubBuffer) {
            const epubKey = `library-epubs/${uuidv4()}.epub`;
            await media.putObject(epubKey, epubBuffer, 'application/epub+zip');
            mainFilename = epubKey;
            mainContentType = 'application/epub+zip';
            originalPdfKey = req.body.r2Key; // already in R2 — no re-upload needed
          }
        } catch (e) {
          console.error('[pdf-to-epub] Path A conversion attempt failed, falling back to PDF:', e.message);
        }
      }
      // Presentations — unlike the PDF case above, the pptx itself stays
      // as the main stored file (mainFilename/mainContentType untouched);
      // this only adds the slide-image rows the reader checks for. Also
      // wrapped so a conversion failure never blocks the upload — the
      // file still saves as a plain pptx, same "Open document" link as
      // before this feature existed.
      if (uploadedContentType === PPTX_MIME && media.isConfigured()) {
        try {
          const pptxObj = await media.getPublicObject(req.body.r2Key);
          const chunks = [];
          for await (const chunk of pptxObj.Body) chunks.push(chunk);
          await convertAndStorePptxSlides(id, Buffer.concat(chunks));
        } catch (e) {
          console.error('[pptx-to-slides] Path A conversion attempt failed, falling back to raw pptx:', e.message);
        }
      }
      db.addLibraryFile(
        id, title.trim(), req.body.description || '', mainFilename, req.body.originalName || req.body.r2Key,
        mainContentType, parseInt(req.body.fileSize) || 0,
        categoryId, subcategoryId || null, visibility || 'client', 'r2', facilitatorResource,
        contentKind, externalLink, assignedClientId
      );
      if (originalPdfKey) db.setLibraryFileOriginalPdf(id, originalPdfKey);
      tags.forEach(t => db.addFileTag(id, t));
      return res.json({ id });
    }

    // Path B — legacy direct-to-disk upload, kept for now so nothing breaks mid-migration.
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });
    const id = uuidv4();
    let mainFilename = req.file.filename, mainStorageType = 'disk', mainContentType = req.file.mimetype, originalPdfKey = null;
    if (req.file.mimetype === 'application/pdf' && media.isConfigured()) {
      try {
        const pdfBuffer = fs.readFileSync(req.file.path);
        const epubBuffer = await convertPdfToEpub(pdfBuffer, title.trim(), brand().name);
        if (epubBuffer) {
          const epubKey = `library-epubs/${uuidv4()}.epub`;
          const pdfKey = `library-pdfs/${uuidv4()}.pdf`;
          await media.putObject(epubKey, epubBuffer, 'application/epub+zip');
          await media.putObject(pdfKey, pdfBuffer, 'application/pdf');
          mainFilename = epubKey;
          mainStorageType = 'r2';
          mainContentType = 'application/epub+zip';
          originalPdfKey = pdfKey;
        }
      } catch (e) {
        console.error('[pdf-to-epub] Path B conversion attempt failed, falling back to PDF:', e.message);
      }
    }
    if (req.file.mimetype === PPTX_MIME && media.isConfigured()) {
      try {
        await convertAndStorePptxSlides(id, fs.readFileSync(req.file.path));
      } catch (e) {
        console.error('[pptx-to-slides] Path B conversion attempt failed, falling back to raw pptx:', e.message);
      }
    }
    db.addLibraryFile(id, title.trim(), req.body.description || '', mainFilename, req.file.originalname, mainContentType, req.file.size, categoryId, subcategoryId || null, visibility || 'client', mainStorageType, facilitatorResource, contentKind, externalLink, assignedClientId);
    if (originalPdfKey) db.setLibraryFileOriginalPdf(id, originalPdfKey);
    tags.forEach(t => db.addFileTag(id, t));
    res.json({ id });
  } catch (e) {
    console.error('library upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Newsletter images ── Admin uploads a file → goes to R2 → server hands
// back a URL that resolves through OUR OWN server (GET /newsletter-images/:key
// below), not a presigned R2 URL. Content-library files use presigned URLs
// because they're meant to be private and tier-gated; newsletter images are
// the opposite — they need to render in an email opened by anyone, including
// people with no account at all, so there's no access check that could ever
// run and no useful place to put an expiry. This reuses the same R2 bucket
// and credentials as the content library, just a different, deliberately
// public, key prefix and serving path.
app.post('/api/admin/newsletter-images', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    if (!media.isConfigured()) return res.status(400).json({ error: 'Image storage (R2) is not configured on this deployment.' });
    if (!req.file.mimetype.startsWith('image/')) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Only image files are supported here.' });
    }

    const buffer = fs.readFileSync(req.file.path);
    const ext = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || [''])[0];
    const key = `newsletter-images/${uuidv4()}${ext}`;

    await media.uploadPublicObject(key, buffer, req.file.mimetype);
    fs.unlink(req.file.path, () => {});

    res.json({ url: `${APP_URL}/newsletter-images/${encodeURIComponent(key.replace('newsletter-images/', ''))}` });
  } catch (e) {
    console.error('newsletter image upload error:', e.message);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Could not upload image: ' + e.message });
  }
});

// Public, no auth, by design — see the comment above. Long cache lifetime
// since each key is a fresh UUID (uploading a "new" version of an image
// just gets a new key, it never overwrites one that might already be cached
// by an email client or CDN).
app.get('/newsletter-images/:key', async (req, res) => {
  try {
    const obj = await media.getPublicObject(`newsletter-images/${req.params.key}`);
    res.setHeader('Content-Type', obj.ContentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    obj.Body.pipe(res);
  } catch (e) {
    res.status(404).send('Not found');
  }
});

// ── Newsletter audio (Per Bot 25) — same public R2 storage/serving pattern
// as newsletter-images above, for the shared editor's new audio button
// (message-editor.js's uploadAudioIntoEditor / audioBlock). Admin-only
// upload, same as images — this is for admin-authored broadcast content
// (Newsletter, MOTD, comms2/sales message types) where public, unauthenticated
// access is the correct model, same reasoning as newsletter-images. NOT
// used by Journal or any other client-facing field — those need a
// private, ownership-checked storage model instead (see
// /api/journal/:id/audio-url for that existing pattern), which is a
// separate decision Per hasn't made yet for embedded media specifically.
app.post('/api/admin/newsletter-audio', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    if (!media.isConfigured()) return res.status(400).json({ error: 'Audio storage (R2) is not configured on this deployment.' });
    if (!req.file.mimetype.startsWith('audio/')) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Only audio files are supported here.' });
    }

    const buffer = fs.readFileSync(req.file.path);
    const ext = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || [''])[0];
    const key = `newsletter-audio/${uuidv4()}${ext}`;

    await media.uploadPublicObject(key, buffer, req.file.mimetype);
    fs.unlink(req.file.path, () => {});

    res.json({ url: `${APP_URL}/newsletter-audio/${encodeURIComponent(key.replace('newsletter-audio/', ''))}` });
  } catch (e) {
    console.error('newsletter audio upload error:', e.message);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Could not upload audio: ' + e.message });
  }
});
app.get('/newsletter-audio/:key', async (req, res) => {
  try {
    const obj = await media.getPublicObject(`newsletter-audio/${req.params.key}`);
    res.setHeader('Content-Type', obj.ContentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    obj.Body.pipe(res);
  } catch (e) {
    res.status(404).send('Not found');
  }
});

// ── Newsletter videos (Per Bot 8) — same public R2 storage/serving pattern
// as newsletter-images above, just a parallel key prefix and a video/ mimetype
// check instead of image/. Most inboxes (Gmail, most Outlook) can't play
// inline video at all, so the editor wraps this URL in a bulletproof
// video/poster/fallback-link block rather than a bare <video> tag — but the
// upload+storage side is identical to how images already work.
// ── R2 upload — Step 1: get a presigned PUT URL for a newsletter video.
// Per Bot 24 (maintenance rebuild, priority 2) — same direct-to-R2
// pattern as /api/content/library/presign-upload above; this was
// flagged as the single highest-risk upload in the whole app (video,
// admin-only, no real size ceiling), previously routed browser → Node →
// R2 (buffered into memory, then re-uploaded from the server — a full
// double transfer, and exposed to Railway's 5-minute request limit).
app.post('/api/admin/newsletter-videos/presign-upload', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    if (!media.isConfigured()) return res.status(503).json({ error: 'Media storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME.' });
    const { filename, contentType } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required.' });
    if (!contentType || !contentType.startsWith('video/')) return res.status(400).json({ error: 'Only video files are supported here.' });
    const ext = (filename.match(/\.[a-zA-Z0-9]+$/) || ['.mp4'])[0];
    const key = `newsletter-videos/${uuidv4()}${ext}`;
    const uploadUrl = await media.getUploadUrl(key, contentType);
    res.json({ uploadUrl, key });
  } catch (e) {
    console.error('newsletter-videos presign-upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/admin/newsletter-videos', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  try {
    if (!media.isConfigured()) return res.status(400).json({ error: 'Video storage (R2) is not configured on this deployment.' });

    // Per Bot 24 — Path A: the upload already happened directly to R2
    // (see presign-upload above); this just confirms the key is real and
    // returns the public URL, no file bytes touch this server at all.
    if (req.body && req.body.r2Key) {
      const key = req.body.r2Key;
      if (!key.startsWith('newsletter-videos/')) return res.status(400).json({ error: 'Unexpected key.' });
      const exists = await media.objectExists(key).catch(() => false);
      if (!exists) return res.status(400).json({ error: 'Upload did not complete — try again.' });
      return res.json({ url: `${APP_URL}/newsletter-videos/${encodeURIComponent(key.replace('newsletter-videos/', ''))}` });
    }

    // Path B — legacy fallback: presign failed, or an older client. Same
    // as before, just now the secondary path rather than the only one.
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    if (!req.file.mimetype.startsWith('video/')) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Only video files are supported here.' });
    }

    const buffer = fs.readFileSync(req.file.path);
    const ext = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || ['.mp4'])[0];
    const key = `newsletter-videos/${uuidv4()}${ext}`;

    await media.uploadPublicObject(key, buffer, req.file.mimetype);
    fs.unlink(req.file.path, () => {});

    res.json({ url: `${APP_URL}/newsletter-videos/${encodeURIComponent(key.replace('newsletter-videos/', ''))}` });
  } catch (e) {
    console.error('newsletter video upload error:', e.message);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Could not upload video: ' + e.message });
  }
});
app.get('/newsletter-videos/:key', async (req, res) => {
  try {
    const obj = await media.getPublicObject(`newsletter-videos/${req.params.key}`);
    res.setHeader('Content-Type', obj.ContentType || 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    obj.Body.pipe(res);
  } catch (e) {
    res.status(404).send('Not found');
  }
});

// ── Playback URL — checked against the SAME tier-gating logic as the Content tab listing. ──
// Only generates a (short-lived, signed) R2 URL after access is confirmed. Legacy disk files
// fall back to the existing /uploads/:filename route, unaffected by this migration.
// Per Bot 46 — client-facing counterpart to the admin chapter endpoints
// above. Same auth/tier gate as playback-url itself, since chapter
// titles and timestamps aren't meaningfully sensitive on their own, but
// there's no reason to expose them to someone who couldn't play the
// file anyway.
app.get('/api/content/library/:id/chapters', auth.requireAuthApi(['client','facilitator','admin']), (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found.' });
    const userRec = req.user.role === 'client' ? db.getUser(req.user.id) : null;
    const userFlags = db.userFlagsFromRecord(userRec, req.user.role);
    const allowed = (req.user.role === 'facilitator' || req.user.role === 'admin')
      ? !file.archived
      : (db.canAccessFile(file, userFlags, req.user.id) || (!file.archived && db.fileHasFreePreview(file.id)));
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });
    res.json(db.getChaptersForFile(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resume position — per person, per file. GET returns 0 for a file
// they've never played, same as a fresh start; no separate "not found"
// case to handle client-side.
app.get('/api/content/library/:id/position', auth.requireAuthApi(['client','facilitator','admin']), (req, res) => {
  try {
    res.json({ positionSeconds: db.getPlaybackPosition(req.user.id, req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/content/library/:id/position', auth.requireAuthApi(['client','facilitator','admin']), (req, res) => {
  try {
    const position = Number(req.body.positionSeconds);
    if (!Number.isFinite(position) || position < 0) return res.status(400).json({ error: 'Invalid position.' });
    db.savePlaybackPosition(req.user.id, req.params.id, position);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/content/library/:id/playback-url', auth.requireAuthApi(['client','facilitator','admin']), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found.' });

    const userRec = req.user.role === 'client' ? db.getUser(req.user.id) : null;
    const userFlags = db.userFlagsFromRecord(userRec, req.user.role);
    // Facilitators/admins can preview/play any file regardless of tier; an Explorer/
    // Member/Client only ever gets a URL for what their own tier actually permits —
    // unless this specific file has been flagged as a free preview (Per Bot 18), in
    // which case any logged-in client-role account can play it regardless of tier.
    const allowed = (req.user.role === 'facilitator' || req.user.role === 'admin')
      ? !file.archived
      : (db.canAccessFile(file, userFlags, req.user.id) || (!file.archived && db.fileHasFreePreview(file.id)));
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });

    if (file.storage_type === 'r2') {
      const isTextHtml = file.file_type === 'text/html';
      const url = await media.getPlaybackUrl(file.filename, { noCache: isTextHtml, forceUtf8: isTextHtml });
      const response = { url, expiresIn: 600 };
      // Unpacked books (see unpack_epub_book.js) get a second URL pointing
      // at the per-resource proxy below — the reader prefers this one so
      // it fetches chapters as needed rather than the whole .epub upfront.
      if (file.epub_opf_path) {
        response.epubReaderUrl = `/api/content/library/${file.id}/epub-resource/${file.epub_opf_path}`;
      }
      return res.json(response);
    }
    // Legacy disk file — same URL pattern as before, no change in behaviour.
    res.json({ url: `/uploads/${file.filename}`, expiresIn: null });
  } catch (e) {
    console.error('playback-url error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Per's request — "Download PDF" alongside the converted EPUB a
// PDF-to-EPUB conversion produces. Same exact access-check as
// playback-url just above (a person needs to be allowed to read this
// file at all before they can download its original), just resolving
// original_pdf_filename instead of filename.
app.get('/api/content/library/:id/original-pdf-url', auth.requireAuthApi(['client','facilitator','admin']), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found.' });
    if (!file.original_pdf_filename) return res.status(404).json({ error: 'No original PDF for this file.' });

    const userRec = req.user.role === 'client' ? db.getUser(req.user.id) : null;
    const userFlags = db.userFlagsFromRecord(userRec, req.user.role);
    const allowed = (req.user.role === 'facilitator' || req.user.role === 'admin')
      ? !file.archived
      : (db.canAccessFile(file, userFlags, req.user.id) || (!file.archived && db.fileHasFreePreview(file.id)));
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });

    const url = await media.getPlaybackUrl(file.original_pdf_filename);
    res.json({ url, expiresIn: 600 });
  } catch (e) {
    console.error('original-pdf-url error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Per's request — on-demand conversion, the moment someone on mobile
// opens a PDF that predates the upload-time conversion feature (most of
// the library, at this point). Same access check as playback-url above,
// since converting still means reading the file's own bytes.
app.post('/api/content/library/:id/convert-to-epub', auth.requireAuthApi(['client','facilitator','admin']), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found.' });

    // Per's request — force:true reconverts a file that's already an
    // epub, reading from its preserved original PDF (original_pdf_filename)
    // rather than the no-op path below. Needed the moment a real bug was
    // found in the conversion itself (wrong spine order) — anything
    // already converted before that fix has the broken structure
    // permanently baked into its stored epub, and the plain "already
    // converted, nothing to do" check below would otherwise mean it can
    // never self-heal, even after the underlying code is fixed. Admin-
    // only: this replaces a file everyone's already reading, not
    // something to trigger from a normal open.
    const force = !!(req.body && req.body.force);
    if (force && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can force a reconversion.' });
    if (file.file_type === 'application/epub+zip' && force && !file.original_pdf_filename) {
      return res.status(400).json({ error: 'No original PDF on file for this item — cannot reconvert.' });
    }
    // Already converted, and not a forced reconvert (this exact file, or
    // a near-simultaneous request for it that finished first) — a real
    // no-op, not an error, so a double-tap or two people opening the
    // same file at once doesn't do the conversion work twice.
    if (file.file_type === 'application/epub+zip' && !force) return res.json({ ok: true, alreadyConverted: true });
    if (file.file_type !== 'application/pdf' && file.file_type !== 'application/epub+zip') {
      return res.status(400).json({ error: 'This file is not a PDF.' });
    }

    const userRec = req.user.role === 'client' ? db.getUser(req.user.id) : null;
    const userFlags = db.userFlagsFromRecord(userRec, req.user.role);
    const allowed = (req.user.role === 'facilitator' || req.user.role === 'admin')
      ? !file.archived
      : (db.canAccessFile(file, userFlags, req.user.id) || (!file.archived && db.fileHasFreePreview(file.id)));
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });

    if (!media.isConfigured()) return res.status(503).json({ error: 'Conversion is not available right now — please try again later.' });

    // A force-reconvert always reads original_pdf_filename, which every
    // conversion path (upload, on-demand) always puts in R2 regardless
    // of the file's own storage_type — the plain, not-yet-converted
    // case below is the only one that still needs the disk fallback.
    const isReconvert = file.file_type === 'application/epub+zip';
    const pdfSourceKey = isReconvert ? file.original_pdf_filename : file.filename;
    let pdfBuffer;
    if (isReconvert || file.storage_type === 'r2') {
      const obj = await media.getPublicObject(pdfSourceKey);
      const chunks = [];
      for await (const chunk of obj.Body) chunks.push(chunk);
      pdfBuffer = Buffer.concat(chunks);
    } else {
      pdfBuffer = fs.readFileSync(path.join(__dirname, 'uploads', pdfSourceKey));
    }

    const epubBuffer = await convertPdfToEpub(pdfBuffer, file.title, brand().name);
    if (!epubBuffer) return res.status(422).json({ error: 'This document could not be converted — it may be a scanned PDF without readable text.' });

    const epubKey = `library-epubs/${uuidv4()}.epub`;
    await media.putObject(epubKey, epubBuffer, 'application/epub+zip');

    // Preserve the original for the Download PDF option — a reconvert
    // already has a stable R2 original (pdfSourceKey itself), so it's
    // simply reused rather than re-uploaded; otherwise same reasoning as
    // before: reuse an already-R2 key directly, or give a legacy disk
    // file a real R2 home for the first time here.
    let originalPdfKey = isReconvert ? pdfSourceKey : file.filename;
    if (!isReconvert && file.storage_type !== 'r2') {
      originalPdfKey = `library-pdfs/${uuidv4()}.pdf`;
      await media.putObject(originalPdfKey, pdfBuffer, 'application/pdf');
    }

    db.markLibraryFileConverted(file.id, epubKey, originalPdfKey);
    res.json({ ok: true, originalPdfFilename: originalPdfKey });
  } catch (e) {
    console.error('[convert-to-epub on-demand] failed:', e.message);
    res.status(500).json({ error: 'Conversion failed — please try again.' });
  }
});

// Same access-check shape as playback-url throughout this file. Returns
// presigned URLs for every slide of a converted presentation, in order.
// If this pptx hasn't been converted yet (most of the library, at this
// point — same situation the PDF-to-EPUB on-demand endpoint exists
// for), converts it right now rather than requiring a re-upload, then
// returns the fresh URLs — one request handles both the already-
// converted and not-yet-converted cases, so the client doesn't need to
// know which one it's getting.
app.get('/api/content/library/:id/slides', auth.requireAuthApi(['client','facilitator','admin']), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found.' });
    if (file.file_type !== PPTX_MIME) return res.status(400).json({ error: 'This file is not a presentation.' });

    const userRec = req.user.role === 'client' ? db.getUser(req.user.id) : null;
    const userFlags = db.userFlagsFromRecord(userRec, req.user.role);
    const allowed = (req.user.role === 'facilitator' || req.user.role === 'admin')
      ? !file.archived
      : (db.canAccessFile(file, userFlags, req.user.id) || (!file.archived && db.fileHasFreePreview(file.id)));
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });

    let slides = db.getLibraryFileSlides(file.id);
    if (!slides.length) {
      if (!media.isConfigured()) return res.status(503).json({ error: 'Conversion is not available right now — please try again later.' });
      let pptxBuffer;
      if (file.storage_type === 'r2') {
        const obj = await media.getPublicObject(file.filename);
        const chunks = [];
        for await (const chunk of obj.Body) chunks.push(chunk);
        pptxBuffer = Buffer.concat(chunks);
      } else {
        pptxBuffer = fs.readFileSync(path.join(__dirname, 'uploads', file.filename));
      }
      const count = await convertAndStorePptxSlides(file.id, pptxBuffer);
      if (!count) return res.status(422).json({ error: 'This presentation could not be converted.' });
      slides = db.getLibraryFileSlides(file.id);
    }

    const urls = await Promise.all(slides.map(s => media.getPlaybackUrl(s.image_key)));
    res.json({ slides: urls, count: urls.length });
  } catch (e) {
    console.error('[pptx slides] failed:', e.message);
    res.status(500).json({ error: 'Could not load this presentation — please try again.' });
  }
});

// Admin-only forced reconvert — same reasoning as convert-to-epub's own
// force flag: a bug fix in the conversion logic itself can't retroactively
// fix decks already converted under the old, broken behaviour, so this
// exists to redo one on request rather than requiring a re-upload.
app.post('/api/content/library/:id/convert-to-slides', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found.' });
    if (file.file_type !== PPTX_MIME) return res.status(400).json({ error: 'This file is not a presentation.' });
    if (!media.isConfigured()) return res.status(503).json({ error: 'Conversion is not available right now — please try again later.' });

    let pptxBuffer;
    if (file.storage_type === 'r2') {
      const obj = await media.getPublicObject(file.filename);
      const chunks = [];
      for await (const chunk of obj.Body) chunks.push(chunk);
      pptxBuffer = Buffer.concat(chunks);
    } else {
      pptxBuffer = fs.readFileSync(path.join(__dirname, 'uploads', file.filename));
    }
    const count = await convertAndStorePptxSlides(file.id, pptxBuffer);
    if (!count) return res.status(422).json({ error: 'This presentation could not be converted.' });
    res.json({ ok: true, count });
  } catch (e) {
    console.error('[convert-to-slides] failed:', e.message);
    res.status(500).json({ error: 'Conversion failed — please try again.' });
  }
});

// Per Bot 16 — shared by the quick text editor, and the mojibake
// scan/fix below, so both read and write the underlying file the exact
// same way regardless of which storage backend it's actually on.
async function readTextFileContent(file) {
  if (file.storage_type === 'r2') {
    const obj = await media.getPublicObject(file.filename);
    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
  }
  return fs.readFileSync(path.join(__dirname, 'uploads', file.filename), 'utf-8');
}
async function writeTextFileContent(file, content) {
  const buffer = Buffer.from(content, 'utf-8');
  if (file.storage_type === 'r2') {
    await media.putObject(file.filename, buffer, 'text/html');
  } else {
    fs.writeFileSync(path.join(__dirname, 'uploads', file.filename), buffer);
  }
}

// Per Bot 16 — fixes the classic WordPress-export mojibake: real UTF-8
// bytes (curly quotes, em-dashes, non-breaking spaces) that got
// misread as Windows-1252 somewhere in the export/import pipeline and
// re-saved that way. The 0x80–0x9F range is the only place Windows-1252
// actually differs from true Latin-1 (real Latin-1 has no printable
// characters there) — CP1252_HIGH is that specific mapping.
//
// Works per contiguous run of "suspicious" characters, not on the whole
// document at once — an earlier version processed the entire file as one
// atomic transform, which meant a single genuine non-Latin1 character
// anywhere in a long poem (a real accented letter, an intentional
// symbol) made the whole fix bail out silently, leaving every actual
// corruption in that file untouched. Scoping to runs means one
// unrelated character elsewhere can't block fixing the rest.
const CP1252_HIGH = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
  0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
  0x9E: 0x017E, 0x9F: 0x0178,
};
const CP1252_HIGH_REV = {};
for (const k in CP1252_HIGH) CP1252_HIGH_REV[CP1252_HIGH[k]] = parseInt(k);
const MOJIBAKE_SUSPICIOUS_CPS = [
  ...Array.from({ length: 0x100 - 0x80 }, (_, i) => 0x80 + i),
  ...Object.values(CP1252_HIGH),
];
const MOJIBAKE_RUN_RE = new RegExp(
  `[${MOJIBAKE_SUSPICIOUS_CPS.map(cp => '\\u' + cp.toString(16).padStart(4, '0')).join('')}]{1,}`, 'g'
);
function fixMojibakeRun(run) {
  const bytes = [];
  for (const ch of run) {
    const cp = ch.codePointAt(0);
    if (CP1252_HIGH_REV[cp] !== undefined) bytes.push(CP1252_HIGH_REV[cp]);
    else if (cp < 0x100) bytes.push(cp);
    else return null; // a genuine character CP1252 can't represent at all — leave this run untouched
  }
  try {
    const decoded = Buffer.from(bytes).toString('utf-8');
    return decoded.includes('\uFFFD') ? null : decoded; // replacement chars mean this run wasn't real double-encoding
  } catch (e) { return null; }
}
function fixMojibake(text) {
  let changed = false;
  let result = text.replace(MOJIBAKE_RUN_RE, (run) => {
    const fixed = fixMojibakeRun(run);
    if (fixed !== null && fixed !== run) { changed = true; return fixed; }
    return run;
  });
  // Orphaned "Â" — the lead byte of what was originally a two-byte UTF-8
  // sequence (almost always a non-breaking space), but whose second byte
  // was separately lost or normalised to a plain space somewhere
  // upstream, before this corruption even happened — there's no byte
  // sequence left to recover. Â never appears as genuine standalone
  // content in English prose, so it's safe to just drop it.
  const orphanRe = /\u00C2(?=[\s.,;:!?)]|$)/g;
  if (orphanRe.test(result)) { result = result.replace(orphanRe, ''); changed = true; }
  return changed ? result : null;
}

// Per Bot 16 — strips leftover WordPress-export boilerplate. Two ways a
// block/line can match:
//  1. Its whole text, once tags are stripped, is exactly one of the
//     known phrases Per identified.
//  2. It's structurally just a single link back to deepermindfulness.org
//     — whatever the link text actually says. This is what catches
//     wording variants ("Join our community" vs "Come join us" vs
//     whatever else was used across different export batches) without
//     needing every phrasing enumerated by hand — a standalone line
//     that's nothing but a link to their own site is essentially always
//     a nav/promo link, never genuine prose.
// Either way, this only ever removes a block/line whose ENTIRE content
// matches — never a block that merely contains a match alongside other
// content, since that's exactly the kind of guess that could quietly
// eat real material along with the boilerplate.
const BOILERPLATE_PHRASES = [
  'try deeper mindfulness community here',
  'free live and recorded mindfulness courses here',
  'join our mailing list',
  'click here for more poems',
  'free live and recorded courses',
  'free live and recorded course',
  'see more blogs here',
  'download the deeper mindfulness app',
].map(s => s.toLowerCase());
function plainTextOf(fragment) {
  return fragment.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
function isOwnSiteLinkOnly(rawFragment) {
  // Per Bot 16 — allows up to a few trailing plain-text characters after
  // the closing </a> (no tags, just letters) since real examples split a
  // word right at the link boundary — "...RECORDED Course</a>s" for
  // "Courses" being the one that surfaced. Still counts as "just a link"
  // for removal purposes; the href match is what actually gates this.
  const m = rawFragment.trim().match(/^<a\s+[^>]*href="([^"]*)"[^>]*>[\s\S]*?<\/a>\s*[a-z]{0,3}$/i);
  return !!(m && /deepermindfulness\.org/i.test(m[1]));
}
function isBoilerplateFragment(rawFragment) {
  return BOILERPLATE_PHRASES.includes(plainTextOf(rawFragment)) || isOwnSiteLinkOnly(rawFragment);
}
function stripKnownBoilerplate(html) {
  const removed = [];
  // Per Bot 16 — now also matches h1-h6, for headings like "Download the
  // Deeper Mindfulness App" that aren't inside a <p> or <div> at all.
  const blockRe = /<(p|div|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let result = html.replace(blockRe, (whole, tag, inner) => {
    if (isBoilerplateFragment(inner)) { removed.push(plainTextOf(inner) || '[link]'); return ''; }
    // Otherwise check line-by-line (split on <br>) — a block can hold
    // several distinct lines (e.g. two links stacked with <br> between
    // them, as in the actual imported files), and only some of those
    // lines may be boilerplate.
    const lines = inner.split(/<br\s*\/?>/i);
    if (lines.length < 2) return whole;
    const kept = [];
    let anyRemoved = false;
    for (const line of lines) {
      if (isBoilerplateFragment(line)) { removed.push(plainTextOf(line) || '[link]'); anyRemoved = true; }
      else kept.push(line);
    }
    if (!anyRemoved) return whole;
    if (!plainTextOf(kept.join(' '))) return ''; // every line was boilerplate — drop the whole block
    return `<${tag}>${kept.join('<br/>')}</${tag}>`;
  });

  // Per Bot 16 — WordPress "button block" wrappers (Download the App,
  // etc). Needs real depth-counting rather than a simple regex: these are
  // nested divs (wp-block-buttons > wp-block-button > a), and a naive
  // non-greedy match would stop at the FIRST </div> — the inner one — 
  // leaving the outer wrapper's closing tag dangling and unmatched in
  // the document. This walks forward counting opens/closes to find the
  // actual matching close, however deep the nesting goes.
  const openTagRe = /<div\s+class="wp-block-buttons"[^>]*>/gi;
  let out = '', lastIndex = 0, buttonBlocksRemoved = 0, m;
  while ((m = openTagRe.exec(result))) {
    const start = m.index;
    const tagRe = /<div\b[^>]*>|<\/div>/gi;
    tagRe.lastIndex = m.index + m[0].length;
    let depth = 1, endIdx = null, m2;
    while ((m2 = tagRe.exec(result))) {
      if (m2[0].toLowerCase().startsWith('<div')) depth++; else depth--;
      if (depth === 0) { endIdx = tagRe.lastIndex; break; }
    }
    if (endIdx === null) continue; // unbalanced — leave alone, don't guess
    out += result.slice(lastIndex, start);
    lastIndex = endIdx;
    buttonBlocksRemoved++;
    openTagRe.lastIndex = endIdx;
  }
  out += result.slice(lastIndex);
  if (buttonBlocksRemoved) result = out;

  if (removed.length || buttonBlocksRemoved) {
    if (buttonBlocksRemoved) removed.push(`${buttonBlocksRemoved} button block(s)`);
    return { html: result, removed };
  }
  return null;
}

// Per Bot 16 — dry run: never writes anything. Scopes to text/html only,
// same reasoning as the text editor above. Returns a snippet of context
// around the first actual change per file, not the whole document, so
// the admin preview stays readable regardless of how long the piece is.
// Per Bot 16 — read-only duplicate scan, same "review before touching
// anything" pattern as the mojibake scan above. Groups are ordered
// oldest-first within each cluster so the admin UI can default to
// recommending "keep the first, remove the rest" without guessing —
// though the actual choice is always left to whoever's reviewing it.
app.get('/api/admin/library/duplicates-scan', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const groups = db.findDuplicateLibraryFiles().map(g =>
      g.slice().sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    );
    res.json({ groups });
  } catch (e) {
    console.error('duplicates scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Per Bot 21 — domain migration check: searches course/lesson/library
// descriptions for hand-embedded links pointing at old WordPress-hosted
// paths, since that content was migrated as free-text/HTML and the R2
// file migration never touched anything living inside a description
// field. Defaults to "wp-content" rather than the bare domain name —
// deepermindfulness.org is the correct, still-in-use domain now, so
// searching for it would flag every legitimate current link too;
// wp-content is the actual WordPress-specific signal that would break
// if that old hosting is ever decommissioned. Read-only — a human
// needs to judge each hit, not an automated find/replace.
app.get('/api/admin/scan-domain-refs', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const term = (req.query.term || 'wp-content').trim();
    if (!term) return res.status(400).json({ error: 'Search term required.' });
    res.json({ results: db.scanDescriptionsForDomainRefs(term) });
  } catch (e) {
    console.error('domain-refs scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/library/mojibake-scan', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const candidates = db.getAllTextHtmlFiles();
    const results = [];
    const errors = [];
    for (const file of candidates) {
      try {
        const original = await readTextFileContent(file);
        let working = original;
        let mojibakeApplied = false;
        const fixed = fixMojibake(working);
        if (fixed !== null && fixed !== working) { working = fixed; mojibakeApplied = true; }
        const stripped = stripKnownBoilerplate(working);
        const removedPhrases = stripped ? stripped.removed : [];
        if (stripped) working = stripped.html;
        if (!mojibakeApplied && !removedPhrases.length) continue;
        // Find roughly where the first character-level change is (from the
        // mojibake fix), for a readable snippet — boilerplate removals are
        // reported separately below since they're whole blocks, not a
        // single point in the text a snippet view suits well.
        let diffAt = 0;
        while (diffAt < original.length && diffAt < working.length && original[diffAt] === working[diffAt]) diffAt++;
        const start = Math.max(0, diffAt - 60);
        results.push({
          id: file.id,
          title: file.title,
          before: original.slice(start, diffAt + 80),
          after: working.slice(start, diffAt + 80),
          removedPhrases,
        });
      } catch (e) {
        // Per Bot 16 — this used to only go to console.error, invisible
        // to the admin, so a read failure on every single file looked
        // identical to "genuinely found nothing." Now surfaced properly.
        console.error(`mojibake scan: could not read ${file.id} (${file.title}):`, e.message);
        errors.push({ id: file.id, title: file.title, error: e.message });
      }
    }
    res.json({ files: results, errors, scannedCount: candidates.length });
  } catch (e) {
    console.error('mojibake scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Per Bot 16 — actually applies the fix, only to the file ids given
// (whatever the admin left checked in the preview), re-running the exact
// same transform rather than trusting anything cached from the scan.
app.post('/api/admin/library/mojibake-fix', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { fileIds } = req.body;
    if (!Array.isArray(fileIds) || !fileIds.length) return res.status(400).json({ error: 'No files specified.' });
    let fixedCount = 0;
    const errors = [];
    const unverified = [];
    for (const id of fileIds) {
      const file = db.getLibraryFile(id);
      if (!file || file.file_type !== 'text/html') continue;
      try {
        const original = await readTextFileContent(file);
        let working = original;
        let changed = false;
        const fixed = fixMojibake(working);
        if (fixed !== null && fixed !== working) { working = fixed; changed = true; }
        const stripped = stripKnownBoilerplate(working);
        if (stripped) { working = stripped.html; changed = true; }
        if (!changed) continue;
        await writeTextFileContent(file, working);
        // Per Bot 16 — a claimed success here previously didn't actually
        // mean the file changed (Per hit this directly: told the fix
        // worked, but the mojibake was still there on re-checking).
        // Reading straight back after the write and comparing against
        // what was intended, rather than just trusting putObject/
        // writeFileSync didn't throw, catches that failure mode instead
        // of reporting a false success.
        const reread = await readTextFileContent(file);
        if (reread === working) {
          fixedCount++;
        } else {
          unverified.push(`${file.title}: write completed without error, but reading it back shows the old content — likely a caching layer in front of storage, or the write went somewhere other than what gets served.`);
        }
      } catch (e) {
        errors.push(`${file.title}: ${e.message}`);
      }
    }
    res.json({ fixedCount, errors, unverified });
  } catch (e) {
    console.error('mojibake fix error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Per Bot 16 — quick text-content editor (admin only): overwrites the
// underlying file in place, for stripping leftover header/footer
// boilerplate from content imported off the old website. Deliberately
// narrow — only ever touches text/html files (blog posts, poems), since
// that's a real, single-source-of-truth text file rather than something
// like a PDF or docx where "the text" isn't the same thing as "the file."
app.patch('/api/content/library/:id/text-content', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found.' });
    if (file.file_type !== 'text/html') return res.status(400).json({ error: 'This quick editor only works for HTML text content (blog posts, poems).' });
    const { content } = req.body;
    if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'Content is required.' });
    await writeTextFileContent(file, content);
    res.json({ ok: true });
  } catch (e) {
    console.error('text-content save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── EPUB resource proxy (Per Bot 14) — same tier check as playback-url
// above, but serves one internal file at a time from an unpacked book
// rather than a single presigned URL to the whole archive. Same-origin,
// so the reader's normal auth cookie covers every request automatically
// — no per-resource presigned URLs to juggle.
// ── Offline caching (Per Bot 51, Phase 1: audio, PDFs, poems/blogs, ebooks) ──
// Per's request: let the app itself cache content to the device for
// offline use (flights, remote signal-free locations), auto-updating
// the cached copy if the file changes — not a manual "download this
// file" the person has to manage.
//
// Why this needs its own route rather than reusing the existing
// playback-url flow: every existing audio/PDF URL (media.getPlaybackUrl)
// is a freshly-signed, short-lived R2 URL — a different string every
// single time it's requested. A Service Worker's cache is keyed on the
// exact request URL, so caching a signed URL today doesn't help when
// the app asks for a NEW signed URL tomorrow; the cache would never be
// found again. This route gives every file a permanent, stable URL
// instead (no signature, never changes) — proxying the actual bytes
// through this server rather than redirecting to R2 — which is what a
// Service Worker cache actually needs as a key.
//
// R2's own ETag is passed straight through as the HTTP ETag, so this
// gets real conditional-request support (a 304 Not Modified round-trip)
// for free — that's the mechanism "auto-update if the file changed"
// actually runs on: the service worker does a lightweight conditional
// check against this URL, and only re-downloads the full file if R2
// says the ETag has actually changed.
app.get('/api/content/library/:id/offline-stream', auth.requireAuthApi(['client','facilitator','admin']), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found.' });
    const userRec = req.user.role === 'client' ? db.getUser(req.user.id) : null;
    const userFlags = db.userFlagsFromRecord(userRec, req.user.role);
    const allowed = (req.user.role === 'facilitator' || req.user.role === 'admin')
      ? !file.archived
      : db.canAccessFile(file, userFlags, req.user.id);
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });
    if (file.storage_type !== 'r2') return res.status(400).json({ error: 'This file is not eligible for offline caching yet.' });

    const obj = await media.getPublicObject(file.filename);
    res.set('Content-Type', obj.ContentType || file.file_type || 'application/octet-stream');
    // Explicit Content-Length matters more here than it would for most
    // files — epub.js/JSZip need to know the EXACT total size to locate
    // a ZIP's central directory (which lives at a known offset from the
    // very end of the file). obj.ContentLength comes straight from R2's
    // own object metadata, so this was always available, just never
    // actually being sent.
    if (obj.ContentLength !== undefined) res.set('Content-Length', String(obj.ContentLength));
    // immutable — the ETag/conditional-request mechanism above is what
    // actually detects a real change, so the browser/service worker
    // never needs to re-ask "is this still good" on a timer.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    if (obj.ETag) res.set('ETag', obj.ETag);
    if (obj.LastModified) res.set('Last-Modified', new Date(obj.LastModified).toUTCString());
    obj.Body.pipe(res);
  } catch (e) {
    console.error('offline-stream error:', e.message);
    res.status(404).json({ error: 'File not found.' });
  }
});

// Every URL a file needs cached for genuinely complete offline use.
// Single-file types (audio, PDF, poem/blog HTML) are just the one
// offline-stream URL above. An EPUB book is many small files (each
// chapter, image, stylesheet, font) served individually via the
// existing epub-resource route below — which already has a stable,
// unsigned URL pattern, so it didn't need a new streaming route, just
// enumerating. That list comes from the book's own OPF manifest (the
// same file the EPUB reader itself already parses to know what's in
// the book), so this only ever lists resources that genuinely exist —
// not a guess at what a book "usually" contains. Shared by the
// per-file route below and by GET /api/client/offline-marks, which
// needs the same thing for every marked file at once.
async function buildOfflineManifest(file) {
  const urls = [];
  let approxBytes = 0;

  if (file.epub_opf_path) {
    const opfKey = `epub-unpacked/${file.id}/${file.epub_opf_path}`;
    const opfObj = await media.getPublicObject(opfKey);
    const opfXml = await streamToString(opfObj.Body);
    const opfDir = file.epub_opf_path.includes('/') ? file.epub_opf_path.slice(0, file.epub_opf_path.lastIndexOf('/') + 1) : '';
    const hrefs = [...opfXml.matchAll(/<item\b[^>]*\bhref="([^"]+)"/g)].map(m => m[1]);
    urls.push(`/api/content/library/${file.id}/epub-resource/${file.epub_opf_path}`);
    hrefs.forEach(h => {
      const decoded = decodeURIComponent(h);
      urls.push(`/api/content/library/${file.id}/epub-resource/${opfDir}${decoded}`);
    });
    approxBytes = null;
  } else if (file.storage_type === 'r2') {
    urls.push(`/api/content/library/${file.id}/offline-stream`);
    approxBytes = file.file_size || null;
  } else {
    throw new Error('This file is not eligible for offline caching yet.');
  }
  return { urls, approxBytes };
}
app.get('/api/content/library/:id/offline-manifest', auth.requireAuthApi(['client','facilitator','admin']), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found.' });
    const userRec = req.user.role === 'client' ? db.getUser(req.user.id) : null;
    const userFlags = db.userFlagsFromRecord(userRec, req.user.role);
    const allowed = (req.user.role === 'facilitator' || req.user.role === 'admin')
      ? !file.archived
      : db.canAccessFile(file, userFlags, req.user.id);
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });
    const { urls, approxBytes } = await buildOfflineManifest(file);
    res.json({ id: file.id, title: file.title, urls, approxBytes });
  } catch (e) {
    console.error('offline-manifest error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/content/library/:id/epub-resource/*', auth.requireAuthApi(['client','facilitator','admin']), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found.' });

    const userRec = req.user.role === 'client' ? db.getUser(req.user.id) : null;
    const userFlags = db.userFlagsFromRecord(userRec, req.user.role);
    const allowed = (req.user.role === 'facilitator' || req.user.role === 'admin')
      ? !file.archived
      : db.canAccessFile(file, userFlags, req.user.id);
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });
    if (!file.epub_opf_path) return res.status(404).json({ error: 'This book has not been unpacked for lazy loading yet.' });

    const relPath = req.params[0];
    const r2Key = `epub-unpacked/${file.id}/${relPath}`;
    const ext = (relPath.split('.').pop() || '').toLowerCase();
    const contentType = {
      xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html',
      css: 'text/css', js: 'application/javascript',
      opf: 'application/oebps-package+xml', ncx: 'application/x-dtbncx+xml', xml: 'application/xml',
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml',
      otf: 'font/otf', ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2',
    }[ext] || 'application/octet-stream';

    const obj = await media.getPublicObject(r2Key);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=3600');
    obj.Body.pipe(res);
  } catch (e) {
    console.error('epub-resource error:', e.message);
    res.status(404).json({ error: 'Resource not found.' });
  }
});

app.patch('/api/content/library/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    // If set, must be a real user account — never trust an arbitrary
    // user id straight from the request body onto a field that grants
    // access. Per Bot 24 — no longer restricted to is_client, so any
    // real person can be the one-to-one target, not just a facilitator's
    // Client.
    if (req.body.assigned_client_id) {
      const target = db.getUser(req.body.assigned_client_id);
      if (!target) return res.status(400).json({ error: 'That is not a valid person.' });
    }
    db.updateLibraryFile(req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/content/library/:id/usage', auth.requireAuthApi(['admin']), (req, res) => res.json(db.getFileUsage(req.params.id)));

// Per's request — replace a file's actual content in place, from a
// lesson's own file list, without the existing delete-and-re-upload
// workaround losing every course/lesson association and progress record
// pointing at it. Reuses the exact same PDF-auto-convert-on-upload logic
// already built for a fresh upload (see /api/content/library above) —
// a replacement PDF gets converted to EPUB exactly the same way a newly
// uploaded one does, rather than a second, separately-maintained copy of
// that logic that could quietly drift out of sync with it over time.
app.post('/api/content/library/:id/replace-file', auth.requireAuthApi(['admin']), upload.single('file'), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found.' });
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });

    let mainFilename, mainContentType = req.file.mimetype, originalPdfKey = null;
    const newBuffer = fs.readFileSync(req.file.path);

    if (req.file.mimetype === 'application/pdf' && media.isConfigured()) {
      try {
        const epubBuffer = await convertPdfToEpub(newBuffer, file.title, brand().name);
        if (epubBuffer) {
          const epubKey = `library-epubs/${uuidv4()}.epub`;
          const pdfKey = `library-pdfs/${uuidv4()}.pdf`;
          await media.putObject(epubKey, epubBuffer, 'application/epub+zip');
          await media.putObject(pdfKey, newBuffer, 'application/pdf');
          mainFilename = epubKey;
          mainContentType = 'application/epub+zip';
          originalPdfKey = pdfKey;
        }
      } catch (e) {
        console.error('[replace-file pdf conversion]', e.message);
      }
    }
    if (!mainFilename) {
      // Not a PDF, or conversion wasn't viable (e.g. a scanned PDF with
      // no real text layer) — stored as-is, same as any other plain
      // library upload.
      if (!media.isConfigured()) { fs.unlink(req.file.path, () => {}); return res.status(503).json({ error: 'File storage is not available right now — please try again later.' }); }
      const ext = path.extname(req.file.originalname) || '';
      mainFilename = `library-files/${uuidv4()}${ext}`;
      await media.putObject(mainFilename, newBuffer, req.file.mimetype);
    }
    fs.unlink(req.file.path, () => {});

    db.replaceLibraryFileContent(file.id, mainFilename, mainContentType, req.file.size, req.file.originalname, 'r2', originalPdfKey);
    // Per's report — replacing a file gave no feedback either way,
    // success or failure, so a real failure (e.g. the PDF-to-EPUB
    // conversion above silently falling back to storing the file as-is)
    // looked identical to nothing happening at all. converted tells the
    // client which actually occurred, so it can say so plainly instead
    // of just going quiet.
    res.json({ ok: true, converted: mainContentType === 'application/epub+zip' });
  } catch (e) {
    console.error('[replace-file]', e.message);
    res.status(500).json({ error: 'Could not replace this file — please try again.' });
  }
});

// ── Content tagging (Per Bot 14) — the library_file_tags table and its
// db.js functions have existed since Per Bot 13 (built for reusing the
// audio-playlist theme vocabulary across content types) but nothing ever
// exposed them as an editable admin UI until now. Powers both the file
// edit modal's tag chips and the themed practice shelves on the client
// Home screen.
app.get('/api/admin/tags', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getAllTags()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/content/library/:id/tags', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getFileTags(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/content/library/:id/tags', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const tag = (req.body.tag || '').trim().toLowerCase();
    if (!tag) return res.status(400).json({ error: 'Tag cannot be empty.' });
    db.addFileTag(req.params.id, tag);
    res.json({ ok: true, tags: db.getFileTags(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/content/library/:id/tags/:tag', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    db.removeFileTag(req.params.id, req.params.tag);
    res.json({ ok: true, tags: db.getFileTags(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/content/library/by-tag/:tag', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getFilesByTag(req.params.tag)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Breathing patterns (Per Bot 15) ── A simple guided breathing timer —
// Talk can launch one via a [[BREATHING:id]] marker (see resolveBreathingMarker
// above), or a person can open the timer directly and pick one themselves.
// Client-facing list is deliberately open to any logged-in role, same as
// the meditation timer's own content — nothing sensitive in a breathing
// pattern's name/phases/cycles.
app.get('/api/breathing-patterns', auth.requireAuthApi(['client', 'facilitator', 'admin']), (req, res) => {
  try { res.json(db.getBreathingPatterns()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/breathing-patterns', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getBreathingPatterns(true)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/breathing-patterns', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { name, situation, phases, defaultCycles, sortOrder } = req.body;
    if (!name || !Array.isArray(phases) || !phases.length) {
      return res.status(400).json({ error: 'name and a non-empty phases array are required.' });
    }
    const badPhase = phases.find(p => !['in', 'hold', 'out'].includes(p.type) || !Number.isFinite(p.seconds) || p.seconds <= 0);
    if (badPhase) return res.status(400).json({ error: 'Every phase needs type in/hold/out and a positive number of seconds.' });
    const id = (req.body.id || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || uuidv4();
    if (db.getBreathingPattern(id)) return res.status(400).json({ error: 'A pattern with that id already exists.' });
    db.createBreathingPattern(id, name.trim(), (situation || '').trim(), phases, defaultCycles || 6, sortOrder || 0);
    res.json({ id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/breathing-patterns/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    if (req.body.phases) {
      const badPhase = req.body.phases.find(p => !['in', 'hold', 'out'].includes(p.type) || !Number.isFinite(p.seconds) || p.seconds <= 0);
      if (badPhase) return res.status(400).json({ error: 'Every phase needs type in/hold/out and a positive number of seconds.' });
    }
    db.updateBreathingPattern(req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/breathing-patterns/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteBreathingPattern(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TEMPORARY — Per Bot 13, WordPress content migration ──
// Runs the blog-post import in-process (shares this server's own sql.js
// singleton), because running it as a separate `node import_....js` console
// process races against this server's next save() and silently loses the
// data — see the warning at the top of import_blog_posts_batch1.js.
// Safe to call more than once (skips anything already imported). Remove this
// route once the WordPress content migration is finished.
app.post('/api/admin/run-blog-import-batch1', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { runImport } = require('./import_blog_posts_batch1');
    const log = [];
    const result = await runImport((line) => { log.push(line); console.log(line); });
    res.json({ ...result, log });
  } catch (e) {
    console.error('blog import error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── TEMPORARY — Per Bot 13, "Being Here" course build ──
// Same in-process reasoning as the blog import route above.
app.post('/api/admin/run-being-here-import', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { runImport } = require('./import_being_here_course');
    const log = [];
    const result = await runImport((line) => { log.push(line); console.log(line); });
    res.json({ ...result, log });
  } catch (e) {
    console.error('being here import error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── TEMPORARY — Per Bot 13, "Being Here" audio narrations ──
// Fetches live from deepermindfulness.org — only works where real internet
// access exists (production), same in-process reasoning as the routes above.
app.post('/api/admin/run-being-here-audio-import', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { runImport } = require('./import_being_here_audio');
    const log = [];
    const result = await runImport((line) => { log.push(line); console.log(line); });
    res.json({ ...result, log });
  } catch (e) {
    console.error('being here audio import error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── TEMPORARY — Per Bot 13, one-off fix for the visibility bug in commits 37/41 ──
app.post('/api/admin/fix-being-here-visibility', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { runFix } = require('./import_being_here_fix_visibility');
    const log = [];
    const result = await runFix((line) => { log.push(line); console.log(line); });
    res.json({ ...result, log });
  } catch (e) {
    console.error('being here visibility fix error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── TEMPORARY — Per Bot 13, one-off backfill: mark existing Being Here text poems mandatory ──
app.post('/api/admin/fix-being-here-mandatory', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { runBackfill } = require('./import_being_here_mandatory_backfill');
    const log = [];
    const result = await runBackfill((line) => { log.push(line); console.log(line); });
    res.json({ ...result, log });
  } catch (e) {
    console.error('being here mandatory backfill error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── TEMPORARY — Per Bot 13, one-off swap: audio mandatory, text optional for Being Here ──
app.post('/api/admin/fix-being-here-mandatory-swap', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { runSwap } = require('./import_being_here_mandatory_swap');
    const log = [];
    const result = await runSwap((line) => { log.push(line); console.log(line); });
    res.json({ ...result, log });
  } catch (e) {
    console.error('being here mandatory swap error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── TEMPORARY — Per Bot 13, "Listen and Learn Mindfulness" import ──
// Fetches live from a WordPress.com staging domain — only works where real
// internet access exists (production), same in-process reasoning as the
// other Per Bot 13 import routes.
app.post('/api/admin/run-listen-and-learn-import', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { runImport } = require('./import_listen_and_learn');
    const log = [];
    const result = await runImport((line) => { log.push(line); console.log(line); });
    res.json({ ...result, log });
  } catch (e) {
    console.error('listen and learn import error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Deeper Mindfulness course import (Per Bot 14) ──
// Backgrounded rather than awaited in the request handler — this import
// fetches ~80 files including full lesson videos, sequentially, which
// comfortably exceeds Railway's gateway timeout if held open on a single
// HTTP request (the original synchronous version 502'd with "upstream
// error" partway through, even though the import itself may have kept
// running server-side). POST now just starts the job and returns
// immediately; poll the GET status route below for progress and the
// final result. In-memory job state only — fine for a one-off admin
// trigger, and consistent with sql.js already being in-memory per process.
let deeperMindfulnessImportJob = null;
app.post('/api/admin/run-deeper-mindfulness-import', auth.requireAuthApi(['admin']), (req, res) => {
  if (deeperMindfulnessImportJob && !deeperMindfulnessImportJob.done) {
    return res.json({ started: false, alreadyRunning: true, job: deeperMindfulnessImportJob });
  }
  deeperMindfulnessImportJob = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  const job = deeperMindfulnessImportJob;
  const { runImport } = require('./import_deeper_mindfulness_course');
  runImport((line) => { job.log.push(line); console.log(line); })
    .then((result) => { job.result = result; job.done = true; })
    .catch((e) => { console.error('deeper mindfulness import error:', e.message); job.error = e.message; job.done = true; });
  res.json({ started: true, job });
});
app.get('/api/admin/run-deeper-mindfulness-import/status', auth.requireAuthApi(['admin']), (req, res) => {
  if (!deeperMindfulnessImportJob) return res.status(404).json({ error: 'No import has been started yet.' });
  res.json(deeperMindfulnessImportJob);
});

// ── Mindfulness For Life course import (Per Bot 14) ──
// Backgrounded from the start — see the comment on the Deeper Mindfulness
// route above for why (Railway gateway timeout on long sequential
// video-file imports held open on a single HTTP request).
let mflImportJob = null;
app.post('/api/admin/run-mindfulness-for-life-import', auth.requireAuthApi(['admin']), (req, res) => {
  if (mflImportJob && !mflImportJob.done) {
    return res.json({ started: false, alreadyRunning: true, job: mflImportJob });
  }
  mflImportJob = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  const job = mflImportJob;
  const { runImport } = require('./import_mindfulness_for_life_course');
  runImport((line) => { job.log.push(line); console.log(line); })
    .then((result) => { job.result = result; job.done = true; })
    .catch((e) => { console.error('mindfulness for life import error:', e.message); job.error = e.message; job.done = true; });
  res.json({ started: true, job });
});
app.get('/api/admin/run-mindfulness-for-life-import/status', auth.requireAuthApi(['admin']), (req, res) => {
  if (!mflImportJob) return res.status(404).json({ error: 'No import has been started yet.' });
  res.json(mflImportJob);
});

// ── Fix: Deeper Mindfulness lesson notes (Per Bot 14) ──
// See fix_deeper_mindfulness_lesson_notes.js for the full story — moves
// each lesson's notes+poem content out of lessons.description (only ever
// shown as a small blurb, not a real page) into a proper text/html
// library file, same rendering pattern as the Being Here poems.
let dmNotesFixJob = null;
app.post('/api/admin/fix-deeper-mindfulness-notes', auth.requireAuthApi(['admin']), (req, res) => {
  if (dmNotesFixJob && !dmNotesFixJob.done) {
    return res.json({ started: false, alreadyRunning: true, job: dmNotesFixJob });
  }
  dmNotesFixJob = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  const job = dmNotesFixJob;
  const { runFix } = require('./fix_deeper_mindfulness_lesson_notes');
  runFix((line) => { job.log.push(line); console.log(line); })
    .then((result) => { job.result = result; job.done = true; })
    .catch((e) => { console.error('DM notes fix error:', e.message); job.error = e.message; job.done = true; });
  res.json({ started: true, job });
});
app.get('/api/admin/fix-deeper-mindfulness-notes/status', auth.requireAuthApi(['admin']), (req, res) => {
  if (!dmNotesFixJob) return res.status(404).json({ error: 'No fix run has been started yet.' });
  res.json(dmNotesFixJob);
});

// ── Fix: Deeper Mindfulness — drop docx Handout, keep PDF (Per Bot 14) ──
app.post('/api/admin/fix-dm-remove-docx-handout', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { runFix } = require('./fix_dm_remove_docx_handout');
    const log = [];
    const result = await runFix((line) => { log.push(line); console.log(line); });
    res.json({ ...result, log });
  } catch (e) {
    console.error('DM docx handout removal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Introduction to Mindfulness course import (Per Bot 14) ──
let imfnImportJob = null;
app.post('/api/admin/run-introduction-to-mindfulness-import', auth.requireAuthApi(['admin']), (req, res) => {
  if (imfnImportJob && !imfnImportJob.done) {
    return res.json({ started: false, alreadyRunning: true, job: imfnImportJob });
  }
  imfnImportJob = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  const job = imfnImportJob;
  const { runImport } = require('./import_introduction_to_mindfulness_course');
  runImport((line) => { job.log.push(line); console.log(line); })
    .then((result) => { job.result = result; job.done = true; })
    .catch((e) => { console.error('introduction to mindfulness import error:', e.message); job.error = e.message; job.done = true; });
  res.json({ started: true, job });
});
app.get('/api/admin/run-introduction-to-mindfulness-import/status', auth.requireAuthApi(['admin']), (req, res) => {
  if (!imfnImportJob) return res.status(404).json({ error: 'No import has been started yet.' });
  res.json(imfnImportJob);
});

// ── Introduction to Micro Moves course import (Per Bot 14) ──
let immImportJob = null;
app.post('/api/admin/run-intro-to-micro-moves-import', auth.requireAuthApi(['admin']), (req, res) => {
  if (immImportJob && !immImportJob.done) {
    return res.json({ started: false, alreadyRunning: true, job: immImportJob });
  }
  immImportJob = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  const job = immImportJob;
  const { runImport } = require('./import_intro_to_micro_moves_course');
  runImport((line) => { job.log.push(line); console.log(line); })
    .then((result) => { job.result = result; job.done = true; })
    .catch((e) => { console.error('intro to micro moves import error:', e.message); job.error = e.message; job.done = true; });
  res.json({ started: true, job });
});
app.get('/api/admin/run-intro-to-micro-moves-import/status', auth.requireAuthApi(['admin']), (req, res) => {
  if (!immImportJob) return res.status(404).json({ error: 'No import has been started yet.' });
  res.json(immImportJob);
});

// ── MMPM practice audio import (Per Bot 14) ──
let mmpmPracticesJob = null;
app.post('/api/admin/run-mmpm-practices-import', auth.requireAuthApi(['admin']), (req, res) => {
  if (mmpmPracticesJob && !mmpmPracticesJob.done) {
    return res.json({ started: false, alreadyRunning: true, job: mmpmPracticesJob });
  }
  mmpmPracticesJob = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  const job = mmpmPracticesJob;
  const { runImport } = require('./import_mmpm_practices');
  runImport((line) => { job.log.push(line); console.log(line); })
    .then((result) => { job.result = result; job.done = true; })
    .catch((e) => { console.error('mmpm practices import error:', e.message); job.error = e.message; job.done = true; });
  res.json({ started: true, job });
});
app.get('/api/admin/run-mmpm-practices-import/status', auth.requireAuthApi(['admin']), (req, res) => {
  if (!mmpmPracticesJob) return res.status(404).json({ error: 'No import has been started yet.' });
  res.json(mmpmPracticesJob);
});

// ── Admin scripts registry (Per Bot 30) ── Generic replacement for the
// one-off "Run X import" buttons that kept accumulating on Settings >
// Maintenance (meditation tags, tag casing cleanup, and whatever comes
// after). Adding a new one-time script from here on means: write the
// script as a module exporting async runImport(log), add one line to
// ADMIN_SCRIPTS below — no new route, no new button, no new poll loop.
// Jobs are in-memory (not persisted across a restart), same as every
// import job before this — a script is expected to be run once, watched
// to completion, and then just sit there as "already run" until the
// process restarts; that's an acceptable trade for not needing a new DB
// table just to remember button-click history.
const ADMIN_SCRIPTS = [
  // Per's cleanup — the five scripts that used to live here
  // (meditation-tags-import, tag-casing-cleanup,
  // set-practices-member-visibility, import-poems-for-the-soul,
  // reconvert-pdf-epubs) have all completed their one-time job and were
  // removed, along with their .js files and any manifest data, in the
  // same round this comment was added. Add future one-time scripts
  // here: { id, label, description, module }. The module just needs to
  // export async runImport(log) — see git history for the removed
  // entries above as a template if needed.
];
const adminScriptJobs = {}; // id -> job, live progress during THIS process's lifetime only

app.get('/api/admin/scripts', auth.requireAuthApi(['admin']), (req, res) => {
  const persisted = db.getAdminScriptStates();
  res.json(ADMIN_SCRIPTS
    .filter(s => !(persisted[s.id] && persisted[s.id].dismissed))
    .map(s => {
      const liveJob = adminScriptJobs[s.id];
      const saved = persisted[s.id];
      // Per Bot 43 — live in-memory job (this process, this run) wins
      // while something's actually in flight or just finished; once the
      // process restarts and that's gone, fall back to what was
      // persisted last time anything ran, so the status a person
      // actually did stays visible across a deploy instead of quietly
      // reverting to "Not run yet".
      const job = liveJob || (saved && saved.last_status ? {
        done: true,
        result: saved.last_result ? JSON.parse(saved.last_result) : null,
        error: saved.last_error || null,
        startedAt: saved.last_run_at,
      } : null);
      return { id: s.id, label: s.label, description: s.description, job };
    }));
});
app.post('/api/admin/scripts/:id/run', auth.requireAuthApi(['admin']), (req, res) => {
  const script = ADMIN_SCRIPTS.find(s => s.id === req.params.id);
  if (!script) return res.status(404).json({ error: 'Unknown script.' });
  const existing = adminScriptJobs[script.id];
  if (existing && !existing.done) {
    return res.json({ started: false, alreadyRunning: true, job: existing });
  }
  const job = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  adminScriptJobs[script.id] = job;
  const { runImport } = require(script.module);
  runImport((line) => { job.log.push(line); console.log(`[${script.id}] ${line}`); })
    .then((result) => {
      job.result = result; job.done = true;
      db.upsertAdminScriptState(script.id, { status: 'done', result });
    })
    .catch((e) => {
      console.error(`${script.id} error:`, e.message);
      job.error = e.message; job.done = true;
      db.upsertAdminScriptState(script.id, { status: 'failed', error: e.message });
    });
  res.json({ started: true, job });
});
app.get('/api/admin/scripts/:id/status', auth.requireAuthApi(['admin']), (req, res) => {
  const job = adminScriptJobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'No run has been started yet.' });
  res.json(job);
});
// Per Bot 43 — "delete" a script row. Doesn't touch the script's file or
// its ADMIN_SCRIPTS entry (that's code, not data — an actual delete
// would mean removing it from the array in a future deploy), just hides
// it from this list from now on. Easy to bring back by flipping
// dismissed off directly in the DB if a "one-off" ever needs a rerun
// after all.
app.delete('/api/admin/scripts/:id', auth.requireAuthApi(['admin']), (req, res) => {
  const script = ADMIN_SCRIPTS.find(s => s.id === req.params.id);
  if (!script) return res.status(404).json({ error: 'Unknown script.' });
  db.setAdminScriptDismissed(req.params.id, true);
  res.json({ ok: true });
});

// ── Standalone poems import (Per Bot 14) ──
let standalonePoemsJob = null;
app.post('/api/admin/run-standalone-poems-import', auth.requireAuthApi(['admin']), (req, res) => {
  if (standalonePoemsJob && !standalonePoemsJob.done) {
    return res.json({ started: false, alreadyRunning: true, job: standalonePoemsJob });
  }
  standalonePoemsJob = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  const job = standalonePoemsJob;
  const { runImport } = require('./import_standalone_poems');
  runImport((line) => { job.log.push(line); console.log(line); })
    .then((result) => { job.result = result; job.done = true; })
    .catch((e) => { console.error('standalone poems import error:', e.message); job.error = e.message; job.done = true; });
  res.json({ started: true, job });
});
app.get('/api/admin/run-standalone-poems-import/status', auth.requireAuthApi(['admin']), (req, res) => {
  if (!standalonePoemsJob) return res.status(404).json({ error: 'No import has been started yet.' });
  res.json(standalonePoemsJob);
});

// ── EPUB unpacking for lazy reading (Per Bot 14) ──
let epubUnpackJob = null;
app.post('/api/admin/unpack-epub-books', auth.requireAuthApi(['admin']), (req, res) => {
  if (epubUnpackJob && !epubUnpackJob.done) {
    return res.json({ started: false, alreadyRunning: true, job: epubUnpackJob });
  }
  epubUnpackJob = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  const job = epubUnpackJob;
  const { runUnpack } = require('./unpack_epub_book');
  runUnpack((line) => { job.log.push(line); console.log(line); }, req.body?.fileId || null)
    .then((result) => { job.result = result; job.done = true; })
    .catch((e) => { console.error('epub unpack error:', e.message); job.error = e.message; job.done = true; });
  res.json({ started: true, job });
});
app.get('/api/admin/unpack-epub-books/status', auth.requireAuthApi(['admin']), (req, res) => {
  if (!epubUnpackJob) return res.status(404).json({ error: 'No unpack job has been started yet.' });
  res.json(epubUnpackJob);
});

// ── R2 orphan check (Per Bot 15) — read-only diagnostic for the rename-route
// filename-corruption bug fixed in Per Bot 14. Backgrounded like every other
// admin action that touches more than a handful of files (checks against R2
// over the network, one HeadObject per file, so easily the slowest of the
// batch jobs so far — Railway's gateway would 502 well before this finishes
// synchronously for a library this size).
let r2SweepJob = null;
app.post('/api/admin/sweep-r2-orphans', auth.requireAuthApi(['admin']), (req, res) => {
  if (r2SweepJob && !r2SweepJob.done) {
    return res.json({ started: false, alreadyRunning: true, job: r2SweepJob });
  }
  r2SweepJob = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  const job = r2SweepJob;
  const { runSweep } = require('./sweep_r2_orphan_check');
  runSweep((line) => { job.log.push(line); console.log(line); })
    .then((result) => { job.result = result; job.done = true; })
    .catch((e) => { console.error('r2 orphan sweep error:', e.message); job.error = e.message; job.done = true; });
  res.json({ started: true, job });
});
app.get('/api/admin/sweep-r2-orphans/status', auth.requireAuthApi(['admin']), (req, res) => {
  if (!r2SweepJob) return res.status(404).json({ error: 'No sweep job has been started yet.' });
  res.json(r2SweepJob);
});

// ── Fix: blog/whitepaper visibility (Per Bot 14) ──
app.post('/api/admin/fix-blog-visibility', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { runFix } = require('./fix_blog_visibility');
    const log = [];
    const result = await runFix((line) => { log.push(line); console.log(line); });
    res.json({ ...result, log });
  } catch (e) {
    console.error('blog visibility fix error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Fix: poem Fusion Builder shortcodes (Per Bot 14) ──
let poemShortcodeFixJob = null;
app.post('/api/admin/fix-poem-shortcodes', auth.requireAuthApi(['admin']), (req, res) => {
  if (poemShortcodeFixJob && !poemShortcodeFixJob.done) {
    return res.json({ started: false, alreadyRunning: true, job: poemShortcodeFixJob });
  }
  poemShortcodeFixJob = { done: false, log: [], result: null, error: null, startedAt: new Date().toISOString() };
  const job = poemShortcodeFixJob;
  const { runFix } = require('./fix_poem_shortcodes');
  runFix((line) => { job.log.push(line); console.log(line); })
    .then((result) => { job.result = result; job.done = true; })
    .catch((e) => { console.error('poem shortcode fix error:', e.message); job.error = e.message; job.done = true; });
  res.json({ started: true, job });
});
app.get('/api/admin/fix-poem-shortcodes/status', auth.requireAuthApi(['admin']), (req, res) => {
  if (!poemShortcodeFixJob) return res.status(404).json({ error: 'No fix run has been started yet.' });
  res.json(poemShortcodeFixJob);
});

// ── TEMPORARY — Per Bot 13, plain-English lesson descriptions for Being Here ──
app.post('/api/admin/fix-being-here-lesson-descriptions', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { runUpdate } = require('./import_being_here_lesson_descriptions');
    const log = [];
    const result = await runUpdate((line) => { log.push(line); console.log(line); });
    res.json({ ...result, log });
  } catch (e) {
    console.error('being here lesson descriptions error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── TEMPORARY — Per Bot 13, plain lesson titles for the poem-a-day course ──
app.post('/api/admin/fix-being-here-lesson-titles', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { runRename } = require('./import_being_here_lesson_titles');
    const log = [];
    const result = await runRename((line) => { log.push(line); console.log(line); });
    res.json({ ...result, log });
  } catch (e) {
    console.error('being here lesson titles error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/content/library/:id/rename', auth.requireAuthApi(['admin']), (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename required.' });
  const file = db.getLibraryFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found.' });

  // R2-stored files: `filename` in the database IS the actual storage
  // key (e.g. library/{uuid}.epub) — it's meant to be an opaque,
  // permanent reference, never a user-facing name. This route used to
  // overwrite it unconditionally, which silently orphaned the real R2
  // object under its real key while the database pointed at a name that
  // was never uploaded there — exactly what happened to a book file this
  // session ("the specified key does not exist" once something tried to
  // actually fetch it). The display name people actually see is `title`,
  // already editable through the normal save — nothing to rename here.
  if (file.storage_type === 'r2') {
    return res.json({ ok: true, filename: file.filename, note: 'R2 files keep their storage key — only the title changes.' });
  }

  const ext = path.extname(file.filename);
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_') + ext;
  try {
    const oldPath = path.join(__dirname, 'uploads', file.filename);
    const newPath = path.join(__dirname, 'uploads', safe);
    if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
    db.renameLibraryFile(req.params.id, safe);
    res.json({ ok: true, filename: safe });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/content/library/:id', auth.requireAuthApi(['admin']), async (req, res) => {
  const file = db.getLibraryFile(req.params.id);
  if (file) {
    if (file.storage_type === 'r2') {
      try { await media.deleteObject(file.filename); } catch (e) { console.error('R2 delete error:', e.message); }
    } else {
      try { fs.unlinkSync(path.join(__dirname, 'uploads', file.filename)); } catch {}
    }
  }
  db.deleteLibraryFile(req.params.id); res.json({ ok: true });
});

// ── Bulk actions on library files (admin content list/grid toggle) ──
app.post('/api/content/library/bulk-delete', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required.' });
    for (const id of ids) {
      const file = db.getLibraryFile(id);
      if (file) {
        if (file.storage_type === 'r2') {
          try { await media.deleteObject(file.filename); } catch (e) { console.error('R2 delete error:', e.message); }
        } else {
          try { fs.unlinkSync(path.join(__dirname, 'uploads', file.filename)); } catch {}
        }
      }
      db.deleteLibraryFile(id);
    }
    res.json({ ok: true, deleted: ids.length });
  } catch (e) {
    console.error('bulk-delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/content/library/bulk-archive', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { ids, archived } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required.' });
    ids.forEach(id => db.archiveLibraryFile(id, !!archived));
    res.json({ ok: true, updated: ids.length });
  } catch (e) {
    console.error('bulk-archive error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/content/library/bulk-visibility', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { ids, visibility } = req.body;
    const allowed = ['registered','member','client','facilitator','admin'];
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required.' });
    if (!allowed.includes(visibility)) return res.status(400).json({ error: 'Invalid visibility value.' });
    ids.forEach(id => db.updateLibraryFile(id, { visibility }));
    res.json({ ok: true, updated: ids.length });
  } catch (e) {
    console.error('bulk-visibility error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/content/courses', auth.requireAuthApi(['admin','facilitator']), (req, res) => res.json(db.getAllCourses(req.query)));
app.post('/api/content/courses', auth.requireAuthApi(['admin']), (req, res) => {
  const { title, description, categoryId, subcategoryId, lessons, skinId, visibility, accessStatus } = req.body;
  if (!title || !categoryId) return res.status(400).json({ error: 'Title and category required.' });
  const courseId = uuidv4();
  db.createCourse(courseId, title, description, categoryId, subcategoryId, false, skinId || null, visibility || 'client', accessStatus || 'visible');
  // Per Bot 16 — a lesson's own visibility (if given) still wins; the
  // course's visibility is only the default a new lesson pre-fills with.
  // A new lesson always starts 'visible' regardless of the course's own
  // access_status — locking/hiding a course doesn't retroactively lock/
  // hide its lessons individually, the course-level check already covers
  // that at read time.
  if (lessons?.length) lessons.forEach(l => db.createLesson(uuidv4(), courseId, l.number, l.title, l.description || '', l.visibility || visibility || 'client', 'visible'));
  res.json({ id: courseId });
});
app.get('/api/content/courses/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const c = db.getCourse(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});
// Edit — was missing; create and delete existed but there was no way to
// change a course's title/description/category after the fact.
app.patch('/api/content/courses/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { title, description, categoryId, subcategoryId, guestVisible, skinId, visibility, accessStatus } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
    db.updateCourse(req.params.id, title.trim(), description, categoryId || null, subcategoryId || null, !!guestVisible, skinId || null, visibility, accessStatus);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/content/courses/:id', auth.requireAuthApi(['admin']), (req, res) => { db.deleteCourse(req.params.id); res.json({ ok: true }); });
// Curated courses shelf on the calm landing screen (Per Bot 28) — a small
// dedicated toggle rather than routing through the main course-update
// endpoint above, which requires a full title/description payload and
// would be awkward to call for a single-field flip.
app.patch('/api/content/courses/:id/featured', auth.requireAuthApi(['admin']), (req, res) => {
  db.setCourseFeatured(req.params.id, !!req.body.featured);
  res.json({ ok: true });
});
// Per Bot 17 — carousel ordering. sortOrder is a plain integer, lower
// shows first; the up/down reorder panel swaps two courses' values at a
// time rather than renumbering the whole list, so this stays a single
// small write per click rather than a bulk operation.
app.patch('/api/content/courses/:id/sort-order', auth.requireAuthApi(['admin']), (req, res) => {
  db.setCourseSortOrder(req.params.id, parseInt(req.body.sortOrder, 10) || 0);
  res.json({ ok: true });
});
// Same query the Home carousel itself uses (db.getFeaturedCourses) — so
// this panel is always showing exactly what would actually appear, in
// the order it would actually appear, not a separate approximation of it.
app.get('/api/admin/courses/carousel-order', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getFeaturedCourses());
});
// Sequencing (Per Bot 13) — enforceLessonSequence locks Lesson N+1 until
// Lesson N is complete; enforceFileSequence is the course-wide default for
// file-order locking within a lesson (individual lessons can override it,
// see the lessons/:id/file-sequence route below). Both default off.
app.patch('/api/content/courses/:id/sequence', auth.requireAuthApi(['admin']), (req, res) => {
  db.setCourseSequenceFlags(req.params.id, !!req.body.enforceLessonSequence, !!req.body.enforceFileSequence);
  res.json({ ok: true });
});

// Per Bot 18 — course tier-hiding. requiredTier: null/''/undefined clears
// the requirement entirely (open to everyone, today's behaviour); 0-3 sets
// Explorer through Member 3 as the floor.
app.patch('/api/content/courses/:id/tier-gating', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    db.setCourseTierGating(req.params.id, req.body.requiredTier, !!req.body.hideWhenLocked);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Per Bot 18 — one-off backfill, run once from the browser console:
// fetch('/api/content/courses/backfill-sequence-defaults',{method:'POST'}).then(r=>r.json()).then(console.log)
app.post('/api/content/courses/backfill-sequence-defaults', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json({ ok: true, updated: db.backfillCourseSequenceDefaults() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/content/courses/:id/lessons', auth.requireAuthApi(['admin','facilitator']), (req, res) => res.json(db.getLessonsForCourse(req.params.id)));
// override: null (inherit the course default), true (force file sequence
// on for this lesson), or false (force off) — sent as 'null'/'true'/'false'
// strings from a tri-state select, parsed here.
app.patch('/api/content/lessons/:id/file-sequence', auth.requireAuthApi(['admin']), (req, res) => {
  const raw = req.body.override;
  const override = raw === null || raw === 'null' ? null : (raw === true || raw === 'true') ? 1 : 0;
  db.setLessonFileSequenceOverride(req.params.id, override);
  res.json({ ok: true });
});
app.patch('/api/content/lesson-file-refs/:id/mandatory', auth.requireAuthApi(['admin']), (req, res) => {
  db.setLessonFileRefMandatory(req.params.id, !!req.body.mandatory);
  res.json({ ok: true });
});
app.patch('/api/content/lesson-file-refs/:id/free-preview', auth.requireAuthApi(['admin']), (req, res) => {
  db.setLessonFileRefFreePreview(req.params.id, !!req.body.freePreview);
  res.json({ ok: true });
});
// Per Bot 15f — reorder a file within its lesson, one step at a time
// (up/down), rather than a full drag-and-drop reorder — the file list is
// a wrapped chip row, not a natural drag target, so simple step buttons
// are both easier to build reliably and easier to use precisely.
app.patch('/api/content/lesson-file-refs/:id/move', auth.requireAuthApi(['admin']), (req, res) => {
  const { direction } = req.body;
  if (direction !== 'up' && direction !== 'down') return res.status(400).json({ error: "direction must be 'up' or 'down'." });
  db.moveLessonFileRef(req.params.id, direction);
  res.json({ ok: true });
});
// Per's request — move a file to a different lesson (e.g. out of the
// auto-organize "Reference" bucket and into a real numbered session).
// Distinct from the up/down route just above, which only ever reorders a
// file within its own lesson.
app.patch('/api/content/lesson-file-refs/:id/move-to-lesson', auth.requireAuthApi(['admin']), (req, res) => {
  const { lessonId } = req.body;
  if (!lessonId) return res.status(400).json({ error: 'lessonId required.' });
  db.moveLessonFileRefToLesson(req.params.id, lessonId);
  res.json({ ok: true });
});
// Per Bot 15g — drag-and-drop reorder: the whole new order in one call.
app.patch('/api/content/lessons/:id/files/reorder', auth.requireAuthApi(['admin']), (req, res) => {
  if (!Array.isArray(req.body.refIds)) return res.status(400).json({ error: 'refIds array required.' });
  db.reorderLessonFileRefs(req.params.id, req.body.refIds);
  res.json({ ok: true });
});
// "All" / "None" bulk toggles — set every file in one lesson, or every
// file across the whole course, in a single call.
app.post('/api/content/lessons/:id/mandatory-all', auth.requireAuthApi(['admin']), (req, res) => {
  db.setAllFileRefsMandatoryForLesson(req.params.id, !!req.body.mandatory);
  res.json({ ok: true });
});
app.post('/api/content/courses/:id/mandatory-all', auth.requireAuthApi(['admin']), (req, res) => {
  db.setAllFileRefsMandatoryForCourse(req.params.id, !!req.body.mandatory);
  res.json({ ok: true });
});
// Per Bot 43 — Per's observation: every FELT lesson (Finding Calm etc.)
// follows the same real, established file order — the session
// document/PDF first, then Introduction, then the main Practice, then
// the Poem, then the Daily Top-up — confirmed directly against Sessions
// 1-4's actual stored order. Neither place that adds files to a lesson
// (creating a lesson with a batch of files, or adding one file to a
// lesson that already exists) has ever placed files by what they
// actually are — one just used whatever order the browser happened to
// queue them in, the other always appended to the very end regardless
// of file type. Either can land in the right order by coincidence (e.g.
// if files were queued in a sensible order to begin with) but neither
// is actually enforcing it, so it isn't reliable. This infers a rank
// from the title text itself and both routes below now sort/insert by
// it instead of by upload order — matching the real pattern rather than
// hoping to land on it. Genuinely unrecognised titles fall through to
// the end (rank 99), same as today's behaviour, rather than causing an
// error.
function inferFileOrderRank(title) {
  const t = (title || '').toLowerCase();
  if (/\bintroduction\b/.test(t)) return 1;
  if (/\bpractice\b/.test(t)) return 2;
  if (/\bpoem\b/.test(t)) return 3;
  if (/\bdaily\s*top[\s-]*up\b/.test(t)) return 4;
  // A session's own document/PDF has no further descriptor beyond the
  // session number itself (e.g. "Finding_Calm_v2_Session5") — checked
  // last, after every more-specific keyword above has had a chance to
  // match, so a title like "Session 5 Introduction" doesn't fall
  // through to this rather than matching "introduction" above.
  if (/session/.test(t)) return 0;
  return 99;
}
app.post('/api/content/lessons', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { courseId, lessonNumber, title, visibility, accessStatus, fileIds } = req.body;
    // NOTE: lessonNumber can legitimately be 0 (e.g. an intro/overview
    // lesson meant to sort before Lesson 1) — checking truthiness here
    // would silently reject "0" as if it were missing, so check for
    // actual absence instead.
    if (!courseId || lessonNumber === undefined || lessonNumber === null || lessonNumber === '' || !title) {
      return res.status(400).json({ error: 'Missing fields.' });
    }
    const lessonId = uuidv4();
    db.createLesson(lessonId, courseId, parseInt(lessonNumber), title, '', visibility || 'client', accessStatus || 'visible');
    if (fileIds?.length) {
      // Per Bot 43 — sort by inferred rank (title text) before assigning
      // sort_order, rather than trusting fileIds' own order (whatever
      // order the browser happened to queue the upload in). A stable
      // sort keeps files of the same rank — e.g. two files that both
      // fell through to "unrecognised" — in their original relative
      // order rather than shuffling them.
      const ranked = fileIds.map((fid, i) => ({ fid, i, rank: inferFileOrderRank((db.getLibraryFile(fid) || {}).title) }));
      ranked.sort((a, b) => a.rank - b.rank || a.i - b.i);
      ranked.forEach((r, i) => db.addLessonFileRef(uuidv4(), lessonId, r.fid, i));
    }
    res.json({ id: lessonId });
  } catch (e) {
    console.error('create lesson error:', e);
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/content/lessons/:id/files', auth.requireAuthApi(['admin','facilitator']), (req, res) => res.json(db.getFilesForLesson(req.params.id)));
// Edit — same gap as courses: create and delete existed, edit didn't.
app.patch('/api/content/lessons/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { lessonNumber, title, description, visibility, accessStatus } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
    // Same falsy-zero issue as create: `parseInt(x) || 1` turns a genuine
    // 0 into 1. Only fall back to 1 when parseInt actually failed (NaN).
    const parsedNumber = parseInt(lessonNumber);
    const finalLessonNumber = Number.isNaN(parsedNumber) ? 1 : parsedNumber;
    db.updateLesson(req.params.id, finalLessonNumber, title.trim(), description, visibility || 'client', accessStatus || 'visible');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/content/lessons/:id', auth.requireAuthApi(['admin']), (req, res) => { db.deleteLesson(req.params.id); res.json({ ok: true }); });

// ── Lesson quiz lookup — for the "Quiz" button in the course detail view ──
app.get('/api/content/lessons/:id/quiz', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  try { res.json(db.getQuizForLesson(req.params.id) ? db.getFullQuiz(db.getQuizForLesson(req.params.id).id) : null); }
  catch(e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/content/lesson-file-refs', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { lessonId, fileId } = req.body;
    if (!lessonId || !fileId) return res.status(400).json({ error: 'Missing fields.' });
    const newRefId = uuidv4();
    // Per Bot 43 — used to just append (sort_order = current count).
    // Insert first (sort_order doesn't matter yet — reorderLessonFileRefs
    // right below renumbers everyone including this one), then work out
    // where it actually belongs among the lesson's existing files by the
    // same inferred rank used when a lesson's created with a batch of
    // files, and reorder to match. A tie in rank (e.g. this file's rank
    // matches an existing file's) keeps the existing files' current
    // relative order and places the new one after them, via the stable
    // sort below — reasonable default for a case that shouldn't
    // ordinarily happen (two "practice" files in one lesson).
    db.addLessonFileRef(newRefId, lessonId, fileId, 999);
    const files = db.getFilesForLesson(lessonId); // includes the ref just added
    const ranked = files.map((f, i) => ({ refId: f.ref_id, i, rank: inferFileOrderRank(f.title) }));
    ranked.sort((a, b) => a.rank - b.rank || a.i - b.i);
    db.reorderLessonFileRefs(lessonId, ranked.map(r => r.refId));
    res.json({ ok: true });
  } catch (e) {
    console.error('add lesson file ref error:', e);
    res.status(500).json({ error: e.message });
  }
});
app.delete('/api/content/lesson-file-refs/:id', auth.requireAuthApi(['admin']), (req, res) => { db.removeLessonFileRef(req.params.id); res.json({ ok: true }); });

app.get('/api/content/playlists', auth.requireAuthApi(['admin','facilitator','client']), (req, res) => res.json(db.getAllPlaylists(req.query)));
app.post('/api/content/playlists', auth.requireAuthApi(['admin']), (req, res) => {
  const { title, description, categoryId, subcategoryId } = req.body;
  if (!title || !categoryId) return res.status(400).json({ error: 'Title and category required.' });
  const id = uuidv4();
  db.createPlaylist(id, title, description, categoryId, subcategoryId, false);
  res.json({ id });
});
app.get('/api/content/playlists/:id/tracks', auth.requireAuthApi(['admin','facilitator','client']), (req, res) => res.json(db.getTracksForPlaylist(req.params.id)));
app.delete('/api/content/playlists/:id', auth.requireAuthApi(['admin']), (req, res) => { db.deletePlaylist(req.params.id); res.json({ ok: true }); });

app.post('/api/content/playlist-track-refs', auth.requireAuthApi(['admin']), (req, res) => {
  const { playlistId, fileId, title, sortOrder } = req.body;
  if (!playlistId || !fileId) return res.status(400).json({ error: 'Missing fields.' });
  db.addPlaylistTrackRef(uuidv4(), playlistId, fileId, title || '', sortOrder || 0);
  res.json({ ok: true });
});
app.delete('/api/content/playlist-track-refs/:id', auth.requireAuthApi(['admin']), (req, res) => { db.removePlaylistTrackRef(req.params.id); res.json({ ok: true }); });

app.get('/uploads/:filename', async (req, res) => {
  const token = req.cookies?.[auth.COOKIE_NAME];
  const user  = token ? auth.verifyToken(token) : null;
  if (!user) return res.redirect('/login');
  const localPath = path.join(__dirname, 'uploads', req.params.filename);
  // Per Bot 24 (maintenance rebuild) — local disk has no persistent
  // volume, so anything actually relayed to R2 (message attachments,
  // and any future addition following the same flat-key convention)
  // won't be sitting here after a deploy. Falls back to a short-lived
  // presigned R2 URL for the same key before giving up — existing local
  // files (and any R2 setup that's genuinely unconfigured) still work
  // exactly as before via the fs.existsSync fast path.
  if (fs.existsSync(localPath)) return res.sendFile(localPath);
  if (media.isConfigured()) {
    try {
      if (await media.objectExists(req.params.filename)) {
        const url = await media.getPlaybackUrl(req.params.filename);
        return res.redirect(url);
      }
    } catch (e) { console.error('/uploads R2 fallback error:', e.message); }
  }
  res.status(404).json({ error: 'File not found.' });
});

// ── Guest routes ──
app.get('/guest',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'guest', 'index.html')));
app.get('/guest/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guest', 'index.html')));

// ── My Account page ──
app.get('/account',  (req, res) => {
  const token = req.cookies?.[auth.COOKIE_NAME];
  const user  = token ? auth.verifyToken(token) : null;
  if (!user) return res.redirect('/login');
  if (user.role === 'client') return res.sendFile(path.join(__dirname, 'public', 'account.html'));
  if (user.role === 'admin' || user.role === 'facilitator') return res.sendFile(path.join(__dirname, 'public', 'staff-account.html'));
  return res.redirect('/login');
});
app.get('/account/', (req, res) => res.redirect('/account'));

// ── My Account — user self-service ──
// Returns the current user's full profile including membership and preferences.
// ── "Log in as" impersonation (Per Bot 24) ── Admin-only. Full access as
// the target person, deliberately — this is for genuinely seeing what
// they see, not a restricted preview mode, per Per's own call. Every
// action taken while impersonating is indistinguishable from that
// person's own real activity except for the audit trail below and the
// red frame the client app renders the whole time (see /api/account's
// `impersonating` flag).
app.post('/api/admin/users/:id/impersonate', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const target = db.getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'Person not found.' });
    const admin = db.getFacilitatorById(req.user.id);
    const impersonatedBy = { id: req.user.id, name: (admin && admin.name) || req.user.name || 'an admin' };
    const token = auth.createToken({ role: 'client', id: target.id, name: target.name, email: target.email, impersonatedBy });
    res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
    db.logLogin(target.id, 'client', 'impersonate_start', req.user.id, 'admin');
    res.json({ ok: true, redirect: '/client/' });
  } catch (e) {
    console.error('impersonate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// No role restriction here on purpose — this is how ANY impersonated
// session ends, and by definition the current session's role is
// whatever the target person's role is (usually 'client'), not 'admin'.
// The only real gate is the token itself actually carrying a valid
// impersonatedBy claim — nobody can forge that without the JWT secret.
app.post('/api/exit-impersonation', (req, res) => {
  try {
    const token = req.cookies?.[auth.COOKIE_NAME];
    const payload = token ? auth.verifyToken(token) : null;
    if (!payload || !payload.impersonatedBy) return res.status(400).json({ error: 'Not currently impersonating anyone.' });
    const admin = db.getFacilitatorById(payload.impersonatedBy.id);
    if (!admin) return res.status(404).json({ error: 'Admin account not found — cannot return to it.' });
    const newToken = auth.createToken({ role: admin.role, id: admin.id, name: admin.name, email: admin.email });
    res.cookie(auth.COOKIE_NAME, newToken, auth.COOKIE_OPTIONS);
    db.logLogin(payload.id, payload.role, 'impersonate_end', admin.id, admin.role);
    res.json({ ok: true, redirect: '/admin/' });
  } catch (e) {
    console.error('exit-impersonation error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/account', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const user = db.getUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found.' });
    // Don't send password hash to the client
    const { password_hash, ...safe } = user;
    // Per Bot 24 — impersonatedBy is a claim on the token itself, not
    // anything stored on the user record — surfaced here so the client
    // app knows to render the red frame + exit control the whole time
    // an admin is genuinely looking at this exact session, not guessing
    // from any other signal.
    if (req.user.impersonatedBy) safe.impersonating = req.user.impersonatedBy;
    res.json(safe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Per Bot 24 (activity/engagement, group 1) — one call, both pieces:
// this week's consistency count and any newly-crossed milestone. Marks
// the milestone as seen the moment it's returned rather than requiring a
// separate acknowledge call — simplest option, and the worst case if a
// render genuinely fails is just that one milestone quietly doesn't
// resurface, not a real problem worth the extra round-trip to guard
// against.
app.get('/api/my/activity-summary', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const consistency = db.getConsistencyStats(req.user.id);
    const milestone = db.getNewMilestone(req.user.id);
    if (milestone) db.markMilestoneSeen(req.user.id, milestone.key);
    res.json({ ...consistency, milestone });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Referral prompt (Per Bot 25) ── see getReferralPromptTrigger in
// db.js for the actual trigger logic/reasoning. 'shown' marks the
// cooldown the moment it renders (not on some later action), so even if
// someone navigates away without tapping anything it won't immediately
// re-show on the next page load. 'respond' is the permanent stop —
// called for either a real "yes" or an explicit "no thanks", never for
// a soft "not now" (which just relies on the cooldown re-earning
// eligibility later on its own).
app.get('/api/my/referral-prompt', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const trigger = db.getReferralPromptTrigger(req.user.id);
    res.json(trigger ? { show: true, ...trigger } : { show: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/my/referral-prompt/shown', auth.requireAuthApi(['client']), (req, res) => {
  try { db.markReferralPromptShown(req.user.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/my/referral-prompt/respond', auth.requireAuthApi(['client']), (req, res) => {
  try { db.markReferralPromptResponded(req.user.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Birthday re-offer (Per Bot 25) ── same shape as the referral prompt
// just above. Saving an actual birthday goes through the existing
// PATCH /api/account (dob_month/dob_day are already in its allowed-
// fields list — see updateAccount's allowed array), not a new endpoint.
app.get('/api/my/birthday-prompt', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const trigger = db.getBirthdayPromptTrigger(req.user.id);
    res.json(trigger || { show: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/my/birthday-prompt/shown', auth.requireAuthApi(['client']), (req, res) => {
  try { db.markBirthdayPromptShown(req.user.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/my/birthday-prompt/respond', auth.requireAuthApi(['client']), (req, res) => {
  try { db.markBirthdayPromptResponded(req.user.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── New library files login notification (Per Bot 25) ── see the
// getNewLibraryFilesCount comment in db.js for the reasoning.
app.get('/api/my/library-notification', auth.requireAuthApi(['client']), (req, res) => {
  try { res.json({ count: db.getNewLibraryFilesCount(req.user.id) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/my/library-notification/seen', auth.requireAuthApi(['client']), (req, res) => {
  try { db.markLibraryNotificationSeen(req.user.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Per Bot 24 (activity/engagement, group 2) — "one obvious next action"
// on the home screen. The client only calls this when the resume card
// (course-in-progress) has nothing to show — see loadNextAction there.
app.get('/api/client/next-action', auth.requireAuthApi(['client']), (req, res) => {
  try { res.json(db.getNextActionSuggestion(req.user.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Update communication preferences and profile fields
app.patch('/api/account', auth.requireAuthApi(['client']), async (req, res) => {
  try {
    // Per Bot 25 — dob_month/dob_day/onboarding_completed/
    // keep_history_prompted were all missing from this list: this route
    // builds `prefs` ONLY from keys present here, so these were being
    // silently stripped from every request before ever reaching
    // updateUserPreferences (whose own, separate allowlist in db.js
    // already correctly includes all of them — that one was never the
    // problem). Two confirmed-live consequences: onboarding_completed
    // never actually reached the database via this endpoint (the only
    // place that ever sets it, other than the one-time grandfather
    // migration for accounts that existed before this feature — see the
    // migration comment in db.js), so every account created since —
    // over a month of signups — has been seeing the onboarding stepper
    // on every single login, forever. Same root cause, same effect on
    // keep_history_prompted: answerKeepHistory()'s "Not now" was meant
    // to mean "don't ask again this session or later", but the flag
    // saying so never actually saved, so maybeShowKeepHistoryPrompt()
    // would keep re-asking indefinitely. voice_hint_shown/tomte_name
    // added too for consistency with db.js's own allowlist, even though
    // neither currently has a live client-side writer to have been
    // affected by this. Found while building the birthday re-offer,
    // which reads this same onboarding_completed field as its own
    // eligibility gate.
    const allowed = ['pref_email_motd','pref_email_reminders','pref_email_renewal','pref_email_news','pref_sms','pref_sms_motd','pref_sms_reminders','pref_sms_renewal','pref_email_messages','pref_sms_messages','pref_keep_history','phone','language','motd_days','motd_hour','timezone','voice_id','a11y_contrast','a11y_text_scale','dob_month','dob_day','onboarding_completed','keep_history_prompted','voice_hint_shown','tomte_name','carousel_autoplay'];
    const prefs = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) prefs[k] = req.body[k]; });
    if (prefs.a11y_contrast !== undefined) {
      const v = Number(prefs.a11y_contrast);
      if (v !== 0 && v !== 1) return res.status(400).json({ error: 'a11y_contrast must be 0 or 1.' });
      prefs.a11y_contrast = v;
    }
    if (prefs.a11y_text_scale !== undefined) {
      if (!['normal','large','larger'].includes(prefs.a11y_text_scale)) {
        return res.status(400).json({ error: "a11y_text_scale must be 'normal', 'large', or 'larger'." });
      }
    }
    // Light validation — bad values here would silently break someone's schedule
    // (e.g. never matching any cron run), so reject rather than store garbage.
    if (prefs.motd_days !== undefined) {
      const days = String(prefs.motd_days).split(',').map(d => d.trim()).filter(Boolean);
      const valid = days.length > 0 && days.every(d => /^[0-6]$/.test(d));
      if (!valid) return res.status(400).json({ error: 'motd_days must be comma-separated digits 0-6.' });
      prefs.motd_days = days.join(',');
    }
    if (prefs.motd_hour !== undefined) {
      const hour = parseInt(prefs.motd_hour, 10);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) return res.status(400).json({ error: 'motd_hour must be 0-23.' });
      prefs.motd_hour = hour;
    }
    if (prefs.timezone !== undefined && prefs.timezone !== null && prefs.timezone !== '') {
      try { new Intl.DateTimeFormat(undefined, { timeZone: prefs.timezone }); }
      catch (e) { return res.status(400).json({ error: 'That timezone isn\'t recognised.' }); }
    }
    // An empty string means "back to the default voice" — stored as NULL,
    // not an empty string, so /api/speak's `if (user?.voice_id)` check
    // treats it the same as never having chosen one. Anything else must be
    // a real, currently-available ElevenLabs voice_id — never trust this
    // straight from the request body.
    if (prefs.voice_id !== undefined) {
      if (prefs.voice_id === '' || prefs.voice_id === null) {
        prefs.voice_id = null;
      } else {
        const cfg = db.getAppConfig() || {};
        const customVoiceAllowed = cfg.allow_custom_voice === null || cfg.allow_custom_voice === undefined ? true : !!cfg.allow_custom_voice;
        if (!customVoiceAllowed) {
          return res.status(400).json({ error: 'Custom voices are turned off right now — please check back later.' });
        }
        try {
          const voices = await fetchElevenLabsVoices();
          if (!voices.some(v => v.voice_id === prefs.voice_id)) {
            return res.status(400).json({ error: 'That voice is not currently available.' });
          }
        } catch (e) {
          return res.status(500).json({ error: 'Could not verify that voice right now — please try again.' });
        }
      }
    }
    // Month/day only, deliberately no year — see the migration comment in
    // db.js. Empty string means "clear it" (also the opt-out, since
    // providing a DOB at all is what enables the birthday message).
    if (prefs.dob_month !== undefined) {
      if (prefs.dob_month === '' || prefs.dob_month === null) prefs.dob_month = null;
      else {
        const m = parseInt(prefs.dob_month, 10);
        if (!Number.isInteger(m) || m < 1 || m > 12) return res.status(400).json({ error: 'Month must be between 1 and 12.' });
        prefs.dob_month = m;
      }
    }
    if (prefs.dob_day !== undefined) {
      if (prefs.dob_day === '' || prefs.dob_day === null) prefs.dob_day = null;
      else {
        const d = parseInt(prefs.dob_day, 10);
        if (!Number.isInteger(d) || d < 1 || d > 31) return res.status(400).json({ error: 'Day must be between 1 and 31.' });
        prefs.dob_day = d;
      }
    }
    // Timezone is optional in general, but mandatory the moment MOTD
    // notifications are on — the scheduled sender can't work out a user's
    // local hour without one. This must only fire when THIS request is
    // actually changing a MOTD-related field — checking against the
    // user's already-saved state unconditionally (as this used to) meant
    // any unrelated update (name, phone, an entirely different preference
    // like Keep History) got wrongly rejected for anyone who simply
    // hadn't set a timezone yet, since pref_email_motd defaults to on for
    // every new account. Only MOTD is per-user scheduled — Reminders and
    // Renewal run on fixed cron times, not a personal hour, so they don't
    // belong in this check at all.
    const touchesMotdScheduling = ['pref_email_motd', 'pref_sms_motd'].some(k => prefs[k] !== undefined);
    if (touchesMotdScheduling) {
      const current = db.getUser(req.user.id);
      const effEmailMotd = prefs.pref_email_motd !== undefined ? !!Number(prefs.pref_email_motd) : !!current.pref_email_motd;
      const effSmsMotd    = prefs.pref_sms_motd   !== undefined ? !!Number(prefs.pref_sms_motd)   : !!current.pref_sms_motd;
      const effTimezone   = prefs.timezone !== undefined ? prefs.timezone : current.timezone;
      if ((effEmailMotd || effSmsMotd) && !effTimezone) {
        return res.status(400).json({ error: 'Please set a timezone before turning on the daily message.' });
      }
    }

    if (Object.keys(prefs).length) db.updateUserPreferences(req.user.id, prefs);
    // Name update — updateUserName only touches the name column. The old
    // call here used updateClientDetails(id, name, null, null), which sets
    // email and facilitator_id unconditionally — including to null. That
    // meant anyone using "Save changes" on their name in My Account had
    // their email silently wiped every time. Live bug, not hypothetical —
    // fixed as part of the invite-link work below, which needed a safe
    // name-only update anyway.
    if (req.body.name && req.body.name.trim()) {
      db.updateUserName(req.user.id, req.body.name.trim());
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Custom reminders (Per Bot 50) ── A person's own reminder(s), on
// their own schedule — distinct from the automatic inactivity-based
// "Practice reminders" toggle above, which is system-driven ("you've
// gone quiet"). This is the opposite: any number of reminders, each
// independently timed (hourly / daily at a set hour / weekly on a set
// day+hour) and each with its own email/SMS choice, regardless of
// activity. Scoped to req.user.id throughout — id in the URL alone was
// never trusted as ownership proof.
app.get('/api/account/custom-reminders', auth.requireAuthApi(['client']), (req, res) => {
  try { res.json(db.getCustomRemindersForUser(req.user.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/account/custom-reminders', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const { label, frequency, day_of_week, time_of_day, channel_email, channel_sms } = req.body || {};
    if (!['hourly', 'daily', 'weekly'].includes(frequency)) {
      return res.status(400).json({ error: "Frequency must be 'hourly', 'daily', or 'weekly'." });
    }
    if (frequency !== 'hourly' && !/^([01]\d|2[0-3]):00$/.test(time_of_day || '')) {
      return res.status(400).json({ error: 'Please choose a time of day.' });
    }
    if (frequency === 'weekly' && (day_of_week === undefined || day_of_week === null || day_of_week < 0 || day_of_week > 6)) {
      return res.status(400).json({ error: 'Please choose a day of the week.' });
    }
    if (!channel_email && !channel_sms) {
      return res.status(400).json({ error: 'Choose at least one of email or SMS.' });
    }
    if (channel_sms) {
      const user = db.getUser(req.user.id);
      if (!user.phone) return res.status(400).json({ error: 'Add a mobile number first — needed for SMS reminders.' });
    }
    const id = db.createCustomReminder(req.user.id, {
      label: (label || 'Practice Reminder').trim().slice(0, 80),
      frequency,
      day_of_week: frequency === 'weekly' ? day_of_week : null,
      time_of_day: frequency === 'hourly' ? null : time_of_day,
      channel_email: !!channel_email,
      channel_sms: !!channel_sms,
    });
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/account/custom-reminders/:id', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const fields = {};
    ['label', 'frequency', 'day_of_week', 'time_of_day', 'channel_email', 'channel_sms', 'active'].forEach(k => {
      if (req.body[k] !== undefined) fields[k] = req.body[k];
    });
    if (fields.channel_sms) {
      const user = db.getUser(req.user.id);
      if (!user.phone) return res.status(400).json({ error: 'Add a mobile number first — needed for SMS reminders.' });
    }
    db.updateCustomReminder(req.params.id, req.user.id, fields);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/account/custom-reminders/:id', auth.requireAuthApi(['client']), (req, res) => {
  try { db.deleteCustomReminder(req.params.id, req.user.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Client journal (Per Bot 6) ── Written entries and simple .txt uploads
// — PDF/DOCX text extraction deliberately left out of this first version;
// it needs extra parsing dependencies for a use case (writing about how
// you feel) that's naturally text-based anyway. Worth adding later only
// if there's real demand specifically for uploading existing documents in
// those formats.
app.get('/api/journal', auth.requireAuthApi(['client']), (req, res) => {
  try {
    res.json({ entries: db.getJournalEntriesForClient(req.user.id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/journal', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const { title, content, shareWithBot, shareWithFacilitator } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Write something first.' });
    const entryTitle = (title && title.trim()) || `Entry from ${new Date().toLocaleDateString()}`;
    const id = uuidv4();
    db.addJournalEntry(id, req.user.id, entryTitle, content.trim(), 'written', null, !!shareWithBot, !!shareWithFacilitator);
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/journal/upload', auth.requireAuthApi(['client']), upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    if (!req.file.originalname.toLowerCase().endsWith('.txt')) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Only plain text (.txt) files are supported right now.' });
    }
    const content = fs.readFileSync(req.file.path, 'utf8');
    fs.unlink(req.file.path, () => {});
    if (!content.trim()) return res.status(400).json({ error: 'That file appears to be empty.' });

    const { title, shareWithBot, shareWithFacilitator } = req.body;
    const entryTitle = (title && title.trim()) || req.file.originalname.replace(/\.txt$/i, '');
    const id = uuidv4();
    db.addJournalEntry(id, req.user.id, entryTitle, content.trim(), 'upload', req.file.originalname, shareWithBot === 'true', shareWithFacilitator === 'true');
    res.json({ id });
  } catch(e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: e.message });
  }
});

// Per Bot 24 (activity/engagement, group 3 — quick capture) — voice
// journal entries. Presign → PUT direct to R2 → confirm, same
// direct-upload pattern as call recordings/practice audio (see the
// maintenance rebuild this session started with) — no reason a quick
// voice note should be any less careful about upload size/timeout risk
// than those were. Transcribed via the same Deepgram call call
// recordings already use (see transcribeAudioBuffer above); a failed or
// empty transcript still saves the entry (the audio itself is never
// lost), just with a plain placeholder instead of transcribed text.
// Per Bot 24 — dictation for the Write Memo path. Genuinely different
// from the Voice Memo path above: that one keeps the recording
// (uploaded to R2, playable later); this one is purely ephemeral — just
// converts a short spoken clip into text for the textarea, nothing is
// stored, so this goes straight through the server (multer) rather than
// the presign-to-R2 dance, which would be pointless overhead for
// something never kept.
app.post('/api/journal/dictate', auth.requireAuthApi(['client']), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio received.' });
    const buffer = fs.readFileSync(req.file.path);
    fs.unlink(req.file.path, () => {});
    const transcript = await transcribeAudioBuffer(buffer, req.file.mimetype);
    res.json({ transcript: transcript || '' });
  } catch(e) {
    console.error('journal dictate error:', e.message);
    res.status(500).json({ error: 'Could not transcribe that — please try again.' });
  }
});

app.post('/api/journal/voice/presign-upload', auth.requireAuthApi(['client']), async (req, res) => {
  try {
    if (!media.isConfigured()) return res.status(503).json({ error: 'Voice notes need media storage configured on this deployment — write it instead for now, or ask your admin to set up R2.' });
    const { mimeType } = req.body;
    const ext = mimeType && mimeType.includes('mp4') ? '.mp4' : '.webm';
    const key = `journal-voice/${uuidv4()}${ext}`;
    const uploadUrl = await media.getUploadUrl(key, mimeType || 'audio/webm');
    res.json({ uploadUrl, key });
  } catch (e) {
    console.error('journal voice presign-upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/journal/voice', auth.requireAuthApi(['client']), async (req, res) => {
  try {
    const { r2Key, mimeType, title, shareWithBot, shareWithFacilitator } = req.body;
    if (!r2Key || !r2Key.startsWith('journal-voice/')) return res.status(400).json({ error: 'Unexpected key.' });
    const exists = await media.objectExists(r2Key).catch(() => false);
    if (!exists) return res.status(400).json({ error: 'Upload did not complete — try again.' });

    let transcript = '';
    try {
      const obj = await media.getPublicObject(r2Key);
      const chunks = [];
      for await (const chunk of obj.Body) chunks.push(chunk);
      transcript = await transcribeAudioBuffer(Buffer.concat(chunks), mimeType || 'audio/webm');
    } catch(e) { console.error('journal voice transcription error:', e.message); }

    const entryTitle = (title && title.trim()) || `Voice note from ${new Date().toLocaleDateString()}`;
    const content = (transcript && transcript.trim()) || '(Voice note — no transcript available. Your recording is still saved below.)';
    const id = uuidv4();
    db.addJournalEntry(id, req.user.id, entryTitle, content, 'voice', null, !!shareWithBot, !!shareWithFacilitator, r2Key);
    res.json({ id });
  } catch(e) {
    console.error('journal voice save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
// Scoped to the entry's own owner only — a facilitator seeing a shared
// entry's transcript is fine (that's the whole point of sharing), but
// the raw audio itself stays private to the person who recorded it,
// same boundary the message-attachment privacy fix earlier this
// session established for one-to-one content generally.
app.get('/api/journal/:id/audio-url', auth.requireAuthApi(['client']), async (req, res) => {
  try {
    const entry = db.getJournalEntryById(req.params.id);
    if (!entry || entry.client_id !== req.user.id) return res.status(404).json({ error: 'Not found.' });
    if (!entry.audio_key) return res.status(400).json({ error: 'This entry has no recording.' });
    const url = await media.getPlaybackUrl(entry.audio_key);
    res.json({ url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Private media for embedded Journal images/video/audio (Per Bot 25) ──
// Distinct from the newsletter-images/videos/audio endpoints above (those
// are permanently, unauthenticated-ly public by design — correct for
// broadcast content, wrong for a client's own journal photo). Two-step,
// same shape as the rest of this app's R2 flows: upload once, store only
// the stable r2_key inside the saved rich-text HTML (see message-editor.js's
// privateImageBlock/privateVideoBlock/privateAudioBlock — those blots
// deliberately serialize the key, never a resolved URL, since signed URLs
// expire), then resolve a fresh signed URL every time the content is
// actually displayed. Ownership is rooted in whoever uploaded it
// (private_media.uploaded_by) — the resolve endpoint below is the one
// and only gate; nobody else, including another client or a facilitator,
// can ever resolve a URL for someone else's embedded media through this
// path. (Sharing a journal entry with a facilitator today only shares
// the entry's *text* — embedded media inside a shared entry will show as
// a broken/unresolvable placeholder for the facilitator. Extending
// resolution to a client's own facilitator when an entry is actually
// shared is a reasonable next step, but a separate decision — not done
// here.)
// ── Journal video compression (Per Bot 25) ── Mobile phones record video
// at resolutions/bitrates meant for a big screen or professional editing,
// not a quick note attached to a journal entry — a few seconds can
// easily run into tens of MB. Transcodes down to a small, low-quality
// mp4 (480px on the long edge, a high CRF, a modest audio bitrate)
// before it ever reaches R2, using the same execFileAsync('ffmpeg', ...)
// pattern as the audiobook/signal-audio pipelines elsewhere in this
// file. Falls back to storing the original untouched if ffmpeg fails
// for any reason (corrupt upload, unsupported codec) — a big file is
// still better than a failed save.
async function compressVideoForJournal(inputPath, originalMimeType) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'journal-video-'));
  try {
    const outPath = path.join(tmpDir, 'compressed.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath,
      // Long edge capped at 480px, even dimensions required by most
      // encoders (-2 keeps the other edge even while preserving aspect
      // ratio) — plenty for a phone-sized preview, nowhere near what a
      // raw phone recording actually captures.
      '-vf', "scale='if(gt(iw,ih),480,-2)':'if(gt(iw,ih),-2,480)'",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32',
      '-c:a', 'aac', '-b:a', '64k',
      '-movflags', '+faststart',
      outPath,
    ], { timeout: 120000 });
    const buffer = await fsp.readFile(outPath);
    return { buffer, mimeType: 'video/mp4', ext: '.mp4' };
  } catch (e) {
    console.error('[journal video] compression failed, storing original:', e.message);
    return { buffer: await fsp.readFile(inputPath), mimeType: originalMimeType, ext: (inputPath.match(/\.[a-zA-Z0-9]+$/) || [''])[0] };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

app.post('/api/journal/media-upload/presign-upload', auth.requireAuthApi(['client']), async (req, res) => {
  try {
    if (!media.isConfigured()) return res.status(503).json({ error: 'Media storage is not configured.' });
    const { filename, contentType } = req.body;
    if (!contentType || !contentType.startsWith('video/')) return res.status(400).json({ error: 'This upload path is for video only.' });
    const ext = (filename && filename.match(/\.[a-zA-Z0-9]+$/)) ? filename.match(/\.[a-zA-Z0-9]+$/)[0] : '.mp4';
    // Raw, pre-compression upload — a distinct prefix from the final
    // journal-media/ key it becomes after compressVideoForJournal runs,
    // so the two are never confused with each other in R2.
    const key = `journal-media-raw/${uuidv4()}${ext}`;
    const uploadUrl = await media.getUploadUrl(key, contentType);
    res.json({ uploadUrl, key });
  } catch (e) {
    console.error('journal media presign-upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/journal/media-upload', auth.requireAuthApi(['client']), upload.single('file'), async (req, res) => {
  try {
    if (!media.isConfigured()) return res.status(400).json({ error: 'Media storage (R2) is not configured on this deployment.' });
    // Per Bot 25 — Path A: video already uploaded directly to R2 (see
    // presign-upload above) — the original file, the one with no real
    // size ceiling, never touches this server. What DOES happen here is
    // downloading it back once (one R2 round-trip, same trade-off the
    // call-recording transcription path already makes) purely to hand
    // the raw bytes to ffmpeg for compression — unavoidable, since
    // compression has to happen somewhere, but the risky part (the
    // browser-to-server transfer of a large, uncompressed phone video)
    // is what this eliminates. Images/audio don't go through this path
    // at all — images are already compressed client-side before upload
    // (see Path B below, unchanged), and audio files are small enough
    // that the original single-request upload was never actually a risk.
    if (req.body && req.body.r2Key) {
      const rawKey = req.body.r2Key;
      if (!rawKey.startsWith('journal-media-raw/')) return res.status(400).json({ error: 'Unexpected key.' });
      const exists = await media.objectExists(rawKey).catch(() => false);
      if (!exists) return res.status(400).json({ error: 'Upload did not complete — try again.' });
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'journal-video-raw-'));
      try {
        const obj = await media.getPublicObject(rawKey);
        const rawPath = path.join(tmpDir, 'raw' + (rawKey.match(/\.[a-zA-Z0-9]+$/) || ['.mp4'])[0]);
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(rawPath);
          obj.Body.pipe(ws);
          obj.Body.on('error', reject);
          ws.on('finish', resolve);
          ws.on('error', reject);
        });
        const compressed = await compressVideoForJournal(rawPath, req.body.mimeType || 'video/mp4');
        const key = `journal-media/${uuidv4()}${compressed.ext}`;
        await media.putObject(key, compressed.buffer, compressed.mimeType);
        db.recordPrivateMediaUpload(key, req.user.id, 'journal', compressed.mimeType);
        await media.deleteObject(rawKey).catch(() => {}); // best-effort — the raw pre-compression copy has no further use
        return res.json({ key, mimeType: compressed.mimeType });
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    // Path B — image/audio, unchanged: small enough that a single
    // multipart request through this server was never a real risk.
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const mimetype = req.file.mimetype || '';
    if (!mimetype.startsWith('image/') && !mimetype.startsWith('audio/')) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Only image or audio files are supported on this path — video goes through presign-upload.' });
    }
    const buffer = fs.readFileSync(req.file.path);
    const ext = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || [''])[0];
    const key = `journal-media/${uuidv4()}${ext}`;
    await media.putObject(key, buffer, mimetype);
    db.recordPrivateMediaUpload(key, req.user.id, 'journal', mimetype);
    fs.unlink(req.file.path, () => {});
    res.json({ key, mimeType: mimetype });
  } catch (e) {
    console.error('journal media upload error:', e.message);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Could not upload: ' + e.message });
  }
});
app.get('/api/journal/media-url', auth.requireAuthApi(['client']), async (req, res) => {
  try {
    const key = req.query.key;
    if (!key || !key.startsWith('journal-media/')) return res.status(400).json({ error: 'Invalid key.' });
    const owner = db.getPrivateMediaOwner(key);
    if (!owner || owner !== req.user.id) return res.status(404).json({ error: 'Not found.' });
    const url = await media.getPlaybackUrl(key);
    res.json({ url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/journal/:id', auth.requireAuthApi(['client']), (req, res) => {
  try {
    db.deleteJournalEntry(req.params.id, req.user.id); // scoped to req.user.id — can't delete someone else's entry
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete account — GDPR right to erasure
app.delete('/api/account', auth.requireAuthApi(['client']), (req, res) => {
  try {
    db.deleteClient(req.user.id);
    res.clearCookie(auth.COOKIE_NAME);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── My Account — admin / facilitator self-service (separate table, no membership/GDPR-export fields) ──
app.get('/api/staff-account', auth.requireAuthApi(['admin', 'facilitator']), (req, res) => {
  try {
    const fac = db.getFacilitatorById(req.user.id);
    if (!fac) return res.status(404).json({ error: 'Not found.' });
    const { password_hash, ...safe } = fac;
    res.json(safe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/staff-account', auth.requireAuthApi(['admin', 'facilitator']), (req, res) => {
  try {
    const name  = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    if (!name)  return res.status(400).json({ error: 'Please enter a name.' });
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Please enter a valid email.' });

    // Prevent collision with another facilitator/admin or a client account
    const existingFac  = db.getFacilitatorByEmail(email);
    if (existingFac && existingFac.id !== req.user.id) return res.status(400).json({ error: 'That email is already in use.' });
    const existingUser = db.getUserByEmail(email);
    if (existingUser) return res.status(400).json({ error: 'That email is already in use.' });

    db.updateFacilitatorDetails(req.user.id, name, email);
    if (req.body.phone !== undefined) db.updateFacilitatorPhone(req.user.id, req.body.phone.trim() || null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Membership plans — public endpoint (no auth required for pricing page) ──
app.get('/api/membership/plans', (req, res) => {
  try { res.json(db.getMembershipPlans(true)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Membership plans — admin management ──
app.get('/api/admin/membership/plans', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getMembershipPlans(false)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
// Per Bot 21 — how many people are actually on each plan right now.
// Deliberately a separate, on-demand endpoint rather than bundled into
// the plan list above: this calls out to Stripe once per plan that has
// a Price ID, which is slower than a local DB read and shouldn't hold
// up the main table rendering. Counts are live from Stripe (status =
// active only — a trialing subscriber hasn't actually paid for this
// plan yet, so isn't counted as "on" it), not anything cached locally,
// since that's the only place billing-cycle-level detail actually
// lives — the app's own user records track tier, not which specific
// Price a person is subscribed under.
app.get('/api/admin/membership/plans/member-counts', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    if (!stripe) return res.json({});
    const plans = db.getMembershipPlans(false).filter(p => p.stripe_price_id);
    const counts = {};
    await Promise.all(plans.map(async (p) => {
      try {
        const subs = await stripe.subscriptions.list({ price: p.stripe_price_id, status: 'active', limit: 100 }).autoPagingToArray({ limit: 1000 });
        counts[p.id] = subs.length;
      } catch (e) {
        counts[p.id] = null; // couldn't fetch this one — shown as unknown, not zero
      }
    }));
    res.json(counts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.patch('/api/admin/membership/plans/:id', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const fields = { ...req.body };
    // Per Bot 18 — the price field and the Stripe Price ID field used to
    // be fully independent, so pasting a real ID here did nothing to the
    // displayed price — exactly the kind of drift that caused a long,
    // confusing back-and-forth earlier tonight. Now, the moment a Price
    // ID is saved, the real amount is pulled live from Stripe and always
    // wins over anything hand-typed in the same request — the price
    // shown here can no longer silently disagree with what Stripe will
    // actually charge.
    if (fields.stripe_price_id) {
      if (!stripe) return res.status(400).json({ error: 'Stripe isn\'t configured (no STRIPE_SECRET_KEY set) — can\'t verify that price ID right now.' });
      try {
        const stripePrice = await stripe.prices.retrieve(fields.stripe_price_id.trim());
        fields.stripe_price_id = stripePrice.id;
        fields.price_pence = stripePrice.unit_amount;
      } catch (e) {
        return res.status(400).json({ error: `Couldn't find that price in Stripe: ${e.message}` });
      }
    }
    db.updateMembershipPlan(req.params.id, fields);
    res.json({ ok: true, pricePence: fields.price_pence });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Offers (Per Bot 17) — Sales & Marketing "Promotions & upgrade page" ──
// Named, dated promotional campaigns. `code` must be unique — checked here
// rather than relying only on the DB's UNIQUE constraint, so a clash comes
// back as a normal, readable error instead of a raw SQLite exception.
app.get('/api/admin/offers', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getAllOffers()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/offers', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { name, code, headline, description, trial_days, launch_date, expiry_date, is_default, cloned_from } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
    if (!code || !code.trim()) return res.status(400).json({ error: 'Code is required.' });
    const safeCode = code.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!safeCode) return res.status(400).json({ error: 'Code must contain at least one letter or number.' });
    if (db.getOfferByCode(safeCode)) return res.status(400).json({ error: `An offer with the code "${safeCode}" already exists.` });
    const id = db.createOffer({
      name: name.trim(), code: safeCode,
      headline: headline || null, description: description || null,
      trial_days: parseInt(trial_days, 10) || 14,
      launch_date: launch_date || null, expiry_date: expiry_date || null,
      is_default: !!is_default, cloned_from: cloned_from || null,
    });
    res.json({ ok: true, id, code: safeCode });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/offers/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const fields = { ...req.body };
    if (fields.code) {
      const safeCode = fields.code.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!safeCode) return res.status(400).json({ error: 'Code must contain at least one letter or number.' });
      const clash = db.getOfferByCode(safeCode);
      if (clash && clash.id !== req.params.id) return res.status(400).json({ error: `An offer with the code "${safeCode}" already exists.` });
      fields.code = safeCode;
    }
    if (fields.trial_days != null) fields.trial_days = parseInt(fields.trial_days, 10) || 14;
    db.updateOffer(req.params.id, fields);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/offers/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    db.deleteOffer(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Campaigns (Per Bot 18) ──
// A campaign mixes calming (line-bank, no CTA) and sales (offer-linked,
// tracked) steps across email and social, on a schedule, reviewed as a
// whole before going live rather than step by step as days pass.
//
// Content generation, kept as one shared function so every entry point
// (adding a step, regenerating one) produces content the same way.
async function generateCampaignStepContent(campaign, step, brief) {
  if (step.type === 'calming') {
    const line = db.getRandomActiveSignalLine();
    if (!line) throw new Error('No active lines in the line bank to draw from — add or activate some first.');
    return { content: line.text, subject: step.channel === 'email' ? 'A little something for today' : null, lineId: line.id };
  }
  // Sales steps need a real offer to link to — a campaign with no offer
  // can still exist (pure calming), it just can't have sales-type steps.
  if (!campaign.offer_id) throw new Error('This campaign has no offer set — sales steps need one to link to.');
  const offer = db.getOffer(campaign.offer_id);
  if (!offer || !db.isOfferCurrentlyValid(offer)) throw new Error('This campaign\'s offer is missing or no longer valid.');
  const source = `${slugify(campaign.name)}-day${step.offset_days}-${step.channel}`;
  const link = `${APP_URL}/promo/${offer.code}?src=${encodeURIComponent(source)}`;

  if (step.channel === 'email') {
    const userBrief = brief || `${offer.headline || offer.name}. ${offer.description || ''}`.trim();
    const systemPrompt = prompts.CAMPAIGN_SALES_EMAIL_PROMPT.replace(/\{\{TRIAL_DAYS\}\}/g, offer.trial_days);
    const raw = await callClaudeRaw(systemPrompt, [{ role: 'user', content: userBrief }], 800);
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); }
    return { content: (parsed.body || '').split('{{SIGNUP_LINK}}').join(link), subject: parsed.subject || offer.headline || offer.name, lineId: null };
  }

  // Social channel — same generator the message builder itself uses,
  // asked for just this one platform.
  const ctaInstructions = prompts.MESSAGE_BUILDER_CTA_INSTRUCTIONS.replace(/\{\{TRIAL_DAYS\}\}/g, offer.trial_days);
  const systemPrompt = prompts.MESSAGE_BUILDER_PROMPT.replace('{{CTA_INSTRUCTIONS}}', ctaInstructions);
  const userBrief = brief || `${offer.headline || offer.name}. ${offer.description || ''}`.trim();
  const userMessage = `SOURCE CONTENT:\n${userBrief}\n\nPLATFORMS TO PRODUCE: ${step.channel}\n\nRespond with only the JSON object, nothing else.`;
  const raw = await callClaudeRaw(systemPrompt, [{ role: 'user', content: userMessage }], 800);
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); }
  const text = (parsed[step.channel] || '').split('{{SIGNUP_LINK}}').join(link);
  return { content: text, subject: null, lineId: null };
}

app.get('/api/admin/campaigns', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getAllCampaigns()); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/campaigns', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { name, offerId, audience } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
    const id = uuidv4();
    db.createCampaign(id, name.trim(), offerId || null, audience || 'all');
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/campaigns/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const campaign = db.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Not found.' });
    res.json({ ...campaign, steps: db.getCampaignSteps(req.params.id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/campaigns/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { name, offerId, audience } = req.body;
    db.updateCampaign(req.params.id, { name, offer_id: offerId, audience });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/campaigns/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const campaign = db.getCampaign(req.params.id);
    if (campaign && campaign.status === 'active') return res.status(400).json({ error: 'Pause an active campaign before deleting it.' });
    db.deleteCampaign(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/campaigns/:id/steps', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const campaign = db.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
    if (campaign.status !== 'draft') return res.status(400).json({ error: 'Only draft campaigns can have steps added.' });
    const { offsetDays, type, channel, brief } = req.body;
    if (!['calming', 'sales'].includes(type)) return res.status(400).json({ error: 'type must be calming or sales.' });
    if (!['email', 'facebook', 'linkedin', 'instagram', 'threads'].includes(channel)) return res.status(400).json({ error: 'Unknown channel.' });
    const id = uuidv4();
    const stub = { offset_days: Number.isFinite(offsetDays) ? offsetDays : 0, type, channel };
    const generated = await generateCampaignStepContent(campaign, stub, brief);
    db.addCampaignStep(id, campaign.id, stub.offset_days, type, channel, generated.subject, generated.content, generated.lineId);
    res.json({ id, step: db.getCampaignStep(id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/campaigns/:id/steps/:stepId', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { offsetDays, subject, content, format } = req.body;
    db.updateCampaignStep(req.params.stepId, { offset_days: offsetDays, subject, content, format });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/campaigns/:id/steps/:stepId', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteCampaignStep(req.params.stepId); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/campaigns/:id/steps/:stepId/regenerate', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const campaign = db.getCampaign(req.params.id);
    const step = db.getCampaignStep(req.params.stepId);
    if (!campaign || !step) return res.status(404).json({ error: 'Not found.' });
    const generated = await generateCampaignStepContent(campaign, step, req.body?.brief);
    db.updateCampaignStep(step.id, { subject: generated.subject, content: generated.content, line_id: generated.lineId });
    res.json({ step: db.getCampaignStep(step.id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Per Bot 18 — email steps can be safely tested (sends only to the admin's
// own test address, never touches the real audience, doesn't mark the
// step as sent). Social steps have no equivalent safe test — BulkPublish
// has no sandbox — so those get a "publish now" action below instead,
// explicitly live, rather than a misleading "test" that either does
// nothing or secretly posts for real.
app.post('/api/admin/campaigns/:id/steps/:stepId/test-email', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const step = db.getCampaignStep(req.params.stepId);
    if (!step) return res.status(404).json({ error: 'Not found.' });
    if (step.channel !== 'email') return res.status(400).json({ error: 'This step isn\'t an email step.' });
    const to = resolveTestEmail(req.body?.email, req.user.email);
    if (!to) return res.status(400).json({ error: 'No test email address available.' });
    const b = brand();
    const { tokens } = resolveTestRecipientTokens(to, req.user);
    await sendEmail(to, `[TEST] ${fillTemplate(step.subject || '(no subject)', tokens)}`,
      `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
        <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name} — campaign test</div>
        ${renderMessageBody(fillTemplate(step.content, tokens), step.format)}
      </div>`);
    res.json({ ok: true, sentTo: to });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/campaigns/:id/steps/:stepId/publish-now', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const step = db.getCampaignStep(req.params.stepId);
    if (!step) return res.status(404).json({ error: 'Not found.' });
    if (step.channel === 'email') return res.status(400).json({ error: 'Use "Send test" for email steps, not this.' });
    if (step.status !== 'pending') return res.status(400).json({ error: 'This step has already fired.' });
    const { channels } = await bulkPublishRequest('GET', '/channels');
    const channel = (channels || []).find(c => (c.platform || '').toLowerCase() === step.channel.toLowerCase());
    if (!channel) return res.status(400).json({ error: `${step.channel} isn't connected in BulkPublish yet.` });
    const post = await bulkPublishRequest('POST', '/posts', {
      content: step.content,
      channels: [{ channelId: channel.id, platform: channel.platform }],
      status: 'published',
    });
    db.setCampaignStepResult(step.id, 'sent', { externalPostId: post?.id || post?.post?.id || null });
    res.json({ ok: true });
  } catch(e) {
    db.setCampaignStepResult(req.params.stepId, 'failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Per Bot 18 — approve & go live. One-way, draft -> active. Every social
// step still pending gets scheduled directly with BulkPublish (its own
// infrastructure fires it, not our cron — more reliable, survives this
// app being briefly down). Email steps stay pending; the daily cron below
// picks those up on their actual day.
app.post('/api/admin/campaigns/:id/activate', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const campaign = db.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Not found.' });
    if (campaign.status !== 'draft') return res.status(400).json({ error: 'Only a draft campaign can be activated.' });
    const steps = db.getCampaignSteps(campaign.id);
    if (!steps.length) return res.status(400).json({ error: 'Add at least one step first.' });
    const emptyStep = steps.find(s => !s.content || !s.content.trim());
    if (emptyStep) return res.status(400).json({ error: `Day ${emptyStep.offset_days}'s ${emptyStep.channel} step has no content.` });

    db.setCampaignStatus(campaign.id, 'active');
    const startedAt = new Date();
    const results = [];
    for (const step of steps) {
      if (step.status !== 'pending' || step.channel === 'email') continue; // already fired, or email — cron's job
      try {
        const { channels } = await bulkPublishRequest('GET', '/channels');
        const channel = (channels || []).find(c => (c.platform || '').toLowerCase() === step.channel.toLowerCase());
        if (!channel) throw new Error(`${step.channel} isn't connected in BulkPublish.`);
        const scheduledAt = new Date(startedAt.getTime() + step.offset_days * 24 * 60 * 60 * 1000);
        scheduledAt.setUTCHours(9, 0, 0, 0); // fixed default send time, 9am UTC
        const post = await bulkPublishRequest('POST', '/posts', {
          content: step.content,
          channels: [{ channelId: channel.id, platform: channel.platform }],
          status: 'scheduled',
          scheduledAt: scheduledAt.toISOString(),
        });
        db.setCampaignStepResult(step.id, 'scheduled', { externalPostId: post?.id || post?.post?.id || null });
        results.push({ stepId: step.id, ok: true });
      } catch (e) {
        db.setCampaignStepResult(step.id, 'failed', { error: e.message });
        results.push({ stepId: step.id, ok: false, error: e.message });
      }
    }
    res.json({ ok: true, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/campaigns/:id/pause', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    // Per Bot 18 — stops the daily cron from firing this campaign's
    // remaining email steps. Doesn't touch social steps already scheduled
    // with BulkPublish — those can only be cancelled on BulkPublish's own
    // side, a genuine limitation worth knowing before relying on pause.
    db.setCampaignStatus(req.params.id, 'paused');
    res.json({ ok: true, note: 'Email steps still pending are stopped. Any social steps already scheduled with BulkPublish need cancelling there directly.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: set member tier directly (manual override / gift membership) ──
app.patch('/api/admin/users/:id/tier', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { tier, expiresAt, trialDays } = req.body;
    if (tier == null) return res.status(400).json({ error: 'tier required (0–3).' });
    let trialEndsAt = null;
    if (trialDays && parseInt(trialDays) > 0) {
      const d = new Date();
      d.setDate(d.getDate() + parseInt(trialDays));
      trialEndsAt = d.toISOString();
    }
    db.setMemberTier(req.params.id, parseInt(tier), expiresAt||null, trialEndsAt, null, null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: downgrade user to Explorer ──
app.patch('/api/admin/users/:id/downgrade', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    db.downgradeToExplorer(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin comms page ──
app.get('/admin/comms',  auth.requireAuth(['admin']), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'comms.html')));
app.get('/admin/comms/', auth.requireAuth(['admin']), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'comms.html')));
// Per Bot 54 — comms2 is the in-progress replacement for comms.html
// (see message_versions above): same login gate, served alongside the
// original rather than in place of it, so both can run side by side
// until comms2 is fully built and tested and comms.html is retired.
app.get('/admin/comms2',  auth.requireAuth(['admin']), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'comms2.html')));
app.get('/admin/comms2/', auth.requireAuth(['admin']), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'comms2.html')));

// Per Bot 15n — Talk & Tomte and Sales & Marketing, split out of the
// Users/Communications pages as part of the six-area admin restructure
// (People / Content / Talk & Tomte / Communications / Sales & Marketing /
// Settings — Settings already existed at /setup).
app.get('/admin/talk',  auth.requireAuth(['admin']), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'talk.html')));
app.get('/admin/talk/', auth.requireAuth(['admin']), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'talk.html')));
app.get('/admin/sales',  auth.requireAuth(['admin']), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'sales.html')));
app.get('/admin/sales/', auth.requireAuth(['admin']), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'sales.html')));

// Per Bot 20 — Reports hub: a single extensible framework (REPORTS
// registry below) rather than a bespoke page per report, so adding a new
// report later is a data function + one registry entry, not a new page.
app.get('/admin/reports',  auth.requireAuth(['admin']), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'reports.html')));
app.get('/admin/pages',    auth.requireAuth(['admin']), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'pages.html')));
app.get('/admin/reports/', auth.requireAuth(['admin']), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'reports.html')));

// ── Legal document public pages ──
app.get('/legal', (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal.html')));
app.get('/legal/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal.html')));
app.get('/legal/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal.html')));

// ── Legal document API — public ──
app.get('/api/legal', (req, res) => {
  try { res.json(db.getAllCurrentLegalDocuments(req.query.skin || null)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/legal/:slug', (req, res) => {
  try {
    const doc = req.query.version
      ? db.getLegalDocumentVersion(req.params.slug, parseInt(req.query.version))
      : db.getLegalDocument(req.params.slug, req.query.skin || null);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    res.json(doc);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/legal/:slug/history', (req, res) => {
  try { res.json(db.getLegalDocumentHistory(req.params.slug)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Legal consent — authenticated users ──
app.get('/api/my/consents', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const pending = db.getPendingConsentsForUser(req.user.id);
    const history = db.getUserConsentHistory(req.user.id);
    res.json({ pending, history });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/my/consents', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const { documentId, slug, version } = req.body;
    if (!documentId || !slug || !version) return res.status(400).json({ error: 'documentId, slug, and version required.' });
    const id = uuidv4();
    db.recordLegalConsent(id, req.user.id, documentId, slug, parseInt(version));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: legal documents ──
app.get('/api/admin/legal', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getAllLegalDocumentsAdmin()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/legal', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { slug, title, content, requiresConsent, skinId } = req.body;
    if (!slug || !title || !content) return res.status(400).json({ error: 'slug, title, and content required.' });
    if (skinId && !db.getSkin(skinId)) return res.status(400).json({ error: 'That is not a valid skin.' });
    const id      = uuidv4();
    const version = db.createLegalDocument(id, slug.toLowerCase().replace(/\s+/g,'-'), title, content, requiresConsent, skinId || null);
    res.json({ id, version });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/legal/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { title, content, requiresConsent, action } = req.body;
    if (action === 'publish') {
      db.publishLegalDocument(req.params.id);
      return res.json({ ok: true });
    }
    db.updateLegalDocument(req.params.id, title, content, requiresConsent);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/legal/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    db.deleteLegalDocumentDraft(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: legal document translations — on-demand, admin-reviewed ──
// Deliberately NOT auto-generated or auto-served like the email template
// translations. Per's instruction: only translate when someone actually
// needs it, and always present the result as an editable draft for Per to
// read and confirm before it can go live — never silently serve an
// AI-translated legal document to a real user.
app.get('/api/admin/legal/:id/translations', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getLegalTranslationsForDoc(req.params.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Generates (or regenerates) a draft translation of one legal document
// version into the requested language. Always lands as status='draft' —
// this endpoint never publishes anything itself.
app.post('/api/admin/legal/:id/translate', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { language, note } = req.body;
    if (!language) return res.status(400).json({ error: 'language is required, e.g. "es", "nl", "fr".' });

    const doc = db.getLegalDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });

    const languageName = LANGUAGE_NAMES[language] || language;
    const raw = await callClaudeRaw(
      'You translate legal documents. Preserve the Markdown formatting EXACTLY — every #, ##, **, -, and blank line must stay in the same structural place, only the human-readable text changes. Preserve every email address, URL, and proper name unchanged. Respond with ONLY a JSON object: {"title":"...","content":"..."} — no preamble, no markdown code fences around the JSON itself, no commentary.',
      [{ role: 'user', content: `Translate this legal document into ${languageName}.\n\nTITLE: ${doc.title}\n\nCONTENT:\n${doc.content}` }],
      4000
    );
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); }
    if (!parsed.title || !parsed.content) throw new Error('Translation response missing title or content.');

    const translation = db.addLegalTranslation(uuidv4(), doc.id, doc.slug, language, parsed.title, parsed.content, note || null);
    res.json(translation);
  } catch(e) {
    console.error('legal translate error:', e.message);
    res.status(500).json({ error: 'Could not generate translation: ' + e.message });
  }
});

app.patch('/api/admin/legal/translations/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { title, content, action } = req.body;
    if (action === 'publish')   { db.publishLegalTranslation(req.params.id);   return res.json({ ok: true }); }
    if (action === 'unpublish') { db.unpublishLegalTranslation(req.params.id); return res.json({ ok: true }); }
    if (title !== undefined || content !== undefined) {
      const existing = db.getLegalTranslationById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Translation not found.' });
      db.updateLegalTranslation(req.params.id, title !== undefined ? title : existing.title, content !== undefined ? content : existing.content);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/legal/translations/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    db.deleteLegalTranslation(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Public: legal document translation ── Falls back to the English original
// if no published translation exists for this language yet — so linking to
// a language that hasn't been requested/confirmed never breaks, it just
// shows English until someone asks and Per confirms a translation.
app.get('/api/legal/:slug/translation/:language', (req, res) => {
  try {
    const translation = db.getPublishedLegalTranslation(req.params.slug, req.params.language);
    if (translation) return res.json({ title: translation.title, content: translation.content, language: req.params.language, translated: true });
    const original = db.getLegalDocument(req.params.slug);
    if (!original) return res.status(404).json({ error: 'Document not found.' });
    res.json({ title: original.title, content: original.content, language: 'en', translated: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Membership page ──
app.get('/membership',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'membership.html')));
// Public — works logged in (auto-fills from /api/account) or anonymous, since
// it's meant to be linkable from outside the app (Per Bot 5, item 11).
app.get('/become-a-facilitator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'become-a-facilitator.html')));
app.get('/become-a-facilitator/', (req, res) => res.redirect('/become-a-facilitator'));
app.get('/membership/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'membership.html')));
// Per's request — the marketing/recruiting page, distinct from
// become-a-facilitator.html above (that one's a narrow request form for
// existing members; this one is the richer pitch page a genuinely
// prospective facilitator — not a member, not logged in at all — lands
// on first, which then leads into that same form as its call to action).
app.get('/teaching-the-felt-way', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teaching-the-felt-way.html')));
app.get('/teaching-the-felt-way/', (req, res) => res.redirect('/teaching-the-felt-way'));
// ── Public course catalog pages (Per's request) ── The student-facing
// counterpart to Teaching The FELT Way above — a schedule listing, plus
// three detail-page types, all genuinely public (no auth, same reasoning
// as the API routes these call — see /api/public/* above). :id routes
// serve one static HTML shell each; that shell's own client-side JS
// reads the id straight off location.pathname and fetches the real data
// itself, same pattern already used for e.g. openCourseDetail elsewhere
// in this app, just for a logged-out audience.
app.get('/courses', (req, res) => res.sendFile(path.join(__dirname, 'public', 'courses.html')));
app.get('/courses/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'course-overview.html')));
app.get('/course-instance/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'course-instance.html')));
app.get('/facilitators/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'facilitator-bio.html')));

// ── App setup / identity settings (Path A: one deployment per facilitator/org) ──
// Admin-only. Same page serves two purposes depending on setup_completed:
// a first-run wizard on a fresh clone, or — once that's done — the
// ongoing "App setup" settings screen linked from the admin nav (Per Bot
// 11). The route itself doesn't branch on that; setup.html's own JS reads
// setup_completed from /api/setup/config and adjusts its copy/button
// accordingly, since this was always meant to be revisitable (see the
// comment on PATCH /api/setup below), it just had no link pointing at it
// before now.
app.get('/setup', auth.requireAuth(['admin']), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.get('/api/setup/config', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getAppConfig()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Partial settings update ── /api/setup below is the FULL setup-wizard
// endpoint — it requires brandName, legalEntityName, and contactEmail on
// every call, and defaults several other fields if they're missing from the
// request. That's correct for the wizard, which always submits everything
// together, but it's the wrong endpoint for a single admin panel saving
// just one setting (reminder threshold, newsletter footer, etc.) — calling
// it with a partial payload either gets rejected by the required-field
// checks, or worse, would silently reset unrelated fields (tagline,
// colour, currency...) back to their defaults. This endpoint is the safe
// alternative: only touches whatever fields are actually present in the
// request body, nothing else.
// Per Bot 18 — minimal GET so the Sales & Marketing page can show the
// current default showcase file without pulling in the full setup-wizard
// config shape. Deliberately narrow rather than a general settings GET.
app.get('/api/admin/settings/default-showcase-file', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json({ defaultShowcaseFileId: db.getAppConfig()?.default_showcase_file_id || null }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Per Bot 24 — the old trial-sequence GET/test-send endpoints (and the
// TRIAL_TEST_SENDERS lookup) are gone — no frontend code calls either
// one anymore, since sales.html's Trial sequence section was already
// built on the shared comms2 editor from the start, which reads
// message_versions directly and has its own generic Send test panel
// (/api/admin/message-versions/:type/test).

// Per Bot 24 — same for the old Savers Protocol GET/test-send endpoints
// and SAVERS_TEST_SENDERS below — sales.html's Savers section was
// already on the shared editor too, so nothing calls these anymore.

app.patch('/api/admin/settings', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const fieldMap = { reminderDays: 'reminder_days', reminderSubject: 'reminder_subject', reminderBody: 'reminder_body', reminderSmsBody: 'reminder_sms_body', reminderFormat: 'reminder_format', newsletterFooter: 'newsletter_footer', renewalReminderDays: 'renewal_reminder_days', renewalReminderSubject: 'renewal_reminder_subject', renewalReminderBody: 'renewal_reminder_body', renewalReminderSmsBody: 'renewal_reminder_sms_body', renewalReminderFormat: 'renewal_reminder_format', testEmail: 'test_email', testPhone: 'test_phone', birthdayEmailSubject: 'birthday_email_subject', birthdayEmailBody: 'birthday_email_body', birthdaySmsBody: 'birthday_sms_body', birthdayEmailFormat: 'birthday_email_format', defaultShowcaseFileId: 'default_showcase_file_id', trialDay3Subject: 'trial_day3_subject', trialDay3Body: 'trial_day3_body', trialDay3Format: 'trial_day3_format', trialDay7Subject: 'trial_day7_subject', trialDay7Body: 'trial_day7_body', trialDay7Format: 'trial_day7_format', trialDay10Subject: 'trial_day10_subject', trialDay10Body: 'trial_day10_body', trialDay10Format: 'trial_day10_format', trialDay14Subject: 'trial_day14_subject', trialDay14Body: 'trial_day14_body', trialDay14Format: 'trial_day14_format', saversCancelDay0Subject: 'savers_cancel_day0_subject', saversCancelDay0Body: 'savers_cancel_day0_body', saversCancelDay0Format: 'savers_cancel_day0_format', saversCancelGrace0Subject: 'savers_cancel_grace0_subject', saversCancelGrace0Body: 'savers_cancel_grace0_body', saversCancelGrace0Format: 'savers_cancel_grace0_format', saversCancelMidSubject: 'savers_cancel_mid_subject', saversCancelMidBody: 'savers_cancel_mid_body', saversCancelMidFormat: 'savers_cancel_mid_format', saversCancelFinalSubject: 'savers_cancel_final_subject', saversCancelFinalBody: 'savers_cancel_final_body', saversCancelFinalFormat: 'savers_cancel_final_format', saversFailureDay0Subject: 'savers_failure_day0_subject', saversFailureDay0Body: 'savers_failure_day0_body', saversFailureDay0Format: 'savers_failure_day0_format', saversFailureMidSubject: 'savers_failure_mid_subject', saversFailureMidBody: 'savers_failure_mid_body', saversFailureMidFormat: 'savers_failure_mid_format', saversFailureFinalSubject: 'savers_failure_final_subject', saversFailureFinalBody: 'savers_failure_final_body', saversFailureFinalFormat: 'savers_failure_final_format', newsletterWelcomeSubject: 'newsletter_welcome_subject', newsletterWelcomeBody: 'newsletter_welcome_body', newsletterWelcomeFormat: 'newsletter_welcome_format', trialExtendedSubject: 'trial_extended_subject', trialExtendedBody: 'trial_extended_body', trialExtendedFormat: 'trial_extended_format', defaultLessonVisibility: 'default_lesson_visibility' /* Per Bot 24 */,
  whatsNewEnabled: 'whats_new_enabled', whatsNewBody: 'whats_new_body', whatsNewLinkType: 'whats_new_link_type', whatsNewLinkId: 'whats_new_link_id', whatsNewSecondsPerItem: 'whats_new_seconds_per_item', nextActionDefaultFileId: 'next_action_default_file_id' /* Per Bot 24 */,
  carouselSpeedSeconds: 'carousel_speed_seconds' /* Per Bot 48 */ };
    const fields = {};
    Object.keys(fieldMap).forEach(k => { if (req.body[k] !== undefined) fields[fieldMap[k]] = req.body[k]; });
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to update.' });
    db.updateAppConfig(fields);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/setup', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { brandName, tagline, primaryColor, contactEmail, currency, legalEntityName, legalJurisdiction, paymentsEnabled, appName, useCalmLanding, talkPersonaName, allowCustomVoice } = req.body;
    if (!brandName || !brandName.trim()) return res.status(400).json({ error: 'Organisation name is required.' });
    if (!legalEntityName || !legalEntityName.trim()) return res.status(400).json({ error: 'Legal entity name is required — it appears in your Privacy Policy and Terms.' });
    if (!contactEmail || !contactEmail.includes('@')) return res.status(400).json({ error: 'A valid contact email is required.' });

    db.updateAppConfig({
      brand_name: brandName.trim(),
      tagline: (tagline || '').trim() || 'Making the practices land and last for life.',
      primary_color: primaryColor || '#B4E6C8',
      contact_email: contactEmail.trim().toLowerCase(),
      currency: currency || 'gbp',
      legal_entity_name: legalEntityName.trim(),
      legal_jurisdiction: (legalJurisdiction || '').trim() || 'United Kingdom',
      payments_enabled: paymentsEnabled ? 1 : 0,
      app_name: (appName || '').trim() || null,
      use_calm_landing: useCalmLanding === undefined ? 1 : (useCalmLanding ? 1 : 0),
      talk_persona_name: (talkPersonaName || '').trim() || null,
      allow_custom_voice: allowCustomVoice === undefined ? 1 : (allowCustomVoice ? 1 : 0),
      setup_completed: 1,
    });

    // Regenerate the legal documents now, with the real identity — they
    // seeded with placeholder defaults on first boot, before this form
    // could ever have been filled in.
    db.regenerateLegalDocumentsFromConfig(() => uuidv4());

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Called any time from admin settings later (not just first-run) — same
// endpoint, same regeneration step, so identity changes always keep the
// legal documents in sync.
app.patch('/api/setup', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const fieldMap = {
      brandName: 'brand_name', tagline: 'tagline', primaryColor: 'primary_color',
      contactEmail: 'contact_email', currency: 'currency',
      legalEntityName: 'legal_entity_name', legalJurisdiction: 'legal_jurisdiction',
      paymentsEnabled: 'payments_enabled',
      reminderDays: 'reminder_days', reminderSubject: 'reminder_subject',
      newsletterFooter: 'newsletter_footer',
      appName: 'app_name',
    };
    const fields = {};
    Object.keys(fieldMap).forEach(k => {
      if (req.body[k] === undefined) return;
      fields[fieldMap[k]] = k === 'paymentsEnabled' ? (req.body[k] ? 1 : 0) : req.body[k];
    });
    db.updateAppConfig(fields);
    if (fields.legal_entity_name || fields.contact_email || fields.legal_jurisdiction) {
      db.regenerateLegalDocumentsFromConfig(() => uuidv4());
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Public — the safe subset of config any page's frontend can read to render
// brand name/color without exposing anything sensitive.
// Resolves which skin (if any) applies to the current request — based on
// the logged-in user's own account, NOT the URL they're currently on.
// That's deliberate: a skin is set once at registration and follows the
// person from then on (see setUserSkin in db.js), so it shows up
// correctly everywhere in the app, not just immediately after using a
// skin-specific login link.
function getRequestSkin(req) {
  try {
    const token = req.cookies?.[auth.COOKIE_NAME];
    const payload = token ? auth.verifyToken(token) : null;
    if (!payload || payload.role !== 'client') return null;
    const user = db.getUser(payload.id);
    if (!user || !user.skin_id) return null;
    return db.getSkin(user.skin_id);
  } catch (e) { return null; }
}
app.get('/api/config', (req, res) => {
  try {
    const cfg = db.getAppConfig() || {};
    const skin = getRequestSkin(req);
    res.json({
      brandName: (skin && skin.name) || cfg.brand_name,
      appName: (skin && skin.name) || cfg.app_name || cfg.brand_name,
      tagline: cfg.tagline,
      primaryColor: (skin && skin.primary_color) || cfg.primary_color,
      logoUrl: (skin && faviconUrl(skin.logo_url)) || cfg.logo_url,
      faviconUrl: (skin && faviconUrl(skin.favicon_url)) || cfg.favicon_url || null,
      paymentsEnabled: !!cfg.payments_enabled,
      currency: cfg.currency,
      legalEntityName: cfg.legal_entity_name,
      backgroundImages: (skin && skin.background_images.length) ? skin.background_images : undefined,
      skinId: (skin && skin.id) || undefined,
      skinContactName: (skin && skin.contact_name) || undefined,
      skinContactEmail: (skin && skin.contact_email) || undefined,
      useCalmLanding: cfg.use_calm_landing === null || cfg.use_calm_landing === undefined ? true : !!cfg.use_calm_landing,
      talkPersonaName: cfg.talk_persona_name || 'Per',
      talkPersonaPhotoUrl: faviconUrl(cfg.talk_persona_photo_url) || '/assets/tomte.png',
      allowCustomVoice: cfg.allow_custom_voice === null || cfg.allow_custom_voice === undefined ? true : !!cfg.allow_custom_voice,
      // Per Bot 24 — "What's New" home promo, now a rotating set (see
      // whats_new_items table) rather than one flat value. Only active
      // items go out, in creation order — the client just rotates
      // through whatever array it gets, no filtering of its own needed.
      whatsNewItems: db.getActiveWhatsNewItems().map(i => ({
        body: i.body || '', linkType: i.link_type || null, linkId: i.link_id || null,
      })),
      whatsNewSecondsPerItem: cfg.whats_new_seconds_per_item || 6,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Per Bot 18 — public, no-auth: what /membership actually shows and
// lets someone buy. Deliberately filters out any plan missing a real
// stripe_price_id even if marked active — a tier an admin has toggled on
// but not yet actually priced in Stripe would otherwise appear as a
// clickable option that fails at checkout. Scoped to tier 1 for now,
// matching what's actually live; the query itself already supports more
// tiers the moment real Stripe prices exist for them and this filter
// naturally becomes the whole membership picker's source of truth.
app.get('/api/public/membership-plans', (req, res) => {
  try {
    const plans = db.getMembershipPlans(true).filter(p => p.stripe_price_id && p.tier === 1);
    res.json(plans.map(p => ({
      id: p.id, billingCycle: p.billing_cycle, pricePence: p.price_pence,
      stripePriceId: p.stripe_price_id, trialDays: p.trial_days,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Stripe: create Checkout Session ──
app.post('/api/membership/checkout', auth.requireAuthApi(['client']), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payment system not configured yet.' });
  try {
    const { priceId, billing } = req.body;
    if (!priceId) return res.status(400).json({ error: 'priceId required.' });

    // Per Bot 18 — resolved from the membership_plans table now (the
    // Sales & Marketing "Active plans" screen), not a hardcoded object —
    // that's what makes editing a price or adding a new tier there
    // actually take effect here without a code change. Both active=1 and
    // a matching stripe_price_id are required, same filter as the public
    // /api/public/membership-plans endpoint that built the picker in the
    // first place, so a plan can't be bought via a stale/guessed priceId
    // even if it was once valid.
    const plan = db.getMembershipPlans(true).find(p => p.billing_cycle === billing && p.stripe_price_id === priceId);
    if (!plan) return res.status(400).json({ error: 'That plan isn\'t currently available.' });
    const resolvedTier = plan.tier;

    const user = db.getUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Reuse Stripe customer if we have one
    let customerId = user.stripe_customer_id || null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name:  user.name,
        metadata: { user_id: user.id }
      });
      customerId = customer.id;
      db.setMemberTier(user.id, user.member_tier || 0, null, null, customerId, null);
    }

    const isLifetime = billing === 'lifetime';
    const sessionParams = {
      customer:             customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode:                 isLifetime ? 'payment' : 'subscription',
      success_url:          `${APP_URL}/membership/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:           `${APP_URL}/membership`,
      metadata:             { user_id: user.id, billing, tier: String(resolvedTier) },
      client_reference_id:  user.id,
    };

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch(e) {
    console.error('[stripe checkout]', e.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// ── Stripe: success page (redirect after payment) ──
app.get('/membership/success', auth.requireAuth(['client']), async (req, res) => {
  // Webhook will have already fired and set the tier — just redirect to account
  res.redirect('/account?welcome=member');
});

// ── Message of the day — admin ──
app.get('/api/admin/motd', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { status } = req.query;
    const messages = db.getAllMotd(status || null);
    const approvedCount = db.countApprovedMotd();
    res.json({ messages, approvedCount, lowStock: approvedCount <= 5 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Message of the day — client archive ── Every stanza that's ever gone
// out, kept as a browsable resource (the "Poems" tab) — not a per-user
// delivery log, just the shared growing collection, newest first. Signed-in
// users only; the content itself isn't sensitive, but this keeps it inside
// the same access model as the rest of the practice space rather than
// exposing it as a fully public feed.
app.get('/api/motd/archive', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const sent = db.getAllMotd('sent')
      .map(m => ({ id: m.id, body: m.body, sent_at: m.sent_at }))
      .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
    res.json(sent);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/motd', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { body, scheduledDate } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'body required.' });
    const id = uuidv4();
    db.addMotd(id, body.trim(), scheduledDate || null);
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MOTD — AI-generated batch ──
// Calls Claude with the house voice + full signal-range prompt (prompts.js),
// asks for `count` new messages, parses the JSON array response, and inserts
// every one as a fresh draft — same as writing them by hand. Nothing is
// approved or scheduled automatically; they show up in the Drafts list for
// the normal edit/approve workflow.
// Generates one chunk and parses it — pulled out of the main handler so it
// can be both chunked (several smaller calls instead of one large one) and
// retried (transient network failures — including the "Premature close"
// error seen in practice, which reads like a proxy/connection timeout on a
// single large generation — are exactly the kind of thing a short retry
// fixes, since regenerating a few stanzas is harmless and idempotent).
async function generateMotdChunk(count, attempt = 1) {
  const userMessage = `Write ${count} new Message of the Day drafts. Cover as wide a spread of the signal range as you can across these ${count} messages — don't repeat the same signal more than necessary given the count. Respond with only the JSON array, nothing else.`;
  try {
    // callClaudeRaw, not callClaude — callClaude runs stripMarkdown() on the
    // response, which is meant for prose replies but is destructive here:
    // stanzas are five lines joined by literal \n inside a JSON string, and
    // stripMarkdown's regexes (bullet-dash stripping, #-stripping) can
    // corrupt that structure before JSON.parse ever sees it.
    const raw = await callClaudeRaw(prompts.MOTD_GENERATION_PROMPT, [{ role: 'user', content: userMessage }], 2000);
    try {
      return JSON.parse(raw);
    } catch {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      return JSON.parse(cleaned);
    }
  } catch (e) {
    if (attempt >= 3) throw e;
    console.error(`motd generate chunk failed (attempt ${attempt}/3): ${e.name || 'Error'}: ${e.message} — retrying`);
    await new Promise(r => setTimeout(r, 1000 * attempt)); // 1s, then 2s
    return generateMotdChunk(count, attempt + 1);
  }
}

app.post('/api/admin/motd/generate', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    let count = parseInt(req.body?.count, 10);
    if (!Number.isFinite(count) || count < 1) count = 12;
    count = Math.min(count, 30); // guardrail — one click shouldn't be able to flood the queue

    // Chunked into groups of at most 6, each with its own retry (see
    // generateMotdChunk above). The likely actual cause of "Premature
    // close" turned out to be stale connection reuse in Node's fetch, fixed
    // at the source in anthropicFetch — this chunking is kept anyway since
    // smaller requests are still faster and a late failure only loses the
    // one chunk still in flight, not the whole batch.
    const CHUNK_SIZE = 6;
    const chunks = [];
    let remaining = count;
    while (remaining > 0) { const n = Math.min(CHUNK_SIZE, remaining); chunks.push(n); remaining -= n; }

    let insertedCount = 0;
    const chunkErrors = [];

    for (const chunkCount of chunks) {
      try {
        const generated = await generateMotdChunk(chunkCount);
        if (!Array.isArray(generated) || !generated.length) throw new Error('Model did not return a usable list of messages.');
        generated
          .filter(msg => typeof msg === 'string' && msg.trim())
          .forEach(msg => { db.addMotd(uuidv4(), msg.trim(), null); insertedCount++; });
      } catch (e) {
        // Per's suggestion: keep enough detail here that a repeat failure
        // is actually diagnosable from the error message alone, not just
        // "it failed again" — the error's name (e.g. AbortError, TypeError)
        // distinguishes a timeout from a parse failure from a network drop.
        console.error('motd generate chunk permanently failed:', e.name + ':', e.message);
        chunkErrors.push(`${e.name || 'Error'}: ${e.message}`);
      }
    }

    if (insertedCount === 0) throw new Error(chunkErrors[0] || 'Model did not return any usable messages.');

    res.json({
      ok: true,
      count: insertedCount,
      partial: chunkErrors.length > 0,
      note: chunkErrors.length ? `${insertedCount} added, but ${chunkErrors.length} chunk(s) failed after retries — you can generate another batch to top up.` : undefined,
    });
  } catch(e) {
    console.error('motd generate error:', e);
    // Admin-only endpoint, so it's safe (and much more useful than a dead
    // end) to surface the actual error rather than a generic message —
    // "Could not generate messages. Please try again." with no detail
    // gives no way to tell a parse failure from an API/auth failure from a
    // network issue without going and reading server logs separately.
    res.status(500).json({ error: 'Could not generate messages: ' + (e.message || 'unknown error') });
  }
});

// Per Bot 17 — Message builder: reformats a piece of source content into
// platform-ready social copy. No posting integration exists (checked the
// MCP registry — nothing available for direct social posting; closest
// matches were analytics tools, not publishing ones), so this only ever
// returns text for Per to copy and paste manually. Same JSON-parse-with-
// markdown-fence-fallback pattern as generateMotdChunk above, since the
// model occasionally wraps JSON in ```json fences despite being told not to.
//
// Per Bot 17 phase 4 — includeCta + offerId added. When includeCta is on,
// the model is told to write a hook line and a closing invitation with a
// literal {{SIGNUP_LINK}} token (see MESSAGE_BUILDER_CTA_INSTRUCTIONS in
// prompts.js for why the model never writes the actual URL itself); the
// real link is substituted in below, after generation, so it's always
// correct even if the offer/trial length changes later. Every generation
// is saved to social_posts for the History panel, whether or not the CTA
// was included.
app.post('/api/admin/message-builder/generate', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const sourceText = (req.body?.sourceText || '').trim();
    const platforms = Array.isArray(req.body?.platforms)
      ? req.body.platforms.filter(p => typeof p === 'string' && p.trim())
      : [];
    if (!sourceText) return res.status(400).json({ error: 'Source content is required.' });
    if (!platforms.length) return res.status(400).json({ error: 'Select at least one platform.' });

    const includeCta = req.body?.includeCta !== false; // default on
    let offer = null;
    if (includeCta) {
      offer = req.body?.offerId ? db.getOffer(req.body.offerId) : db.getDefaultOffer();
      if (offer && !db.isOfferCurrentlyValid(offer)) offer = null; // don't promote a dead/expired offer
    }

    const ctaInstructions = (includeCta && offer)
      ? prompts.MESSAGE_BUILDER_CTA_INSTRUCTIONS.replace(/\{\{TRIAL_DAYS\}\}/g, offer.trial_days)
      : 'Do not add any signup hook, closing invitation, or link — produce only the reformatted message itself, per the platform shapes above.';
    const systemPrompt = prompts.MESSAGE_BUILDER_PROMPT.replace('{{CTA_INSTRUCTIONS}}', ctaInstructions);

    const userMessage = `SOURCE CONTENT:\n${sourceText}\n\nPLATFORMS TO PRODUCE: ${platforms.join(', ')}\n\nRespond with only the JSON object, nothing else.`;
    const raw = await callClaudeRaw(systemPrompt, [{ role: 'user', content: userMessage }], 1500);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      parsed = JSON.parse(cleaned);
    }

    if (includeCta && offer) {
      // Per Bot 18 — every produced link now carries a source tag, no
      // exceptions. Each platform gets its own link tagged with that
      // platform's name, so a single generation batch (e.g. Facebook +
      // LinkedIn + Instagram in one go) still shows up as three separately
      // comparable rows in the funnel report, not one merged untagged hit.
      Object.keys(parsed).forEach(k => {
        if (typeof parsed[k] !== 'string') return;
        const link = `${APP_URL}/promo/${offer.code}?src=${encodeURIComponent(k)}`;
        parsed[k] = parsed[k].split('{{SIGNUP_LINK}}').join(link);
      });
    }

    const postId = db.addSocialPost(sourceText, platforms, parsed, offer ? offer.id : null);
    res.json({ ok: true, results: parsed, postId });
  } catch (e) {
    console.error('message builder generate error:', e);
    // Admin-only endpoint — surface the real error rather than a generic
    // message, same reasoning as the MOTD generate route above.
    res.status(500).json({ error: 'Could not generate posts: ' + (e.message || 'unknown error') });
  }
});

// ── BulkPublish integration (Per Bot 18) ──
// Publishes message-builder output directly to the connected social
// accounts, instead of only ever producing copy-paste text. Talks to
// BulkPublish's REST API (app.bulkpublish.com) using an API key kept in
// Railway's environment — never hardcoded, never sent to the browser.
const BULKPUBLISH_BASE = 'https://app.bulkpublish.com/api';
async function bulkPublishRequest(method, path, body) {
  const apiKey = process.env.BULKPUBLISH_API_KEY;
  if (!apiKey) throw new Error('BULKPUBLISH_API_KEY is not set — add it in Railway before publishing.');
  const res = await fetch(`${BULKPUBLISH_BASE}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `BulkPublish returned ${res.status}`);
  return data;
}

// Lists connected channels — the admin UI uses this to show which of the
// four platforms actually have a live connection before offering a
// Publish button for it, rather than letting someone click Publish on a
// platform that was never connected and get a confusing failure.
app.get('/api/admin/bulkpublish/channels', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const data = await bulkPublishRequest('GET', '/channels');
    res.json({ ok: true, channels: data.channels || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Publishes one platform's already-generated text immediately (status
// 'published', not scheduled) to whichever connected channel matches that
// platform. Text-only for now — media attachment (the video generator's
// output) is a natural next step once this is working end to end, not
// bundled in here to keep the first real publish simple to verify.
app.post('/api/admin/bulkpublish/publish', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { platform, text } = req.body;
    if (!platform || !text || !text.trim()) return res.status(400).json({ error: 'platform and text are required.' });
    const { channels } = await bulkPublishRequest('GET', '/channels');
    const channel = (channels || []).find(c => (c.platform || '').toLowerCase() === platform.toLowerCase());
    if (!channel) return res.status(400).json({ error: `${platform} isn't connected in BulkPublish yet — connect it in the Channels page first.` });
    const post = await bulkPublishRequest('POST', '/posts', {
      content: text,
      channels: [{ channelId: channel.id, platform: channel.platform }],
      status: 'published',
    });
    res.json({ ok: true, post });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Message builder history (Per Bot 17 phase 4) ──
app.get('/api/admin/social-posts', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getAllSocialPosts()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/social-posts/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteSocialPost(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Signal lines / line bank (Per Bot 17 phase 6) ──
app.get('/api/admin/signal-lines', auth.requireAuthApi(['admin']), (req, res) => {
  try { res.json(db.getAllSignalLines()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/signal-lines', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { text, prior_tag, status } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Line text is required.' });
    const id = db.createSignalLine({ text: text.trim(), prior_tag: prior_tag || 'general', status: status || 'active', source: 'manual' });
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/signal-lines/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.updateSignalLine(req.params.id, req.body); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/signal-lines/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteSignalLine(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Per Bot 17 phase 6 — "re-check current trends." Runs a real, live web
// search (Anthropic's native tool, not a canned prompt) to find what's
// genuinely weighing on people right now, then writes new lines in the
// established voice, tied to whichever of the three primary priors each
// pressure actually expresses. Everything lands as status='draft' —
// never auto-activated — so nothing reaches /promotions, the message
// builder, or anywhere else without Per reviewing it first. Same
// JSON-parse-with-fence-fallback pattern used throughout this file.
app.post('/api/admin/signal-lines/trend-scan', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    // Per Bot 18 — this was failing with a 500 on the old 2000-token /
    // 45s budget. A trend scan needs several rounds of live web search
    // before Claude ever writes the final JSON, and both the token
    // ceiling and the timeout were too tight to reliably survive that —
    // same class of issue as the "Sonnet adaptive thinking draws from the
    // same max_tokens budget as the reply" lesson learned elsewhere in
    // this project. Raised both rather than just one, since either alone
    // could still cut the run short.
    const raw = await anthropicFetchWithWebSearch(
      prompts.SIGNAL_LINE_TREND_SCAN_PROMPT,
      [{ role: 'user', content: 'Find current trends and write the lines now.' }],
      4000,
      90000
    );
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      parsed = JSON.parse(cleaned);
    }
    if (!Array.isArray(parsed)) throw new Error('Unexpected response shape from trend scan.');
    const created = parsed
      .filter(l => l && typeof l.text === 'string' && l.text.trim())
      .map(l => db.createSignalLine({
        text: l.text.trim(),
        prior_tag: ['fear', 'belonging', 'mattering'].includes(l.prior_tag) ? l.prior_tag : 'general',
        status: 'draft',
        source: 'trend-scan',
        trend_context: l.trend_context || null,
      }));
    res.json({ ok: true, count: created.length });
  } catch (e) {
    console.error('signal-lines trend-scan error:', e);
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    res.status(500).json({ error: timedOut
      ? 'The trend scan took too long and timed out — this can happen if the search is having a slow moment. Try again.'
      : 'Could not run the trend scan: ' + (e.message || 'unknown error') });
  }
});

// Public — a single random active line, for /promotions and anywhere
// else on the public site that wants to rotate one in. Deliberately
// minimal (just the text) since nothing beyond the line itself is ever
// meant to be publicly visible.
app.get('/api/public/signal-line', (req, res) => {
  const line = db.getRandomActiveSignalLine();
  if (!line) return res.status(404).json({ error: 'No active lines.' });
  res.json({ text: line.text });
});

function maybeSendMotdLowStockAlert(remaining) {
  if (remaining > 5) return;
  const b = brand();
  sendEmail(process.env.ADMIN_EMAIL || b.contactEmail,
    `⚠️ Message of the day — only ${remaining} approved message${remaining === 1 ? '' : 's'} remaining`,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px">
      <h2 style="font-weight:normal">Message queue running low</h2>
      <p>There ${remaining === 1 ? 'is' : 'are'} only <strong>${remaining}</strong> approved message${remaining === 1 ? '' : 's'} of the day left in the queue.</p>
      <p>Please add and approve more at <a href="${APP_URL}/admin/">${APP_URL}/admin/</a></p>
      <hr/><p style="font-size:12px;color:#aaa">${b.name}</p>
    </div>`
  );
}

// ── MOTD — bulk approve ──
// Approves every id in the list, then checks stock ONCE at the end — not once
// per item, which would otherwise fire the low-stock alert email repeatedly
// while working through a big batch of drafts.
// MUST be registered before the /:id route below — otherwise Express matches
// the literal path segment "bulk-approve" as if it were an :id parameter, and
// this route never gets hit at all. (Same bug caught and fixed on
// /api/admin/facilitator-requests/bulk — missed re-checking this one at the time.)
app.patch('/api/admin/motd/bulk-approve', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'No messages selected.' });
    ids.forEach(id => db.approveMotd(id));
    const remaining = db.countApprovedMotd();
    maybeSendMotdLowStockAlert(remaining);
    res.json({ ok: true, approvedCount: remaining, lowStock: remaining <= 5, approved: ids.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/motd/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { body, scheduledDate, action } = req.body;
    if (action === 'approve') {
      db.approveMotd(req.params.id);
      // After approving, check if stock is low and alert Per
      const remaining = db.countApprovedMotd();
      maybeSendMotdLowStockAlert(remaining);
      return res.json({ ok: true, approvedCount: remaining, lowStock: remaining <= 5 });
    }
    if (body != null) db.updateMotd(req.params.id, body.trim(), scheduledDate || null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/motd/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteMotd(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MOTD email markup — shared by the real send (sendDailyMotd) and the ──
// admin test-send endpoint below, so a test email is pixel-identical to
// what a real recipient gets. Only extracted, not changed.
function buildMotdHtml(body, b) {
  return `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
        <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:24px">${b.name}</div>
        <p style="font-size:17px;line-height:1.8;color:#1a1a1a;margin-bottom:32px">${body.replace(/\n/g, '<br/>')}</p>
        <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
        <p style="font-size:12px;color:#aaa">
          You're receiving this because you're a member of ${b.name}.
          <a href="${APP_URL}/client/" style="color:#2d6a4f">Visit your practice space</a> ·
          <a href="${APP_URL}/account" style="color:#888">Manage preferences</a>
        </p>
      </div>`;
}

// ── Newsletter email markup — shared by the real send and the admin ──
// test-send endpoint, same principle as buildMotdHtml above. Subject gets
// its own heading treatment (unlike MOTD, which has no subject at all) since
// a newsletter is a proper piece of correspondence, not a short stanza.
const DEFAULT_NEWSLETTER_FOOTER = `You're receiving this because you're part of {{brand_name}}.\n{{unsubscribe_link}}`;

// ── Rich body post-processing ── Converts what the editor produces into
// what actually needs to go out in an email. Two things need fixing up:
//
// 1. Buttons — the editor renders them via a CSS class (.nl-button) for a
//    live WYSIWYG look, but email clients strip <style> blocks and
//    class-based styling almost universally, so the class means nothing by
//    the time it reaches an inbox. This finds every button-tagged link and
//    replaces it with the same tag carrying real inline styles instead.
//
// 2. Columns — the editor marks each cell contenteditable="true" and tags
//    them data-column-cell so the browser allows typing/pasting into them
//    independently of Quill's own Delta model. Neither attribute means
//    anything once the message is sent — contenteditable specifically has
//    no business in an email a recipient can't edit — so both are stripped.
//
// This is plain string/regex work, not DOM manipulation, since Node has no
// DOM — safe here because Quill's own serialization of these two specific
// patterns is predictable and narrow (an <a class="nl-button"...> tag, and
// td elements carrying these two specific attributes), not general-purpose
// HTML sanitization.
// ── Unified message editor (Per Bot 19) ── format-aware body rendering,
// shared by every context. 'rich' bodies come straight from the same
// Quill setup Newsletters already used (see postProcessRichBody just
// below — genuinely reusable as-is, it was never newsletter-specific
// logic, just the only place it was called from). 'plain' bodies keep
// each context's existing paragraph rendering — renderEmailParagraphs for
// the multi-paragraph templates (Trial/Savers/Reminder/Renewal/
// Birthday/Campaign), which is unchanged from before this session.
function renderMessageBody(text, format) {
  return format === 'rich' ? postProcessRichBody(String(text || '')) : renderEmailParagraphs(text);
}

function postProcessRichBody(html) {
  return html
    .replace(/<a\s+([^>]*\bclass=["']nl-button["'][^>]*)>([\s\S]*?)<\/a>/gi, (match, attrs, innerText) => {
      const hrefMatch = attrs.match(/href=["']([^"']*)["']/i);
      const href = hrefMatch ? hrefMatch[1] : '#';
      // Color choice (Per Bot 8) — the editor applies the chosen color as
      // an inline style on the button itself, so it's read back here
      // rather than assumed; old buttons with no stored color (sent
      // before this feature existed) fall back to the original green.
      const styleMatch = attrs.match(/style=["']([^"']*)["']/i);
      const bgMatch = styleMatch && styleMatch[1].match(/background(?:-color)?\s*:\s*([^;]+)/i);
      const bg = bgMatch ? bgMatch[1].trim() : '#2d6a4f';
      return `<a href="${href}" style="display:inline-block;background:${bg};color:#ffffff;padding:11px 26px;border-radius:6px;text-decoration:none;font-family:Georgia,serif;font-size:14px;margin:10px 0;">${innerText}</a>`;
    })
    .replace(/\s*contenteditable=["'][^"']*["']/gi, '')
    .replace(/\s*data-column-cell=["'][^"']*["']/gi, '')
    // Margin reset (Per Bot 8) — Quill's own editor CSS zeroes the margin
    // on every block element (p, h2/h3, ul/ol, li) so spacing while writing
    // comes only from actual blank-line paragraphs, never from browser
    // defaults. That stylesheet is Quill's own — it never ships with the
    // sent email — so without this, every one of those tags falls back to
    // whatever margin the recipient's email client defaults to (often
    // close to a full line each), which is exactly the "lots of extra
    // white space" bug: nothing about the written text changed, the HTML
    // just lost the styling context that had been hiding those margins.
    // Setting margin:0 explicitly here restores what the editor actually
    // showed — any real spacing the person wrote (a genuine blank line)
    // still shows up on its own, since that comes from line-height, not
    // from a paragraph's margin.
    .replace(/<p>/gi, '<p style="margin:0;">')
    .replace(/<p class="([^"]*)">/gi, '<p class="$1" style="margin:0;">')
    .replace(/<h2>/gi, '<h2 style="margin:0 0 12px;">')
    .replace(/<h2 class="([^"]*)">/gi, '<h2 class="$1" style="margin:0 0 12px;">')
    .replace(/<h3>/gi, '<h3 style="margin:0 0 10px;">')
    .replace(/<h3 class="([^"]*)">/gi, '<h3 class="$1" style="margin:0 0 10px;">')
    .replace(/<ul>/gi, '<ul style="margin:0 0 12px;padding-left:24px;">')
    .replace(/<ol>/gi, '<ol style="margin:0 0 12px;padding-left:24px;">')
    .replace(/<li>/gi, '<li style="margin:0 0 4px;">');
}

// format: 'plain' (body is plain text, \n becomes <br/>, same as before) or
// 'rich' (body is already HTML from the compose editor, used as-is —
// running it through the \n replace would double up on the editor's own
// <p>/<br> tags). footerHtml is the fully-resolved footer for this specific
// recipient (unsubscribe link already substituted in) — see the send loop
// below, which is why this isn't just read from config directly in here.
function buildNewsletterHtml(subject, body, b, format, footerHtml) {
  const bodyHtml = format === 'rich' ? postProcessRichBody(body) : body.replace(/\n/g, '<br/>');
  const logoBlock = b.logoUrl
    ? `<img src="${b.logoUrl}" alt="${b.name}" style="max-height:48px;margin-bottom:12px"/>`
    : `<div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">${b.name}</div>`;

  return `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;color:#2a2a2a">
        ${logoBlock}
        <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">${subject}</h1>
        <div style="font-size:15px;line-height:1.75;color:#333">${bodyHtml}</div>
        <hr style="border:none;border-top:1px solid #e0e0e0;margin:32px 0 20px"/>
        <div style="font-size:12px;color:#aaa;line-height:1.7">${footerHtml}</div>
      </div>`;
}

// Fills {{brand_name}} and {{unsubscribe_link}} in the footer template —
// separate from the {{name}}/{{invite_link}} substitution used on
// subject/body, since the footer is admin-configured (Settings), not
// something typed fresh into the compose box each time.
function buildNewsletterFooterHtml(footerTemplate, b, unsubscribeUrl) {
  const template = (footerTemplate && footerTemplate.trim()) || DEFAULT_NEWSLETTER_FOOTER;
  const unsubscribeLinkHtml = `<a href="${unsubscribeUrl}" style="color:#888">Unsubscribe</a> · <a href="${APP_URL}/account" style="color:#888">Manage what you receive</a>`;
  return template
    .split('{{brand_name}}').join(b.name)
    .split('{{unsubscribe_link}}').join(unsubscribeLinkHtml)
    .replace(/\n/g, '<br/>');
}

// ── MOTD send — manual/admin override ── Used by the "Send today's message"
// admin button. Broadcasts IMMEDIATELY to every currently opted-in recipient,
// ignoring each person's chosen day/hour — this is a deliberate override for
// emergencies or one-off testing, not part of the per-user schedule below.
// Operates on whichever message is already "today's active" one (so it
// doesn't fight with sendScheduledMotd() over which message is current); if
// nothing has been activated yet today, it activates the next queued one
// itself. Either way it finalises that message as 'sent' immediately,
// ending its day early for anyone still waiting on their scheduled hour —
// acceptable for a manual override, not for the automatic hourly sender.
async function sendDailyMotd() {
  const today = new Date().toISOString().slice(0, 10);
  let motd = db.getActiveMotdForDate(today);
  if (!motd) {
    motd = db.getNextMotdToSend();
    if (!motd) return { ok: true, sent: 0, note: 'No approved messages in queue.' };
    db.activateMotd(motd.id, today);
  }

  const recipients = db.getMotdRecipients();
  if (!recipients.length) {
    db.markMotdSent(motd.id);
    return { ok: true, sent: 0, note: 'No recipients opted in.' };
  }

  // Send to each recipient individually so we can personalise the greeting
  let sent = 0;
  const b = brand();
  for (const user of recipients) {
    await sendEmail(user.email, `From ${b.name} — a moment for today`, buildMotdHtml(motd.body, b));
    sent++;
  }

  db.markMotdSent(motd.id);

  // Check remaining and alert Per if low
  const remaining = db.countApprovedMotd();
  if (remaining <= 5) {
    await sendEmail(process.env.ADMIN_EMAIL || 'per@deepermindfulness.org',
      `⚠️ MOTD queue — ${remaining} message${remaining === 1 ? '' : 's'} remaining`,
      `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px">
        <p>Today's message was sent to ${sent} recipient${sent === 1 ? '' : 's'}.</p>
        <p>Only <strong>${remaining}</strong> approved message${remaining === 1 ? '' : 's'} left. Please add more.</p>
        <p><a href="${APP_URL}/admin/">${APP_URL}/admin/</a></p>
      </div>`
    );
  }

  return { ok: true, sent, remaining, lowStock: remaining <= 5 };
}

// ── Timezone-aware local day/hour/date for one user ── SQLite has no IANA
// timezone support, so "is it this user's chosen hour right now" can only be
// computed per-row in JS via Intl.DateTimeFormat, not filtered in SQL — this
// is why sendScheduledMotd() below fetches all candidates and matches in a
// loop rather than doing it in the query. Throws if the stored timezone
// string is invalid (defensive — shouldn't happen, since PATCH /api/account
// validates on the way in, but a bad row should never crash the whole
// scheduled send for everyone else).
function getLocalDayHourDate(timezone, nowUtc) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: 'numeric', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(nowUtc);
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0; // some ICU builds return "24" rather than "00" at local midnight
  return { day: weekdayMap[map.weekday], hour, dateStr: `${map.year}-${map.month}-${map.day}` };
}

// Per Bot 24 (activity/engagement, group 1) — the local hour (in this
// person's own current timezone, DST included) their recent genuine
// engagement clusters around, computed properly per-timestamp rather
// than matching on raw stored UTC hour. That distinction actually
// matters here specifically: someone due a reminder has by definition
// gone quiet, so their relevant history often spans a season — a
// UTC-hour match would silently drift by an hour across a DST boundary,
// while this stays correct since each historical timestamp is converted
// into local terms using their *current* timezone rule, same as
// getLocalDayHourDate already does for "now" above. Returns null when
// there's no history yet, so the caller can fall back to their explicit
// motd_hour preference instead of guessing at nothing.
function getPreferredLocalHour(userId, timezone) {
  const timestamps = db.getRecentPlayTimestamps(userId, 50);
  if (!timestamps.length) return null;
  const counts = {};
  for (const ts of timestamps) {
    let hour;
    try { hour = getLocalDayHourDate(timezone, new Date(ts.replace(' ', 'T') + 'Z')).hour; } // SQLite's datetime('now') format needs the T inserted before Z will parse reliably as UTC — same conversion already used elsewhere in this file.
    catch (e) { continue; } // bad/missing timezone on this user — skip rather than let one bad row break the whole computation
    counts[hour] = (counts[hour] || 0) + 1;
  }
  let best = null, bestCount = 0;
  for (const h in counts) { if (counts[h] > bestCount) { best = Number(h); bestCount = counts[h]; } }
  return best;
}

// ── MOTD send — scheduled, per-user ── This is the real automatic daily
// driver, run hourly by cron (see cron.js). It replaces the old fixed
// 07:00 UTC broadcast with per-user day-of-week + hour preferences
// (motd_days / motd_hour on the user, default every day at 09:00) —
// interpreted in the user's own timezone, not UTC.
//
// HOW THE QUEUE ADVANCES: a message becomes "active" for a calendar date
// (activated_date, tracked in UTC) rather than being marked 'sent' the
// instant everyone's received it — different users are due at different
// hours, sometimes different days, so "everyone's received it" may never
// happen for a message some users have opted out of on their scheduled
// days. The message stays active for its whole UTC calendar day, then gets
// retired (marked 'sent') the next time this function runs and finds a
// stale activated_date — at which point the next queued message activates.
// A user whose motd_days excludes today simply doesn't get today's message
// and picks up again on their next matching day — this is the intended
// behaviour of a day-of-week preference, not a bug.
//
// SIMPLIFICATION WORTH KNOWING ABOUT: which message is "today's" is decided
// once, globally, by UTC date — timezone only controls WHEN within that
// UTC-day window each person is sent it, not WHICH message they get. For
// someone whose local day has already rolled over relative to UTC, this can
// occasionally mean receiving what's technically still "yesterday's UTC"
// message at their chosen local hour. Not worth solving for a message-of-
// the-day feature — flagging it so it's a known tradeoff, not a surprise.
async function sendScheduledMotd() {
  const nowUtc   = new Date();
  const todayUtc = nowUtc.toISOString().slice(0, 10);

  let active = db.getActiveMotdForDate(todayUtc);
  let activatedNewMessage = false;

  if (!active) {
    // Retire yesterday's (or older) active message if one was left dangling
    const stale = db.getStaleActiveMotd(todayUtc);
    if (stale) db.markMotdSent(stale.id);

    const next = db.getNextMotdToSend();
    if (!next) return { ok: true, sent: 0, note: 'No approved messages in queue.' };
    db.activateMotd(next.id, todayUtc);
    active = db.getMotd(next.id);
    activatedNewMessage = true;
  }

  const candidates = db.getMotdNotificationCandidates();
  const b = brand();
  let sentEmail = 0, sentSms = 0;

  for (const user of candidates) {
    let local;
    try { local = getLocalDayHourDate(user.timezone, nowUtc); }
    catch (e) { console.error(`MOTD schedule: bad timezone "${user.timezone}" for user ${user.id} — skipping`); continue; }

    const days = String(user.motd_days || '0,1,2,3,4,5,6').split(',').map(d => d.trim());
    if (!days.includes(String(local.day))) continue;
    if (Number(user.motd_hour ?? 9) !== local.hour) continue;
    if (user.motd_last_sent_date === local.dateStr) continue; // already sent for their local day

    if (user.pref_email_motd && user.email) {
      await sendEmail(user.email, `From ${b.name} — a moment for today`, buildMotdHtml(active.body, b));
      sentEmail++;
    }
    if (user.pref_sms && user.phone) {
      const result = await sms.sendSms(user.phone, `${b.name}: ${active.body}`);
      if (result.ok) sentSms++;
    }
    db.markMotdSentForUser(user.id, local.dateStr);
  }

  // Low-stock alert fires once, at the moment a new message gets activated —
  // not every hour, since queue depth only actually changes on activation.
  if (activatedNewMessage) {
    const remaining = db.countApprovedMotd();
    if (remaining <= 5) {
      await sendEmail(process.env.ADMIN_EMAIL || 'per@deepermindfulness.org',
        `⚠️ MOTD queue — ${remaining} message${remaining === 1 ? '' : 's'} remaining`,
        `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px">
          <p>Today's message has just gone active, delivered on each recipient's own schedule through the day.</p>
          <p>Only <strong>${remaining}</strong> approved message${remaining === 1 ? '' : 's'} left. Please add more.</p>
          <p><a href="${APP_URL}/admin/">${APP_URL}/admin/</a></p>
        </div>`
      );
    }
  }

  return { ok: true, activeMessageId: active.id, sentEmail, sentSms, candidates: candidates.length };
}

// Manual/admin trigger — same logic as the cron job, for testing or one-off sends.
app.post('/api/admin/motd/send-daily', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const result = await sendDailyMotd();
    res.json(result);
  } catch(e) {
    console.error('motd send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── MOTD test send — sends the exact compose-modal draft to a single address, ──
// bypassing the queue entirely. No DB writes, no recipient list, no "sent"
// marking — just a real email so you can see it land before approving it for
// the real queue. Defaults to the logged-in admin's own email; the modal lets
// that be overridden for testing a different inbox.
app.post('/api/admin/motd/test-send', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { body, to } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is empty.' });

    const toEmail = resolveTestEmail(to, req.user.email);
    if (!toEmail) return res.status(400).json({ error: 'No address to send to — override the address or check your admin account has an email set.' });

    const b = brand();
    await sendEmail(toEmail, `[TEST] From ${b.name} — a moment for today`, buildMotdHtml(body, b));
    res.json({ ok: true, to: toEmail });
  } catch (e) {
    console.error('motd test-send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── MOTD test send — SMS ── Same idea as the email test-send above, but over
// Twilio. No default recipient — unlike email there's no logged-in admin
// phone number on file, so the modal requires an explicit number here.
// SMS has no HTML/formatting, so this sends motd.body as plain text, as-is.
app.post('/api/admin/motd/test-send-sms', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    if (!sms.isConfigured()) return res.status(400).json({ error: 'SMS is not configured yet — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in Railway.' });

    const { body, to } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is empty.' });

    const admin = db.getFacilitatorById(req.user.id);
    const toPhone = resolveTestPhone(to, admin && admin.phone);
    if (!toPhone) return res.status(400).json({ error: 'Enter a phone number to send the test to (e.g. +447...), or add your own number in My Account first.' });

    const result = await sms.sendSms(toPhone, body.trim());
    if (!result.ok) return res.status(400).json({ error: result.error || 'Could not send SMS.' });

    res.json({ ok: true, to: toPhone });
  } catch (e) {
    console.error('motd test-send-sms error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Inactivity reminder test send ── Sends the CURRENT subject line from the
// admin form (whether saved yet or not — mirrors the MOTD test-send pattern:
// see what it looks like before committing) to the logged-in admin's email
// by default, overridable. No DB writes, no real users touched.
app.post('/api/admin/reminders/test', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { subject, to } = req.body;
    const toEmail = resolveTestEmail(to, req.user.email);
    if (!toEmail) return res.status(400).json({ error: 'No address to send to.' });

    // Per Bot 24 — falls back to the active message_versions row now,
    // not app_config directly (see resolveMessageContent) — an unsaved
    // subject typed into the request body still previews first, same as
    // before, since that's the old comms.html form's "preview before
    // saving" behaviour and hasn't been retired yet.
    const testSubject = (subject && subject.trim()) || resolveMessageContent('reminder', { subject: "Whenever you're ready" }).subject;
    const b = brand();
    const realUser = db.getUserByEmail(toEmail.toLowerCase());

    await sendEmail(toEmail, `[TEST] ${testSubject}`, buildReminderHtml(realUser || { id: null, name: req.user.name || 'there' }, b));
    res.json({ ok: true, to: toEmail });
  } catch (e) {
    console.error('reminder test-send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Per Bot 19 — same pattern as the other test-sends: real account tokens
// when the address matches one, preview tokens otherwise. Uses the
// CURRENT saved config, not whatever an admin form might have unsaved —
// there's no dedicated edit form for this one yet, just the shared
// settings PATCH, so "test" here means "see what's currently live."
app.post('/api/admin/newsletter-welcome/test', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const toEmail = resolveTestEmail(req.body?.to, req.user.email);
    if (!toEmail) return res.status(400).json({ error: 'No address to send to.' });
    const realUser = db.getUserByEmail(toEmail.toLowerCase());
    await emailWelcomeFromNewsletter(realUser || { id: null, name: req.user.name || 'there', email: toEmail });
    res.json({ ok: true, to: toEmail });
  } catch (e) {
    console.error('newsletter-welcome test-send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/trial-extended/test', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const toEmail = resolveTestEmail(req.body?.to, req.user.email);
    if (!toEmail) return res.status(400).json({ error: 'No address to send to.' });
    const realUser = db.getUserByEmail(toEmail.toLowerCase());
    const previewUser = realUser || { id: null, name: req.user.name || 'there', email: toEmail };
    await emailTrialUpdated(previewUser, 14, 'features', false);
    res.json({ ok: true, to: toEmail });
  } catch (e) {
    console.error('trial-extended test-send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/reminders/test-sms', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    if (!sms.isConfigured()) return res.status(400).json({ error: 'SMS is not configured yet — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in Railway.' });
    const { to } = req.body;
    const admin = db.getFacilitatorById(req.user.id);
    const toPhone = resolveTestPhone(to, admin && admin.phone);
    if (!toPhone) return res.status(400).json({ error: 'Enter a phone number to send the test to (e.g. +447...), or add your own number in My Account first.' });

    const b = brand();
    const result = await sms.sendSms(toPhone, buildReminderSms(req.user.name || 'there', b));
    if (!result.ok) return res.status(400).json({ error: result.error || 'Could not send SMS.' });
    res.json({ ok: true, to: toPhone });
  } catch (e) {
    console.error('reminder test-send-sms error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Renewal reminders — admin test-send (email + SMS) ── Uses a sample date
// (30 days out) since a test send has no real user with a real expiry date
// to draw from — clearly a placeholder, same principle as the newsletter
// test-send's fake invite-link token.
app.post('/api/admin/renewal/test', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { subject, to } = req.body;
    const toEmail = resolveTestEmail(to, req.user.email);
    if (!toEmail) return res.status(400).json({ error: 'No address to send to.' });

    // Per Bot 24 — falls back to the active message_versions row now.
    const testSubject = (subject && subject.trim()) || resolveMessageContent('renewal', { subject: 'Your membership renews soon' }).subject;
    const b = brand();
    const sampleExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const realUser = db.getUserByEmail(toEmail.toLowerCase());

    await sendEmail(toEmail, `[TEST] ${testSubject}`, buildRenewalReminderHtml(realUser || { id: null, name: req.user.name || 'there' }, (realUser && realUser.member_expires_at) || sampleExpiry, b));
    res.json({ ok: true, to: toEmail });
  } catch (e) {
    console.error('renewal test-send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/renewal/test-sms', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    if (!sms.isConfigured()) return res.status(400).json({ error: 'SMS is not configured yet — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in Railway.' });
    const { to } = req.body;
    const admin = db.getFacilitatorById(req.user.id);
    const toPhone = resolveTestPhone(to, admin && admin.phone);
    if (!toPhone) return res.status(400).json({ error: 'Enter a phone number to send the test to (e.g. +447...), or add your own number in My Account first.' });

    const b = brand();
    const sampleExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = await sms.sendSms(toPhone, buildRenewalReminderSms(req.user.name || 'there', sampleExpiry, b));
    if (!result.ok) return res.status(400).json({ error: result.error || 'Could not send SMS.' });
    res.json({ ok: true, to: toPhone });
  } catch (e) {
    console.error('renewal test-send-sms error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Birthday messages — admin test-send (email + SMS) ──
app.post('/api/admin/birthday/test', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { subject, to } = req.body;
    const toEmail = resolveTestEmail(to, req.user.email);
    if (!toEmail) return res.status(400).json({ error: 'No address to send to.' });

    const testSubject = (subject && subject.trim()) || resolveMessageContent('birthday', { subject: 'Happy birthday from all of us' }).subject;
    const b = brand();
    const realUser = db.getUserByEmail(toEmail.toLowerCase());

    await sendEmail(toEmail, `[TEST] ${testSubject}`, buildBirthdayHtml(realUser || { id: null, name: req.user.name || 'there' }, b));
    res.json({ ok: true, to: toEmail });
  } catch (e) {
    console.error('birthday test-send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/birthday/test-sms', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    if (!sms.isConfigured()) return res.status(400).json({ error: 'SMS is not configured yet — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in Railway.' });
    const { to } = req.body;
    const admin = db.getFacilitatorById(req.user.id);
    const toPhone = resolveTestPhone(to, admin && admin.phone);
    if (!toPhone) return res.status(400).json({ error: 'Enter a phone number to send the test to (e.g. +447...), or add your own number in My Account first.' });

    const b = brand();
    const result = await sms.sendSms(toPhone, buildBirthdaySms(req.user.name || 'there', b));
    if (!result.ok) return res.status(400).json({ error: result.error || 'Could not send SMS.' });
    res.json({ ok: true, to: toPhone });
  } catch (e) {
    console.error('birthday test-send-sms error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Generic "Send test" for comms2 (Per Bot 24) ── One endpoint covering
// every type in MESSAGE_TYPE_REGISTRY, so comms2's shared editor doesn't
// need per-type wiring — reuses each type's existing send-building logic
// exactly as-is (the individual /api/admin/reminders/test etc. endpoints
// above stay working too, for the old comms.html forms until each is
// retired). For a type already switched over to message_versions (see
// resolveMessageContent), this naturally reflects the active saved
// version; for a type not yet switched, it reflects current app_config —
// either way, always an accurate preview of what a real send looks like
// today, never stale or misleading.
const TYPE_TEST_SENDERS = {
  reminder: {
    email: (toEmail, realUser, override) => sendEmail(toEmail, `[TEST] ${resolveMessageContent('reminder', { subject: "Whenever you're ready" }, override).subject}`, buildReminderHtml(realUser, brand(), override)),
    sms: (toPhone, adminName, override) => sms.sendSms(toPhone, buildReminderSms(adminName, brand(), override)),
  },
  renewal: {
    email: (toEmail, realUser, override) => {
      const sampleExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      return sendEmail(toEmail, `[TEST] ${resolveMessageContent('renewal', { subject: 'Your membership renews soon' }, override).subject}`, buildRenewalReminderHtml(realUser, realUser.member_expires_at || sampleExpiry, brand(), override));
    },
    sms: (toPhone, adminName, override) => sms.sendSms(toPhone, buildRenewalReminderSms(adminName, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), brand(), override)),
  },
  birthday: {
    email: (toEmail, realUser, override) => sendEmail(toEmail, `[TEST] ${resolveMessageContent('birthday', { subject: 'Happy birthday from all of us' }, override).subject}`, buildBirthdayHtml(realUser, brand(), override)),
    sms: (toPhone, adminName, override) => sms.sendSms(toPhone, buildBirthdaySms(adminName, brand(), override)),
  },
  newsletter_welcome: { email: (toEmail, realUser, override) => emailWelcomeFromNewsletter(realUser, override), sms: null },
  trial_extended:     { email: (toEmail, realUser, override) => emailTrialUpdated(realUser, 14, 'features', false, override), sms: null },
  trial_day3:  { email: (toEmail, realUser, override) => emailTrialDay3(realUser, override),  sms: null },
  trial_day7:  { email: (toEmail, realUser, override) => emailTrialDay7(realUser, override),  sms: null },
  trial_day10: { email: (toEmail, realUser, override) => emailTrialDay10(realUser, override), sms: null },
  trial_day14: { email: (toEmail, realUser, override) => emailTrialDay14(realUser, override), sms: null },
  savers_cancel_day0:   { email: (toEmail, realUser, override) => emailSaversCancelDay0(realUser, '[example date]', override), sms: null },
  savers_cancel_grace0: { email: (toEmail, realUser, override) => emailSaversCancelGrace0(realUser, override), sms: null },
  savers_cancel_mid:    { email: (toEmail, realUser, override) => emailSaversCancelMid(realUser, override),    sms: null },
  savers_cancel_final:  { email: (toEmail, realUser, override) => emailSaversCancelFinal(realUser, override),  sms: null },
  savers_failure_day0:  { email: (toEmail, realUser, override) => emailSaversFailureDay0(realUser, override),  sms: null },
  savers_failure_mid:   { email: (toEmail, realUser, override) => emailSaversFailureMid(realUser, override),   sms: null },
  savers_failure_final: { email: (toEmail, realUser, override) => emailSaversFailureFinal(realUser, override), sms: null },
};
app.post('/api/admin/message-versions/:type/test', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { type } = req.params;
    const handlers = TYPE_TEST_SENDERS[type];
    if (!handlers) return res.status(400).json({ error: 'No test-send available for this message type yet.' });
    const { to, kind, override } = req.body;
    if (kind === 'sms') {
      if (!handlers.sms) return res.status(400).json({ error: 'This message type has no SMS version.' });
      if (!sms.isConfigured()) return res.status(400).json({ error: 'SMS is not configured yet — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in Railway.' });
      const admin = db.getFacilitatorById(req.user.id);
      const toPhone = resolveTestPhone(to, admin && admin.phone);
      if (!toPhone) return res.status(400).json({ error: 'Enter a phone number to send the test to (e.g. +447...), or add your own number in My Account first.' });
      const result = await handlers.sms(toPhone, req.user.name || 'there', override);
      if (result && result.ok === false) return res.status(400).json({ error: result.error || 'Could not send SMS.' });
      return res.json({ ok: true, to: toPhone });
    }
    const toEmail = resolveTestEmail(to, req.user.email);
    if (!toEmail) return res.status(400).json({ error: 'No address to send to.' });
    const realUser = db.getUserByEmail(toEmail.toLowerCase()) || { id: null, name: req.user.name || 'there', email: toEmail };
    await handlers.email(toEmail, realUser, override);
    res.json({ ok: true, to: toEmail });
  } catch (e) {
    console.error(`message-versions test-send (${req.params.type}) error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Newsletters — admin ── One-off broadcasts to everyone opted into "News
// and updates", independent of membership tier. Compose → (optionally edit,
// test) → Send. No queue, no auto-schedule — content differs every time, so
// this is a deliberate, manual "hit send when it's ready" tool rather than
// something cron-driven like the MOTD.
// Per Bot 19 fix: recipient_count on the newsletters row itself is only
// ever a snapshot taken the moment runNewsletterSend finishes — and that
// same function is reused for both the original send (the full audience)
// AND a later retry (just the outstanding subset), so a retry silently
// overwrites it with a smaller number rather than the real running total.
// email_log is the one place that's always accurate (every recipient is a
// row, retries just update existing rows rather than duplicating them),
// so the list now reports a live count from there instead of trusting the
// stored snapshot — same source Progress already uses, just surfaced here
// too instead of only on demand.
// ── Scheduled (recurring) messages (Per Bot 21) ──
app.get('/api/admin/scheduled-messages', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const list = db.getAllScheduledMessages().map(m => ({ ...m, recurrence_config: JSON.parse(m.recurrence_config || '{}') }));
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/scheduled-messages', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { subject, body, format, audience, recurrence_type, recurrence_config, send_hour, active } = req.body;
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'Subject is required.' });
    if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required.' });
    if (!['daily','weekly','monthly_date','monthly_nth_weekday','yearly'].includes(recurrence_type)) {
      return res.status(400).json({ error: 'Unrecognised recurrence type.' });
    }
    const id = uuidv4();
    db.createScheduledMessage(id, { subject: subject.trim(), body, format, audience, recurrence_type, recurrence_config, send_hour, active });
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/scheduled-messages/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    db.updateScheduledMessage(req.params.id, req.body);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/scheduled-messages/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    db.deleteScheduledMessage(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Send-now — a real send this instant (same pipeline, same recipients as
// the real schedule would use), for checking a scheduled message actually
// looks right without waiting for its next due date. Deliberately does
// NOT touch last_sent_date, so it has no effect on when the real
// schedule next fires — this is a preview-by-actually-sending, not an
// occurrence in its own right.
app.post('/api/admin/scheduled-messages/:id/send-now', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    if (IS_STAGING) return res.status(403).json({ error: 'Sending is disabled on staging.' });
    const msg = db.getScheduledMessage(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Not found.' });
    const newsletterId = uuidv4();
    db.addNewsletter(newsletterId, msg.subject, msg.body, msg.audience, msg.format, null, null, msg.id);
    const newsletter = db.getNewsletter(newsletterId);
    const recipients = db.getNewsletterRecipients(newsletter.audience);
    // Per Bot 47 — batched: one save() for the whole pre-log instead of
    // one per recipient (was 375 full-database disk writes happening
    // synchronously before this request could even respond).
    const logRowsByUserId = {};
    const pendingLogRows = recipients.map(user => {
      const id = uuidv4();
      logRowsByUserId[user.id] = id;
      return { id, kind: 'newsletter', email: user.email, subject: newsletter.subject, newsletterId: newsletter.id, userId: user.id };
    });
    db.logEmailPendingBatch(pendingLogRows);
    db.updateNewsletterStatus(newsletter.id, 'sending');
    res.json({ ok: true, started: true, recipientCount: recipients.length });
    runNewsletterSend(newsletter, recipients, logRowsByUserId).catch(e => {
      console.error('scheduled-message send-now background error:', e.message);
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/newsletters', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const list = db.getAllNewsletters().map(n => {
      if (n.status === 'draft') return n;
      const counts = db.getEmailLogCountsForNewsletter(n.id);
      return { ...n, live_sent_count: counts.sent, live_total_count: counts.pending + counts.sent + counts.failed };
    });
    res.json(list);
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Accepts ?segments=explorer,member1 (comma-separated) so the compose modal
// can show a live count as the admin ticks/unticks audience checkboxes,
// before ever saving a draft. No query param, or 'all', means everyone.
// Per Bot 24 — also accepts ?userIds=id1,id2,... for the explicit-list
// compose flow, taking priority over segments when present (same rule as
// getNewsletterRecipients itself).
app.get('/api/admin/newsletters/recipient-count', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const userIds = req.query.userIds ? String(req.query.userIds).split(',').filter(Boolean) : null;
    res.json({ count: db.getNewsletterRecipients(req.query.segments || 'all', userIds).length });
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Rich (HTML from the editor) bodies can look non-empty by string length
// alone — Quill leaves behind markup like <p><br></p> for an empty editor —
// so the "did they actually write anything" check has to strip tags first
// when format is 'rich', or an empty draft would slip through as valid.
function newsletterBodyIsEmpty(body, format) {
  if (!body) return true;
  return format === 'rich' ? !body.replace(/<[^>]*>/g, '').trim() : !body.trim();
}

// Per Bot 24 — small shared parse for newsletters.explicit_user_ids
// (JSON array or null), used everywhere a saved newsletter's real
// recipients need resolving.
function parseNewsletterExplicitIds(newsletter) {
  if (!newsletter || !newsletter.explicit_user_ids) return null;
  try { const arr = JSON.parse(newsletter.explicit_user_ids); return Array.isArray(arr) && arr.length ? arr : null; }
  catch(e) { return null; }
}

app.post('/api/admin/newsletters', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { subject, body, audience, format, offerId, sourceTag, explicitUserIds } = req.body;
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'Subject is required.' });
    if (newsletterBodyIsEmpty(body, format)) return res.status(400).json({ error: 'Body is required.' });
    const id = uuidv4();
    db.addNewsletter(id, subject.trim(), format === 'rich' ? body : body.trim(), audience, format, offerId, sourceTag, null,
      Array.isArray(explicitUserIds) ? explicitUserIds : null);
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/newsletters/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { subject, body, audience, format, offerId, sourceTag, explicitUserIds } = req.body;
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'Subject is required.' });
    if (newsletterBodyIsEmpty(body, format)) return res.status(400).json({ error: 'Body is required.' });
    const existing = db.getNewsletter(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Newsletter not found.' });
    if (existing.status !== 'draft') return res.status(400).json({ error: 'Already sent — sent newsletters cannot be edited.' });
    db.updateNewsletter(req.params.id, subject.trim(), format === 'rich' ? body : body.trim(), audience, format, offerId, sourceTag,
      Array.isArray(explicitUserIds) ? explicitUserIds : null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/newsletters/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    db.deleteNewsletterDraft(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Test send — mirrors the MOTD/reminder pattern: uses whatever's currently
// in the compose form (saved or not), sent to the admin's own email by
// default or an override. No DB writes. Audience doesn't affect a test
// send — it always goes to one address regardless of segment.
app.post('/api/admin/newsletters/test-send', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { subject, body, to, format } = req.body;
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'Write a subject first.' });
    if (!body || !body.trim())       return res.status(400).json({ error: 'Write the body first.' });

    const toEmail = resolveTestEmail(to, req.user.email);
    if (!toEmail) return res.status(400).json({ error: 'No address to send to.' });

    // Per Bot 18 (now via the shared resolveTestRecipientTokens, Per Bot
    // 19) — if the address being sent to actually matches a real account,
    // use their real data: a genuinely working invite link and their real
    // expiry date, not the placeholder preview below. This is what makes
    // it safe to use this same button to send a real, working, one-off
    // message to a specific named person (e.g. inviting a handful of
    // legacy members back one at a time) rather than only ever being a
    // wording check. Falls back to the placeholder preview for any
    // address that isn't a real account — testing wording to your own
    // admin inbox, most commonly.
    const { isReal, tokens } = resolveTestRecipientTokens(toEmail, req.user);
    const subjectFilled = fillTemplate(subject.trim(), tokens);
    const bodyFilled = fillTemplate(body.trim(), tokens);
    const note = isReal ? ` — sent with ${tokens.name}'s real invite link and expiry date, this is a genuine working send, not a preview` : '';

    const b = brand();
    const cfg = db.getAppConfig() || {};
    // Per Bot 21 — real bug: this line (and the two below it) referred to
    // a `realUser` variable that no longer exists in this scope since the
    // Per Bot 19 refactor moved to resolveTestRecipientTokens (which only
    // returns isReal/tokens, not the raw user row) — a ReferenceError on
    // every single send, not just an edge case. Fetching it directly
    // here matches the exact pattern every sibling test-send endpoint
    // already uses.
    const realUser = db.getUserByEmail(toEmail.toLowerCase());
    const previewUnsubscribe = realUser ? `${APP_URL}/unsubscribe/${db.ensureUnsubscribeToken(realUser.id)}` : `${APP_URL}/unsubscribe/EXAMPLE-TOKEN-not-a-real-link`;
    const footerHtml = buildNewsletterFooterHtml(cfg.newsletter_footer, b, previewUnsubscribe);
    await sendEmail(toEmail, `${realUser ? '' : '[TEST] '}${subjectFilled}`, buildNewsletterHtml(subjectFilled, bodyFilled, b, format, footerHtml));
    res.json({ ok: true, to: toEmail, real: !!realUser, note });
  } catch (e) {
    console.error('newsletter test-send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// The real send — broadcasts to whichever audience segment(s) this
// newsletter was saved with (defaults to 'all' if none chosen). Requires
// the newsletter to already be saved as a draft (so there's a permanent
// record of exactly what was sent, to whom, and how many people), then
// marks it 'sent' and locks it against further edits.
//
// Supports two placeholders in subject/body: {{name}} and {{invite_link}}.
// {{invite_link}} resolves differently per recipient — someone with no
// login yet gets their personal /join/:token claim link (generated here if
// they don't already have one); someone who already has a real account just
// gets pointed at /login. This is what makes a single "come try it" send
// work correctly across a mixed audience without composing two newsletters.
// Runs the actual send loop in the background — called after the endpoint
// below has already responded, so a slow or large batch can never hit an
// HTTP/platform timeout mid-send the way the original version could.
// Every recipient was already pre-logged as 'pending' before this function
// is even called (see the endpoint), so if the whole Node process dies
// mid-loop, the log still shows exactly who was and wasn't reached —
// nothing to reconstruct from Scaleway's side afterward, unlike the
// "Finding Calm" send this replaces the design for.
async function runNewsletterSend(newsletter, recipients, logRowsByUserId) {
  const b = brand();
  const cfg = db.getAppConfig() || {};
  let sentCount = 0, failedCount = 0;

  for (const user of recipients) {
    // Per Bot 18 (now via the shared buildMessageTokens, Per Bot 19) — if
    // this send is tied to an offer, every non-logged-in recipient's
    // invite_link carries that offer's code plus this send's source tag,
    // same query-string shape /promo/<code>?src=... already uses, so it
    // lands in the same funnel report as everything else — rather than
    // the old fixed-14-day /join/<token> link with no attribution at all.
    const tokens = buildMessageTokens(user, { offerId: newsletter.offer_id, sourceTag: newsletter.source_tag });
    const subject = fillTemplate(newsletter.subject, tokens);
    const body    = fillTemplate(newsletter.body, tokens);

    const unsubscribeUrl = `${APP_URL}/unsubscribe/${db.ensureUnsubscribeToken(user.id)}`;
    const footerHtml = buildNewsletterFooterHtml(cfg.newsletter_footer, b, unsubscribeUrl);
    const html = buildNewsletterHtml(subject, body, b, newsletter.format, footerHtml);

    // A failed send here must never stop the loop — the original bug was
    // exactly this: one bad address could abort everyone after it with no
    // record of how far it got. Every outcome, good or bad, is caught and
    // logged, and the loop always continues to the next person.
    try {
      const result = await sendEmail(user.email, subject, html, {
        kind: 'newsletter', newsletterId: newsletter.id, userId: user.id, logId: logRowsByUserId[user.id],
      });
      if (result.ok) sentCount++; else failedCount++;
    } catch(e) {
      failedCount++;
      db.updateEmailLogResult(logRowsByUserId[user.id], 'failed', null, e.message);
    }
  }

  // Marked sent regardless of partial failures, with real counts attached
  // — the newsletter no longer sits stuck on "draft" just because a few
  // addresses failed, which was the second half of the original bug (the
  // status only ever flipped after a loop that could never actually
  // finish cleanly at any real scale).
  db.markNewsletterSent(newsletter.id, sentCount);
  console.log(`Newsletter ${newsletter.id} send complete: ${sentCount} sent, ${failedCount} failed, ${recipients.length} total.`);
}

// Per Bot 21 — checks every active scheduled_messages row against
// today's date/hour and, for whichever ones are due, creates a real
// newsletter row and runs it through the exact same send pipeline a
// manual "Send" click already uses (runNewsletterSend above) — no
// separate, parallel sending logic to keep in sync with the real one.
// Guarded by IS_STAGING same as the manual endpoint below, and by
// last_sent_date so a slow run or an extra cron tick within the same
// hour never double-sends the same occurrence.
// Per's request — session reminders, 3 days / 1 day / 1 hour before.
// Deliberately "has this already been sent" rather than a narrow time
// window, so this is robust against whatever the actual cron interval
// turns out to be: a session crosses into a threshold once, gets its
// reminder, gets recorded, and the UNIQUE constraint on
// session_reminders_sent (see db.js) is the real backstop against a
// duplicate even if two runs overlap — this JS-level check is a
// courtesy that avoids the wasted work of even attempting to send
// twice, not the actual safety mechanism.
async function sendDueSessionReminders() {
  if (IS_STAGING) return { skipped: 'staging' };
  const REMINDER_TYPES = [
    { type: '3day', thresholdMs: 3 * 24 * 60 * 60 * 1000, emailFn: emailSessionReminder3Day },
    { type: '1day', thresholdMs: 1 * 24 * 60 * 60 * 1000, emailFn: emailSessionReminder1Day },
    { type: '1hour', thresholdMs: 60 * 60 * 1000, emailFn: emailSessionReminder1Hour },
  ];
  const now = new Date();
  const sessions = db.getUpcomingSessionsWithScheduledTime();
  let sentCount = 0;
  const errors = [];
  for (const session of sessions) {
    const sessionDate = new Date(session.scheduled_at);
    if (isNaN(sessionDate.getTime())) continue; // malformed date — skip rather than crash the whole run
    const msUntil = sessionDate.getTime() - now.getTime();
    if (msUntil <= 0) continue; // already happened
    for (const { type, thresholdMs, emailFn } of REMINDER_TYPES) {
      if (msUntil > thresholdMs) continue; // not close enough yet for this reminder tier
      const enrolments = db.getEnrolmentsForInstance(session.course_instance_id);
      for (const enrolment of enrolments) {
        if (db.hasSentSessionReminder(session.id, enrolment.id, type)) continue;
        try {
          const user = db.getUser(enrolment.user_id);
          if (!user) continue;
          const sessionDateStr = sessionDate.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
          await emailFn(user, session.course_title, session.title, sessionDateStr, session.course_instance_id);
          db.markSessionReminderSent(uuidv4(), session.id, enrolment.id, type);
          sentCount++;
        } catch(e) {
          errors.push(`${session.id}/${enrolment.id}/${type}: ${e.message}`);
        }
      }
    }
  }
  return { sentCount, errorCount: errors.length, errors: errors.slice(0, 10) };
}

async function sendDueScheduledMessages() {
  if (IS_STAGING) return { skipped: 'staging' };
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const currentHour = now.getUTCHours();
  const messages = db.getAllScheduledMessages().filter(m => m.active);
  let firedCount = 0;
  const fired = [];
  for (const msg of messages) {
    if (msg.last_sent_date === todayStr) continue;
    if (Number(msg.send_hour) !== currentHour) continue;
    let config = {};
    try { config = JSON.parse(msg.recurrence_config || '{}'); } catch(e) {}
    if (!db.scheduledMessageMatchesDate(msg.recurrence_type, config, now)) continue;

    const newsletterId = uuidv4();
    db.addNewsletter(newsletterId, msg.subject, msg.body, msg.audience, msg.format, null, null, msg.id);
    const newsletter = db.getNewsletter(newsletterId);
    const recipients = db.getNewsletterRecipients(newsletter.audience);
    // Per Bot 47 — batched: one save() for the whole pre-log instead of
    // one per recipient (was 375 full-database disk writes happening
    // synchronously before this request could even respond).
    const logRowsByUserId = {};
    const pendingLogRows = recipients.map(user => {
      const id = uuidv4();
      logRowsByUserId[user.id] = id;
      return { id, kind: 'newsletter', email: user.email, subject: newsletter.subject, newsletterId: newsletter.id, userId: user.id };
    });
    db.logEmailPendingBatch(pendingLogRows);
    db.updateNewsletterStatus(newsletter.id, 'sending');
    await runNewsletterSend(newsletter, recipients, logRowsByUserId);
    db.markScheduledMessageSent(msg.id, todayStr);
    // Per's request — "Once" is a genuine one-off, not a recurring
    // pattern someone has to remember to switch off. Auto-deactivating
    // here (rather than deleting it outright) means it still shows up
    // in the Scheduled list afterwards as a record of what fired and
    // when, just no longer live — same convention as everything else in
    // this admin panel favouring "deactivated, still visible" over
    // "gone", so nothing ever silently vanishes.
    if (msg.recurrence_type === 'once') db.updateScheduledMessage(msg.id, { active: 0 });
    firedCount++;
    fired.push({ id: msg.id, subject: msg.subject, recipientCount: recipients.length });
  }
  return { checked: messages.length, fired: firedCount, details: fired };
}

app.post('/api/admin/newsletters/:id/send', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    // Defense-in-depth alongside the cron guard above — a genuine bulk
    // send to real people should never be possible from a staging
    // deployment, even by an intentional admin click, in case staging
    // ever ends up pointed at anything resembling real subscriber data.
    if (IS_STAGING) return res.status(403).json({ error: 'Newsletter sending is disabled on staging.' });
    const newsletter = db.getNewsletter(req.params.id);
    if (!newsletter) return res.status(404).json({ error: 'Newsletter not found.' });
    if (newsletter.status !== 'draft') return res.status(400).json({ error: 'Already sent.' });

    const recipients = db.getNewsletterRecipients(newsletter.audience, parseNewsletterExplicitIds(newsletter));

    // Pre-log every recipient as pending BEFORE any sending starts — the
    // core fix. Even if the server crashes or redeploys one email into the
    // batch, this table already shows all 377 intended recipients, so
    // "who's missing" is a query against our own data, not a forensic
    // exercise against Scaleway's console.
    // Per Bot 47 — batched: one save() for the whole pre-log instead of
    // one per recipient (was 375 full-database disk writes happening
    // synchronously before this request could even respond).
    const logRowsByUserId = {};
    const pendingLogRows = recipients.map(user => {
      const id = uuidv4();
      logRowsByUserId[user.id] = id;
      return { id, kind: 'newsletter', email: user.email, subject: newsletter.subject, newsletterId: newsletter.id, userId: user.id };
    });
    db.logEmailPendingBatch(pendingLogRows);

    // Mark as sending immediately and respond right away — the actual
    // loop below runs after this response goes out, so however long 377
    // (or 3,770) sequential sends takes, it can never hit an HTTP or
    // platform timeout waiting for a response that was already sent.
    db.updateNewsletterStatus(newsletter.id, 'sending');
    res.json({ ok: true, started: true, recipientCount: recipients.length });

    runNewsletterSend(newsletter, recipients, logRowsByUserId).catch(e => {
      console.error('newsletter send background error:', e.message);
    });
  } catch (e) {
    console.error('newsletter send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Progress — poll this while a newsletter is 'sending' to show a live
// count instead of nothing. Reads straight from the log table, which is
// exactly why every recipient got pre-logged as pending up front.
app.get('/api/admin/newsletters/:id/progress', auth.requireAuthApi(['admin']), (req, res) => {
  const newsletter = db.getNewsletter(req.params.id);
  if (!newsletter) return res.status(404).json({ error: 'Newsletter not found.' });
  const counts = db.getEmailLogCountsForNewsletter(req.params.id);
  res.json({ status: newsletter.status, ...counts, total: counts.pending + counts.sent + counts.failed });
});

// Per-recipient detail — the actual list behind the counts above, for
// figuring out exactly who's missing rather than just how many.
app.get('/api/admin/newsletters/:id/recipients', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getEmailLogForNewsletter(req.params.id));
});

// Retry — re-sends only to recipients still 'pending' or 'failed' in the
// log for this newsletter, skipping anyone already 'sent'. Safe to run
// repeatedly; each retry only ever touches whoever's still outstanding.
app.post('/api/admin/newsletters/:id/retry', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    if (IS_STAGING) return res.status(403).json({ error: 'Newsletter sending is disabled on staging.' });
    const newsletter = db.getNewsletter(req.params.id);
    if (!newsletter) return res.status(404).json({ error: 'Newsletter not found.' });
    const log = db.getEmailLogForNewsletter(req.params.id);
    const outstanding = log.filter(r => r.status !== 'sent');
    if (!outstanding.length) return res.json({ ok: true, started: false, message: 'Nothing outstanding — everyone already sent.' });

    const allRecipients = db.getNewsletterRecipients(newsletter.audience, parseNewsletterExplicitIds(newsletter));
    const byUserId = {};
    allRecipients.forEach(u => { byUserId[u.id] = u; });
    const retryRecipients = outstanding.map(r => byUserId[r.user_id]).filter(Boolean);
    const logRowsByUserId = {};
    outstanding.forEach(r => { if (r.user_id) logRowsByUserId[r.user_id] = r.id; });

    res.json({ ok: true, started: true, recipientCount: retryRecipients.length });
    runNewsletterSend(newsletter, retryRecipients, logRowsByUserId).catch(e => {
      console.error('newsletter retry background error:', e.message);
    });
  } catch (e) {
    console.error('newsletter retry error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Reconciliation — for the "Finding Calm" send specifically, and any other
// past send that went out before this logging existed. Asks Scaleway
// directly what it has on record since this newsletter's created_at, then
// cross-references rcpt_to against the newsletter's actual target
// audience to work out who's genuinely missing — rather than anyone
// having to page through Scaleway's console by hand.
// Debug only (Per Bot 8) — read-only, no state changes. Shows exactly what
// Scaleway's list endpoint actually returns, since the reconcile endpoint's
// assumption about that response shape needs checking against a real
// account rather than documentation alone.
app.get('/api/admin/scaleway-debug', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const url = `https://api.scaleway.com/transactional-email/v1alpha1/regions/${SCW_TEM_REGION}/emails?page=1&page_size=5&project_id=${SCW_PROJECT_ID}`;
    const r = await fetch(url, { headers: { 'X-Auth-Token': SCW_SECRET_KEY } });
    const bodyText = await r.text();
    let parsed;
    try { parsed = JSON.parse(bodyText); } catch(e) { parsed = null; }
    res.json({
      requestUrl: url,
      httpStatus: r.status,
      rawBody: bodyText.slice(0, 3000),
      parsedKeys: parsed ? Object.keys(parsed) : null,
      firstEmailSample: parsed && parsed.emails ? parsed.emails[0] : (Array.isArray(parsed) ? parsed[0] : null),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/newsletters/:id/reconcile', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const newsletter = db.getNewsletter(req.params.id);
    if (!newsletter) return res.status(404).json({ error: 'Newsletter not found.' });
    const recipients = db.getNewsletterRecipients(newsletter.audience, parseNewsletterExplicitIds(newsletter));

    const scwEmails = await scwListEmailsBySubjectSince(newsletter.subject, newsletter.created_at);
    const reachedAddresses = new Set(scwEmails.map(e => (e.rcpt_to || '').toLowerCase()));

    const already = recipients.filter(u => reachedAddresses.has((u.email || '').toLowerCase()));
    const missing = recipients.filter(u => !reachedAddresses.has((u.email || '').toLowerCase()));

    // Safe to re-run — clears any previous reconcile attempt for this
    // newsletter first, so trying again while dialling in the Scaleway
    // lookup doesn't pile up duplicate log rows each time.
    db.clearEmailLogForNewsletter(newsletter.id);
    // Per Bot 47 — batched (one save() for the whole reconcile, not one
    // per already/missing recipient).
    db.logEmailResultBatch(already.map(u => ({
      id: uuidv4(), kind: 'newsletter', email: u.email, subject: newsletter.subject,
      newsletterId: newsletter.id, userId: u.id, status: 'sent',
    })));
    db.logEmailPendingBatch(missing.map(u => ({
      id: uuidv4(), kind: 'newsletter', email: u.email, subject: newsletter.subject,
      newsletterId: newsletter.id, userId: u.id,
    })));
    if (newsletter.status === 'draft') db.updateNewsletterStatus(newsletter.id, 'sending');

    res.json({
      ok: true,
      scalewayRecordsFound: scwEmails.length,
      audienceSize: recipients.length,
      alreadyReached: already.length,
      missing: missing.length,
      missingEmails: missing.map(u => u.email),
    });
  } catch (e) {
    console.error('newsletter reconcile error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// instead of the request just dying silently (this was the original bug: a 54MB
// upload via the legacy disk path would hit multer's old 50MB limit and the
// connection would simply drop with no response at all). ──
app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is too large for the fallback upload path. Try again — uploads normally go directly to storage and have no size limit.' });
  }
  if (err) {
    console.error('Unhandled error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
  next();
});

// ── Start ──
(async () => {
  await db.getDb();
  const adminEmail = process.env.ADMIN_EMAIL || 'per@deepermindfulness.org';
  const adminPass  = process.env.ADMIN_PASSWORD || 'changeme123';
  const adminName  = process.env.ADMIN_NAME || 'Admin';
  if (!db.getFacilitatorByEmail(adminEmail)) {
    const hash = await auth.hashPassword(adminPass);
    db.createFacilitator(uuidv4(), adminName, adminEmail, hash, 'admin');
    console.log(`Admin created: ${adminEmail}`);
  }
  // Per Bot 22 — any AI-generate job still 'pending' means the previous
  // process died mid-generation (restart, deploy, crash), not a real
  // failure — pick it back up rather than leave it stuck forever.
  recoverPendingAiGenerateJobs();
  if (IS_STAGING) {
    console.log('[staging] cron jobs NOT started — no scheduled email/SMS can fire from this environment.');
  } else {
    startCronJobs({ db, sendScheduledMotd, emailTrialDay3, emailTrialDay7, emailTrialDay10, emailTrialDay14, sendInactivityReminders, sendCustomReminders, sendRenewalReminders, sendBirthdayMessages, sweepStaleChatSessions, sendDueCampaignEmailSteps, sendDueSaversEmails, processDueSaversDowngrades, emailSaversCancelGrace0, sendDueScheduledMessages, sendDueSessionReminders });
  }
  server.listen(PORT, () => console.log(`Per Bot running on port ${PORT}`));
})();
