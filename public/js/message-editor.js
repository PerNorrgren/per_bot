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
  };
})(window);
