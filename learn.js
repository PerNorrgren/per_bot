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
    title: 'Why do I suddenly wake up with a racing heart at 3am?',
    seoTitle: 'Waking at 3am with your heart racing: why it happens',
    description: 'Nothing is wrong in the room, and still the heart is going. Why the body sounds its alarm at night, and a small practice you can do in bed.',
    published: '2026-10-12',
    readMinutes: 9,
    related: [
      { href: '/alarm', label: 'The Alarm That Would Not Stop', note: 'the book this comes from, with short practices you can listen to' },
      { href: '/courses', label: 'Courses', note: 'live on Zoom or at your own pace in the app' },
    ],
    body: [
      // ── Per's own text (13 Oct 2026); only plain slips fixed ──
      P(`Suddenly you are awake, for no apparent reason. You look around, the room is dark, nothing visibly wrong, there are no strange sounds, but somewhere deep inside is that feeling of alarm.`),
      P(`If you have experienced this, you know how that moment feels with something there for sure but actually there isn’t anything to worry about.`),
      P(`Most often all is good, nothing has happened apart from your alarm system raised an alarm. There is nothing wrong with this in itself, we need this alarm system, it is just that if there is no break, nothing to say “thank you, but now we do not need the alarm”, the alarm will raise up through the consciousness and wake us up.`),
      `<aside class="note"><p>${`First – important to rule out any natural reasons for the arousal, like sleep apnoea, or you feel some pain in the chest, being out of breath maybe with some dizziness or disorientation, then it is important to seek medical assistance.`}</p></aside>`,
      P(`What I am going to write about is the natural worry that might be running unchecked in the background due to past events.`),
      P(`Many of my clients come to me with this issue, thoughts from nowhere suddenly appear and keep them awake for hours.`),
      P(`There is nothing strange with the environment, normal bedroom in a normal house, in a normal street, all quiet. Often there is a partner sleeping in the same bed, unaware of what is going on, unaware of the loud and random noise inside the mind.`),
      P(`Interestingly, this is not much of an issue during the day and it seems that other things keep the mind occupied. There is always something to do, being busy keeps the focus away from this state of mind. Like that bedside lamp had a second secret switch, the first one turns the light off, the second one turns the mind on.`),
      H2(`My client’s story`),
      P(`One client came to me after therapy for six years, it had helped but not stopped it from happening. He would now and then still wake up in the middle of the night with a racing heart and thoughts like fireworks. The thoughts seemed to always be around something that was not totally confirmed or about a predicted future.`),
      P(`That there had been something that his mind had put together as an explanation for what had happened or why a person had done something for a past event. Or that it was a prediction of what was going to happen in the future, what a person would do.`),
      P(`Like his mind would be a detective and put two and two together and get six as the answer. And the answer must of course be true, the evidence is so clear, so how could it not be true?`),
      P(`And on it would go, with endless logic applied to see if there was any other scenario possible.`),
      H2(`What is going on here?`),
      P(`Simply put, our mind is a prediction engine, it predicts the reason for past events and predicts the future based on lived experiences.  And here is the rub, that past experience includes the sleepless nights of worry, so the workings of the mind are beautifully self-reinforcing and self-perpetuating. Each worry night adds to the evidence that it must be true, so any note of a possible difference is simply seen through the eyes of worry and turned to evidence of the prediction.`),
      P(`It is important to understand that those lived experiences can be very old, going back to childhood when our nervous system was developed. So it might even be that we have no idea or memory of it, or that it was not a single traumatic event but a lived experience of an environment that did not give what was needed.`),
      H2(`Why does it happen in the middle of the night?`),
      P(`The mind re-organises the events of the day during the night, does the house keeping tasks it needs to do to sort things out. First comes deep sleep for some hours and then lighter sleep comes, and often there is a window in the middle of the night where the sleep is very light or like a slumber. We might go to the bathroom, look at the clock to see it is 3am or listen to any noise outside in the garden or the street.`),
      P(`And now is prime time to look at something that the subconscious mind has picked up as possible danger. Or picked up as evidence of exclusion, evidence of not being enough, evidence of not belonging, etc. the list is long.`),
      H2(`The wired mind`),
      P(`As our minds are wired for survival, it sets about trying to remove or reduce the threat or evidence. And here we are, 3am, trying to think our way out of something that is not originating in the mind. It originates in the body, the body keeps the score of what happened in the past. What the state of the body was when this or that happened.`),
      P(`So when something happens that the subconscious mind picks up as “Aha, I have seen this before….”, the old body state returns, preparing for action. And this body state gets presented to the thinking mind as emotions and feelings associated with what was picked up during the day. And off we go, we try to make sense of, get some clarity and get some much needed sleep.`),
      H2(`The prediction error`),
      P(`This logical approach to try to solve something that is a body state, will not work very well. What we can do to break this loop is to meet the body state with some evidence of the contrary.`),
      P(`We create a prediction error for the mind.`),
      P(`So we first must ground ourselves and the reality of this moment, what day it is, time, where I am etc.`),
      H2(`The grounding`),
      P(`Back to my client, and what we did. We introduced gentle use of the feet first and simply let the heels find what is supporting them with a little pressure. Hold this for a slow count to five and then gently release. Repeat this a few times until you notice the feeling of the bed or floor pressing back. Then we introduce an action, something I decide to do just like that and it can be simply pressing the index finger and thumb together, again press, hold for a count to five then slowly release. We notice that it was an action done on purpose, I did this.`),
      P(`Once this is done we use the breath and do a few double breaths; start with inhale belly and feel how the abdominal wall expands. Then we add the chest, by slowly lifting and expanding the chest, before slowly breathing out fully. On the second outbreath introduce a little micro smile and a sense of tight muscles relaxing. Maybe doing three to five of these extended inhale and exhale to feel a little looser and more at ease.`),
      P(`We allow the breath to become steady and find its own slow rhythm and we put one hand on the back of the other, feel the warmth of the hand and slowly at a count to five move the hand up to the elbow. We do this allowing the hand to slowly slide up the forearm with gentle and soft pressure. This is repeated three times with the feeling of warmth and softness of where you are.`),
      P(`Finally we do the orientation, noting where I am, what day it is, what time it is, any sound, etc. mentioning softly inwardly three real things in this moment.`),
      H2(`The release`),
      P(`Finding ourselves being grounded and perhaps even feeling calm with the heart rate back to normal, we can work in releasing the thoughts.`),
      P(`Gently and softly without getting overwhelmed, bring the thought back in to mind and notice how the body responds. Maybe the tightness returns, maybe the heart rate picks up?`),
      P(`Turn to where you feel it in the body, allowing any thoughts to be there in the thinking mind just as they are. Like you put the thoughts on the workbench or in a box for later.`),
      P(`With some curiosity start to explore actually how it feels in the body, where it is, how big, does it move, have colour, what is the image you see?`),
      P(`Once you feel it and/or see it, you can work with it by slowly releasing the muscles around it, imagining inhaling soft warm air in to the area. Perhaps the outbreath carries some of the tension away and the area slowly starts to change. We then offer some kindness, some warmth and even love if it is available. Softly inwardly we say gently “I see you, I hear you”, “I am here for you”, “I love you” and notice how this feels.`),
      P(`We finish with soft affirmation “Body reactions are normal, it is ok to have them, but no further action needed now”`),
      P(`This circle of grounding followed by release is repeated three times, before we stop and ask ourselves if there is anything now that we notice is different from before we started. Even a tiny bit is recognised, and we confirm it with just one word said softly inwardly.`),
      H2(`The going back to sleep`),
      P(`The trick is to let the moment settle and give the mind something trivial to do.`),
      P(`We introduce a simple word, like MELON, and start with the first letter M. We try to come up with things that all start with the letter M. Once we cannot find any more, we move to the next letter E, and so on.`),
      P(`It keeps the mind from going back to the worry and it soon calms the mind and we fall asleep.`),
      H2(`My client’s experience`),
      P(`The little practice had a remarkable effect on my client's sleep pattern and ability to go back to sleep when woken by the busy mind.`),
      P(`Key for him was to do the practice little and often until it just became part of life. Even starting to use it during the day, short moments of grounding with little release when the mind got stuck on worrying or feeling upset or anxious about something.`),
      P(`He found it very helpful to find a trigger event, something he normally does that he used as a cue in to doing it. Like waiting for the kettle, the lift, at a red light in the car, etc.`),
      P(`It could look like this: first do a simple grounding, maybe only one heel-press, one double breath with a micro-smile followed by a short "here it is again, no action needed now". Finish with noticing if there is a difference and then continue with what you were doing.`),
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
  .note p { font-size:15px; margin:0 0 10px; color:var(--soft); } .note p:last-child { margin-bottom:0; }
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
  ${more ? `<div class="more"><h2>If this sounds like your nights</h2>${more}<p><a href="/register?src=learn-${esc(a.slug)}">Try the app free</a>, no card needed.</p></div>` : ''}
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
