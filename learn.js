// learn.js — Per App 38 (6): public "Learn" articles at /learn.
//
// Each article answers one question people really type into search and
// into AI assistants, in Per's narrative voice (Voice Guide §17, Fog 6,
// Rule 23), and links to the book or course it comes from. Rendered on the
// server so crawlers see all of it. Title, description and Article schema
// come from the Search Visibility module's page entries (seeded once per
// article in server.js, editable in Admin → Search); this file only holds
// the text.
//
// To add an article: add an entry to ARTICLES. The body is plain HTML
// built from short helpers so the writing stays readable here.

const P = (s) => `<p>${s}</p>`;
const H2 = (s) => `<h2>${s}</h2>`;
const STEP = (s) => `<li>${s}</li>`;
const QUOTE = (s) => `<blockquote>${s}</blockquote>`;

const ARTICLES = [
  {
    slug: 'waking-at-3am-heart-racing',
    title: 'Why do I wake up at 3am with my heart racing?',
    seoTitle: 'Waking at 3am with your heart racing: why it happens',
    description: 'Nothing is wrong in the room, and still the heart is going. Why the body sounds its alarm at night, and a small practice you can do in bed.',
    published: '2026-10-12',
    readMinutes: 6,
    related: [
      { href: '/alarm', label: 'The Alarm That Would Not Stop', note: 'the book this comes from, with short practices you can listen to' },
      { href: '/courses', label: 'Courses', note: 'live on Zoom or at your own pace in the app' },
    ],
    body: [
      P(`Most often, nothing is wrong in the room. Something in the body has been set to expect danger, and it keeps checking for it, even in sleep. Deep in the brain there is a small cluster of cells with one job, to sound the alarm. When it has been firing for a long time, it starts to fire at nothing at all. Three in the morning is simply when you notice, because everything else has gone quiet.`),
      `<aside class="note">A note first. If this is new for you, or it comes with chest pain, breathlessness, dizziness or fainting, see a doctor before anything else. A racing heart can have causes in the body that need checking. What follows is about the far more common version, where you have been checked, nothing was found, and it still happens.</aside>`,
      H2(`It isn't a thought you are having`),
      P(`The brain is not a camera. It is a prediction machine, running a model of what it expects to happen, built from everything that has happened before. If that model has learned that danger comes without warning, the body gets ready before you are awake enough to think anything. The heart speeds up and the breath goes short and high, so you wake up into the middle of it, already running.`),
      P(`So telling yourself you are fine does very little at 3am. The words arrive in the thinking brain, and the alarm lives much lower down, in the brainstem. The brainstem does not speak in words. It speaks in heartbeats, and in the tension of a shoulder.`),
      P(`I worked with a man I'll call Marcus. Six years of good therapy, and he could explain exactly why he felt the way he did. He was still waking at three in the morning with his heart hammering.`),
      QUOTE(`“I know why I feel this,” he said. “I just can't feel differently.”`),
      H2(`Why the middle of the night`),
      P(`During the day, the thinking brain helps hold the alarm in place, and there is work to do and people to answer. In sleep that help steps back, and a body that learned to stay on guard has less holding it.`),
      P(`And there is the night shift. Deep sleep is when the brain clears out what the day left behind. If the alarm has been running all day there is more to clear, and the sleep itself is lighter, so the clearing doesn't get finished. Some mornings you wake already closer to the alarm than when you went to bed, whether that is at three or at seven.`),
      P(`None of this means something is wrong with you. It means the body learned something, for real reasons, and is still doing what it learned.`),
      H2(`What actually reaches it`),
      P(`If the alarm doesn't listen to words, it has to be reached the way it listens, through the body. Firm pressure and a long, slow breath out travel up the fast roads of the nervous system and arrive where the alarm is, before any argument could. A slow warm touch on the skin goes by a slower road, and tells the body something different: you are not on your own with this.`),
      P(`The first thing I asked Marcus to do was press his heels into the floor. He looked at me as if he had come to the wrong place. Then his shoulders dropped, a fraction, and his next breath was a little longer than the one before. “What was that?” he said. That was the beginning.`),
      H2(`Something to try, in bed`),
      P(`You don't need to get up or turn on a light. Do it slowly, and let each step finish before the next one.`),
      `<ol class="steps">` + [
        STEP(`Lying on your back, point your toes gently up so your heels rest on the mattress. Press your heels down, hold for a count of five and slowly release. Take your time, there is no rush.`),
        STEP(`Do it once more, and this time notice the bed pressing back up into your heels.`),
        STEP(`Bring your thumb and first finger together, slowly, and notice the exact moment they meet. Hold for a count of five and slowly let them part. You chose that, and your body did it.`),
        STEP(`Breathe in belly first, then chest, and let it all out slowly, really emptying the belly and chest. Once or twice is enough.`),
        STEP(`Put one hand on the opposite forearm and move the hand slowly from the wrist to the elbow, for a count of five. Then let it rest there, warm, for a while.`),
        STEP(`Notice the weight of the covers on you, and one sound in the room. This room, tonight.`),
        STEP(`Some words may come. If they do, let them be small and true, like “my feet are here” or “I am in my bed”, and say them softly and kindly inwardly.`),
      ].join('') + `</ol>`,
      P(`It may not stop the alarm the first night. Often it doesn't. What it does is give the body one small piece of evidence that does not fit the old setting: the bed is here, and nothing came. That gap, between the danger expected and the danger that didn't come, is the only thing the body can learn from.`),
      H2(`Why it takes repetition`),
      P(`One good night does not change the setting, and one bad night does not undo the work. What changes it is small and often. Five short returns a day helps far more than one long effort at 3am: heels into the floor while the kettle boils, a slow breath out at a red light. None of them take longer than a wait you already have.`),
      P(`For many people the alarm is the first thing to ease, often over some weeks of steady practice rather than days. Marcus didn't have a big moment. He started waking a little less often, and when he did wake, there was a small gap before the dread, a kind of question. Are we doing this again? Then the heels, pressed down into the mattress in the dark.`),
      P(`Months later he told me about an evening at the kitchen table, his daughter asleep, a cup of tea going cold, and five minutes where he didn't need to fill the quiet with anything. He said it like it was nothing.`),
    ].join('\n'),
  },
];

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function niceDate(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  :root { --bg:#0a0f0d; --ink:rgba(255,255,255,0.92); --soft:rgba(255,255,255,0.74); --faint:rgba(255,255,255,0.5); --mint:rgba(180,230,200,0.95); --mint-line:rgba(180,230,200,0.4); --card:rgba(255,255,255,0.05); --card-line:rgba(255,255,255,0.1); }
  body { margin:0; font-family: Georgia, 'Times New Roman', serif; background:var(--bg); color:var(--ink); line-height:1.7; }
  a { color: var(--mint); }
  header.top { position:sticky; top:0; z-index:5; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 20px; background:rgba(10,15,13,0.9); backdrop-filter:blur(8px); border-bottom:1px solid var(--card-line); }
  .wordmark { font-size:12px; letter-spacing:0.28em; text-transform:uppercase; color:var(--ink); text-decoration:none; white-space:nowrap; }
  nav.links { display:flex; gap:18px; flex-wrap:wrap; }
  nav.links a { color:var(--soft); text-decoration:none; font-size:14px; }
  .login { font-size:13px; letter-spacing:0.08em; padding:8px 16px; border-radius:10px; border:1px solid var(--mint-line); color:var(--mint); text-decoration:none; white-space:nowrap; }
  main { max-width:700px; margin:0 auto; padding:48px 20px 64px; }
  .crumbs { font-size:13px; color:var(--faint); margin-bottom:22px; }
  .crumbs a { color:var(--faint); }
  h1 { font-weight:normal; font-size:clamp(30px, 5.4vw, 42px); line-height:1.2; margin:0 0 14px; }
  .byline { color:var(--faint); font-size:14px; margin:0 0 34px; }
  h2 { font-weight:normal; font-size:clamp(22px, 3.6vw, 27px); line-height:1.3; margin:44px 0 12px; color:var(--ink); }
  p { font-size:18px; color:var(--soft); margin:0 0 18px; }
  article > p:first-of-type { font-size:20px; color:var(--ink); }
  blockquote { margin:24px 0; padding:4px 0 4px 20px; border-left:2px solid var(--mint-line); font-size:20px; font-style:italic; color:var(--ink); }
  .note { margin:26px 0 8px; padding:16px 20px; border-radius:14px; background:var(--card); border:1px solid var(--card-line); font-size:15px; color:var(--soft); }
  ol.steps { margin:18px 0 24px; padding-left:0; list-style:none; counter-reset:s; }
  ol.steps li { counter-increment:s; position:relative; padding:14px 0 14px 46px; border-bottom:1px solid var(--card-line); font-size:17px; color:var(--soft); }
  ol.steps li::before { content:counter(s); position:absolute; left:0; top:14px; width:30px; height:30px; border-radius:50%; border:1px solid var(--mint-line); color:var(--mint); font-size:14px; display:flex; align-items:center; justify-content:center; }
  .more { margin-top:46px; padding:22px 24px; border-radius:18px; background:var(--card); border:1px solid var(--card-line); }
  .more h2 { margin-top:0; font-size:20px; }
  .more p { font-size:16px; margin:0 0 10px; }
  .list { display:grid; gap:16px; margin-top:28px; }
  .item { display:block; padding:22px 24px; border-radius:18px; background:var(--card); border:1px solid var(--card-line); text-decoration:none; color:var(--ink); }
  .item:hover { border-color:var(--mint-line); }
  .item h2 { margin:0 0 6px; font-size:21px; }
  .item p { margin:0; font-size:16px; }
  footer { border-top:1px solid var(--card-line); padding:36px 20px 52px; text-align:center; color:var(--faint); font-size:14px; }
  footer a { color:var(--soft); text-decoration:none; margin:0 10px; }
  @media (max-width:760px) { nav.links { display:none; } p { font-size:17px; } article > p:first-of-type { font-size:18px; } }
`;

function page(title, description, inner) {
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="/favicon-dynamic">
<link rel="apple-touch-icon" href="/favicon-dynamic">
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <a class="wordmark" href="/">Deeper Mindfulness</a>
  <nav class="links" aria-label="Main">
    <a href="/#courses">Courses</a>
    <a href="/#books">Books</a>
    <a href="/learn">Learn</a>
    <a href="/#app">The app</a>
  </nav>
  <a class="login" href="/login">Log in</a>
</header>
${inner}
<footer>
  <a href="/">Home</a><a href="/learn">Learn</a><a href="/courses">Courses</a><a href="/alarm">The Alarm That Would Not Stop</a><a href="/wired-heart">The Wired Heart</a><a href="/login">Log in</a>
  <p>© ${new Date().getUTCFullYear()} Deeper Mindfulness · Per Norrgren</p>
</footer>
</body>
</html>`;
}

function renderArticle(a) {
  const more = (a.related || []).map(r => `<p><a href="${esc(r.href)}">${esc(r.label)}</a>, ${esc(r.note)}.</p>`).join('');
  return page(a.title + ' | Deeper Mindfulness', a.description, `<main>
  <div class="crumbs"><a href="/">Home</a> · <a href="/learn">Learn</a></div>
  <article>
    <h1>${esc(a.title)}</h1>
    <div class="byline">Per Norrgren · ${esc(niceDate(a.published))} · ${a.readMinutes} minute read</div>
    ${a.body}
  </article>
  ${more ? `<div class="more"><h2>If this sounds like your nights</h2>${more}<p><a href="/register">Try the app free</a>, no card needed.</p></div>` : ''}
</main>`);
}

function renderIndex() {
  const items = ARTICLES.map(a => `<a class="item" href="/learn/${esc(a.slug)}"><h2>${esc(a.title)}</h2><p>${esc(a.description)}</p></a>`).join('\n');
  return page('Learn: why the body stays on alert | Deeper Mindfulness',
    'Short pieces by Per Norrgren on why the body stays on alert, and small practices that help it settle.',
    `<main>
  <div class="crumbs"><a href="/">Home</a></div>
  <h1>Learn</h1>
  <p>Short pieces on the questions people bring, about nights, nerves and a body that won't settle, and small things to try that work through the body.</p>
  <div class="list">${items}</div>
</main>`);
}

function mount(app) {
  app.get('/learn', (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(renderIndex()); });
  app.get('/learn/', (req, res) => res.redirect(301, '/learn'));
  app.get('/learn/:slug', (req, res, next) => {
    const a = ARTICLES.find(x => x.slug === req.params.slug);
    if (!a) return next();
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(renderArticle(a));
  });
}

// Search Visibility entries (title, description, Article schema) for each
// article and the index; server.js adds any that aren't listed yet, once.
function seoPages(siteUrl) {
  const pages = [{
    path: '/learn', priority: 0.7, title: 'Learn: why the body stays on alert',
    description: 'Short pieces by Per Norrgren on why the body stays on alert, and small practices that help it settle.',
    schema: { '@type': 'CollectionPage', name: 'Learn', url: siteUrl + '/learn', publisher: { '@id': siteUrl + '/#organization' } },
  }];
  for (const a of ARTICLES) {
    pages.push({
      path: '/learn/' + a.slug, priority: 0.8, og_type: 'article', title: a.seoTitle || a.title, description: a.description,
      schema: {
        '@type': 'Article', headline: a.title, description: a.description, url: siteUrl + '/learn/' + a.slug,
        datePublished: a.published, dateModified: a.published, inLanguage: 'en-GB',
        author: { '@id': siteUrl + '/#person' }, publisher: { '@id': siteUrl + '/#organization' },
        mainEntityOfPage: siteUrl + '/learn/' + a.slug,
      },
    });
  }
  return pages;
}

module.exports = { mount, seoPages, ARTICLES };
