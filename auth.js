const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const db        = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const COOKIE_NAME = 'perbot_session';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 24 * 60 * 60 * 1000 // 24 hours
};

// ── Guest identity ── Separate, lightweight cookie proving a site visitor
// has actually given a name and email before browsing content or talking to
// the bot — Per doesn't want anonymous browsing-only access. Distinct from
// COOKIE_NAME/perbot_session on purpose: a guest is not a user record and
// has no role, so mixing it into the real session cookie would blur that
// line. 30-day expiry, longer than a real login session, since someone
// exploring over several visits shouldn't have to re-identify every day.
const GUEST_COOKIE_NAME = 'perbot_guest';
const GUEST_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000
};

// ── Active-session tracking (Per Bot 22) ──
// "Who's actually using the app right now" for the admin People page.
// In-memory only, on purpose — same convention as the Tomte active-tab
// counter in server.js: ephemeral presence data, not meant to survive a
// restart or be written to the database. A Map write on every
// authenticated request costs nothing next to the disk-backed sql.js
// writes elsewhere in this app, so no throttling needed here unlike a
// real DB column would need.
const activeSessions = new Map(); // `${role}:${id}` -> lastSeenTimestamp
const ACTIVE_SESSION_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function touchActiveSession(role, id) {
  if (!role || !id) return;
  activeSessions.set(`${role}:${id}`, Date.now());
}

// Prunes anything outside the window, then returns the ids still active
// for a given role — 'client' is what the People page cares about, but
// this stays role-generic in case facilitator/admin presence is ever
// wanted too.
function getActiveIdsForRole(role) {
  const cutoff = Date.now() - ACTIVE_SESSION_WINDOW_MS;
  const ids = [];
  for (const [key, ts] of activeSessions) {
    if (ts < cutoff) { activeSessions.delete(key); continue; }
    const sep = key.indexOf(':');
    if (key.slice(0, sep) === role) ids.push(key.slice(sep + 1));
  }
  return ids;
}

// ── Hash and verify passwords ──
async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// ── Create JWT ──
function createToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Guests get a longer-lived, dedicated token — not signed via createToken()
// above since that hardcodes a 24h expiry meant for real logins.
function createGuestToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

// ── Middleware: require a guest to have identified themselves ──
// Used on guest content/chat endpoints. A missing or invalid token means
// they haven't submitted the name+email form yet — respond with a specific
// error code the frontend checks for, so it can show the identify form
// instead of a generic broken-page error.
function requireGuestIdentity() {
  return (req, res, next) => {
    const token = req.cookies?.[GUEST_COOKIE_NAME];
    if (!token) return res.status(403).json({ error: 'not_identified' });

    const payload = verifyToken(token);
    if (!payload || payload.type !== 'guest') return res.status(403).json({ error: 'not_identified' });

    req.guest = payload;
    next();
  };
}

// ── Login: find user across all roles ──
async function login(email, password) {
  const emailLower = email.toLowerCase().trim();

  // Check admin first
  const admin = db.getFacilitatorByEmail(emailLower);
  if (admin && admin.role === 'admin') {
    const valid = await verifyPassword(password, admin.password_hash);
    if (valid) return { role: 'admin', id: admin.id, name: admin.name, email: admin.email };
  }

  // Check facilitator
  const facilitator = db.getFacilitatorByEmail(emailLower);
  if (facilitator) {
    const valid = await verifyPassword(password, facilitator.password_hash);
    if (valid) return { role: facilitator.role, id: facilitator.id, name: facilitator.name, email: facilitator.email, mustChangePassword: facilitator.must_change_password };
  }

  // Check users table (Explorer / Member / Client)
  const user = db.getUserByEmail(emailLower);
  if (user) {
    const valid = await verifyPassword(password, user.password_hash);
    if (valid) {
      db.checkTrialExpiry(user.id); // drops to Explorer if trial lapsed with no active subscription
      return { role: 'client', id: user.id, name: user.name, email: user.email, mustChangePassword: user.must_change_password };
    }
  }

  return null;
}

// ── Middleware: require auth ──
function requireAuth(roles = []) {
  return (req, res, next) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.redirect('/login');

    const payload = verifyToken(token);
    if (!payload) return res.redirect('/login');

    if (roles.length && !roles.includes(payload.role)) {
      return res.status(403).send('Access denied');
    }

    req.user = payload;
    touchActiveSession(payload.role, payload.id);
    next();
  };
}

// ── Middleware: require auth for API ──
function requireAuthApi(roles = []) {
  return (req, res, next) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'Invalid session' });

    if (roles.length && !roles.includes(payload.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    req.user = payload;
    touchActiveSession(payload.role, payload.id);
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  login,
  requireAuth,
  requireAuthApi,
  COOKIE_NAME,
  COOKIE_OPTIONS,
  createGuestToken,
  requireGuestIdentity,
  GUEST_COOKIE_NAME,
  GUEST_COOKIE_OPTIONS,
  getActiveIdsForRole,
};
