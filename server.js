const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');
const fetch      = require('node-fetch');
const cookieParser = require('cookie-parser');
const crypto       = require('crypto');

// ── Stripe ──
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;

const STRIPE_PLANS = {
  monthly:  { priceId: 'price_1ToG0XCxT0sk2KVUHercrrgp', tier: 1 },
  annual:   { priceId: 'price_1ToG7kCxT0sk2KVUdSeLuNk4', tier: 1 },
  lifetime: { priceId: 'price_1ToG7kCxT0sk2KVUMBQnPiZn', tier: 1 },
};
const db         = require('./db');
const auth       = require('./auth');
const prompts    = require('./prompts');
const { startCronJobs } = require('./cron');
const media      = require('./media');

// ── Config ──
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID           = process.env.VOICE_ID;
const DEEPGRAM_API_KEY   = process.env.DEEPGRAM_API_KEY;
const VOICE_SPEED        = parseFloat(process.env.VOICE_SPEED || '0.82');
const PORT               = process.env.PORT || 3000;
const BREVO_API_KEY      = process.env.BREVO_API_KEY;
const EMAIL_FROM         = process.env.EMAIL_FROM || 'per@deepermindfulness.org';
const APP_URL            = process.env.APP_URL || 'https://mirror-production-018d.up.railway.app';

// ── Express + HTTP server ──
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(cookieParser());
// NOTE: uploads are served exclusively via the auth-checked /uploads/:filename route below.
// (Previously this also had an unguarded express.static('/uploads') line ahead of that route,
// which meant any file could be fetched by anyone who knew or guessed the filename, regardless
// of tier — Express matches middleware in registration order, so the static middleware served
// the file before the auth check ever ran. Removed as part of the R2 migration security pass.)

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
async function sendEmail(to, subject, html) {
  if (!BREVO_API_KEY) { console.log('BREVO_API_KEY not set — skipping email to', to); return; }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Deeper Mindfulness', email: EMAIL_FROM },
        to: [{ email: to }], subject, htmlContent: html
      })
    });
    const data = await res.json().catch(() => {});
    if (!res.ok) console.error('Brevo error:', res.status, data);
    else console.log('Email sent to', to);
  } catch (e) { console.error('Email error:', e.message); }
}

function emailWelcomeFacilitator(name, email, tempPassword) {
  return sendEmail(email, 'Welcome to Deeper Mindfulness — your facilitator account',
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">Deeper Mindfulness</div>
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
      <div style="font-size:12px;color:#aaa">Deeper Mindfulness · Per Norrgren</div>
    </div>`
  );
}

function emailWelcomeClient(name, email, tempPassword) {
  return sendEmail(email, 'Welcome to Deeper Mindfulness',
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">Deeper Mindfulness</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Welcome, ${name}</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">Your account is ready.</p>
      <div style="background:#f5f5f0;border-radius:10px;padding:20px;margin-bottom:24px">
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Sign in at</div>
        <div style="font-size:15px;color:#1a1a1a;margin-bottom:16px"><a href="${APP_URL}" style="color:#2d6a4f">${APP_URL}</a></div>
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Email</div>
        <div style="font-size:15px;color:#1a1a1a;margin-bottom:16px">${email}</div>
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Temporary password</div>
        <div style="font-size:18px;font-family:monospace;color:#1a1a1a;letter-spacing:0.05em">${tempPassword}</div>
      </div>
      <p style="font-size:14px;line-height:1.7;color:#666">You will be asked to choose a new password when you sign in.</p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <div style="font-size:12px;color:#aaa">Deeper Mindfulness · Per Norrgren</div>
    </div>`
  );
}

// ── Trial email sequence (Per Bot 5, item 4) ──
// Day 3: what you've unlocked. Day 10: 4 days left. Day 14: trial ended.
function emailTrialDay3(user) {
  return sendEmail(user.email, 'Here\'s what you\'ve unlocked at Deeper Mindfulness',
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">Deeper Mindfulness</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${user.name},</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:20px">You're a few days into your trial. A quick look at what's already available to you:</p>
      <ul style="font-size:15px;line-height:1.9;color:#444;margin:0 0 24px;padding-left:20px">
        <li>The full content library — every guided practice, not just the free selection</li>
        <li>A daily message, if you've opted in — a short prompt to pause and notice</li>
        <li>Your own practice space, with history of what you've listened to</li>
      </ul>
      <p style="font-size:14px;line-height:1.7;color:#666;margin-bottom:24px">No pressure to do anything with this today. Just wanted you to know it's there.</p>
      <p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/client/" style="color:#2d6a4f">Visit your practice space →</a></p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">Deeper Mindfulness · Per Norrgren · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`
  );
}

function emailTrialDay10(user) {
  return sendEmail(user.email, 'Four days left on your trial',
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">Deeper Mindfulness</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${user.name},</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:20px">Your trial ends in four days. After that, your account moves to the free Explorer tier — you'll keep your history, but full access ends.</p>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">If it's been useful, you can continue anytime, no rush and no pressure either way.</p>
      <div style="background:#f5f5f0;border-radius:10px;padding:20px;margin-bottom:24px">
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Membership</div>
        <div style="font-size:15px;color:#1a1a1a">£5.99/month · £59/year · £100 one-off, lifetime</div>
      </div>
      <p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/membership" style="color:#2d6a4f">See membership options →</a></p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">Deeper Mindfulness · Per Norrgren · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`
  );
}

function emailTrialDay14(user) {
  return sendEmail(user.email, 'Your trial has ended',
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">Deeper Mindfulness</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${user.name},</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:20px">Your 14-day trial has come to an end. Your account is now on the free Explorer tier — your history and saved content are still there, and the free content is still available.</p>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">If you'd like full access back, you're welcome anytime.</p>
      <p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/membership" style="color:#2d6a4f">See membership options →</a></p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">Deeper Mindfulness · Per Norrgren · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`
  );
}

// ── Inactivity reminder (Per Bot 5, item 8) ──
function emailInactivityReminder(user) {
  return sendEmail(user.email, 'Whenever you\'re ready',
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">Deeper Mindfulness</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${user.name},</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">It's been a little while. No pressure at all — just wanted to leave the door open, in case a few minutes today would help.</p>
      <p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/client/" style="color:#2d6a4f">Visit your practice space →</a></p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">Deeper Mindfulness · Per Norrgren · <a href="${APP_URL}/account" style="color:#aaa">Manage email preferences</a></p>
    </div>`
  );
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

function emailFacilitatorRequestApproved(request) {
  return sendEmail(request.email, 'Your facilitator request has been approved',
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">Deeper Mindfulness</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${request.name},</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">Your request to become a facilitator has been approved. Your account now has facilitator access.</p>
      <p style="font-size:14px;line-height:1.7"><a href="${APP_URL}/facilitator/" style="color:#2d6a4f">Go to your facilitator dashboard →</a></p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">Deeper Mindfulness · Per Norrgren</p>
    </div>`
  );
}

function emailFacilitatorRequestDeclined(request) {
  return sendEmail(request.email, 'About your facilitator request',
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">Deeper Mindfulness</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${request.name},</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:20px">Thank you for your interest in facilitating. We're not able to move forward with this right now.</p>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">If you haven't yet spent time with the practice as a member yourself, that's usually the best next step — we'd genuinely welcome hearing from you again once you have.</p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">Deeper Mindfulness · Per Norrgren</p>
    </div>`
  );
}

function emailFacilitatorRequestDeferred(request) {
  return sendEmail(request.email, 'About your facilitator request',
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">Deeper Mindfulness</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Hello ${request.name},</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">Thank you for your request to become a facilitator. We need a little more time to consider it — no action needed from you, we'll follow up before too long.</p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <p style="font-size:12px;color:#aaa">Deeper Mindfulness · Per Norrgren</p>
    </div>`
  );
}


app.get('/login',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/register/',(req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/change-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'change-password.html')));
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
  const token = auth.createToken(user);
  res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
  if (user.mustChangePassword) return res.json({ redirect: '/change-password' });

  // Check if facilitator/admin also has a client record — show role chooser
  if (user.role === 'facilitator' || user.role === 'admin') {
    const userRecord = db.getUserByEmail(user.email.toLowerCase());
    if (userRecord) {
      return res.json({ chooseRole: true, name: user.name });
    }
  }

  const redirectMap = { admin: '/admin/', facilitator: '/facilitator/', client: '/client/' };
  res.json({ redirect: redirectMap[user.role] || '/login' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(auth.COOKIE_NAME);
  res.json({ ok: true });
});

// ── Self-registration ──
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!email.includes('@')) return res.status(400).json({ error: 'Please enter a valid email.' });

    const emailLower = email.toLowerCase().trim();

    const existingFac = db.getFacilitatorByEmail(emailLower);
    if (existingFac) return res.status(400).json({ error: 'An account with this email already exists.' });

    const existingUser = db.getUserByEmail(emailLower);
    if (existingUser) return res.status(400).json({ error: 'An account with this email already exists.' });

    const id   = uuidv4();
    const hash = await auth.hashPassword(password);
    db.registerUser(id, name.trim(), emailLower, hash);

    // If there's a pending invitation, link them to the facilitator
    const { inviteToken } = req.body;
    if (inviteToken) {
      const inv = db.getInvitationByToken(inviteToken);
      if (inv && !inv.accepted_at && new Date(inv.expires_at) > new Date() && inv.email === emailLower) {
        db.markAsClient(id, inv.facilitator_id);
        db.acceptInvitation(inviteToken, new Date().toISOString());
      }
    }

    // Log them in immediately
    const token = auth.createToken({ role: 'client', id, name: name.trim(), email: emailLower });
    res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
    res.json({ redirect: '/client/' });
  } catch(e) {
    console.error('register error:', e);
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
  const { name, email, action } = req.body;
  if (action === 'archive')   { db.archiveFacilitator(req.params.id); return res.json({ ok: true }); }
  if (action === 'unarchive') { db.unarchiveFacilitator(req.params.id); return res.json({ ok: true }); }
  if (action === 'reset_password') {
    const fac = db.getFacilitatorById(req.params.id);
    if (!fac) return res.status(404).json({ error: 'Not found.' });
    const tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
    const hash = await auth.hashPassword(tempPassword);
    db.updateFacilitatorPassword(req.params.id, hash);
    sendEmail(fac.email, 'Your Deeper Mindfulness password has been reset',
      `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px">
        <h1 style="font-size:22px;font-weight:normal">Password reset</h1>
        <p>Your temporary password: <strong style="font-family:monospace;font-size:18px">${tempPassword}</strong></p>
        <p><a href="${APP_URL}">${APP_URL}</a></p>
      </div>`
    );
    return res.json({ ok: true, tempPassword });
  }
  if (name && email) { db.updateFacilitatorDetails(req.params.id, name.trim(), email.trim()); return res.json({ ok: true }); }
  res.status(400).json({ error: 'Invalid request.' });
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

// ── Admin: Add Member ──
// Mirrors self-registration: same fields, same email-confirmation-with-password-change flow.
// GDPR: consent is recorded as given by the admin on the member's behalf at creation time,
// since this mirrors the same consent checkbox shown on self-registration.
app.post('/api/admin/members', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
    const emailLower = email.toLowerCase().trim();

    if (db.getFacilitatorByEmail(emailLower)) return res.status(400).json({ error: 'An account with this email already exists.' });
    if (db.getUserByEmail(emailLower))      return res.status(400).json({ error: 'An account with this email already exists.' });

    const id = uuidv4();
    const tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
    const passwordHash = await auth.hashPassword(tempPassword);

    db.createUser(id, name.trim(), null, emailLower, passwordHash, null, null, {
      consentGiven:    true,
      consentVersion:  'admin-added-v1',
      lawfulBasis:     'consent'
    });
    db.upgradeToMember(id, 'member');

    emailWelcomeClient(name.trim(), emailLower, tempPassword);
    res.json({ id, name: name.trim(), email: emailLower, tempPassword });
  } catch(e) {
    console.error('add member error:', e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
  if (email && tempPassword) emailWelcomeClient(name.trim(), email.trim(), tempPassword);
  res.json({ id, name: name.trim(), tempPassword });
});
app.get('/api/clients/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && user.facilitator_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  res.json({ ...user, sessions: db.getSessionsForClient(req.params.id), practices: db.getPracticesForClient(req.params.id) });
});
app.patch('/api/clients/:id/arc', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  db.updateArc(req.params.id, req.body.arc); res.json({ ok: true });
});
app.patch('/api/clients/:id/archive', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  db.archiveClient(req.params.id); res.json({ ok: true });
});
app.get('/api/my/profile', auth.requireAuthApi(['client']), (req, res) => {
  res.json({ ...db.getUser(req.user.id), sessions: db.getClientSessionsForClient(req.user.id), practices: db.getPracticesForClient(req.user.id) });
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
      300
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
  db.addPractice(uuidv4(), client_id, title, 'text', content, '');
  res.json({ ok: true });
});
app.post('/api/practices/audio', auth.requireAuthApi(['admin','facilitator']), upload.single('file'), (req, res) => {
  const { client_id, title } = req.body;
  if (!client_id || !title || !req.file) return res.status(400).json({ error: 'Missing fields.' });
  const id = uuidv4();
  db.addPractice(id, client_id, title, 'audio', '', req.file.filename);
  res.json({ id, filename: req.file.filename });
});
app.patch('/api/practices/:id/favourite', (req, res) => { db.toggleFavourite(req.params.id); res.json({ ok: true }); });
app.patch('/api/practices/:id/use',       (req, res) => { db.incrementUseCount(req.params.id); res.json({ ok: true }); });
app.delete('/api/practices/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  db.deletePractice(req.params.id); res.json({ ok: true });
});

// ── Claude ──
async function callClaude(systemPrompt, messages, maxTokens = 400) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: maxTokens, system: systemPrompt, messages }),
  });
  const data = await response.json();
  if (!data.content) throw new Error(JSON.stringify(data));
  return stripMarkdown(data.content[0].text);
}

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
    });
  }
  return chatSessions.get(sessionId);
}

app.post('/api/chat', auth.requireAuthApi(['client']), async (req, res) => {
  try {
    const { message, sessionId, clientId } = req.body;
    const session = getChatSession(sessionId, clientId || req.user.id);

    // Build system prompt once per session
    if (!session.systemPrompt) {
      let sp = prompts.CLIENT_SYSTEM_PROMPT;
      const cId = session.clientId;
      if (cId) {
        const client   = db.getUser(cId);
        const sessions = db.getSessionsForClient(cId);
        const arc      = client?.arc || '';
        if (arc || sessions.length > 0) sp += prompts.CLIENT_ARC_PREFIX(arc, sessions.length);
        // Adaptive context — programme/track awareness
        if (client?.programme || sessions.length > 0) {
          sp += prompts.CLIENT_ADAPTIVE_CONTEXT(client?.programme, client?.track, sessions.length);
        }
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

    const reply = await callClaude(session.systemPrompt, messages, 400);
    session.history.push({ role: 'assistant', content: reply });
    session.transcript.push(`BOT: ${reply}`);

    res.json({ reply });
  } catch(e) {
    console.error('chat error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/guest/lead — capture name + email, no auth ──
app.post('/api/guest/lead', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!email && !name) return res.json({ ok: true }); // both empty — skip silently
    db.addGuestLead(uuidv4(), name?.trim() || null, email?.trim()?.toLowerCase() || null, 'guest_page');
    res.json({ ok: true });
  } catch(e) {
    console.error('guest lead error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/guest/content — no auth. Was referenced by public/guest/index.html ──
// but never actually built, which is why guest browsing has been broken (Per
// Bot 5, item 10). A guest has no user record and no role, so we use the same
// flags an unregistered Explorer would have — level 0 ("registered" tier) —
// via userFlagsFromRecord(null, null). getAllLibraryFilesWithAccess tags every
// file with `accessible` rather than filtering, so locked (higher-tier) items
// still show up with the lock icon the guest page already renders for them —
// that's the existing frontend behaviour, this just supplies the data it expects.
app.get('/api/guest/content', (req, res) => {
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
  res.json(db.getGuestLeads());
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
app.patch('/api/clients/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const { name, email, facilitator_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required.' });
  db.updateClientDetails(req.params.id, name.trim(), email?.trim()||null, facilitator_id||null);
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
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required.' });

    const fac      = db.getFacilitatorById(req.user.id);
    if (!fac) return res.status(404).json({ error: 'Facilitator not found.' });

    const emailLower = email.toLowerCase().trim();
    const token      = crypto.randomBytes(32).toString('hex');
    const id         = uuidv4();
    const expiresAt  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    db.createInvitation(id, token, req.user.id, emailLower, expiresAt);

    const inviteUrl = `${APP_URL}/invite/${token}`;
    const existing  = db.getUserByEmail(emailLower);
    const isKnown   = !!existing;

    await sendEmail(emailLower,
      `${fac.name} has invited you to Deeper Mindfulness`,
      `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
        <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">Deeper Mindfulness</div>
        <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:16px">You've been invited</h1>
        <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">
          ${fac.name} has invited you to work together on Deeper Mindfulness — a body-based practice companion.
        </p>
        <a href="${inviteUrl}" style="display:inline-block;padding:14px 28px;background:#2d6a4f;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;letter-spacing:0.05em">
          ${isKnown ? 'Accept invitation' : 'Create your account'}
        </a>
        <p style="font-size:13px;color:#888;margin-top:24px;line-height:1.6">
          This invitation expires in 7 days. If you didn't expect this, you can ignore it.
        </p>
        <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
        <div style="font-size:12px;color:#aaa">Deeper Mindfulness · Per Norrgren</div>
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
    // Facilitators/admins previewing content should see everything regardless of tier,
    // but a logged-in Explorer/Member/Client only ever sees what their own tier permits —
    // getAllLibraryFilesWithAccess tags every file with `accessible`; we filter on it here
    // rather than relying on the frontend to respect that flag (it previously didn't).
    const files = req.user.role === 'facilitator' || req.user.role === 'admin'
      ? db.getAllLibraryFilesWithAccess(userFlags)
      : db.getAllLibraryFilesWithAccess(userFlags).filter(f => f.accessible);
    const favIds = new Set(db.getFavourites(req.user.id).map(f => f.id));
    res.json(files.map(f => ({ ...f, is_favourite: favIds.has(f.id) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Favourites
app.post('/api/client/favourites/:fileId', auth.requireAuthApi(['client']), (req, res) => {
  db.addFavourite(uuidv4(), req.user.id, req.params.fileId);
  res.json({ ok: true });
});
app.delete('/api/client/favourites/:fileId', auth.requireAuthApi(['client']), (req, res) => {
  db.removeFavourite(req.user.id, req.params.fileId);
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
  db.markAsClient(req.params.id, facilitatorId);
  res.json({ ok: true });
});

// ── Guest lead delete ──
app.delete('/api/admin/guest-leads/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteGuestLead(req.params.id);
  res.json({ ok: true });
});

// ── /api/guest/chat — no auth, same bot, lighter system prompt ──
const guestSessions = new Map();

app.post('/api/guest/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!guestSessions.has(sessionId)) {
      guestSessions.set(sessionId, { history: [], systemPrompt: prompts.CLIENT_SYSTEM_PROMPT });
    }
    const session = guestSessions.get(sessionId);
    const isStart = !message || message === 'begin';
    if (!isStart) session.history.push({ role: 'user', content: message });
    const messages = session.history.length ? session.history : [{ role: 'user', content: 'begin' }];
    const reply = await callClaude(session.systemPrompt, messages, 400);
    session.history.push({ role: 'assistant', content: reply });
    res.json({ reply });
  } catch(e) {
    console.error('guest chat error:', e);
    res.status(500).json({ error: e.message });
  }
});



app.get('/api/admin/users', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getAllUsersAdmin(false));
});

// ── /api/admin/users/:id/upgrade — upgrade to member tier ──
app.patch('/api/admin/users/:id/upgrade', auth.requireAuthApi(['admin']), (req, res) => {
  const { level, tier } = req.body;
  const memberTier = tier != null ? parseInt(tier) : (level === 'member' ? 1 : parseInt(level) || 1);
  db.setMemberTier(req.params.id, memberTier, null, null, null, null);
  res.json({ ok: true });
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

// ── /api/speak — ElevenLabs, piped directly (Mare Bot architecture) ──
app.post('/api/speak', async (req, res) => { // public — used by guest and client
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'No text' });
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.65, similarity_boost: 0.80, speed: VOICE_SPEED }
      })
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

// ── /listen — Deepgram STT proxy (Mare Bot architecture) ──
const listenWss = new WebSocket.Server({ server, path: '/listen' });

listenWss.on('connection', (clientWs) => {
  const dgWs = new WebSocket(
    'wss://api.deepgram.com/v1/listen?model=nova-2&language=multi&encoding=linear16&sample_rate=16000&channels=1&smart_format=true&endpointing=400&utterance_end_ms=1200&interim_results=true',
    { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
  );
  dgWs.on('open',    () => console.log('Deepgram connected'));
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

const facilitatorWss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname !== '/' || searchParams.get('type') !== 'facilitator') return; // not our route — let ws's own /listen handler take it

  const cookies = parseCookies(req.headers.cookie);
  const payload = auth.verifyToken(cookies[auth.COOKIE_NAME]);
  if (!payload || !['facilitator', 'admin'].includes(payload.role)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
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
  const { facilitatorId, client } = ctx;
  let fogLevel = 12;
  let history = []; // { role: 'user'|'assistant', content: string } — this facilitator's own conversation, not the client's

  // Deepgram connection for this facilitator's voice input — opened lazily on start_listening
  let dgWs = null;

  function send(obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  async function respond(userText, { explain = false } = {}) {
    try {
      const systemPrompt = prompts.FACILITATOR_SYSTEM_PROMPT(fogLevel);
      const promptText = explain
        ? `Explain to me: ${userText || 'what is happening clinically right now, based on what I have described so far.'}`
        : userText;
      history.push({ role: 'user', content: promptText });
      const reply = await callClaude(systemPrompt, history, 500);
      history.push({ role: 'assistant', content: reply });
      send({ type: explain ? 'explanation' : 'response_text', text: reply });

      // Voice playback for the facilitator, same TTS pipeline as the client uses
      try {
        const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY },
          body: JSON.stringify({
            text: reply,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.65, similarity_boost: 0.80, speed: VOICE_SPEED }
          })
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
        dgWs = new WebSocket(
          'wss://api.deepgram.com/v1/listen?model=nova-2&language=multi&encoding=opus&sample_rate=48000&channels=1&smart_format=true&endpointing=400&utterance_end_ms=1200&interim_results=false',
          { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
        );
        dgWs.on('message', async (data) => {
          try {
            const parsed = JSON.parse(data.toString('utf8'));
            const transcript = parsed?.channel?.alternatives?.[0]?.transcript;
            if (transcript && transcript.trim() && parsed.speech_final) {
              send({ type: 'final_transcript', text: transcript });
              await respond(transcript, { explain: false });
            }
          } catch { /* non-JSON or partial frame — ignore */ }
        });
        dgWs.on('error', (e) => console.error('facilitator deepgram error:', e.message));
        break;
      }

      case 'audio_chunk':
        if (dgWs && dgWs.readyState === WebSocket.OPEN && msg.data) {
          dgWs.send(Buffer.from(msg.data, 'base64'));
        }
        break;

      case 'stop_listening':
        send({ type: 'listening_stopped' });
        if (dgWs) { try { dgWs.close(); } catch {} dgWs = null; }
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
            500
          );

          const clientSummary = await callClaude(
            'You are rewriting a clinical summary into a short, warm note for the client to read themselves.',
            [{ role: 'user', content: prompts.GENERATE_CLIENT_SUMMARY(clinicalSummary) }],
            300
          );

          const arcUpdate = await callClaude(
            'You are updating a clinical arc/development plan based on session notes.',
            [{ role: 'user', content: prompts.GENERATE_ARC_UPDATE(client.arc, clinicalSummary) }],
            300
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

app.get('/api/content/library', auth.requireAuthApi(['admin','facilitator']), (req, res) => res.json(db.getLibraryFiles(req.query)));

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

// ── R2 upload — Step 2: browser has finished uploading directly to R2; save the metadata row. ──
app.post('/api/content/library', auth.requireAuthApi(['admin']), upload.single('file'), (req, res) => {
  try {
    const { title, categoryId, subcategoryId, visibility } = req.body;
    if (!title || !categoryId) return res.status(400).json({ error: 'Missing required fields.' });
    const facilitatorResource = req.body.facilitatorResource === 'true' || req.body.facilitatorResource === true;

    // Path A — R2 upload already completed client-side; just save the reference.
    if (req.body.r2Key) {
      const id = uuidv4();
      db.addLibraryFile(
        id, title.trim(), req.body.description || '', req.body.r2Key, req.body.originalName || req.body.r2Key,
        req.body.contentType || 'application/octet-stream', parseInt(req.body.fileSize) || 0,
        categoryId, subcategoryId || null, visibility || 'client', 'r2', facilitatorResource
      );
      return res.json({ id });
    }

    // Path B — legacy direct-to-disk upload, kept for now so nothing breaks mid-migration.
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });
    const id = uuidv4();
    db.addLibraryFile(id, title.trim(), req.body.description || '', req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, categoryId, subcategoryId || null, visibility || 'client', 'disk', facilitatorResource);
    res.json({ id });
  } catch (e) {
    console.error('library upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Playback URL — checked against the SAME tier-gating logic as the Content tab listing. ──
// Only generates a (short-lived, signed) R2 URL after access is confirmed. Legacy disk files
// fall back to the existing /uploads/:filename route, unaffected by this migration.
app.get('/api/content/library/:id/playback-url', auth.requireAuthApi(['client','facilitator','admin']), async (req, res) => {
  try {
    const file = db.getLibraryFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found.' });

    const userRec = req.user.role === 'client' ? db.getUser(req.user.id) : null;
    const userFlags = db.userFlagsFromRecord(userRec, req.user.role);
    // Facilitators/admins can preview/play any file regardless of tier; an Explorer/
    // Member/Client only ever gets a URL for what their own tier actually permits.
    const allowed = (req.user.role === 'facilitator' || req.user.role === 'admin')
      ? !file.archived
      : db.canAccessFile(file, userFlags);
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });

    if (file.storage_type === 'r2') {
      const url = await media.getPlaybackUrl(file.filename);
      return res.json({ url, expiresIn: 600 });
    }
    // Legacy disk file — same URL pattern as before, no change in behaviour.
    res.json({ url: `/uploads/${file.filename}`, expiresIn: null });
  } catch (e) {
    console.error('playback-url error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/content/library/:id', auth.requireAuthApi(['admin']), (req, res) => { db.updateLibraryFile(req.params.id, req.body); res.json({ ok: true }); });
app.get('/api/content/library/:id/usage', auth.requireAuthApi(['admin']), (req, res) => res.json(db.getFileUsage(req.params.id)));
app.patch('/api/content/library/:id/rename', auth.requireAuthApi(['admin']), (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename required.' });
  const file = db.getLibraryFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found.' });
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
  const { title, description, categoryId, subcategoryId, lessons } = req.body;
  if (!title || !categoryId) return res.status(400).json({ error: 'Title and category required.' });
  const courseId = uuidv4();
  db.createCourse(courseId, title, description, categoryId, subcategoryId, false);
  if (lessons?.length) lessons.forEach(l => db.createLesson(uuidv4(), courseId, l.number, l.title, l.description || '', l.visibility || 'client'));
  res.json({ id: courseId });
});
app.get('/api/content/courses/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const c = db.getCourse(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});
app.delete('/api/content/courses/:id', auth.requireAuthApi(['admin']), (req, res) => { db.deleteCourse(req.params.id); res.json({ ok: true }); });

app.get('/api/content/courses/:id/lessons', auth.requireAuthApi(['admin','facilitator']), (req, res) => res.json(db.getLessonsForCourse(req.params.id)));
app.post('/api/content/lessons', auth.requireAuthApi(['admin']), (req, res) => {
  const { courseId, lessonNumber, title, visibility, fileIds } = req.body;
  if (!courseId || !lessonNumber || !title) return res.status(400).json({ error: 'Missing fields.' });
  const lessonId = uuidv4();
  db.createLesson(lessonId, courseId, parseInt(lessonNumber), title, '', visibility || 'client');
  if (fileIds?.length) fileIds.forEach((fid, i) => db.addLessonFileRef(uuidv4(), lessonId, fid, i));
  res.json({ id: lessonId });
});
app.get('/api/content/lessons/:id/files', auth.requireAuthApi(['admin','facilitator']), (req, res) => res.json(db.getFilesForLesson(req.params.id)));
app.delete('/api/content/lessons/:id', auth.requireAuthApi(['admin']), (req, res) => { db.deleteLesson(req.params.id); res.json({ ok: true }); });

app.post('/api/content/lesson-file-refs', auth.requireAuthApi(['admin']), (req, res) => {
  const { lessonId, fileId } = req.body;
  if (!lessonId || !fileId) return res.status(400).json({ error: 'Missing fields.' });
  db.addLessonFileRef(uuidv4(), lessonId, fileId, db.getFilesForLesson(lessonId).length);
  res.json({ ok: true });
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

app.get('/uploads/:filename', (req, res) => {
  const token = req.cookies?.[auth.COOKIE_NAME];
  const user  = token ? auth.verifyToken(token) : null;
  if (!user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'uploads', req.params.filename));
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
app.get('/api/account', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const user = db.getUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found.' });
    // Don't send password hash to the client
    const { password_hash, ...safe } = user;
    res.json(safe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update communication preferences and profile fields
app.patch('/api/account', auth.requireAuthApi(['client']), (req, res) => {
  try {
    const allowed = ['pref_email_motd','pref_email_reminders','pref_email_renewal','pref_email_news','pref_sms','phone','language'];
    const prefs = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) prefs[k] = req.body[k]; });
    if (Object.keys(prefs).length) db.updateUserPreferences(req.user.id, prefs);
    // Name update
    if (req.body.name && req.body.name.trim()) {
      db.updateClientDetails(req.user.id, req.body.name.trim(), null, null);
    }
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
app.patch('/api/admin/membership/plans/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    db.updateMembershipPlan(req.params.id, req.body);
    res.json({ ok: true });
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

// ── Legal document public pages ──
app.get('/legal', (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal.html')));
app.get('/legal/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal.html')));
app.get('/legal/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal.html')));

// ── Legal document API — public ──
app.get('/api/legal', (req, res) => {
  try { res.json(db.getAllCurrentLegalDocuments()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/legal/:slug', (req, res) => {
  try {
    const doc = req.query.version
      ? db.getLegalDocumentVersion(req.params.slug, parseInt(req.query.version))
      : db.getLegalDocument(req.params.slug);
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
    const { slug, title, content, requiresConsent } = req.body;
    if (!slug || !title || !content) return res.status(400).json({ error: 'slug, title, and content required.' });
    const id      = uuidv4();
    const version = db.createLegalDocument(id, slug.toLowerCase().replace(/\s+/g,'-'), title, content, requiresConsent);
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

// ── Membership page ──
app.get('/membership',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'membership.html')));
// Public — works logged in (auto-fills from /api/account) or anonymous, since
// it's meant to be linkable from outside the app (Per Bot 5, item 11).
app.get('/become-a-facilitator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'become-a-facilitator.html')));
app.get('/become-a-facilitator/', (req, res) => res.redirect('/become-a-facilitator'));
app.get('/membership/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'membership.html')));

// ── Stripe: create Checkout Session ──
app.post('/api/membership/checkout', auth.requireAuthApi(['client']), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payment system not configured yet.' });
  try {
    const { priceId, billing } = req.body;
    if (!priceId) return res.status(400).json({ error: 'priceId required.' });

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
      metadata:             { user_id: user.id, billing, tier: '1' },
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

// ── Stripe: webhook ──
// Must use raw body — express.json() must NOT have parsed this request
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
        const tier    = parseInt(session.metadata?.tier || '1');
        const billing = session.metadata?.billing;
        if (!userId) break;

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

        // Send welcome email
        const user = db.getUser(userId);
        if (user?.email) {
          await sendEmail(user.email,
            'Welcome to Deeper Mindfulness — you\'re a Member',
            `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
              <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:24px">Deeper Mindfulness</div>
              <h2 style="font-weight:normal;font-size:22px;margin-bottom:16px">You're in, ${user.name}.</h2>
              <p style="font-size:15px;line-height:1.8;margin-bottom:20px">Your membership is active. The full practice library is open, and your daily message from Per starts tomorrow morning.</p>
              <a href="${APP_URL}/client/" style="display:inline-block;padding:12px 28px;border-radius:8px;background:#2d7873;color:#fff;text-decoration:none;font-size:13px;letter-spacing:0.08em">Go to your practice space</a>
              <hr style="border:none;border-top:1px solid #e8e8e8;margin:32px 0"/>
              <p style="font-size:12px;color:#aaa">Making the practices land and last for life. · <a href="${APP_URL}/account" style="color:#888">Manage my account</a></p>
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
        const user = db.queryAll ? null : null; // use raw query below
        const users = db.getDb ? null : null;
        // Find user by stripe_subscription_id
        const found = db.queryAll
          ? null
          : null;
        // Use direct DB query via exported function
        const userRec = db.getUserByStripeSubscription ? db.getUserByStripeSubscription(subId) : null;
        if (userRec) {
          const d = new Date(); d.setMonth(d.getMonth() + 1);
          db.setMemberTier(userRec.id, userRec.member_tier || 1, d.toISOString(), null, null, null);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        // Subscription cancelled — drop to Explorer
        const sub    = event.data.object;
        const custId = sub.customer;
        // Find user by stripe_customer_id
        const userRec = db.getUserByStripeCustomer ? db.getUserByStripeCustomer(custId) : null;
        if (userRec) {
          db.downgradeToExplorer(userRec.id);
          const user = db.getUser(userRec.id);
          if (user?.email) {
            await sendEmail(user.email,
              'Your Deeper Mindfulness membership has ended',
              `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
                <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:24px">Deeper Mindfulness</div>
                <p style="font-size:15px;line-height:1.8;margin-bottom:20px">Your membership has ended. You can continue exploring as a free member, or <a href="${APP_URL}/membership" style="color:#2d7873">rejoin at any time</a>.</p>
                <p style="font-size:12px;color:#aaa">Making the practices land and last for life.</p>
              </div>`
            );
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const custId  = invoice.customer;
        const userRec = db.getUserByStripeCustomer ? db.getUserByStripeCustomer(custId) : null;
        if (userRec?.email) {
          await sendEmail(userRec.email,
            'Payment issue with your Deeper Mindfulness membership',
            `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
              <p style="font-size:15px;line-height:1.8;margin-bottom:20px">We couldn't process your membership payment. Please update your payment details to keep your access.</p>
              <a href="https://billing.stripe.com/p/login/test_00g" style="display:inline-block;padding:12px 28px;border-radius:8px;background:#2d7873;color:#fff;text-decoration:none;font-size:13px">Update payment details</a>
            </div>`
          );
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

// ── Message of the day — admin ──
app.get('/api/admin/motd', auth.requireAuthApi(['admin']), (req, res) => {
  try {
    const { status } = req.query;
    const messages = db.getAllMotd(status || null);
    const approvedCount = db.countApprovedMotd();
    res.json({ messages, approvedCount, lowStock: approvedCount <= 5 });
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
app.post('/api/admin/motd/generate', auth.requireAuthApi(['admin']), async (req, res) => {
  try {
    let count = parseInt(req.body?.count, 10);
    if (!Number.isFinite(count) || count < 1) count = 12;
    count = Math.min(count, 30); // guardrail — one click shouldn't be able to flood the queue

    const userMessage = `Write ${count} new Message of the Day drafts. Cover as wide a spread of the signal range as you can across these ${count} messages — don't repeat the same signal more than necessary given the count. Respond with only the JSON array, nothing else.`;

    const raw = await callClaude(prompts.MOTD_GENERATION_PROMPT, [{ role: 'user', content: userMessage }], 4000);

    let generated;
    try {
      generated = JSON.parse(raw);
    } catch {
      // Claude occasionally wraps the array in a fence despite instructions — strip and retry once.
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      generated = JSON.parse(cleaned);
    }
    if (!Array.isArray(generated) || !generated.length) throw new Error('Model did not return a usable list of messages.');

    const ids = generated
      .filter(msg => typeof msg === 'string' && msg.trim())
      .map(msg => {
        const id = uuidv4();
        db.addMotd(id, msg.trim(), null);
        return id;
      });

    res.json({ ok: true, count: ids.length });
  } catch(e) {
    console.error('motd generate error:', e);
    res.status(500).json({ error: 'Could not generate messages. Please try again.' });
  }
});

function maybeSendMotdLowStockAlert(remaining) {
  if (remaining > 5) return;
  sendEmail(process.env.ADMIN_EMAIL || 'per@deepermindfulness.org',
    `⚠️ Message of the day — only ${remaining} approved message${remaining === 1 ? '' : 's'} remaining`,
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px">
      <h2 style="font-weight:normal">Message queue running low</h2>
      <p>There ${remaining === 1 ? 'is' : 'are'} only <strong>${remaining}</strong> approved message${remaining === 1 ? '' : 's'} of the day left in the queue.</p>
      <p>Please add and approve more at <a href="${APP_URL}/admin/">${APP_URL}/admin/</a></p>
      <hr/><p style="font-size:12px;color:#aaa">Deeper Mindfulness · Per Bot</p>
    </div>`
  );
}

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

// ── MOTD — bulk approve ──
// Approves every id in the list, then checks stock ONCE at the end — not once
// per item, which would otherwise fire the low-stock alert email repeatedly
// while working through a big batch of drafts.
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

app.delete('/api/admin/motd/:id', auth.requireAuthApi(['admin']), (req, res) => {
  try { db.deleteMotd(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MOTD send — the actual send logic, callable directly (cron) or via the ──
// admin endpoint below (manual trigger / testing). Kept as one function so
// there's exactly one place this logic lives.
async function sendDailyMotd() {
  const motd = db.getNextMotdToSend();
  if (!motd) return { ok: true, sent: 0, note: 'No approved messages in queue.' };

  const recipients = db.getMotdRecipients();
  if (!recipients.length) {
    db.markMotdSent(motd.id);
    return { ok: true, sent: 0, note: 'No recipients opted in.' };
  }

  // Send to each recipient individually so we can personalise the greeting
  let sent = 0;
  for (const user of recipients) {
    await sendEmail(user.email,
      'From Deeper Mindfulness — a moment for today',
      `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
        <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:24px">Deeper Mindfulness</div>
        <p style="font-size:17px;line-height:1.8;color:#1a1a1a;margin-bottom:32px">${motd.body.replace(/\n/g, '<br/>')}</p>
        <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
        <p style="font-size:12px;color:#aaa">
          You're receiving this because you're a member of Deeper Mindfulness.
          <a href="${APP_URL}/client/" style="color:#2d6a4f">Visit your practice space</a> ·
          <a href="${APP_URL}/account" style="color:#888">Manage preferences</a>
        </p>
      </div>`
    );
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
  if (!db.getFacilitatorByEmail(adminEmail)) {
    const hash = await auth.hashPassword(adminPass);
    db.createFacilitator(uuidv4(), 'Per Norrgren', adminEmail, hash, 'admin');
    console.log(`Admin created: ${adminEmail}`);
  }
  startCronJobs({ db, sendDailyMotd, emailTrialDay3, emailTrialDay10, emailTrialDay14, emailInactivityReminder });
  server.listen(PORT, () => console.log(`Per Bot running on port ${PORT}`));
})();
