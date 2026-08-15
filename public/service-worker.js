// Deeper Mindfulness — offline caching service worker (Per Bot 51, Phase 1)
//
// Scope: audio, PDFs, ebooks (currently single-file .epub), and
// poem/blog text — everything Phase 1 covers. Video is deliberately
// NOT handled here yet (Phase 2, flagged to Per as a separate, larger
// piece given file size).
//
// How caching works here:
// - The app never asks this file to cache anything automatically. A
//   person explicitly taps "Make available offline" on something (see
//   client/index.html), which sends this worker a CACHE_URLS message
//   with the exact list of stable URLs that one item needs (one URL
//   for audio/PDF/ebook, potentially several for a multi-resource
//   book) — that list comes from the server's own offline-manifest
//   endpoint, not guessed here.
// - Once cached, the fetch handler below serves those exact URLs from
//   cache first, network as a fallback — so it keeps working with no
//   signal at all, not just "loads faster when there is one".
// - "Auto-update if it's changed": every offline-eligible URL is served
//   with a real ETag by the server (see /offline-stream in server.js).
//   On each fetch while online, this worker does a conditional
//   request — the server returns 304 Not Modified (cheap, no re-
//   transfer) if nothing changed, or a fresh 200 body if it did, and
//   the cache is only overwritten in the latter case. Nobody has to
//   manually refresh anything for a re-recorded or edited file to
//   update on their device.
//
// App shell (Per's follow-up): the above only ever covers content
// someone explicitly marked. Without this second piece, tapping the
// installed icon with zero signal at all would show the browser's own
// generic "no internet" page before the app itself ever got a chance to
// load — there'd be nothing to open the Offline Files tab FROM. This
// precaches the app's own HTML/JS shell on install and, for any page
// navigation, tries the network first (so everyone still gets the
// latest version of the app whenever they do have signal) and only
// falls back to the cached shell when that fails — which is the one
// thing that actually makes "press the icon with no signal" work.

const CACHE_NAME = 'dm-offline-v1';
const SHELL_CACHE_NAME = 'dm-shell-v1';
// The one page the app shell falls back to for ANY failed navigation —
// this app is a single-page client (everything past login lives at
// /client/), so there's only ever one real shell to cache, not one per
// route.
const SHELL_URL = '/client/';
const SHELL_ASSET_URLS = [
  SHELL_URL,
  '/client', // both forms precached — see the fetch handler's fallback comment for why
  '/brand-inject.js',
  '/js/dialogs.js',
  '/js/call.js',
  '/js/message-editor.js',
  '/tomte-widget.js',
  '/assets/tomte.png', // default Talk persona avatar — see isShellAsset below for why a custom brand photo is also covered automatically
];

// Only these path shapes are ever cached — deliberately not "cache
// everything the app requests", since most of what the app loads
// (account data, the tier someone's on, today's content list) needs to
// always be current, never served stale from a cache.
const OFFLINE_PATH_PATTERNS = [
  /^\/api\/content\/library\/[^/]+\/offline-stream$/,
  /^\/api\/content\/library\/[^/]+\/epub-resource\//,
];

// Static brand imagery — the Tomte/persona avatar, the site favicon,
// anything served from a skin. Pattern-based rather than one exact URL,
// since the actual photo is admin-configurable (defaults to
// /assets/tomte.png, but a brand can set its own via any of these
// routes) — matching the route SHAPE means whichever one is actually in
// use gets picked up automatically, without needing to know the exact
// URL in advance.
const SHELL_ASSET_PATTERNS = [
  /^\/assets\//,
  /^\/favicon-asset\//,
  /^\/skin-assets\//,
];

function isOfflineEligible(url) {
  const path = new URL(url).pathname;
  return OFFLINE_PATH_PATTERNS.some(p => p.test(path));
}
function isShellAsset(path) {
  return SHELL_ASSET_URLS.includes(path) || SHELL_ASSET_PATTERNS.some(p => p.test(path));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE_NAME).then(cache =>
      // allSettled, not addAll — addAll fails (and caches nothing at
      // all) the moment any single URL 404s; one broken shell asset
      // shouldn't cost caching every other one that's fine.
      Promise.allSettled(SHELL_ASSET_URLS.map(u => cache.add(u)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME && n !== SHELL_CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const path = new URL(req.url).pathname;

  // App shell — page loads (req.mode==='navigate' covers typing the URL,
  // tapping the home-screen icon, and any in-app link/redirect that's a
  // full navigation) and the handful of scripts that page needs to boot
  // at all. Network-first: always prefer the live version when there's
  // any connection, cache only steps in once fetch has genuinely failed.
  if (req.method === 'GET' && (req.mode === 'navigate' || isShellAsset(path))) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE_NAME);
      try {
        const netRes = await fetch(req);
        if (netRes.ok) cache.put(req, netRes.clone());
        return netRes;
      } catch (e) {
        // A failed navigation to some other page still falls back to
        // the app shell — there's nothing else to navigate to offline,
        // and this is what makes launching the installed icon itself
        // work with zero signal. Tries the exact URL that was actually
        // requested first (covers a plain asset request failing), then
        // every plausible shell URL in turn — a page can genuinely get
        // cached under more than one of these (start_url is '/',
        // which redirects to '/login', which for an already-signed-in
        // person redirects on to '/client/' — whichever of those
        // someone's browser happened to actually load and cache
        // successfully before going offline is the one this needs to
        // find), rather than assuming only one fixed string was ever
        // the one that got cached.
        if (req.mode === 'navigate') {
          for (const url of [req.url, SHELL_URL, '/client', '/']) {
            const hit = await cache.match(url);
            if (hit) return hit;
          }
          return new Response('This app has not been opened on this device before, so there is nothing saved to open offline yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
        }
        const fallback = await cache.match(req);
        return fallback || new Response('This app has not been opened on this device before, so there is nothing saved to open offline yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  if (req.method !== 'GET' || !isOfflineEligible(req.url)) return; // everything else: normal browser behaviour, untouched

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);

    if (!navigator.onLine) {
      // No signal at all — this is the entire point of the feature.
      return cached || new Response('Offline and this item was not saved for offline use.', { status: 503 });
    }

    try {
      // Conditional request when we already have a cached copy, so an
      // unchanged file costs almost nothing to "check" — a 304 with no
      // body, not a full re-download every time it's played.
      const headers = new Headers(req.headers);
      if (cached && cached.headers.get('ETag')) {
        headers.set('If-None-Match', cached.headers.get('ETag'));
      }
      const netRes = await fetch(req, { headers });
      if (netRes.status === 304 && cached) return cached;
      if (netRes.ok) {
        cache.put(req, netRes.clone());
        return netRes;
      }
      return cached || netRes;
    } catch (e) {
      // Fetch itself threw — flaky/dropping signal rather than a clean
      // "offline" state navigator.onLine would have caught above.
      return cached || new Response('Could not reach the server, and this item was not saved for offline use.', { status: 503 });
    }
  })());
});

self.addEventListener('message', (event) => {
  const { type, urls, url } = event.data || {};

  if (type === 'CACHE_URLS') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      const results = await Promise.allSettled(
        urls.map(async (u) => {
          const res = await fetch(u);
          if (!res.ok) throw new Error(`${u}: ${res.status}`);
          // Was res.clone() — genuine bug, and almost certainly why only
          // small files (poems/blogs, a few KB) worked offline while
          // every audio file and the 18MB ebook silently failed. clone()
          // tees the response body into two independent streams; here
          // only the clone ever actually got read (by cache.put below) —
          // the original `res` was never consumed at all. For a small
          // response browsers buffer that away without issue, but for a
          // large streamed response (this is a direct R2 pipe with no
          // fixed Content-Length — see /offline-stream in server.js)
          // leaving one branch of a tee'd stream completely unread can
          // stall or fail the other branch once internal buffering limits
          // are hit. res was never used for anything but the .ok check
          // above, so there was never a need for two copies in the first
          // place — passing the original straight to cache.put lets the
          // Cache API drain the one real stream directly, no tee at all.
          await cache.put(u, res);
        })
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      event.source && event.source.postMessage({ type: 'CACHE_URLS_DONE', total: urls.length, failed });
    })());
  }

  if (type === 'REMOVE_URLS') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(urls.map(u => cache.delete(u)));
      event.source && event.source.postMessage({ type: 'REMOVE_URLS_DONE' });
    })());
  }

  if (type === 'CHECK_CACHED') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      const match = await cache.match(url);
      event.source && event.source.postMessage({ type: 'CHECK_CACHED_RESULT', url, cached: !!match });
    })());
  }

  if (type === 'ESTIMATE_USAGE') {
    event.waitUntil((async () => {
      const estimate = (navigator.storage && navigator.storage.estimate) ? await navigator.storage.estimate() : null;
      event.source && event.source.postMessage({ type: 'ESTIMATE_USAGE_RESULT', estimate });
    })());
  }
});
