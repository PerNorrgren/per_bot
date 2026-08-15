// ── brand-inject.js ──
// Fetches this deployment's brand config once and applies it wherever a page
// has opted in via data-brand attributes, so Path-A clones (a facilitator's
// own deployment, e.g. Rotterdam UAS) show their own name instead of a
// hardcoded "Deeper Mindfulness" baked into every page's HTML.
//
// USAGE — add to any page:
//   <script src="/brand-inject.js"></script>
//   <span data-brand="name">Deeper Mindfulness</span>       -- brand/marketing name
//   <span data-brand="tagline">...</span>                   -- tagline
//   <span data-brand="entity">Per Norrgren trading as...</span> -- legal trading entity (GDPR/consent copy, legal page chrome)
//   <img data-brand="logo" src="...">                       -- only swapped if a logoUrl is configured
//
// The text already in the HTML is the fallback — if the config fetch fails
// (offline, slow first load, whatever), the page still reads correctly with
// Per's own name rather than breaking or showing nothing.
//
// For pages that need the brand name in their OWN dynamic logic (e.g.
// legal.html sets document.title after an async document load, so the
// generic <title> patch below would just get overwritten) — await
// window.brandReady and use cfg.brandName directly.
//
// ── Skins (Per Bot 20) ──
// A "skin" is a lighter-weight, additional brand layer on top of all the
// above — for a specific group (e.g. a Rotterdam University cohort)
// within this SAME deployment, not a separate Path-A clone. Once someone
// registers through a skin-specific URL, their account remembers it
// (users.skin_id) and /api/config itself resolves it for them server-side
// on every future request — that's what makes it "persistent" without
// this file needing to do anything special for a logged-in visit.
// The one thing server-side resolution CAN'T do is the brief pre-login
// window on /login/:slug or /register/:slug, before there's a cookie to
// read — this file detects that slug from the URL itself and fetches
// /api/skins/:slug directly, which is the only skin-specific logic here.
window.brandReady = (function() {
  var pathMatch = window.location.pathname.match(/^\/(?:login|register)\/([a-z0-9-]+)/i);
  var skinSlug = pathMatch ? pathMatch[1] : null;
  window.__skinSlug = skinSlug;

  var CONFIG_CACHE_KEY = 'dm_brand_config_cache';
  var configPromise = fetch('/api/config').then(function(r) { return r.json(); }).then(function(cfg) {
    // Per's report — What's New (and anything else riding on this same
    // config) went blank offline rather than showing what it last had.
    // The .catch() at the bottom of this file already existed as a
    // fallback, but it only ever had generic hardcoded defaults to fall
    // back to (brand name, tagline) — nothing that knew about
    // whatsNewItems or anything else server-specific. Caching the real
    // response here means that catch can use actual last-known data
    // instead of a blank slate.
    try { localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(cfg)); } catch (e) {}
    return cfg;
  });
  var skinPromise = skinSlug
    ? fetch('/api/skins/' + encodeURIComponent(skinSlug)).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; })
    : Promise.resolve(null);

  return Promise.all([configPromise, skinPromise]).then(function(results) {
    var cfg = results[0] || {};
    var skin = results[1];

    var name    = (skin && skin.name) || cfg.brandName || 'Deeper Mindfulness';
    var tagline = cfg.tagline || 'Making the practices land and last for life.';
    var entity  = cfg.legalEntityName || 'Per Norrgren trading as Deeper Mindfulness';
    var logoUrl = (skin && skin.logoUrl) || cfg.logoUrl;

    document.querySelectorAll('[data-brand="name"]').forEach(function(el)    { el.textContent = name; });
    document.querySelectorAll('[data-brand="tagline"]').forEach(function(el) { el.textContent = tagline; });
    document.querySelectorAll('[data-brand="entity"]').forEach(function(el)  { el.textContent = entity; });
    if (logoUrl) {
      document.querySelectorAll('[data-brand="logo"]').forEach(function(el) {
        if (el.tagName === 'IMG') el.src = logoUrl;
      });
    }
    // Favicon on a pre-login skin page — /favicon-dynamic can't know who
    // this is yet (no account, no cookie), so the <link> tag is patched
    // directly here instead, only when a skin was actually found.
    if (skin && skin.faviconUrl) {
      document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(function(el) { el.href = skin.faviconUrl; });
    }
    // Background images "playing" — exposed for whichever page's own
    // slideshow script wants to use them instead of its default set (see
    // login.html/register.html/client/index.html). Deliberately not
    // wired up automatically here since each page's slideshow already has
    // its own DOM/timing; this just makes the list available.
    window.__skinBackgroundImages = (skin && skin.backgroundImages && skin.backgroundImages.length) ? skin.backgroundImages
      : ((cfg.backgroundImages && cfg.backgroundImages.length) ? cfg.backgroundImages : null);
    if (document.title.indexOf('Deeper Mindfulness') !== -1) {
      document.title = document.title.split('Deeper Mindfulness').join(name);
    }
    if (skin) {
      cfg.brandName = name; cfg.appName = name; cfg.logoUrl = logoUrl;
      cfg.faviconUrl = skin.faviconUrl || cfg.faviconUrl;
      cfg.primaryColor = skin.primaryColor || cfg.primaryColor;
      cfg.skinSlug = skinSlug; cfg.skinContactName = skin.contactName; cfg.skinContactEmail = skin.contactEmail;
    }
    return cfg;
  }).catch(function(e) {
    console.error('brand-inject: could not load config, falling back to defaults', e);
    // Per's report — fall back to the real last-known config (from
    // localStorage, cached above) rather than generic hardcoded
    // defaults, so anything riding on window.brandReady (What's New,
    // etc.) can still show real content offline instead of going blank.
    try {
      var cached = JSON.parse(localStorage.getItem('dm_brand_config_cache') || 'null');
      if (cached) return cached;
    } catch (e2) {}
    return { brandName: 'Deeper Mindfulness', tagline: 'Making the practices land and last for life.', legalEntityName: 'Per Norrgren trading as Deeper Mindfulness' };
  });
})();
