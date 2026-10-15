// practice_pages.js — Per App 38 (22): free practice pages that printed
// material points to.
//
// The Alarm That Would Not Stop tells readers on almost every practice:
// "Audio available at www.deepermindfulness.org/the_alarm". The FELT lesson
// slides say "Audio available at deepermindfulness.org/felt". Both addresses
// were dead after the move to the new site. Per (15 Oct 2026): set both up as
// outside pages, free to listen to with no login, each with a way to learn
// more.
//
//  /the_alarm   the twelve five-minute practices from the book, in book
//               order. A recording appears as soon as Per uploads it to the
//               library with "Alarm" and the practice name in its title,
//               e.g. "Alarm - The Floor Is Here". Until then: "Recording
//               coming soon".
//  /felt        the recorded practices from Finding Mindfulness, the FELT
//               Way, session by session, straight from the course. New
//               recordings added to the course show up here by themselves.
//  /practice-audio/:id   plays one recording. Only files that are on one of
//               these two pages can be played this way; anything else in the
//               library still needs a login.

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FELT_COURSE = '92d60a4a-4305-41ee-a9f8-ca4f7921a4ac'; // Finding Mindfulness - Mindfulness For Life The FELT Way

// The twelve practices, in the order they appear in the book. `match` is the
// phrase looked for in the uploaded recording's title (together with "alarm").
const ALARM_PRACTICES = [
  { name: 'The Floor Is Here', match: 'floor is here', line: 'Heels into the floor, slow counts of five. A fast, steadying signal that the ground is there and you are held.' },
  { name: 'Something Deliberate', match: 'something deliberate', line: 'Thumb to finger, slowly and on purpose. You decide, and your body carries it out.' },
  { name: 'Gentle Curiosity', match: 'gentle curiosity', line: 'From scanning to wondering: one sound, one colour, one sensation, just noticed.' },
  { name: 'The Beat', match: 'beat', line: 'A slow, steady tap for the alarm to settle into.' },
  { name: 'The Sigh', match: 'sigh', line: 'A full breath in, one more small sip on top, and a long, slow breath out.' },
  { name: 'The Slow Touch', match: 'slow touch', line: 'A slow stroke along the forearm, then a hand simply resting.' },
  { name: 'Just Noticing', match: 'just noticing', line: 'Staying with one sensation, without needing to change it.' },
  { name: 'Looking Around', match: 'looking around', line: 'Five things you can see, four you can hear, three you can feel. This room, this day.' },
  { name: 'Another Person', match: 'another person', line: 'Sitting quietly with someone who settles you, or picturing them with you.' },
  { name: 'Warmth Toward the Body', match: 'warmth toward', line: 'A hand on the chest: this is a body that has been working hard.' },
  { name: 'What Has Changed, and Something True', match: 'what has changed', line: 'Noticing what is even slightly different, and saying one true thing.' },
  { name: 'Unconditionality', match: 'unconditional', line: 'Five minutes with nothing to fix, produce or prove. I am allowed to be here.' },
];

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const CSS = `
  .intro { font-size:20px; color:var(--ink); }
  .meta-line { color:var(--faint); font-size:15px; margin:0 0 26px; }
  .plist { list-style:none; padding:0; margin:10px 0 0; counter-reset:p; }
  .plist > li { counter-increment:p; position:relative; padding:16px 0 16px 46px; border-bottom:1px solid var(--card-line); }
  .plist > li::before { content:counter(p); position:absolute; left:0; top:16px; width:30px; height:30px; border-radius:50%; border:1px solid var(--mint-line); color:var(--mint); font-size:13px; display:flex; align-items:center; justify-content:center; }
  .plist .pt { display:block; font-size:18px; color:var(--ink); }
  .plist .pd { display:block; font-size:15px; color:var(--soft); margin-top:3px; }
  .plist audio { width:100%; max-width:520px; margin-top:10px; display:block; }
  .plist .soon { display:inline-block; margin-top:8px; font-size:14px; color:var(--faint); font-style:italic; }
  .session { margin-top:30px; }
  .session h2 { font-size:22px; font-weight:normal; margin:0 0 6px; }
  .tracks { list-style:none; padding:0; margin:0; }
  .tracks li { padding:10px 0; border-bottom:1px solid var(--card-line); }
  .tracks .tt { display:block; font-size:16px; color:var(--ink); }
  .tracks audio { width:100%; max-width:520px; margin-top:8px; display:block; }
  .learn { margin-top:40px; padding:22px 22px 18px; border-radius:18px; background:var(--card); border:1px solid var(--card-line); }
  .learn h2 { margin:0 0 8px; font-size:22px; font-weight:normal; }
  .learn p { font-size:16px; color:var(--soft); }
  .learn .cta { margin:10px 10px 0 0; }
`;

function mountPracticePages(app, { db, media, publicPages, seoStore, invalidate = () => {}, siteUrl, heroImg, cleanLessonTitle = t => t, log = console.log }) {
  const SITE = String(siteUrl || 'https://deepermindfulness.org').replace(/\/+$/, '');

  // ── Which recordings belong on each page ──
  function alarmFiles() {
    const rows = db.rawAll(`SELECT id, title FROM library_files WHERE (archived IS NULL OR archived=0) AND file_type LIKE 'audio/%' AND lower(title) LIKE '%alarm%' ORDER BY created_at DESC`);
    return ALARM_PRACTICES.map(p => {
      const hit = rows.find(r => { const t = norm(r.title); return t.includes(norm(p.match)) && !/would not stop audio/.test(t); });
      return Object.assign({}, p, { file: hit || null });
    });
  }
  function feltSessions() {
    const lessons = db.rawAll(`SELECT id, title, lesson_number FROM lessons WHERE course_id=? AND (access_status IS NULL OR access_status != 'hidden') ORDER BY sort_order, lesson_number`, [FELT_COURSE]);
    const out = [];
    for (const l of lessons) {
      const files = db.rawAll(`SELECT lf.id, lf.title FROM lesson_file_refs r JOIN library_files lf ON lf.id=r.file_id
        WHERE r.lesson_id=? AND lf.file_type LIKE 'audio/%' AND (lf.archived IS NULL OR lf.archived=0) ORDER BY r.sort_order`, [l.id]);
      out.push({ title: String(cleanLessonTitle(l.title)).replace(/^Session (\d+)\s+(?!·)/i, 'Session $1 · '), files });
    }
    return out;
  }
  const trackLabel = t => String(t || '')
    .replace(/^session\s*\d+\s*[-·:]?\s*/i, '')
    .replace(/\bv\d+\b/i, '')
    .replace(/(\d+)\s*min\b/i, '· $1 minutes')
    .replace(/\s+/g, ' ').trim() || 'Practice';

  function allowed(id) {
    if (alarmFiles().some(p => p.file && p.file.id === id)) return true;
    return feltSessions().some(s => s.files.some(f => f.id === id));
  }

  const player = id => `<audio controls preload="none" src="/practice-audio/${esc(id)}"></audio>`;

  function learnBox(heading, text, links) {
    return `<section class="learn"><h2>${esc(heading)}</h2><p>${esc(text)}</p>
  <p>${links.map(([href, label, ghost]) => `<a class="cta${ghost ? ' ghost' : ''}" href="${esc(href)}">${esc(label)}</a>`).join('')}</p></section>`;
  }

  function renderAlarm() {
    const items = alarmFiles().map(p => `<li><span class="pt">${esc(p.name)}</span><span class="pd">${esc(p.line)}</span>${p.file ? player(p.file.id) : '<span class="soon">Recording coming soon</span>'}</li>`).join('\n');
    return publicPages.shell('The Alarm That Would Not Stop: the guided practices | Deeper Mindfulness',
      'The twelve five-minute guided practices from The Alarm That Would Not Stop by Per Norrgren. Free to listen to, no sign-up needed.',
      `<style>${CSS}</style><main>
  <div class="crumbs"><a href="/">Home</a> · <a href="/alarm">The Alarm That Would Not Stop</a></div>
  <h1>The Alarm That Would Not Stop: the practices</h1>
  <p class="intro">The twelve five-minute practices from the book, recorded so you can simply listen and follow along. In the book each one sits right where the idea it belongs to comes up. Here they are in the same order.</p>
  <p class="meta-line">Free to listen to, no sign-up needed. A few minutes, a few times a day, does more than one long session a week.</p>
  <ol class="plist">${items}</ol>
  ${learnBox('Want to go further?', 'The book explains why the body stays on alert long after the danger has gone, and why these small signals reach it when understanding alone does not. In the Deeper Mindfulness app the practices sit alongside full courses, a library of guided practices and a short daily message.',
    [['/alarm', 'About the book'], ['/register', 'Try the app free'], ['/courses', 'Courses', true]])}
</main>`);
  }

  function renderFelt() {
    const sessions = feltSessions();
    const withAudio = sessions.filter(s => s.files.length);
    const blocks = withAudio.map(s => `<section class="session"><h2>${esc(s.title)}</h2><ul class="tracks">${s.files.map(f => `<li><span class="tt">${esc(trackLabel(f.title))}</span>${player(f.id)}</li>`).join('')}</ul></section>`).join('\n');
    const more = sessions.length > withAudio.length ? '<p class="meta-line" style="margin-top:22px">More sessions are added here as they are recorded.</p>' : '';
    return publicPages.shell('FELT: the guided practices | Deeper Mindfulness',
      'Guided practices from Finding Mindfulness, the FELT Way, by Per Norrgren: settling through the body, session by session. Free to listen to, no sign-up needed.',
      `<style>${CSS}</style><main>
  <div class="crumbs"><a href="/">Home</a> · <a href="/courses/mindfulness-for-life">Mindfulness for Life</a></div>
  <h1>FELT: the practices</h1>
  <p class="intro">The guided practices from Finding Mindfulness, the FELT Way, session by session. Each session has a short introduction, a longer practice, a poem, and a four-minute daily top-up for the days in between.</p>
  <p class="meta-line">Free to listen to, no sign-up needed. The body learns through repetition: a short top-up most days does more than one long practice now and then.</p>
  ${blocks || '<p>The recordings are on their way.</p>'}
  ${more}
  ${learnBox('Take the whole course', 'Finding Mindfulness, the FELT Way, is Mindfulness for Life with the FELT signals added: ten sessions with notes, practices and poems, at your own pace in the app.',
    [['/courses/mindfulness-for-life', 'About the course'], ['/register', 'Try the app free'], ['/learn', 'Learn more', true]])}
</main>`);
  }

  const send = (fn, name) => (req, res) => {
    try { res.set('Cache-Control', 'no-cache'); res.type('html').send(fn()); }
    catch (e) { log(`[practice-pages] ${name} failed: ${e.message}`); res.status(500).send('Sorry, this page could not be shown just now.'); }
  };
  app.get('/the_alarm', send(renderAlarm, 'the_alarm'));
  for (const alias of ['/the_alarm/', '/the-alarm', '/the-alarm/', '/thealarm', '/alarm-practices', '/alarm/practices']) app.get(alias, (req, res) => res.redirect(301, '/the_alarm'));
  app.get('/felt', send(renderFelt, 'felt'));
  for (const alias of ['/felt/', '/felt-practices']) app.get(alias, (req, res) => res.redirect(301, '/felt'));

  app.get('/practice-audio/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!allowed(id)) return res.status(404).send('Not found');
      const f = db.rawAll(`SELECT filename, storage_type FROM library_files WHERE id=?`, [id])[0];
      if (!f || f.storage_type !== 'r2') return res.status(404).send('Not found');
      const url = await media.getPlaybackUrl(f.filename, { expiresIn: 4 * 3600 });
      res.set('Cache-Control', 'no-store');
      res.redirect(302, url);
    } catch (e) {
      log('[practice-pages] audio failed: ' + e.message);
      res.status(500).send('Sorry, this recording could not be played just now.');
    }
  });

  function syncSearch() {
    const pages = seoStore.listPages();
    const upsert = (path, row) => {
      const ex = pages.find(p => p.path === path);
      seoStore.savePage(Object.assign({ id: ex ? ex.id : undefined, path, image_url: heroImg, in_sitemap: 1, in_llms: 1, og_type: 'website', priority: 0.7 }, row));
    };
    const author = { '@type': 'Person', name: 'Per Norrgren', url: SITE };
    upsert('/the_alarm', { title: 'The Alarm That Would Not Stop: the guided practices',
      description: 'The twelve five-minute guided practices from The Alarm That Would Not Stop by Per Norrgren. Free to listen to, no sign-up needed.',
      schema_type: 'CollectionPage', schema_json: JSON.stringify({ '@type': 'CollectionPage', name: 'The Alarm That Would Not Stop: the guided practices', url: `${SITE}/the_alarm`, author,
        isPartOf: { '@type': 'Book', name: 'The Alarm That Would Not Stop', author } }) });
    upsert('/felt', { title: 'FELT: the guided practices',
      description: 'Guided practices from Finding Mindfulness, the FELT Way, by Per Norrgren: settling through the body, session by session. Free to listen to.',
      schema_type: 'CollectionPage', schema_json: JSON.stringify({ '@type': 'CollectionPage', name: 'FELT: the guided practices', url: `${SITE}/felt`, author }) });
    invalidate();
  }

  return { syncSearch, alarmFiles, feltSessions, ALARM_PRACTICES };
}

module.exports = { mountPracticePages, ALARM_PRACTICES };
