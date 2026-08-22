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
      /* Per Bot 44 — every rich editor's toolbar sticks to the top of
         its scrolling ancestor now (not just the newsletter editor
         Per specifically asked about — this is the shared definition
         every editor in the app draws from, so it's consistent
         everywhere rather than needing this fix repeated per page).
         The background here MUST be solid, not the near-transparent
         rgba(255,255,255,0.05) this used to be — once stuck, scrolled
         text runs directly underneath it, and a transparent background
         let it show straight through, which is what actually caused
         Per's report ("the text flows up under it"): position:sticky
         itself was working fine, the toolbar just wasn't opaque enough
         to hide what was scrolling behind it. */
      .me-ql-wrap .ql-toolbar.ql-snow { background:#171d1a; border-color:rgba(255,255,255,0.12) !important; border-radius:8px 8px 0 0; position:sticky; top:0; z-index:20; }
      .me-ql-wrap .ql-container.ql-snow { border-color:rgba(255,255,255,0.12) !important; font-family:'Georgia',serif; font-size:14px; border-radius:0 0 8px 8px; }
      .me-ql-wrap .ql-editor { color:rgba(255,255,255,0.85); min-height:140px; }
      .me-ql-wrap .ql-editor.ql-blank::before { color:rgba(255,255,255,0.25); font-style:normal; }
      /* Per Bot 25 — contrast fix. Every editor instance in the app had
         this same problem: toolbar icons and picker labels were set to
         rgba(255,255,255,0.5) — barely half-opacity white — which reads
         as too dark/faint against this dark toolbar background, and, on
         top of that, this whole stylesheet is written assuming a dark
         background unconditionally. Any place these white-on-transparent
         icons end up rendered against a LIGHT background instead (a
         browser/OS forced-colour or high-contrast display mode, which is
         what "reverse contrast" showing everything washed-out light
         actually is) makes them functionally invisible — white-ish icons
         at low opacity on a light background. Two changes: raise the
         normal-mode opacity so it's clearly readable on the intended dark
         background, and add an explicit forced-colors block below so
         when the OS/browser IS rendering in a forced light/high-contrast
         theme, the icons switch to system colours instead of staying on
         these now-wrong hardcoded whites. */
      .me-ql-wrap .ql-snow .ql-stroke { stroke:rgba(255,255,255,0.75); }
      .me-ql-wrap .ql-snow .ql-fill { fill:rgba(255,255,255,0.75); }
      .me-ql-wrap .ql-snow .ql-picker { color:rgba(255,255,255,0.75); }
      .me-ql-wrap .ql-snow .ql-picker-options { background:#1a221e; border-color:rgba(255,255,255,0.12) !important; }
      .me-ql-wrap .ql-snow .ql-tooltip { background:#1a221e; border-color:rgba(255,255,255,0.12); color:rgba(255,255,255,0.8); box-shadow:none; }
      .me-ql-wrap .ql-snow .ql-tooltip input[type=text] { background:rgba(255,255,255,0.06); border-color:rgba(255,255,255,0.15); color:rgba(255,255,255,0.85); }
      .me-ql-wrap .ql-toolbar.ql-snow .ql-picker-label { border-color:transparent; }
      /* Text-content buttons (1 col/2 col/3 col, AI Help, and the emoji-
         glyph media buttons: audio/p-image/p-video/p-audio), not the
         SVG-icon ones above (B/I/U/alignment/lists/link/image), which get
         their colour from .ql-stroke/.ql-fill instead. Per Bot 25 — the
         emoji buttons were added without ever being added to this list,
         so they fell back to the browser's unstyled default button text
         colour (dark) instead of matching everything else, and rendered
         at the browser default font-size (small) rather than large
         enough to actually read as a photo/clapperboard/note glyph —
         reported as "so dark and small so I did not see them". The
         explicit font-size here is the fix for size; color is the fix
         for contrast. */
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-nl-button,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-columns-1,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-columns-2,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-columns-3,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-audio,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-p-image,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-p-video,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-p-audio,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-dictate,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-ai-polish { color:rgba(255,255,255,0.75); }
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-audio,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-p-image,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-p-video,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-p-audio,
      .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-dictate { font-size:16px; line-height:1; }
      /* Per Bot 25 — 'simple' preset (Journal, course/lesson descriptions,
         facilitator notes) needs no size change from the default above.
         'compact' preset (inline message composers) needs the smaller
         footprint the old per-file .cmsg-rich-container/.msg-rich-
         container CSS used to give it — same numbers, now in one place. */
      .me-ql-wrap.me-ql-compact .ql-container.ql-snow { font-size:13.5px; min-height:20px; }
      .me-ql-wrap.me-ql-compact .ql-editor { padding:8px 10px; min-height:20px; max-height:100px; overflow-y:auto; }
      .me-ql-wrap.me-ql-compact .ql-toolbar.ql-snow button { width:22px; height:22px; }
      .me-ai-panel { background:#141a17; border:1px solid rgba(255,255,255,0.12); border-radius:10px; padding:14px; margin-top:8px; }
      .me-ai-body { font-size:13px; line-height:1.6; color:rgba(255,255,255,0.8); max-height:240px; overflow-y:auto; }
      /* Per Bot 25 — forced-colors (Windows High Contrast and similar OS/
         browser accessibility modes) overrides most author colours with
         a small system palette and renders the page's own background as
         a system colour (often light), regardless of what this stylesheet
         says. Left alone, the rgba(255,255,255,...) icon colours above
         are exactly the kind of author colour that mode is inconsistent
         about honouring — sometimes ignored, sometimes kept, neither
         case giving a reliably visible result against whatever background
         actually renders. Explicit system colour keywords here (ButtonText,
         Canvas, CanvasText, Highlight) are the standard, supported way to
         stay legible under forced-colors — the browser resolves them to
         whatever the person's actual OS contrast theme uses. */
      @media (forced-colors: active) {
        .me-ql-wrap .ql-toolbar.ql-snow { forced-color-adjust: none; background:Canvas; border-color:ButtonText !important; }
        .me-ql-wrap .ql-container.ql-snow { forced-color-adjust: none; background:Canvas; border-color:ButtonText !important; }
        .me-ql-wrap .ql-editor { forced-color-adjust: none; color:CanvasText; background:Canvas; }
        .me-ql-wrap .ql-snow .ql-stroke { stroke:ButtonText; }
        .me-ql-wrap .ql-snow .ql-fill { fill:ButtonText; }
        .me-ql-wrap .ql-snow .ql-picker { color:ButtonText; }
        .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-nl-button,
        .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-columns-1,
        .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-columns-2,
        .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-columns-3,
        .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-audio,
        .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-p-image,
        .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-p-video,
        .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-p-audio,
        .me-ql-wrap .ql-toolbar.ql-snow .ql-formats button.ql-ai-polish { color:ButtonText; }
        .me-ql-wrap .ql-picker-item.ql-selected, .me-ql-wrap .ql-toolbar .ql-active { color:Highlight; }
      }
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

    // Per Bot 25 — audio block, same atomic-embed pattern as VideoBlot.
    // Quill has no built-in audio format (only 'video', which is
    // iframe-embed-only) — this is a plain <audio controls> pointing at
    // a real uploaded file (see uploadAudioIntoEditor below), reused
    // everywhere the shared editor mounts, not just one context.
    class AudioBlot extends BlockEmbed {
      static create(url) {
        const node = super.create();
        node.setAttribute('contenteditable', 'false');
        node.style.cssText = 'margin:10px 0;';
        node.innerHTML = `<audio controls style="width:100%" src="${url}"></audio>`;
        node.dataset.src = url;
        return node;
      }
      static value(node) { return node.dataset.src; }
    }
    AudioBlot.blotName = 'audioBlock';
    AudioBlot.tagName = 'DIV';
    AudioBlot.className = 'ql-audio-block';
    Quill.register(AudioBlot);

    // Per Bot 25 — private media block. Used only where opts.privateMedia
    // is set (currently Journal). Unlike VideoBlot/AudioBlot above, this
    // NEVER stores a usable URL — value(node) returns the stable R2 key
    // only, since a signed URL would go stale before the entry is next
    // opened. The actual <img>/<video>/<audio> starts with no src at
    // all; resolvePrivateMedia() (exported below) fills it in with a
    // freshly-signed URL every time this content is actually displayed,
    // whether that's this Quill instance mounting existing content, or a
    // read-only render of a saved entry elsewhere in the app.
    class PrivateMediaBlot extends BlockEmbed {
      static create(value) {
        const node = super.create();
        node.setAttribute('contenteditable', 'false');
        node.style.cssText = 'margin:10px 0;';
        node.dataset.mediaKey = value.key;
        node.dataset.mediaKind = value.kind;
        const tag = value.kind === 'image' ? 'img' : value.kind;
        const attrs = value.kind === 'image' ? 'style="max-width:100%;display:block;border-radius:8px;"' : 'controls style="width:100%"';
        node.innerHTML = `<${tag} class="ql-private-media" data-media-key="${value.key}" data-media-kind="${value.kind}" ${attrs}></${tag}>`;
        return node;
      }
      static value(node) { return { key: node.dataset.mediaKey, kind: node.dataset.mediaKind }; }
    }
    PrivateMediaBlot.blotName = 'privateMediaBlock';
    PrivateMediaBlot.tagName = 'DIV';
    PrivateMediaBlot.className = 'ql-private-media-block';
    Quill.register(PrivateMediaBlot);
  }

  // Per Bot 25 — resolves every not-yet-resolved private-media element
  // under rootEl to a real, currently-valid signed URL. Call this after
  // mounting/populating any content that might contain privateMediaBlock
  // embeds — both the live editor (mountRich does this automatically
  // when opts.privateMedia is set) and any read-only display of saved
  // content elsewhere in the app (e.g. the Journal list view), which
  // this module has no visibility into on its own. Safe to call
  // repeatedly — already-resolved elements are skipped via the
  // data-resolved marker, and a stale signed URL simply won't be
  // refreshed by a second call; re-render the content itself to force
  // a fresh resolve if content has been sitting open long enough for the
  // 10-minute signed URL to expire.
  async function resolvePrivateMedia(rootEl) {
    if (!rootEl) return;
    const els = Array.from(rootEl.querySelectorAll('.ql-private-media[data-media-key]:not([data-resolved])'));
    await Promise.all(els.map(async (el) => {
      const key = el.getAttribute('data-media-key');
      try {
        const res = await fetch('/api/journal/media-url?key=' + encodeURIComponent(key));
        const data = await res.json();
        if (data.url) { el.src = data.url; el.setAttribute('data-resolved', '1'); }
      } catch (e) { /* leave unresolved — a broken embed is better than a crash */ }
    }));
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
  // Per Bot 24 (maintenance rebuild, priority 2) — direct-to-R2 for
  // newsletter videos specifically, the highest-risk upload in the app
  // (video, no real size ceiling). Presign → PUT straight to R2 from the
  // browser → tiny confirm call with just the key, no file bytes ever
  // touch this server. Falls back to the old server-relayed path
  // (uploadFileGetUrl) if presigning fails for any reason, same
  // "primary path, legacy fallback stays available" pattern used
  // elsewhere in this app.
  async function uploadVideoDirectToR2(file) {
    try {
      const presignRes = await fetch('/api/admin/newsletter-videos/presign-upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentType: file.type || 'video/mp4' }),
      });
      const presignData = await presignRes.json();
      if (!presignRes.ok || !presignData.uploadUrl) throw new Error(presignData.error || 'Could not start upload.');
      const putRes = await fetch(presignData.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'video/mp4' }, body: file });
      if (!putRes.ok) throw new Error('Upload to storage failed.');
      const confirmRes = await fetch('/api/admin/newsletter-videos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ r2Key: presignData.key }),
      });
      const confirmData = await confirmRes.json();
      if (!confirmRes.ok || !confirmData.url) throw new Error(confirmData.error || 'Could not confirm upload.');
      return confirmData.url;
    } catch (e) {
      // Legacy fallback — routes through the server, same as before this change.
      return uploadFileGetUrl('/api/admin/newsletter-videos', file);
    }
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
        videoUrl = await uploadVideoDirectToR2(videoFile);
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

  // Per Bot 25 — audio upload, same shape as uploadImageIntoEditor above:
  // atomic embed rather than something editable inline, so a plain
  // insertEmbed at the cursor (no in-cell/columns handling — an audio
  // player inside a two-column layout isn't a real use case here).
  async function uploadAudioIntoEditor(q) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'audio/*';
    const range = q.getSelection(true) || { index: q.getLength() };
    q.insertText(range.index, 'Uploading audio…');
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) { q.deleteText(range.index, 'Uploading audio…'.length); return; }
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch('/api/admin/newsletter-audio', { method: 'POST', body: formData });
        const data = await res.json();
        if (!data.url) {
          q.deleteText(range.index, 'Uploading audio…'.length);
          window.appAlert(data.error || 'Could not upload audio.');
          return;
        }
        q.deleteText(range.index, 'Uploading audio…'.length);
        q.insertEmbed(range.index, 'audioBlock', data.url);
        if (range.index + 1 >= q.getLength() - 1) q.insertText(range.index + 1, ' ');
        q.setSelection(range.index + 1);
      } catch (e) {
        q.deleteText(range.index, 'Uploading audio…'.length);
        window.appAlert('Network error — could not upload audio.');
      }
    };
    input.click();
  }

  // Per Bot 25 — private-media upload (Journal). Same two-step shape as
  // everywhere else: upload the file, get back a stable key (never a
  // URL — see the private_media schema comment in server.js), embed the
  // key, then resolve it to a real signed URL via resolvePrivateMedia
  // once the embed actually exists in the DOM.
  // Per Bot 25 — client-side image resize/compress, before the file ever
  // leaves the browser. Mobile phone photos routinely run 3000-4000px on
  // the long edge at several MB each — nothing in this app displays a
  // journal photo anywhere near that size, so shrinking it here saves
  // the upload itself, R2 storage, and every future load. Caps the long
  // edge at 1280px (comfortably sharp on any phone or desktop screen at
  // normal viewing size) and re-encodes as JPEG at a moderate quality —
  // typically brings a 4-8MB phone photo down to a few hundred KB.
  // createImageBitmap's imageOrientation:'from-image' bakes in EXIF
  // rotation (phones store many photos "sideways" with a rotation flag
  // rather than physically rotated pixels) so the compressed copy
  // doesn't come out sideways; falls back to a plain <img> decode (which
  // browsers also generally orient correctly for display, just via a
  // different code path) if createImageBitmap itself isn't available.
  const JOURNAL_IMAGE_MAX_DIMENSION = 1280;
  const JOURNAL_IMAGE_QUALITY = 0.82;
  async function compressImageFile(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
    }
    const srcW = bitmap.width, srcH = bitmap.height;
    const scale = Math.min(1, JOURNAL_IMAGE_MAX_DIMENSION / Math.max(srcW, srcH));
    const w = Math.round(srcW * scale), h = Math.round(srcH * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JOURNAL_IMAGE_QUALITY));
    // A tiny/simple source image (a screenshot, a graphic) can sometimes
    // come back larger as re-encoded JPEG than the original — if
    // compression didn't actually help, just use the original file
    // rather than uploading something bigger than what we started with.
    return (blob && blob.size < file.size) ? blob : file;
  }

  async function uploadPrivateMediaIntoEditor(q, kind) {
    const accept = kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : 'audio/*';
    const label = kind === 'image' ? 'photo' : kind;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    const range = q.getSelection(true) || { index: q.getLength() };
    q.insertText(range.index, `Uploading ${label}…`);
    input.onchange = async () => {
      let file = input.files[0];
      if (!file) { q.deleteText(range.index, `Uploading ${label}…`.length); return; }
      if (kind === 'image') {
        try { file = await compressImageFile(file); }
        catch (e) { console.error('[journal image] client-side compression failed, uploading original:', e); }
      }
      try {
        let data;
        if (kind === 'video') {
          // Per Bot 25 — direct-to-R2 presigned upload, same pattern
          // already used for call recordings/practice audio/newsletter
          // videos. A raw phone video can be large enough, on a slow
          // enough connection, to risk Railway's hard 5-minute HTTP
          // timeout if it went through this server as a normal request
          // — this way it never does; the server only downloads it back
          // once, afterward, to run ffmpeg compression.
          const presignRes = await fetch('/api/journal/media-upload/presign-upload', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: file.name, contentType: file.type || 'video/mp4' }),
          });
          const presign = await presignRes.json();
          if (!presign.uploadUrl) { window.appAlert(presign.error || 'Could not prepare that upload.'); q.deleteText(range.index, `Uploading ${label}…`.length); return; }
          const putRes = await fetch(presign.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'video/mp4' }, body: file });
          if (!putRes.ok) { window.appAlert('Could not upload that video — please try again.'); q.deleteText(range.index, `Uploading ${label}…`.length); return; }
          const finishRes = await fetch('/api/journal/media-upload', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ r2Key: presign.key, mimeType: file.type || 'video/mp4' }),
          });
          data = await finishRes.json();
        } else {
          const formData = new FormData();
          formData.append('file', file, file.name || 'upload.jpg');
          const res = await fetch('/api/journal/media-upload', { method: 'POST', body: formData });
          data = await res.json();
        }
        if (!data.key) {
          q.deleteText(range.index, `Uploading ${label}…`.length);
          window.appAlert(data.error || `Could not upload ${label}.`);
          return;
        }
        q.deleteText(range.index, `Uploading ${label}…`.length);
        q.insertEmbed(range.index, 'privateMediaBlock', { key: data.key, kind });
        if (range.index + 1 >= q.getLength() - 1) q.insertText(range.index + 1, ' ');
        q.setSelection(range.index + 1);
        resolvePrivateMedia(q.root);
      } catch (e) {
        q.deleteText(range.index, `Uploading ${label}…`.length);
        window.appAlert(`Network error — could not upload ${label}.`);
      }
    };
    input.click();
  }

  // replaces the editor's content outright on success. No accept/discard
  // step by design — easy to amend anything afterward, and a review
  // modal would just add friction for something meant to be a quick
  // "make this better" nudge. Distinct from the Generate & insert
  // dropdown (aiGenerateHtml/runAiGenerate below) — this improves what's
  // already there; that inserts something new alongside it.
  // Per Bot 41 — Per's report: clicking AI Help showed a "…" on the
  // button and nothing else, and on at least one try the text came back
  // unchanged with zero indication of why — no error, no confirmation,
  // nothing to go on. Two problems, really: no visible progress while
  // waiting, and a straight overwrite of the whole message the moment a
  // reply came back, success or (before Per Bot 39's truncation guard)
  // partial failure alike. Rebuilt to match how Generate-and-insert
  // already works elsewhere in this editor: open a panel, show a clear
  // "Improving your message…" state, then either the suggested rewrite
  // with an explicit "Use this version" to actually apply it, or a
  // plain-language error with a Try again button — never a silent
  // no-op and never an unreviewed overwrite.
  const aiPolishState = {};
  async function runAiPolish(q, btn) {
    if (!btn) return;
    const containerId = btn.closest('.me-ql-wrap') ? btn.closest('.me-ql-wrap').id : null;
    const panel = containerId ? document.getElementById(`${containerId}_polishPanel`) : null;
    if (!q.getText().trim()) { window.appAlert('Write something first.'); return; }
    if (!panel) { // fallback for any editor instance that somehow has no panel (shouldn't happen — see mountRich)
      window.appAlert('Could not open AI Help here — please try reloading the page.');
      return;
    }
    aiPolishState[containerId] = { q, html: q.root.innerHTML };
    panel.style.display = 'block';
    // Per's report: "AI Help does nothing." It wasn't doing nothing —
    // the panel lives right after the whole editor block in the
    // document (see mountRich), which on a long message can be a long
    // way below wherever someone's actually scrolled to when they click
    // the toolbar's AI Help button (the toolbar itself is sticky and
    // stays on screen the whole time, but the panel it opens isn't).
    // Scrolling it into view the moment it opens means it's always
    // where they're looking, regardless of how long the message is or
    // where in it they clicked from.
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    startAiPolish(containerId);
  }
  async function startAiPolish(containerId) {
    const st = aiPolishState[containerId];
    if (!st) return;
    document.getElementById(`${containerId}_polishRetry`).style.display = 'none';
    document.getElementById(`${containerId}_polishInsert`).style.display = 'none';
    document.getElementById(`${containerId}_polishBody`).innerHTML = `<span style="color:rgba(255,255,255,0.4);font-style:italic">Improving your message…</span>`;
    try {
      const res = await fetch('/api/ai-polish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: st.html }) });
      const data = await res.json();
      if (!res.ok || !data.html) throw new Error(data.error || 'Could not get a suggestion right now.');
      st.result = data.html;
      document.getElementById(`${containerId}_polishBody`).innerHTML = data.html;
      document.getElementById(`${containerId}_polishRetry`).style.display = '';
      document.getElementById(`${containerId}_polishInsert`).style.display = '';
    } catch (e) {
      document.getElementById(`${containerId}_polishBody`).innerHTML = `<span style="color:rgba(255,120,100,0.85)">${e.message || 'Something went wrong — please try again.'}</span>`;
      document.getElementById(`${containerId}_polishRetry`).style.display = '';
    }
  }
  function retryAiPolish(containerId) { startAiPolish(containerId); }
  function closeAiPolishPreview(containerId) {
    delete aiPolishState[containerId];
    const panel = document.getElementById(`${containerId}_polishPanel`);
    if (panel) panel.style.display = 'none';
  }
  function insertAiPolishResult(containerId) {
    const st = aiPolishState[containerId];
    if (!st || !st.result || !st.q) return;
    st.q.root.innerHTML = st.result;
    closeAiPolishPreview(containerId);
  }

  function mountRich(containerId, initialHtml, opts) {
    opts = opts || {};
    ensureStyles();
    ensureBlotsRegistered();
    if (instances[containerId]) { destroy(containerId); }
    const container = document.getElementById(containerId);
    // Per Bot 25 — Quill inserts its auto-built toolbar as a DOM SIBLING
    // immediately before whatever element it's mounted on (confirmed
    // directly against Quill 1.3.7's source — Toolbar.js does
    // `quill.container.parentNode.insertBefore(toolbarEl, quill.container)`),
    // not inside it. Every editor in this app used to mount Quill
    // directly on the div carrying the `.me-ql-wrap` class, which meant
    // the toolbar came out as .me-ql-wrap's sibling, not its descendant —
    // every `.me-ql-wrap .ql-toolbar...` CSS rule (background, border,
    // and critically every icon colour) silently never matched anything,
    // for every editor in the app, the whole time. The editor's own
    // typing area still looked right (Quill nests .ql-editor as a real
    // child of its mount point, so that half of the CSS did reach it) —
    // which is exactly why this read as "the toolbar icons are too dark/
    // wrong contrast" rather than "the editor is completely unstyled":
    // only the toolbar chrome was silently falling back to Quill's own
    // bundled default (mid-grey #444 strokes, no background), invisible
    // against this app's near-black page background. Fix: mount Quill on
    // a fresh INNER div nested inside the original containerId element,
    // so the toolbar — inserted as that inner div's sibling — lands
    // inside the outer element instead, which is the one actually
    // carrying .me-ql-wrap. instances[] and every public method below
    // still key off the original containerId, so no caller anywhere
    // needed to change.
    if (container) {
      container.innerHTML = '';
      container.classList.add('me-ql-wrap');
    }
    const mountEl = document.createElement('div');
    if (container) container.appendChild(mountEl);
    if (window.ImageResize && Quill.imports['modules/imageResize'] === undefined) {
      Quill.register('modules/imageResize', window.ImageResize.default || window.ImageResize);
    }
    // Per Bot 25 — opts.toolbar selects which button set mounts, but
    // it's still the exact same Quill instance, same handlers, same
    // paste/link/image behaviour, same styling underneath either way.
    // Per: "we should only ever now have one single text editor, used
    // for all" — this is that: one real implementation, three presets,
    // rather than a separate copy-pasted mountRichEditor per file (which
    // is what caused the contrast fix in ensureStyles() below to have
    // been applied inconsistently — three near-identical but separately
    // drifted CSS blocks existed before this).
    const toolbarPresets = {
      full: [
        [{ header: [2, 3, false] }],
        ['bold', 'italic', 'underline'],
        [{ align: [] }],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['link', 'image', 'image-link', 'image-copy', 'image-resize', 'video-link'],
        ['nl-video'],
        ['audio'],
        ['nl-button'],
        ['columns-1', 'columns-2', 'columns-3'],
        ['ai-polish'],
        ['clean'],
      ],
      // Every plain content field that isn't a marketing email — Journal
      // entries, course/lesson descriptions, facilitator session notes.
      // Same formatting and AI Help as 'full', without the email-specific
      // building blocks (columns/buttons) that don't belong in this kind
      // of field. opts.privateMedia (Journal only, for now — see the
      // privateMediaBlock comment above) adds a private image/video/audio
      // group; other 'simple' fields get none of that until their own
      // privacy model is decided. opts.onDictate (Journal only) adds a
      // mic button that calls back into the caller's own recording
      // logic — kept as a callback rather than baking dictation itself
      // in here, since recording/transcribing is Journal-specific
      // business logic, not something every 'simple' field needs.
      simple: [
        [{ header: [2, 3, false] }],
        ['bold', 'italic', 'underline'],
        [{ align: [] }],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['link'],
        ...(opts.privateMedia ? [['p-image', 'p-video', 'p-audio']] : []),
        ...(opts.onDictate ? [['dictate']] : []),
        ['ai-polish'], ['clean'],
      ],
      // The small inline message composers (client↔facilitator direct
      // messages). No headers/lists/clean — there's no room for a second
      // toolbar row in this UI, and a short message rarely needs them.
      compact: [['bold', 'italic'], ['link'], ['ai-polish']],
      // Per Bot 25 — social post drafts (admin/comms.html's per-platform
      // message builder: Facebook/LinkedIn/Instagram/Threads). No
      // headers/lists/columns/AI Help/clean — none of that means
      // anything on a social caption, and the text this drafts from is
      // already AI-generated by the message builder itself. 'video' is
      // deliberately Quill's own bare built-in format (not this file's
      // custom video-link/nl-video), since that's what comms.html
      // already relied on — a real inline embed preview while drafting,
      // not a text link — and it needs no entry in the handlers object
      // below to work, Quill provides its own default handler for it.
      // Only image/audio move to this module's real upload flow, in
      // place of comms.html's old raw URL-prompt versions.
      social: [['bold', 'italic', 'underline'], ['link', 'image', 'video', 'audio']],
    };
    const toolbarContainer = toolbarPresets[opts.toolbar] || toolbarPresets.full;
    if (container && (opts.toolbar === 'compact' || opts.toolbar === 'simple')) container.classList.add('me-ql-' + opts.toolbar);

    const q = new Quill(mountEl, {
      theme: 'snow',
      placeholder: opts.placeholder || '',
      modules: Object.assign({
        toolbar: {
          container: toolbarContainer,
          handlers: {
            image: () => uploadImageIntoEditor(q),
            'video-link': () => insertVideoLink(q),
            'nl-video': () => insertNewsletterVideo(q),
            audio: () => uploadAudioIntoEditor(q),
            'p-image': () => uploadPrivateMediaIntoEditor(q, 'image'),
            'p-video': () => uploadPrivateMediaIntoEditor(q, 'video'),
            'p-audio': () => uploadPrivateMediaIntoEditor(q, 'audio'),
            // Per Bot 25 — thin passthrough. this.container is Quill's
            // own toolbar-module container (see the labelling code
            // below), not our outer wrapper element — used here so the
            // caller's onDictate can update the button's own label/state
            // directly without a separate query.
            dictate: function () { opts.onDictate(q, this.container.querySelector('.ql-dictate')); },
            'image-link': () => linkSelectedImage(q),
            'image-copy': () => copySelectedImage(q),
            'image-resize': () => shrinkSelectedImage(q),
            'nl-button': () => insertNewsletterButton(q),
            'columns-1': () => insertColumnsBlock(q, 1),
            'columns-2': () => insertColumnsBlock(q, 2),
            'columns-3': () => insertColumnsBlock(q, 3),
            // Per Bot 24 — opts.aiPolish lets one specific mountRich
            // instance (What's New's promo line, so far) swap in its own
            // AI Help behaviour — different endpoint, and able to
            // generate fresh from nothing rather than requiring existing
            // text first — without touching the shared runAiPolish every
            // other editor on this shared component still uses by
            // default.
            'ai-polish': function () { (opts.aiPolish || runAiPolish)(q, this.container.querySelector('.ql-ai-polish')); },
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
        // Per Bot 25 — only requested when window.ImageResize is actually
        // registered. client/index.html, admin/content.html, and
        // facilitator/index.html (the 'simple'/'compact' presets) never
        // load that CDN plugin — asking Quill to instantiate a module
        // that was never registered throws and aborts mounting entirely,
        // which is exactly what broke in testing this against a page
        // without it. The 'full' preset's image-resize toolbar button is
        // still only meaningful where the plugin is loaded anyway.
      }, (window.ImageResize ? { imageResize: { modules: ['Resize', 'DisplaySize', 'Toolbar'] } } : {})),
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
    label('.ql-audio', '🎵', 'Upload an audio file and insert a player');
    label('.ql-p-image', '📷', 'Add a photo');
    label('.ql-p-video', '🎬', 'Add a video');
    label('.ql-p-audio', '🎵', 'Add an audio recording');
    label('.ql-dictate', '🎙️', 'Dictate — tap to start, tap again to stop and transcribe');
    label('.ql-image-link', '🔗', 'Click an image first to select it, then click here to link it');
    label('.ql-image-copy', '📋', 'Click an image first to select it, then click here to copy it to your clipboard — paste it anywhere, including elsewhere in this message, as a way to move it');
    label('.ql-image-resize', '🗜️', "Click an image first, resize it with its own handles to the size you want it shown at, then click here — shrinks the actual file to match, keeping the email lighter");
    label('.ql-nl-button', '▭', 'Insert a button');
    label('.ql-columns-1', '1 col', 'Insert a single wide column');
    label('.ql-columns-2', '2 col', 'Insert two side-by-side columns');
    label('.ql-columns-3', '3 col', 'Insert three side-by-side columns');
    label('.ql-ai-polish', '✨ AI Help', opts.aiPolishTooltip || 'Suggest an improved version of the whole message');

    // Per's report — pasting text, or clicking an alignment/format
    // button, was jumping the whole modal back to its top, forcing a
    // scroll back down to find the edit again. Root cause: Quill's own
    // selection-tracking scrolls whatever it thinks the page's
    // scrolling container is to keep the cursor visible after a paste
    // or format change, but was never told this editor actually lives
    // inside a scrollable modal — so it ends up resetting that modal's
    // own scroll position as a side effect. Rather than depend on
    // identifying Quill's exact internal container (fragile across
    // Quill versions/instances), this snapshots the real, visible
    // scroll position right before the action starts and puts it back
    // a few times as the DOM settles afterward — works no matter which
    // element actually got scrolled.
    const guardScroller = (() => {
      let node = mountEl.parentElement;
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
        node = node.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    })();
    function guardScrollPosition() {
      const docEl = document.scrollingElement || document.documentElement;
      const savedTop = guardScroller.scrollTop;
      const savedDocTop = docEl.scrollTop;
      const restore = () => {
        if (guardScroller.scrollTop !== savedTop) guardScroller.scrollTop = savedTop;
        if (docEl !== guardScroller && docEl.scrollTop !== savedDocTop) docEl.scrollTop = savedDocTop;
      };
      // Several passes across the next few frames/ticks — Quill's own
      // scroll correction sometimes lands a beat after the paste/format
      // itself, not synchronously with it.
      requestAnimationFrame(restore);
      requestAnimationFrame(() => requestAnimationFrame(restore));
      setTimeout(restore, 50);
      setTimeout(restore, 200);
    }
    // mousedown (not click) so this fires — and takes its snapshot —
    // before Quill's own toolbar click handling runs at all.
    toolbarEl.addEventListener('mousedown', guardScrollPosition, true);
    // Capture phase, registered ahead of the paste handlers below, so
    // the snapshot happens before anything (ours or Quill's own default
    // paste handling) starts changing the document.
    q.root.addEventListener('paste', guardScrollPosition, true);

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
    if (opts.privateMedia) resolvePrivateMedia(q.root);
    instances[containerId] = q;
    // Per Bot 24 — explicit spell-check, rather than relying on browser
    // default behaviour for a contenteditable region, which is
    // inconsistent enough across browsers that typos were slipping
    // through unmarked.
    q.root.setAttribute('spellcheck', 'true');
    q.root.setAttribute('autocorrect', 'on');
    q.root.setAttribute('autocapitalize', 'sentences');
    // Per Bot 41 — AI Help's preview panel. Injected here rather than
    // requiring every page that mounts a rich editor to remember to
    // render one (unlike the Generate-and-insert panel, which is opt-in
    // per page via aiGenerateHtml() — AI Help is on every rich editor's
    // toolbar automatically, so its panel needs to exist automatically
    // too). Skipped when opts.aiPolish overrides the button's whole
    // behaviour (What's New's promo line) — that path has never used
    // this panel and isn't changing here.
    if (!opts.aiPolish) {
      const existing = document.getElementById(`${containerId}_polishPanel`);
      if (existing) existing.remove();
      const panel = document.createElement('div');
      panel.id = `${containerId}_polishPanel`;
      panel.className = 'me-ai-panel';
      panel.style.display = 'none';
      panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong style="font-size:12px;color:rgba(255,255,255,0.7)">✨ AI Help</strong>
          <button type="button" onclick="MessageEditor.closeAiPolishPreview('${containerId}')" style="background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:16px;line-height:1">×</button>
        </div>
        <div class="me-ai-body" id="${containerId}_polishBody"></div>
        <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">
          <button type="button" class="btn sm" id="${containerId}_polishRetry" style="display:none" onclick="MessageEditor.retryAiPolish('${containerId}')">Try again</button>
          <button type="button" class="btn sm primary" id="${containerId}_polishInsert" style="display:none" onclick="MessageEditor.insertAiPolishResult('${containerId}')">Use this version</button>
        </div>`;
      container.parentNode.insertBefore(panel, container.nextSibling);
    }
    return q;
  }

  function destroy(containerId) {
    // Per Bot 25 — since mountRich now mounts Quill on an inner div
    // nested inside the containerId element (see the mount-point comment
    // in mountRich above), the toolbar it builds lands inside containerId
    // too, so container.innerHTML = '' below removes it along with
    // everything else on its own. This explicit toolbar removal predates
    // that fix (Per Bot 24 — back when the toolbar really was an
    // external sibling, and re-mounting the same containerId left old
    // toolbars stacking up outside the container) and is redundant now,
    // but harmless to leave as a defensive no-op rather than something to
    // risk getting wrong by removing.
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

  // ── Textarea-backed mounting (Per Bot 25) ── mountRich above binds
  // straight onto a container div someone else already created and
  // reads/writes purely through the Quill instance — that's right for
  // comms2/sales/Newsletter/MOTD, which never had a plain-text field to
  // begin with. Every OTHER field this app has (Journal entries,
  // course/lesson descriptions, facilitator session notes) grew up as a
  // plain <textarea>, with save code that reads ta.value — this wraps
  // mountRich so that pattern keeps working unchanged: mounts Quill into
  // a sibling div, keeps the textarea as the real source of truth via a
  // text-change listener, hides the textarea itself. This is the one
  // implementation every "simple"/"compact" field in the app now shares
  // — see mountRichEditor() in client/index.html, admin/content.html,
  // and facilitator/index.html, each now a two-line shim over this.
  function mountOnTextarea(textareaId, opts) {
    opts = opts || {};
    const ta = document.getElementById(textareaId);
    if (!ta) return null;
    const containerId = textareaId + '_rich';
    if (instances[containerId] && !opts.force) return instances[containerId];
    ta.style.display = 'none';
    let container = document.getElementById(containerId);
    if (!container) {
      container = document.createElement('div');
      container.id = containerId;
      ta.parentNode.insertBefore(container, ta.nextSibling);
    }
    const q = mountRich(containerId, ta.value || '', Object.assign({ placeholder: ta.placeholder || '' }, opts));
    q.on('text-change', () => { ta.value = q.root.innerHTML; });
    return q;
  }

  function setTextareaContent(textareaId, html) {
    const ta = document.getElementById(textareaId);
    if (ta) ta.value = html || '';
    const q = instances[textareaId + '_rich'];
    if (q) {
      q.root.innerHTML = html || '';
      // Defensive — no current call site loads existing private-media
      // content this way (Journal only ever resets to blank here), but
      // costs nothing to keep correct if that changes later.
      resolvePrivateMedia(q.root);
    }
  }

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
    mountOnTextarea, setTextareaContent, resolvePrivateMedia,
    aiGenerateHtml, runAiGenerate, retryAiGenerate, closeAiPreview, insertAiResult,
    retryAiPolish, closeAiPolishPreview, insertAiPolishResult,
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
    renewal: {
      subject: 'Your membership renews soon',
      body: "Just a heads up — your membership renews on <strong>{{date}}</strong>. Nothing to do if that's expected; if you'd like to make changes first, you can manage your subscription any time.",
      extra: { days: 5, sms_body: 'Hi {{name}}, your membership renews on {{date}}. Manage it any time at {{link}}' },
    },
    birthday: {
      subject: 'Happy birthday from all of us',
      body: 'Just a little note to say happy birthday, {{name}}! Wishing you a day with a bit of extra ease in it.',
      extra: { sms_body: 'Happy birthday, {{name}}! Wishing you a great day, from all of us at {{brand}}.' },
    },
    newsletter_welcome: {
      subject: "Welcome to Deeper Mindfulness — you're in",
      body: `Dear {{name}},

Hope you're well, and that things are good with you.

A short note to welcome you to the new, rebuilt Deeper Mindfulness — genuinely rebuilt, not just refreshed, and we hope you feel that the moment you're in it.

If you have an existing subscription to Deeper Mindfulness, it has carried over in full, nothing to renew or reconsider. All you need to do is follow this link: {{invite_link}}

Once you're in, everything is open to you — courses, practices, poems, blogs, whitepapers, all of it, fully. If you find something missing, just let me know and I will add it promptly.

One new thing worth knowing about: Talk. It's not a scripted practice — it's somewhere to think something through out loud, and it listens and responds to whatever you're actually carrying in that moment, not a fixed script. I'd love to know what you make of it.

You can also set up practice reminders — a small message once a day, by email or text, whichever suits you.

Hope this lands well, and that the new app becomes a good place for you.

Warmly,
Per`,
    },
    trial_extended: {
      subject: "Your trial's been extended",
      body: "Hi {{name}},\n\nWe've been rolling out a lot of new things lately, so we've extended your trial by {{days}} days — until {{expiry_date}} — to give you a proper chance to see and try what's new.\n\nSign in at {{invite_link}} whenever you're ready.",
    },
    trial_day3: {
      subject: "The parts of this you haven't found yet",
      body: `A few days in is usually when people find the one thing that works and quietly stop looking any further. That's completely fine — but there's more here than the first thing you landed on.

Everything is actually open to you right now, not just what's free to try — the full library, and Talk, for the days nothing scripted quite fits what you're carrying.

No pressure to go looking. Just wanted you to know it's there.`,
    },
    trial_day7: {
      subject: 'The five minutes that actually add up',
      body: `The people who keep this going long after a trial ends aren't usually the ones who did one long session — they're the ones who came back for five minutes, a few times a week.

If you haven't yet, that's really all Talk or a short practice needs to be. Not a commitment. Just a few minutes, whenever the day happens to call for it.

However you've used it so far is fine — this is just a nudge that short and often counts for more than it seems.`,
    },
    trial_day10: {
      subject: 'Four days left, and what happens after',
      body: `Your trial ends in four days. After that, your account moves to the free Explorer tier — your history stays, but full access doesn't.

If this has found a place in your week, membership just means it stays there. Nothing else changes, and there's no pressure either way.`,
    },
    trial_day14: {
      subject: "Your trial has ended — here's where things stand",
      body: `Your 14-day trial has come to an end. Your account is now on the free Explorer tier — your history and the free content are both still there.

If you'd like full access back, you're welcome any time. No explanation needed, and nothing about coming back later is complicated.`,
    },
    savers_cancel_day0: {
      subject: 'Got it — no questions asked',
      body: `You've let us know you're moving on, and that's completely fine — no explanation needed.

Nothing changes for now. You've got full access exactly as already paid for, through {{period_end}}. We're genuinely glad you spent time here at all.`,
    },
    savers_cancel_grace0: {
      subject: "We've kept the door open a little longer",
      body: `Your paid time wrapped up — but rather than closing things off right away, we've kept full access open for another two weeks, no charge.

No pressure either way. Just wanted you to have the option, in case the timing was the only thing wrong.`,
    },
    savers_cancel_mid: {
      subject: 'A week left of the extra time',
      body: `Just flagging it — there's about a week left of the extra access we set aside after your membership wrapped up.

Nothing you need to do. If it's found a place in your week again, membership's there whenever suits.`,
    },
    savers_cancel_final: {
      subject: "Last day, and that's alright too",
      body: `This is the last day of the extra time we set aside. After today your account settles into the free Explorer tier — which is a real, permanent place, not a dead end.

If you'd like to come back properly at some point, you're always welcome, any time.`,
    },
    savers_failure_day0: {
      subject: "Your last payment didn't go through",
      body: `Wanted to flag this from an actual person, not just the automated notice — your last payment didn't process. This happens for all sorts of ordinary reasons, most often just a card that's expired or been reissued.

Your access hasn't changed. You've got two full weeks to sort it out, no rush.`,
    },
    savers_failure_mid: {
      subject: 'Still showing a payment issue',
      body: `A gentle follow-up — the payment issue from last week is still showing on our end. No drama, just didn't want it to quietly slip by.

Full access is still there while this gets sorted.`,
    },
    savers_failure_final: {
      subject: 'One more day before things settle',
      body: `Last day of full access before your account moves to the free Explorer tier — if it's just a card that needs updating, this is the moment to catch it.

If it's genuinely time to step back for now, that's completely fine too — Explorer keeps the free content open regardless.`,
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
          <label>Send test — sends exactly what's in this form right now, saved or not</label>
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
      // Per Bot 24 — sends exactly what's currently in the form as an
      // override, not just whatever's already saved as the active
      // version. Same fields saveVersionEditor itself would save — a
      // test now genuinely previews unsaved edits, the way the old
      // per-type comms.html forms did, rather than only ever showing
      // what was last saved.
      const override = {
        subject: document.getElementById('meVeSubject').value.trim(),
        body: _veFormat === 'rich' ? getHtml('meVeRichBody') : document.getElementById('meVePlainBody').value,
        format: _veFormat,
        extra: await collectVeExtraFields(type),
      };
      const res = await fetch(`/api/admin/message-versions/${type}/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to || undefined, kind, override }),
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
