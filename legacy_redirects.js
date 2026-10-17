// legacy_redirects.js — Per App 38 (24): every old WordPress address goes
// somewhere useful.
//
// Search Console (15 Oct 2026) listed 334 old addresses as "Not found" and
// 76 old share/feed variants. They come from the WordPress site: undated
// posts (/poem-silent-shore/), course lessons (/courses-4/…), events,
// membership pages, uploads, share buttons (?share=facebook) and feeds
// (/feed/). Links to them still exist on social media and other sites, so
// each one now gets a permanent redirect (301) to the closest new page:
// the poem or blog itself when it is public, otherwise its list, the
// matching course page, or the nearest section. Old test/demo pages that
// never had real content get "gone" (410) so Google drops them.
//
// Mounted last, so it only ever sees addresses nothing else answered.

const { makeResolver } = require('./fix_blog_links');

const COURSE_BY_OLD = [
  [/^(mindfulness-for-life|listen-and-learn-mindfulness|mfl|mrl)/, '/courses/mindfulness-for-life'],
  [/^(deeper-mindfulness|dm-)/, '/courses/deeper-mindfulness'],
  [/^(introduction-to-mindfulness|imfn)/, '/courses/introduction-to-mindfulness'],
  [/^(one-micro-move-ahead|mmpm)/, '/courses/introduction-to-micro-moves'],
  [/^(finding-calm)/, '/courses/finding-calm'],
  [/^(finding-joy|joy)/, '/courses/finding-joy'],
  [/^(teaching-audios)/, '/courses/mindfulness-for-life'],
];

// Pages that were never real content (WordPress demos, tests, private tools).
const GONE = /^(15-tips-increase-business|free-advertising-for-your(-online-business)?|the-next-generation-of-it-will-change-the-world|welcome-to-production|edit-csv-file-page|foodlogging|pebbles(-maps|-pdf)?|3d-flip-book|test(-\d+)*|category\/test)$/;

// Single old pages with an obvious new home.
const FIXED = {
  'about': '/#contact', 'about-2': '/#contact', 'contact': '/#contact', 'contact-2': '/#contact',
  'privacy-policy': '/legal', 'terms-of-service': '/legal', 'refund_returns': '/legal',
  'blog': '/blog', 'blog-2': '/blog', 'blogs': '/blog', 'news': '/blog',
  'a-poem': '/poems', 'poems': '/poems',
  'subscribe': '/register', 'subscription-form': '/register',
  'login': '/login', 'login-2': '/login', 'my-account': '/login', 'my-account-3': '/login', 'home': '/', 'home-2': '/',
  'membership-levels': '/membership', 'membership-checkout': '/membership', 'membership-account': '/login',
  'courses': '/courses', 'courses-4': '/courses', 'events': '/courses', 'event': '/courses', 'series': '/courses', 'organiser': '/courses',
  'felt': '/felt', 'felt-calm': '/felt', '1-existential-safety': '/felt',
  'mare': 'https://mare.deepermindfulness.org/',
  'wellbeing-gratitude': '/blog', 'meditation-timer-3': '/register',
  'meditation-timer-background-and-bells': '/register', 'meditation-player': '/register', 'meditations-3': '/register',
  'what-to-practice-v3': '/learn', 'attuned-breath-coach-abc-v2': '/learn', 'self-compassionate-touch': '/learn',
  'emotional-complexes': '/learn', 'feltfibre_paper_1': '/learn', 'mmpm-white-papers': '/learn',
  'mmpm-guided-practices-from-the-book': '/courses/introduction-to-micro-moves',
  'mmpm-a-new-way-you-can-reset-your-mind': '/courses/introduction-to-micro-moves',
  'album': '/poems', 'tag': '/blog', 'category': '/blog',
};

function mountLegacyRedirects(app, { db, publicPages, log = console.log }) {
  // Lookups are rebuilt at most once a minute (the library rarely changes).
  let cache = null, cachedAt = 0;
  function lookups() {
    if (cache && Date.now() - cachedAt < 60000) return cache;
    const files = db.getLibraryFiles({ includeArchived: false }) || [];
    const kindById = {};
    for (const f of files) kindById[f.id] = f.content_type;
    const urlById = {};
    for (const it of publicPages.list()) if (it.url) { try { urlById[it.file_id] = new URL(it.url).pathname; } catch (e) { /* skip */ } }
    cache = { resolve: makeResolver(files), kindById, urlById };
    cachedAt = Date.now();
    return cache;
  }

  // An old post slug → its public page, or the right list if it is not public.
  function forSlug(slug) {
    const { resolve, kindById, urlById } = lookups();
    const hit = resolve(slug);
    if (hit) {
      if (urlById[hit.id]) return urlById[hit.id];
      return kindById[hit.id] === 'poem' ? '/poems' : '/blog';
    }
    return null;
  }

  function target(rawPath) {
    // Drop the WordPress extras: /feed/, /comment-page-2/, /page/2/, /amp/.
    let p = decodeURIComponent(rawPath).toLowerCase()
      .replace(/\/(feed|amp|embed)\/?$/, '/')
      .replace(/\/comment-page-\d+\/?$/, '/')
      .replace(/\/page\/\d+\/?$/, '/')
      .replace(/\/+$/, '').replace(/^\/+/, '');
    if (!p) return null;
    const parts = p.split('/');
    const first = parts[0], last = parts[parts.length - 1];

    if (GONE.test(p) || GONE.test(first)) return 'GONE';

    // Uploaded files from the old site.
    if (first === 'wp-content' || first === 'wp-includes') {
      if (/felt/.test(last)) return '/felt';
      if (/finding_calm|finding-calm/.test(last)) return '/courses/finding-calm';
      if (/\.pdf$/.test(last)) return '/learn';
      return '/';
    }
    if (/^wp-|xmlrpc|wp-login/.test(first)) return 'GONE';

    // Daily posts that became the "A Poem a Day" course.
    if (/^being-here-day-\d+$/.test(first) || /^a-poem-a-day-/.test(first)) return '/courses/a-poem-a-day-for-your-nerves';

    // Course lessons: /courses-4/<course>/lessons/<lesson>/ and /lessons/<lesson>/.
    if (first === 'courses-4' || first === 'courses' || first === 'lessons') {
      const key = first === 'lessons' ? (parts[1] || '') : (parts[1] || '');
      for (const [re, to] of COURSE_BY_OLD) if (re.test(key)) return to;
      if (first === 'lessons' && /read-me-first/.test(key)) return '/courses';
      if (first !== 'courses' || parts.length > 1) return '/courses';
    }

    // Events, membership and account pages, categories and tags.
    if (['event', 'events', 'series', 'organiser'].includes(first)) return '/courses';
    if (first === 'membership-account') return '/login';
    if (first === 'membership-checkout') return '/membership';
    if (first === 'category') return /poem/.test(parts[1] || '') ? '/poems' : '/blog';
    if (first === 'tag') return '/blog';
    if (first === 'home' && parts[1] === 'my-account') return '/login';

    // Old dated posts that the dated route did not catch (cut-off addresses).
    if (/^\d{4}$/.test(first)) return forSlug(last) || (/poem/.test(last) ? '/poems' : '/blog');

    if (parts.length === 1) {
      if (FIXED[first]) return FIXED[first];
      const hit = forSlug(first);
      if (hit) return hit;
      if (/^poem|poem$/.test(first)) return '/poems';
      if (/^(blog|news)-/.test(first)) return '/blog';
      for (const [re, to] of COURSE_BY_OLD) if (re.test(first)) return to;
      if (/^mmpm/.test(first)) return '/courses/introduction-to-micro-moves';
      // Any other old post name (three or more words) was a blog post.
      if (/^[a-z0-9]+(-[a-z0-9]+){2,}$/.test(first)) return '/blog';
    }
    if (FIXED[first]) return FIXED[first];
    return null;
  }

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/admin') || req.path.startsWith('/client')) return next();
    let to;
    try { to = target(req.path); } catch (e) { log('[legacy] ' + e.message); return next(); }
    if (!to) return next();
    if (to === 'GONE') { res.set('X-Robots-Tag', 'noindex'); return res.status(410).type('text').send('This page no longer exists.'); }
    // Never redirect to the address that was asked for (no loops).
    if (to.replace(/\/$/, '') === req.path.replace(/\/$/, '')) return next();
    res.redirect(301, to);
  });

  return { target };
}

module.exports = { mountLegacyRedirects };
