// seo/engines.js — asks AI assistants a question the way a member of the
// public would, with live web search on, and reports whether the brand
// came up. No system prompt is sent: the point is to see the answer an
// ordinary user gets, not one steered towards us.
//
// Each engine is optional. An engine with no API key is simply skipped.
// Every engine returns { text, urls } or throws an Error whose message
// says what to do.

const TIMEOUT_MS = 90000;

async function postJson(url, headers, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await r.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { /* non-JSON error page */ }
  if (!r.ok) {
    const msg = (data && data.error && (data.error.message || data.error)) || raw.slice(0, 200);
    const err = new Error(`HTTP ${r.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

const ENGINES = {
  claude: {
    label: 'Claude',
    keyName: 'anthropic',
    envName: 'ANTHROPIC_API_KEY',
    async ask(question, key, model) {
      const d = await postJson('https://api.anthropic.com/v1/messages',
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: 4000,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
          messages: [{ role: 'user', content: question }] });
      let text = ''; const urls = [];
      for (const b of d.content || []) {
        if (b.type === 'text') {
          text += b.text;
          for (const c of b.citations || []) if (c.url) urls.push(c.url);
        }
        if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
          for (const r of b.content) if (r.url) urls.push(r.url);
        }
      }
      return { text, urls };
    },
  },
  chatgpt: {
    label: 'ChatGPT',
    keyName: 'openai',
    envName: 'OPENAI_API_KEY',
    // Per App 38 (5) — OpenAI renames models often (gpt-5.5 is in their web
    // search guide but already off their pricing page), so an unknown model
    // falls through to the next one here instead of failing the check.
    async ask(question, key, model) {
      const tryModels = Array.from(new Set([model, ...CHATGPT_FALLBACKS].filter(Boolean)));
      const call = (m, toolType) => postJson('https://api.openai.com/v1/responses',
        { Authorization: `Bearer ${key}` },
        { model: m, tools: [{ type: toolType }], input: question });
      const callModel = async (m) => {
        try { return await call(m, 'web_search'); }
        catch (e) {
          // Older accounts/models only know the preview tool name.
          if (e.status === 400 && /web_search/.test(e.message) && !/model/i.test(e.message)) return call(m, 'web_search_preview');
          throw e;
        }
      };
      let d, lastErr;
      for (const m of tryModels) {
        try { d = await callModel(m); break; }
        catch (e) {
          lastErr = e;
          const unknownModel = (e.status === 404 || e.status === 400) && /model/i.test(e.message) && /not.?found|does not exist|invalid|unsupported|not supported/i.test(e.message);
          if (!unknownModel) throw e;
        }
      }
      if (!d) throw lastErr;
      let text = ''; const urls = [];
      for (const item of d.output || []) {
        if (item.type !== 'message') continue;
        for (const c of item.content || []) {
          if (c.type !== 'output_text') continue;
          text += c.text;
          for (const a of c.annotations || []) if (a.url) urls.push(a.url);
        }
      }
      if (!text && d.output_text) text = d.output_text;
      return { text, urls };
    },
  },
  perplexity: {
    label: 'Perplexity',
    keyName: 'perplexity',
    envName: 'PERPLEXITY_API_KEY',
    // Per App 38 (4) — Perplexity's Agent API (POST /v1/agent). Their docs
    // now treat Sonar chat completions as legacy. The "model" setting takes
    // a preset name (fast, low, medium, high — presets include web search)
    // or a provider/model id; the old default "sonar" maps to "fast".
    async ask(question, key, model) {
      const m = !model || model === 'sonar' ? 'fast' : String(model);
      const body = { input: question };
      if (m.includes('/')) {
        body.model = m;
        body.tools = [{ type: 'web_search' }];
        body.max_output_tokens = 4000; // required for anthropic/* models
      } else {
        body.preset = m;
      }
      const d = await postJson('https://api.perplexity.ai/v1/agent', { Authorization: `Bearer ${key}` }, body);
      let text = ''; const urls = [];
      for (const item of d.output || []) {
        if (item.type === 'message') {
          for (const c of item.content || []) {
            if (c.type !== 'output_text') continue;
            text += c.text || '';
            for (const a of c.annotations || []) if (a.url) urls.push(a.url);
          }
        } else if (item.type === 'search_results') {
          for (const r of item.results || []) if (r.url) urls.push(r.url);
        }
      }
      if (!text && d.output_text) text = d.output_text;
      return { text, urls };
    },
  },
  gemini: {
    label: 'Gemini',
    keyName: 'gemini',
    envName: 'GEMINI_API_KEY',
    async ask(question, key, model) {
      const d = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': key },
        { contents: [{ role: 'user', parts: [{ text: question }] }], tools: [{ google_search: {} }] });
      const cand = (d.candidates || [])[0] || {};
      const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
      const urls = [];
      const chunks = (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
      // Gemini gives redirect links; the chunk title is the source domain.
      for (const c of chunks) if (c.web) urls.push(c.web.title && /\./.test(c.web.title) ? `https://${c.web.title}` : c.web.uri);
      return { text, urls };
    },
  },
};

// Per App 38 (2) — checked 12 Oct 2026: Google limits the 2.5 models to
// accounts that already used them and recommends 3.8 Flash for new
// projects. ChatGPT (38 (5)): gpt-6.1-sol, current on OpenAI's pricing
// page at $2/$10 per 1M tokens, with CHATGPT_FALLBACKS tried in turn. Any of these can be changed in Search → Settings.
const CHATGPT_FALLBACKS = ['gpt-6.1-sol', 'gpt-5.5', 'gpt-6-astra'];
const DEFAULT_MODELS = {
  claude: 'claude-sonnet-5',
  chatgpt: 'gpt-6.1-sol',
  perplexity: 'fast',
  gemini: 'gemini-3.8-flash',
};

// ── Mention detection ──
// "FELT·FIBRE", "Felt-Fibre" and "felt fibre" all count as the same term.
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[·•‧∙⋅\-‐-―_/]+/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ');
}
function firstIndex(haystackNorm, term) {
  const t = norm(term).trim();
  if (!t) return -1;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|[^a-z0-9À-ɏ])${esc}(?=[^a-z0-9À-ɏ]|$)`).exec(haystackNorm);
  return m ? m.index + m[1].length : -1;
}
// A line "Name | alias | alias" is one competitor with several spellings.
function parseNamed(lines) {
  return (lines || []).map(l => String(l).split('|').map(s => s.trim()).filter(Boolean))
    .filter(a => a.length).map(a => ({ name: a[0], terms: a }));
}
function hostOf(u) { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; } }

function analyse(text, urls, settings) {
  const h = norm(text);
  const brandTerms = settings.brandTerms || [];
  const domain = hostOf(settings.siteUrl || '');
  const brandsFound = [];
  let ourIdx = -1;
  for (const t of brandTerms) {
    const i = firstIndex(h, t);
    if (i >= 0) { brandsFound.push(t); if (ourIdx < 0 || i < ourIdx) ourIdx = i; }
  }
  const cited = Array.from(new Set((urls || []).filter(Boolean)));
  const domainCited = !!domain && cited.some(u => { const x = hostOf(u); return x === domain || x.endsWith('.' + domain); });
  if (domain && ourIdx < 0) { const i = h.indexOf(domain); if (i >= 0) { ourIdx = i; brandsFound.push(domain); } }

  const competitorsFound = [];
  const compIdx = [];
  for (const c of parseNamed(settings.competitorTerms)) {
    let best = -1;
    for (const t of c.terms) { const i = firstIndex(h, t); if (i >= 0 && (best < 0 || i < best)) best = i; }
    if (best >= 0) { competitorsFound.push(c.name); compIdx.push(best); }
  }
  const mentioned = ourIdx >= 0;
  const position = mentioned ? 1 + compIdx.filter(i => i < ourIdx).length : null;
  return { mentioned, domainCited, position, brandsFound, competitorsFound, citedUrls: cited.slice(0, 40) };
}

module.exports = { ENGINES, DEFAULT_MODELS, analyse, norm, hostOf, postJson };
