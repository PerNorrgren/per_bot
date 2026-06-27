const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');
const fetch      = require('node-fetch');
const dbOps      = require('./db');
const prompts    = require('./prompts');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID           = process.env.VOICE_ID;
const DEEPGRAM_API_KEY   = process.env.DEEPGRAM_API_KEY;
const PORT               = process.env.PORT || 3000;

// ── Static & middleware ──
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Explicit routes for each interface
app.get('/', (req, res) => res.redirect('/client/'));
app.get('/client', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client', 'index.html')));
app.get('/client/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client', 'index.html')));
app.get('/facilitator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'facilitator', 'index.html')));
app.get('/facilitator/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'facilitator', 'index.html')));

// ── File upload (mp3s) ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, uuidv4() + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── REST API ──

// Clients
app.get('/api/clients', (req, res) => {
  try { res.json(dbOps.getAllClients()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  dbOps.createClient(id, name.trim());
  res.json({ id, name: name.trim() });
});

app.get('/api/clients/:id', (req, res) => {
  const client = dbOps.getClient(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const sessions  = dbOps.getSessionsForClient(req.params.id);
  const practices = dbOps.getPracticesForClient(req.params.id);
  res.json({ ...client, sessions, practices });
});

app.patch('/api/clients/:id/arc', (req, res) => {
  const { arc } = req.body;
  dbOps.updateArc(req.params.id, arc);
  res.json({ ok: true });
});

// Sessions
app.post('/api/sessions', (req, res) => {
  const { client_id, type, summary } = req.body;
  const id = uuidv4();
  dbOps.addSession(id, client_id, type, summary);
  res.json({ id });
});

// Practices
app.get('/api/clients/:id/practices', (req, res) => {
  res.json(dbOps.getPracticesForClient(req.params.id));
});

app.post('/api/practices/text', (req, res) => {
  const { client_id, title, content } = req.body;
  if (!client_id || !title) return res.status(400).json({ error: 'client_id and title required' });
  const id = uuidv4();
  dbOps.addPractice(id, client_id, title, 'text', content, '');
  res.json({ id });
});

app.post('/api/practices/audio', upload.single('file'), (req, res) => {
  const { client_id, title } = req.body;
  if (!client_id || !title || !req.file) return res.status(400).json({ error: 'client_id, title, and file required' });
  const id = uuidv4();
  dbOps.addPractice(id, client_id, title, 'audio', '', req.file.filename);
  res.json({ id, filename: req.file.filename });
});

app.patch('/api/practices/:id/favourite', (req, res) => {
  dbOps.toggleFavourite(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/practices/:id/use', (req, res) => {
  dbOps.incrementUseCount(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/practices/:id', (req, res) => {
  dbOps.deletePractice(req.params.id);
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
  return data.content[0].text;
}

// ── ElevenLabs TTS ──
async function textToSpeech(text) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.75, similarity_boost: 0.85, style: 0.0, use_speaker_boost: true },
      }),
    }
  );
  if (!response.ok) throw new Error(`ElevenLabs ${response.status}`);
  const chunks = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ── Deepgram STT via WebSocket relay ──
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

// ── WebSocket handler ──
wss.on('connection', (ws, req) => {
  const url      = new URL(req.url, 'http://localhost');
  const botType  = url.searchParams.get('type') || 'client'; // 'client' | 'facilitator'
  const clientId = url.searchParams.get('client') || null;

  let conversationHistory = [];
  let sessionTranscript   = [];
  let fogLevel            = 12;
  let deepgramWs          = null;
  let currentAudio        = null;
  let systemPrompt        = '';

  console.log(`[${botType}] connected${clientId ? ` — client ${clientId}` : ''}`);

  // ── Initialise session ──
  (async () => {
    await dbOps.getDb();

    if (botType === 'client') {
      systemPrompt = prompts.CLIENT_SYSTEM_PROMPT;

      if (clientId) {
        const client   = dbOps.getClient(clientId);
        const sessions = dbOps.getSessionsForClient(clientId);
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

      const audio = await textToSpeech(greeting);
      ws.send(JSON.stringify({ type: 'greeting', text: greeting }));
      ws.send(JSON.stringify({ type: 'audio', data: audio.toString('base64') }));

    } else if (botType === 'facilitator') {
      systemPrompt = prompts.FACILITATOR_SYSTEM_PROMPT(fogLevel);

      if (clientId) {
        const client   = dbOps.getClient(clientId);
        const sessions = dbOps.getSessionsForClient(clientId);
        const recentSummaries = sessions.slice(0, 3).map((s, i) =>
          `Session ${sessions.length - i} (${s.created_at.slice(0, 10)}): ${s.summary}`
        ).join('\n\n');

        const briefing = await callClaude(systemPrompt, [{
          role: 'user',
          content: `Give me a pre-session briefing for this client.\n\nNAME: ${client?.name || 'Client'}\nARC: ${client?.arc || 'Not yet established'}\nRECENT SESSIONS:\n${recentSummaries || 'No sessions yet.'}\n\nBriefing: arc summary, suggested focus today, any clinical flags. Keep it under 150 words.`
        }], 300);

        ws.send(JSON.stringify({ type: 'briefing', text: briefing, clientName: client?.name }));
      } else {
        ws.send(JSON.stringify({ type: 'ready', text: 'Ready. Select a client to begin.' }));
      }
    }
  })().catch(console.error);

  // ── Message handler ──
  ws.on('message', async (message) => {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    // ── Voice: start/stop listening ──
    if (msg.type === 'start_listening') {
      if (currentAudio) { currentAudio = null; }
      deepgramWs = openDeepgram(async (transcript, isFinal) => {
        if (!isFinal) {
          ws.send(JSON.stringify({ type: 'interim_transcript', text: transcript }));
          return;
        }
        ws.send(JSON.stringify({ type: 'final_transcript', text: transcript }));
        sessionTranscript.push(`USER: ${transcript}`);
        conversationHistory.push({ role: 'user', content: transcript });

        try {
          const reply = await callClaude(systemPrompt, conversationHistory, botType === 'facilitator' ? 500 : 400);
          conversationHistory.push({ role: 'assistant', content: reply });
          sessionTranscript.push(`BOT: ${reply}`);

          ws.send(JSON.stringify({ type: 'response_text', text: reply }));
          const audio = await textToSpeech(reply);
          ws.send(JSON.stringify({ type: 'audio', data: audio.toString('base64') }));
        } catch (e) {
          console.error('Claude error:', e);
        }
      });
      ws.send(JSON.stringify({ type: 'listening_started' }));
    }

    if (msg.type === 'audio_chunk' && deepgramWs?.readyState === WebSocket.OPEN) {
      deepgramWs.send(Buffer.from(msg.data, 'base64'));
    }

    if (msg.type === 'stop_listening') {
      deepgramWs?.close();
      deepgramWs = null;
      ws.send(JSON.stringify({ type: 'listening_stopped' }));
    }

    // ── Text input (facilitator) ──
    if (msg.type === 'text_input') {
      const text = msg.text?.trim();
      if (!text) return;
      sessionTranscript.push(`FACILITATOR: ${text}`);
      conversationHistory.push({ role: 'user', content: text });

      try {
        const reply = await callClaude(systemPrompt, conversationHistory, 500);
        conversationHistory.push({ role: 'assistant', content: reply });
        sessionTranscript.push(`BOT: ${reply}`);
        ws.send(JSON.stringify({ type: 'response_text', text: reply }));
        const audio = await textToSpeech(reply);
        ws.send(JSON.stringify({ type: 'audio', data: audio.toString('base64') }));
      } catch (e) { console.error(e); }
    }

    // ── Fog level change ──
    if (msg.type === 'set_fog') {
      fogLevel     = msg.level;
      systemPrompt = prompts.FACILITATOR_SYSTEM_PROMPT(fogLevel);
      ws.send(JSON.stringify({ type: 'fog_set', level: fogLevel }));
    }

    // ── Explain to me ──
    if (msg.type === 'explain') {
      const recentExchange = conversationHistory.slice(-6)
        .map(m => `${m.role === 'user' ? 'Facilitator' : 'Bot'}: ${m.content}`)
        .join('\n');

      try {
        const explanation = await callClaude(
          prompts.FACILITATOR_SYSTEM_PROMPT(fogLevel),
          [{
            role: 'user',
            content: `Based on this recent exchange, explain what is happening underneath — the neurobiological mechanism, which prior is active, which fibres are relevant, and why.\n\nRECENT EXCHANGE:\n${recentExchange}\n\nExplain clearly at the current language level. Under 200 words.`
          }],
          400
        );
        ws.send(JSON.stringify({ type: 'explanation', text: explanation }));
        const audio = await textToSpeech(explanation);
        ws.send(JSON.stringify({ type: 'audio', data: audio.toString('base64') }));
      } catch (e) { console.error(e); }
    }

    // ── End session & generate summary ──
    if (msg.type === 'end_session' && clientId) {
      try {
        const fullTranscript = sessionTranscript.join('\n');
        const client = dbOps.getClient(clientId);

        const summary = await callClaude(
          prompts.FACILITATOR_SYSTEM_PROMPT(12),
          [{ role: 'user', content: prompts.GENERATE_SESSION_SUMMARY(fullTranscript, client?.arc, botType) }],
          600
        );

        dbOps.addSession(uuidv4(), clientId, botType, summary);

        // Suggest arc update
        const sessions = dbOps.getSessionsForClient(clientId);
        const recentSummaries = sessions.slice(0, 3).map(s => s.summary).join('\n\n---\n\n');
        const arcUpdate = await callClaude(
          prompts.FACILITATOR_SYSTEM_PROMPT(12),
          [{ role: 'user', content: prompts.GENERATE_ARC_UPDATE(client?.arc, recentSummaries) }],
          300
        );

        ws.send(JSON.stringify({ type: 'session_summary', summary, arcUpdate }));
      } catch (e) {
        console.error('Summary error:', e);
      }
    }

    // ── Accept arc update ──
    if (msg.type === 'update_arc' && clientId) {
      dbOps.updateArc(clientId, msg.arc);
      ws.send(JSON.stringify({ type: 'arc_updated' }));
    }
  });

  ws.on('close', () => {
    deepgramWs?.close();
    console.log(`[${botType}] disconnected`);
  });
});

// ── Start ──
(async () => {
  await dbOps.getDb();
  server.listen(PORT, () => console.log(`Per Bot v2 running on port ${PORT}`));
})();
