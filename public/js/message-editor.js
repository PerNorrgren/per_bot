// ── Unified message editor — shared primitives (Per Bot 19) ──
// Used by Trial sequence, Savers Protocol, and Campaign email steps
// (sales.html). Newsletters (comms.html) keeps its own existing, heavier
// editor as-is — columns/buttons/video/AI-polish are genuinely
// newsletter-grade features, disproportionate for a short transactional
// message like a day-3 trial email or a cancellation notice. This module
// is deliberately lighter: bold/italic/underline/link/image only.
//
// Not used for Reminder/Renewal/Birthday — those stay plain-text-only
// (token dropdown still applies to them, via insertTokenAtField below),
// per the scope agreed for this build.
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

  // ── Light rich editor ── bold/italic/underline/link/image only — see
  // the file header for why this doesn't reuse Newsletters' full toolbar.
  function mountRich(containerId, initialHtml, opts) {
    opts = opts || {};
    if (instances[containerId]) { destroy(containerId); }
    const q = new Quill('#' + containerId, {
      theme: 'snow',
      placeholder: opts.placeholder || '',
      modules: { toolbar: [['bold', 'italic', 'underline'], ['link', 'image'], ['clean']] },
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

  window.MessageEditor = {
    insertTokenAtField, insertTokenAtRich, standardTokens, tokenSelectHtml,
    formatToggleHtml, mountRich, destroy, getHtml, isMounted,
  };
})(window);
