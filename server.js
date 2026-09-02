// ── server.js — Mare companion app ──
// Separate Railway service from per_bot, same project. Own repo, own
// deploy.sh, own admin, own accounts. Ported from per_bot: auth pattern,
// R2 media plumbing, ElevenLabs TTS, Deepgram word-timestamp STT, and
// (that pass) the Talk architecture — a raw Deepgram STT proxy over its
// own websocket plus plain HTTP for the Claude reply, the same split
// per_bot itself borrowed from the original standalone Mare Bot
// prototype (see the '/listen' comment below). Since then, also built:
// comms (broadcasts, scheduling, What's New) and a site-wide helper
// character — deliberately NOT a separate Tomte-style persona, but Mare
// herself, adapting register by audience (see prompts.js's
// buildMareHelperSystemPrompt). Not ported, still: courses, Stripe
// subscription tiers (merchandise here uses one-off Stripe Checkout
// instead). Deliberately deferred, for now: Talk's arc/history/
// knowledge-base layers (see prompts.js and the talk_sessions schema
// comment in db.js for why).

const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const fetch = require('node-fetch');
const Stripe = require('stripe');
const WebSocket = require('ws');
const Anthropic = require('@anthropic-ai/sdk');

const db = require('./db');
const auth = require('./auth');
const media = require('./media');
const prompts = require('./prompts');
const email = require('./email');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const MARE_VOICE_ID = process.env.MARE_VOICE_ID; // same ElevenLabs voice already used for Mare inside per_bot's Tomte flow
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const TALK_MODEL = process.env.TALK_MODEL || 'claude-sonnet-4-6';

// A raw http.Server wrapping the Express app — needed because a
// websocket upgrade happens beneath Express entirely (Express never
// sees it), so there has to be a real server object to attach an
// 'upgrade' listener to. Every websocket path in this app funnels
// through one consolidated dispatcher near the bottom of this file
// (server.on('upgrade', ...)), the same pattern per_bot settled on
// after hitting real bugs from multiple {server,path}-bound
// WebSocket.Server instances all firing on every upgrade regardless of
// path — see that pattern's own comment in per_bot's server.js for the
// full story. One websocket path today (/listen); built this way so a
// second one doesn't require re-architecting anything.
const server = http.createServer(app);

// ─────────────────────────────────────────────────────────────────────
// LOCALE — English and Dutch to start (the book's two published
// editions). Adding a language later means adding it here, adding a
// public/i18n/<locale>.json file, and adding the book rows for it —
// nothing else in this list needs to change.
// ─────────────────────────────────────────────────────────────────────
const SUPPORTED_LOCALES = ['en', 'nl'];
const DEFAULT_LOCALE = 'en';

// Resolution order: explicit ?lang= query param (wins, since a person
// actively choosing a language should never be second-guessed) → saved
// mare_locale cookie → browser Accept-Language → default.
function resolveLocale(req) {
  const fromQuery = req.query?.lang;
  if (fromQuery && SUPPORTED_LOCALES.includes(fromQuery)) return fromQuery;
  const fromCookie = req.cookies?.mare_locale;
  if (fromCookie && SUPPORTED_LOCALES.includes(fromCookie)) return fromCookie;
  const acceptLang = (req.headers['accept-language'] || '').toLowerCase();
  for (const loc of SUPPORTED_LOCALES) {
    if (acceptLang.includes(loc)) return loc;
  }
  return DEFAULT_LOCALE;
}

// ─────────────────────────────────────────────────────────────────────
// AUTH — Parent / Teacher / Admin, fully separate accounts from per_bot
// ─────────────────────────────────────────────────────────────────────

app.post('/api/parent/signup', async (req, res) => {
  try {
    const { email: rawEmail, password, name } = req.body || {};
    if (!rawEmail || !password || !name) return res.status(400).json({ error: 'Missing fields' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (db.getParentByEmail(rawEmail)) return res.status(409).json({ error: 'Email already registered' });
    const hash = await auth.hashPassword(password);
    const id = db.createParent({ email: rawEmail, passwordHash: hash, name });
    const token = auth.createToken({ role: 'parent', id, name, email: rawEmail });
    res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
    res.json({ ok: true, id });
    // Fire-and-forget — a slow or failed welcome email should never hold
    // up or break the signup response itself; the send is fully logged
    // in email_log either way (see email.js).
    email.sendWelcomeParentEmail(rawEmail, name).catch(e => console.error('welcome email failed:', e.message));
  } catch (e) {
    console.error('parent signup failed', e);
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/parent/login', async (req, res) => {
  const { email: rawEmail, password } = req.body || {};
  const result = await auth.loginParent(rawEmail || '', password || '');
  if (result === 'suspended') return res.status(403).json({ error: 'Account suspended' });
  if (!result) return res.status(401).json({ error: 'Invalid email or password' });
  const token = auth.createToken(result);
  res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
  res.json({ ok: true });
});

// Public self-serve teacher signup is disabled — teacher accounts are
// now created via Admin only (the single-account form or bulk import
// in the Parents & Teachers tab), per Per's explicit request that
// account creation move off the public site. Route kept rather than
// deleted so the reason is documented in one place and restoring it is
// a one-line change if that decision ever changes.
app.post('/api/teacher/signup', async (req, res) => {
  res.status(403).json({ error: 'Teacher accounts are created by an administrator. Contact your school to get set up.' });
});

app.post('/api/teacher/login', async (req, res) => {
  const { email: rawEmail, password } = req.body || {};
  const result = await auth.loginTeacher(rawEmail || '', password || '');
  if (result === 'suspended') return res.status(403).json({ error: 'Account suspended' });
  if (!result) return res.status(401).json({ error: 'Invalid email or password' });
  const token = auth.createToken(result);
  res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
  res.json({ ok: true });
});

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body || {};
  const result = await auth.loginAdmin(email || '', password || '');
  if (!result) return res.status(401).json({ error: 'Invalid email or password' });
  const token = auth.createToken(result);
  res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
  res.json({ ok: true, role: result.role });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(auth.COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', auth.requireAuthApi(), (req, res) => res.json({ user: req.user }));

// ─────────────────────────────────────────────────────────────────────
// PASSWORD RESET — role-aware (parent/teacher/admin all share this
// pair of routes; role comes from which form submitted, since the
// same email address could in principle exist in more than one table).
// Deliberately returns the same {ok:true} response whether or not the
// email was found, so this endpoint can't be used to probe which
// emails have accounts — the token itself is only ever sent by email,
// never revealed in the response.
// ─────────────────────────────────────────────────────────────────────

function getAccountByRoleAndEmail(role, emailAddr) {
  if (role === 'teacher') return db.getTeacherByEmail(emailAddr);
  if (role === 'admin') return db.getAdminByEmail(emailAddr);
  return db.getParentByEmail(emailAddr);
}

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email: rawEmail, role } = req.body || {};
  const validRole = ['parent', 'teacher', 'admin'].includes(role) ? role : 'parent';
  if (!rawEmail) return res.status(400).json({ error: 'Missing fields' });

  const account = getAccountByRoleAndEmail(validRole, rawEmail);
  if (account) {
    const token = db.createPasswordResetToken(validRole, account.id);
    const resetUrl = `${(process.env.APP_URL || 'https://mareapp-production.up.railway.app')}/reset-password.html?token=${token}&role=${validRole}`;
    email.sendPasswordResetEmail(account.email, account.name, resetUrl)
      .catch(e => console.error('password reset email failed:', e.message));
  }
  // Same response either way — see comment above.
  res.json({ ok: true });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const record = db.getValidPasswordResetToken(token);
  if (!record) return res.status(400).json({ error: 'This reset link is invalid or has expired' });

  const hash = await auth.hashPassword(password);
  if (record.role === 'teacher') db.updateTeacherPasswordHash(record.user_id, hash);
  else if (record.role === 'admin') db.updateAdminPasswordHash(record.user_id, hash);
  else db.updateParentPasswordHash(record.user_id, hash);

  db.markPasswordResetTokenUsed(token);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// CHILDREN — profiles that can belong to more than one parent/carer.
// Two access levels used throughout: requireChildAccess (primary parent
// OR any linked carer — viewing, editing basic details, adding another
// carer, managing addresses) and requireChildOwnership (primary parent
// only — deleting the child, removing a carer). See the child_carers
// schema comment in db.js for why removal is more restricted than
// adding: it avoids carers being able to remove each other or the
// primary parent in a dispute.
// ─────────────────────────────────────────────────────────────────────

function requireChildAccess(req, res) {
  const child = db.getChild(req.params.id);
  if (!child || !db.canParentAccessChild(req.user.id, child.id)) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return child;
}
function requireChildOwnership(req, res) {
  const child = db.getChild(req.params.id);
  if (!child || !db.isPrimaryParentOfChild(req.user.id, child.id)) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return child;
}

app.get('/api/children', auth.requireAuthApi(['parent']), (req, res) => {
  res.json({ children: db.getChildrenByParent(req.user.id) });
});
app.post('/api/children', auth.requireAuthApi(['parent']), (req, res) => {
  const { name, avatarKey } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = db.createChild(req.user.id, name, avatarKey);
  res.json({ ok: true, id });
});
app.get('/api/children/:id', auth.requireAuthApi(['parent']), (req, res) => {
  const child = requireChildAccess(req, res);
  if (!child) return;
  res.json({
    child,
    isPrimary: db.isPrimaryParentOfChild(req.user.id, child.id),
    carers: db.getCarersForChild(child.id),
    addresses: db.getAddressesForOwner('child', child.id),
  });
});
app.patch('/api/children/:id', auth.requireAuthApi(['parent']), (req, res) => {
  const child = requireChildAccess(req, res);
  if (!child) return;
  try {
    db.updateChild(child.id, req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/children/:id', auth.requireAuthApi(['parent']), (req, res) => {
  const child = requireChildOwnership(req, res);
  if (!child) return;
  db.deleteChild(child.id);
  res.json({ ok: true });
});
// Kept alongside the general PATCH above for backward compatibility —
// this shipped first and the test harness already calls it directly.
app.patch('/api/children/:id/age-band', auth.requireAuthApi(['parent']), (req, res) => {
  const child = requireChildAccess(req, res);
  if (!child) return;
  try {
    db.setChildAgeBand(child.id, req.body?.ageBand);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Carers ──
app.get('/api/children/:id/carers', auth.requireAuthApi(['parent']), (req, res) => {
  const child = requireChildAccess(req, res);
  if (!child) return;
  res.json({ carers: db.getCarersForChild(child.id) });
});
app.post('/api/children/:id/carers', auth.requireAuthApi(['parent']), (req, res) => {
  const child = requireChildAccess(req, res);
  if (!child) return;
  const { email, relationship } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const id = db.addCarerToChild(child.id, email, relationship);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/children/:id/carers/:carerLinkId', auth.requireAuthApi(['parent']), (req, res) => {
  const child = requireChildOwnership(req, res);
  if (!child) return;
  db.removeCarerFromChild(req.params.carerLinkId);
  res.json({ ok: true });
});

// ── Addresses (child-owned) ──
app.get('/api/children/:id/addresses', auth.requireAuthApi(['parent']), (req, res) => {
  const child = requireChildAccess(req, res);
  if (!child) return;
  res.json({ addresses: db.getAddressesForOwner('child', child.id) });
});
app.post('/api/children/:id/addresses', auth.requireAuthApi(['parent']), (req, res) => {
  const child = requireChildAccess(req, res);
  if (!child) return;
  const { label, recipientName, line1, line2, city, postcode, country, isDefault } = req.body || {};
  if (!line1 || !city || !postcode) return res.status(400).json({ error: 'line1, city, and postcode are required' });
  const id = db.createAddress('child', child.id, { label, recipientName, line1, line2, city, postcode, country, isDefault });
  res.json({ ok: true, id });
});

// ── Addresses — shared update/delete for both parent- and child-owned
// rows. Ownership is checked generically here since an address row
// doesn't know in advance which kind of owner it belongs to. ──
function requireAddressAccess(req, res) {
  const address = db.getAddress(req.params.id);
  if (!address) { res.status(404).json({ error: 'Not found' }); return null; }
  const allowed = address.owner_type === 'parent'
    ? address.owner_id === req.user.id
    : db.canParentAccessChild(req.user.id, address.owner_id);
  if (!allowed) { res.status(404).json({ error: 'Not found' }); return null; }
  return address;
}
app.patch('/api/addresses/:id', auth.requireAuthApi(['parent']), (req, res) => {
  const address = requireAddressAccess(req, res);
  if (!address) return;
  db.updateAddress(address.id, req.body || {});
  res.json({ ok: true });
});
app.delete('/api/addresses/:id', auth.requireAuthApi(['parent']), (req, res) => {
  const address = requireAddressAccess(req, res);
  if (!address) return;
  db.deleteAddress(address.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// ACCOUNT — the parent's own profile: name, birthday, locale, email
// preferences, and their own addresses (separate from any child's
// addresses — e.g. a grandparent's shipping address lives on the child,
// not the parent, if that's where gifts should go). One GET returns
// everything the account page needs in a single call, same pattern as
// /api/splash.
// ─────────────────────────────────────────────────────────────────────

app.get('/api/account', auth.requireAuthApi(['parent']), (req, res) => {
  const parent = db.getParentById(req.user.id);
  const { password_hash, ...safeParent } = parent;
  res.json({
    parent: safeParent,
    addresses: db.getAddressesForOwner('parent', req.user.id),
    children: db.getChildrenByParent(req.user.id).map(c => ({
      ...c,
      isPrimary: db.isPrimaryParentOfChild(req.user.id, c.id),
    })),
  });
});
app.patch('/api/account', auth.requireAuthApi(['parent']), (req, res) => {
  const { name, birthdayMonth, birthdayDay, preferredLocale } = req.body || {};
  db.updateParentProfile(req.user.id, { name, birthdayMonth, birthdayDay, preferredLocale });
  res.json({ ok: true });
});
app.patch('/api/account/email-prefs', auth.requireAuthApi(['parent']), (req, res) => {
  const { optIn, frequency } = req.body || {};
  db.setParentEmailPrefs(req.user.id, !!optIn, frequency === 'daily' ? 'daily' : 'weekly');
  res.json({ ok: true });
});
app.get('/api/account/addresses', auth.requireAuthApi(['parent']), (req, res) => {
  res.json({ addresses: db.getAddressesForOwner('parent', req.user.id) });
});
app.post('/api/account/addresses', auth.requireAuthApi(['parent']), (req, res) => {
  const { label, recipientName, line1, line2, city, postcode, country, isDefault } = req.body || {};
  if (!line1 || !city || !postcode) return res.status(400).json({ error: 'line1, city, and postcode are required' });
  const id = db.createAddress('parent', req.user.id, { label, recipientName, line1, line2, city, postcode, country, isDefault });
  res.json({ ok: true, id });
});

app.post('/api/account/change-password', auth.requireAuthApi(['parent']), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const parent = db.getParentById(req.user.id);
    const valid = await auth.verifyPassword(currentPassword, parent.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await auth.hashPassword(newPassword);
    db.updateParentPasswordHash(req.user.id, hash);
    res.json({ ok: true });
  } catch (e) {
    console.error('change-password failed', e);
    res.status(500).json({ error: 'Could not update password' });
  }
});

// Blocked if this parent is the primary parent for any child — see the
// db.js comment on deleteParentAccount for why. A carer-only account
// (or one with no children at all) can delete freely.
app.delete('/api/account', auth.requireAuthApi(['parent']), (req, res) => {
  const primaryCount = db.primaryChildrenCountForParent(req.user.id);
  if (primaryCount > 0) {
    return res.status(409).json({ error: 'You\u2019re the primary parent for one or more children — remove or reassign them first.', primaryChildrenCount: primaryCount });
  }
  db.deleteParentAccount(req.user.id);
  res.clearCookie(auth.COOKIE_NAME);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// SPLASH — books + Club Mare + Merchandise icons in one call
// ─────────────────────────────────────────────────────────────────────

app.get('/api/splash', (req, res) => {
  const locale = resolveLocale(req);
  res.cookie('mare_locale', locale, { maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({
    locale,
    books: db.getActiveBooksForLocale(locale),
    hasClubMare: true,
    hasMerchandise: true,
  });
});

app.get('/api/books/:slug', (req, res) => {
  const book = db.getBookBySlug(req.params.slug);
  if (!book) return res.status(404).json({ error: 'Not found' });
  const chapters = db.getChaptersByBook(book.id).map(ch => ({
    ...ch,
    scenes: db.getScenesByChapter(ch.id),
  }));
  res.json({ book, chapters });
});

app.get('/api/scenes/:id', (req, res) => {
  const sceneId = req.params.id;
  res.json({
    sentences: db.getNarrationSentences(sceneId),
    hotspots: db.getHotspotsByScene(sceneId),
    audioCues: db.getAudioCuesByScene(sceneId),
  });
});

app.get('/api/activities/book/:bookId', (req, res) => {
  res.json({ activities: db.getActivitiesForBook(req.params.bookId) });
});

// Reading progress — parent-scoped (see the reading_progress schema
// comment in db.js for why not child-scoped). bookId here is the real
// book row id (from the already-loaded /api/books/:slug response), not
// the slug.
app.get('/api/reading-progress/:bookId', auth.requireAuthApi(['parent']), (req, res) => {
  const progress = db.getReadingProgress(req.user.id, req.params.bookId);
  res.json({ progress: progress || null });
});
app.post('/api/reading-progress', auth.requireAuthApi(['parent']), (req, res) => {
  const { bookId, chapterId, sceneId } = req.body || {};
  if (!bookId || !chapterId || !sceneId) return res.status(400).json({ error: 'bookId, chapterId, and sceneId required' });
  db.upsertReadingProgress(req.user.id, bookId, chapterId, sceneId);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// MEDIA UPLOAD — presigned R2, browser uploads directly (same pattern
// as per_bot). Admin-only.
// ─────────────────────────────────────────────────────────────────────

app.post('/api/admin/upload-url', auth.requireAuthApi(['admin', 'support']), async (req, res) => {
  try {
    const { key, contentType } = req.body || {};
    if (!key || !contentType) return res.status(400).json({ error: 'key and contentType required' });
    const url = await media.getUploadUrl(key, contentType);
    res.json({ url, key });
  } catch (e) {
    console.error('upload-url failed', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/playback-url', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'key required' });
    const url = await media.getPlaybackUrl(key);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// MARE VOICE — speak any text via ElevenLabs, same voice already used
// for Mare inside per_bot's Tomte flow (MARE_VOICE_ID). Generalises the
// per_bot /api/speak pattern so any text field (quiz instructions,
// hotspot popups, What's New items) can be read aloud.
// ─────────────────────────────────────────────────────────────────────

app.post('/api/speak', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    if (!ELEVENLABS_API_KEY || !MARE_VOICE_ID) return res.status(503).json({ error: 'Voice not configured' });

    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${MARE_VOICE_ID}?output_format=mp3_44100_192`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY, 'Connection': 'close' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
    });
    if (!ttsRes.ok) throw new Error(`ElevenLabs TTS failed: ${ttsRes.status}`);
    res.set('Content-Type', 'audio/mpeg');
    ttsRes.body.pipe(res);
  } catch (e) {
    console.error('speak failed', e);
    res.status(500).json({ error: e.message });
  }
});

// Curated Mare "menu" — hello / joke etc. A small fixed set of
// pre-written responses, spoken via the same /api/speak pipeline. Talk
// to Mare below is the open-conversation version of this — the menu
// stays as a lighter-weight option for a quick moment that doesn't need
// a real back-and-forth. Content itself lives in admin later; this is
// the endpoint shape.
app.get('/api/mare/menu', (req, res) => {
  res.json({
    items: [
      { id: 'hello', label: 'Say hello' },
      { id: 'joke', label: 'Tell a joke' },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────
// TALK TO MARE — a real, open conversation between a child and Mare.
// Architecture: /listen is a raw Deepgram STT proxy (own websocket, no
// Claude/TTS in it at all) — the child's device streams mic audio in,
// gets transcript JSON back, and once it has a final transcript it POSTs
// that text to /api/talk/chat over plain HTTP. That returns Mare's
// reply text, which the client then sends to the existing /api/speak
// for ElevenLabs playback. Three separate, simple pieces rather than one
// do-everything socket — this is the same split per_bot's own /listen
// comment traces back to "Mare Bot architecture," i.e. the original
// standalone Mare Bot prototype, not something invented fresh here.
//
// Auth model: every route below requires a parent session AND ownership
// of the child the session belongs to — a child has no login of their
// own (see the children table comment in db.js), so it's the parent's
// authenticated session that gates access on the child's behalf, the
// same way /api/children already works.
// ─────────────────────────────────────────────────────────────────────

// Conversation history lives here only, in memory, for the life of the
// session — see the talk_sessions schema comment in db.js for why full
// transcripts aren't written to the database in this pass. Cleared on
// server restart, same as per_bot's own in-memory chat sessions.
const talkSessions = new Map(); // sessionId -> { history: [{role,content}], systemPrompt, dbRow }

function requireOwnedChild(req, res) {
  const child = db.getChild(req.body?.childId || req.params?.childId);
  if (!child || !db.canParentAccessChild(req.user.id, child.id)) {
    res.status(404).json({ error: 'Child not found' });
    return null;
  }
  return child;
}

// A Talk session is tied to a child, not exclusively to whichever
// parent happened to start it — any parent/carer with access to that
// child can continue, end, or receive the opening for a session, same
// as with every other child-scoped resource in this file. In practice
// only one parent is ever holding the device during a live session, but
// the permission boundary should match the child-access model, not the
// literal originator.
function requireSessionChildAccess(req, res, sessionId) {
  const dbRow = db.getTalkSession(sessionId);
  if (!dbRow || !db.canParentAccessChild(req.user.id, dbRow.child_id)) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  return dbRow;
}

// Talk to Mare doesn't yet have an explicit "which book is this about"
// selection — there's only one active book today, so this picks the
// first active one for the session's locale (falling back the same
// way getActiveBooksForLocale always does). If a second book is ever
// added, this is the one place that would need a real selection
// mechanism; until then, this keeps today's only book correctly wired
// in without inventing a picker nobody needs yet.
function getPrimaryBookText(locale) {
  try {
    const books = db.getActiveBooksForLocale(locale);
    if (!books.length) return '';
    return db.getFullBookText(books[0].id);
  } catch (e) {
    console.error('getPrimaryBookText failed', e);
    return ''; // Talk still works, just without book-specific knowledge — same as before this feature existed.
  }
}

app.post('/api/talk/session', auth.requireAuthApi(['parent']), (req, res) => {
  const child = requireOwnedChild(req, res);
  if (!child) return;
  const locale = resolveLocale(req);
  const sessionId = db.createTalkSession(child.id, req.user.id, locale);
  const systemPrompt = prompts.buildMareSystemPrompt({
    ageBand: child.age_band,
    locale,
    childName: child.name,
    bookText: getPrimaryBookText(locale),
  });
  talkSessions.set(sessionId, { history: [], systemPrompt, dbRow: db.getTalkSession(sessionId) });
  res.json({ ok: true, sessionId, locale });
});

app.post('/api/talk/chat', auth.requireAuthApi(['parent']), async (req, res) => {
  try {
    const { sessionId, message } = req.body || {};
    if (!sessionId || !message) return res.status(400).json({ error: 'sessionId and message required' });

    const dbRow = requireSessionChildAccess(req, res, sessionId);
    if (!dbRow) return;
    if (dbRow.ended_at) return res.status(410).json({ error: 'Session has ended' });
    if (!anthropic) return res.status(503).json({ error: 'Talk is not configured' });

    let session = talkSessions.get(sessionId);
    if (!session) {
      // Server restarted mid-session, or this is somehow the first turn
      // without a prior /api/talk/session call reaching memory — rebuild
      // the system prompt fresh from the DB row rather than failing.
      const child = db.getChild(dbRow.child_id);
      session = {
        history: [],
        systemPrompt: prompts.buildMareSystemPrompt({
          ageBand: child?.age_band,
          locale: dbRow.locale,
          childName: child?.name,
          bookText: getPrimaryBookText(dbRow.locale),
        }),
        dbRow,
      };
      talkSessions.set(sessionId, session);
    }

    session.history.push({ role: 'user', content: message });

    const response = await anthropic.messages.create({
      model: TALK_MODEL,
      max_tokens: 400,
      system: session.systemPrompt,
      messages: session.history,
    });
    const replyText = (response.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    session.history.push({ role: 'assistant', content: replyText });
    db.touchTalkSession(sessionId);

    res.json({ ok: true, reply: replyText });
  } catch (e) {
    console.error('talk chat failed', e);
    res.status(500).json({ error: 'Mare is having trouble hearing right now — try again in a moment.' });
  }
});

app.post('/api/talk/session/:id/end', auth.requireAuthApi(['parent']), (req, res) => {
  const dbRow = requireSessionChildAccess(req, res, req.params.id);
  if (!dbRow) return;
  db.endTalkSession(req.params.id);
  talkSessions.delete(req.params.id);
  res.json({ ok: true });
});

// The very first thing Mare says, in character, without the child having
// spoken yet — see prompts.js's MARE_OPENING_LINE. Separate from
// /api/talk/chat because it isn't a reply to anything; it's an opener,
// pushed to history as an assistant turn so the conversation continues
// naturally from there.
app.post('/api/talk/session/:id/opening', auth.requireAuthApi(['parent']), async (req, res) => {
  try {
    const dbRow = requireSessionChildAccess(req, res, req.params.id);
    if (!dbRow) return;
    if (!anthropic) return res.status(503).json({ error: 'Talk is not configured' });

    let session = talkSessions.get(req.params.id);
    if (!session) return res.status(410).json({ error: 'Session expired — start a new one' });
    if (session.history.length) return res.status(409).json({ error: 'Opening already given for this session' });

    const response = await anthropic.messages.create({
      model: TALK_MODEL,
      max_tokens: 200,
      system: session.systemPrompt,
      messages: [{ role: 'user', content: '(The child has just arrived. Give your opening line now.)' }],
    });
    const replyText = (response.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    session.history.push({ role: 'assistant', content: replyText });
    res.json({ ok: true, reply: replyText });
  } catch (e) {
    console.error('talk opening failed', e);
    res.status(500).json({ error: 'Mare is having trouble hearing right now — try again in a moment.' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// MARE HELPER — the site-wide "how does this app work" character.
// Same Mare as Talk to Mare (see prompts.js's buildMareHelperSystemPrompt
// for why this is one character with one voice, not a separate helper),
// but general-purpose and available everywhere: public showcase pages,
// the parent/teacher hub, admin, even alongside the child's own Talk to
// Mare session. No auth required — has to work for anonymous visitors
// on the showcase page too — so rate-limited per IP instead, same
// pattern per_bot's Tomte uses for the same reason.
//
// Text-only for now (type a question, get a reply, optionally hear it
// via the existing /api/speak TTS pipeline). Live voice input (a
// microphone, streamed to Deepgram) is real future work, not built in
// this pass — flagged here rather than silently left out.
//
// History is kept client-side and sent each turn (capped at the last
// 10 messages by the widget) rather than a server-side session store —
// this conversation is stateless and lightweight by design, unlike
// Talk to Mare's real talk_sessions rows, so there's no new table for
// it.
// ─────────────────────────────────────────────────────────────────────

// Formats a real DB product row for Mare Helper's prompt — never used
// with client-supplied product data (see the productId lookup at each
// call site), so what she's told about a product is always what's
// actually in the catalog, not something a request could put words in
// her mouth about.
function formatProductForMareHelper(product, locale) {
  if (!product || !product.active) return null;
  const priceFormatted = new Intl.NumberFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', {
    style: 'currency', currency: (product.currency || 'gbp').toUpperCase(),
  }).format((product.price_cents || 0) / 100);
  return { name: product.name, description: product.description, priceFormatted };
}

const mareHelperRateLog = new Map(); // ip -> [timestamps]
function mareHelperRateLimitOk(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000; // 10 minutes
  const maxRequests = 30;
  const recent = (mareHelperRateLog.get(ip) || []).filter(t => now - t < windowMs);
  if (recent.length >= maxRequests) return false;
  recent.push(now);
  mareHelperRateLog.set(ip, recent);
  return true;
}

// Best-effort identification of who's asking, without requiring login —
// affects register (buildMareHelperSystemPrompt's 'child' vs everything
// else) but never gates access to the helper itself.
function resolveHelperAudience(req) {
  try {
    const token = req.cookies && req.cookies[auth.COOKIE_NAME];
    const payload = token && auth.verifyToken(token);
    if (payload && ['parent', 'teacher', 'admin', 'support'].includes(payload.role)) return payload.role;
  } catch { /* fall through to anonymous */ }
  return 'anonymous';
}

app.post('/api/mare-helper/greet', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    if (!mareHelperRateLimitOk(ip)) return res.status(429).json({ error: 'Too many requests — try again in a few minutes.' });
    if (!anthropic) return res.status(503).json({ error: 'Mare Helper is not configured' });

    const { page, isChild, ageBand, childName, productId } = req.body || {};
    const locale = resolveLocale(req);
    const audience = isChild ? 'child' : resolveHelperAudience(req);
    const product = productId ? formatProductForMareHelper(db.getProduct(productId), locale) : null;
    const systemPrompt = prompts.buildMareHelperSystemPrompt({ page, audience, locale, ageBand, childName, product });

    const response = await anthropic.messages.create({
      model: TALK_MODEL,
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: 'user', content: '(Someone just opened you on this page. Give a short, warm greeting — one sentence, maybe two.)' }],
    });
    const reply = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.json({ ok: true, reply });
  } catch (e) {
    console.error('mare-helper greet failed', e);
    res.status(500).json({ error: 'Mare is having trouble hearing right now — try again in a moment.' });
  }
});

app.post('/api/mare-helper/chat', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    if (!mareHelperRateLimitOk(ip)) return res.status(429).json({ error: 'Too many requests — try again in a few minutes.' });
    const { page, focus, message, history, isChild, ageBand, childName, productId } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    if (!anthropic) return res.status(503).json({ error: 'Mare Helper is not configured' });
    const locale = resolveLocale(req);
    const audience = isChild ? 'child' : resolveHelperAudience(req);
    const product = productId ? formatProductForMareHelper(db.getProduct(productId), locale) : null;
    const systemPrompt = prompts.buildMareHelperSystemPrompt({ page, focus, audience, locale, ageBand, childName, product });

    // Client-supplied history, trusted only as conversational turns (not
    // as instructions) — same trust boundary as any other chat history
    // passed back to a model. Capped defensively here too, not just by
    // the widget, in case something else ever calls this endpoint.
    const trimmedHistory = Array.isArray(history) ? history.slice(-10) : [];
    const messages = [...trimmedHistory, { role: 'user', content: message }];

    const response = await anthropic.messages.create({
      model: TALK_MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages,
    });
    const reply = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.json({ ok: true, reply });
  } catch (e) {
    console.error('mare-helper chat failed', e);
    res.status(500).json({ error: 'Mare is having trouble hearing right now — try again in a moment.' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// NARRATION SYNC — upload narration audio for a scene, run it through
// Deepgram for word-level timestamps, collapse into sentences, store.
// Admin reviews/nudges the result before it's published (review UI is a
// separate front-end piece — this is the processing endpoint).
// ─────────────────────────────────────────────────────────────────────

app.post('/api/admin/scenes/:id/sync-narration', auth.requireAuthApi(['admin', 'support']), async (req, res) => {
  try {
    const sceneId = req.params.id;
    const { audioKey } = req.body || {};
    if (!audioKey) return res.status(400).json({ error: 'audioKey required' });
    if (!DEEPGRAM_API_KEY) return res.status(503).json({ error: 'Deepgram not configured' });

    db.setSceneNarrationAudio(sceneId, audioKey);
    const audioUrl = await media.getPlaybackUrl(audioKey);

    const dgRes = await fetch(
      `https://api.deepgram.com/v1/listen?model=nova-2&language=multi&smart_format=true&punctuate=true&utterances=true`,
      {
        method: 'POST',
        headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: audioUrl }),
      }
    );
    if (!dgRes.ok) throw new Error(`Deepgram failed: ${dgRes.status}`);
    const dgJson = await dgRes.json();

    // Deepgram's own "utterances" (when requested) are the natural
    // sentence-ish boundary — prefer those directly; fall back to a
    // manual collapse of the word array on punctuation if utterances
    // aren't present for some reason.
    const utterances = dgJson.results?.utterances;
    let sentences;
    if (utterances && utterances.length) {
      sentences = utterances.map(u => ({
        text: u.transcript,
        startMs: Math.round(u.start * 1000),
        endMs: Math.round(u.end * 1000),
      }));
    } else {
      const words = dgJson.results?.channels?.[0]?.alternatives?.[0]?.words || [];
      sentences = [];
      let cur = [];
      words.forEach(w => {
        cur.push(w);
        if (/[.!?]$/.test(w.punctuated_word || w.word)) {
          sentences.push({
            text: cur.map(x => x.punctuated_word || x.word).join(' '),
            startMs: Math.round(cur[0].start * 1000),
            endMs: Math.round(cur[cur.length - 1].end * 1000),
          });
          cur = [];
        }
      });
      if (cur.length) {
        sentences.push({
          text: cur.map(x => x.punctuated_word || x.word).join(' '),
          startMs: Math.round(cur[0].start * 1000),
          endMs: Math.round(cur[cur.length - 1].end * 1000),
        });
      }
    }

    db.replaceNarrationSentences(sceneId, sentences);
    db.clearAllBookTextCache();
    res.json({ ok: true, sentences: db.getNarrationSentences(sceneId) });
  } catch (e) {
    console.error('sync-narration failed', e);
    res.status(500).json({ error: e.message });
  }
});

// Manual nudge after review, before publish.
app.patch('/api/admin/sentences/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { startMs, endMs } = req.body || {};
  db.updateNarrationSentenceTiming(req.params.id, startMs, endMs);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// CLUB MARE — free now (tier 1), paid later (tier 2). Never tier 0.
// ─────────────────────────────────────────────────────────────────────

app.post('/api/club-mare/join', auth.requireAuthApi(['parent']), (req, res) => {
  db.joinClubMareFree(req.user.id);
  res.json({ ok: true });
});

app.get('/api/club-mare/membership', auth.requireAuthApi(['parent']), (req, res) => {
  const membership = db.getClubMareMembership(req.user.id);
  res.json({ tier: membership ? membership.tier : 0 });
});

app.get('/api/club-mare/posts', auth.requireAuthApi(['parent']), (req, res) => {
  const membership = db.getClubMareMembership(req.user.id);
  const tier = membership ? membership.tier : 0;
  res.json({ posts: tier > 0 ? db.getClubMarePosts(tier) : [] });
});

// ─────────────────────────────────────────────────────────────────────
// CLUB MARE ADMIN — member visibility/tier management, and full CRUD
// for the tier-gated exclusive posts. Nothing here touches Stripe
// directly; a tier override here is a manual admin decision (comping
// someone, or stepping a paid member back to free by hand), completely
// separate from whatever a real Stripe subscription is doing — see the
// comment on db.setClubMareMemberTier for why a downgrade here
// deliberately doesn't touch stripe_subscription_id.
// ─────────────────────────────────────────────────────────────────────

app.get('/api/admin/club-mare/members', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json({ members: db.getAllClubMareMembersAdmin() });
});
app.patch('/api/admin/club-mare/members/:parentId/tier', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { tier } = req.body || {};
  if (![1, 2].includes(Number(tier))) return res.status(400).json({ error: 'Invalid tier' });
  db.setClubMareMemberTier(req.params.parentId, Number(tier));
  res.json({ ok: true });
});
app.delete('/api/admin/club-mare/members/:parentId', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.removeClubMareMembership(req.params.parentId);
  res.json({ ok: true });
});

app.get('/api/admin/club-mare/posts', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json({ posts: db.getAllClubMarePostsAdmin() });
});
app.post('/api/admin/club-mare/posts', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { title, body, imageKey, minTier } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  const id = db.createClubMarePost({ title, body, imageKey, minTier: Number(minTier) });
  res.json({ ok: true, id });
});
app.patch('/api/admin/club-mare/posts/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { title, body, imageKey, minTier, active } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  db.updateClubMarePost(req.params.id, { title, body, imageKey, minTier: Number(minTier), active });
  res.json({ ok: true });
});
app.delete('/api/admin/club-mare/posts/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteClubMarePost(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// MERCHANDISE — in-app Stripe Checkout
// ─────────────────────────────────────────────────────────────────────

app.get('/api/products', (req, res) => res.json({ products: db.getActiveProducts() }));

app.post('/api/checkout', auth.requireAuthApi(['parent']), async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
    const { items, offerCode } = req.body || {}; // items: [{ productId, qty, variant }]
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items' });

    // Resolve the offer code once, up front — same validity checks
    // whether one item or several, and validated here rather than
    // trusting a discount amount the client might send.
    let offer = null;
    if (offerCode && offerCode.trim()) {
      offer = db.getOfferByCode(offerCode.trim());
      if (!offer || !offer.active) return res.status(400).json({ error: 'That code isn\'t valid.' });
      if (offer.expires_at && new Date(offer.expires_at) < new Date()) return res.status(400).json({ error: 'That code has expired.' });
    }

    let originalTotalCents = 0;
    const lineInputs = [];
    for (const item of items) {
      const product = db.getProduct(item.productId);
      if (!product) return res.status(400).json({ error: `Unknown product ${item.productId}` });
      const qty = item.qty || 1;
      const lineTotal = product.price_cents * qty;
      originalTotalCents += lineTotal;
      lineInputs.push({ product, qty, lineTotal });
    }

    // Percent discounts apply identically to every line, so no
    // proportional split is needed. A fixed discount is a flat amount
    // off the WHOLE order, not per item, so it's distributed across
    // lines by each line's share of the original total — a £5-off code
    // on a £20 cart takes 25% off every line, keeping Stripe's own
    // line-item totals internally consistent with the order total
    // rather than just knocking the discount off one arbitrary item.
    let totalCents = 0;
    const lineItems = lineInputs.map(({ product, qty, lineTotal }) => {
      let unitAmount = product.price_cents;
      if (offer) {
        if (offer.discount_type === 'percent') {
          unitAmount = Math.round(unitAmount * (1 - offer.discount_value / 100));
        } else if (offer.discount_type === 'fixed' && originalTotalCents > 0) {
          const lineShare = lineTotal / originalTotalCents;
          const lineDiscount = Math.round(offer.discount_value * lineShare);
          unitAmount = Math.max(0, Math.round(unitAmount - lineDiscount / qty));
        }
      }
      totalCents += unitAmount * qty;
      return {
        price_data: {
          currency: product.currency,
          product_data: { name: product.name },
          unit_amount: unitAmount,
        },
        quantity: qty,
      };
    });

    const orderId = db.createOrder(req.user.id, totalCents, 'gbp');
    items.forEach(item => {
      const product = db.getProduct(item.productId);
      db.addOrderItem(orderId, item.productId, item.variant, item.qty || 1, product.price_cents);
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      success_url: `${process.env.APP_URL || ''}/merchandise.html?success=1`,
      cancel_url: `${process.env.APP_URL || ''}/merchandise.html?cancelled=1`,
      metadata: { orderId, offerCode: offer ? offer.code : '' },
    });
    db.setOrderStripeSession(orderId, session.id);
    res.json({ url: session.url });
  } catch (e) {
    console.error('checkout failed', e);
    res.status(500).json({ error: e.message });
  }
});

// Stripe webhook — marks the order paid. Needs raw body, mounted before
// the express.json() middleware would normally consume it, so it's
// registered with its own express.raw() here.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook signature verification failed: ${e.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    db.markOrderPaid(event.data.object.id);
  }
  res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────────────
// WHAT'S NEW — Parent/Teacher only
// ─────────────────────────────────────────────────────────────────────

app.get('/api/whats-new', auth.requireAuthApi(['parent', 'teacher']), (req, res) => {
  res.json({ items: db.getWhatsNew(req.user.role) });
});

// ─────────────────────────────────────────────────────────────────────
// SOCIAL LINKS — public read (site footer), admin+support manage
// ─────────────────────────────────────────────────────────────────────

app.get('/api/social-links', (req, res) => {
  res.json({ links: db.getActiveSocialLinks() });
});
app.get('/api/admin/social-links', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json({ links: db.getAllSocialLinks() });
});
app.post('/api/admin/social-links', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { platform, url, label, sortOrder } = req.body || {};
  if (!platform || !url) return res.status(400).json({ error: 'platform and url required' });
  const id = db.createSocialLink({ platform, url, label, sortOrder });
  res.json({ ok: true, id });
});
app.patch('/api/admin/social-links/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const ok = db.updateSocialLink(req.params.id, req.body || {});
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
app.delete('/api/admin/social-links/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteSocialLink(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// MARKETING — "reformat for social": paste content, get platform-ready
// posts an admin copies and posts by hand. No auto-posting integration
// exists — same deliberate boundary as per_bot's own version of this
// tool. See prompts.js buildMarketingPrompt for the full design notes,
// in particular why {{SIGNUP_LINK}} is a token the model writes rather
// than a real URL it could hallucinate.
// ─────────────────────────────────────────────────────────────────────

app.post('/api/admin/marketing/generate', auth.requireAuthApi(['admin', 'support']), async (req, res) => {
  try {
    const { sourceText, platforms, includeCta } = req.body || {};
    if (!sourceText || !sourceText.trim()) return res.status(400).json({ error: 'Paste some source content first' });
    const requestedPlatforms = (Array.isArray(platforms) ? platforms : []).filter(p => prompts.MARKETING_PLATFORM_KEYS.includes(p));
    if (!requestedPlatforms.length) return res.status(400).json({ error: 'Choose at least one platform' });
    if (!anthropic) return res.status(503).json({ error: 'Marketing generation is not configured' });

    const systemPrompt = prompts.buildMarketingPrompt(!!includeCta);
    const response = await anthropic.messages.create({
      model: TALK_MODEL,
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: `SOURCE CONTENT:\n${sourceText}\n\nPLATFORMS: ${requestedPlatforms.join(', ')}` }],
    });
    const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

    let results;
    try {
      results = JSON.parse(raw);
    } catch (e) {
      console.error('marketing generate — model did not return valid JSON:', raw);
      return res.status(502).json({ error: 'Mare\u2019s marketing generator returned something unexpected \u2014 try again.' });
    }

    // Substitute the real signup link server-side — the model only ever
    // wrote the literal token, never an actual URL.
    const signupUrl = `${process.env.APP_URL || ''}/`;
    for (const platform of Object.keys(results)) {
      if (typeof results[platform] === 'string') {
        results[platform] = results[platform].split('{{SIGNUP_LINK}}').join(signupUrl);
      }
    }

    db.createMarketingPost({
      sourceText,
      platforms: requestedPlatforms,
      results,
      includedCta: !!includeCta,
      createdById: req.user.id,
      createdByRole: req.user.role,
    });

    res.json({ ok: true, results });
  } catch (e) {
    console.error('marketing generate failed', e);
    res.status(500).json({ error: 'Could not generate posts right now \u2014 try again in a moment.' });
  }
});

app.get('/api/admin/marketing/history', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const rows = db.getMarketingHistory(30).map(r => ({
    ...r,
    platforms: JSON.parse(r.platforms_json),
    results: JSON.parse(r.results_json),
  }));
  res.json({ history: rows });
});
app.delete('/api/admin/marketing/history/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteMarketingPost(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// ADMIN — content CRUD (books/chapters/scenes/hotspots/activities/
// products/whats-new). Kept intentionally minimal here — no
// course/comms/facilitator admin exists in this app at all.
// ─────────────────────────────────────────────────────────────────────

app.get('/api/admin/books', auth.requireAuthApi(['admin', 'support']), (req, res) => res.json({ books: db.getAllBooks() }));
app.post('/api/admin/books', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { title, slug, description, splashIconKey } = req.body || {};
  if (!title || !slug) return res.status(400).json({ error: 'title and slug required' });
  const id = db.createBook({ title, slug, description, splashIconKey });
  res.json({ ok: true, id });
});
app.patch('/api/admin/books/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const ok = db.updateBook(req.params.id, req.body || {});
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
// The full nested tree (chapters -> scenes -> hotspots/audioCues/
// sentences) in one call — what the content editor loads on open,
// rather than a round trip per scene.
app.get('/api/admin/books/:id/full', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const tree = db.getBookFullTree(req.params.id);
  if (!tree) return res.status(404).json({ error: 'Not found' });
  res.json(tree);
});

app.post('/api/admin/chapters', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { bookId, title, sortOrder } = req.body || {};
  if (!bookId || !title) return res.status(400).json({ error: 'bookId and title required' });
  const id = db.createChapter(bookId, title, sortOrder);
  res.json({ ok: true, id });
});
app.patch('/api/admin/chapters/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const ok = db.updateChapter(req.params.id, req.body || {});
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
app.delete('/api/admin/chapters/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteChapter(req.params.id);
  res.json({ ok: true });
});
// Drag-reorder — body is the full ordered list of chapter ids for this
// book; sort_order is rewritten 0..n to match exactly.
app.post('/api/admin/chapters/reorder', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { bookId, orderedIds } = req.body || {};
  if (!bookId || !Array.isArray(orderedIds)) return res.status(400).json({ error: 'bookId and orderedIds required' });
  db.reorderChapters(bookId, orderedIds);
  res.json({ ok: true });
});

app.post('/api/admin/scenes', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { chapterId, kind, sortOrder } = req.body || {};
  if (!chapterId || !kind) return res.status(400).json({ error: 'chapterId and kind required' });
  const id = db.createScene(chapterId, kind, sortOrder);
  res.json({ ok: true, id });
});
app.patch('/api/admin/scenes/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  if (req.body?.kind) db.updateSceneKind(req.params.id, req.body.kind);
  res.json({ ok: true });
});
app.delete('/api/admin/scenes/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteScene(req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/scenes/reorder', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { chapterId, orderedIds } = req.body || {};
  if (!chapterId || !Array.isArray(orderedIds)) return res.status(400).json({ error: 'chapterId and orderedIds required' });
  db.reorderScenes(chapterId, orderedIds);
  res.json({ ok: true });
});
app.patch('/api/admin/scenes/:id/image', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.setSceneImage(req.params.id, req.body.imageKey);
  res.json({ ok: true });
});
app.patch('/api/admin/scenes/:id/narration-audio', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.setSceneNarrationAudio(req.params.id, req.body.audioKey);
  res.json({ ok: true });
});
app.patch('/api/admin/narration-sentences/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { text, startMs, endMs } = req.body || {};
  if (text !== undefined) { db.updateNarrationSentenceText(req.params.id, text); db.clearAllBookTextCache(); }
  if (startMs !== undefined && endMs !== undefined) db.updateNarrationSentenceTiming(req.params.id, startMs, endMs);
  res.json({ ok: true });
});

app.post('/api/admin/hotspots', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { sceneId, x, y, w, h, type, payload } = req.body || {};
  if (!sceneId || x === undefined || y === undefined || !type) return res.status(400).json({ error: 'sceneId, x, y, and type required' });
  const id = db.createHotspot(sceneId, { x, y, w, h, type, payload });
  res.json({ ok: true, id });
});
app.patch('/api/admin/hotspots/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const ok = db.updateHotspot(req.params.id, req.body || {});
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
app.delete('/api/admin/hotspots/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteHotspot(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/audio-cues', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { sceneId, kind, audioKey, startMs, volume, loop } = req.body || {};
  if (!sceneId || !kind || !audioKey) return res.status(400).json({ error: 'sceneId, kind, and audioKey required' });
  const id = db.createAudioCue(sceneId, { kind, audioKey, startMs, volume, loop });
  res.json({ ok: true, id });
});
app.patch('/api/admin/audio-cues/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const ok = db.updateAudioCue(req.params.id, req.body || {});
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
app.delete('/api/admin/audio-cues/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteAudioCue(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/activities', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { bookId, chapterId, type, title, payload } = req.body || {};
  const id = db.createActivity({ bookId, chapterId, type, title, payload });
  res.json({ ok: true, id });
});

// Products/payments — admin only, never support, per Per's scoping of the
// support role (content + helping parents/teachers, no payment settings).
app.get('/api/admin/products', auth.requireAuthApi(['admin']), (req, res) => {
  res.json({ products: db.getAllProductsAdmin() });
});
app.post('/api/admin/products', auth.requireAuthApi(['admin']), (req, res) => {
  const { name, description, priceCents, currency, imageKey, imageKeys, videoKey, variantOptions, stock, sortOrder } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!priceCents || priceCents <= 0) return res.status(400).json({ error: 'A valid price is required' });
  const id = db.createProduct({ name, description, priceCents, currency, imageKey, imageKeys, videoKey, variantOptions, stock, sortOrder });
  res.json({ ok: true, id });
});
app.patch('/api/admin/products/:id', auth.requireAuthApi(['admin']), (req, res) => {
  const { name, description, priceCents, currency, imageKey, imageKeys, videoKey, variantOptions, stock, active, sortOrder } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!priceCents || priceCents <= 0) return res.status(400).json({ error: 'A valid price is required' });
  db.updateProduct(req.params.id, { name, description, priceCents, currency, imageKey, imageKeys, videoKey, variantOptions, stock, active, sortOrder });
  res.json({ ok: true });
});
app.delete('/api/admin/products/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteProduct(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/whats-new', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { audience, title, body, linkType, linkValue } = req.body || {};
  const id = db.createWhatsNew({ audience, title, body, linkType, linkValue });
  res.json({ ok: true, id });
});
app.get('/api/admin/whats-new-items', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json({ items: db.getAllWhatsNewAdmin() });
});
app.patch('/api/admin/whats-new-items/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { audience, title, body, linkType, linkValue, active } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Missing fields' });
  db.updateWhatsNew(req.params.id, { audience, title, body, linkType, linkValue, active });
  res.json({ ok: true });
});
app.delete('/api/admin/whats-new-items/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteWhatsNew(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// BROADCASTS — the "comms" system. Admin composes a message with the
// rich editor, targets parents/teachers/both, and either saves it as a
// draft, sends a test copy to themself, schedules it for later, or
// sends it now. sendBroadcastNow() is shared between the immediate-send
// route and the cron pickup below, so the actual sending logic exists
// in exactly one place.
// ─────────────────────────────────────────────────────────────────────

async function sendBroadcastNow(broadcast) {
  db.markBroadcastSending(broadcast.id);
  const recipients = db.getBroadcastAudienceEmails(broadcast.audience);
  let sentCount = 0, failedCount = 0;
  for (const r of recipients) {
    const result = await email.sendBroadcastEmail(r.email, broadcast.subject, broadcast.body_html, r.id);
    if (result.ok) sentCount++; else failedCount++;
  }
  db.markBroadcastSent(broadcast.id, { recipientCount: recipients.length, sentCount, failedCount });
}

app.get('/api/admin/broadcasts', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json({ broadcasts: db.getAllBroadcasts() });
});
app.get('/api/admin/broadcasts/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const b = db.getBroadcast(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json({ broadcast: b });
});
app.post('/api/admin/broadcasts', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { subject, bodyHtml, bodyText, audience } = req.body || {};
  if (!subject || !bodyHtml) return res.status(400).json({ error: 'Missing fields' });
  const id = db.createBroadcast({ subject, bodyHtml, bodyText, audience, createdById: req.user.id, createdByRole: req.user.role });
  res.json({ ok: true, id });
});
app.patch('/api/admin/broadcasts/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { subject, bodyHtml, bodyText, audience } = req.body || {};
  if (!subject || !bodyHtml) return res.status(400).json({ error: 'Missing fields' });
  db.updateBroadcastContent(req.params.id, { subject, bodyHtml, bodyText, audience });
  res.json({ ok: true });
});
app.delete('/api/admin/broadcasts/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteBroadcast(req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/broadcasts/:id/send-test', auth.requireAuthApi(['admin', 'support']), async (req, res) => {
  const b = db.getBroadcast(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const result = await email.sendBroadcastEmail(req.user.email, `[TEST] ${b.subject}`, b.body_html, req.user.id);
  if (!result.ok) return res.status(502).json({ error: result.error || 'Test send failed' });
  res.json({ ok: true });
});
app.post('/api/admin/broadcasts/:id/schedule', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { scheduledFor } = req.body || {};
  if (!scheduledFor) return res.status(400).json({ error: 'Missing fields' });
  const b = db.getBroadcast(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  db.scheduleBroadcast(req.params.id, scheduledFor);
  res.json({ ok: true });
});
app.post('/api/admin/broadcasts/:id/unschedule', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.unscheduleBroadcast(req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/broadcasts/:id/send', auth.requireAuthApi(['admin', 'support']), async (req, res) => {
  const b = db.getBroadcast(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.status === 'sent' || b.status === 'sending') return res.status(409).json({ error: 'Already sent or sending' });
  // Respond immediately — sending to a real audience can take a while
  // (one email.js call per recipient) and the admin shouldn't have to
  // wait on the HTTP request for it. Status is visible via the list/
  // detail routes once sendBroadcastNow finishes.
  res.json({ ok: true, status: 'sending' });
  sendBroadcastNow(b).catch(e => console.error('broadcast send failed:', e.message));
});

// ─────────────────────────────────────────────────────────────────────
// OFFERS — discount-code infrastructure for Sales & Marketing. Not yet
// wired into /api/checkout (no merchandise storefront page exists yet
// to apply a code from) — this is the admin-management half, ready for
// whenever that storefront gets built.
// ─────────────────────────────────────────────────────────────────────

app.get('/api/admin/offers-catalog', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json({ offers: db.getAllOffers() });
});
app.post('/api/admin/offers-catalog', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { code, description, discountType, discountValue, expiresAt } = req.body || {};
  if (!code || !discountValue) return res.status(400).json({ error: 'Missing fields' });
  if (db.getOfferByCode(code)) return res.status(409).json({ error: 'Code already exists' });
  const id = db.createOffer({ code, description, discountType, discountValue, expiresAt });
  res.json({ ok: true, id });
});
app.patch('/api/admin/offers-catalog/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { description, discountType, discountValue, active, expiresAt } = req.body || {};
  db.updateOffer(req.params.id, { description, discountType, discountValue, active, expiresAt });
  res.json({ ok: true });
});
app.delete('/api/admin/offers-catalog/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteOffer(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// SPLASH PAGE CONTENT — the public showcase landing page's welcome
// message, Talk to Mare sample phrases, showcase tiles, and intro
// video are all admin-managed rather than hardcoded. GET is public (the
// splash page itself needs this with no auth); everything else is
// admin/support.
// ─────────────────────────────────────────────────────────────────────

app.get('/api/showcase', async (req, res) => {
  const content = db.getShowcaseContent();
  let videoUrl = null;
  if (content.video_status === 'ready' && content.video_key) {
    try { videoUrl = await media.getPlaybackUrl(content.video_key); } catch { /* leave null, front-end handles it */ }
  }
  res.json({
    welcomeMessageEn: content.welcome_message_en,
    welcomeMessageNl: content.welcome_message_nl,
    videoStatus: content.video_status,
    videoUrl,
    tiles: db.getActiveShowcaseTiles(),
    talkPhrases: db.getActiveShowcasePhrases(),
  });
});
app.patch('/api/admin/showcase', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { welcomeMessageEn, welcomeMessageNl } = req.body || {};
  db.updateShowcaseContent({ welcomeMessageEn, welcomeMessageNl });
  res.json({ ok: true });
});
app.post('/api/admin/showcase/video', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'Missing fields' });
  db.setShowcaseVideo(key);
  res.json({ ok: true });
});
app.delete('/api/admin/showcase/video', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.clearShowcaseVideo();
  res.json({ ok: true });
});

app.get('/api/admin/showcase/phrases', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json({ phrases: db.getAllShowcasePhrasesAdmin() });
});
app.post('/api/admin/showcase/phrases', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { phraseEn, phraseNl, sortOrder } = req.body || {};
  if (!phraseEn) return res.status(400).json({ error: 'Missing fields' });
  const id = db.createShowcasePhrase({ phraseEn, phraseNl, sortOrder });
  res.json({ ok: true, id });
});
app.patch('/api/admin/showcase/phrases/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { phraseEn, phraseNl, sortOrder, active } = req.body || {};
  if (!phraseEn) return res.status(400).json({ error: 'Missing fields' });
  db.updateShowcasePhrase(req.params.id, { phraseEn, phraseNl, sortOrder, active });
  res.json({ ok: true });
});
app.delete('/api/admin/showcase/phrases/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteShowcasePhrase(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/showcase/tiles', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json({ tiles: db.getAllShowcaseTilesAdmin() });
});
app.post('/api/admin/showcase/tiles', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { tileType, labelEn, labelNl, icon, linkType, linkValue, sortOrder } = req.body || {};
  if (!labelEn) return res.status(400).json({ error: 'Missing fields' });
  const id = db.createShowcaseTile({ tileType, labelEn, labelNl, icon, linkType, linkValue, sortOrder });
  res.json({ ok: true, id });
});
app.patch('/api/admin/showcase/tiles/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { tileType, labelEn, labelNl, icon, linkType, linkValue, sortOrder, active } = req.body || {};
  if (!labelEn) return res.status(400).json({ error: 'Missing fields' });
  db.updateShowcaseTile(req.params.id, { tileType, labelEn, labelNl, icon, linkType, linkValue, sortOrder, active });
  res.json({ ok: true });
});
app.delete('/api/admin/showcase/tiles/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteShowcaseTile(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// BULK SCHOOL ONBOARDING — admin pastes a list (one person per line,
// CSV-style: role,name,email,extra) and every row gets created in one
// pass. extra means: school name for a teacher, parent's email for a
// child (to link them), unused for a parent. No plaintext passwords are
// ever generated or emailed — every created account gets a random
// unusable password plus an immediate password-reset token, and the
// welcome email carries a 'set your password' link through the exact
// same reset-password flow a forgotten-password request uses.
//
// Admin-initiated only (not self-service for schools) — per Per's
// answer that this should be the admin-side tool for now.
// ─────────────────────────────────────────────────────────────────────

function parseBulkImportText(text) {
  return text.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.toLowerCase().startsWith('role,')) // skip blank lines and an optional header row
    .map(line => {
      const parts = line.split(',').map(p => p.trim());
      return { role: (parts[0] || '').toLowerCase(), name: parts[1] || '', email: parts[2] || '', extra: parts[3] || '' };
    });
}

app.post('/api/admin/bulk-import', auth.requireAuthApi(['admin', 'support']), async (req, res) => {
  const { schoolName, text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Missing fields' });

  const rows = parseBulkImportText(text);
  if (!rows.length) return res.status(400).json({ error: 'No valid rows found' });
  if (rows.length > 500) return res.status(400).json({ error: 'Too many rows in one batch (max 500)' });

  const importId = db.createBulkImport({ schoolName, initiatedById: req.user.id, rowCount: rows.length });
  let createdCount = 0, failedCount = 0;
  // Parents created earlier in the SAME batch need to be linkable by
  // email for a child row later in the same batch, even before this
  // whole import is committed to the response — hence this in-memory
  // map alongside the real DB lookups.
  const parentEmailToId = {};

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowId = db.addBulkImportRow(importId, { rowNumber: i + 1, role: row.role, name: row.name, email: row.email, extra: row.extra });
    try {
      if (row.role === 'teacher') {
        if (!row.name || !row.email) throw new Error('Missing name or email');
        if (db.getTeacherByEmail(row.email)) throw new Error('Email already registered');
        const hash = await auth.hashPassword(crypto.randomBytes(24).toString('hex'));
        const teacherId = db.createTeacher({ email: row.email, passwordHash: hash, name: row.name, school: row.extra || schoolName });
        const token = db.createPasswordResetToken('teacher', teacherId);
        const resetUrl = `${process.env.APP_URL || 'https://mareapp-production.up.railway.app'}/reset-password.html?token=${token}&role=teacher`;
        email.sendPasswordResetEmail(row.email, row.name, resetUrl).catch(e => console.error('bulk welcome email failed:', e.message));
        db.markBulkImportRowResult(rowId, { status: 'created', createdUserId: teacherId });
        createdCount++;
      } else if (row.role === 'parent') {
        if (!row.name || !row.email) throw new Error('Missing name or email');
        if (db.getParentByEmail(row.email)) throw new Error('Email already registered');
        const hash = await auth.hashPassword(crypto.randomBytes(24).toString('hex'));
        const parentId = db.createParent({ email: row.email, passwordHash: hash, name: row.name });
        parentEmailToId[row.email.toLowerCase()] = parentId;
        const token = db.createPasswordResetToken('parent', parentId);
        const resetUrl = `${process.env.APP_URL || 'https://mareapp-production.up.railway.app'}/reset-password.html?token=${token}&role=parent`;
        email.sendPasswordResetEmail(row.email, row.name, resetUrl).catch(e => console.error('bulk welcome email failed:', e.message));
        db.markBulkImportRowResult(rowId, { status: 'created', createdUserId: parentId });
        createdCount++;
      } else if (row.role === 'child') {
        if (!row.name || !row.extra) throw new Error('Missing name or parent email');
        const parentEmail = row.extra.toLowerCase();
        let parentId = parentEmailToId[parentEmail];
        if (!parentId) {
          const existingParent = db.getParentByEmail(parentEmail);
          if (!existingParent) throw new Error(`No parent found for ${row.extra} — add that parent row first`);
          parentId = existingParent.id;
        }
        const childId = db.createChild(parentId, row.name, null);
        db.markBulkImportRowResult(rowId, { status: 'created', createdUserId: childId });
        createdCount++;
      } else {
        throw new Error(`Unknown role "${row.role}" — expected teacher, parent, or child`);
      }
    } catch (e) {
      db.markBulkImportRowResult(rowId, { status: 'failed', error: e.message });
      failedCount++;
    }
  }

  db.finishBulkImport(importId, { createdCount, failedCount });
  res.json({ ok: true, importId, createdCount, failedCount, rowCount: rows.length });
});

app.get('/api/admin/bulk-imports', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json({ imports: db.getAllBulkImports() });
});
app.get('/api/admin/bulk-imports/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const imp = db.getBulkImport(req.params.id);
  if (!imp) return res.status(404).json({ error: 'Not found' });
  res.json({ import: imp, rows: db.getBulkImportRows(req.params.id) });
});

// ─────────────────────────────────────────────────────────────────────
// STAFF ACCOUNTS — admin only. Creating an admin/support account is
// deliberately not self-service (no public signup for these roles) —
// only an existing admin can create another one from inside the dashboard.
// ─────────────────────────────────────────────────────────────────────

// One-time bootstrap for the very first admin account, since the normal
// path (an existing admin creates the next one) has no starting point
// otherwise. Only works while zero staff accounts exist at all —
// becomes permanently inert (403) the instant the first one is created,
// same shape as a real one-time-use credential rather than a standing
// unauthenticated door into the admin system.
//
// This runs in-process on the live server deliberately, not as a
// separate script — sql.js keeps the real database in server memory and
// periodically saves it to disk; a standalone script touching the same
// DB file while the real server is also running risks a silent
// data-loss race (whichever save happens last wins, overwriting the
// other). Going through this route means there's only ever one process
// touching the data.
app.post('/api/admin/bootstrap', async (req, res) => {
  try {
    if (db.getAllStaff().length > 0) {
      return res.status(403).json({ error: 'Bootstrap already used \u2014 a staff account already exists.' });
    }
    const { email, password, name } = req.body || {};
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password, and name required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hash = await auth.hashPassword(password);
    const id = db.createAdmin({ email, passwordHash: hash, name, role: 'admin' });
    res.json({ ok: true, id });
  } catch (e) {
    console.error('bootstrap failed', e);
    res.status(500).json({ error: 'Could not create admin account' });
  }
});

app.get('/api/admin/staff', auth.requireAuthApi(['admin']), (req, res) => {
  res.json({ staff: db.getAllStaff() });
});
app.post('/api/admin/staff', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { email, password, name, role } = req.body || {};
    if (!email || !password || !name) return res.status(400).json({ error: 'Missing fields' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (db.getAdminByEmail(email)) return res.status(409).json({ error: 'Email already registered' });
    const hash = await auth.hashPassword(password);
    const id = db.createAdmin({ email, passwordHash: hash, name, role: role === 'support' ? 'support' : 'admin' });
    res.json({ ok: true, id });
  } catch (e) {
    console.error('staff create failed', e);
    res.status(500).json({ error: 'Could not create account' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// PARENT / TEACHER DIRECTORY — read-only lookup so support and admin can
// help someone troubleshoot ("what email did you sign up with", "is your
// account actually there"). Status changes (suspend/reactivate) below
// are the one deliberate exception — blocking login without touching
// the account's data, for handling abuse/support issues without the
// heavier, irreversible delete path.
// ─────────────────────────────────────────────────────────────────────

app.get('/api/admin/parents', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json({ parents: db.getAllParentsDirectory() });
});
app.get('/api/admin/teachers', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json({ teachers: db.getAllTeachersDirectory() });
});
app.patch('/api/admin/parents/:id/status', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.setParentStatus(req.params.id, status);
  res.json({ ok: true });
});
app.patch('/api/admin/teachers/:id/status', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.setTeacherStatus(req.params.id, status);
  res.json({ ok: true });
});

// Single-account teacher creation — the admin-side replacement for the
// old public self-serve signup. Same secure pattern as bulk-import:
// random unusable password, immediate reset token, "set your password"
// email — never a plaintext password generated or sent.
app.post('/api/admin/teachers', auth.requireAuthApi(['admin', 'support']), async (req, res) => {
  const { name, email: rawEmail, school } = req.body || {};
  if (!name || !rawEmail) return res.status(400).json({ error: 'Missing fields' });
  if (db.getTeacherByEmail(rawEmail)) return res.status(409).json({ error: 'Email already registered' });
  const hash = await auth.hashPassword(crypto.randomBytes(24).toString('hex'));
  const teacherId = db.createTeacher({ email: rawEmail, passwordHash: hash, name, school });
  const token = db.createPasswordResetToken('teacher', teacherId);
  const resetUrl = `${process.env.APP_URL || 'https://mareapp-production.up.railway.app'}/reset-password.html?token=${token}&role=teacher`;
  email.sendPasswordResetEmail(rawEmail, name, resetUrl).catch(e => console.error('teacher welcome email failed:', e.message));
  res.json({ ok: true, id: teacherId });
});

// ─────────────────────────────────────────────────────────────────────
// ADMIN REPORTING — overview counts for the dashboard, and the email
// delivery log for troubleshooting "did that email actually send".
// Email log can include email addresses, so admin-only rather than
// admin+support — same boundary as products/payments elsewhere in
// this app.
// ─────────────────────────────────────────────────────────────────────

app.get('/api/admin/report/overview', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json(db.getAdminOverviewStats());
});
app.get('/api/admin/email-log', auth.requireAuthApi(['admin']), (req, res) => {
  res.json({ log: db.getRecentEmailLog(100) });
});

// ─────────────────────────────────────────────────────────────────────
// TEACHER RESOURCES — documents/tools/links shown in the teacher hub.
// Admin/support manage them here; teachers read them via the public
// endpoint below.
// ─────────────────────────────────────────────────────────────────────

app.get('/api/admin/teacher-resources', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json({ resources: db.getAllTeacherResources() });
});
app.post('/api/admin/teacher-resources', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { title, description, category, fileKey, externalUrl, sortOrder } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  const id = db.createTeacherResource({ title, description, category, fileKey, externalUrl, sortOrder });
  res.json({ ok: true, id });
});
app.patch('/api/admin/teacher-resources/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const ok = db.updateTeacherResource(req.params.id, req.body || {});
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
app.delete('/api/admin/teacher-resources/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteTeacherResource(req.params.id);
  res.json({ ok: true });
});

app.get('/api/teacher/resources', auth.requireAuthApi(['teacher']), (req, res) => {
  res.json({ resources: db.getActiveTeacherResources() });
});

// ─────────────────────────────────────────────────────────────────────
// APP PAGES DIRECTORY — admin's "Pages" tab. Maintained list, not an
// auto-crawl (see the comment on the app_pages table in db.js for why).
// Content, not payments, so admin+support both manage it.
// ─────────────────────────────────────────────────────────────────────

app.get('/api/admin/pages', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  res.json({ pages: db.getAllAppPages() });
});
app.post('/api/admin/pages', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const { label, url, kind, status, description, sortOrder } = req.body || {};
  if (!label || !url) return res.status(400).json({ error: 'label and url required' });
  const id = db.createAppPage({ label, url, kind, status, description, sortOrder });
  res.json({ ok: true, id });
});
app.patch('/api/admin/pages/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  const ok = db.updateAppPage(req.params.id, req.body || {});
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
app.delete('/api/admin/pages/:id', auth.requireAuthApi(['admin', 'support']), (req, res) => {
  db.deleteAppPage(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// "Messages from Mare" — daily/weekly opt-in email, same cron shape as
// per_bot's custom_reminders (hourly tick, dedup via a sent-today log).
// Actual email send + Mare-voiced content generation is left as a stub
// here — wire in Scaleway send + prompts.js-style content once the
// content/voice pipeline for these messages is decided.
// ─────────────────────────────────────────────────────────────────────

function startCron() {
  cron.schedule('0 * * * *', () => {
    const now = new Date();
    const hour = now.getUTCHours();
    const dateStr = now.toISOString().slice(0, 10);
    const isMonday = now.getUTCDay() === 1;

    const daily = hour === 8 ? db.getEmailOptInParents('daily') : [];
    const weekly = (hour === 8 && isMonday) ? db.getEmailOptInParents('weekly') : [];

    [...daily, ...weekly].forEach(parent => {
      if (db.hasSentMareMessageToday(parent.id, dateStr)) return;
      // TODO: actually send via Scaleway once "message from Mare" content is written
      console.log(`[mare-message] would send to ${parent.email}`);
      db.logMareMessageSent(parent.id, dateStr);
    });

    // Scheduled broadcasts — checked every hour tick, same cadence as
    // everything else in this cron. sendBroadcastNow is the exact same
    // function the immediate-send API route uses, so scheduled and
    // send-now broadcasts behave identically once they actually fire.
    db.getDueScheduledBroadcasts().forEach(b => {
      sendBroadcastNow(b).catch(e => console.error('scheduled broadcast send failed:', e.message));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// /listen — Deepgram STT proxy for Talk to Mare. Auth-gated: the upgrade
// request must carry a valid parent session cookie AND a ?session=
// query param naming a talk_sessions row that parent actually owns —
// unlike per_bot's original /listen (which is open, no auth at all,
// since it only ever ran behind pages already gated by page-level auth),
// this one is reachable directly as a raw websocket URL, so the check
// has to happen right here at the handshake. Once open, it's a pure
// proxy: audio bytes in, Deepgram's transcript JSON straight back out —
// no Claude, no TTS, nothing else happens on this socket at all.
// ─────────────────────────────────────────────────────────────────────

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

const listenWss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

listenWss.on('connection', (clientWs, req) => {
  const { searchParams } = new URL(req.url, 'http://internal');
  const locale = searchParams.get('locale') === 'nl' ? 'nl' : 'en';
  const dgLanguage = locale === 'nl' ? 'nl' : 'en';

  const dgWs = new WebSocket(
    `wss://api.deepgram.com/v1/listen?model=nova-2&language=${dgLanguage}&encoding=linear16&sample_rate=16000&channels=1&smart_format=true&endpointing=400&utterance_end_ms=3200&interim_results=true`,
    { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
  );
  dgWs.on('open', () => console.log('[listen] Deepgram connected'));
  dgWs.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => console.error(`[listen] deepgram rejected connection — status=${res.statusCode} body=${body}`));
  });
  dgWs.on('message', (data) => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(typeof data === 'string' ? data : data.toString('utf8')); });
  dgWs.on('error', (e) => console.error('[listen] Deepgram error:', e.message));
  dgWs.on('close', () => console.log('[listen] Deepgram closed'));
  clientWs.on('message', (audioData) => { if (dgWs.readyState === WebSocket.OPEN) dgWs.send(audioData); });
  clientWs.on('close', () => { if (dgWs.readyState === WebSocket.OPEN) dgWs.close(); });
  clientWs.on('error', (e) => console.error('[listen] client ws error:', e.message));
});

server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname !== '/listen') {
    socket.destroy();
    return;
  }

  if (!DEEPGRAM_API_KEY) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const payload = auth.verifyToken(cookies[auth.COOKIE_NAME]);
  if (!payload || payload.role !== 'parent') {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const sessionId = searchParams.get('session');
  const talkSession = sessionId ? db.getTalkSession(sessionId) : null;
  if (!talkSession || !db.canParentAccessChild(payload.id, talkSession.child_id) || talkSession.ended_at) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  listenWss.handleUpgrade(req, socket, head, (ws) => listenWss.emit('connection', ws, req));
});

// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// ERROR HANDLING — was missing entirely before this pass. Without this,
// any unhandled error in a route (a thrown exception, a rejected
// promise reaching Express's default handler) fell through to Express's
// default HTML error page, which can leak stack traces, and an
// oversized request body had no clean failure path. Ported from
// per_bot's own equivalent, adapted to this app's routes.
// ─────────────────────────────────────────────────────────────────────

// Anything under /api/ that didn't match a route above is a genuine
// "not found", not a page-serving fallback — keep it JSON rather than
// falling through to express.static's default 404 HTML.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That request was too large.' });
  }
  if (err) {
    console.error('Unhandled error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

db.getDb().then(() => {
  startCron();
  server.listen(PORT, () => console.log(`Mare app listening on :${PORT}`));
}).catch(e => {
  console.error('Failed to initialise database', e);
  process.exit(1);
});
