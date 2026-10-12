// public-home.js — Per App 38 (2): the public home page at "/".
//
// Before this, "/" redirected to /login, so to Google and to AI crawlers
// the home page was a login form. This page is rendered on the server from
// live data (open courses, live practice, membership prices), so everything
// on it is in the HTML itself — nothing waits for JavaScript to load.
//
// Head tags (title, description, Open Graph, the site's Organization /
// Person / WebSite schema) come from the Search Visibility module's entry
// for "/". This file adds only what has to match the page's live content:
// the course list and the FAQ, as schema.org JSON-LD.
//
// Writing rules for the visible text: plain words (Gunning Fog about 6),
// no "brake" or "Moro" (Rule 23), no claims the app can't stand behind.

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Course descriptions are stored as editor HTML. Plain text, first
// paragraph or two, cut at a sentence end.
function summary(html, title, max) {
  const paras = String(html || '')
    .split(/<\/p>|<br\s*\/?>/i)
    .map(p => p.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim())
    .filter(p => p && p.toLowerCase() !== String(title || '').toLowerCase() && !String(title || '').toLowerCase().startsWith(p.toLowerCase()));
  let out = '';
  for (const p of paras) {
    if (out && (out + ' ' + p).length > max) break;
    out = out ? out + ' ' + p : p;
  }
  if (out.length > max) {
    const cut = out.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    out = end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
  }
  return out;
}

function niceDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00Z');
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function money(pence) {
  const n = Number(pence) / 100;
  return '£' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
}

// ── Data → view model ──
function buildModel(data) {
  const siteUrl = String(data.siteUrl || '').replace(/\/+$/, '');
  const live = (data.schedule || []).map(s => ({
    title: s.course_title || s.instance_title,
    instanceTitle: s.instance_title,
    url: `/course-instance/${s.id}`,
    when: [s.schedule_day, s.schedule_time].filter(Boolean).join(' · '),
    dates: s.start_date ? (s.end_date ? `${niceDate(s.start_date)} to ${niceDate(s.end_date)}` : `From ${niceDate(s.start_date)}`) : '',
    startDate: s.start_date || null, endDate: s.end_date || null,
    courseId: s.course_id,
  }));
  const selfPaced = (data.selfPaced || []).map(c => ({
    title: c.title,
    url: `/course-instance/${c.instance_id}`,
    text: summary(c.description, c.title, 300),
    courseId: c.id,
  }));
  const meetings = (data.meetings || []).filter(m => m.active).map(m => ({
    title: m.title,
    text: String(m.description || '').trim(),
  }));
  const plans = {};
  for (const p of data.plans || []) plans[p.billing_cycle] = p.price_pence;
  return { siteUrl, live, selfPaced, meetings, plans, brand: data.brandName || 'Deeper Mindfulness', email: data.contactEmail || '' };
}

function priceLine(plans) {
  const parts = [];
  if (plans.monthly) parts.push(`${money(plans.monthly)} a month`);
  if (plans.annual) parts.push(`${money(plans.annual)} a year`);
  if (plans.lifetime) parts.push(`${money(plans.lifetime)} once, for life`);
  if (!parts.length) return '';
  return parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' or ' + parts[parts.length - 1];
}

function faqs(m) {
  const price = priceLine(m.plans);
  return [
    ['What is Deeper Mindfulness?',
      `Deeper Mindfulness is a home for mindfulness practice, founded by Per Norrgren. It offers live courses on Zoom, self-paced courses, books, and an app full of short guided practices. The practices work through the body: grounding, breath, gentle touch and movement.`],
    ['How is it different from other mindfulness apps?',
      `Most apps ask you to calm your mind. Here the practices speak to the body first, to the part of you that reacts before you have had a single thought. Everything is built on the FELT·FIBRE framework, which links traditional mindfulness, as taught in MBSR and MBCT, with current neuroscience. And you are not left to do it alone: there are live group sessions and an AI companion you can talk things through with.`],
    ['Do I need any experience?',
      `No. You can start with the short Introduction to Mindfulness course, or with one practice of a few minutes. There is nothing to force and nothing to get right.`],
    ['Can I practise with other people?',
      `Yes. There is a live practice on Zoom every Thursday at 06:30 UK time, and the live courses meet as a group, same time each week, with real faces.`],
    ['What does it cost?',
      `You can try the app free, and no card is needed.${price ? ` Membership is ${price}.` : ''} Self-paced courses are included for members. Live courses are booked on their own page.`],
    ['Who is Per Norrgren?',
      `Per is a meditation teacher, a yoga teacher and a long-term practitioner. He created the FELT·FIBRE framework, teaches one to one and in groups, supervises other mindfulness teachers, and wrote The Wired Heart and The Alarm That Would Not Stop.`],
    ['Can I teach these courses?',
      `If you have spent real time with the practice and want to offer it to others, Per would like to hear from you. See Teaching the FELT Way.`],
  ];
}

// schema.org for what's on this page. The Organization, Person and WebSite
// nodes come from the Search Visibility module, referenced here by @id.
function jsonLd(m) {
  const org = { '@id': m.siteUrl + '/#organization' };
  const courses = new Map();
  for (const c of m.selfPaced) {
    courses.set(c.courseId, {
      '@type': 'Course', name: c.title, description: c.text || c.title, url: m.siteUrl + c.url, provider: org,
      hasCourseInstance: [{ '@type': 'CourseInstance', courseMode: 'online', courseWorkload: 'Self-paced', url: m.siteUrl + c.url }],
    });
  }
  for (const l of m.live) {
    const inst = { '@type': 'CourseInstance', courseMode: 'online', url: m.siteUrl + l.url, name: l.instanceTitle, instructor: { '@id': m.siteUrl + '/#person' } };
    if (l.startDate) inst.startDate = l.startDate;
    if (l.endDate) inst.endDate = l.endDate;
    if (l.when) inst.courseSchedule = { '@type': 'Schedule', description: l.when };
    const existing = courses.get(l.courseId);
    if (existing) existing.hasCourseInstance.push(inst);
    else courses.set(l.courseId, { '@type': 'Course', name: l.title, description: l.instanceTitle || l.title, url: m.siteUrl + l.url, provider: org, hasCourseInstance: [inst] });
  }
  const graph = [];
  if (courses.size) {
    graph.push({ '@type': 'ItemList', name: 'Courses', itemListElement: Array.from(courses.values()).map((c, i) => ({ '@type': 'ListItem', position: i + 1, item: c })) });
  }
  graph.push({ '@type': 'FAQPage', mainEntity: faqs(m).map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
  graph.push(
    { '@type': 'Book', name: 'The Wired Heart', alternativeHeadline: 'When love activates fear, and how the body heals it', author: { '@id': m.siteUrl + '/#person' }, publisher: org, url: m.siteUrl + '/wired-heart' },
    { '@type': 'Book', name: 'The Alarm That Would Not Stop', alternativeHeadline: 'How your nervous system got hijacked, and how to take it back', author: { '@id': m.siteUrl + '/#person' }, publisher: org, url: m.siteUrl + '/alarm' },
  );
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}

const HERO_IMG = 'https://images.unsplash.com/photo-1505118380757-91f5f5632de0?w=1600&q=70';

function render(data) {
  const m = buildModel(data);
  const price = priceLine(m.plans);
  const year = new Date().getUTCFullYear();

  const liveCards = m.live.map(l => `
        <a class="card" href="${esc(l.url)}">
          <span class="tag">Live on Zoom</span>
          <h3>${esc(l.title)}</h3>
          ${l.when ? `<p class="meta">${esc(l.when)}</p>` : ''}
          ${l.dates ? `<p class="meta">${esc(l.dates)}</p>` : ''}
          <span class="more">See dates and book →</span>
        </a>`).join('');
  const selfCards = m.selfPaced.map(c => `
        <a class="card" href="${esc(c.url)}">
          <span class="tag">Self-paced · in the app</span>
          <h3>${esc(c.title)}</h3>
          ${c.text ? `<p>${esc(c.text)}</p>` : ''}
          <span class="more">Find out more →</span>
        </a>`).join('');
  const meetingCards = m.meetings.map(mt => `
        <div class="card plain">
          <span class="tag">Every week</span>
          <h3>${esc(mt.title)}</h3>
          ${mt.text ? `<p>${esc(mt.text).replace(/\n+/g, '<br>')}</p>` : ''}
        </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Body-based mindfulness courses | Deeper Mindfulness</title>
<meta name="description" content="Short guided practices, live Zoom courses and books by Per Norrgren that help an over-alert nervous system settle. Try the app free, no card needed.">
<link rel="icon" href="/favicon-dynamic">
<link rel="apple-touch-icon" href="/favicon-dynamic">
<link rel="manifest" href="/site.webmanifest">
<link rel="preconnect" href="https://images.unsplash.com">
<script type="application/ld+json">${jsonLd(m)}</script>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  :root { --bg:#0a0f0d; --ink:rgba(255,255,255,0.92); --soft:rgba(255,255,255,0.72); --faint:rgba(255,255,255,0.5); --mint:rgba(180,230,200,0.95); --mint-line:rgba(180,230,200,0.4); --card:rgba(255,255,255,0.05); --card-line:rgba(255,255,255,0.1); }
  html { scroll-behavior: smooth; }
  body { margin:0; font-family: Georgia, 'Times New Roman', serif; background:var(--bg); color:var(--ink); line-height:1.6; }
  a { color: var(--mint); }
  .skip { position:absolute; left:-999px; } .skip:focus { left:16px; top:16px; background:#fff; color:#000; padding:8px 12px; z-index:10; }
  header.top { position:sticky; top:0; z-index:5; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 20px; background:rgba(10,15,13,0.88); backdrop-filter:blur(8px); border-bottom:1px solid var(--card-line); }
  .wordmark { font-size:12px; letter-spacing:0.28em; text-transform:uppercase; color:var(--ink); text-decoration:none; white-space:nowrap; }
  nav.links { display:flex; gap:18px; flex-wrap:wrap; justify-content:center; }
  nav.links a { color:var(--soft); text-decoration:none; font-size:14px; }
  nav.links a:hover { color:var(--ink); }
  .login { font-size:13px; letter-spacing:0.08em; padding:8px 16px; border-radius:10px; border:1px solid var(--mint-line); color:var(--mint); text-decoration:none; white-space:nowrap; }
  .login:hover { background:rgba(180,230,200,0.12); }
  .hero { position:relative; min-height:78vh; display:flex; align-items:center; justify-content:center; text-align:center; padding:72px 20px; background: linear-gradient(180deg, rgba(6,10,8,0.55), rgba(6,10,8,0.82) 70%, var(--bg)), url('${HERO_IMG}') center/cover no-repeat; }
  .hero-inner { max-width:720px; }
  h1 { font-weight:normal; font-size:clamp(32px, 6vw, 48px); line-height:1.2; margin:0 0 20px; }
  h1 em { font-style:normal; color:var(--mint); }
  .lead { font-size:clamp(16px, 2.4vw, 19px); color:var(--soft); margin:0 auto 32px; max-width:580px; }
  .cta { display:inline-block; font-size:14px; letter-spacing:0.12em; text-transform:uppercase; padding:15px 38px; border-radius:12px; border:1px solid var(--mint-line); background:rgba(180,230,200,0.14); color:var(--mint); text-decoration:none; margin:6px; }
  .cta:hover { background:rgba(180,230,200,0.24); }
  .cta.ghost { background:transparent; border-color:var(--card-line); color:var(--soft); }
  .note { font-size:13px; color:var(--faint); margin-top:12px; }
  main section { max-width:1040px; margin:0 auto; padding:64px 20px; }
  .eyebrow { font-size:11px; letter-spacing:0.22em; text-transform:uppercase; color:rgba(180,230,200,0.75); margin:0 0 10px; text-align:center; }
  h2 { font-weight:normal; font-size:clamp(24px, 4vw, 32px); line-height:1.3; text-align:center; margin:0 0 14px; }
  .intro { color:var(--soft); text-align:center; max-width:640px; margin:0 auto 36px; font-size:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:18px; }
  .card { display:flex; flex-direction:column; gap:8px; background:var(--card); border:1px solid var(--card-line); border-radius:18px; padding:24px; text-decoration:none; color:var(--ink); transition:border-color .2s, background .2s; }
  a.card:hover { border-color:var(--mint-line); background:rgba(255,255,255,0.07); }
  .card h3 { font-weight:normal; font-size:20px; line-height:1.35; margin:0; }
  .card p { margin:0; color:var(--soft); font-size:15px; }
  .card .meta { color:var(--ink); font-size:14px; }
  .tag { font-size:11px; letter-spacing:0.14em; text-transform:uppercase; color:rgba(180,230,200,0.8); }
  .more { margin-top:auto; padding-top:8px; color:var(--mint); font-size:14px; }
  .sub { font-size:13px; letter-spacing:0.16em; text-transform:uppercase; color:var(--faint); margin:34px 0 14px; }
  .pillars { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:18px; }
  .pillar h3 { font-size:18px; }
  .band { background:rgba(255,255,255,0.025); box-shadow:0 0 0 100vmax rgba(255,255,255,0.025); clip-path:inset(0 -100vmax); }
  .price { text-align:center; font-size:18px; margin:6px 0 22px; }
  .center { text-align:center; }
  .faq { max-width:760px; margin:0 auto; }
  .faq details { border-bottom:1px solid var(--card-line); padding:16px 0; }
  .faq summary { cursor:pointer; font-size:18px; list-style:none; }
  .faq summary::-webkit-details-marker { display:none; }
  .faq summary::after { content:'+'; float:right; color:var(--mint); }
  .faq details[open] summary::after { content:'–'; }
  .faq p { color:var(--soft); margin:10px 0 0; }
  .about { display:grid; grid-template-columns:1fr; gap:10px; max-width:720px; margin:0 auto; text-align:center; color:var(--soft); }
  footer { border-top:1px solid var(--card-line); padding:40px 20px 56px; text-align:center; color:var(--faint); font-size:14px; }
  footer nav { display:flex; flex-wrap:wrap; justify-content:center; gap:10px 20px; margin-bottom:18px; }
  footer a { color:var(--soft); text-decoration:none; }
  footer a:hover { color:var(--ink); }
  @media (max-width: 760px) {
    header.top { flex-wrap:wrap; justify-content:space-between; }
    nav.links { order:3; width:100%; justify-content:flex-start; gap:14px; overflow-x:auto; flex-wrap:nowrap; padding-bottom:2px; }
    nav.links a { white-space:nowrap; }
    main section { padding:48px 16px; }
  }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <a class="wordmark" href="/">${esc(m.brand)}</a>
  <nav class="links" aria-label="Main">
    <a href="#courses">Courses</a>
    <a href="#live">Live practice</a>
    <a href="#books">Books</a>
    <a href="#app">The app</a>
    <a href="#teach">Teach</a>
    <a href="#questions">Questions</a>
  </nav>
  <a class="login" href="/login">Log in</a>
</header>

<div class="hero">
  <div class="hero-inner">
    <p class="eyebrow">Making the practices land and last for life</p>
    <h1>Mindfulness that works <em>through the body</em></h1>
    <p class="lead">Your nervous system doesn't calm down because you decided to think differently. It calms down through the body. Short guided practices, live groups, courses and books by Per Norrgren, built on the FELT·FIBRE framework.</p>
    <a class="cta" href="/register">Try it free</a>
    <a class="cta ghost" href="#courses">See the courses</a>
    <p class="note">Free to explore. No card needed.</p>
  </div>
</div>

<main id="main">
  <section aria-labelledby="what">
    <p class="eyebrow">What this is</p>
    <h2 id="what">Practices that meet you where you are</h2>
    <p class="intro">Grounding, breath, gentle touch and movement, a few minutes at a time. They speak to the part of you that reacts before you've had a single thought about it.</p>
    <div class="pillars">
      <div class="card plain pillar"><h3>Body first</h3><p>Your body learns from what it feels, not from being told. So the practices give it something to feel: steadiness, warmth, a moment of safety.</p></div>
      <div class="card plain pillar"><h3>You're not doing this alone</h3><p>Loneliness isn't a side effect here. It's something the practices work on directly, with live group sessions and real faces.</p></div>
      <div class="card plain pillar"><h3>Old roots, new science</h3><p>Traditional mindfulness, as taught in MBSR and MBCT, linked with what neuroscience now shows about how the body settles.</p></div>
    </div>
  </section>

  <section id="courses" class="band" aria-labelledby="courses-h">
    <p class="eyebrow">Courses</p>
    <h2 id="courses-h">Learn it properly, step by step</h2>
    <p class="intro">Join a live group on Zoom, or work through a course in the app at your own pace. Either way you're never just handed a technique and left to use it alone.</p>
    ${m.live.length ? `<p class="sub">Live courses</p><div class="grid">${liveCards}</div>` : ''}
    ${m.selfPaced.length ? `<p class="sub">Self-paced courses · free for members</p><div class="grid">${selfCards}</div>` : ''}
    <p class="center" style="margin-top:28px"><a href="/courses">All courses and dates →</a></p>
  </section>

  <section id="live" aria-labelledby="live-h">
    <p class="eyebrow">Live practice</p>
    <h2 id="live-h">Practise together, same time each week</h2>
    <p class="intro">Real people, live, on Zoom. Come as you are.</p>
    ${meetingCards ? `<div class="grid">${meetingCards}</div>` : `<p class="center">Live sessions are listed in the app.</p>`}
  </section>

  <section id="books" class="band" aria-labelledby="books-h">
    <p class="eyebrow">Books by Per Norrgren</p>
    <h2 id="books-h">Why the body stays on alert, and what reaches it</h2>
    <div class="grid">
      <a class="card" href="/wired-heart">
        <span class="tag">Book · FELT·FIBRE</span>
        <h3>The Wired Heart</h3>
        <p class="meta">When love activates fear, and how the body heals it</p>
        <p>Why the person you trust most can be the one your body treats as the greatest threat. And the body-level practices that change it.</p>
        <span class="more">Read more →</span>
      </a>
      <a class="card" href="/alarm">
        <span class="tag">Book and audiobook · FELT·FIBRE</span>
        <h3>The Alarm That Would Not Stop</h3>
        <p class="meta">How your nervous system got hijacked, and how to take it back</p>
        <p>You've done the practice, the therapy, the breathing. You still wake at three in the morning with your heart going. This book explains why, and what actually reaches it.</p>
        <span class="more">Read more →</span>
      </a>
    </div>
  </section>

  <section id="app" aria-labelledby="app-h">
    <p class="eyebrow">The app</p>
    <h2 id="app-h">Everything in one place, whenever your day allows</h2>
    <div class="pillars">
      <div class="card plain pillar"><h3>A library of practices</h3><p>Guided practices of a few minutes up to a full session, with a timer for silent practice and calm background sounds.</p></div>
      <div class="card plain pillar"><h3>Someone to talk it through with</h3><p>An AI companion, out loud or typed, for when something is sitting heavy. It remembers what matters to you.</p></div>
      <div class="card plain pillar"><h3>A message each day</h3><p>A short daily message from Per, to bring the practice back into an ordinary day.</p></div>
      <div class="card plain pillar"><h3>Courses included</h3><p>Self-paced courses are free for members. Take a whole course offline and practise anywhere.</p></div>
    </div>
    ${price ? `<p class="price" style="margin-top:32px">Membership: ${esc(price)}.</p>` : ''}
    <p class="center"><a class="cta" href="/register">Try it free</a> <a class="cta ghost" href="/membership">Membership</a></p>
  </section>

  <section id="teach" class="band" aria-labelledby="teach-h">
    <p class="eyebrow">For teachers</p>
    <h2 id="teach-h">Teach the FELT way</h2>
    <p class="intro">If you've spent real time with the practice and want to offer it to others, you can teach these courses with the full reasoning behind every session, a live thinking partner while you teach, and your students' progress in one place.</p>
    <p class="center"><a class="cta ghost" href="/teaching-the-felt-way">Teaching the FELT Way</a></p>
  </section>

  <section aria-labelledby="about-h">
    <p class="eyebrow">About</p>
    <h2 id="about-h">Per Norrgren</h2>
    <div class="about">
      <p>Per is a meditation teacher, a yoga teacher and a long-term practitioner. He created the FELT·FIBRE framework, which brings traditional mindfulness together with current neuroscience. He teaches one to one and in groups, supervises other mindfulness teachers, and wrote The Wired Heart and The Alarm That Would Not Stop.</p>
    </div>
  </section>

  <section id="questions" class="band" aria-labelledby="faq-h">
    <p class="eyebrow">Questions</p>
    <h2 id="faq-h">Questions people ask</h2>
    <div class="faq">
      ${faqs(m).map(([q, a], i) => `<details${i === 0 ? ' open' : ''}><summary>${esc(q)}</summary><p>${esc(a).replace('Teaching the FELT Way.', '<a href="/teaching-the-felt-way">Teaching the FELT Way</a>.')}</p></details>`).join('\n      ')}
    </div>
  </section>
</main>

<footer>
  <nav aria-label="Site">
    <a href="/courses">Courses</a>
    <a href="/membership">Membership</a>
    <a href="/wired-heart">The Wired Heart</a>
    <a href="/alarm">The Alarm That Would Not Stop</a>
    <a href="/teaching-the-felt-way">Teaching the FELT Way</a>
    <a href="/samurai">The Modern Samurai</a>
    <a href="/welcome">Why the body</a>
    <a href="/legal">Legal</a>
    <a href="/login">Log in</a>
  </nav>
  ${m.email ? `<p><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></p>` : ''}
  <p>© ${year} ${esc(m.brand)} · Per Norrgren</p>
</footer>
</body>
</html>`;
}

module.exports = { render, summary, priceLine };
