// seo/store.js — storage for the portable Search Visibility module.
//
// The module never touches the host app's own tables. It owns five tables,
// all prefixed seo_, and talks to the host database only through a tiny
// adapter passed in at mount time:
//
//   store.run(sql, params)  — run one write and persist it
//   store.all(sql, params)  — return rows as plain objects
//
// Tables are created lazily on first use, not at require time, because
// both host apps open their database asynchronously after server.js has
// already loaded (and may start in maintenance mode with no database).

function createStore(adapter, defaults) {
  if (!adapter || typeof adapter.run !== 'function' || typeof adapter.all !== 'function') {
    throw new Error('seo: mountSeo needs opts.store = { run(sql, params), all(sql, params) }');
  }
  let ready = false;

  function ensure() {
    if (ready) return;
    adapter.run(`CREATE TABLE IF NOT EXISTS seo_settings (
      key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))`);
    adapter.run(`CREATE TABLE IF NOT EXISTS seo_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      title TEXT, description TEXT, canonical TEXT, image_url TEXT,
      og_type TEXT DEFAULT 'website',
      schema_type TEXT, schema_json TEXT,
      in_sitemap INTEGER NOT NULL DEFAULT 1,
      in_llms INTEGER NOT NULL DEFAULT 1,
      priority REAL DEFAULT 0.5,
      updated_at TEXT DEFAULT (datetime('now')))`);
    adapter.run(`CREATE TABLE IF NOT EXISTS seo_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')))`);
    adapter.run(`CREATE TABLE IF NOT EXISTS seo_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      trigger TEXT,
      status TEXT DEFAULT 'running',
      engines TEXT,
      prompt_count INTEGER DEFAULT 0,
      error TEXT)`);
    adapter.run(`CREATE TABLE IF NOT EXISTS seo_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      prompt_id INTEGER NOT NULL,
      prompt_text TEXT,
      engine TEXT NOT NULL,
      mentioned INTEGER DEFAULT 0,
      domain_cited INTEGER DEFAULT 0,
      position INTEGER,
      brands_found TEXT,
      competitors_found TEXT,
      cited_urls TEXT,
      answer TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')))`);
    adapter.run(`CREATE INDEX IF NOT EXISTS idx_seo_checks_run ON seo_checks(run_id)`);
    ready = true;
  }

  // ── Settings: one JSON value per key, merged over the host's defaults ──
  function getSettings() {
    ensure();
    const out = JSON.parse(JSON.stringify(defaults || {}));
    for (const r of adapter.all(`SELECT key, value FROM seo_settings`)) {
      try { out[r.key] = JSON.parse(r.value); } catch (e) { /* skip a broken row */ }
    }
    return out;
  }
  function saveSettings(obj) {
    ensure();
    for (const [k, v] of Object.entries(obj || {})) {
      if (v === undefined) continue;
      adapter.run(`INSERT INTO seo_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, [k, JSON.stringify(v)]);
    }
  }

  // ── Pages ──
  const PAGE_FIELDS = ['title', 'description', 'canonical', 'image_url', 'og_type', 'schema_type', 'schema_json', 'in_sitemap', 'in_llms', 'priority'];
  function listPages() { ensure(); return adapter.all(`SELECT * FROM seo_pages ORDER BY path`); }
  function getPageById(id) { ensure(); return adapter.all(`SELECT * FROM seo_pages WHERE id=?`, [id])[0] || null; }
  function savePage(p) {
    ensure();
    if (p.id) {
      const keys = PAGE_FIELDS.filter(k => p[k] !== undefined);
      const sets = keys.map(k => `${k}=?`).concat(['path=?', `updated_at=datetime('now')`]);
      adapter.run(`UPDATE seo_pages SET ${sets.join(', ')} WHERE id=?`, keys.map(k => p[k]).concat([p.path, p.id]));
      return p.id;
    }
    const keys = ['path'].concat(PAGE_FIELDS.filter(k => p[k] !== undefined));
    adapter.run(`INSERT INTO seo_pages (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => p[k]));
    const row = adapter.all(`SELECT id FROM seo_pages WHERE path=?`, [p.path])[0];
    return row ? row.id : null;
  }
  function deletePage(id) { ensure(); adapter.run(`DELETE FROM seo_pages WHERE id=?`, [id]); }

  // ── Prompts ──
  function listPrompts() { ensure(); return adapter.all(`SELECT * FROM seo_prompts ORDER BY id`); }
  function addPrompt(text) { ensure(); adapter.run(`INSERT INTO seo_prompts (text) VALUES (?)`, [text]); }
  function updatePrompt(id, f) {
    ensure();
    if (f.text !== undefined) adapter.run(`UPDATE seo_prompts SET text=? WHERE id=?`, [f.text, id]);
    if (f.active !== undefined) adapter.run(`UPDATE seo_prompts SET active=? WHERE id=?`, [f.active ? 1 : 0, id]);
  }
  function deletePrompt(id) { ensure(); adapter.run(`DELETE FROM seo_prompts WHERE id=?`, [id]); }

  // ── Runs and checks ──
  function startRun(trigger, engines, promptCount) {
    ensure();
    adapter.run(`INSERT INTO seo_runs (trigger, engines, prompt_count) VALUES (?, ?, ?)`, [trigger, JSON.stringify(engines), promptCount]);
    return adapter.all(`SELECT MAX(id) AS id FROM seo_runs`)[0].id;
  }
  function finishRun(id, status, error) {
    adapter.run(`UPDATE seo_runs SET finished_at=datetime('now'), status=?, error=? WHERE id=?`, [status, error || null, id]);
  }
  function addCheck(c) {
    adapter.run(`INSERT INTO seo_checks (run_id, prompt_id, prompt_text, engine, mentioned, domain_cited, position,
        brands_found, competitors_found, cited_urls, answer, error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [c.run_id, c.prompt_id, c.prompt_text, c.engine, c.mentioned ? 1 : 0, c.domain_cited ? 1 : 0,
       c.position == null ? null : c.position, JSON.stringify(c.brands_found || []), JSON.stringify(c.competitors_found || []),
       JSON.stringify(c.cited_urls || []), c.answer || null, c.error || null]);
  }
  function listRuns(limit) {
    ensure();
    return adapter.all(`SELECT * FROM seo_runs ORDER BY id DESC LIMIT ?`, [limit || 20]);
  }
  function runChecks(runId) {
    ensure();
    return adapter.all(`SELECT id, run_id, prompt_id, prompt_text, engine, mentioned, domain_cited, position,
      brands_found, competitors_found, cited_urls, error FROM seo_checks WHERE run_id=? ORDER BY prompt_id, engine`, [runId]);
  }
  function getCheck(id) { ensure(); return adapter.all(`SELECT * FROM seo_checks WHERE id=?`, [id])[0] || null; }
  function lastRunOn(dateStr) {
    ensure();
    return adapter.all(`SELECT id FROM seo_runs WHERE substr(started_at,1,10)=? AND trigger='schedule'`, [dateStr])[0] || null;
  }
  // A run left 'running' by a restart mid-check would show as running forever.
  function closeStaleRuns() {
    ensure();
    adapter.run(`UPDATE seo_runs SET status='stopped', finished_at=datetime('now'),
      error='The app restarted while this check was running. Results so far are kept.' WHERE status='running'`);
  }

  return {
    ensure, getSettings, saveSettings,
    listPages, getPageById, savePage, deletePage,
    listPrompts, addPrompt, updatePrompt, deletePrompt,
    startRun, finishRun, addCheck, listRuns, runChecks, getCheck, lastRunOn, closeStaleRuns,
  };
}

module.exports = { createStore };
