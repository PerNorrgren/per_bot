const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.VOICE_ID || '1VQdbBbW1zds7ZzRwz4g';
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;

// Anthropic proxy
app.post('/api/chat', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ElevenLabs proxy
app.post('/api/speak', async (req, res) => {
  try {
    const { text } = req.body;
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_KEY,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: {
          stability: 0.85,
          similarity_boost: 0.80,
          speed: 0.75
        }
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
    res.status(500).json({ error: e.message });
  }
});

// Create HTTP server
const server = http.createServer(app);

// WebSocket server for Deepgram streaming
const wss = new WebSocket.Server({ server, path: '/listen' });

wss.on('connection', (clientWs) => {
  console.log('Client connected for transcription');

  // Connect to Deepgram
  const deepgramWs = new WebSocket(
    'wss://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true&endpointing=500&utterance_end_ms=1500&interim_results=true',
    { headers: { Authorization: `Token ${DEEPGRAM_KEY}` } }
  );

  deepgramWs.on('open', () => {
    console.log('Connected to Deepgram');
  });

  deepgramWs.on('message', (data) => {
    try {
      const parsed = JSON.parse(data);
      const transcript = parsed?.channel?.alternatives?.[0]?.transcript;
      const isFinal = parsed?.is_final;
      if (transcript && isFinal) {
        clientWs.send(JSON.stringify({ type: 'transcript', text: transcript }));
      }
    } catch(e) {}
  });

  deepgramWs.on('error', (err) => {
    console.error('Deepgram error:', err.message);
    clientWs.send(JSON.stringify({ type: 'error', message: err.message }));
  });

  deepgramWs.on('close', () => {
    console.log('Deepgram connection closed');
  });

  // Forward audio from browser to Deepgram
  clientWs.on('message', (audioData) => {
    if (deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.send(audioData);
    }
  });

  clientWs.on('close', () => {
    console.log('Client disconnected');
    if (deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.close();
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Mirror running on port ${PORT}`));
