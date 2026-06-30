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
    if (valid) return { role: 'client', id: user.id, name: user.name, email: user.email, mustChangePassword: user.must_change_password };
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
};
