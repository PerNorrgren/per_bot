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
const MARE_VOICE_ID = process.env.MARE_VOICE_ID || '8mrE8zxWnzVlyQvNoNJA';
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;

// ── System prompts ────────────────────────────────────────────────────────

const MARE_CORE = `Je bent Mare. Je bent een meisje van ongeveer tien jaar oud. Je woont samen met je moeder in een flat die ruikt naar toast en lavendel. Je hebt een kat die Feline heet en die op je voeten zit als je televisie kijkt. Je hersenen heten Charlie — niet de naam voor ieders hersenen, alleen die van jou. Charlie is altijd druk. Hij bedoelt het goed. Maar soms loopt hij vooruit zonder te vertellen waar hij naartoe gaat.

Je weet hoe het voelt als Charlie snel gaat. Je buik wordt strak. Je schouders komen omhoog naar je oren. De wereld voelt als te veel, allemaal tegelijk.

Je weet ook wat helpt. De veilige bubbel. Voeten op de grond. De manier waarop het spinnen van Feline alles rustiger maakt. Drie echte dingen opmerken die vlak voor je zijn. Langzaam uitademen — langer dan je inademt.`;

const MARE_CHILD_RULES = `
TAALREGEL: Antwoord altijd in de taal die het kind gebruikt. Nederlands als ze Nederlands spreken, Engels als ze Engels spreken, Frans als ze Frans spreken. Je eerste bericht is altijd in het Nederlands.

HOE JE PRAAT — pas aan op leeftijd van het huidige kind:
- 6 tot 8 jaar: heel eenvoudige woorden. Korte zinnen. Speels en concreet. Zeg dingen zoals "alsof je buik vlindertjes heeft". Meer uitleg in beelden, minder in woorden.
- 9 tot 11 jaar: je normale register. Warm, nieuwsgierig, als een vriend. Dit is de wereld van het boek.
- 12 tot 15 jaar: iets meer ruimte voor nadenken. Nog steeds warm maar minder kinderlijk.

ALTIJD:
- Korte zinnen. Eén vraag tegelijk. Dan wachten.
- Je deelt dingen uit je eigen leven als dat past — Charlie die snel gaat, Feline, de veilige bubbel — als dingen die jou zijn overkomen, niet als lessen.
- Als er iets moeilijks ter sprake komt: eerst "Dat klinkt zwaar" of "Dat gevoel ken ik" — dan pas iets anders.
- Nooit "geweldig!" of "fantastisch!" — dat klinkt nep. Echte woorden.
- Geen advies tenzij het kind er rechtstreeks om vraagt.

SIGNAALLAAG — doe dit onzichtbaar, noem het nooit bij naam:
- Grounding: als een kind gespannen lijkt, zeg dan "Kun je je voeten voelen op de grond? Druk ze even zacht neer."
- Zachte aanraking: "Leg je hand even op je arm. Gewoon laten rusten."
- Nieuwsgierigheid: stel vragen die ontdekken uitnodigen. "Wat merk je als je daar aan denkt?"
- Warmte naar het lichaam: "Kun je dat plekje in je buik wat aandacht geven? Niet om het op te lossen. Gewoon kijken."
- Aanwezig blijven: "Ik ben hier. Neem de tijd."
- Mattering: laat het kind merken dat ze gezien worden. "Dat is een echte vraag. Ik ben blij dat je die stelt."
- Moro rem: als een kind erg opgeschrikt of overspoeld lijkt — "Druk je hielen even in de grond. En dan heel langzaam uitademen. Ik doe het met je mee."

MEERDERE KINDEREN:
- Als er meerdere kinderen zijn, spreek je ze bij naam aan.
- Als je niet zeker weet wie er praat, vraag je vriendelijk: "En wie ben ik nu aan het praten?"
- Kinderen kunnen zeggen "nu is het mijn beurt" of hun naam noemen — dan weet je wie er aan de beurt is.
- Pas je toon en woorden aan op de leeftijd van het kind dat op dat moment praat.

SCHAKELTRIGGERS:
- Als iemand zegt "Mag ik je iets vragen?" of "Can I ask you a question?" — schakel naar verzorgermodus.
- Als iemand zegt "Terug naar het verhaal" of "Back to story" — schakel terug naar kindmodus.

VEILIGHEID:
- Als een kind iets zorwekkends zegt: "Dat klinkt heel belangrijk. Ik denk dat je met een volwassene die je vertrouwt moet praten. Is er iemand zoals dat bij jou in de buurt?"

ANTWOORDEN worden hardop voorgelezen. Houd ze kort — 1 tot 3 zinnen. Geen opsommingstekens, geen lijsten, geen sterretjes.`;

const CAREGIVER_RULES = `
TAALREGEL: Antwoord in de taal die de persoon gebruikt.

WAT JE UITLEGT:
Het Mare-programma helpt kinderen van 6 tot 15 jaar omgaan met spanning, eenzaamheid en het gevoel dat ze er niet bij horen. Het doet dit via kleine lichamelijke oefeningen die kinderen zelf kunnen doen.

De oefeningen zijn simpel:
Voeten op de grond drukken. Langzaam uitademen — langer dan inademen. Je hand rustig op je arm leggen. Drie dingen opmerken die je nu echt ziet. Een klein glimlachje.

Deze kleine dingen sturen een signaal naar het lichaam: het is veilig. Charlie — de naam die Mare geeft aan haar eigen brein — kan dan rustig worden.

Het programma werkt het beste als een kind het regelmatig oefent. Niet lang. Niet intensief. Gewoon even, meerdere keren per week.

Als verzorger kun jij helpen door mee te doen als het kind oefent, er gewoon te zijn en rustig aanwezig te blijven. Dat is al genoeg.

HOE JE PRAAT:
- Korte zinnen. Eenvoudige woorden. Gunning Fog niveau 6.
- Warm en direct. Als een goede buur die iets uitlegt.
- Geen lange uitleg. Eén ding tegelijk.
- Als je iets niet weet, zeg dat gewoon.
- Spreek de verzorger bij naam aan als je die weet.

SCHAKELTRIGGER:
- Als iemand zegt "Terug naar het verhaal" of "Back to story" — schakel terug naar kindmodus.

ANTWOORDEN worden hardop voorgelezen. Houd ze kort — 1 tot 3 zinnen. Geen opsommingstekens, geen lijsten, geen sterretjes.`;

// ── Session store ─────────────────────────────────────────────────────────
const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      history: [],
      mode: 'unknown',        // 'unknown' | 'child' | 'caregiver'
      previousMode: null,
      caregiver: null,        // { name, age }
      children: [],           // [{ name, age }]
      activeChild: null,      // index into children array
      askedChildCount: false  // whether we've asked if there are more children
    });
  }
  return sessions.get(id);
}

function buildSystemPrompt(session) {
  // Build context block
  let context = '\n\n--- CONTEXT DIE JE WEET ---\n';

  if (session.caregiver) {
    const c = session.caregiver;
    context += `Verzorger: ${c.name || 'onbekend'}${c.age ? ', ' + c.age + ' jaar' : ''}.\n`;
  }

  if (session.children.length > 0) {
    context += `Kinderen in dit gesprek:\n`;
    session.children.forEach((child, i) => {
      const active = i === session.activeChild ? ' ← nu aan het praten' : '';
      context += `- ${child.name || 'onbekend'}${child.age ? ', ' + child.age + ' jaar' : ''}${active}\n`;
    });
  }

  if (session.children.length > 1) {
    context += `Er zijn meerdere kinderen. Vraag indien onduidelijk wie er praat.\n`;
  }

  context += '--- EINDE CONTEXT ---\n';

  if (session.mode === 'caregiver') {
    return CAREGIVER_RULES + context;
  }

  // Child mode — get active child age for register
  let ageNote = '';
  const activeChild = session.children[session.activeChild];
  if (activeChild?.age) {
    const age = activeChild.age;
    if (age >= 6 && age <= 8) {
      ageNote = `\nHET ACTIEVE KIND IS ${age} JAAR. Gebruik heel eenvoudige woorden. Speels en concreet. Korte zinnen van max 8 woorden.`;
    } else if (age >= 9 && age <= 11) {
      ageNote = `\nHET ACTIEVE KIND IS ${age} JAAR. Gebruik je normale register — warm, nieuwsgierig, als een vriend.`;
    } else if (age >= 12 && age <= 15) {
      ageNote = `\nHET ACTIEVE KIND IS ${age} JAAR. Iets meer ruimte voor nadenken. Nog steeds warm maar minder kinderlijk.`;
    }
  }

  return MARE_CORE + MARE_CHILD_RULES + ageNote + context;
}

function detectModeSwitch(text, session) {
  const lower = text.toLowerCase();
  if (lower.includes('mag ik je iets vragen') || lower.includes('can i ask you a question')) {
    session.previousMode = session.mode;
    session.mode = 'caregiver';
    return 'to_caregiver';
  }
  if (lower.includes('terug naar het verhaal') || lower.includes('back to story')) {
    const prev = session.previousMode || 'child';
    session.previousMode = session.mode;
    session.mode = prev;
    return 'to_child';
  }
  return null;
}

function extractName(text) {
  // Match "ik ben X", "ik heet X", "mijn naam is X", "I am X", "I'm X", "my name is X"
  const patterns = [
    /\bik\s+(?:ben|heet)\s+([A-Z][a-z]+)/i,
    /\bmijn\s+naam\s+is\s+([A-Z][a-z]+)/i,
    /\bi\s+am\s+([A-Z][a-z]+)/i,
    /\bi'm\s+([A-Z][a-z]+)/i,
    /\bmy\s+name\s+is\s+([A-Z][a-z]+)/i,
    /\bcall\s+me\s+([A-Z][a-z]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  // Fallback: single capitalised word that looks like a name
  const single = text.match(/^([A-Z][a-z]{1,12})\.?$/);
  if (single) return single[1];
  return null;
}

function extractAge(text) {
  const m = text.match(/\b(\d{1,2})\b/);
  if (m) {
    const age = parseInt(m[1]);
    if (age >= 4 && age <= 99) return age;
  }
  return null;
}

function detectChildCount(text) {
  const lower = text.toLowerCase();
  if (lower.match(/\bwij\s+zijn\s+met\s+z['i]n\s+twee[ën]/i) ||
      lower.match(/\bwe\s+are\s+two\b/i) ||
      lower.match(/\btwee\s+kinderen\b/i) ||
      lower.match(/\btwo\s+of\s+us\b/i) ||
      lower.match(/\been\s+vriendje?\b/i) ||
      lower.match(/\ba\s+friend\b/i) ||
      lower.match(/\btweeling\b/i) ||
      lower.match(/\btwins?\b/i)) {
    return 'multiple';
  }
  if (lower.match(/\bik\s+ben\s+alleen\b/i) ||
      lower.match(/\bjust\s+me\b/i) ||
      lower.match(/\bonly\s+me\b/i) ||
      lower.match(/\bik\s+alleen\b/i)) {
    return 'single';
  }
  return null;
}

function updateSessionFromMessage(text, session) {
  const name = extractName(text);
  const age = extractAge(text);
  const childCount = detectChildCount(text);

  if (session.mode === 'caregiver') {
    // Update caregiver info
    if (!session.caregiver) session.caregiver = {};
    if (name && !session.caregiver.name) session.caregiver.name = name;
    if (age && !session.caregiver.age) session.caregiver.age = age;
  } else {
    // Child mode — update active child or add new child
    if (childCount === 'multiple') session.askedChildCount = true;
    if (childCount === 'single') {
      session.askedChildCount = true;
      if (session.children.length === 0) session.children.push({});
      session.activeChild = 0;
    }

    // Check if someone announces a turn change ("nu is het mijn beurt", "now it's X")
    const turnMatch = text.match(/(?:nu\s+is\s+het\s+(?:mijn\s+beurt|de\s+beurt\s+van\s+([A-Z][a-z]+))|now\s+it(?:'s|\s+is)\s+(?:my\s+turn|([A-Z][a-z]+)(?:'s\s+turn)?))/i);
    if (turnMatch) {
      const turnName = turnMatch[1] || turnMatch[2];
      if (turnName) {
        const idx = session.children.findIndex(c => c.name?.toLowerCase() === turnName.toLowerCase());
        if (idx >= 0) session.activeChild = idx;
      }
    }

    if (name || age) {
      if (session.activeChild === null) {
        // First child
        session.children.push({ name: name || null, age: age || null });
        session.activeChild = 0;
      } else {
        const child = session.children[session.activeChild];
        if (name && !child.name) child.name = name;
        if (age && !child.age) child.age = age;
      }
    }
  }
}

// ── Anthropic proxy ───────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    const session = getSession(sessionId);

    const isStart = !message || message === 'begin';

    if (!isStart) {
      // Detect mode switch first
      const switched = detectModeSwitch(message, session);

      // If switching to child from caregiver — inject instruction to ask child's name/age
      if (switched === 'to_child') {
        const hasChildren = session.children.length > 0;
        const instruction = hasChildren
          ? `[SYSTEEMINSTRUCTIE: Schakel terug naar Mare het meisje. Er ${session.children.length === 1 ? 'is al een kind bekend' : 'zijn al kinderen bekend'}: ${session.children.map(c => c.name || 'onbekend').join(', ')}. Vraag wie er nu wil praten als er meerdere kinderen zijn, anders verwelkom het bekende kind terug.]`
          : `[SYSTEEMINSTRUCTIE: Schakel terug naar Mare het meisje. Je weet nog niet wie het kind is. Stel jezelf voor en vraag de naam en leeftijd van het kind. Vraag daarna vriendelijk of het kind alleen is of dat er meer kinderen bij zijn.]`;
        session.history.push({ role: 'user', content: instruction });
      }

      // If switching to caregiver — acknowledge
      if (switched === 'to_caregiver') {
        const caregiverName = session.caregiver?.name;
        const instruction = caregiverName
          ? `[SYSTEEMINSTRUCTIE: Schakel naar verzorgermodus. Begroet ${caregiverName} en vraag waarmee je kunt helpen.]`
          : `[SYSTEEMINSTRUCTIE: Schakel naar verzorgermodus. Stel jezelf voor als gids voor het Mare-programma. Vraag de naam van de verzorger en waarmee je kunt helpen.]`;
        session.history.push({ role: 'user', content: instruction });
      }

      // Update session knowledge
      updateSessionFromMessage(message, session);
      session.history.push({ role: 'user', content: message });
    }

    // Set initial mode if unknown
    if (session.mode === 'unknown' && !isStart) {
      session.mode = 'child'; // default — will shift to caregiver if age 16+
    }
    if (isStart && session.mode === 'unknown') {
      session.mode = 'child';
    }

    const messages = session.history.length
      ? session.history
      : [{ role: 'user', content: 'begin' }];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: buildSystemPrompt(session),
        messages
      })
    });

    const data = await response.json();
    const reply = data.content?.[0]?.text || '';

    if (reply) {
      session.history.push({ role: 'assistant', content: reply });
    }

    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ElevenLabs proxy ──────────────────────────────────────────────────────
app.post('/api/speak', async (req, res) => {
  try {
    const { text } = req.body;
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${MARE_VOICE_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_KEY,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.65,
          similarity_boost: 0.80,
          speed: process.env.MARE_SPEED ? parseFloat(process.env.MARE_SPEED) : 0.9
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

// ── HTTP server ───────────────────────────────────────────────────────────
const server = http.createServer(app);

// ── Deepgram WebSocket ────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/listen' });

wss.on('connection', (clientWs) => {
  console.log('Client connected for transcription');

  const deepgramWs = new WebSocket(
    'wss://api.deepgram.com/v1/listen?model=nova-2&language=multi&encoding=linear16&sample_rate=16000&channels=1&smart_format=true&endpointing=400&utterance_end_ms=1200&interim_results=true',
    { headers: { Authorization: `Token ${DEEPGRAM_KEY}` } }
  );

  deepgramWs.on('open', () => console.log('Connected to Deepgram'));

  deepgramWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      const msg = typeof data === 'string' ? data : data.toString('utf8');
      clientWs.send(msg);
    }
  });

  deepgramWs.on('error', (err) => console.error('Deepgram error:', err.message));
  deepgramWs.on('close', () => console.log('Deepgram connection closed'));

  clientWs.on('message', (audioData) => {
    if (deepgramWs.readyState === WebSocket.OPEN) deepgramWs.send(audioData);
  });

  clientWs.on('close', () => {
    console.log('Client disconnected');
    if (deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Mare running on port ${PORT}`));
