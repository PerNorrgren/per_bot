// ── Unified message editor — shared primitives (Per Bot 19, extended
// Per Bot 54) ── Used everywhere a message gets composed: comms2.html's
// Reminder/Renewal/Birthday/Newsletter Welcome/Trial Extended,
// sales.html's Trial sequence/Savers Protocol/Campaign steps, and
// (Per Bot 54) Newsletter and MOTD too. Per: "the rich editor with all
// features is the one I want for all messages" — mountRich below is now
// the exact full Newsletter editor (columns, video, buttons, image
// resize, AI Help), generalized to mount on any containerId rather than
// the single hardcoded Newsletter instance it started as. There is
// deliberately only one rich editor implementation left in this app.
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
      /* Per Bot 24 — text-content buttons (1 col/2 col/3 col, AI Help),
         not the SVG-icon ones above (B/I/U/alignment/lists/link/image),
         which already get their colour from .ql-stroke/.ql-fill. These
         never had an equivalent override, so they sat at the browser's
         plain default black button text — invisible on this dark
         toolbar. (Fixed once already, but in ensureVersionStyles() below
         — the modal's OWN styling, not this function, which is the one
         mountRich actually uses for the real editor toolbar. That
         earlier fix never did anything; this is the one that matters.) */
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-nl-button,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-columns-1,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-columns-2,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-columns-3,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-ai-polish { color:rgba(255,255,255,0.5); }
      .me-ai-panel { background:#141a17; border:1px solid rgba(255,255,255,0.12); border-radius:10px; padding:14px; margin-top:8px; }
      .me-ai-body { font-size:13px; line-height:1.6; color:rgba(255,255,255,0.8); max-height:240px; overflow-y:auto; }
    `;
    document.head.appendChild(style);
  }

  // ── Full rich editor (Per Bot 54) — Per: "the rich editor with all
  // features is the one I want for all messages." This is the exact
  // Newsletter editor from comms.html, generalized to mount on any
  // containerId instead of a single hardcoded '#newsletterRichEditor'
  // singleton — headers, alignment, lists, link, image (upload, link,
  // copy, resize), video (link or upload with poster), buttons, 1/2/3
  // side-by-side columns, AI Help (rewrite the whole message), and
  // (Per Bot 54) the Generate & insert dropdown. Every comment below
  // describing a specific bug and its fix is preserved verbatim from
  // the original — hard-won knowledge about Quill 1.3.7's internals
  // that any future change here needs to keep in mind, not just
  // decoration.
  //
  // lastClickedImage/lastCellSelection stay module-level (not per-
  // container) since only one heavy editor is ever visible/interactive
  // at a time on any given page — matches how it always worked in
  // comms.html, just no longer assuming there's exactly one editor that
  // will ever exist for the lifetime of the page.

  let _blotsRegistered = false;
  function ensureBlotsRegistered() {
    if (_blotsRegistered || typeof Quill === 'undefined') return;
    _blotsRegistered = true;
    const BlockEmbed = Quill.import('blots/block/embed');

    // Columns block. Table-based markup (not flexbox/grid) because real
    // email clients — Outlook especially — don't reliably support CSS
    // layout; a table is the one thing that actually renders consistently
    // side-by-side across clients. Quill treats the whole block as a
    // single atomic embed (like an image) and won't try to track edits
    // inside it via its own Delta model — but each cell is explicitly
    // marked contenteditable="true", so the browser still lets you click
    // in and type or drop an image directly, independent of Quill's model.
    class ColumnsBlot extends BlockEmbed {
      static create(value) {
        const node = super.create();
        const count = (value && value.count) || 2;
        node.setAttribute('contenteditable', 'false');
        node.style.cssText = 'margin:14px 0;';
        const cellWidth = Math.floor(100 / count);
        let cells = '';
        for (let i = 0; i < count; i++) {
          const pad = i < count - 1 ? '0 16px 0 0' : '0';
          cells += `<td valign="top" contenteditable="true" style="width:${cellWidth}%;padding:${pad};vertical-align:top;outline:none" data-column-cell="true"><p>Column text or image…</p></td>`;
        }
        node.innerHTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table>`;
        return node;
      }
      // Reads back whatever's actually in the DOM now, not a stored value
      // from insertion time — the cells are live editable regions, so
      // their content changes after the block is first inserted.
      static value(node) { return node.innerHTML; }
    }
    ColumnsBlot.blotName = 'columnsBlock';
    ColumnsBlot.tagName = 'DIV';
    ColumnsBlot.className = 'ql-columns-block';
    Quill.register(ColumnsBlot);

    // Button — a real Quill link (Quill's own well-tested built-in
    // mechanism, not custom insertion logic), just tagged with a class so
    // it survives Quill's serialization and can be found and converted
    // into a properly inline-styled button server-side before sending.
    const Link = Quill.import('formats/link');
    class ButtonLink extends Link {
      static create(value) {
        const node = super.create(value);
        node.setAttribute('class', 'nl-button');
        return node;
      }
    }
    ButtonLink.blotName = 'buttonLink';
    Quill.register(ButtonLink, true);

    // Video block — atomic embed like ColumnsBlot above, since there's
    // nothing editable inside it (just the bulletproof video/poster/
    // fallback-link markup built in buildVideoBlockHtml below). Storing
    // the fully-built HTML as the blot's value means the editor never
    // has to reconstruct it from parts on reload.
    class VideoBlot extends BlockEmbed {
      static create(value) {
        const node = super.create();
        node.setAttribute('contenteditable', 'false');
        node.style.cssText = 'margin:14px 0;';
        node.innerHTML = value.html;
        return node;
      }
      static value(node) { return { html: node.innerHTML }; }
    }
    VideoBlot.blotName = 'videoBlock';
    VideoBlot.tagName = 'DIV';
    VideoBlot.className = 'ql-video-block';
    Quill.register(VideoBlot);
  }

  let lastClickedImage = null;
  let lastCellSelection = null;
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { return; }
    const node = sel.getRangeAt(0).startContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const cellEl = el ? el.closest('[data-column-cell]') : null;
    lastCellSelection = cellEl ? { cellEl, range: sel.getRangeAt(0).cloneRange(), browserSel: sel } : null;
  });

  function insertNodeAtCellRange(target, node) {
    target.range.deleteContents();
    target.range.insertNode(node);
    target.range.setStartAfter(node);
    target.range.collapse(true);
    target.browserSel.removeAllRanges();
    target.browserSel.addRange(target.range);
  }

  // ── Shared insertion targeting ── A columns block is a single atomic
  // unit as far as Quill's own selection/Delta model is concerned —
  // clicking inside one of its cells moves the browser's real cursor
  // there, but quill.getSelection() has no visibility into it at all.
  // Every custom insertion (image, video link, button, image link) needs
  // to check the REAL browser selection first and look for a column-cell
  // ancestor. Tracking the last known cell selection continuously
  // (selectionchange listener above), rather than trying to catch it
  // fresh after the fact, sidesteps Quill's toolbar mousedown handling
  // stomping on the real browser selection before a click handler fires.
  function getInsertionTarget(q) {
    if (lastCellSelection && document.contains(lastCellSelection.cellEl)) {
      return { inCell: true, range: lastCellSelection.range, browserSel: lastCellSelection.browserSel };
    }
    return { inCell: false, quillRange: q.getSelection(true) || { index: q.getLength() } };
  }
  function inCell() {
    return !!(lastCellSelection && document.contains(lastCellSelection.cellEl));
  }
  function restoreCellSelection() {
    lastCellSelection.browserSel.removeAllRanges();
    lastCellSelection.browserSel.addRange(lastCellSelection.range);
  }
  function formatInCellOrQuill(q, format) {
    if (inCell()) { restoreCellSelection(); document.execCommand(format); return; }
    q.format(format, !q.getFormat()[format]);
  }

  function insertColumnsBlock(q, count) {
    const range = q.getSelection(true) || { index: q.getLength() };
    q.insertEmbed(range.index, 'columnsBlock', { count });
    q.setSelection(range.index + 1);
  }

  async function linkSelectedImage(q) {
    if (lastClickedImage && document.contains(lastClickedImage)) {
      const url = await window.appPrompt('Link this image to:');
      if (!url || !url.trim()) return;
      const a = document.createElement('a');
      a.href = url.trim();
      lastClickedImage.parentNode.insertBefore(a, lastClickedImage);
      a.appendChild(lastClickedImage);
      return;
    }
    const range = q.getSelection();
    if (!range || range.length === 0) { window.appAlert('Click directly on an image to select it first, then click this button.'); return; }
    const [leaf] = q.getLeaf(range.index);
    if (!leaf || !leaf.domNode || leaf.domNode.tagName !== 'IMG') { window.appAlert("That selection isn't an image — click directly on an image first."); return; }
    const url = await window.appPrompt('Link this image to:');
    if (!url || !url.trim()) return;
    q.formatText(range.index, 1, 'link', url.trim());
  }

  // Reliable clipboard copy for an image already in the editor, meant to
  // pair with the pasted-image fix below: copy an image out with this
  // button, paste it back in anywhere (including a different spot in the
  // same message) as a way to move one, since Quill has no drag-
  // reposition. Does its own fresh fetch() of the image rather than
  // relying on the browser's native right-click "Copy Image" — that
  // reads whatever the browser currently has decoded/cached, which can
  // go stale; this always copies what's actually at the URL right now.
  async function copySelectedImage(q) {
    let img = (lastClickedImage && document.contains(lastClickedImage)) ? lastClickedImage : null;
    if (!img) {
      const range = q.getSelection();
      const leaf = range ? q.getLeaf(range.index)[0] : null;
      if (leaf && leaf.domNode && leaf.domNode.tagName === 'IMG') img = leaf.domNode;
    }
    if (!img) { window.appAlert('Click directly on an image to select it first, then click this button.'); return; }
    try {
      // Real bug found (kept here as a warning for anyone touching this
      // again): `await fetch(...)` THEN `await navigator.clipboard.write(...)`
      // loses the user-gesture context in Safari (and some Chrome
      // policies) by the time the write actually happens — the write
      // then silently fails, leaving whatever was on the clipboard before
      // untouched. Fix: pass the fetch as a still-pending promise straight
      // into ClipboardItem — the constructor call itself is synchronous
      // within this click handler's call stack, which is what the browser
      // actually checks, even though the promise it's holding resolves
      // later.
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': fetch(img.src).then(r => r.blob()) })
      ]);
      window.appAlert('Image copied — paste it anywhere with your normal paste shortcut, including elsewhere in this message.');
    } catch (e) {
      try {
        await navigator.clipboard.writeText(img.src);
        window.appAlert('Could not copy the image itself (your browser may not support it) — copied the image link instead.');
      } catch (e2) {
        window.appAlert('Could not copy this image. Try right-click > Copy Image instead.');
      }
    }
  }

  // Resize, not compress: the resize handles already let someone drag an
  // image down to a smaller display size, but that's purely CSS — the
  // underlying file is still whatever full size it was uploaded at. This
  // re-encodes the actual file at the size it's currently being shown at,
  // keeping PNG (lossless) rather than switching to a lossy format.
  async function shrinkSelectedImage(q) {
    let img = (lastClickedImage && document.contains(lastClickedImage)) ? lastClickedImage : null;
    if (!img) {
      const range = q.getSelection();
      const leaf = range ? q.getLeaf(range.index)[0] : null;
      if (leaf && leaf.domNode && leaf.domNode.tagName === 'IMG') img = leaf.domNode;
    }
    if (!img) { window.appAlert('Click directly on an image to select it first, then click this button.'); return; }
    const targetWidth = Math.round(img.getBoundingClientRect().width);
    if (!targetWidth || targetWidth < 20) { window.appAlert("Could not read this image's current display size."); return; }
    try {
      const res = await fetch(img.src);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      if (bitmap.width <= targetWidth) {
        window.appAlert(`This image is already ${bitmap.width}px wide, no bigger than its current display size — nothing to shrink.`);
        return;
      }
      const scale = targetWidth / bitmap.width;
      const targetHeight = Math.round(bitmap.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, targetWidth, targetHeight);
      const newBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const formData = new FormData();
      formData.append('file', newBlob, 'resized.png');
      const uploadRes = await fetch('/api/admin/newsletter-images', { method: 'POST', body: formData });
      const data = await uploadRes.json();
      if (!data.url) { window.appAlert(data.error || 'Could not resize this image.'); return; }
      const savingsPct = Math.round((1 - newBlob.size / blob.size) * 100);
      img.removeAttribute('width');
      img.style.width = '';
      img.src = data.url;
      window.appAlert(`Resized to ${targetWidth}×${targetHeight}px${savingsPct > 0 ? ` — about ${savingsPct}% smaller` : ''}, keeping the email lighter.`);
    } catch (e) {
      window.appAlert('Could not resize this image. Please try again.');
    }
  }

  async function insertNewsletterButton(q) {
    const result = await window.appPromptMulti([
      { label: 'Button text' },
      { label: 'Button link (https://...)' },
    ]);
    if (result === null) return;
    const [text, url] = result;
    if (!text || !text.trim()) return;
    if (!url || !url.trim()) return;
    const label = text.trim();
    const linkUrl = url.trim();
    // Native OS color picker rather than a custom modal — click() on a
    // hidden <input type="color"> opens it immediately. Defaults to
    // today's green, so leaving it alone (or just closing the picker)
    // reproduces the exact old behaviour with nothing to configure.
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = '#2d6a4f';
    colorInput.style.cssText = 'position:fixed;opacity:0;pointer-events:none;left:-9999px;top:-9999px';
    document.body.appendChild(colorInput);
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      insertNewsletterButtonWithColor(q, label, linkUrl, colorInput.value);
      colorInput.remove();
    };
    colorInput.addEventListener('change', finish, { once: true });
    colorInput.addEventListener('blur', () => setTimeout(finish, 150), { once: true });
    colorInput.click();
  }
  function insertNewsletterButtonWithColor(q, label, linkUrl, color) {
    const target = getInsertionTarget(q);
    if (target.inCell) {
      const a = document.createElement('a');
      a.href = linkUrl;
      a.className = 'nl-button';
      a.style.background = color;
      a.textContent = label;
      insertNodeAtCellRange(target, a);
      return;
    }
    q.insertText(target.quillRange.index, label, 'buttonLink', linkUrl);
    q.insertText(target.quillRange.index + label.length, '\n');
    q.setSelection(target.quillRange.index + label.length + 1);
    // Quill's Link format only carries an href, no color concept — applied
    // directly to the DOM node right after insertion instead.
    const leaf = q.getLeaf(target.quillRange.index)[0];
    if (leaf && leaf.domNode) leaf.domNode.style.background = color;
  }

  async function insertVideoLink(q) {
    const url = await window.appPrompt('Paste the video link (YouTube, Vimeo, or any URL):');
    if (!url || !url.trim()) return;
    const target = getInsertionTarget(q);
    const label = '▶ Watch the video';
    if (target.inCell) {
      const a = document.createElement('a');
      a.href = url.trim();
      a.textContent = label;
      insertNodeAtCellRange(target, a);
      return;
    }
    q.insertText(target.quillRange.index, label, 'link', url.trim());
    q.insertText(target.quillRange.index + label.length, '\n');
    q.setSelection(target.quillRange.index + label.length + 1);
  }

  // Builds the standard "bulletproof" video-in-email pattern: a real
  // <video> tag for clients that support inline playback (Apple Mail, iOS
  // Mail), wrapped so Outlook (which renders via Word and chokes on
  // <video>) is steered to a plain poster-image fallback via MSO
  // conditional comments instead.
  function buildVideoBlockHtml(videoUrl, posterUrl) {
    const posterImg = posterUrl
      ? `<img src="${posterUrl}" alt="Watch the video" width="100%" style="max-width:480px;border-radius:8px;display:block;margin:0 auto"/>`
      : `<div style="max-width:480px;margin:0 auto;padding:40px 20px;background:#f0f0eb;border-radius:8px;text-align:center;font-family:Georgia,serif;color:#2d6a4f;font-size:15px">▶ Watch the video</div>`;
    return `<div style="text-align:center">
      <a href="${videoUrl}" target="_blank" style="text-decoration:none">
        <!--[if !mso]><!-->
        <video poster="${posterUrl}" controls="controls" width="100%" style="max-width:480px;border-radius:8px;display:block;margin:0 auto">
          <source src="${videoUrl}" type="video/mp4">
          ${posterImg}
        </video>
        <!--<![endif]-->
        <!--[if mso]>${posterImg}<![endif]-->
      </a>
    </div>`;
  }
  function insertVideoBlockAtTarget(q, target, videoUrl, posterUrl) {
    const html = buildVideoBlockHtml(videoUrl, posterUrl);
    if (target.inCell) {
      const div = document.createElement('div');
      div.innerHTML = html;
      div.setAttribute('contenteditable', 'false');
      insertNodeAtCellRange(target, div);
      if (!div.nextSibling) div.parentNode.insertBefore(document.createTextNode('\u00A0'), div.nextSibling);
      return;
    }
    q.insertEmbed(target.quillRange.index, 'videoBlock', { html });
    q.insertText(target.quillRange.index + 1, ' ');
    q.setSelection(target.quillRange.index + 2);
  }
  function uploadFileGetUrl(endpoint, file) {
    return new Promise(async (resolve, reject) => {
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await fetch(endpoint, { method: 'POST', body: fd });
        const data = await res.json();
        if (data.url) resolve(data.url); else reject(new Error(data.error || 'Upload failed.'));
      } catch (e) { reject(e); }
    });
  }
  async function insertNewsletterVideo(q) {
    const target = getInsertionTarget(q);
    const videoInput = document.createElement('input');
    videoInput.type = 'file';
    videoInput.accept = 'video/*';
    videoInput.onchange = async () => {
      const videoFile = videoInput.files[0];
      if (!videoFile) return;
      let videoUrl;
      try {
        videoUrl = await uploadFileGetUrl('/api/admin/newsletter-videos', videoFile);
      } catch (e) { window.appAlert(e.message || 'Could not upload video.'); return; }
      let posterUrl = '';
      if (await window.appConfirm('Add a thumbnail image for the video? Recommended — without one, inboxes that can\'t play it inline just show a plain "Watch the video" box instead of a picture.')) {
        const imgInput = document.createElement('input');
        imgInput.type = 'file';
        imgInput.accept = 'image/*';
        posterUrl = await new Promise((resolve) => {
          imgInput.onchange = async () => {
            const imgFile = imgInput.files[0];
            if (!imgFile) { resolve(''); return; }
            try { resolve(await uploadFileGetUrl('/api/admin/newsletter-images', imgFile)); }
            catch (e) { window.appAlert('Could not upload thumbnail — inserting without one.'); resolve(''); }
          };
          imgInput.click();
        });
      }
      insertVideoBlockAtTarget(q, target, videoUrl, posterUrl);
    };
    videoInput.click();
  }
  // Dynamically-created hidden file input, one per call — same pattern
  // as the light editor's old uploadImage helper — rather than a static
  // page element with a fixed id, so this works for any container on any
  // page, not just Newsletter's own modal.
  async function uploadImageIntoEditor(q) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    const target = getInsertionTarget(q);
    if (!target.inCell) q.insertText(target.quillRange.index, 'Uploading image…');
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) { if (!target.inCell) q.deleteText(target.quillRange.index, 'Uploading image…'.length); return; }
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch('/api/admin/newsletter-images', { method: 'POST', body: formData });
        const data = await res.json();
        if (!data.url) {
          if (!target.inCell) q.deleteText(target.quillRange.index, 'Uploading image…'.length);
          window.appAlert(data.error || 'Could not upload image.');
          return;
        }
        if (target.inCell) {
          const img = document.createElement('img');
          img.src = data.url;
          img.style.maxWidth = '100%';
          insertNodeAtCellRange(target, img);
          // The image-resize module's click-to-select and alignment
          // toolbar need a real sibling node to attach to — an image with
          // nothing after it couldn't be "selected" at all.
          if (!img.nextSibling) img.parentNode.insertBefore(document.createTextNode('\u00A0'), img.nextSibling);
        } else {
          q.deleteText(target.quillRange.index, 'Uploading image…'.length);
          q.insertEmbed(target.quillRange.index, 'image', data.url);
          if (target.quillRange.index + 1 >= q.getLength() - 1) q.insertText(target.quillRange.index + 1, ' ');
          q.setSelection(target.quillRange.index + 1);
        }
      } catch (e) {
        if (!target.inCell) q.deleteText(target.quillRange.index, 'Uploading image…'.length);
        window.appAlert('Network error — could not upload image.');
      }
    };
    input.click();
  }

  // AI Help — reads the whole editor, sends it for a full rewrite,
  // replaces the editor's content outright on success. No accept/discard
  // step by design — easy to amend anything afterward, and a review
  // modal would just add friction for something meant to be a quick
  // "make this better" nudge. Distinct from the Generate & insert
  // dropdown (aiGenerateHtml/runAiGenerate below) — this improves what's
  // already there; that inserts something new alongside it.
  async function runAiPolish(q, btn) {
    if (!btn) return;
    if (!q.getText().trim()) { window.appAlert('Write something first.'); return; }
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await fetch('/api/ai-polish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: q.root.innerHTML }) });
      const data = await res.json();
      if (data.html) q.root.innerHTML = data.html;
      else window.appAlert(data.error || 'Could not get a suggestion right now.');
    } catch (e) {
      window.appAlert('Something went wrong — please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  function mountRich(containerId, initialHtml, opts) {
    opts = opts || {};
    ensureStyles();
    ensureBlotsRegistered();
    if (instances[containerId]) { destroy(containerId); }
    const container = document.getElementById(containerId);
    if (container) container.classList.add('me-ql-wrap');
    if (window.ImageResize && Quill.imports['modules/imageResize'] === undefined) {
      Quill.register('modules/imageResize', window.ImageResize.default || window.ImageResize);
    }
    const q = new Quill('#' + containerId, {
      theme: 'snow',
      placeholder: opts.placeholder || '',
      modules: {
        toolbar: {
          container: [
            [{ header: [2, 3, false] }],
            ['bold', 'italic', 'underline'],
            [{ align: [] }],
            [{ list: 'ordered' }, { list: 'bullet' }],
            ['link', 'image', 'image-link', 'image-copy', 'image-resize', 'video-link'],
            ['nl-video'],
            ['nl-button'],
            ['columns-1', 'columns-2', 'columns-3'],
            ['ai-polish'],
            ['clean'],
          ],
          handlers: {
            image: () => uploadImageIntoEditor(q),
            'video-link': () => insertVideoLink(q),
            'nl-video': () => insertNewsletterVideo(q),
            'image-link': () => linkSelectedImage(q),
            'image-copy': () => copySelectedImage(q),
            'image-resize': () => shrinkSelectedImage(q),
            'nl-button': () => insertNewsletterButton(q),
            'columns-1': () => insertColumnsBlock(q, 1),
            'columns-2': () => insertColumnsBlock(q, 2),
            'columns-3': () => insertColumnsBlock(q, 3),
            'ai-polish': function () { runAiPolish(q, this.container.querySelector('.ql-ai-polish')); },
            // Every standard format button below has the same problem the
            // paste fix further down solves: Quill's default handlers
            // operate on ITS OWN Delta-model selection, which has no
            // concept of a position inside a column cell's raw
            // contenteditable. Each handler here checks a live cell
            // selection and, when it's active, restores the real browser
            // selection and applies the native equivalent instead —
            // otherwise falling through to Quill's own default behaviour.
            bold: () => formatInCellOrQuill(q, 'bold'),
            italic: () => formatInCellOrQuill(q, 'italic'),
            underline: () => formatInCellOrQuill(q, 'underline'),
            list: (value) => {
              if (inCell()) { restoreCellSelection(); document.execCommand(value === 'ordered' ? 'insertOrderedList' : 'insertUnorderedList'); return; }
              const current = q.getFormat().list;
              q.format('list', current === value ? false : value);
            },
            align: (value) => {
              if (inCell()) {
                restoreCellSelection();
                document.execCommand(value === 'center' ? 'justifyCenter' : value === 'right' ? 'justifyRight' : value === 'justify' ? 'justifyFull' : 'justifyLeft');
                return;
              }
              q.format('align', value);
            },
            // appPrompt() (an in-app modal, not native prompt()) for both
            // cases — Quill's own Snow-theme tooltip only has room for a
            // few characters of the URL and doesn't work inside a cell at
            // all.
            link: async () => {
              if (inCell()) {
                restoreCellSelection();
                const sel = lastCellSelection.browserSel;
                const anchor = sel.anchorNode && sel.anchorNode.nodeType === 1
                  ? sel.anchorNode.closest('a')
                  : sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest('a');
                if (anchor) { document.execCommand('unlink'); return; }
                const url = await window.appPrompt('Link this text to:');
                if (!url || !url.trim()) return;
                restoreCellSelection();
                document.execCommand('createLink', false, url.trim());
                return;
              }
              const range = q.getSelection();
              if (!range) return;
              const current = q.getFormat(range).link;
              if (current) { q.format('link', false); return; }
              const url = await window.appPrompt('Link this text to:');
              if (url && url.trim()) q.format('link', url.trim());
            },
            clean: () => {
              // The one that was actually destructive — Quill's default
              // "clean" calls removeFormat() on its own selection, which
              // (same root cause as everything else here) resolved to the
              // columns block's own position and stripped the embed
              // format itself, deleting the whole block. Native
              // removeFormat on the cell's real selection has no way to
              // reach outside the cell, so it can't touch the block.
              if (inCell()) { restoreCellSelection(); document.execCommand('removeFormat'); return; }
              const range = q.getSelection();
              if (range) q.removeFormat(range.index, range.length);
            },
          },
        },
        imageResize: { modules: ['Resize', 'DisplaySize', 'Toolbar'] },
      },
    });
    // Quill has no built-in icons/labels for any of these custom buttons —
    // the toolbar array above just references format names that don't
    // exist, which renders blank buttons; label them after Quill builds
    // the toolbar DOM. Scoped to this instance's own toolbar container
    // (not a page-wide document.querySelector) so mounting a second
    // heavy editor elsewhere on the same page can never label the wrong
    // one's buttons.
    const toolbarEl = q.getModule('toolbar').container;
    const label = (cls, text, title) => {
      const el = toolbarEl.querySelector(cls);
      if (el) { el.textContent = text; el.title = title; }
    };
    label('.ql-video-link', '▶', 'Insert a video link');
    label('.ql-nl-video', '🎬', 'Upload a video and insert an inline player');
    label('.ql-image-link', '🔗', 'Click an image first to select it, then click here to link it');
    label('.ql-image-copy', '📋', 'Click an image first to select it, then click here to copy it to your clipboard — paste it anywhere, including elsewhere in this message, as a way to move it');
    label('.ql-image-resize', '🗜️', "Click an image first, resize it with its own handles to the size you want it shown at, then click here — shrinks the actual file to match, keeping the email lighter");
    label('.ql-nl-button', '▭', 'Insert a button');
    label('.ql-columns-1', '1 col', 'Insert a single wide column');
    label('.ql-columns-2', '2 col', 'Insert two side-by-side columns');
    label('.ql-columns-3', '3 col', 'Insert three side-by-side columns');
    label('.ql-ai-polish', '✨ AI Help', 'Suggest an improved version of the whole message');

    // Tracks the last image clicked anywhere in the editor, including
    // inside a columns-block cell — see linkSelectedImage above for why
    // this has to work independently of Quill's own selection tracking.
    q.root.addEventListener('click', (e) => {
      if (e.target && e.target.tagName === 'IMG') lastClickedImage = e.target;
    });

    // Editing an existing link/button by clicking it — NEW links go
    // through appPrompt (above) instead of Quill's own Snow-theme
    // tooltip; this covers clicking an EXISTING link or button already
    // in the document, a separate code path Quill's theme handles
    // automatically and unprompted otherwise. Capture-phase so Quill's
    // own tooltip never gets to see the click at all.
    //
    // Root(); Quill.find(a) resolves the clicked node back to its Blot so
    // quill.formatText/deleteText/insertText can update the real Delta —
    // a plain DOM edit outside Quill's API gets silently reverted by its
    // MutationObserver on the next re-render, since the Delta never
    // agreed the change happened.
    q.root.addEventListener('click', async (e) => {
      const a = e.target.closest('a');
      if (!a || !q.root.contains(a)) return;
      e.preventDefault();
      e.stopPropagation();
      const blot = Quill.find(a);
      if (!blot) return;
      const index = blot.offset(q.scroll);
      const length = blot.length();
      const isButton = a.classList.contains('nl-button');
      const currentHref = a.getAttribute('href') || '';
      if (isButton) {
        const currentLabel = a.textContent || '';
        const color = a.style.background || '#2d6a4f';
        const result = await window.appPromptMulti([
          { label: 'Button text', defaultValue: currentLabel },
          { label: 'Button link (https://...)', defaultValue: currentHref },
        ]);
        if (result === null) return;
        const [newLabel, newUrl] = result;
        const finalLabel = (newLabel || '').trim() || currentLabel;
        const finalUrl = (newUrl || '').trim() || currentHref;
        q.deleteText(index, length);
        q.insertText(index, finalLabel, 'buttonLink', finalUrl);
        q.setSelection(index + finalLabel.length);
        const leaf = q.getLeaf(index)[0];
        if (leaf && leaf.domNode) leaf.domNode.style.background = color;
        return;
      }
      const newUrl = await window.appPrompt('Link this text to (leave blank to remove the link):', currentHref);
      if (newUrl === null) return;
      q.formatText(index, length, 'link', newUrl.trim() || false);
    }, true);

    // Pasted-image fix, pairs with the Copy Image toolbar button above
    // (copy an image out via that button, paste it back in anywhere —
    // including a different spot — as a way to move one, since Quill has
    // no drag-reposition). Without this, Quill's own default paste
    // handling for image clipboard data embeds it as a giant inline
    // base64 data-URI rather than a real hosted image. Capture phase so
    // this runs before Quill's handler; uploads through the exact same
    // endpoint a manual image upload already uses.
    q.root.addEventListener('paste', async (e) => {
      const items = (e.clipboardData || window.clipboardData)?.items;
      const imageItem = items && Array.from(items).find(it => it.type && it.type.startsWith('image/'));
      if (!imageItem) return;
      e.stopPropagation();
      e.preventDefault();
      const target = getInsertionTarget(q);
      const file = imageItem.getAsFile();
      if (!file) return;
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch('/api/admin/newsletter-images', { method: 'POST', body: formData });
        const data = await res.json();
        if (!data.url) { window.appAlert(data.error || 'Could not paste that image.'); return; }
        if (target.inCell) {
          const img = document.createElement('img');
          img.src = data.url;
          img.style.maxWidth = '100%';
          insertNodeAtCellRange(target, img);
          if (!img.nextSibling) img.parentNode.insertBefore(document.createTextNode('\u00A0'), img.nextSibling);
        } else {
          q.insertEmbed(target.quillRange.index, 'image', data.url);
          if (target.quillRange.index + 1 >= q.getLength() - 1) q.insertText(target.quillRange.index + 1, ' ');
          q.setSelection(target.quillRange.index + 1);
        }
      } catch (e2) {
        window.appAlert('Network error — could not paste that image.');
      }
    }, true);

    // Paste-into-column fix — Quill treats the whole columns block as one
    // atomic embed and has no concept of a cursor position *inside* a
    // cell, so its own paste handler (bubble-phase) drops pasted content
    // right after the block instead of into the cell being looked at.
    // Capture phase runs before Quill ever sees the event. Plain text
    // rather than rich HTML deliberately — clipboard HTML from Word/
    // Google Docs tends to carry styling that breaks once this goes
    // through the email-client conversion step.
    q.root.addEventListener('paste', (e) => {
      const cell = e.target && e.target.closest ? e.target.closest('[data-column-cell]') : null;
      if (!cell) return;
      e.stopPropagation();
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    }, true);

    if (initialHtml) q.clipboard.dangerouslyPasteHTML(initialHtml);
    instances[containerId] = q;
    // Per Bot 24 — explicit spell-check, rather than relying on browser
    // default behaviour for a contenteditable region, which is
    // inconsistent enough across browsers that typos were slipping
    // through unmarked.
    q.root.setAttribute('spellcheck', 'true');
    q.root.setAttribute('autocorrect', 'on');
    q.root.setAttribute('autocapitalize', 'sentences');
    return q;
  }

  function destroy(containerId) {
    // Per Bot 24 — this used to only drop the JS reference and rely on
    // "the container's innerHTML gets replaced by the caller" — but
    // Quill's auto-generated toolbar (the array-config form used here)
    // is inserted as a DOM sibling BEFORE the container element, not
    // inside it, so clearing the container's own innerHTML was never
    // enough to remove it. Re-mounting the same containerId (e.g.
    // re-opening "Edit version" on a different row) left every previous
    // toolbar still sitting in the DOM, stacking up visually one per
    // re-mount — that's the actual toolbar element removed here now,
    // not just the reference to it.
    const q = instances[containerId];
    if (q) {
      try {
        const toolbarModule = q.getModule('toolbar');
        if (toolbarModule && toolbarModule.container && toolbarModule.container.parentNode) {
          toolbarModule.container.parentNode.removeChild(toolbarModule.container);
        }
      } catch(e) {}
    }
    delete instances[containerId];
    const container = document.getElementById(containerId);
    if (container) container.innerHTML = '';
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
  // Tracks the plain text of the most recently inserted haiku/limerick/
  // poem, so the sumie generator can key off a specific, known piece
  // deterministically (haiku, then limerick, then poem, then falling
  // back to the editor's general text) rather than the model having to
  // guess which lines in an undifferentiated whole-body text dump were
  // the poem versus the intro paragraph versus anything else.
  const _lastInsertedByType = { haiku: null, limerick: null, poem: null };

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
        <!-- Per Bot 24 — optional topic, so this doesn't always default
             to the same handful of subjects (coffee pots and all). Typing
             here and pressing Enter (or Generate) re-runs with the topic;
             leaving it blank keeps the previous untargeted behaviour. -->
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <input type="text" id="${containerId}_aiTopic" placeholder="What should this be about? (optional)" style="flex:1;font-size:12px"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();MessageEditor.retryAiGenerate('${containerId}');}"/>
          <button type="button" class="btn sm" onclick="MessageEditor.retryAiGenerate('${containerId}')">Generate</button>
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
    // Captured now, at the moment generation starts, not re-read later —
    // cell-aware (getInsertionTarget), same as every other insertion in
    // the heavy editor, so this lands in a columns cell correctly if
    // that's where the cursor was.
    st.target = q ? getInsertionTarget(q) : null;
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
      // Per Bot 24 — the topic field applies to every type, not just
      // sumie. sumie keeps its own fallback (base the image on whatever
      // haiku/limerick/poem was last inserted) only when the topic field
      // is left blank, preserving its previous behaviour exactly.
      const topicEl = document.getElementById(`${containerId}_aiTopic`);
      const topic = topicEl ? topicEl.value.trim() : '';
      if (type === 'sumie') {
        const q = instances[containerId];
        body.context = topic || _lastInsertedByType.haiku || _lastInsertedByType.limerick || _lastInsertedByType.poem || (q ? q.getText() : '');
      } else if (topic) {
        body.context = topic;
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
      // job keeps running server-side regardless. Just retry. (A locked/
      // backgrounded phone can throttle setTimeout itself, not just abort
      // the odd fetch, so re-polling on visibilitychange below closes
      // that gap too.)
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

  // A locked/backgrounded phone can throttle setTimeout itself, not just
  // abort the odd fetch, so a pending poll can end up waiting far longer
  // than 2s to actually fire once the tab comes back. Re-polling
  // immediately on return, instead of waiting for that possibly-delayed
  // timer, closes the gap between "I unlocked my phone" and "the result
  // actually shows up."
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    Object.keys(aiState).forEach(containerId => {
      const st = aiState[containerId];
      if (st && st.jobId && !st.result) {
        if (st.pollTimer) clearTimeout(st.pollTimer);
        pollAiJob(containerId);
      }
    });
  });

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

  // Commits the previewed result into the document, at the insertion
  // point captured back when generation started — mirrors the
  // image-upload flow's cell-vs-Quill handling exactly.
  function insertAiResult(containerId) {
    const st = aiState[containerId];
    const q = instances[containerId];
    if (!st || !st.result || !q || !st.target) return;
    const { type, target, result } = st;
    if (type === 'sumie') {
      if (target.inCell) {
        const img = document.createElement('img');
        img.src = result.imageUrl;
        img.style.maxWidth = '100%';
        insertNodeAtCellRange(target, img);
        if (!img.nextSibling) img.parentNode.insertBefore(document.createTextNode('\u00A0'), img.nextSibling);
      } else {
        q.insertEmbed(target.quillRange.index, 'image', result.imageUrl);
        if (target.quillRange.index + 1 >= q.getLength() - 1) q.insertText(target.quillRange.index + 1, ' ');
        q.setSelection(target.quillRange.index + 1);
      }
    } else {
      if (_lastInsertedByType.hasOwnProperty(type)) {
        _lastInsertedByType[type] = result.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      if (target.inCell) {
        const wrap = document.createElement('span');
        wrap.innerHTML = result.html;
        insertNodeAtCellRange(target, wrap);
      } else {
        q.clipboard.dangerouslyPasteHTML(target.quillRange.index, result.html + '<br/>');
        q.setSelection(target.quillRange.index + 1);
      }
    }
    closeAiPreview(containerId);
  }

  function getInstance(containerId) { return instances[containerId]; }

  window.MessageEditor = {
    insertTokenAtField, insertTokenAtRich, standardTokens, tokenSelectHtml,
    formatToggleHtml, mountRich, destroy, getHtml, isMounted, getInstance,
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
      /* Per Bot 24 — Quill dark-theme overrides, ported from comms.html's
         page-level <style> block. This modal is shared across comms.html,
         comms2.html, and sales.html — comms.html happened to already have
         its own copy of these rules (harmless duplication, same values),
         but comms2.html had none at all, so its toolbar rendered with
         Quill's default near-black icons — invisible against this dark
         modal. Centralising the fix here means it's correct regardless of
         which page mounts the editor, rather than depending on each page
         remembering to duplicate this block. */
      .ql-toolbar.ql-snow { background:rgba(255,255,255,0.05); border-color:rgba(255,255,255,0.12) !important; border-radius:8px 8px 0 0; }
      .ql-container.ql-snow { border-color:rgba(255,255,255,0.12) !important; min-height:140px; font-family:'Georgia',serif; font-size:14px; }
      .ql-editor { color:rgba(255,255,255,0.85); min-height:140px; }
      .ql-editor.ql-blank::before { color:rgba(255,255,255,0.25); font-style:normal; }
      .ql-snow .ql-stroke { stroke:rgba(255,255,255,0.5); }
      .ql-snow .ql-fill { fill:rgba(255,255,255,0.5); }
      .ql-snow .ql-picker { color:rgba(255,255,255,0.5); }
      .ql-snow .ql-picker-options { background:#1a221e; border-color:rgba(255,255,255,0.12) !important; }
      .ql-snow .ql-tooltip { background:#1a221e; border-color:rgba(255,255,255,0.12); color:rgba(255,255,255,0.8); box-shadow:none; }
      .ql-snow .ql-tooltip input[type=text] { background:rgba(255,255,255,0.06); border-color:rgba(255,255,255,0.15); color:rgba(255,255,255,0.85); }
      .ql-toolbar.ql-snow .ql-picker-label { border-color:transparent; }
      .ql-columns-block table { border-collapse:collapse; }
      .ql-columns-block td[data-column-cell] { border:1px dashed rgba(180,230,200,0.25); }
      .ql-editor a.nl-button { display:inline-block; background:#2d6a4f; color:#fff !important; padding:9px 20px; border-radius:6px; text-decoration:none !important; font-size:13px; }
      .ql-toolbar.ql-snow .ql-formats button.ql-image-link,
      .ql-toolbar.ql-snow .ql-formats button.ql-image-copy,
      .ql-toolbar.ql-snow .ql-formats button.ql-image-resize,
      .ql-toolbar.ql-snow .ql-formats button.ql-nl-button,
      .ql-toolbar.ql-snow .ql-formats button.ql-nl-video { width:auto; padding:0 6px; font-size:14px; }
      .ql-toolbar.ql-snow .ql-formats button.ql-columns-1,
      .ql-toolbar.ql-snow .ql-formats button.ql-columns-2,
      .ql-toolbar.ql-snow .ql-formats button.ql-columns-3 { width:auto; padding:0 8px; font-size:11px; }
      /* Text-content buttons (not SVG-icon ones), which never had an
         equivalent override and sat at Quill's default near-black. */
      .ql-toolbar.ql-snow .ql-formats button.ql-nl-button,
      .ql-toolbar.ql-snow .ql-formats button.ql-columns-1,
      .ql-toolbar.ql-snow .ql-formats button.ql-columns-2,
      .ql-toolbar.ql-snow .ql-formats button.ql-columns-3,
      .ql-toolbar.ql-snow .ql-formats button.ql-ai-polish { color:rgba(255,255,255,0.5); }
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
    sms_body: { render: (val) => `<div class="me-field-group"><label>SMS body</label><textarea class="me-inline-input" id="meVeExtra_sms_body" rows="2" spellcheck="true">${escVe(val ?? '')}</textarea></div>` },
  };
  // Per Bot 24 — mirrors the hardcoded fallback text baked into each
  // switched-over type's real send function in server.js
  // (resolveMessageContent's fallback argument at each call site). A
  // version whose subject/body/extra field is genuinely blank — never
  // customised before comms2 existed — used to show as an empty field
  // here, which looked like something had failed to load even though
  // real sends were working fine (falling back to this same text). Now
  // pre-filled instead, so editing always starts from what a real send
  // actually looks like. Extended as each type gets switched over; a
  // type not listed here just leaves blank fields blank, same as before.
  const DEFAULT_MESSAGE_TEXT = {
    reminder: {
      subject: "Whenever you're ready",
      body: "It's been a little while. No pressure at all — just wanted to leave the door open, in case a few minutes today would help.",
      extra: { days: 4, sms_body: "It's been a little while, {{name}}. No pressure — a few minutes today might help. {{link}}" },
    },
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
            <input class="me-inline-input" type="text" id="meVeSubject" spellcheck="true" style="flex:1"/>
            <span id="meVeSubjectTokenWrap"></span>
          </div>
        </div>
        <div class="me-field-group">
          <label>Body</label>
          <div id="meVeFormatToggleWrap"></div>
          <textarea class="me-inline-input" id="meVePlainBody" rows="6" style="width:100%" spellcheck="true"></textarea>
          <div id="meVeRichBody" style="display:none"></div>
          <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center" id="meVeBodyTokenWrap"></div>
          <div id="meVeAiGenerateWrap" style="display:none"></div>
        </div>
        <div id="meVeExtraFields"></div>
        <label class="me-checkbox-row">
          <input type="checkbox" id="meVeMakeActive"/>
          Make this the active version
        </label>
        <!-- Per Bot 24 — generic "Send test" for every message type, so
             this doesn't have to be rebuilt per-type as each gets
             switched over to message_versions. Sends whatever's LIVE for
             this type right now (the active saved version if one exists,
             otherwise current app_config) — see the backend endpoint for
             why that's always accurate, not stale. Shown for every type;
             the SMS half only appears for types that actually have one
             (sms_body in their extra fields). -->
        <div class="me-field-group" id="meVeTestSendWrap" style="border-top:1px solid rgba(255,255,255,0.08);padding-top:14px">
          <label>Send test — uses what's currently live, not what's unsaved in this form</label>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            <input class="me-inline-input" type="email" id="meVeTestEmailTo" placeholder="Defaults to your email" style="flex:1;min-width:160px"/>
            <button class="me-btn me-sm" type="button" onclick="MessageEditor.sendVersionTest('email')" id="meVeTestEmailBtn">Send test email</button>
          </div>
          <div id="meVeTestSmsRow" style="display:none;margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            <input class="me-inline-input" type="tel" id="meVeTestSmsTo" placeholder="+447..." style="flex:1;min-width:160px"/>
            <button class="me-btn me-sm" type="button" onclick="MessageEditor.sendVersionTest('sms')" id="meVeTestSmsBtn">Send test SMS</button>
          </div>
          <div class="me-modal-err" id="meVeTestFeedback"></div>
        </div>
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
      const typeDefaults = (DEFAULT_MESSAGE_TEXT[type] && DEFAULT_MESSAGE_TEXT[type].extra) || {};
      // Per Bot 24 — same blank-fills-with-default treatment as
      // subject/body above, per key.
      wrap.innerHTML = keys.map(k => {
        const val = (extra||{})[k];
        const fallback = (val === undefined || val === null || val === '') ? typeDefaults[k] : undefined;
        return VERSION_EXTRA_FIELD_RENDERERS[k] ? VERSION_EXTRA_FIELD_RENDERERS[k].render(fallback !== undefined ? fallback : val) : '';
      }).join('');
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
    const typeDefaults = DEFAULT_MESSAGE_TEXT[type] || {};
    document.getElementById('meVeSubject').value = (prefill && prefill.subject) || typeDefaults.subject || '';
    document.getElementById('meVePlainBody').value = (prefill && prefill.body) || typeDefaults.body || '';
    document.getElementById('meVeMakeActive').checked = false;
    document.getElementById('meVeErr').textContent = '';
    // Per Bot 24 — defaults to Rich always now, regardless of what
    // format a version happens to already be saved as, matching "the
    // rich editor with all features is the one I want for all messages"
    // — Plain is still one click away via the toggle if wanted for a
    // specific version, this just changes which one opens first.
    _veFormat = 'rich';
    renderVeFormatToggle();
    document.getElementById('meVePlainBody').style.display = _veFormat === 'rich' ? 'none' : 'block';
    document.getElementById('meVeRichBody').style.display = _veFormat === 'rich' ? 'block' : 'none';
    if (_veFormat === 'rich') mountRich('meVeRichBody', (prefill && prefill.body) || typeDefaults.body || '');
    else { destroy('meVeRichBody'); document.getElementById('meVeRichBody').innerHTML = ''; }
    renderVeTokenWraps();
    renderVeExtraFields(type, prefill && prefill.extra);
    // Per Bot 24 — Send test panel: SMS half only shown for types that
    // actually have one (same check renderVeExtraFields already makes
    // for the sms_body field itself), and the to-fields/feedback are
    // reset per open so a stale address or result from editing a
    // different version's test-send doesn't linger.
    const hasTestSend = !!TYPE_TEST_SENDER_TYPES[type];
    document.getElementById('meVeTestSendWrap').style.display = hasTestSend ? '' : 'none';
    const hasSms = hasTestSend && (metaMap[type] && (metaMap[type].extraFields || []).includes('sms_body'));
    document.getElementById('meVeTestSmsRow').style.display = hasSms ? 'flex' : 'none';
    document.getElementById('meVeTestEmailTo').value = '';
    document.getElementById('meVeTestSmsTo').value = '';
    document.getElementById('meVeTestFeedback').textContent = '';
    document.getElementById('meVeModalOverlay').classList.add('me-open');
  }
  // Per Bot 24 — mirrors TYPE_TEST_SENDERS in server.js, just the keys —
  // used only to decide whether to show the Send test panel at all for a
  // given type. Kept in sync manually as each type gets its backend
  // handler added; a type missing here simply hides the panel rather
  // than showing a button that would 400.
  const TYPE_TEST_SENDER_TYPES = {
    reminder: true, renewal: true, birthday: true, newsletter_welcome: true, trial_extended: true,
    trial_day3: true, trial_day7: true, trial_day10: true, trial_day14: true,
    savers_cancel_day0: true, savers_cancel_grace0: true, savers_cancel_mid: true, savers_cancel_final: true,
    savers_failure_day0: true, savers_failure_mid: true, savers_failure_final: true,
  };
  async function sendVersionTest(kind) {
    const type = document.getElementById('meVeType').value;
    const feedback = document.getElementById('meVeTestFeedback');
    const btn = document.getElementById(kind === 'sms' ? 'meVeTestSmsBtn' : 'meVeTestEmailBtn');
    const to = document.getElementById(kind === 'sms' ? 'meVeTestSmsTo' : 'meVeTestEmailTo').value.trim();
    feedback.style.color = '';
    feedback.textContent = '';
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await fetch(`/api/admin/message-versions/${type}/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to || undefined, kind }),
      });
      const data = await res.json();
      if (data.ok) { feedback.style.color = 'rgba(180,230,200,0.85)'; feedback.textContent = `Sent to ${data.to}`; }
      else { feedback.textContent = data.error || 'Could not send test.'; }
    } catch (e) {
      feedback.textContent = 'Network error — could not send test.';
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
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
  // Per Bot 24 — Send test panel's button handlers.
  window.MessageEditor.sendVersionTest = sendVersionTest;
})(window);
