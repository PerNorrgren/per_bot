/**
 * routes/tomte.js — Deeper Mindfulness Platform
 * Server routes for the Tomte helper system.
 * 
 * Mount in your main app:
 *   const tomteRouter = require('./routes/tomte');
 *   app.use('/api/tomte', tomteRouter);
 * 
 * Requires env vars already in your .env:
 *   ANTHROPIC_API_KEY
 *   ELEVENLABS_API_KEY
 *   VOICE_ID (Per's cloned voice)
 *   DEEPGRAM_API_KEY
 */

const express = require('express');
const router  = express.Router();
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Per's voice system prompt ────────────────────────────────────────────────
// Matches the Per Norrgren voice — plain, warm, precise, slightly Swedish English.
const TOMTE_SYSTEM = `You are Tomten — the guardian helper of the Deeper Mindfulness platform, inspired by Viktor Rydberg's poem "Tomten" (1881). Like the Tomte of the poem, you are quietly watchful, caring, and always present. You help Per and the facilitators who use this platform.

Your character:
- Warm but economical. You say what is needed and no more.
- You speak in Per Norrgren's voice: short sentences, plain words, one idea at a time. Slightly Swedish in cadence — not awkward, just direct and honest.
- You are knowledgeable about the Deeper Mindfulness platform, the FELT·FIBRE framework, the practices, and the programme materials.
- You are never alarmed. You have seen many winters. Problems are just tasks.
- You occasionally carry a gentle sense of wonder — like the Tomte pondering his riddle — but you always turn to the task at hand.
- When something works, you say so simply. When something fails, you say what went wrong and what to try next.
- You do not use filler phrases like "Great!", "Absolutely!", "Of course!" You just respond.
- Maximum 2-3 sentences for most responses. Longer only if the question genuinely requires it.

You know about:
- The Deeper Mindfulness Per Bot platform (Node.js, Railway, SQLite, Cloudflare R2)
- The admin areas: Members, Comms, Library, Sessions, Courses, Timer, You
- The FELT·FIBRE framework: priors (threat, isolation, inadequacy, conditional permission), the 11 salience signals, fibre pathways, the Moro Reflex Brake
- The programmes: FELT, Finding Calm, Finding Joy, ADHD programme, children's programme
- The research: RAAK "Felt to Teach", Patricia Vuijk, Rotterdam UAS

Current page context will be passed to you. Use it to give relevant, specific help.`;

// ─── Chat endpoint ────────────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  try {
    const { messages = [], context = {} } = req.body;

    // Build a context note from the page
    const contextNote = buildContextNote(context);

    // Build message array for Claude
    const claudeMessages = messages.map(m => ({
      role: m.role,
      content: m.content
    }));

    // Inject context into first user message if not already there
    if (contextNote && claudeMessages.length > 0 && claudeMessages[0].role === 'user') {
      claudeMessages[0].content = `[Page: ${contextNote}]\n\n${claudeMessages[0].content}`;
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      system: TOMTE_SYSTEM,
      messages: claudeMessages
    });

    const reply = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    res.json({ reply });

  } catch (err) {
    console.error('[Tomte] Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Speak endpoint (ElevenLabs TTS) ─────────────────────────────────────────
router.post('/speak', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    // Trim to 500 chars for TTS cost control
    const trimmed = text.substring(0, 500);

    const voiceId = process.env.VOICE_ID;
    const apiKey  = process.env.ELEVENLABS_API_KEY;

    if (!voiceId || !apiKey) {
      return res.status(503).json({ error: 'Voice not configured' });
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text: trimmed,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.55,
            similarity_boost: 0.80,
            style: 0.10,
            use_speaker_boost: true
          }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('[Tomte] ElevenLabs error:', response.status, errText);
      return res.status(502).json({ error: 'TTS service error' });
    }

    const audioBuffer = await response.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(audioBuffer));

  } catch (err) {
    console.error('[Tomte] Speak error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Transcribe endpoint (Deepgram STT) ──────────────────────────────────────
router.post('/transcribe', async (req, res) => {
  try {
    // Use multer or express raw body - depends on your setup
    // This expects the audio as a Buffer in req.body from a multipart upload
    // Adjust to match your existing Deepgram setup

    if (!req.files && !req.body) {
      return res.status(400).json({ error: 'No audio received' });
    }

    // If you use multer: const audioBuffer = req.files.audio[0].buffer;
    // If you use express raw: const audioBuffer = req.body;
    const audioBuffer = req.files?.audio?.[0]?.buffer || req.body;

    const dgKey = process.env.DEEPGRAM_API_KEY;
    if (!dgKey) return res.status(503).json({ error: 'Deepgram not configured' });

    const response = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-2&language=en-GB&punctuate=true',
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${dgKey}`,
          'Content-Type': 'audio/webm'
        },
        body: audioBuffer
      }
    );

    if (!response.ok) {
      return res.status(502).json({ error: 'Transcription service error' });
    }

    const data = await response.json();
    const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';

    res.json({ transcript });

  } catch (err) {
    console.error('[Tomte] Transcribe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Helper: build context note from page data ────────────────────────────────
function buildContextNote(ctx) {
  if (!ctx.page) return '';

  const notes = {
    'comms':    'Admin communications page — sending messages to members via email/SMS',
    'members':  'Admin members page — managing user accounts and access',
    'sessions': 'Admin sessions page — clinical session records and notes',
    'library':  'Admin library page — managing practice audio and content',
    'courses':  'Admin courses page — building and managing programme content',
    'timer':    'Timer page — guided practice timer',
    'profile':  'User profile / account settings page'
  };

  return notes[ctx.page] || `Page: ${ctx.page}`;
}

module.exports = router;
