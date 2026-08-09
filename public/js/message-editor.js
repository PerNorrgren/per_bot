// ── Unified message editor — shared primitives (Per Bot 19, extended
// Per Bot 54 for comms2) ── Used by Trial sequence, Savers Protocol,
// Campaign email steps (sales.html), and now comms2.html's Reminder/
// Renewal/Birthday/Newsletter Welcome/Trial Extended. Newsletters
// (comms.html) keeps its own existing, heavier editor as-is —
// columns/video/image-resize are genuinely newsletter-grade features
// with no equivalent need in a short transactional message. This module
// is lighter by design: bold/italic/underline/headers/link/image, plus
// (Per Bot 54) the same "Generate & insert" AI feature Newsletter has,
// simplified — no columns-block insertion logic, since nothing using
// this module has columns.
(function (window) {
  'use strict';

  const instances = {}; // containerId -> Quill instance, one per mounted rich field

  // ── Plain input/textarea token insertion — insert at cursor, refocus. ──
  function insertTokenAtField(el, token) {
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + token + el.value.slice(end);
    el.focus();
    const pos = start + token.length;
    el.setSelectionRange(pos, pos);
  }

  // ── Rich (Quill) token insertion — same idea, at the live selection. ──
  function insertTokenAtRich(containerId, token) {
    const q = instances[containerId];
    if (!q) return;
    const range = q.getSelection(true) || { index: q.getLength(), length: 0 };
    q.insertText(range.index, token);
    q.setSelection(range.index + token.length);
  }

  // Standard token list every email context shares — {{name}}, real
  // {{invite_link}}, {{expiry_date}}. Contexts with an extra token of
  // their own (Savers cancel-day0 has {{period_end}}) pass it in `extra`.
  function standardTokens(extra) {
    const base = [
      { value: '{{name}}', label: "Recipient's name" },
      { value: '{{invite_link}}', label: 'Their login/invite link' },
      { value: '{{expiry_date}}', label: 'Their membership expiry date' },
    ];
    return extra ? base.concat(extra) : base;
  }

  // Renders a <select> that inserts a token into a plain field on choice
  // and resets itself — same "reads as an action, not a setting" pattern
  // already used throughout sales.html/comms.html.
  function tokenSelectHtml(fieldId, tokens, opts) {
    opts = opts || {};
    const options = ['<option value="">' + (opts.placeholder || 'Insert…') + '</option>']
      .concat(tokens.map(t => `<option value="${t.value}">${t.label}</option>`)).join('');
    const insertCall = opts.rich
      ? `MessageEditor.insertTokenAtRich('${fieldId}', this.value)`
      : `MessageEditor.insertTokenAtField(document.getElementById('${fieldId}'), this.value)`;
    return `<select onchange="if(this.value){${insertCall};this.value='';${opts.onAfter || ''}}" style="font-size:11px;${opts.style || 'width:auto'}">${options}</select>`;
  }

  // Renders the plain/rich toggle pair. onToggle(format) is called with
  // the newly-chosen format so the caller can swap which field is visible
  // and (re)mount/tear down the Quill instance.
  function formatToggleHtml(idPrefix, current, onToggleFnName) {
    const isRich = current === 'rich';
    return `<div class="format-toggle" style="margin-bottom:6px">
      <button type="button" id="${idPrefix}_plainBtn" class="${isRich ? '' : 'active'}" onclick="${onToggleFnName}('${idPrefix}','plain')">Plain text</button>
      <button type="button" id="${idPrefix}_richBtn" class="${isRich ? 'active' : ''}" onclick="${onToggleFnName}('${idPrefix}','rich')">Rich message</button>
    </div>`;
  }

  // Injected once — Quill's Snow theme is unstyled by default and reads
  // as plain black-on-white; every dark admin page needs the same
  // overrides, so this module carries its own copy instead of relying on
  // each host page to remember to add them (comms2.html shipped without
  // this and the editor looked broken — text was there, just invisible).
  let _stylesInjected = false;
  function ensureStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .me-ql-wrap .ql-toolbar.ql-snow { background:rgba(255,255,255,0.05); border-color:rgba(255,255,255,0.12) !important; border-radius:8px 8px 0 0; }
      .me-ql-wrap .ql-container.ql-snow { border-color:rgba(255,255,255,0.12) !important; font-family:'Georgia',serif; font-size:14px; border-radius:0 0 8px 8px; }
      .me-ql-wrap .ql-editor { color:rgba(255,255,255,0.85); min-height:140px; }
      .me-ql-wrap .ql-editor.ql-blank::before { color:rgba(255,255,255,0.25); font-style:normal; }
      .me-ql-wrap .ql-snow .ql-stroke { stroke:rgba(255,255,255,0.5); }
      .me-ql-wrap .ql-snow .ql-fill { fill:rgba(255,255,255,0.5); }
      .me-ql-wrap .ql-snow .ql-picker { color:rgba(255,255,255,0.5); }
      .me-ql-wrap .ql-snow .ql-picker-options { background:#1a221e; border-color:rgba(255,255,255,0.12) !important; }
      .me-ql-wrap .ql-snow .ql-tooltip { background:#1a221e; border-color:rgba(255,255,255,0.12); color:rgba(255,255,255,0.8); box-shadow:none; }
      .me-ql-wrap .ql-snow .ql-tooltip input[type=text] { background:rgba(255,255,255,0.06); border-color:rgba(255,255,255,0.15); color:rgba(255,255,255,0.85); }
      .me-ql-wrap .ql-toolbar.ql-snow .ql-picker-label { border-color:transparent; }
      .me-ai-panel { background:#141a17; border:1px solid rgba(255,255,255,0.12); border-radius:10px; padding:14px; margin-top:8px; }
      .me-ai-body { font-size:13px; line-height:1.6; color:rgba(255,255,255,0.8); max-height:240px; overflow-y:auto; }
    `;
    document.head.appendChild(style);
  }

  // ── Rich editor — bold/italic/underline/headers/link/image. Headers
  // added Per Bot 54 (Per: "no headers" — the original scope for this
  // module deliberately left them out for short transactional emails,
  // but a subject line or two of structure is a reasonable ask even for
  // those, and it's harmless for every existing consumer of this
  // module too). ──
  function mountRich(containerId, initialHtml, opts) {
    opts = opts || {};
    ensureStyles();
    if (instances[containerId]) { destroy(containerId); }
    const container = document.getElementById(containerId);
    if (container) container.classList.add('me-ql-wrap');
    const q = new Quill('#' + containerId, {
      theme: 'snow',
      placeholder: opts.placeholder || '',
      modules: { toolbar: [[{ header: [2, 3, false] }], ['bold', 'italic', 'underline'], ['link', 'image'], ['clean']] },
    });
    if (opts.imageUploadEndpoint) {
      const toolbar = q.getModule('toolbar');
      toolbar.addHandler('image', () => uploadImage(q, opts.imageUploadEndpoint));
    }
    if (initialHtml) q.clipboard.dangerouslyPasteHTML(initialHtml);
    instances[containerId] = q;
    return q;
  }

  async function uploadImage(q, endpoint) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await fetch(endpoint, { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok || !data.url) throw new Error(data.error || 'Upload failed.');
        const range = q.getSelection(true);
        q.insertEmbed(range ? range.index : q.getLength(), 'image', data.url, 'user');
      } catch (e) { alert(e.message); }
    };
    input.click();
  }

  function destroy(containerId) {
    // Quill has no formal teardown — dropping the reference and letting
    // the container's innerHTML get replaced by the caller is enough
    // (same assumption the message-builder's mbQuillInstances already
    // relies on elsewhere in this app).
    delete instances[containerId];
  }

  function getHtml(containerId) {
    const q = instances[containerId];
    return q ? q.root.innerHTML : '';
  }

  function isMounted(containerId) { return !!instances[containerId]; }

  // ── AI generate & insert (Per Bot 54) — a simplified, portable version
  // of comms.html's Newsletter-only "Generate & insert" feature. Same
  // backend job (/api/admin/comms-ai-generate, POST to start + GET to
  // poll) and same five types, but inserts at the plain Quill selection
  // — no columns-block/cell-range handling, since nothing using this
  // module has that feature. Renders its own dropdown + inline preview
  // panel under the given container; only enabled while that container
  // is the active rich field (caller decides when to show/hide via the
  // rich/plain toggle, same as comms.html's own commsAiGenerateSelect).
  const AI_LABELS = { motd: 'Message of the Day style', limerick: 'Mindful limerick (hidden signal)', haiku: 'Surprising haiku', poem: 'Nature poem, Mary Oliver style', sumie: 'Sumi-e style line art' };
  const aiState = {}; // containerId -> { type, jobId, pollTimer, result }

  function aiGenerateHtml(containerId) {
    const options = Object.keys(AI_LABELS).map(k => `<option value="${k}">${AI_LABELS[k]}</option>`).join('');
    return `
      <select onchange="if(this.value){MessageEditor.runAiGenerate('${containerId}',this.value);this.value='';}" style="font-size:11px">
        <option value="">Generate &amp; insert…</option>
        ${options}
      </select>
      <div class="me-ai-panel" id="${containerId}_aiPanel" style="display:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong style="font-size:12px;color:rgba(255,255,255,0.7)" id="${containerId}_aiTitle">Generating</strong>
          <button type="button" onclick="MessageEditor.closeAiPreview('${containerId}')" style="background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:16px;line-height:1">×</button>
        </div>
        <div class="me-ai-body" id="${containerId}_aiBody"></div>
        <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">
          <button type="button" class="btn sm" id="${containerId}_aiRetry" style="display:none" onclick="MessageEditor.retryAiGenerate('${containerId}')">Try again</button>
          <button type="button" class="btn sm primary" id="${containerId}_aiInsert" style="display:none" onclick="MessageEditor.insertAiResult('${containerId}')">Insert</button>
        </div>
      </div>`;
  }

  function runAiGenerate(containerId, type) {
    const st = aiState[containerId] || (aiState[containerId] = {});
    if (st.pollTimer) clearTimeout(st.pollTimer);
    const q = instances[containerId];
    st.type = type;
    st.jobId = null;
    st.result = null;
    st.range = q ? (q.getSelection(true) || { index: q.getLength(), length: 0 }) : null;
    document.getElementById(`${containerId}_aiPanel`).style.display = 'block';
    document.getElementById(`${containerId}_aiTitle`).textContent = AI_LABELS[type] || 'Generating';
    startAiJob(containerId, type);
  }

  async function startAiJob(containerId, type) {
    const st = aiState[containerId];
    document.getElementById(`${containerId}_aiRetry`).style.display = 'none';
    document.getElementById(`${containerId}_aiInsert`).style.display = 'none';
    document.getElementById(`${containerId}_aiBody`).innerHTML = `<span style="color:rgba(255,255,255,0.4);font-style:italic">Generating${type === 'sumie' ? ' — this can take up to two minutes' : ''}…</span>`;
    try {
      const body = { type };
      if (type === 'sumie') {
        const q = instances[containerId];
        body.context = q ? q.getText() : '';
      }
      const res = await fetch('/api/admin/comms-ai-generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok || !data.jobId) throw new Error(data.error || 'Could not start that right now.');
      st.jobId = data.jobId;
      pollAiJob(containerId);
    } catch (e) {
      showAiError(containerId, e.message || 'Something went wrong — please try again.');
    }
  }

  async function pollAiJob(containerId) {
    const st = aiState[containerId];
    if (!st || !st.jobId) return;
    let res, data;
    try {
      res = await fetch(`/api/admin/comms-ai-generate/${st.jobId}`);
      data = await res.json();
    } catch (e) {
      // A failed poll request itself doesn't mean the job failed — the
      // job keeps running server-side regardless. Just retry.
      st.pollTimer = setTimeout(() => pollAiJob(containerId), 2000);
      return;
    }
    if (!res.ok) { showAiError(containerId, data.error || 'That job could not be found — please try again.'); return; }
    if (data.status === 'pending') { st.pollTimer = setTimeout(() => pollAiJob(containerId), 2000); return; }
    if (data.status === 'error') { showAiError(containerId, data.error || 'Could not generate that right now.'); return; }
    st.result = st.type === 'sumie' ? { imageUrl: data.imageUrl } : { html: data.html };
    const bodyEl = document.getElementById(`${containerId}_aiBody`);
    bodyEl.innerHTML = st.type === 'sumie' ? `<img src="${st.result.imageUrl}" style="max-width:100%;display:block;border-radius:4px"/>` : st.result.html;
    document.getElementById(`${containerId}_aiRetry`).style.display = '';
    document.getElementById(`${containerId}_aiInsert`).style.display = '';
  }

  function showAiError(containerId, message) {
    document.getElementById(`${containerId}_aiBody`).innerHTML = `<span style="color:rgba(255,120,100,0.85)">${message}</span>`;
    document.getElementById(`${containerId}_aiRetry`).style.display = '';
    document.getElementById(`${containerId}_aiInsert`).style.display = 'none';
  }

  function retryAiGenerate(containerId) {
    const st = aiState[containerId];
    if (!st) return;
    document.getElementById(`${containerId}_aiTitle`).textContent = AI_LABELS[st.type] || 'Generating';
    startAiJob(containerId, st.type);
  }

  function closeAiPreview(containerId) {
    const st = aiState[containerId];
    if (st && st.pollTimer) clearTimeout(st.pollTimer);
    delete aiState[containerId];
    const panel = document.getElementById(`${containerId}_aiPanel`);
    if (panel) panel.style.display = 'none';
  }

  function insertAiResult(containerId) {
    const st = aiState[containerId];
    const q = instances[containerId];
    if (!st || !st.result || !q) return;
    if (st.type === 'sumie') {
      const idx = st.range ? st.range.index : q.getLength();
      q.insertEmbed(idx, 'image', st.result.imageUrl);
      q.setSelection(idx + 1);
    } else {
      const idx = st.range ? st.range.index : q.getLength();
      q.clipboard.dangerouslyPasteHTML(idx, st.result.html + '<br/>');
      q.setSelection(idx + 1);
    }
    closeAiPreview(containerId);
  }

  window.MessageEditor = {
    insertTokenAtField, insertTokenAtRich, standardTokens, tokenSelectHtml,
    formatToggleHtml, mountRich, destroy, getHtml, isMounted,
    aiGenerateHtml, runAiGenerate, retryAiGenerate, closeAiPreview, insertAiResult,
    renderVersionSection, refreshVersionSection,
  };

  // ═══════════════════════════════════════════════════════════════════
  // ── Version sections (Per Bot 54) — the generic "versions list +
  // shared editor modal" UI, factored out of comms2.html so sales.html
  // (Trial sequence, Savers Protocol) can use the exact same thing
  // instead of a second hand-copied implementation. One call —
  // MessageEditor.renderVersionSection(el, type, opts) — renders a
  // complete section (warning banner, card, table, New button) into any
  // container, for any type in db.js's MESSAGE_TYPE_REGISTRY. The editor
  // modal itself is injected into <body> once and shared across every
  // section on the page, however many there are.
  //
  // All injected class names are "me-"-prefixed and scoped under
  // .me-version-ui so this can drop into comms.html or sales.html —
  // pages with their own long-established .card/.btn/.modal-overlay
  // rules — without any risk of colliding with or overriding them.
  // ═══════════════════════════════════════════════════════════════════

  let _versionStylesInjected = false;
  function ensureVersionStyles() {
    if (_versionStylesInjected) return;
    _versionStylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .me-version-ui { font-family:'Georgia',serif; }
      .me-section-label { font-size:10px; letter-spacing:0.2em; text-transform:uppercase; color:rgba(255,255,255,0.3); margin-bottom:14px; }
      .me-card { background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:14px; overflow:hidden; }
      .me-card-header { padding:16px 20px; border-bottom:1px solid rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; }
      .me-card-title { font-size:14px; color:rgba(255,255,255,0.75); }
      .me-btn { padding:7px 16px; border-radius:7px; border:1px solid rgba(255,255,255,0.12); background:none; color:rgba(255,255,255,0.5); font-size:11px; letter-spacing:0.08em; text-transform:uppercase; cursor:pointer; font-family:'Georgia',serif; display:inline-flex; align-items:center; gap:5px; }
      .me-btn:hover { background:rgba(255,255,255,0.07); color:rgba(255,255,255,0.8); }
      .me-btn.me-primary { border-color:rgba(180,230,200,0.35); color:rgba(180,230,200,0.75); }
      .me-btn.me-primary:hover { background:rgba(180,230,200,0.1); }
      .me-btn.me-danger { border-color:rgba(255,100,80,0.25); color:rgba(255,100,80,0.6); }
      .me-btn.me-danger:hover { background:rgba(255,100,80,0.08); color:rgba(255,100,80,0.9); }
      .me-btn.me-sm { padding:5px 10px; font-size:10px; }
      .me-btn:disabled { opacity:0.35; pointer-events:none; }
      .me-version-row { display:flex; align-items:center; gap:12px; padding:13px 20px; border-bottom:1px solid rgba(255,255,255,0.04); flex-wrap:wrap; }
      .me-version-row:last-child { border-bottom:none; }
      .me-version-main { flex:1; min-width:200px; }
      .me-version-label { font-size:13px; color:rgba(255,255,255,0.8); }
      .me-version-subject { font-size:12px; color:rgba(255,255,255,0.45); margin-top:2px; }
      .me-version-meta { font-size:11px; color:rgba(255,255,255,0.28); margin-top:3px; }
      .me-version-actions { display:flex; gap:6px; align-items:center; flex-shrink:0; }
      .me-active-pill { font-size:10px; letter-spacing:0.06em; text-transform:uppercase; padding:4px 10px; border-radius:12px; background:rgba(180,230,200,0.12); color:rgba(180,230,200,0.85); border:1px solid rgba(180,230,200,0.3); }
      .me-empty-note { padding:20px; font-size:13px; color:rgba(255,255,255,0.35); }
      .me-warn-banner { display:flex; align-items:center; gap:10px; padding:11px 16px; margin-bottom:10px; border-radius:10px; background:rgba(255,180,60,0.09); border:1px solid rgba(255,180,60,0.28); color:rgba(255,200,110,0.9); font-size:12px; }
      .me-modal-overlay { display:none; position:fixed; inset:0; z-index:200; background:rgba(0,0,0,0.7); backdrop-filter:blur(8px); align-items:center; justify-content:center; padding:20px; }
      .me-modal-overlay.me-open { display:flex; }
      .me-modal { background:#141a17; border:1px solid rgba(255,255,255,0.12); border-radius:16px; padding:28px; width:100%; max-width:600px; display:flex; flex-direction:column; gap:16px; max-height:90vh; overflow-y:auto; font-family:'Georgia',serif; color:rgba(255,255,255,0.82); }
      .me-modal h3 { font-weight:normal; }
      .me-modal label { display:block; font-size:11px; letter-spacing:0.1em; text-transform:uppercase; color:rgba(255,255,255,0.35); margin-bottom:6px; }
      .me-field-group { display:flex; flex-direction:column; gap:6px; }
      .me-inline-input { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); border-radius:6px; padding:8px 10px; font-size:13px; color:rgba(255,255,255,0.8); outline:none; width:100%; font-family:'Georgia',serif; }
      .me-inline-input:focus { border-color:rgba(180,230,200,0.3); }
      textarea.me-inline-input { resize:vertical; }
      .me-modal-err { font-size:12px; color:rgba(255,120,100,0.8); min-height:16px; }
      .me-modal-btns { display:flex; gap:10px; justify-content:flex-end; margin-top:4px; flex-wrap:wrap; }
      .me-modal-cancel { padding:8px 18px; border-radius:8px; border:1px solid rgba(255,255,255,0.12); background:none; color:rgba(255,255,255,0.45); cursor:pointer; font-family:'Georgia',serif; font-size:13px; }
      .me-modal-ok { padding:8px 18px; border-radius:8px; border:1px solid rgba(180,230,200,0.3); background:rgba(180,230,200,0.1); color:rgba(180,230,200,0.8); cursor:pointer; font-family:'Georgia',serif; font-size:13px; }
      .me-checkbox-row { display:flex; align-items:center; gap:8px; font-size:13px; color:rgba(255,255,255,0.7); }
      .me-checkbox-row input { width:15px; height:15px; accent-color:rgba(180,230,200,0.7); }
      #meVeRichBody { background:#0d1210; border-radius:8px; min-height:140px; }
    `;
    document.head.appendChild(style);
  }

  let _typesMetaCache = null;
  async function getTypesMeta() {
    if (_typesMetaCache) return _typesMetaCache;
    const res = await fetch('/api/admin/message-versions/types');
    const list = await res.json();
    _typesMetaCache = {};
    list.forEach(t => { _typesMetaCache[t.type] = t; });
    return _typesMetaCache;
  }

  const VERSION_EXTRA_FIELD_RENDERERS = {
    days: { render: (val) => `<div class="me-field-group"><label>Days threshold</label><input class="me-inline-input" type="number" min="1" max="30" id="meVeExtra_days" value="${val ?? ''}" style="width:100px"/></div>` },
    sms_body: { render: (val) => `<div class="me-field-group"><label>SMS body</label><textarea class="me-inline-input" id="meVeExtra_sms_body" rows="2">${escVe(val ?? '')}</textarea></div>` },
  };
  function escVe(s) { return (s==null?'':String(s)).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtVeDate(s) {
    if (!s) return '—';
    try { return new Date(s.replace(' ','T')+'Z').toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
    catch { return s.slice(0,16); }
  }

  const sectionsByType = {}; // type -> { listEl, warnEl, opts }
  let _veModalInjected = false;
  function ensureVersionModal() {
    if (_veModalInjected) return;
    _veModalInjected = true;
    ensureVersionStyles();
    const overlay = document.createElement('div');
    overlay.className = 'me-modal-overlay';
    overlay.id = 'meVeModalOverlay';
    overlay.innerHTML = `
      <div class="me-modal">
        <h3 id="meVeTitle">New version</h3>
        <input type="hidden" id="meVeType"/>
        <input type="hidden" id="meVeId"/>
        <div class="me-field-group">
          <label>Label <span style="text-transform:none;color:rgba(255,255,255,0.25)">— a short note to tell this version apart later, e.g. "Christmas 2026"</span></label>
          <input class="me-inline-input" type="text" id="meVeLabel" placeholder="Optional"/>
        </div>
        <div class="me-field-group">
          <label>Subject</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input class="me-inline-input" type="text" id="meVeSubject" style="flex:1"/>
            <span id="meVeSubjectTokenWrap"></span>
          </div>
        </div>
        <div class="me-field-group">
          <label>Body</label>
          <div id="meVeFormatToggleWrap"></div>
          <textarea class="me-inline-input" id="meVePlainBody" rows="6" style="width:100%"></textarea>
          <div id="meVeRichBody" style="display:none"></div>
          <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center" id="meVeBodyTokenWrap"></div>
          <div id="meVeAiGenerateWrap" style="display:none"></div>
        </div>
        <div id="meVeExtraFields"></div>
        <label class="me-checkbox-row">
          <input type="checkbox" id="meVeMakeActive"/>
          Make this the active version
        </label>
        <div class="me-modal-err" id="meVeErr"></div>
        <div class="me-modal-btns">
          <button class="me-modal-cancel" type="button" onclick="MessageEditor.closeVersionEditor()">Cancel</button>
          <button class="me-modal-ok" type="button" onclick="MessageEditor.saveVersionEditor()">Save version</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  }

  let _veFormat = 'plain';
  function renderVeFormatToggle() {
    document.getElementById('meVeFormatToggleWrap').innerHTML = formatToggleHtml('meVeBodyFmt', _veFormat, 'MessageEditor._setVeFormat');
  }
  function _setVeFormat(_idPrefix, fmt) {
    _veFormat = fmt;
    renderVeFormatToggle();
    const plainEl = document.getElementById('meVePlainBody');
    const richEl = document.getElementById('meVeRichBody');
    if (fmt === 'rich') {
      plainEl.style.display = 'none';
      richEl.style.display = 'block';
      if (!isMounted('meVeRichBody')) mountRich('meVeRichBody', plainEl.value ? plainEl.value.replace(/\n/g,'<br>') : '');
    } else {
      richEl.style.display = 'none';
      plainEl.style.display = 'block';
    }
    renderVeTokenWraps();
  }
  function renderVeTokenWraps() {
    const type = document.getElementById('meVeType').value;
    const extraTokens = (sectionsByType[type] && sectionsByType[type].opts.extraTokens) || null;
    document.getElementById('meVeSubjectTokenWrap').innerHTML = tokenSelectHtml('meVeSubject', standardTokens(extraTokens));
    document.getElementById('meVeBodyTokenWrap').innerHTML = tokenSelectHtml(
      'meVeRichBody', standardTokens(extraTokens), { placeholder: 'Insert field into body…', rich: _veFormat === 'rich' }
    );
    const aiWrap = document.getElementById('meVeAiGenerateWrap');
    if (_veFormat === 'rich') { aiWrap.style.display = ''; aiWrap.innerHTML = aiGenerateHtml('meVeRichBody'); }
    else { aiWrap.style.display = 'none'; aiWrap.innerHTML = ''; }
  }
  function renderVeExtraFields(type, extra) {
    getTypesMeta().then(metaMap => {
      const keys = (metaMap[type] && metaMap[type].extraFields) || [];
      const wrap = document.getElementById('meVeExtraFields');
      wrap.innerHTML = keys.map(k => (VERSION_EXTRA_FIELD_RENDERERS[k] ? VERSION_EXTRA_FIELD_RENDERERS[k].render((extra||{})[k]) : '')).join('');
    });
  }
  async function collectVeExtraFields(type) {
    const metaMap = await getTypesMeta();
    const keys = (metaMap[type] && metaMap[type].extraFields) || [];
    const extra = {};
    keys.forEach(k => {
      const el = document.getElementById(`meVeExtra_${k}`);
      if (el) extra[k] = el.type === 'number' ? Number(el.value) : el.value;
    });
    return extra;
  }

  async function openVersionEditor(type, prefill) {
    ensureVersionModal();
    closeAiPreview('meVeRichBody');
    const metaMap = await getTypesMeta();
    document.getElementById('meVeType').value = type;
    document.getElementById('meVeId').value = (prefill && prefill.__editId) || '';
    document.getElementById('meVeTitle').textContent = (prefill && prefill.__editId) ? 'Edit version' : (metaMap[type] ? `New ${metaMap[type].label} version` : 'New version');
    document.getElementById('meVeLabel').value = (prefill && prefill.label) || '';
    document.getElementById('meVeSubject').value = (prefill && prefill.subject) || '';
    document.getElementById('meVePlainBody').value = (prefill && prefill.body) || '';
    document.getElementById('meVeMakeActive').checked = false;
    document.getElementById('meVeErr').textContent = '';
    _veFormat = (prefill && prefill.format) || 'plain';
    renderVeFormatToggle();
    document.getElementById('meVePlainBody').style.display = _veFormat === 'rich' ? 'none' : 'block';
    document.getElementById('meVeRichBody').style.display = _veFormat === 'rich' ? 'block' : 'none';
    if (_veFormat === 'rich') mountRich('meVeRichBody', (prefill && prefill.body) || '');
    else { destroy('meVeRichBody'); document.getElementById('meVeRichBody').innerHTML = ''; }
    renderVeTokenWraps();
    renderVeExtraFields(type, prefill && prefill.extra);
    document.getElementById('meVeModalOverlay').classList.add('me-open');
  }
  function closeVersionEditor() {
    const overlay = document.getElementById('meVeModalOverlay');
    if (overlay) overlay.classList.remove('me-open');
  }

  async function editVersionRow(id, type) {
    const res = await fetch(`/api/admin/message-versions?type=${type}`);
    const rows = await res.json();
    const row = rows.find(r => r.id === id);
    if (!row) return;
    openVersionEditor(type, { ...row, __editId: id });
  }
  async function duplicateVersionRow(id, type) {
    const res = await fetch(`/api/admin/message-versions?type=${type}`);
    const rows = await res.json();
    const row = rows.find(r => r.id === id);
    if (!row) return;
    openVersionEditor(type, { ...row, label: row.label ? `${row.label} (copy)` : '' });
  }
  async function saveVersionEditor() {
    const type = document.getElementById('meVeType').value;
    const id = document.getElementById('meVeId').value;
    const label = document.getElementById('meVeLabel').value.trim();
    const subject = document.getElementById('meVeSubject').value.trim();
    const body = _veFormat === 'rich' ? getHtml('meVeRichBody') : document.getElementById('meVePlainBody').value;
    const extra = await collectVeExtraFields(type);
    const makeActive = document.getElementById('meVeMakeActive').checked;
    const errEl = document.getElementById('meVeErr');
    errEl.textContent = '';
    if (!subject && !body) { errEl.textContent = 'Write a subject or body first.'; return; }
    try {
      let res;
      if (id) {
        res = await fetch(`/api/admin/message-versions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, subject, body, format: _veFormat, extra }) });
        if (res.ok && makeActive) await fetch(`/api/admin/message-versions/${id}/activate`, { method: 'POST' });
      } else {
        res = await fetch('/api/admin/message-versions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, label, subject, body, format: _veFormat, extra, makeActive }) });
      }
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error || 'Could not save.'; return; }
      closeVersionEditor();
      refreshVersionSection(type);
    } catch (e) { errEl.textContent = 'Error: ' + e.message; }
  }
  async function activateVersionRow(id, type) {
    if (!(await window.appConfirm('Make this the active version?'))) return;
    await fetch(`/api/admin/message-versions/${id}/activate`, { method: 'POST' });
    refreshVersionSection(type);
  }
  async function deleteVersionRow(id, type) {
    if (!(await window.appConfirm('Delete this version? This cannot be undone.'))) return;
    const res = await fetch(`/api/admin/message-versions/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { await window.appAlert(data.error || 'Could not delete.'); return; }
    refreshVersionSection(type);
  }

  // Renders a complete section — warning banner, card, "New version"
  // button, table of versions — into containerEl for the given type.
  // opts: { label (override registry default), extraTokens: [{value,
  // label}] (e.g. Savers cancel-day0's {{period_end}}), newButtonLabel }
  async function renderVersionSection(containerEl, type, opts) {
    opts = opts || {};
    ensureVersionStyles();
    ensureVersionModal();
    const metaMap = await getTypesMeta();
    const meta = metaMap[type] || { label: type };
    const label = opts.label || meta.label;
    containerEl.classList.add('me-version-ui');
    containerEl.innerHTML = `
      <div class="me-section-label">${escVe(label)}</div>
      <div class="me-warn-banner" style="display:none"></div>
      <div class="me-card">
        <div class="me-card-header">
          <div class="me-card-title">Versions</div>
          <button class="me-btn me-sm me-primary" type="button">${escVe(opts.newButtonLabel || 'New version')}</button>
        </div>
        <div class="me-version-list"><div class="me-empty-note">Loading…</div></div>
      </div>`;
    const warnEl = containerEl.querySelector('.me-warn-banner');
    const listEl = containerEl.querySelector('.me-version-list');
    const newBtn = containerEl.querySelector('.me-btn.me-primary');
    newBtn.addEventListener('click', () => openVersionEditor(type));
    sectionsByType[type] = { warnEl, listEl, opts };
    await refreshVersionSection(type);
  }

  async function refreshVersionSection(type) {
    const sec = sectionsByType[type];
    if (!sec) return;
    try {
      const res = await fetch(`/api/admin/message-versions?type=${type}`);
      const rows = await res.json();
      const hasActive = rows.some(r => r.is_active);
      sec.warnEl.style.display = hasActive ? 'none' : 'flex';
      sec.warnEl.innerHTML = hasActive ? '' : `⚠ No active version — this type has nothing for an automated send to use once it switches over to the new system.`;
      if (!rows.length) {
        sec.listEl.innerHTML = `<div class="me-empty-note">No versions yet — click "New version" to write the first one.</div>`;
        return;
      }
      sec.listEl.innerHTML = rows.map(r => `
        <div class="me-version-row">
          <div class="me-version-main">
            <div class="me-version-label">${escVe(r.label || '(untitled)')}</div>
            <div class="me-version-subject">${escVe(r.subject || '(no subject)')}</div>
            <div class="me-version-meta">Saved ${fmtVeDate(r.created_at)}</div>
          </div>
          <div class="me-version-actions">
            ${r.is_active ? '<span class="me-active-pill">Active</span>' : `<button class="me-btn me-sm" type="button" data-act="activate" data-id="${r.id}">Make active</button>`}
            <button class="me-btn me-sm" type="button" data-act="edit" data-id="${r.id}">Edit</button>
            <button class="me-btn me-sm" type="button" data-act="duplicate" data-id="${r.id}">Duplicate</button>
            <button class="me-btn me-sm me-danger" type="button" data-act="delete" data-id="${r.id}" ${r.is_active ? 'disabled title="Activate a different version first"' : ''}>Delete</button>
          </div>
        </div>`).join('');
      sec.listEl.querySelectorAll('button[data-act]').forEach(btn => {
        const id = btn.getAttribute('data-id');
        const act = btn.getAttribute('data-act');
        btn.addEventListener('click', () => {
          if (act === 'activate') activateVersionRow(id, type);
          else if (act === 'edit') editVersionRow(id, type);
          else if (act === 'duplicate') duplicateVersionRow(id, type);
          else if (act === 'delete') deleteVersionRow(id, type);
        });
      });
    } catch (e) {
      sec.listEl.innerHTML = `<div class="me-empty-note">Couldn't load — ${escVe(e.message)}</div>`;
    }
  }

  // A few internal functions need to be reachable from the modal's own
  // inline onclick handlers (format toggle, save, cancel) — exposed here
  // rather than kept fully private.
  window.MessageEditor.closeVersionEditor = closeVersionEditor;
  window.MessageEditor.saveVersionEditor = saveVersionEditor;
  window.MessageEditor._setVeFormat = _setVeFormat;
})(window);
