// seo/index.js — Search Visibility: a portable module for any Express app.
//
// What it does
//   1. Meta + structured data: for each public page registered in admin it
//      sets <title>, meta description, canonical, Open Graph tags and
//      JSON-LD schema in the HTML on its way out — server-side, so search
//      engines and AI crawlers that don't run JavaScript still see it.
//   2. Site files: /robots.txt, /sitemap.xml and /llms.txt, generated from
//      the same page list and settings.
//   3. AI visibility check: asks Claude, ChatGPT, Perplexity and Gemini
//      (whichever have keys) the questions people actually ask, with live
//      web search on, and records whether the brand is mentioned, where it
//      ranks against named competitors, and whether the site is cited.
//      Runs on demand from admin, or weekly on a schedule.
//
// What it does not do: publish anything on its own. AI suggestions for
// titles, descriptions and schema land in the form for a person to check
// and save.
//
// Mounting (see seo/README.md for the full list of options):
//   const { mountSeo } = require('./seo');
//   mountSeo(app, { store, requireAdminApi, requireAdminPage, siteUrl, ... });
// Call it BEFORE express.static and before the routes that send pages, so
// the head injection sits in front of them.

const fs = require('fs');
const path = require('path');
const { createStore } = require('./store');
const { ENGINES, DEFAULT_MODELS, analyse, hostOf, postJson } = require('./engines');

const BASE_DEFAULTS = {
  siteUrl: '',
  siteName: '',
  orgName: '',
  orgDescription: '',
  logoUrl: '',
  personName: '',
  personJobTitle: '',
  sameAs: [],
  includeSiteSchema: true,
  brandTerms: [],
  competitorTerms: [],
  robotsDisallow: ['/admin', '/api/'],
  blockAiTraining: false,
  robotsExtra: '',
  llmsSummary: '',
  llmsExtra: '',
  engines: { claude: true, chatgpt: true, perplexity: true, gemini: true },
  models: Object.assign({}, DEFAULT_MODELS),
  checkEnabled: false,
  checkWeekday: 1,           // 0=Sunday … 6=Saturday, UTC
  maxPromptsPerRun: 25,
};

function mountSeo(app, opts) {
  opts = opts || {};
  const siteUrl = String(opts.siteUrl || '').replace(/\/+$/, '');
  const defaults = Object.assign({}, BASE_DEFAULTS, opts.defaults || {}, siteUrl ? { siteUrl } : {});
  defaults.models = Object.assign({}, DEFAULT_MODELS, (opts.defaults && opts.defaults.models) || {});
  const store = createStore(opts.store, defaults);
  const apiBase = opts.apiBase || '/api/seo-admin';
  const adminPath = opts.adminPath || '/admin/seo';
  const requireAdminApi = opts.requireAdminApi;
  const requireAdminPage = opts.requireAdminPage || opts.requireAdminApi;
  if (typeof requireAdminApi !== 'function') throw new Error('seo: mountSeo needs opts.requireAdminApi (Express middleware)');
  const keys = Object.assign({
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    perplexity: process.env.PERPLEXITY_API_KEY,
    gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY,
  }, opts.keys || {});
  const log = opts.log || ((...a) => console.log('[seo]', ...a));

  // ── Page cache for the head injector (refreshed on every page save) ──
  let pageCache = null;
  let settingsCache = null;
  function normPath(p) {
    let s = String(p || '/').split('?')[0].split('#')[0].trim();
    if (!s.startsWith('/')) s = '/' + s;
    if (s.length > 1) s = s.replace(/\/+$/, '');
    return s;
  }
  function loadCaches() {
    const m = new Map();
    for (const p of store.listPages()) m.set(normPath(p.path), p);
    pageCache = m;
    settingsCache = store.getSettings();
  }
  function invalidate() { pageCache = null; settingsCache = null; }
  function settings() { if (!settingsCache) settingsCache = store.getSettings(); return settingsCache; }
  function baseUrl(s) { return String((s || settings()).siteUrl || siteUrl || '').replace(/\/+$/, ''); }

  // ═══════════════════════════════════════════
  // 1. Head injection
  // ═══════════════════════════════════════════
  function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function siteGraph(s) {
    const url = baseUrl(s);
    const out = [];
    if (!s.includeSiteSchema || !url) return out;
    const org = { '@type': 'Organization', '@id': url + '/#organization', name: s.orgName || s.siteName, url };
    if (s.orgDescription) org.description = s.orgDescription;
    if (s.logoUrl) org.logo = s.logoUrl;
    if (s.sameAs && s.sameAs.length) org.sameAs = s.sameAs;
    if (s.personName) {
      org.founder = { '@id': url + '/#person' };
      const person = { '@type': 'Person', '@id': url + '/#person', name: s.personName, url };
      if (s.personJobTitle) person.jobTitle = s.personJobTitle;
      if (s.sameAs && s.sameAs.length) person.sameAs = s.sameAs;
      out.push(person);
    }
    out.unshift(org);
    out.push({ '@type': 'WebSite', '@id': url + '/#website', name: s.siteName || s.orgName, url, publisher: { '@id': url + '/#organization' } });
    return out;
  }

  function buildHead(page, s, reqPath) {
    const url = baseUrl(s);
    const canonical = page.canonical || (url ? url + reqPath : '');
    const tags = [];
    if (page.description) tags.push(`<meta name="description" content="${escAttr(page.description)}">`);
    if (canonical) tags.push(`<link rel="canonical" href="${escAttr(canonical)}">`);
    const ogTitle = page.title || '';
    if (ogTitle) tags.push(`<meta property="og:title" content="${escAttr(ogTitle)}">`);
    if (page.description) tags.push(`<meta property="og:description" content="${escAttr(page.description)}">`);
    if (canonical) tags.push(`<meta property="og:url" content="${escAttr(canonical)}">`);
    tags.push(`<meta property="og:type" content="${escAttr(page.og_type || 'website')}">`);
    if (s.siteName) tags.push(`<meta property="og:site_name" content="${escAttr(s.siteName)}">`);
    if (ogTitle) tags.push(`<meta name="twitter:title" content="${escAttr(ogTitle)}">`);
    if (page.description) tags.push(`<meta name="twitter:description" content="${escAttr(page.description)}">`);
    if (page.image_url) {
      tags.push(`<meta property="og:image" content="${escAttr(page.image_url)}">`);
      tags.push(`<meta name="twitter:image" content="${escAttr(page.image_url)}">`);
      tags.push(`<meta name="twitter:card" content="summary_large_image">`);
    }
    const graph = siteGraph(s);
    if (page.schema_json) {
      try {
        const extra = JSON.parse(page.schema_json);
        for (const node of [].concat(extra['@graph'] || extra)) {
          const n = Object.assign({}, node); delete n['@context'];
          graph.push(n);
        }
      } catch (e) { /* invalid JSON is refused at save time; ignore here */ }
    }
    if (graph.length) {
      const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
      tags.push(`<script type="application/ld+json" data-seo="1">${json}</script>`);
    }
    return tags.join('\n');
  }

  function injectHtml(html, page, s, reqPath) {
    if (!/<\/head>/i.test(html)) return html;
    let out = html;
    if (page.title) {
      if (/<title[^>]*>[\s\S]*?<\/title>/i.test(out)) out = out.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${escText(page.title)}</title>`);
      else out = out.replace(/<\/head>/i, `<title>${escText(page.title)}</title>\n</head>`);
    }
    // Remove what we are about to set, so a page never carries two.
    if (page.description) out = out.replace(/<meta\s+name=["']description["'][^>]*>\s*/gi, '');
    out = out.replace(/<link\s+rel=["']canonical["'][^>]*>\s*/gi, '');
    out = out.replace(/<meta\s+property=["']og:(title|description|url|type|image|site_name)["'][^>]*>\s*/gi, (m, k) =>
      (k === 'image' && !page.image_url) || (k === 'title' && !page.title) || (k === 'description' && !page.description) ? m : '');
    out = out.replace(/<meta\s+name=["']twitter:(title|description|image|card)["'][^>]*>\s*/gi, (m, k) =>
      ((k === 'image' || k === 'card') && !page.image_url) || (k === 'title' && !page.title) || (k === 'description' && !page.description) ? m : '');
    out = out.replace(/<script[^>]*data-seo=["']1["'][^>]*>[\s\S]*?<\/script>\s*/gi, '');
    return out.replace(/<\/head>/i, buildHead(page, s, reqPath) + '\n</head>');
  }

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let page;
    try {
      if (!pageCache) loadCaches();
      page = pageCache.get(normPath(req.path));
    } catch (e) { return next(); } // database not ready (boot / maintenance mode)
    if (!page) return next();
    const s = settingsCache;
    // Always send the full page (never a 304) so a browser or crawler can't
    // keep an older version from before the tags changed.
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];

    const _write = res.write, _end = res.end, _writeHead = res.writeHead;
    const chunks = [];
    let mode = null; // 'pass' | 'buffer'
    const decide = () => {
      if (mode) return mode;
      const ct = String(res.getHeader('content-type') || '');
      mode = res.statusCode === 200 && /text\/html/i.test(ct) ? 'buffer' : 'pass';
      return mode;
    };
    res.writeHead = function (code, a, b) {
      const hdrs = (a && typeof a === 'object') ? a : b;
      if (hdrs && typeof hdrs === 'object' && !Array.isArray(hdrs)) for (const [k, v] of Object.entries(hdrs)) res.setHeader(k, v);
      if (typeof code === 'number') res.statusCode = code;
      if (decide() === 'buffer') return res;
      return _writeHead.call(res, res.statusCode);
    };
    res.write = function (chunk, enc, cb) {
      if (decide() === 'pass') return _write.call(res, chunk, enc, cb);
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
      if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
      return true;
    };
    res.end = function (chunk, enc, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; }
      if (typeof enc === 'function') { cb = enc; enc = null; }
      if (decide() === 'pass') return _end.call(res, chunk, enc, cb);
      if (req.method === 'HEAD') {
        // No body to change; just drop the headers that describe the
        // original file, which no longer match what a GET returns.
        res.writeHead = _writeHead; res.write = _write; res.end = _end;
        res.removeHeader('ETag'); res.removeHeader('Last-Modified'); res.removeHeader('Content-Length');
        return _end.call(res, null, cb);
      }
      // Hand the real methods back before the final write: Node sends the
      // headers through res.writeHead, which must not be intercepted now.
      res.writeHead = _writeHead; res.write = _write; res.end = _end;
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc || 'utf8'));
      let body = Buffer.concat(chunks).toString('utf8');
      try { body = injectHtml(body, page, s, normPath(req.path)); } catch (e) { log('inject failed:', e.message); }
      const buf = Buffer.from(body, 'utf8');
      res.removeHeader('ETag');
      res.removeHeader('Last-Modified');
      res.setHeader('Content-Length', buf.length);
      return _end.call(res, buf, cb);
    };
    next();
  });

  // ═══════════════════════════════════════════
  // 2. robots.txt, sitemap.xml, llms.txt
  // ═══════════════════════════════════════════
  function robotsTxt() {
    const s = settings();
    const lines = ['User-agent: *'];
    for (const d of s.robotsDisallow || []) if (String(d).trim()) lines.push(`Disallow: ${String(d).trim()}`);
    lines.push('Allow: /');
    if (s.blockAiTraining) {
      // Training crawlers only. Search/answer crawlers (OAI-SearchBot,
      // ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot) stay
      // allowed, so the site can still be found and cited.
      for (const bot of ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot', 'Applebot-Extended']) {
        lines.push('', `User-agent: ${bot}`, 'Disallow: /');
      }
    }
    if (s.robotsExtra && s.robotsExtra.trim()) lines.push('', s.robotsExtra.trim());
    const url = baseUrl(s);
    if (url) lines.push('', `Sitemap: ${url}/sitemap.xml`);
    return lines.join('\n') + '\n';
  }
  function sitemapXml() {
    const url = baseUrl();
    const rows = store.listPages().filter(p => p.in_sitemap);
    const xmlEsc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const items = rows.map(p => {
      const loc = p.canonical || url + normPath(p.path);
      const lastmod = String(p.updated_at || '').slice(0, 10);
      return `  <url><loc>${xmlEsc(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<priority>${Number(p.priority || 0.5).toFixed(1)}</priority></url>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.join('\n')}\n</urlset>\n`;
  }
  function llmsTxt() {
    const s = settings();
    const url = baseUrl(s);
    const out = [`# ${s.siteName || s.orgName || url}`];
    const summary = s.llmsSummary || s.orgDescription;
    if (summary) out.push('', '> ' + String(summary).replace(/\n+/g, ' '));
    if (s.llmsExtra && s.llmsExtra.trim()) out.push('', s.llmsExtra.trim());
    const pages = store.listPages().filter(p => p.in_llms);
    if (pages.length) {
      out.push('', '## Pages', '');
      for (const p of pages) {
        const loc = p.canonical || url + normPath(p.path);
        out.push(`- [${p.title || normPath(p.path)}](${loc})${p.description ? ': ' + p.description : ''}`);
      }
    }
    return out.join('\n') + '\n';
  }
  function sendText(res, type, fn) {
    try {
      const body = fn();
      res.set('Content-Type', type);
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(body);
    } catch (e) {
      res.status(503).type('text/plain').send('Temporarily unavailable.\n');
    }
  }
  if (opts.serveRobots !== false) app.get('/robots.txt', (req, res) => sendText(res, 'text/plain; charset=utf-8', robotsTxt));
  if (opts.serveSitemap !== false) app.get('/sitemap.xml', (req, res) => sendText(res, 'application/xml; charset=utf-8', sitemapXml));
  if (opts.serveLlms !== false) app.get('/llms.txt', (req, res) => sendText(res, 'text/plain; charset=utf-8', llmsTxt));

  // ═══════════════════════════════════════════
  // 3. Claude helper (suggestions) + AI visibility check
  // ═══════════════════════════════════════════
  async function claudeJson(system, user, maxTokens) {
    if (!keys.anthropic) throw new Error('No Anthropic key. In Railway, open this app\'s Variables, add ANTHROPIC_API_KEY, then redeploy.');
    const model = opts.suggestModel || settings().models.claude || DEFAULT_MODELS.claude;
    const d = await postJson('https://api.anthropic.com/v1/messages',
      { 'x-api-key': keys.anthropic, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: maxTokens || 2000, thinking: { type: 'disabled' }, system, messages: [{ role: 'user', content: user }] });
    const text = ((d.content || []).find(b => b.type === 'text') || {}).text || '';
    const m = text.match(/[[{][\s\S]*[\]}]/);
    if (!m) throw new Error('Claude did not return usable data. Press the button again.');
    return JSON.parse(m[0]);
  }

  function engineStatus(s) {
    return Object.entries(ENGINES).map(([id, e]) => ({
      id, label: e.label, envName: e.envName,
      hasKey: !!keys[e.keyName],
      enabled: !!(s.engines || {})[id],
      model: (s.models || {})[id] || DEFAULT_MODELS[id],
    }));
  }

  function friendlyError(engineId, e) {
    const E = ENGINES[engineId];
    const msg = String(e && e.message || e);
    // Per App 38 (4) — prepaid accounts (Perplexity) block the key when the
    // credit runs out, which would otherwise read as a bad key.
    if (e && (e.status === 402 || /credit|balance|insufficient|quota|billing/i.test(msg))) return `${E.label} has no credit left. Open the ${E.label} API billing page, add credit, then run the check again.`;
    if (e && (e.status === 401 || e.status === 403)) return `${E.label} refused the API key. In Railway, open this app's Variables, check ${E.envName}, save, then run the check again.`;
    if (e && e.status === 404 || /model/i.test(msg) && /not.?found|does not exist|invalid/i.test(msg)) return `${E.label} does not know the model "${settings().models[engineId]}". Open Settings on this page, enter a model your ${E.label} account has, save, then run the check again.`;
    if (e && e.status === 429) return `${E.label} said too many requests or no credit left. Check the account's billing page, then run the check again later.`;
    if (/timeout|aborted/i.test(msg)) return `${E.label} took longer than 90 seconds. Run the check again; if it keeps happening, turn ${E.label} off in Settings.`;
    return `${E.label}: ${msg.slice(0, 220)}`;
  }

  const jobs = new Map();
  let running = null;

  async function runCheck(trigger, onProgress) {
    if (running) throw new Error('A check is already running. Wait for it to finish, then press Run again.');
    const s = store.getSettings();
    const engines = engineStatus(s).filter(e => e.enabled && e.hasKey);
    const prompts = store.listPrompts().filter(p => p.active).slice(0, s.maxPromptsPerRun || 25);
    if (!engineStatus(s).some(e => e.hasKey)) throw new Error('No AI engine has an API key yet. In Railway, open this app\'s Variables, add ANTHROPIC_API_KEY (and/or OPENAI_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY), redeploy, then press Run again.');
    if (!engines.length) throw new Error('Every engine with a key is switched off. Open Settings on this page, tick at least one engine that shows "key found", save, then press Run again.');
    if (!prompts.length) throw new Error('There are no active questions. Open the Questions tab, add at least one question, then press Run again.');
    if (!(s.brandTerms || []).length) throw new Error('No brand names are set, so nothing can be matched. Open Settings, fill in "Brand names to look for", save, then press Run again.');
    store.closeStaleRuns(); // any run still 'running' now was cut off by a restart
    const runId = store.startRun(trigger, engines.map(e => e.id), prompts.length);
    running = runId;
    const total = prompts.length * engines.length;
    let done = 0;
    const dead = {}; // engineId -> error message (key refused etc.)
    try {
      for (const p of prompts) {
        await Promise.all(engines.map(async (e) => {
          const base = { run_id: runId, prompt_id: p.id, prompt_text: p.text, engine: e.id };
          if (dead[e.id]) { store.addCheck(Object.assign(base, { error: dead[e.id] })); done++; return; }
          try {
            const { text, urls } = await ENGINES[e.id].ask(p.text, keys[ENGINES[e.id].keyName], e.model);
            const a = analyse(text, urls, s);
            store.addCheck(Object.assign(base, {
              mentioned: a.mentioned, domain_cited: a.domainCited, position: a.position,
              brands_found: a.brandsFound, competitors_found: a.competitorsFound, cited_urls: a.citedUrls,
              answer: String(text || '').slice(0, 12000),
            }));
          } catch (err) {
            const fe = friendlyError(e.id, err);
            if (err && [401, 403, 404].includes(err.status)) dead[e.id] = fe;
            store.addCheck(Object.assign(base, { error: fe }));
          }
          done++;
          if (onProgress) onProgress(done, total);
        }));
      }
      store.finishRun(runId, 'done');
      log(`check ${runId} finished: ${prompts.length} questions × ${engines.length} engines`);
      return runId;
    } catch (e) {
      store.finishRun(runId, 'failed', e.message);
      throw e;
    } finally {
      running = null;
    }
  }

  function summarise(runs) {
    // Per finished run: mention rate and citation rate per engine.
    return runs.filter(r => r.status === 'done' || r.status === 'stopped').map(r => {
      const checks = store.runChecks(r.id).filter(c => !c.error);
      const byEngine = {};
      for (const c of checks) {
        const b = byEngine[c.engine] || (byEngine[c.engine] = { n: 0, mentioned: 0, cited: 0, posSum: 0, posN: 0 });
        b.n++; if (c.mentioned) b.mentioned++; if (c.domain_cited) b.cited++;
        if (c.position) { b.posSum += c.position; b.posN++; }
      }
      const engines = {};
      for (const [k, b] of Object.entries(byEngine)) {
        engines[k] = { n: b.n, mentionRate: b.n ? b.mentioned / b.n : 0, citeRate: b.n ? b.cited / b.n : 0, avgPos: b.posN ? b.posSum / b.posN : null };
      }
      const all = checks.length;
      return { id: r.id, date: r.started_at, trigger: r.trigger, n: all,
        mentionRate: all ? checks.filter(c => c.mentioned).length / all : 0,
        citeRate: all ? checks.filter(c => c.domain_cited).length / all : 0, engines };
    });
  }

  // ═══════════════════════════════════════════
  // 4. Admin API
  // ═══════════════════════════════════════════
  const express = require('express');
  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { log('admin error:', e.message); res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.message }); }
  };
  const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };

  api.get('/state', wrap((req, res) => {
    const s = store.getSettings();
    if (!running) store.closeStaleRuns();
    const runs = store.listRuns(26);
    const latest = runs.find(r => r.status !== 'running') || null;
    res.json({
      settings: s,
      pages: store.listPages(),
      prompts: store.listPrompts(),
      engines: engineStatus(s),
      runs: runs.slice(0, 12),
      trend: summarise(runs).reverse(),
      latest: latest ? { run: latest, checks: store.runChecks(latest.id) } : null,
      running: running ? { runId: running } : null,
      siteUrl: baseUrl(s),
    });
  }));

  const LIST_KEYS = ['sameAs', 'brandTerms', 'competitorTerms', 'robotsDisallow'];
  api.put('/settings', wrap((req, res) => {
    const b = req.body || {};
    const clean = {};
    for (const k of Object.keys(BASE_DEFAULTS)) if (b[k] !== undefined) clean[k] = b[k];
    for (const k of LIST_KEYS) if (clean[k] !== undefined && !Array.isArray(clean[k])) {
      clean[k] = String(clean[k]).split('\n').map(x => x.trim()).filter(Boolean);
    }
    if (clean.siteUrl !== undefined) {
      clean.siteUrl = String(clean.siteUrl).trim().replace(/\/+$/, '');
      if (clean.siteUrl && !/^https?:\/\/[^/]+$/i.test(clean.siteUrl)) throw bad('The site address must look like https://www.example.org — no path after the domain. Fix it, then press Save again.');
    }
    if (clean.checkWeekday !== undefined) clean.checkWeekday = Math.max(0, Math.min(6, parseInt(clean.checkWeekday, 10) || 0));
    if (clean.maxPromptsPerRun !== undefined) clean.maxPromptsPerRun = Math.max(1, Math.min(50, parseInt(clean.maxPromptsPerRun, 10) || 25));
    store.saveSettings(clean);
    invalidate();
    res.json({ ok: true, settings: store.getSettings() });
  }));

  function pageFromBody(b, id) {
    const p = { path: normPath(b.path) };
    if (!b.path || !String(b.path).trim()) throw bad('Enter the page address, for example /courses, then press Save again.');
    if (/^https?:/i.test(String(b.path))) throw bad('Enter only the part after the domain, for example /courses — not the full https:// address. Then press Save again.');
    for (const k of ['title', 'description', 'canonical', 'image_url', 'og_type', 'schema_type']) if (b[k] !== undefined) p[k] = String(b[k] || '').trim() || null;
    if (b.schema_json !== undefined) {
      const raw = String(b.schema_json || '').trim();
      if (raw) {
        try { JSON.parse(raw); } catch (e) { throw bad(`The schema box is not valid JSON (${e.message}). Fix the text in that box, or press "Suggest with AI" to start again, then press Save.`); }
      }
      p.schema_json = raw || null;
    }
    if (b.in_sitemap !== undefined) p.in_sitemap = b.in_sitemap ? 1 : 0;
    if (b.in_llms !== undefined) p.in_llms = b.in_llms ? 1 : 0;
    if (b.priority !== undefined) p.priority = Math.max(0, Math.min(1, Number(b.priority) || 0.5));
    if (id) p.id = id;
    return p;
  }
  api.post('/pages', wrap((req, res) => {
    const p = pageFromBody(req.body || {});
    if (store.listPages().some(x => normPath(x.path) === p.path)) throw bad(`${p.path} is already in the list. Edit it there instead.`);
    const id = store.savePage(p); invalidate();
    res.json({ ok: true, id });
  }));
  api.put('/pages/:id', wrap((req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!store.getPageById(id)) throw bad('That page is no longer in the list. Reload this page.');
    const p = pageFromBody(req.body || {}, id);
    if (store.listPages().some(x => x.id !== id && normPath(x.path) === p.path)) throw bad(`${p.path} is already in the list. Edit that one instead.`);
    store.savePage(p); invalidate();
    res.json({ ok: true, id });
  }));
  api.delete('/pages/:id', wrap((req, res) => { store.deletePage(parseInt(req.params.id, 10)); invalidate(); res.json({ ok: true }); }));

  // Reads the page as the public sees it, through this same server.
  async function fetchOwnPage(req, pagePath) {
    const port = req.socket && req.socket.localPort;
    const r = await fetch(`http://127.0.0.1:${port}${pagePath}`, {
      headers: { Host: req.headers.host || 'localhost', 'User-Agent': 'SeoModule/1.0 (page read)' },
      redirect: 'manual', signal: AbortSignal.timeout(15000),
    });
    if (r.status >= 300 && r.status < 400) throw bad(`${pagePath} redirects to ${r.headers.get('location')} — it is not a public page. Use the address it ends up on, or a page anyone can open without logging in.`);
    if (!r.ok) throw bad(`${pagePath} returned ${r.status}. Check the address opens in a private browser window without logging in, then try again.`);
    return r.text();
  }
  function pageText(html) {
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const desc = (html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) || [])[1] || '';
    const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    return { title: title.trim(), desc, body: body.slice(0, 9000) };
  }

  api.post('/pages/suggest', wrap(async (req, res) => {
    const pagePath = normPath((req.body || {}).path);
    if (!pagePath || pagePath === '/' && !(req.body || {}).path) throw bad('Enter the page address first, for example /courses, then press Suggest with AI.');
    const s = store.getSettings();
    const url = baseUrl(s);
    const t = pageText(await fetchOwnPage(req, pagePath));
    if (t.body.length < 40) throw bad(`${pagePath} has almost no text in its HTML (it may be built by JavaScript after loading). Write the title and description by hand for this page.`);
    const sys = `You write search metadata for one web page. Return only JSON, no prose.
Rules:
- "title": 45-60 characters. Lead with what the page offers, end with " | ${s.siteName || s.orgName}" only if it fits.
- "description": 140-160 characters, plain words, says who it is for and what they get. No hype words.
- "schema_type": one of Course, Book, Event, Article, FAQPage, WebPage, Product, Service.
- "schema_json": a schema.org JSON-LD object (without @context) for this page, using ONLY facts stated on the page. Never invent prices, dates, ratings or reviews. Reference the organisation as {"@id": "${url}/#organization"}${s.personName ? ` and the author/instructor as {"@id": "${url}/#person"}` : ''}. Use "url": "${url}${pagePath}".
- If the page is in a language other than English, write title and description in that language.
Shape: {"title":"","description":"","schema_type":"","schema_json":{}}`;
    const user = `Site: ${s.siteName || s.orgName} (${url})\nAbout the organisation: ${s.orgDescription || '(not given)'}\nPage: ${pagePath}\nCurrent title: ${t.title}\nCurrent description: ${t.desc}\n\nPage text:\n${t.body}`;
    const out = await claudeJson(sys, user, 2500);
    res.json({ ok: true, suggestion: {
      title: String(out.title || ''), description: String(out.description || ''),
      schema_type: String(out.schema_type || ''),
      schema_json: out.schema_json ? JSON.stringify(out.schema_json, null, 2) : '',
    } });
  }));

  api.post('/prompts', wrap((req, res) => {
    const lines = String((req.body || {}).text || '').split('\n').map(x => x.trim()).filter(Boolean);
    if (!lines.length) throw bad('Type at least one question (one per line), then press Add.');
    for (const l of lines) store.addPrompt(l.slice(0, 500));
    res.json({ ok: true, added: lines.length });
  }));
  api.put('/prompts/:id', wrap((req, res) => { store.updatePrompt(parseInt(req.params.id, 10), req.body || {}); res.json({ ok: true }); }));
  api.delete('/prompts/:id', wrap((req, res) => { store.deletePrompt(parseInt(req.params.id, 10)); res.json({ ok: true }); }));
  api.post('/prompts/suggest', wrap(async (req, res) => {
    const s = store.getSettings();
    if (!s.orgDescription) throw bad('Fill in "What the organisation does" in Settings first and save — the suggestions are built from it. Then press Suggest again.');
    const lang = (req.body || {}).language || '';
    const existing = store.listPrompts().map(p => p.text);
    const out = await claudeJson(
      `You list questions real people type into AI assistants when they are looking for what an organisation offers — WITHOUT naming the organisation (we want to see if the assistant finds it on its own). Mix: problem-led ("how do I stop overthinking at night"), solution-led ("best online mindfulness course for anxiety"), audience-led, and comparison questions. Plain, natural phrasing, as typed into ChatGPT. Return only a JSON array of 12 strings.${lang ? ' Write them in ' + lang + '.' : ''}`,
      `Organisation: ${s.orgName || s.siteName}\nWhat it does: ${s.orgDescription}\nOffers (page titles): ${store.listPages().map(p => p.title).filter(Boolean).join('; ') || '(none listed)'}\nAlready tracking: ${existing.join(' | ') || '(nothing yet)'}`, 1500);
    const list = (Array.isArray(out) ? out : []).map(String).filter(q => !existing.includes(q));
    res.json({ ok: true, suggestions: list });
  }));

  api.post('/run', wrap((req, res) => {
    if (running) throw bad('A check is already running. Wait for it to finish — its progress shows on this page.');
    const jobId = Math.random().toString(36).slice(2, 10);
    const job = { status: 'running', done: 0, total: 0, runId: null, error: null };
    jobs.set(jobId, job);
    runCheck('manual', (d, t) => { job.done = d; job.total = t; })
      .then(runId => { job.status = 'done'; job.runId = runId; })
      .catch(e => { job.status = 'failed'; job.error = e.message; });
    setTimeout(() => jobs.delete(jobId), 6 * 3600 * 1000).unref();
    // runCheck validates synchronously before its first await, so an
    // immediate failure (no engines, no questions) is already known here.
    setImmediate(() => job.status === 'failed'
      ? res.status(400).json({ error: job.error })
      : res.json({ ok: true, jobId }));
  }));
  api.get('/jobs/:id', wrap((req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) throw bad('That check is no longer being tracked (the app may have restarted). Reload this page to see the latest results.');
    res.json(j);
  }));
  api.get('/runs/:id', wrap((req, res) => res.json({ checks: store.runChecks(parseInt(req.params.id, 10)) })));
  api.get('/checks/:id', wrap((req, res) => {
    const c = store.getCheck(parseInt(req.params.id, 10));
    if (!c) throw bad('That result no longer exists. Reload this page.');
    res.json(c);
  }));
  api.get('/preview/:file', wrap((req, res) => {
    const f = req.params.file;
    const body = f === 'robots' ? robotsTxt() : f === 'sitemap' ? sitemapXml() : f === 'llms' ? llmsTxt() : null;
    if (body == null) throw bad('Unknown file.');
    res.json({ body });
  }));

  app.use(apiBase, requireAdminApi, api);

  // ── Admin page ──
  const adminTemplate = path.join(__dirname, 'admin.html');
  const sendAdmin = (req, res) => {
    try {
      const cfg = { apiBase, lang: opts.lang || 'en', appName: opts.appName || '', theme: opts.theme || 'dark', languages: opts.languages || ['en', 'nl'] };
      const html = fs.readFileSync(adminTemplate, 'utf8')
        .replace('__SEO_CONFIG__', () => JSON.stringify(cfg).replace(/</g, '\\u003c'))
        .replace('<!--SEO_NAV-->', () => opts.adminNavHtml || '');
      res.set('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (e) { res.status(500).send('Search admin page could not be loaded: ' + e.message); }
  };
  app.get(adminPath, requireAdminPage, sendAdmin);
  app.get(adminPath + '/', requireAdminPage, sendAdmin);

  // ── Weekly schedule ──
  if (opts.enableCron !== false) {
    let cron = null;
    try { cron = require('node-cron'); } catch (e) { log('node-cron not installed — weekly check disabled'); }
    if (cron) {
      // 05:47 UTC daily; only acts on the chosen weekday, once.
      cron.schedule(opts.cronExpression || '47 5 * * *', async () => {
        try {
          const s = store.getSettings();
          const now = new Date();
          if (!s.checkEnabled || now.getUTCDay() !== Number(s.checkWeekday)) return;
          if (store.lastRunOn(now.toISOString().slice(0, 10))) return;
          await runCheck('schedule');
          if (typeof opts.onScheduledRun === 'function') opts.onScheduledRun({ ok: true });
        } catch (e) {
          log('scheduled check failed:', e.message);
          if (typeof opts.onScheduledRun === 'function') opts.onScheduledRun({ ok: false, error: e.message });
        }
      });
    }
  }

  log(`mounted — admin ${adminPath}, files /robots.txt /sitemap.xml /llms.txt`);
  return { store, runCheck, robotsTxt, sitemapXml, llmsTxt, invalidate };
}

module.exports = { mountSeo };
