const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');
const fetch      = require('node-fetch');
const cookieParser = require('cookie-parser');
const db         = require('./db');
const auth       = require('./auth');
const prompts    = require('./prompts');

// ── Email via Brevo ──
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_FROM    = process.env.EMAIL_FROM || 'per@deepermindfulness.org';
const APP_URL       = process.env.APP_URL || 'https://mirror-production-018d.up.railway.app';

async function sendEmail(to, subject, html) {
  if (!BREVO_API_KEY) { console.log('BREVO_API_KEY not set — skipping email to', to); return; }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'Deeper Mindfulness', email: EMAIL_FROM },
        to: [{ email: to }],
        subject,
        htmlContent: html
      })
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) {
      console.error('Brevo error:', res.status, JSON.stringify(data));
    } else {
      console.log('Email sent to', to, '— messageId:', data.messageId);
    }
  } catch (e) { console.error('Email error:', e.message); }
}

function emailWelcomeFacilitator(name, email, tempPassword) {
  return sendEmail(email, 'Welcome to Deeper Mindfulness — your facilitator account',
    `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">Deeper Mindfulness</div>
      <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Welcome, ${name}</h1>
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">Your facilitator account has been created. You can sign in using the details below.</p>
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
      <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">Your account is ready. Sign in to access your practices and connect with your guide.</p>
      <div style="background:#f5f5f0;border-radius:10px;padding:20px;margin-bottom:24px">
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Sign in at</div>
        <div style="font-size:15px;color:#1a1a1a;margin-bottom:16px"><a href="${APP_URL}" style="color:#2d6a4f">${APP_URL}</a></div>
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Email</div>
        <div style="font-size:15px;color:#1a1a1a;margin-bottom:16px">${email}</div>
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Temporary password</div>
        <div style="font-size:18px;font-family:monospace;color:#1a1a1a;letter-spacing:0.05em">${tempPassword}</div>
      </div>
      <p style="font-size:14px;line-height:1.7;color:#666">You will be asked to choose a new password when you first sign in.</p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
      <div style="font-size:12px;color:#aaa">Deeper Mindfulness · Per Norrgren</div>
    </div>`
  );
}

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID           = process.env.VOICE_ID;
const DEEPGRAM_API_KEY   = process.env.DEEPGRAM_API_KEY;
const VOICE_SPEED        = parseFloat(process.env.VOICE_SPEED || '0.82');
const PORT               = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── File upload ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => { cb(null, uuidv4() + path.extname(file.originalname)); }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── Strip markdown ──
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

// ── Page routes ──
app.get('/login',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/change-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'change-password.html')));
app.get('/',                (req, res) => res.redirect('/login'));

// ── Role-aware page routing ──
function roleRouter(allowedRoles, file) {
  return (req, res) => {
    const token = req.cookies?.[auth.COOKIE_NAME];
    const user  = token ? auth.verifyToken(token) : null;
    if (!user) return res.redirect('/login');
    if (!allowedRoles.includes(user.role)) {
      // Redirect to correct interface
      const map = { admin: '/admin/', facilitator: '/facilitator/', client: '/client/' };
      return res.redirect(map[user.role] || '/login');
    }
    res.sendFile(path.join(__dirname, file));
  };
}

app.get('/admin',    roleRouter(['admin'], 'public/admin/index.html'));
app.get('/admin/',   roleRouter(['admin'], 'public/admin/index.html'));

app.get('/facilitator',  roleRouter(['admin','facilitator'], 'public/facilitator/index.html'));
app.get('/facilitator/', roleRouter(['admin','facilitator'], 'public/facilitator/index.html'));

app.get('/client',  roleRouter(['client'], 'public/client/index.html'));
app.get('/client/', roleRouter(['client'], 'public/client/index.html'));

// ── Auth API ──
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ error: 'Email and password required.' });

  const user = await auth.login(email, password);
  if (!user) return res.json({ error: 'Email or password not recognised.' });

  const token = auth.createToken(user);
  res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);

  if (user.mustChangePassword) return res.json({ redirect: '/change-password' });

  const redirectMap = { admin: '/admin/', facilitator: '/facilitator/', client: '/client/' };
  res.json({ redirect: redirectMap[user.role] || '/login' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(auth.COOKIE_NAME);
  res.json({ ok: true });
});

app.post('/api/change-password', auth.requireAuthApi(), async (req, res) => {
  const { password, currentPassword } = req.body;
  if (!password || password.length < 8) return res.json({ error: 'Password must be at least 8 characters.' });

  const user = req.user;

  // If current password provided, verify it first (in-app change)
  if (currentPassword) {
    let record;
    if (user.role === 'client') {
      record = db.getClient(user.id);
    } else {
      record = db.getFacilitatorById(user.id);
    }
    const valid = record ? await auth.verifyPassword(currentPassword, record.password_hash) : false;
    if (!valid) return res.json({ error: 'Current password is incorrect.' });
  }

  const hash = await auth.hashPassword(password);

  if (user.role === 'client') {
    db.updateClientPassword(user.id, hash);
  } else {
    db.updateFacilitatorPassword(user.id, hash);
  }

  // First-time change via change-password page — redirect
  if (!currentPassword) {
    const redirectMap = { admin: '/admin/', facilitator: '/facilitator/', client: '/client/' };
    return res.json({ redirect: redirectMap[user.role] || '/login' });
  }

  res.json({ ok: true });
});

// ── Admin API ──
app.get('/api/admin/facilitators', auth.requireAuthApi(['admin']), (req, res) => {
  const includeArchived = req.query.archived === '1';
  res.json(db.getAllFacilitators(includeArchived));
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
    // Mark as must change password again
    db.getDb().then(() => {
      try { db.save && db.save(); } catch {}
    });
    // Send reset email
    sendEmail(fac.email, 'Your Deeper Mindfulness password has been reset',
      `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px;color:#2a2a2a">
        <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#888;margin-bottom:8px">Deeper Mindfulness</div>
        <h1 style="font-size:22px;font-weight:normal;color:#1a1a1a;margin-bottom:24px">Password reset</h1>
        <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">Your password has been reset by the administrator. Use the temporary password below to sign in.</p>
        <div style="background:#f5f5f0;border-radius:10px;padding:20px;margin-bottom:24px">
          <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Sign in at</div>
          <div style="font-size:15px;color:#1a1a1a;margin-bottom:16px"><a href="${APP_URL}" style="color:#2d6a4f">${APP_URL}</a></div>
          <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px">Temporary password</div>
          <div style="font-size:20px;font-family:monospace;color:#1a1a1a;letter-spacing:0.06em">${tempPassword}</div>
        </div>
        <p style="font-size:14px;line-height:1.7;color:#666">You will be asked to set a new password when you sign in.</p>
        <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0"/>
        <div style="font-size:12px;color:#aaa">Deeper Mindfulness · Per Norrgren</div>
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

  const existing = db.getFacilitatorByEmail(email);
  if (existing) return res.status(400).json({ error: 'Email already in use.' });

  const tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
  const hash = await auth.hashPassword(tempPassword);
  const id   = uuidv4();
  db.createFacilitator(id, name.trim(), email.trim(), hash, 'facilitator');
  emailWelcomeFacilitator(name.trim(), email.trim(), tempPassword);
  res.json({ id, name, tempPassword });
});

app.delete('/api/admin/facilitators/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteFacilitator(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/clients', auth.requireAuthApi(['admin']), (req, res) => {
  const includeArchived = req.query.archived === '1';
  res.json(db.getAllClientsAdmin(includeArchived));
});

// ── Clients API ──
app.get('/api/clients', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const facilitatorId = req.user.role === 'admin' ? req.query.facilitator_id : req.user.id;
  if (!facilitatorId) return res.json([]);
  const includeArchived = req.query.archived === '1';
  res.json(db.getAllClients(facilitatorId, includeArchived));
});

app.post('/api/clients', auth.requireAuthApi(['admin','facilitator']), async (req, res) => {
  const { name, email, categoryId, subcategoryId } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required.' });

  const facilitatorId = req.user.role === 'admin' ? req.body.facilitator_id : req.user.id;
  const id = uuidv4();
  let passwordHash = null;
  let tempPassword = null;

  if (email) {
    tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2,4).toUpperCase();
    passwordHash = await auth.hashPassword(tempPassword);
  }

  db.createClient(id, name.trim(), facilitatorId, email?.trim() || null, passwordHash, categoryId || null, subcategoryId || null);
  if (email && tempPassword) emailWelcomeClient(name.trim(), email.trim(), tempPassword);
  res.json({ id, name: name.trim(), tempPassword });
});

app.get('/api/clients/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const client = db.getClient(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && client.facilitator_id !== req.user.id)
    return res.status(403).json({ error: 'Access denied' });
  const sessions  = db.getSessionsForClient(req.params.id);
  const practices = db.getPracticesForClient(req.params.id);
  res.json({ ...client, sessions, practices });
});

app.patch('/api/clients/:id/arc', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  db.updateArc(req.params.id, req.body.arc);
  res.json({ ok: true });
});

app.patch('/api/clients/:id/archive', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  db.archiveClient(req.params.id);
  res.json({ ok: true });
});

// Client self-view
app.get('/api/my/profile', auth.requireAuthApi(['client']), (req, res) => {
  const client    = db.getClient(req.user.id);
  const sessions  = db.getClientSessionsForClient(req.user.id);
  const practices = db.getPracticesForClient(req.user.id);
  res.json({ ...client, sessions, practices });
});

// ── Sessions API ──
app.post('/api/sessions', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const { client_id, type, summary, client_summary } = req.body;
  const id = uuidv4();
  db.addSession(id, client_id, req.user.id, type, summary, client_summary || '');
  res.json({ id });
});

// ── Practices API ──
app.get('/api/clients/:id/practices', auth.requireAuthApi(['admin','facilitator','client']), (req, res) => {
  const clientId = req.user.role === 'client' ? req.user.id : req.params.id;
  res.json(db.getPracticesForClient(clientId));
});

app.post('/api/practices/text', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const { client_id, title, content } = req.body;
  if (!client_id || !title) return res.status(400).json({ error: 'client_id and title required.' });
  const id = uuidv4();
  db.addPractice(id, client_id, title, 'text', content, '');
  res.json({ id });
});

app.post('/api/practices/audio', auth.requireAuthApi(['admin','facilitator']), upload.single('file'), (req, res) => {
  const { client_id, title } = req.body;
  if (!client_id || !title || !req.file) return res.status(400).json({ error: 'Missing fields.' });
  const id = uuidv4();
  db.addPractice(id, client_id, title, 'audio', '', req.file.filename);
  res.json({ id, filename: req.file.filename });
});

app.patch('/api/practices/:id/favourite', (req, res) => {
  db.toggleFavourite(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/practices/:id/use', (req, res) => {
  db.incrementUseCount(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/practices/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  db.deletePractice(req.params.id);
  res.json({ ok: true });
});

// ── Claude helper ──
async function callClaude(systemPrompt, messages, maxTokens = 400) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    }),
  });
  const data = await response.json();
  if (!data.content) throw new Error(JSON.stringify(data));
  return stripMarkdown(data.content[0].text);
}

// ── ElevenLabs TTS ──
// ── ElevenLabs TTS — Mirror architecture ──
// Server fetches full audio, sends token over WebSocket
// Client fetches audio via HTTP /api/audio/:token — proven approach
const audioStore = new Map(); // token -> audio buffer, expires in 60s

async function textToSpeech(text) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.85, similarity_boost: 0.85, style: 0.0, use_speaker_boost: true },
        speed: VOICE_SPEED,
      }),
    }
  );
  if (!response.ok) throw new Error(`ElevenLabs ${response.status}`);
  const chunks = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function textToSpeechSentences(text, ws) {
  const audio = await textToSpeech(text);
  // Store with random token, send token to client
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  audioStore.set(token, audio);
  setTimeout(() => audioStore.delete(token), 60000);
  ws.send(JSON.stringify({ type: 'audio_token', token, final: true }));
}

// ── Deepgram STT ──
function openDeepgram(onTranscript) {
  const dgUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
    model: 'nova-2', language: 'en', punctuate: 'true',
    interim_results: 'true', endpointing: '500',
  });
  const dg = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
  dg.on('message', (data) => {
    const result = JSON.parse(data.toString());
    const transcript = result?.channel?.alternatives?.[0]?.transcript;
    const isFinal    = result?.is_final;
    if (transcript?.trim()) onTranscript(transcript, isFinal);
  });
  dg.on('error', (e) => console.error('Deepgram error:', e));
  return dg;
}

// ── WebSocket: verify session cookie ──
function getWsUser(req) {
  const cookie = req.headers.cookie || '';
  const match  = cookie.match(/perbot_session=([^;]+)/);
  if (!match) return null;
  return auth.verifyToken(match[1]);
}

// ── WebSocket handler ──
wss.on('connection', (ws, req) => {
  const wsUser = getWsUser(req);
  if (!wsUser) { ws.close(4001, 'Unauthorised'); return; }

  const url      = new URL(req.url, 'http://localhost');
  const botType  = url.searchParams.get('type') || 'client';
  const clientId = wsUser.role === 'client' ? wsUser.id : url.searchParams.get('client');

  let conversationHistory = [];
  let sessionTranscript   = [];
  let fogLevel            = 12;
  let deepgramWs          = null;
  let systemPrompt        = '';
  let isProcessing        = false;

  console.log(`[${botType}] ${wsUser.name} connected`);

  (async () => {
    await db.getDb();

    if (botType === 'client') {
      systemPrompt = prompts.CLIENT_SYSTEM_PROMPT;

      if (clientId) {
        const client   = db.getClient(clientId);
        const sessions = db.getSessionsForClient(clientId);
        const arc      = client?.arc || '';
        if (arc || sessions.length > 0) {
          systemPrompt += prompts.CLIENT_ARC_PREFIX(arc, sessions.length);
        }
      }

      const greeting = await callClaude(systemPrompt, [
        { role: 'user', content: '[Client has just arrived. Offer your opening — one or two sentences only. Receive them.]' }
      ], 120);

      conversationHistory.push({ role: 'assistant', content: greeting });
      sessionTranscript.push(`BOT: ${greeting}`);

      ws.send(JSON.stringify({ type: 'greeting', text: greeting }));
      await textToSpeechSentences(greeting, ws);

    } else if (botType === 'facilitator') {
      systemPrompt = prompts.FACILITATOR_SYSTEM_PROMPT(fogLevel);

      if (clientId) {
        const client   = db.getClient(clientId);
        const sessions = db.getSessionsForClient(clientId);
        const recentSummaries = sessions.slice(0, 3).map((s, i) =>
          `Session ${sessions.length - i} (${s.created_at?.slice(0, 10)}): ${s.summary}`
        ).join('\n\n');

        const briefing = await callClaude(systemPrompt, [{
          role: 'user',
          content: `Pre-session briefing for ${client?.name || 'Client'}.\nARC: ${client?.arc || 'Not yet established'}\nRECENT SESSIONS:\n${recentSummaries || 'No sessions yet.'}\n\nBriefing: arc summary, suggested focus today, clinical flags. Under 100 words.`
        }], 200);

        ws.send(JSON.stringify({ type: 'briefing', text: briefing, clientName: client?.name }));
      } else {
        ws.send(JSON.stringify({ type: 'ready', text: 'Ready. Select a client to begin.' }));
      }
    }
  })().catch(console.error);

  ws.on('message', async (message) => {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    if (msg.type === 'start_listening') {
      deepgramWs = openDeepgram(async (transcript, isFinal) => {
        if (!isFinal) { ws.send(JSON.stringify({ type: 'interim_transcript', text: transcript })); return; }
        if (isProcessing) return; // Drop if still processing previous response
        ws.send(JSON.stringify({ type: 'final_transcript', text: transcript }));
        sessionTranscript.push(`USER: ${transcript}`);
        isProcessing = true;

        const detailed = msg.detailed || false;
        const content  = (botType === 'facilitator' && !detailed)
          ? transcript + '\n\n[Respond in 2-3 sentences maximum. Short and sharp.]'
          : transcript;
        conversationHistory.push({ role: 'user', content });

        try {
          const reply = await callClaude(systemPrompt, conversationHistory, botType === 'facilitator' ? (detailed ? 500 : 150) : 400);
          conversationHistory.push({ role: 'assistant', content: reply });
          sessionTranscript.push(`BOT: ${reply}`);
          ws.send(JSON.stringify({ type: 'response_text', text: reply }));
          await textToSpeechSentences(reply, ws);
          isProcessing = false;
        } catch (e) { console.error('Claude error:', e); isProcessing = false; }
      });
      ws.send(JSON.stringify({ type: 'listening_started' }));
    }

    if (msg.type === 'audio_chunk' && deepgramWs?.readyState === WebSocket.OPEN) {
      deepgramWs.send(Buffer.from(msg.data, 'base64'));
    }

    if (msg.type === 'stop_listening') {
      deepgramWs?.close(); deepgramWs = null;
      ws.send(JSON.stringify({ type: 'listening_stopped' }));
    }

    if (msg.type === 'text_input') {
      const text = msg.text?.trim();
      if (!text) return;
      const detailed = msg.detailed || false;
      const promptedText = detailed
        ? text
        : text + '\n\n[Respond in 2-3 sentences maximum. Short and sharp — facilitator is in session.]';
      sessionTranscript.push(`FACILITATOR: ${text}`);
      conversationHistory.push({ role: 'user', content: promptedText });

      try {
        const reply = await callClaude(systemPrompt, conversationHistory, detailed ? 500 : 150);
        conversationHistory.push({ role: 'assistant', content: reply });
        sessionTranscript.push(`BOT: ${reply}`);
        ws.send(JSON.stringify({ type: 'response_text', text: reply }));
        await textToSpeechSentences(reply, ws);
      } catch (e) { console.error(e); }
    }

    if (msg.type === 'set_fog') {
      fogLevel = msg.level;
      systemPrompt = prompts.FACILITATOR_SYSTEM_PROMPT(fogLevel);
      ws.send(JSON.stringify({ type: 'fog_set', level: fogLevel }));
    }

    if (msg.type === 'explain') {
      const recentExchange = conversationHistory.slice(-6)
        .map(m => `${m.role === 'user' ? 'Facilitator' : 'Bot'}: ${m.content}`).join('\n');
      try {
        const explanation = await callClaude(
          prompts.FACILITATOR_SYSTEM_PROMPT(fogLevel),
          [{ role: 'user', content: `Explain what is happening underneath based on this exchange:\n${recentExchange}\n\nMechanism, prior, fibres. Under 150 words.` }],
          300
        );
        ws.send(JSON.stringify({ type: 'explanation', text: explanation }));
        await textToSpeechSentences(explanation, ws);
      } catch (e) { console.error(e); }
    }

    if (msg.type === 'end_session' && clientId) {
      try {
        const fullTranscript = sessionTranscript.join('\n');
        const client = db.getClient(clientId);

        const [summary, clientSummary] = await Promise.all([
          callClaude(prompts.FACILITATOR_SYSTEM_PROMPT(12), [{
            role: 'user',
            content: prompts.GENERATE_SESSION_SUMMARY(fullTranscript, client?.arc, botType)
          }], 600),
          callClaude(prompts.CLIENT_SYSTEM_PROMPT, [{
            role: 'user',
            content: `Write a brief session summary for the client themselves — plain language, warm, what shifted, what to practice. Under 80 words.\n\nSESSION:\n${fullTranscript}`
          }], 200)
        ]);

        db.addSession(uuidv4(), clientId, wsUser.id, botType, summary, clientSummary);

        const sessions = db.getSessionsForClient(clientId);
        const recentSummaries = sessions.slice(0, 3).map(s => s.summary).join('\n\n---\n\n');
        const arcUpdate = await callClaude(
          prompts.FACILITATOR_SYSTEM_PROMPT(12),
          [{ role: 'user', content: prompts.GENERATE_ARC_UPDATE(client?.arc, recentSummaries) }],
          300
        );

        ws.send(JSON.stringify({ type: 'session_summary', summary, arcUpdate }));
      } catch (e) { console.error('Summary error:', e); }
    }

    if (msg.type === 'update_arc' && clientId) {
      db.updateArc(clientId, msg.arc);
      ws.send(JSON.stringify({ type: 'arc_updated' }));
    }
  });

  ws.on('close', () => {
    deepgramWs?.close();
    console.log(`[${botType}] ${wsUser.name} disconnected`);
  });
});

// ── Start ──
(async () => {
  await db.getDb();

  // Create admin account if none exists
  const adminEmail = process.env.ADMIN_EMAIL || 'per@deepermindfulness.org';
  const adminPass  = process.env.ADMIN_PASSWORD || 'changeme123';
  const existing   = db.getFacilitatorByEmail(adminEmail);
  if (!existing) {
    const hash = await auth.hashPassword(adminPass);
    db.createFacilitator(uuidv4(), 'Per Norrgren', adminEmail, hash, 'admin');
    db.updateFacilitatorPassword(db.getFacilitatorByEmail(adminEmail).id, hash);
    // Mark as not needing password change since it's set via env var
    console.log(`Admin created: ${adminEmail}`);
  }

  server.listen(PORT, () => console.log(`Per Bot v2 running on port ${PORT}`));
})();

// ════════════════════════════════════════════
// CONTENT MANAGEMENT API
// ════════════════════════════════════════════

// ── Audio serving — Mirror approach ──
// Client fetches audio by token via HTTP — no WebSocket binary issues
app.get('/api/audio/:token', (req, res) => {
  const audio = audioStore.get(req.params.token);
  if (!audio) return res.status(404).send('Not found');
  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'no-cache');
  res.send(audio);
});

// Content pages
app.get('/admin/content',  auth.requireAuth(['admin']), (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin', 'content.html')));
app.get('/admin/content/', auth.requireAuth(['admin']), (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin', 'content.html')));

// ── Categories ──
app.get('/api/content/categories', auth.requireAuthApi(['admin','facilitator','client']), (req, res) => {
  res.json(db.getAllCategories());
});
app.post('/api/content/categories', auth.requireAuthApi(['admin']), (req, res) => {
  const { name, parentId } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required.' });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
  db.createCategory(uuidv4(), name.trim(), slug, parentId || null, 0);
  res.json({ ok: true });
});
app.patch('/api/content/categories/:id', auth.requireAuthApi(['admin']), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required.' });
  db.renameCategory(req.params.id, name.trim());
  res.json({ ok: true });
});
app.delete('/api/content/categories/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteCategory(req.params.id);
  res.json({ ok: true });
});

// ── Library files ──
app.get('/api/content/library', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const { categoryId, subcategoryId, visibility, search } = req.query;
  res.json(db.getLibraryFiles({ categoryId, subcategoryId, visibility, search }));
});

app.post('/api/content/library', auth.requireAuthApi(['admin']), upload.single('file'), (req, res) => {
  const { title, categoryId, subcategoryId, visibility } = req.body;
  if (!title || !categoryId || !req.file) return res.status(400).json({ error: 'Missing required fields.' });
  const id = uuidv4();
  db.addLibraryFile(id, title.trim(), req.body.description || '', req.file.filename,
    req.file.originalname, req.file.mimetype, req.file.size,
    categoryId, subcategoryId || null, visibility || 'client');
  res.json({ id });
});

app.patch('/api/content/library/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.updateLibraryFile(req.params.id, req.body);
  res.json({ ok: true });
});

app.get('/api/content/library/:id/usage', auth.requireAuthApi(['admin']), (req, res) => {
  res.json(db.getFileUsage(req.params.id));
});

app.patch('/api/content/library/:id/rename', auth.requireAuthApi(['admin']), (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename required.' });
  const file = db.getLibraryFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found.' });
  const fs   = require('fs');
  const ext  = path.extname(file.filename);
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_') + ext;
  const oldPath = path.join(__dirname, 'uploads', file.filename);
  const newPath = path.join(__dirname, 'uploads', safe);
  try {
    if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
    db.renameLibraryFile(req.params.id, safe);
    res.json({ ok: true, filename: safe });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/content/library/:id', auth.requireAuthApi(['admin']), (req, res) => {
  const file = db.getLibraryFile(req.params.id);
  if (file) {
    const fp = path.join(__dirname, 'uploads', file.filename);
    try { require('fs').unlinkSync(fp); } catch {}
  }
  db.deleteLibraryFile(req.params.id);
  res.json({ ok: true });
});

// ── Courses ──
app.get('/api/content/courses', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  res.json(db.getAllCourses(req.query));
});
app.post('/api/content/courses', auth.requireAuthApi(['admin']), (req, res) => {
  const { title, description, categoryId, subcategoryId, lessons } = req.body;
  if (!title || !categoryId) return res.status(400).json({ error: 'Title and category required.' });
  const courseId = uuidv4();
  db.createCourse(courseId, title, description, categoryId, subcategoryId, false);
  if (lessons && lessons.length) {
    lessons.forEach(l => {
      db.createLesson(uuidv4(), courseId, l.number, l.title, l.description || '', l.visibility || 'client');
    });
  }
  res.json({ id: courseId });
});
app.get('/api/content/courses/:id', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  const c = db.getCourse(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});
app.delete('/api/content/courses/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteCourse(req.params.id);
  res.json({ ok: true });
});

// ── Lessons ──
app.get('/api/content/courses/:id/lessons', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  res.json(db.getLessonsForCourse(req.params.id));
});
app.post('/api/content/lessons', auth.requireAuthApi(['admin']), (req, res) => {
  const { courseId, lessonNumber, title, visibility, fileIds } = req.body;
  if (!courseId || !lessonNumber || !title) return res.status(400).json({ error: 'Missing fields.' });
  const lessonId = uuidv4();
  db.createLesson(lessonId, courseId, parseInt(lessonNumber), title, '', visibility || 'client');
  if (fileIds && fileIds.length) {
    fileIds.forEach((fid, i) => db.addLessonFileRef(uuidv4(), lessonId, fid, i));
  }
  res.json({ id: lessonId });
});
app.get('/api/content/lessons/:id/files', auth.requireAuthApi(['admin','facilitator']), (req, res) => {
  res.json(db.getFilesForLesson(req.params.id));
});
app.delete('/api/content/lessons/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deleteLesson(req.params.id);
  res.json({ ok: true });
});

// ── Lesson file refs ──
app.post('/api/content/lesson-file-refs', auth.requireAuthApi(['admin']), (req, res) => {
  const { lessonId, fileId } = req.body;
  if (!lessonId || !fileId) return res.status(400).json({ error: 'Missing fields.' });
  const existing = db.getFilesForLesson(lessonId);
  db.addLessonFileRef(uuidv4(), lessonId, fileId, existing.length);
  res.json({ ok: true });
});
app.delete('/api/content/lesson-file-refs/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.removeLessonFileRef(req.params.id);
  res.json({ ok: true });
});

// ── Playlists ──
app.get('/api/content/playlists', auth.requireAuthApi(['admin','facilitator','client']), (req, res) => {
  res.json(db.getAllPlaylists(req.query));
});
app.post('/api/content/playlists', auth.requireAuthApi(['admin']), (req, res) => {
  const { title, description, categoryId, subcategoryId } = req.body;
  if (!title || !categoryId) return res.status(400).json({ error: 'Title and category required.' });
  const id = uuidv4();
  db.createPlaylist(id, title, description, categoryId, subcategoryId, false);
  res.json({ id });
});
app.get('/api/content/playlists/:id/tracks', auth.requireAuthApi(['admin','facilitator','client']), (req, res) => {
  res.json(db.getTracksForPlaylist(req.params.id));
});
app.delete('/api/content/playlists/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.deletePlaylist(req.params.id);
  res.json({ ok: true });
});

// ── Playlist track refs ──
app.post('/api/content/playlist-track-refs', auth.requireAuthApi(['admin']), (req, res) => {
  const { playlistId, fileId, title, sortOrder } = req.body;
  if (!playlistId || !fileId) return res.status(400).json({ error: 'Missing fields.' });
  db.addPlaylistTrackRef(uuidv4(), playlistId, fileId, title || '', sortOrder || 0);
  res.json({ ok: true });
});
app.delete('/api/content/playlist-track-refs/:id', auth.requireAuthApi(['admin']), (req, res) => {
  db.removePlaylistTrackRef(req.params.id);
  res.json({ ok: true });
});

// ── Serve uploaded files (auth required) ──
app.get('/uploads/:filename', (req, res) => {
  const token = req.cookies?.[auth.COOKIE_NAME];
  const user  = token ? auth.verifyToken(token) : null;
  if (!user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'uploads', req.params.filename));
});
