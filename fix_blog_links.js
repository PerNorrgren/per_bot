// Per App 38 (10) — Per's request (13 Oct 2026): the blog posts imported
// from the old WordPress site still carry that site's links — App Store and
// Google Play badges for the old app (their images no longer load), "See
// more Blogs" and "Join our mailing list" buttons, links to old pages that
// no longer exist, and links to other old posts by their WordPress address.
//
// For each blog post this:
//  - removes the old app download section (heading, badges, "Click QR
//    image…" text) and its entry in the table of contents
//  - removes mailing-list, "More Blogs" and "free courses" footer links and
//    buttons, and any images that pointed at the old site (they no longer load)
//  - turns a link to another old post into a link that opens that post here
//    in the app (/client/?file=<id>); if the post is not in the app the
//    words stay and only the link goes
//  - keeps the words of any other link to an old page, without the link
//  - adds one short footer: More blogs (the app's own list) and the app itself
//
// The original of every file it changes is kept in storage under
// library-backup/blog-links/ first, so any post can be put back. Each post
// is done once (remembered by id), and a post that already has the new
// footer is never changed again.
//
// Per App 38 (12): white papers too (cleaner headings, dead "read the
// white papers" lines removed), and course material pages such as the
// lesson notes (old links and images only, no footer).
//
// Per App 38 (11): poems get the same treatment, with a "More poems" link,
// and a poem whose heading was removed by an earlier clean-up gets its
// title back as the heading.

const { parse } = require('node-html-parser');

// Includes the misspelt addresses some posts used (depermindfulness, deepermidfulness).
const OLD_HOSTS = /^(www\.)?de+perm[a-z]*fulness\.(org|net)$/i;
const FOOTER_CLASS = 'dm-links';
const APP_URL = 'https://deepermindfulness.org/';

function classify(href) {
  const h = (href || '').trim();
  if (!h || h.startsWith('#') || h.startsWith('/client') || h.startsWith('mailto:')) return { kind: 'keep' };
  if (/^https?:\/\/(www\.)?deepermindfulness\.org\/client\b/i.test(h)) return { kind: 'keep' };
  let u;
  try { u = new URL(h); } catch (e) { return { kind: 'keep' }; }
  const host = u.hostname;
  if (/apps\.apple\.com$/i.test(host) || /play\.google\.com$/i.test(host)) return { kind: 'store' };
  if (/sibforms\.com$/i.test(host)) return { kind: 'mailing' };
  if (/zoom\.us$/i.test(host)) return { kind: 'dead' };
  // The old WordPress staging copy is gone too.
  if (/wpcomstaging\.com$/i.test(host)) return { kind: 'dead' };
  if (!OLD_HOSTS.test(host)) return { kind: 'external' };
  const p = u.pathname.replace(/\/+$/, '');
  if (!p || p === '') return { kind: 'home' };
  if (/^\/(subscription-form|subscribe)$/i.test(p) || u.searchParams.has('ff_landing')) return { kind: 'mailing' };
  if (/^\/category\//i.test(p)) return { kind: 'moreblogs' };
  const m = p.match(/^\/20\d\d\/\d\d\/\d\d\/([^/]+)$/);
  if (m) return { kind: 'post', slug: m[1] };
  if (/^\/[a-z0-9-]+$/i.test(p) && !/^\/(events|products__trashed|wp-content)/i.test(p)) return { kind: 'post', slug: p.slice(1) };
  return { kind: 'dead' };
}

const textOf = el => (el.text || '').replace(/\s+/g, ' ').trim();

function removeIfEmpty(el, stopAt) {
  let cur = el;
  while (cur && cur !== stopAt && cur.tagName) {
    const hasMedia = cur.querySelector && cur.querySelector('img, iframe, video, audio');
    if (textOf(cur).replace(/[\s|•·,–-]/g, '').length > 1 || hasMedia) break;
    const parent = cur.parentNode;
    cur.remove();
    cur = parent;
  }
}

// The words in an element that are not inside a link.
function ownText(el) {
  let t = textOf(el);
  for (const a of el.querySelectorAll('a')) t = t.replace(textOf(a), '');
  return t.replace(/[\s|•·,.:;!–-]+/g, ' ').trim();
}

// Promo lines such as "Try Deeper Mindfulness Community HERE" / "FREE Live
// and Recorded Mindfulness Courses HERE" that point to the site's front
// page and stand on their own (no sentence around them): the new footer
// already covers them.
function sweepPromoLinks(article) {
  let n = 0;
  for (const a of article.querySelectorAll('a')) {
    if (!a.parentNode || a.closest('.' + FOOTER_CLASS)) continue;
    const c = classify(a.getAttribute('href') || '');
    const toApp = c.kind === 'home' || (a.getAttribute('href') || '').trim().replace(/\/+$/, '') === APP_URL.replace(/\/+$/, '');
    if (!toApp) continue;
    const box = a.closest('p, li, div, figure') || a.parentNode;
    if (ownText(box).length > 3) continue;
    if (/^de+perm[a-z]*fulness\.(org|net)$/i.test(textOf(a))) continue;
    const parent = a.parentNode;
    a.remove(); n++;
    removeIfEmpty(parent, article);
  }
  return n;
}

const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// resolve(slug) → { id, title } or null. opts.kind is 'blog' or 'poem';
// opts.title is the library title, used when the file has no heading.
function transformBlogHtml(html, resolve, opts = {}) {
  // 'material' (course lesson notes): links and old images only — no
  // footer, no heading, and only changed if something was actually found.
  const kind = ['poem', 'whitepaper', 'material'].includes(opts.kind) ? opts.kind : 'blog';
  const root = parse(html, { comment: false });
  const article = root.querySelector('article') || root.querySelector('body') || root;
  const stats = { removedLinks: 0, mapped: 0, unwrapped: 0, retargeted: 0, images: 0, sections: 0, footerAdded: false };
  // A file done by the first round (38 (10)) already has the footer; it
  // only gets the promo-link sweep (step 0) that came later.
  if (article.querySelector('.' + FOOTER_CLASS)) {
    const n = sweepPromoLinks(article);
    stats.removedLinks += n;
    return n ? { html: root.toString(), stats, changed: true } : { html, stats, changed: false };
  }

  // 0. Stand-alone promo links to the front page.
  stats.removedLinks += sweepPromoLinks(article);

  // 1. Old app download section: heading, its TOC entry, QR text.
  for (const h of article.querySelectorAll('h1,h2,h3,h4')) {
    if (/download the deeper mindfulness app/i.test(textOf(h))) { h.remove(); stats.sections++; }
  }
  for (const a of article.querySelectorAll('a')) {
    if (/^#download/i.test(a.getAttribute('href') || '')) {
      const li = a.closest('li');
      (li || a).remove(); stats.sections++;
    }
  }
  for (const p of article.querySelectorAll('p')) {
    if (/scan (the )?qr code|click qr image|qr code to download/i.test(textOf(p))) { p.remove(); stats.sections++; }
  }

  // 2. Images from the old site no longer load.
  for (const img of article.querySelectorAll('img, audio, video, source')) {
    const src = img.getAttribute('src') || '';
    let host = '';
    try { host = new URL(src, 'https://x.invalid').hostname; } catch (e) { /* relative */ }
    if (OLD_HOSTS.test(host) || /^\/?wp-content\//.test(src)) {
      const parent = img.parentNode;
      img.remove(); stats.images++;
      removeIfEmpty(parent, article);
    }
  }

  // 3. Links.
  for (const a of article.querySelectorAll('a')) {
    if (!a.parentNode) continue;
    const href = a.getAttribute('href') || '';
    const c = classify(href);
    const parent = a.parentNode;
    if (c.kind === 'keep') continue;
    if (c.kind === 'external') {
      a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener');
      continue;
    }
    if (c.kind === 'store' || c.kind === 'mailing' || c.kind === 'moreblogs') {
      a.remove(); stats.removedLinks++;
      removeIfEmpty(parent, article);
      continue;
    }
    if (c.kind === 'home') {
      // A sentence that sends the reader to the site keeps its link, now to
      // the app; a bare "Free courses" / "Try the app" footer link goes.
      const sentence = ownText(parent).length > 25 && parent.tagName !== 'LI';
      const bareUrl = /de+permindfulness\.(org|net)/i.test(textOf(a));
      if (sentence || bareUrl) {
        a.setAttribute('href', APP_URL);
        if (bareUrl) a.set_content('deepermindfulness.org');
        stats.retargeted++;
      } else {
        a.remove(); stats.removedLinks++;
        removeIfEmpty(parent, article);
      }
      continue;
    }
    if (c.kind === 'post') {
      const hit = resolve(c.slug) || resolve(textOf(a).toLowerCase().replace(/[^a-z0-9]+/g, '-'), true);
      if (hit) {
        a.setAttribute('href', `${APP_URL}client/?file=${hit.id}`);
        a.removeAttribute('target');
        if (/^https?:\/\//i.test(textOf(a))) a.set_content(hit.title.replace(/^(Blog|Poem)\s*[-–]?\s*/i, ''));
        stats.mapped++;
        continue;
      }
    }
    // A link named after Deeper Mindfulness or the app now goes to the app.
    if (/^(deeper mindfulness|.*\bapp\b.*)$/i.test(textOf(a))) {
      a.setAttribute('href', APP_URL);
      stats.retargeted++;
      continue;
    }
    // dead page, or a post that is not in the app: keep the words only.
    a.replaceWith(a.innerHTML);
    stats.unwrapped++;
  }

  // 4. Leftover empty WordPress button and column wrappers, stray rules.
  for (const el of article.querySelectorAll('.wp-block-buttons, .wp-block-button, .wp-block-columns, .wp-block-column, figure, p')) {
    if (el.parentNode) removeIfEmpty(el, article);
  }
  // A footer paragraph left with only line breaks and a stray letter ("s").
  for (const p of article.querySelectorAll('p')) {
    if (!p.querySelector('a, img') && textOf(p).length <= 2) p.remove();
  }
  // Trailing separators left at the very end.
  let last = article.lastElementChild;
  while (last && last.tagName === 'HR') { const prev = last.previousElementSibling; last.remove(); last = prev; }

  // 4b. White papers: "Blog - Whitepaper" left in the headings, a heading
  // repeated, and "Read the white papers HERE / click the links below"
  // lines whose links went to old pages that no longer exist.
  if (kind === 'whitepaper') {
    const seen = new Set();
    for (const h of article.querySelectorAll('h1, h2, h3')) {
      const clean = textOf(h).replace(/^blog\s*[-–:]?\s*/i, '').replace(/^white\s*paper\s*[-–:]?\s*/i, '').trim();
      const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (seen.has(key)) { h.remove(); stats.sections++; continue; }
      seen.add(key);
      if (clean !== textOf(h)) { h.set_content(esc(clean)); stats.sections++; }
    }
    for (const p of article.querySelectorAll('p')) {
      // The papers themselves were never moved over, so drop the
      // "click the links below" lead-in and the claim they can be
      // downloaded here; the papers' names stay as plain text.
      const before = p.innerHTML;
      const after = before
        .replace(/Read the white papers now\.?\s*Click the links below:?\s*(<br\s*\/?>)?/i, '')
        .replace(/(^|<br\s*\/?>)\s*-\s*(White Paper \d)/gi, '$1$2')
        .replace(/These two white papers are available to read or download\s*[—–-]\s*together, they form/i, 'Together, these two white papers form');
      if (after !== before) { p.set_content(after); stats.sections++; }
      if (p.querySelector('a')) continue;
      if (/^(read the white papers?( now)?\.?\s*(here|click the links below:?)?|read white paper \d+\b.*)$/i.test(textOf(p))) { p.remove(); stats.sections++; }
    }
  }

  if (kind === 'material') {
    const changed = stats.removedLinks + stats.mapped + stats.unwrapped + stats.retargeted + stats.images + stats.sections > 0;
    return { html: changed ? root.toString().replace(/\n\s*\n(\s*\n)+/g, '\n\n') : html, stats, changed };
  }

  // 5. A file whose heading was removed gets its title back as a heading.
  if (!article.querySelector('h1, h2, h3') && opts.title) {
    const heading = String(opts.title).replace(/^(blog|poem)\s*[-–:]?\s*/i, '').trim();
    if (heading) { article.insertAdjacentHTML('afterbegin', `<h1>${esc(heading)}</h1>\n`); stats.headingAdded = true; }
  }

  // 6. New footer.
  const more = kind === 'poem'
    ? `<a href="${APP_URL}client/?view=poems">More poems</a>`
    : `<a href="${APP_URL}client/?view=posts">More blogs</a>`;
  article.insertAdjacentHTML('beforeend',
    `\n<hr />\n<p class="${FOOTER_CLASS}">${more}<br /><a href="${APP_URL}">The Deeper Mindfulness app: courses, live sessions and practices</a></p>\n`);
  stats.footerAdded = true;

  return { html: root.toString().replace(/\n\s*\n(\s*\n)+/g, '\n\n'), stats, changed: true };
}

// WordPress slug → post id, from the original blog import manifest, for
// posts whose old web address does not match their title.
const WP_SLUGS = {"a-thouht-for-2024":"881","a-thouht-for-2024-2":"4573","the-importance-of-grounding-in-the-body-a-path-to-mindful-living-and-deeper-self-discovery":"1210","embracing-the-early-morning-practice-a-path-to-awakening":"1220","leadership-success-achieve-clarity-and-resilience-with-deeper-mindfulness":"1215","deeper-mindfulness-elevating-leadership-with-tools-for-focus-and-resilience":"1217","mastering-stoic-wisdom-control-and-acceptance-in-stoicism-and-mindfulness":"1253","embracing-the-pause-a-path-to-decentering":"1355","the-power-of-embodiment-building-trust-through-mindfulness":"1488","liberating-the-mind-from-uncertainty-deeper-mindfulness-insights":"1517","self-care-per-norgren":"1556","self-care-and-compassion":"1636","self-care-3":"1660","self-care-4-nurturing-self-care":"1690","self-care-4-nurturing-self-care-poem":"1696","self-care-blog-5-steps-to-warm-stilness-of-the-mind":"1723","news-why-does-awe-inspire-us-to-help-others":"1743","embracing-personal-growth-a-four-step-journey-of-the-soul":"1772","science-of-sleep-consciousness":"1833","wellness-wellbeing":"1865","wellbeing-and-selfcare":"1967","the-power-of-listening":"2095","boundaries-wellbeing-self-care":"2112","1-step-to-reducing-loneliness":"2165","mastering-emotions":"2173","home-practice-wellbeing-self-care":"2183","self-compassionate-touch":"2216","12-points-for-wellbeing-in-a-relationship":"2237","finding-peace-in-the-chaos":"2271","blog-feeling-tone-meditation":"2298","out-of-your-head-and-into-your-life":"2346","blog-grounded-with-kindness":"2379","mindfulness-meditation-danger":"4575","blog-power-of-forgiveness":"4579","blog-self-worth-at-work":"2398","blog-finding-purpose-in-life":"2431","blog-connection-and-belonging":"2467","controlling-relatives":"2490","proactive-hope":"2541","envision-positive-futures":"2573","blog-taking-the-first-step-and-turning-hope-into-action":"2609","can-you-shift-from-fearful-to-curious":"2638","blog-what-are-the-three-styles-of-curiosity":"5507","blog-turning-fear-to-curiosity":"2665","blog-how-a-meditation-timer-can-transform-you-practice":"5521","blog-the-secret-language-of-feeling-tone":"5558","blog-the-inflexible-self":"5566","blog-the-science-of-mindfulness":"5611","blog-can-i-get-good-at-conflict":"5662","blog-should-i-take-my-breath-seriously":"5718","blog-micro-manage-your-mind-white-papers":"5857","blog-poetry-brain-blog":"6025","blog-cant-switch-off-at-night-cognitive-shuffling-micro-movements-may-help":"6439","blog-the-error-that-heals-how-to-reprogramme-your-emotions":"6464","blog-when-full-range-movements-can-be-useful-during-emotional-overload":"6517","blog-the-alphabet-trick-that-can-still-your-mind-in-minutes":"6539","blog-rooted-strength-how-to-stand-firm-when-the-world-shakes":"6561","blog-self-expression-letting-life-move-through-you":"6579","blog-horizon-after-the-storm":"6598","blog-the-hardest-part-of-adult-relationship-the-past":"6603","blog-what-if-your-reactivity-is-not-really-you":"6633","blog-what-if-the-cure-for-loneliness-is-smaller-than-you-think":"6668","blog-what-if-the-way-you-feel-is-just-a-best-guess":"6673","blog-what-if-the-most-powerful-medicine-you-have-is-a-memory":"6764","blog-what-if-the-moment-youre-in-is-already-enough":"6804","blog-make-this-moment-meaningful":"6836","blog-ten-emotional-complexes-our-inner-world":"6862","blog-1-existential-safety-complex":"6885","blog-whitepaper-recalibrating-primitive-threat-responses":"6888","blog-2-agency-fairness-complex":"7004","blog-recalibrate-belonging-healing-the-attachment-belonging-complex-3":"7009","blog-boundaries-without-backlash":"7050","blog-loosing-my-self-worth":"7077","blog-difficult-colleagues-really":"7112","blog-not-everyone-is-a-narcissist":"7119","blog-when-you-feel-invisible":"7206","blog-when-caring-too-much-becomes-a-burden":"7245","blog-the-pain-of-being-controlling-clingy-or-emotionally-intense":"7263","blog-difficulty-trusting-your-own-feelings":"7512","blog-the-paradox-that-breaks-the-relationship":"8288"};

// Build slug → id lookup from the library: blogs by their imported file
// name (WordPress id + slug, cut at 60 characters), poems and blogs by title.
function makeResolver(files) {
  const norm = s => (s || '').toLowerCase().replace(/^(blog|poem|news)\s*[-–:]?\s*/i, '').replace(/[^a-z0-9]+/g, '');
  const entries = [];
  for (const f of files) {
    if (!['blog', 'poem', 'whitepaper'].includes(f.content_type)) continue;
    const fromName = (f.original_name || '').replace(/\.html?$/i, '').replace(/^\d+-/, '');
    if (fromName && !/^standalone-poem/.test(fromName)) entries.push([norm(fromName), f]);
    entries.push([norm(f.title), f]);
  }
  const byWpId = {};
  for (const f of files) { const m = (f.original_name || '').match(/^(\d+)-/); if (m) byWpId[m[1]] = f; }
  const out = f => f ? { id: f.id, title: f.title } : null;
  return (slug, exactOnly) => {
    const wp = WP_SLUGS[slug.trim()];
    if (wp && byWpId[wp]) return out(byWpId[wp]);
    const s = norm(slug.replace(/-/g, ' '));
    if (s.length < 8) return null;
    let hit = entries.find(([k]) => k === s);
    if (!hit && !exactOnly) hit = entries.find(([k]) => k.length >= 20 && s.length >= 20 && (s.startsWith(k) || k.startsWith(s)));
    return hit ? out(hit[1]) : null;
  };
}

async function streamToBuffer(body) {
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function fixBlogLinks({ db, media, store, log = console.log }) {
  if (!media.isConfigured()) return { skipped: 'storage not configured' };
  const settings = store.getSettings();
  const done = new Set(settings.blogLinksFixed2 || []);
  const all = db.getLibraryFiles({ includeArchived: true }) || [];
  const isMaterial = f => /^course_material/.test(f.content_type || '');
  const blogs = all.filter(f => (['blog', 'poem', 'whitepaper'].includes(f.content_type) || isMaterial(f)) && f.file_type === 'text/html' && f.storage_type === 'r2' && !done.has(f.id));
  if (!blogs.length) return fixRelativeAppLinks({ db, media, store, log, skip: new Set() });
  const resolve = makeResolver(all);
  let headings = 0;
  const total = { changed: 0, unchanged: 0, failed: 0, mapped: 0, unwrapped: 0, removedLinks: 0, images: 0 };
  for (const f of blogs) {
    try {
      const obj = await media.getPublicObject(f.filename);
      const original = await streamToBuffer(obj.Body);
      const out = transformBlogHtml(original.toString('utf8'), resolve, { kind: isMaterial(f) ? 'material' : f.content_type, title: f.title });
      if (out.changed) {
        const backupKey = 'library-backup/blog-links/' + f.filename.replace(/^.*\//, '');
        if (!(await media.objectExists(backupKey))) await media.putObject(backupKey, original, 'text/html');
        const buf = Buffer.from(out.html, 'utf8');
        await media.putObject(f.filename, buf, 'text/html');
        db.replaceLibraryFileContent(f.id, f.filename, 'text/html', buf.length, f.original_name, 'r2', f.original_pdf_filename || null);
        total.changed++;
        if (out.stats.headingAdded) headings++;
        for (const k of ['mapped', 'unwrapped', 'removedLinks', 'images']) total[k] += out.stats[k];
      } else total.unchanged++;
      done.add(f.id);
    } catch (e) {
      total.failed++;
      log(`[content] blog links: could not update "${f.title}": ${e.message}`);
    }
  }
  store.saveSettings({ blogLinksFixed2: Array.from(done) });
  await fixRelativeAppLinks({ db, media, store, log, skip: new Set(blogs.map(f => f.id)) });
  log(`[content] blog/poem/document links: ${total.changed} file(s) updated (${headings} heading(s) restored from the title, ${total.removedLinks} old links removed, ${total.mapped} now open the post in the app, ${total.unwrapped} dead links kept as plain words, ${total.images} old images removed); ${total.unchanged} had nothing to change; ${total.failed} failed (tried again at the next restart). Originals kept under library-backup/blog-links/.`);
  return total;
}

// Per App 38 (12) — the first two rounds wrote the in-app links as
// /client/?…, which only works inside the app. Opened any other way (the
// admin Open button shows the raw file from storage) they pointed at the
// storage address and failed. Files changed in this round are already
// written with the full address; this rewrites the earlier ones, once.
async function fixRelativeAppLinks({ db, media, store, log, skip }) {
  const done = new Set(store.getSettings().appLinksAbsolute || []);
  for (const id of skip) done.add(id);
  const files = (db.getLibraryFiles({ includeArchived: true }) || []).filter(f =>
    ['blog', 'poem', 'whitepaper'].includes(f.content_type) && f.file_type === 'text/html' && f.storage_type === 'r2' && !done.has(f.id));
  let fixed = 0, failed = 0;
  for (const f of files) {
    try {
      const html = (await streamToBuffer((await media.getPublicObject(f.filename)).Body)).toString('utf8');
      if (html.includes('href="/client/')) {
        const buf = Buffer.from(html.split('href="/client/').join(`href="${APP_URL}client/`), 'utf8');
        await media.putObject(f.filename, buf, 'text/html');
        db.replaceLibraryFileContent(f.id, f.filename, 'text/html', buf.length, f.original_name, 'r2', f.original_pdf_filename || null);
        fixed++;
      }
      done.add(f.id);
    } catch (e) { failed++; }
  }
  store.saveSettings({ appLinksAbsolute: Array.from(done) });
  if (fixed || failed) log(`[content] in-app links made full addresses in ${fixed} file(s)${failed ? `; ${failed} could not be read (tried again at the next restart)` : ''}.`);
  return { fixed, failed };
}

module.exports = { fixBlogLinks, transformBlogHtml, makeResolver, classify };
