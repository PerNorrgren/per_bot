// public_pages.js — Per App 38 (14): public pages for poems and blogs.
//
// Per's plan (13 Oct 2026): poems and blogs get their own public pages on
// deepermindfulness.org, so search engines and AI search can read them and
// they can be posted on social media with a proper preview.
//
//  - Poems (/poems/<name>): the whole poem, open to everyone, with links
//    into the app (try it free, more poems).
//  - Blogs (/blog/<name>): the opening is shown; the rest is on the page
//    but faded out behind "Continue reading". Pressing it opens a small
//    window (create a free account / log in) with the whole post visible,
//    blurred, behind it. After signing up or logging in, the person lands
//    on that same post inside the app. The page carries Google's markup for
//    content that needs an account, so search engines may read all of it.
//  - /poems and /blog list everything that is public.
//  - Old WordPress addresses (/2024/09/05/<name>/) of a public post go to
//    its new page; any other old post address goes to the home page.
//  - Each public page gets a Search entry (title, description, preview
//    picture, schema) so it is in the sitemap and shows a proper preview on
//    social media.
//
// What is public is chosen per item (admin → Content → Library → 🌐).
// The first time this runs it makes every poem public and the blogs Per
// approved (STARTER_BLOGS); after that, only the admin switch changes it.

const { parse } = require('node-html-parser');
const { makeResolver, sweepPromoLinks } = require('./fix_blog_links');

// The 39 blogs chosen for the first release (Claude's selection, approved
// by Per on 13 Oct 2026): the FELT-era posts from 2025-26 and the strongest
// 2024 ones. Generic, seasonal, leadership and quoted-text posts stay in
// the app for now.
const STARTER_BLOGS = ["d712b7b5-9f87-4a50-a3ef-5f5637a1f4e8", "b53d3aa5-928e-45aa-b775-224397e9f49b", "b22d13b9-89c4-4cfb-8956-88c016060655", "95c1f9e6-cdf7-435e-8673-fd87c793e38b", "2b0a3863-8fff-41f2-ab96-78df5edab4f4", "50d1dca5-0e72-4411-a3a7-39517e1fd447", "66280592-a389-4116-a1c1-005f0f3192a7", "f2d69181-2061-44ab-b139-de54693237ad", "ae87d755-a72c-4c58-a437-8758dff99a1c", "e8e4402e-1ad3-4e12-9091-65371b0abe72", "fd850589-ea2d-4c84-b6d2-f58d247715a8", "9c2bd272-620d-452e-953a-101c7febd7b3", "024f8c30-39a8-4375-862c-ab811aba12a0", "789d6979-5b8e-4642-a309-0b87fe8d8cea", "95d89978-b2c7-4e9f-8b9f-172ddaf01a5a", "f44fcd14-35c9-4418-8912-1bcc0fc3b128", "30f9dc6d-0979-4d69-9147-735de09fb8ca", "b5064cff-2588-4267-b42a-653b89288445", "64c6a7eb-1ce0-4e4b-a9ec-9b5ac2891539", "008ee3b6-0823-43c4-835f-dec7fdc3e4f0", "8136110c-f6e3-40a0-9e62-69d6f9e503ce", "9b42540c-2ca4-4bc8-a2e7-48705db79fe2", "cc913bbe-1ac5-452c-b0a2-cdc2c149ee01", "c5f95477-64a4-42b5-b308-8b609e577949", "324e3691-c4b8-4d66-953a-d52925b4ac4f", "2d244b66-84ac-46c5-8e1c-c19e351bee22", "e5438f52-f47d-40a6-b595-d37235323e16", "6e311a47-2981-47bc-ad4e-b356c797175a", "6a1e561a-de0e-493a-968e-682da27fd65d", "1d86cbc7-7b20-4183-975e-182985325bee", "b1a4e8f1-5a9c-47c8-b6cd-ba54d01d6bed", "b1267393-3b44-48a5-bb61-4a96a2adccb3", "8ce8e9d2-ebd0-45d1-b8c2-aec60b657871", "cbe8fe0f-0b1c-42ff-8d5a-ff1ba62681aa", "a57abfc9-0687-4325-8ac7-8c4e21cbf0d1", "20d86f43-3ccb-41ce-a7d2-96ecafb7886b", "b2ca0d1e-421c-4934-a88b-e535904ae4be", "abad0408-67d8-439e-a93d-3961edd5bd1a", "c4fb926c-0d4a-424b-bad8-62a25e41dd32"];

const KIND_PATH = { poem: 'poems', blog: 'blog' };
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textOf = el => (el.text || '').replace(/\s+/g, ' ').trim();
const cleanTitle = t => String(t || '').replace(/^(blog|poem|whitepaper|news)\s*[-–:]?\s*/i, '').replace(/\s+/g, ' ').trim();
const slugify = t => cleanTitle(t).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '') || 'untitled';
const kindOf = f => (f.content_type === 'poem' ? 'poem' : (['blog', 'whitepaper'].includes(f.content_type) ? 'blog' : null));

function mountPublicPages(app, { db, media, seoStore, invalidate = () => {}, siteUrl, heroImg, log = console.log }) {
  const SITE = String(siteUrl || 'https://deepermindfulness.org').replace(/\/+$/, '');
  let ready = false;
  function ensure() {
    if (ready) return;
    db.rawRun(`CREATE TABLE IF NOT EXISTS public_items (
      file_id TEXT PRIMARY KEY, kind TEXT NOT NULL, slug TEXT NOT NULL,
      published INTEGER NOT NULL DEFAULT 0, description TEXT, published_at TEXT,
      updated_at TEXT DEFAULT (datetime('now')))`);
    db.rawRun(`CREATE UNIQUE INDEX IF NOT EXISTS idx_public_items_slug ON public_items(kind, slug)`);
    // Per App 38 (14) — set when the weekly campaign freshens a page.
    if (!db.rawAll(`PRAGMA table_info(public_items)`).some(c => c.name === 'freshened_at')) db.rawRun(`ALTER TABLE public_items ADD COLUMN freshened_at TEXT`);
    ready = true;
  }
  const rowFor = id => { ensure(); return db.rawAll(`SELECT * FROM public_items WHERE file_id=?`, [id])[0] || null; };
  const rowBySlug = (kind, slug) => { ensure(); return db.rawAll(`SELECT * FROM public_items WHERE kind=? AND slug=? AND published=1`, [kind, slug])[0] || null; };
  const publishedRows = kind => { ensure(); return db.rawAll(`SELECT * FROM public_items WHERE published=1${kind ? ' AND kind=?' : ''} ORDER BY published_at DESC`, kind ? [kind] : []); };
  const urlFor = r => `${SITE}/${KIND_PATH[r.kind]}/${r.slug}`;
  const pathFor = r => `/${KIND_PATH[r.kind]}/${r.slug}`;

  // ── File content, cached briefly (the files rarely change) ──
  const cache = new Map();
  async function fileHtml(f) {
    const hit = cache.get(f.id);
    if (hit && hit.size === f.file_size && Date.now() - hit.at < 30 * 60 * 1000) return hit.html;
    const obj = await media.getPublicObject(f.filename);
    const chunks = []; for await (const c of obj.Body) chunks.push(Buffer.from(c));
    const html = Buffer.concat(chunks).toString('utf8');
    cache.set(f.id, { html, size: f.file_size, at: Date.now() });
    return html;
  }

  // Cleans a post or poem for its public page: no in-app footer, no title
  // (the page has its own), the "Originally published" date pulled out for
  // the byline, and in-app links to other public pieces pointed at their
  // public pages.
  function prepare(html, f) {
    const root = parse(html, { comment: false });
    const article = root.querySelector('article') || root.querySelector('body') || root;
    // The old WordPress tables of contents point into the part behind the
    // gate, so the public page goes without them.
    article.querySelectorAll('.dm-links, script, style, .wp-block-yoast-seo-table-of-contents, .wp-block-rank-math-toc-block, #rank-math-toc').forEach(el => el.remove());
    // Any stand-alone old "Try … HERE" promo lines still in the file.
    try { sweepPromoLinks(article); } catch (e) { /* page still works */ }
    let date = null;
    for (const p of article.querySelectorAll('p.meta, p')) {
      const m = textOf(p).match(/^Originally published (\d{4}-\d{2}-\d{2})/i);
      if (m) { date = m[1]; p.remove(); break; }
    }
    const t = cleanTitle(f.title).toLowerCase().replace(/[^a-z0-9]+/g, '');
    const first = article.querySelector('h1, h2, h3');
    if (first) {
      const h = cleanTitle(textOf(first)).toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (h && t && (h.includes(t) || t.includes(h))) first.remove();
    }
    for (const a of article.querySelectorAll('a[href]')) {
      const m = (a.getAttribute('href') || '').match(/^(?:https?:\/\/(?:www\.)?deepermindfulness\.org)?\/client\/\?(?:.*&)?file=([\w-]+)/i);
      if (m) {
        const r = rowFor(m[1]);
        if (r && r.published) a.setAttribute('href', urlFor(r));
      }
    }
    let last = article.lastElementChild;
    while (last && last.tagName === 'HR') { const prev = last.previousElementSibling; last.remove(); last = prev; }
    const words = textOf(article).split(' ').filter(Boolean).length;
    return { article, date, words };
  }

  function describe(article, kind) {
    const lines = [];
    for (const p of article.querySelectorAll('p')) {
      const s = textOf(p);
      if (s.length > 20 && !/^(table of contents|contents)$/i.test(s)) lines.push(s);
      if (lines.join(' ').length > 220) break;
    }
    let d = lines.join(kind === 'poem' ? ' / ' : ' ');
    if (d.length > 158) d = d.slice(0, 155).replace(/\s+\S*$/, '') + '…';
    return d;
  }

  // ── Publish / unpublish ──
  async function setPublished(fileId, on) {
    ensure();
    const f = db.getLibraryFile(fileId);
    if (!f) throw new Error('File not found.');
    const kind = kindOf(f);
    if (!kind) throw new Error('Only poems and blogs can have a public page.');
    let r = rowFor(fileId);
    if (!r) {
      let slug = slugify(f.title), n = 2;
      while (db.rawAll(`SELECT 1 FROM public_items WHERE kind=? AND slug=?`, [kind, slug]).length) slug = `${slugify(f.title)}-${n++}`;
      db.rawRun(`INSERT INTO public_items (file_id, kind, slug, published) VALUES (?, ?, ?, 0)`, [fileId, kind, slug]);
      r = rowFor(fileId);
    }
    if (on) {
      const { article, date } = prepare(await fileHtml(f), f);
      const description = describe(article, kind);
      db.rawRun(`UPDATE public_items SET published=1, description=?, published_at=COALESCE(published_at, ?), updated_at=datetime('now') WHERE file_id=?`,
        [description, date || null, fileId]);
    } else {
      db.rawRun(`UPDATE public_items SET published=0, updated_at=datetime('now') WHERE file_id=?`, [fileId]);
    }
    r = rowFor(fileId);
    syncSearchEntry(r, f);
    return { ...r, url: r.published ? urlFor(r) : null };
  }

  function syncSearchEntry(r, f) {
    const path = pathFor(r);
    const existing = seoStore.listPages().find(p => p.path === path);
    if (!r.published) { if (existing) seoStore.deletePage(existing.id); invalidate(); return; }
    const title = cleanTitle(f.title);
    const url = urlFor(r);
    const person = { '@type': 'Person', name: 'Per Norrgren', url: SITE };
    const schema = r.kind === 'poem'
      ? { '@type': 'CreativeWork', genre: 'Poetry', name: title, headline: title, url, author: person, inLanguage: 'en-GB',
          datePublished: r.published_at || undefined, isAccessibleForFree: true, image: heroImg }
      : { '@type': 'BlogPosting', headline: title, description: r.description, url, mainEntityOfPage: url, author: person,
          publisher: { '@type': 'Organization', name: 'Deeper Mindfulness', url: SITE }, inLanguage: 'en-GB',
          datePublished: r.published_at || undefined, dateModified: String(r.freshened_at || r.published_at || '').slice(0, 10) || undefined, image: heroImg,
          isAccessibleForFree: false,
          hasPart: { '@type': 'WebPageElement', isAccessibleForFree: false, cssSelector: '.paywalled' } };
    seoStore.savePage({
      id: existing ? existing.id : undefined, path,
      title: r.kind === 'poem' ? `${title}: a poem by Per Norrgren` : `${title} | Per Norrgren`,
      description: r.description || '', image_url: heroImg, og_type: 'article',
      schema_type: schema['@type'], schema_json: JSON.stringify(schema), in_sitemap: 1, in_llms: 1, priority: r.kind === 'blog' ? 0.7 : 0.6,
    });
    invalidate();
  }

  // First run: every poem and the starter blogs.
  async function seedOnce() {
    ensure();
    if (seoStore.getSettings().publicPagesSeeded) return;
    const all = db.getLibraryFiles({ includeArchived: false }) || [];
    const ids = all.filter(f => f.content_type === 'poem' && f.file_type === 'text/html').map(f => f.id)
      .concat(STARTER_BLOGS.filter(id => all.some(f => f.id === id)));
    let ok = 0, failed = 0;
    for (const id of ids) {
      try { await setPublished(id, true); ok++; } catch (e) { failed++; log(`[public] could not publish ${id}: ${e.message}`); }
    }
    syncIndexEntries();
    if (!failed) seoStore.saveSettings({ publicPagesSeeded: new Date().toISOString() });
    log(`[public] first release: ${ok} poems and blogs now have public pages${failed ? `; ${failed} failed (tried again at the next restart)` : ''}.`);
  }

  function syncIndexEntries() {
    for (const [path, title, description] of [
      ['/poems', 'Poems by Per Norrgren', 'Poems by Per Norrgren on stillness, the body, kindness and coming home to the present moment.'],
      ['/blog', 'Blog: Per Norrgren on the body, the mind and how they settle', 'Writing by Per Norrgren on why the body stays on alert, how emotions are made, and small practices that help.'],
    ]) {
      const existing = seoStore.listPages().find(p => p.path === path);
      if (existing) continue;
      seoStore.savePage({ path, title, description, image_url: heroImg, og_type: 'website', schema_type: 'CollectionPage',
        schema_json: JSON.stringify({ '@type': 'CollectionPage', name: title, url: SITE + path }), in_sitemap: 1, in_llms: 1, priority: 0.7 });
    }
    invalidate();
  }

  // ── Page shell (matches the Learn pages) ──
  const CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  :root { --bg:#0a0f0d; --ink:rgba(255,255,255,0.92); --soft:rgba(255,255,255,0.76); --faint:rgba(255,255,255,0.5); --mint:rgba(180,230,200,0.95); --mint-line:rgba(180,230,200,0.4); --card:rgba(255,255,255,0.05); --card-line:rgba(255,255,255,0.1); }
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
  article h2, article h3 { font-weight:normal; line-height:1.3; margin:40px 0 12px; color:var(--ink); }
  article h2 { font-size:clamp(22px, 3.6vw, 27px); } article h3 { font-size:21px; }
  article p, article li { font-size:18px; color:var(--soft); }
  article p { margin:0 0 18px; }
  article ul, article ol { padding-left:22px; }
  article img, article iframe { max-width:100%; }
  article hr { border:0; border-top:1px solid var(--card-line); margin:32px 0; }
  article .wp-block-yoast-seo-table-of-contents, article .wp-block-rank-math-toc-block { padding:14px 20px; border-radius:14px; background:var(--card); border:1px solid var(--card-line); margin:0 0 28px; }
  article .wp-block-yoast-seo-table-of-contents h2 { margin:0 0 6px; font-size:16px; letter-spacing:0.06em; text-transform:uppercase; color:var(--faint); }
  article .wp-block-yoast-seo-table-of-contents li, article .wp-block-rank-math-toc-block li { font-size:15px; }
  .poem p { font-size:19px; color:var(--ink); }
  .paywalled { position:relative; max-height:240px; overflow:hidden; }
  .paywalled::after { content:''; position:absolute; left:0; right:0; bottom:0; height:200px; background:linear-gradient(to bottom, rgba(10,15,13,0), var(--bg)); }
  .gate { text-align:center; margin:6px 0 10px; }
  .gate p { color:var(--faint); font-size:14px; margin:10px 0 0; }
  .cta { display:inline-block; font-size:14px; letter-spacing:0.1em; text-transform:uppercase; padding:14px 26px; border-radius:12px; border:1px solid var(--mint-line); background:rgba(180,230,200,0.12); color:var(--mint); text-decoration:none; cursor:pointer; font-family:inherit; }
  .cta.ghost { background:transparent; }
  .more { margin-top:46px; padding:22px 24px; border-radius:18px; background:var(--card); border:1px solid var(--card-line); }
  .more h2 { margin:0 0 8px; font-size:20px; font-weight:normal; }
  .more p { font-size:16px; margin:0 0 10px; color:var(--soft); }
  .list { display:grid; gap:14px; margin-top:28px; }
  .item { display:block; padding:20px 22px; border-radius:16px; background:var(--card); border:1px solid var(--card-line); text-decoration:none; color:var(--ink); }
  .item:hover { border-color:var(--mint-line); }
  .item h2 { margin:0 0 6px; font-size:20px; font-weight:normal; }
  .item p { margin:0; font-size:15px; color:var(--soft); }
  body.gate-open .paywalled { max-height:none; }
  body.gate-open .paywalled::after { display:none; }
  body.gate-open .gate { display:none; }
  body.gate-open main article { filter:blur(2.5px); }
  .gate-modal { display:none; position:fixed; inset:0; z-index:20; background:rgba(5,8,7,0.55); align-items:center; justify-content:center; padding:20px; }
  body.gate-open .gate-modal { display:flex; }
  .gate-card { position:relative; max-width:420px; width:100%; background:#101613; border:1px solid var(--mint-line); border-radius:20px; padding:30px 26px 26px; text-align:center; box-shadow:0 20px 60px rgba(0,0,0,0.6); }
  .gate-card h2 { font-weight:normal; font-size:24px; margin:0 0 10px; }
  .gate-card p { color:var(--soft); font-size:16px; margin:0 0 20px; }
  .gate-card .cta { display:block; margin:10px 0 0; }
  .gate-close { position:absolute; top:10px; right:14px; background:none; border:0; color:var(--faint); font-size:26px; cursor:pointer; }
  footer { border-top:1px solid var(--card-line); padding:36px 20px 52px; text-align:center; color:var(--faint); font-size:14px; }
  footer a { color:var(--soft); text-decoration:none; margin:0 10px; }
  @media (max-width:760px) { nav.links { display:none; } article p, article li { font-size:17px; } }
  `;

  function shell(title, description, inner, extraHead = '') {
    return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="/favicon-dynamic">
<link rel="apple-touch-icon" href="/favicon-dynamic">
${extraHead}
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <a class="wordmark" href="/">Deeper Mindfulness</a>
  <nav class="links" aria-label="Main">
    <a href="/courses">Courses</a>
    <a href="/blog">Blog</a>
    <a href="/poems">Poems</a>
    <a href="/learn">Learn</a>
    <a href="/#app">The app</a>
  </nav>
  <a class="login" href="/login">Log in</a>
</header>
${inner}
<footer>
  <a href="/">Home</a><a href="/blog">Blog</a><a href="/poems">Poems</a><a href="/learn">Learn</a><a href="/courses">Courses</a><a href="/login">Log in</a>
  <p>© ${new Date().getUTCFullYear()} Deeper Mindfulness · Per Norrgren</p>
</footer>
</body>
</html>`;
  }

  const niceDate = iso => { const d = new Date(String(iso || '').slice(0, 10) + 'T12:00:00Z'); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); };
  const inApp = (f, src) => ({
    register: `/register?src=${encodeURIComponent(src)}&next=${encodeURIComponent('/client/?file=' + f.id)}`,
    login: `/login?next=${encodeURIComponent('/client/?file=' + f.id)}`,
  });

  // Splits a blog into what everyone sees and what is behind the gate:
  // about a third of the post, at least 150 and at most 450 words, ending
  // at a whole paragraph.
  function split(article, words) {
    const target = Math.max(150, Math.min(450, Math.round(words * 0.35)));
    const kids = article.childNodes.filter(n => n.nodeType === 1 || textOf(n));
    let count = 0, cut = kids.length;
    for (let i = 0; i < kids.length; i++) {
      count += textOf(kids[i]).split(' ').filter(Boolean).length;
      if (count >= target && kids[i].tagName === 'P') { cut = i + 1; break; }
    }
    if (cut >= kids.length - 1) cut = Math.max(1, Math.floor(kids.length * 0.4));
    return { lead: kids.slice(0, cut).map(n => n.toString()).join('\n'), rest: kids.slice(cut).map(n => n.toString()).join('\n') };
  }

  async function renderItem(r) {
    const f = db.getLibraryFile(r.file_id);
    if (!f || f.archived) return null;
    const { article, date, words } = prepare(await fileHtml(f), f);
    const title = cleanTitle(f.title);
    // Only a real first-published date (from the old site); the import date
    // into the app would be misleading.
    const when = date ? niceDate(date) : '';
    const updated = r.freshened_at ? niceDate(r.freshened_at) : '';
    const links = inApp(f, `${r.kind}-${r.slug}`.slice(0, 60));
    if (r.kind === 'poem') {
      return shell(`${title}: a poem by Per Norrgren`, r.description || '', `<main>
  <div class="crumbs"><a href="/">Home</a> · <a href="/poems">Poems</a></div>
  <article class="poem">
    <h1>${esc(title)}</h1>
    <div class="byline">A poem by Per Norrgren${when ? ' · ' + esc(when) : ''}</div>
    ${article.innerHTML}
  </article>
  <div class="more">
    <h2>More poems, and the practices behind them</h2>
    <p>Many of the poems can be listened to in the Deeper Mindfulness app, along with short guided practices, courses and live sessions.</p>
    <p><a class="cta" href="${links.register}">Try the app free</a></p>
    <p style="margin-top:14px"><a href="/poems">More poems</a> · <a href="${links.login}">Log in</a></p>
  </div>
</main>`);
    }
    const { lead, rest } = split(article, words);
    const minutes = Math.max(2, Math.round(words / 220));
    return shell(`${title} | Per Norrgren`, r.description || '', `<main>
  <div class="crumbs"><a href="/">Home</a> · <a href="/blog">Blog</a></div>
  <article>
    <h1>${esc(title)}</h1>
    <div class="byline">Per Norrgren${when ? ' · ' + esc(when) : ''}${updated ? ' · updated ' + esc(updated) : ''} · ${minutes} minute read</div>
    ${lead}
    <div class="paywalled">${rest}</div>
  </article>
  <div class="gate">
    <a class="cta" id="continueBtn" href="${links.register}">Continue reading</a>
    <p>Free with an account. No card needed.</p>
  </div>
  <div class="more">
    <h2>More from Per</h2>
    <p><a href="/blog">More blogs</a> · <a href="/poems">Poems</a> · <a href="/learn">Learn</a></p>
  </div>
</main>
<div class="gate-modal" id="gateModal" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
  <div class="gate-card">
    <button class="gate-close" id="gateClose" aria-label="Close">×</button>
    <h2 id="gateTitle">Read the rest, free</h2>
    <p>Create a free account, or log in, and this post opens in the Deeper Mindfulness app, with the practices, courses and live sessions that go with it.</p>
    <a class="cta" href="${links.register}">Create a free account</a>
    <a class="cta ghost" href="${links.login}">Log in</a>
  </div>
</div>
<script>
  (function () {
    var b = document.body;
    document.getElementById('continueBtn').addEventListener('click', function (e) { e.preventDefault(); b.classList.add('gate-open'); });
    document.getElementById('gateClose').addEventListener('click', function () { b.classList.remove('gate-open'); });
    document.getElementById('gateModal').addEventListener('click', function (e) { if (e.target === this) b.classList.remove('gate-open'); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') b.classList.remove('gate-open'); });
  })();
</script>`);
  }

  function renderIndex(kind) {
    const rows = publishedRows(kind);
    const items = rows.map(r => {
      const f = db.getLibraryFile(r.file_id);
      if (!f || f.archived) return '';
      return `<a class="item" href="${pathFor(r)}"><h2>${esc(cleanTitle(f.title))}</h2><p>${esc(r.description || '')}</p></a>`;
    }).join('\n');
    const isPoem = kind === 'poem';
    return shell(isPoem ? 'Poems by Per Norrgren' : 'Blog | Per Norrgren',
      isPoem ? 'Poems by Per Norrgren.' : 'Writing by Per Norrgren on the body, the mind and how they settle.', `<main>
  <div class="crumbs"><a href="/">Home</a></div>
  <h1>${isPoem ? 'Poems' : 'Blog'}</h1>
  <p style="color:var(--soft);font-size:18px">${isPoem
      ? 'Poems by Per Norrgren, written alongside the practice. Many of them can be listened to in the app.'
      : 'Writing by Per Norrgren on why the body stays on alert, how feelings are made, and small practices that help.'}</p>
  <div class="list">${items || '<p>Nothing here yet.</p>'}</div>
  <div class="more"><p><a class="cta" href="/register?src=${isPoem ? 'poems-index' : 'blog-index'}">Try the app free</a></p></div>
</main>`);
  }

  // ── Routes ──
  app.get(['/poems', '/blog'], (req, res) => {
    try { res.set('Cache-Control', 'no-cache'); res.type('html').send(renderIndex(req.path === '/poems' ? 'poem' : 'blog')); }
    catch (e) { log('[public] index failed: ' + e.message); res.status(500).send('Sorry, this page could not be shown just now.'); }
  });
  app.get(['/poems/', '/blog/'], (req, res) => res.redirect(301, req.path.replace(/\/$/, '')));
  app.get(['/poems/:slug', '/blog/:slug'], async (req, res, next) => {
    try {
      const kind = req.path.startsWith('/poems/') ? 'poem' : 'blog';
      const r = rowBySlug(kind, req.params.slug);
      if (!r) return next();
      const html = await renderItem(r);
      if (!html) return next();
      res.set('Cache-Control', 'no-cache');
      res.type('html').send(html);
    } catch (e) { log('[public] page failed: ' + e.message); res.status(500).send('Sorry, this page could not be shown just now.'); }
  });
  // Old WordPress addresses.
  app.get('/:y(\\d{4})/:m(\\d{2})/:d(\\d{2})/:slug', (req, res) => {
    try {
      const all = db.getLibraryFiles({ includeArchived: false }) || [];
      const hit = makeResolver(all)(req.params.slug);
      const r = hit && rowFor(hit.id);
      res.redirect(301, r && r.published ? pathFor(r) : '/');
    } catch (e) { res.redirect(302, '/'); }
  });
  app.get(/^\/category\/(blogs?|news)(\/.*)?$/i, (req, res) => res.redirect(301, '/blog'));
  app.get(/^\/category\/poems?(\/.*)?$/i, (req, res) => res.redirect(301, '/poems'));

  // Public link for the app's Share button (no account needed: it only
  // says whether a piece has a public page and where).
  app.get('/api/public-link/:fileId', (req, res) => {
    try {
      const r = rowFor(req.params.fileId);
      res.json({ url: r && r.published ? urlFor(r) : null });
    } catch (e) { res.json({ url: null }); }
  });

  function markFreshened(fileId) { ensure(); db.rawRun(`UPDATE public_items SET freshened_at=date('now') WHERE file_id=?`, [fileId]); cache.delete(fileId); }

  return {
    ensure, setPublished, seedOnce, syncIndexEntries, markFreshened, shell,
    list: () => { ensure(); return db.rawAll(`SELECT * FROM public_items`).map(r => ({ ...r, url: r.published ? urlFor(r) : null })); },
  };
}

module.exports = { mountPublicPages, STARTER_BLOGS, slugify, cleanTitle };
