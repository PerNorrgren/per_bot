// course_pages.js — Per App 38 (15): public course pages.
//
// Per's request (13 Oct 2026): every course gets an outside page that can be
// promoted again and again on social media and found by Google: a short
// introduction in Per's voice (approved by Per), what is in it lesson by
// lesson, how it runs, live dates when there are any, and a button into the
// course. The three Mindfulness for Life courses share one page with the
// three ways to take it side by side.
//
//  /courses            all course pages
//  /courses/<name>     one course (or the Mindfulness for Life choice)
//
// "Start" goes to the course's existing booking page (/course-instance/…),
// which already handles new people (create an account, enrolled straight
// into the course) and people who are logged in (enrol in one tap).

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ACCESS = 'Included in membership, together with the whole practice library. You can try the app free first, no card needed.';

// Texts approved by Per on 13 Oct 2026.
const PAGES = [
  {
    slug: 'mindfulness-for-life', title: 'Mindfulness for Life',
    seoTitle: 'Mindfulness for Life: an eight-week mindfulness course, three ways to take it',
    intro: `You get to the end of the day and wonder where it went. The kettle boiled, the emails got answered, the drive home happened, and somewhere in all of that we were not really there. Most of us live like this, on autopilot, and it works until it doesn't, until the stress builds up with nowhere to go. Mindfulness for Life is eight weeks of coming back, through the body, the breath and the mind, until being here is something you can do on your own, any day. There are three ways to take it, choose the one that fits how you like to learn.`,
    options: [
      { course: 'fbcbf26e-6963-4d06-9355-e60e90d4b9ab', name: 'The traditional course',
        text: 'Eight lessons in the classic format of MBSR and MBCT, the programmes mindfulness grew up with: body scan, breath, movement and sitting practice, step by step, with notes for each week.',
        suits: 'Suits you if you like a clear, well-trodden path.' },
      { course: '92d60a4a-4305-41ee-a9f8-ca4f7921a4ac', name: 'The FELT Way (Finding Mindfulness)',
        text: 'The same journey, built on what we now know about how the nervous system settles. Ten sessions of short practices (grounding, breath, gentle touch and movement) that speak to the part of you that reacts before you have had a single thought. Belonging is built into the practices too.',
        suits: 'Suits you if you like to understand why it works.' },
      { course: 'e2171fc3-f5dc-4a0d-a6da-c8cc38d3a9fd', name: 'Listen and Learn',
        text: 'Forty guided tracks, ten minutes each, one a day for eight weeks. The teaching sits inside the practice itself, so there is nothing to study first and no timetable, you just press play.',
        suits: "Suits you if you'd rather just listen." },
    ],
  },
  { slug: 'deeper-mindfulness', course: '9473faea-b7b5-4c9f-bc8e-bb8fd1e7e46c', title: 'Deeper Mindfulness',
    seoTitle: 'Deeper Mindfulness: taking an MBCT-based practice further',
    intro: `You have practised for a while, and it helps, and still there is something underneath you have not quite reached. Deeper Mindfulness is for that. Eight lessons built on the MBCT-based approach of Finding Peace in a Frantic World, taking an existing practice further: catching the habits of the mind as they happen, turning towards what is difficult instead of away from it, and finding the small moments in a day where a different choice is possible.` },
  { slug: 'finding-calm', course: '9df84f29-d3cf-4ba1-9f1b-cfbf0dd1b880', title: 'Finding Calm',
    seoTitle: 'Finding Calm: ten sessions for a body that will not switch off',
    intro: `Nothing is actually wrong, and still the body hums, tight and ready, and it will not switch off. Finding Calm meets that hum where it lives, in the body. Ten sessions set in the forest, each one letting the body find a little more ground at its own pace. Nothing to perform, nothing to get right, we practise together and notice what changes.` },
  { slug: 'finding-joy', course: 'fc5322be-5cad-4d66-a5d2-7d2eede7d2db', title: 'Finding Joy',
    seoTitle: 'Finding Joy: ten sessions to notice joy again',
    intro: `Some days everything is fine, and still joy is nowhere to be found, like a signal we have stopped listening for. Finding Joy is ten sessions of practising to notice it again: the warmth that is already here, what happens when it is shared, and how it can sit right next to loss without either one cancelling the other out.` },
  { slug: 'a-poem-a-day-for-your-nerves', course: 'e2f5a1de-2f64-4729-b8ce-40c360f8a878', title: 'A Poem a Day for your nerves',
    seoTitle: 'A Poem a Day for your nerves: poems that work through the body',
    intro: `Some mornings the mind starts running before we are even out of bed. A poem can meet that in a way advice cannot. Each poem here meets one pattern, the drive that will not stop, the pull to please, the feeling of not being enough, from three sides over three days: through the body, in plain words, and in the bigger picture. One a day, with the morning tea.` },
  { slug: 'introduction-to-mindfulness', course: '95609ff9-0523-464e-8a60-f76fe31eb710', title: 'Introduction to Mindfulness',
    seoTitle: 'Introduction to Mindfulness: a short, three-lesson start',
    intro: `Your mind rarely sits still, and the harder we try to make it, the louder it gets. This short introduction, three lessons, is about something simpler: paying attention on purpose, noticing what is here, and finding a little space between what happens and how we respond. A good place to start if mindfulness is new to you.` },
  { slug: 'introduction-to-micro-moves', course: 'bb6b7526-be35-4c6c-aa98-8407bb97adc7', title: 'Introduction to Micro Moves',
    seoTitle: 'Introduction to Micro Moves: small movements that help the body settle',
    intro: `Sometimes the body keeps running long after we have stopped. Micro moves are small, precise movements, the heels pressing down, fingertips meeting, done slowly with a count and a release, that let the nervous system know it can settle. This short introduction shows you how, so you can use them anywhere: at the kettle, in a meeting, in bed at 3am.` },
  { slug: 'personal-retreat', course: '49bda20a-4638-4d28-b6ae-34d91dccfd7d', title: 'Personal Retreat, 2 days',
    seoTitle: 'Personal Retreat: a two-day mindfulness retreat at home',
    intro: `Two days for yourself, at home or wherever you are. The retreat follows the traditional MBSR retreat format with the FELT signalling added: each recording introduces and explains a practice, then you set your own timer and carry on in silence for as long as feels right. Structure when you need it, silence when you don't.` },
];

const NUM = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

function cleanLessonTitle(t) {
  return String(t || '')
    .replace(/^S(\d+)\s*·/i, 'Session $1 ·')
    .replace(/\s*·\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .replace(/Loosenig/gi, 'Loosening')
    .replace(/\bhere$/, 'Here')
    .replace(/\bjoy$/, 'Joy')
    .trim()
    .replace(/^./, c => c.toUpperCase());
}
const isGeneric = t => /^(introduction|lesson\s*\d+|week\s*\d+|day\s*\d+|reference|before you begin)$/i.test(String(t || '').trim());

function mountCoursePages(app, { db, publicPages, seoStore, invalidate = () => {}, siteUrl, heroImg, log = console.log }) {
  const SITE = String(siteUrl || 'https://deepermindfulness.org').replace(/\/+$/, '');
  const clean = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

  function selfPacedInstance(courseId) {
    return db.rawAll(`SELECT id FROM course_instances WHERE course_id=? AND status='open' AND mode='self_paced' ORDER BY created_at LIMIT 1`, [courseId])[0] || null;
  }
  function liveDates(courseId) {
    const today = new Date().toISOString().slice(0, 10);
    return (db.getPublicOpenInstancesForCourse(courseId) || []).filter(i => i.start_date && i.start_date >= today);
  }
  const niceDate = iso => { const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z'); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); };

  function lessonsBlock(courseId) {
    const lessons = (db.getLessonsForCourse(courseId) || []).filter(l => !/^reference$/i.test(String(l.title || '').trim()));
    const intro = lessons.filter(l => /^(introduction|before you begin)$/i.test(String(l.title || '').trim()));
    const main = lessons.filter(l => !intro.includes(l));
    if (!main.length) return '';
    if (main.every(l => isGeneric(l.title))) {
      const unit = /^week/i.test(main[0].title) ? 'weeks' : /^day/i.test(main[0].title) ? 'days' : 'lessons';
      const n = main.length;
      return `<p class="lessons-summary">${NUM[n] || n} ${unit}${intro.length ? ' and an introduction' : ''}, each with guided practices${unit === 'lessons' ? ' and notes' : ''}.</p>`;
    }
    const items = main.map(l => {
      const d = clean(l.description);
      const line = d ? d.split(/(?<=[.!?])\s/)[0] : '';
      return `<li><span class="lt">${esc(cleanLessonTitle(l.title))}</span>${line ? `<span class="ld">${esc(line)}</span>` : ''}</li>`;
    }).join('');
    return `${intro.length ? '<p class="lessons-summary">An introduction, then:</p>' : ''}<ol class="lessons">${items}</ol>`;
  }

  function startLinks(courseId, slug) {
    const inst = selfPacedInstance(courseId);
    const src = `course-${slug}`.slice(0, 60);
    return inst ? `/course-instance/${inst.id}?src=${encodeURIComponent(src)}` : `/register?src=${encodeURIComponent(src)}`;
  }

  function liveBlock(courseId) {
    const live = liveDates(courseId);
    if (!live.length) return '';
    return `<div class="live"><h3>Live on Zoom</h3>${live.map(i => `<p><a href="/course-instance/${i.id}">${esc(niceDate(i.start_date))}${i.schedule_day ? ', ' + esc(i.schedule_day) + 's' : ''}${i.schedule_time ? ' at ' + esc(i.schedule_time) + ' UK time' : ''}</a>${i.price_cents ? ` · £${(i.price_cents / 100).toFixed(0)}` : ''}</p>`).join('')}</div>`;
  }

  const CSS = `
  .intro { font-size:20px; color:var(--ink); }
  .meta-line { color:var(--faint); font-size:15px; margin:0 0 30px; }
  .lessons { list-style:none; padding:0; margin:14px 0 0; counter-reset:l; }
  .lessons li { counter-increment:l; position:relative; padding:12px 0 12px 44px; border-bottom:1px solid var(--card-line); }
  .lessons li::before { content:counter(l); position:absolute; left:0; top:12px; width:28px; height:28px; border-radius:50%; border:1px solid var(--mint-line); color:var(--mint); font-size:13px; display:flex; align-items:center; justify-content:center; }
  .lessons .lt { display:block; font-size:17px; color:var(--ink); }
  .lessons .ld { display:block; font-size:15px; color:var(--soft); margin-top:2px; }
  .lessons-summary { font-size:17px; color:var(--soft); }
  .live { margin-top:22px; padding:16px 20px; border-radius:14px; background:var(--card); border:1px solid var(--card-line); }
  .live h3 { margin:0 0 6px; font-weight:normal; font-size:18px; }
  .live p { margin:4px 0; font-size:16px; }
  .start { margin:30px 0 8px; }
  .start p { color:var(--faint); font-size:14px; margin:10px 0 0; }
  .options { display:grid; gap:18px; margin-top:26px; }
  .option { padding:22px 22px 20px; border-radius:18px; background:var(--card); border:1px solid var(--card-line); }
  .option h2 { margin:0 0 8px; font-size:22px; font-weight:normal; }
  .option .suits { color:var(--mint); font-style:italic; font-size:16px; margin:8px 0 14px; }
  .option details summary { cursor:pointer; color:var(--soft); font-size:15px; margin:10px 0; }
  @media (min-width:900px) { main.wide { max-width:1000px; } .options { grid-template-columns:repeat(3, 1fr); } }
  `;

  function render(page) {
    const access = `<p class="meta-line">${esc(ACCESS)}</p>`;
    if (page.options) {
      const opts = page.options.map((o, i) => {
        const c = db.getCourse(o.course);
        if (!c) return '';
        return `<section class="option">
  <h2>${esc(o.name)}</h2>
  <p>${esc(o.text)}</p>
  <p class="suits">${esc(o.suits)}</p>
  <details><summary>What is in it</summary>${lessonsBlock(o.course)}</details>
  ${liveBlock(o.course)}
  <p style="margin-top:16px"><a class="cta" href="${startLinks(o.course, page.slug + '-' + (i + 1))}">Start this one</a></p>
</section>`;
      }).join('\n');
      return publicPages.shell(`${page.seoTitle} | Deeper Mindfulness`, page.intro.slice(0, 155), `<style>${CSS}</style><main class="wide">
  <div class="crumbs"><a href="/">Home</a> · <a href="/courses">Courses</a></div>
  <h1>${esc(page.title)}</h1>
  <p class="intro">${esc(page.intro)}</p>
  ${access}
  <div class="options">${opts}</div>
  <div class="more"><p><a href="/courses">All courses</a> · <a href="/blog">Blog</a> · <a href="/poems">Poems</a></p></div>
</main>`);
    }
    const c = db.getCourse(page.course);
    if (!c) return null;
    return publicPages.shell(`${page.seoTitle} | Deeper Mindfulness`, page.intro.slice(0, 155), `<style>${CSS}</style><main>
  <div class="crumbs"><a href="/">Home</a> · <a href="/courses">Courses</a></div>
  <h1>${esc(page.title)}</h1>
  <p class="intro">${esc(page.intro)}</p>
  ${access}
  <h2>What is in it</h2>
  ${lessonsBlock(page.course)}
  ${liveBlock(page.course)}
  <div class="start"><a class="cta" href="${startLinks(page.course, page.slug)}">Start the course</a><p>Already have an account? The same button lets you log in and start.</p></div>
  <div class="more"><p><a href="/courses">All courses</a> · <a href="/blog">Blog</a> · <a href="/poems">Poems</a></p></div>
</main>`);
  }

  function renderIndex() {
    const items = PAGES.map(p => `<a class="item" href="/courses/${p.slug}"><h2>${esc(p.title)}</h2><p>${esc(p.intro.split(/(?<=[.!?])\s/).slice(0, 2).join(' '))}</p></a>`).join('\n');
    return publicPages.shell('Mindfulness courses by Per Norrgren | Deeper Mindfulness',
      'Mindfulness courses by Per Norrgren, at your own pace in the app or live on Zoom: Mindfulness for Life, Finding Calm, Finding Joy and more.', `<main>
  <div class="crumbs"><a href="/">Home</a></div>
  <h1>Courses</h1>
  <p style="color:var(--soft);font-size:18px">Courses by Per Norrgren, rooted in MBSR and MBCT and in the FELT approach of working through the body. Take them at your own pace in the app, and some live on Zoom. ${esc(ACCESS)}</p>
  <div class="list">${items}</div>
</main>`);
  }

  app.get('/courses', (req, res) => { try { res.set('Cache-Control', 'no-cache'); res.type('html').send(renderIndex()); } catch (e) { log('[courses] index failed: ' + e.message); res.status(500).send('Sorry, this page could not be shown just now.'); } });
  app.get('/courses/', (req, res) => res.redirect(301, '/courses'));
  app.get('/courses/:slug', (req, res, next) => {
    const page = PAGES.find(p => p.slug === req.params.slug);
    if (!page) return next();
    try { const html = render(page); if (!html) return next(); res.set('Cache-Control', 'no-cache'); res.type('html').send(html); }
    catch (e) { log('[courses] page failed: ' + e.message); res.status(500).send('Sorry, this page could not be shown just now.'); }
  });

  // Search entries (title, description, preview picture, Course schema),
  // added or updated at every start so the texts here stay the source.
  function syncSearch() {
    const pages = seoStore.listPages();
    const upsert = (path, row) => {
      const ex = pages.find(p => p.path === path);
      seoStore.savePage(Object.assign({ id: ex ? ex.id : undefined, path, image_url: heroImg, in_sitemap: 1, in_llms: 1 }, row));
    };
    const provider = { '@type': 'Organization', name: 'Deeper Mindfulness', url: SITE };
    upsert('/courses', { title: 'Mindfulness courses by Per Norrgren', description: 'Mindfulness courses by Per Norrgren, at your own pace in the app or live on Zoom: Mindfulness for Life, Finding Calm, Finding Joy and more.',
      og_type: 'website', schema_type: 'ItemList', priority: 0.9,
      schema_json: JSON.stringify({ '@type': 'ItemList', name: 'Courses', itemListElement: PAGES.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}/courses/${p.slug}`, name: p.title })) }) });
    for (const p of PAGES) {
      const desc = p.intro.length > 158 ? p.intro.slice(0, 155).replace(/\s+\S*$/, '') + '…' : p.intro;
      upsert(`/courses/${p.slug}`, { title: p.seoTitle, description: desc, og_type: 'website', schema_type: 'Course', priority: 0.9,
        schema_json: JSON.stringify({ '@type': 'Course', name: p.title, description: p.intro, url: `${SITE}/courses/${p.slug}`, provider,
          inLanguage: 'en-GB', image: heroImg, hasCourseInstance: { '@type': 'CourseInstance', courseMode: 'online' } }) });
    }
    invalidate();
  }

  return { syncSearch, PAGES };
}

module.exports = { mountCoursePages, PAGES };
