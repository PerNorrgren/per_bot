// ── dialogs.js ──
// Replaces native alert()/confirm()/prompt(). Browsers title those with the
// page's raw origin (e.g. "mirror-production-018d.up.railway.app says"),
// which is what was showing up instead of the app's own name. These render
// as a small in-page modal instead, titled with the app's configured name
// (falls back to the brand name, then to "Deeper Mindfulness" if nothing
// has loaded yet) — same resolution brand-inject.js uses, so no extra
// admin field is needed just for this.
//
// Usage (all return Promises — call sites need to be inside an async
// function and use await, same shape as the native calls they replace):
//   await appAlert('Message.')
//   const ok = await appConfirm('Are you sure?')          -> true/false
//   const val = await appPrompt('Label:', 'default value') -> string or null
(function () {
  var configPromise = (window.brandReady || fetch('/api/config').then(function (r) { return r.json(); }))
    .then(function (cfg) { return cfg && cfg.appName || cfg && cfg.brandName || 'Deeper Mindfulness'; })
    .catch(function () { return 'Deeper Mindfulness'; });

  var STYLE = `
    .app-dialog-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:100000; display:flex; align-items:center; justify-content:center; padding:20px; }
    .app-dialog { background:#12181a; border:1px solid rgba(255,255,255,0.14); border-radius:14px; max-width:420px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.5); font-family:Georgia,serif; overflow:hidden; }
    .app-dialog-title { padding:16px 20px 2px; font-size:12px; letter-spacing:0.08em; color:rgba(255,255,255,0.4); text-transform:uppercase; }
    .app-dialog-body { padding:8px 20px 18px; color:rgba(255,255,255,0.85); font-size:14.5px; line-height:1.5; white-space:pre-wrap; }
    .app-dialog-input { margin:0 20px 18px; display:block; width:calc(100% - 40px); background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.15); border-radius:8px; padding:10px 12px; color:rgba(255,255,255,0.9); font-family:Georgia,serif; font-size:14px; outline:none; box-sizing:border-box; }
    .app-dialog-btns { display:flex; justify-content:flex-end; gap:10px; padding:14px 20px; border-top:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.02); }
    .app-dialog-btns button { padding:9px 18px; border-radius:8px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.8); font-family:Georgia,serif; font-size:13.5px; cursor:pointer; }
    .app-dialog-btns button.primary { background:rgba(180,230,200,0.18); border-color:rgba(180,230,200,0.45); color:rgba(210,240,222,0.95); }
    .app-dialog-btns button:hover { filter:brightness(1.15); }
  `;
  var styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    var s = document.createElement('style');
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  // opts: {title, showCancel, showInput, defaultValue, okText, cancelText}
  function buildDialog(message, opts) {
    return configPromise.then(function (appName) {
      return new Promise(function (resolve) {
        injectStyle();
        var overlay = document.createElement('div');
        overlay.className = 'app-dialog-overlay';
        var hasInput = !!opts.showInput;
        overlay.innerHTML =
          '<div class="app-dialog" role="dialog" aria-modal="true">' +
            '<div class="app-dialog-title"></div>' +
            '<div class="app-dialog-body"></div>' +
            (hasInput ? '<input type="text" class="app-dialog-input"/>' : '') +
            '<div class="app-dialog-btns">' +
              (opts.showCancel ? '<button class="app-dialog-cancel"></button>' : '') +
              '<button class="app-dialog-ok primary"></button>' +
            '</div>' +
          '</div>';
        overlay.querySelector('.app-dialog-title').textContent = opts.title || appName;
        overlay.querySelector('.app-dialog-body').textContent = message || '';
        var okBtn = overlay.querySelector('.app-dialog-ok');
        var cancelBtn = overlay.querySelector('.app-dialog-cancel');
        var input = overlay.querySelector('.app-dialog-input');
        okBtn.textContent = opts.okText || 'OK';
        if (cancelBtn) cancelBtn.textContent = opts.cancelText || 'Cancel';
        if (input) input.value = opts.defaultValue || '';

        document.body.appendChild(overlay);

        function close(result) {
          overlay.remove();
          document.removeEventListener('keydown', onKey);
          resolve(result);
        }
        function onKey(e) {
          if (e.key === 'Escape') close(hasInput ? null : false);
          else if (e.key === 'Enter') close(hasInput ? input.value : true);
        }
        okBtn.addEventListener('click', function () { close(hasInput ? input.value : true); });
        if (cancelBtn) cancelBtn.addEventListener('click', function () { close(hasInput ? null : false); });
        overlay.addEventListener('click', function (e) {
          if (e.target === overlay) close(hasInput ? null : false);
        });
        document.addEventListener('keydown', onKey);
        if (input) { input.focus(); input.select(); } else { okBtn.focus(); }
      });
    });
  }

  window.appAlert = function (message, title) {
    return buildDialog(message, { title: title, showCancel: false, okText: 'OK' }).then(function () {});
  };
  window.appConfirm = function (message, title) {
    return buildDialog(message, { title: title, showCancel: true, okText: 'OK', cancelText: 'Cancel' });
  };
  window.appPrompt = function (message, defaultValue, title) {
    return buildDialog(message, { title: title, showCancel: true, showInput: true, defaultValue: defaultValue, okText: 'OK', cancelText: 'Cancel' });
  };

  // Per Bot 21 — two fields in one dialog instead of chaining two
  // appPrompt() calls back to back, for anything where both values
  // belong together and get edited as one action (a button's visible
  // text alongside its link, most immediately). fields: array of
  // {label, defaultValue}. Resolves to an array of the entered strings,
  // in the same order as fields — or null if cancelled.
  window.appPromptMulti = function (fields, opts) {
    opts = opts || {};
    return configPromise.then(function (appName) {
      return new Promise(function (resolve) {
        injectStyle();
        var overlay = document.createElement('div');
        overlay.className = 'app-dialog-overlay';
        var inputsHtml = fields.map(function (f, i) {
          return '<div style="margin:0 20px 12px">' +
            '<label style="display:block;font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:4px">' + (f.label || '') + '</label>' +
            '<input type="text" class="app-dialog-input app-dialog-multi-input" data-i="' + i + '" style="margin:0"/>' +
          '</div>';
        }).join('');
        overlay.innerHTML =
          '<div class="app-dialog" role="dialog" aria-modal="true">' +
            '<div class="app-dialog-title"></div>' +
            '<div class="app-dialog-body"></div>' +
            inputsHtml +
            '<div class="app-dialog-btns">' +
              '<button class="app-dialog-cancel"></button>' +
              '<button class="app-dialog-ok primary"></button>' +
            '</div>' +
          '</div>';
        overlay.querySelector('.app-dialog-title').textContent = opts.title || appName;
        overlay.querySelector('.app-dialog-body').textContent = opts.message || '';
        var okBtn = overlay.querySelector('.app-dialog-ok');
        var cancelBtn = overlay.querySelector('.app-dialog-cancel');
        var inputs = Array.prototype.slice.call(overlay.querySelectorAll('.app-dialog-multi-input'));
        okBtn.textContent = opts.okText || 'OK';
        cancelBtn.textContent = opts.cancelText || 'Cancel';
        fields.forEach(function (f, i) { inputs[i].value = f.defaultValue || ''; });

        document.body.appendChild(overlay);

        function close(result) {
          overlay.remove();
          document.removeEventListener('keydown', onKey);
          resolve(result);
        }
        function collect() { return inputs.map(function (inp) { return inp.value; }); }
        function onKey(e) {
          if (e.key === 'Escape') close(null);
          else if (e.key === 'Enter') close(collect());
        }
        okBtn.addEventListener('click', function () { close(collect()); });
        cancelBtn.addEventListener('click', function () { close(null); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(null); });
        document.addEventListener('keydown', onKey);
        if (inputs[0]) { inputs[0].focus(); inputs[0].select(); }
      });
    });
  };

  // ── appShareSheet (Per Bot 23) ──
  // A consistent, custom "who to share with" popup — used everywhere
  // instead of the browser's native navigator.share(), which sounds like
  // the obvious choice but doesn't actually work on most desktop
  // browsers at all (silently falls back to nothing), giving a
  // completely different experience on desktop vs mobile for the exact
  // same button. This is the same everywhere, always.
  //
  // text: the message body (used by WhatsApp/SMS/Email, which accept
  //   free text). url: the link (used by Facebook/Messenger, which only
  //   ever accept a URL to share, not arbitrary text — a real platform
  //   limitation, not a choice made here). title: used as the email
  //   subject line. Copy always copies `text` (already includes the link
  //   at the end, wherever this is called from).
  var SHARE_STYLE = `
    .app-share-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:100000; display:flex; align-items:flex-end; justify-content:center; }
    @media (min-width: 640px) { .app-share-overlay { align-items:center; } }
    .app-share-sheet { background:#12181a; border:1px solid rgba(255,255,255,0.14); border-radius:16px 16px 0 0; max-width:420px; width:100%; box-shadow:0 -10px 40px rgba(0,0,0,0.5); font-family:Georgia,serif; overflow:hidden; }
    @media (min-width: 640px) { .app-share-sheet { border-radius:16px; margin-bottom:10vh; } }
    .app-share-title { padding:18px 20px 4px; font-size:14px; color:rgba(255,255,255,0.75); }
    .app-share-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:4px; padding:12px 12px 8px; }
    .app-share-opt { display:flex; flex-direction:column; align-items:center; gap:6px; background:none; border:none; color:rgba(255,255,255,0.7); font-family:Georgia,serif; font-size:11.5px; padding:12px 6px; border-radius:10px; cursor:pointer; }
    .app-share-opt:hover { background:rgba(255,255,255,0.06); }
    .app-share-opt-icon { width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:20px; background:rgba(255,255,255,0.08); }
    .app-share-cancel { display:block; width:calc(100% - 24px); margin:6px 12px 16px; padding:12px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:none; color:rgba(255,255,255,0.6); font-family:Georgia,serif; font-size:13px; cursor:pointer; }
  `;
  var shareStyleInjected = false;
  function injectShareStyle() {
    if (shareStyleInjected) return;
    shareStyleInjected = true;
    var s = document.createElement('style');
    s.textContent = SHARE_STYLE;
    document.head.appendChild(s);
  }

  window.appShareSheet = function (text, url, title) {
    return new Promise(function (resolve) {
      injectShareStyle();
      var shareUrl = url || '';
      var fullText = text || '';
      var encText = encodeURIComponent(fullText);
      var encUrl = encodeURIComponent(shareUrl);
      var encSubject = encodeURIComponent(title || '');

      // Facebook and Messenger only ever accept a URL parameter, never
      // free text — that's a platform restriction, not something this
      // code can work around. WhatsApp/SMS/Email get the full text
      // (which already has the link at the end, wherever this was
      // called from).
      var options = [
        { label: 'WhatsApp', icon: '💬', href: 'https://wa.me/?text=' + encText },
        { label: 'Text message', icon: '✉️', href: 'sms:?body=' + encText },
        { label: 'Email', icon: '📧', href: 'mailto:?subject=' + encSubject + '&body=' + encText },
        { label: 'Facebook', icon: '📘', href: 'https://www.facebook.com/sharer/sharer.php?u=' + encUrl },
        { label: 'Messenger', icon: '💌', href: 'fb-messenger://share/?link=' + encUrl },
        { label: 'Copy', icon: '📋', copy: true },
      ];

      var overlay = document.createElement('div');
      overlay.className = 'app-share-overlay';
      overlay.innerHTML =
        '<div class="app-share-sheet" role="dialog" aria-modal="true">' +
          '<div class="app-share-title"></div>' +
          '<div class="app-share-grid"></div>' +
          '<button class="app-share-cancel">Cancel</button>' +
        '</div>';
      overlay.querySelector('.app-share-title').textContent = title || 'Share';
      var grid = overlay.querySelector('.app-share-grid');
      options.forEach(function (opt) {
        var btn = document.createElement('button');
        btn.className = 'app-share-opt';
        btn.innerHTML = '<span class="app-share-opt-icon">' + opt.icon + '</span><span>' + opt.label + '</span>';
        btn.addEventListener('click', function () {
          if (opt.copy) {
            if (navigator.clipboard) {
              navigator.clipboard.writeText(fullText).then(function () {
                btn.querySelector('span:last-child').textContent = 'Copied ✓';
                setTimeout(function () { close(true); }, 700);
              });
              return;
            }
          } else {
            window.open(opt.href, '_blank');
          }
          close(true);
        });
        grid.appendChild(btn);
      });
      document.body.appendChild(overlay);

      function close(result) { overlay.remove(); resolve(result); }
      overlay.querySelector('.app-share-cancel').addEventListener('click', function () { close(false); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(false); });
    });
  };
})();

// ── Admin/facilitator accessibility: reversed-colour contrast + text size
// (Per Bot 29) ── Same idea as the client app and /account (see
// client-index.html, account.html), shared here once since every admin
// page already loads this file synchronously in <head>, before body
// renders — so the CSS and the pre-paint class-on-<html> both land before
// first paint with no extra wiring per page. localStorage-only, not saved
// to account: admin/facilitator logins live in a separate table from
// client users, and this is a handful of people on their own machines,
// not thousands of members across devices — the account-wide plumbing
// the client version needed doesn't earn its cost here.
(function () {
  var STYLE = document.createElement('style');
  STYLE.textContent =
    'html.a11y-contrast { filter: invert(1) hue-rotate(180deg); }' +
    'html.a11y-contrast img, html.a11y-contrast video { filter: invert(1) hue-rotate(180deg); }' +
    'html.a11y-text-large body { zoom: 1.15; }' +
    'html.a11y-text-larger body { zoom: 1.3; }' +
    '.a11y-toggle-btn { background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.15); border-radius:14px; cursor:pointer; color:rgba(255,255,255,0.55); font-size:12px; letter-spacing:0.03em; font-family:Georgia,serif; padding:6px 14px; line-height:1; }' +
    '.a11y-toggle-btn:hover { background:rgba(255,255,255,0.09); color:rgba(255,255,255,0.75); }' +
    '.a11y-menu { display:none; position:absolute; top:calc(100% + 8px); right:0; z-index:500; background:rgba(20,26,24,0.98); border:1px solid rgba(255,255,255,0.15); border-radius:12px; padding:8px; min-width:190px; box-shadow:0 8px 24px rgba(0,0,0,0.5); }' +
    '.a11y-menu.open { display:block; }' +
    '.a11y-menu-label { font-size:10px; letter-spacing:0.1em; text-transform:uppercase; color:rgba(255,255,255,0.35); padding:6px 8px 2px; }' +
    '.a11y-menu-opt { display:block; width:100%; text-align:left; background:none; border:none; color:rgba(255,255,255,0.75); font-family:Georgia,serif; font-size:13px; padding:8px; border-radius:8px; cursor:pointer; }' +
    '.a11y-menu-opt:hover { background:rgba(255,255,255,0.07); }' +
    '.a11y-menu-opt.active { background:rgba(180,230,200,0.14); color:rgba(180,230,200,0.95); }';
  document.head.appendChild(STYLE);

  try {
    if (localStorage.getItem('admin_a11y_contrast') === '1') document.documentElement.classList.add('a11y-contrast');
    var scale = localStorage.getItem('admin_a11y_text_scale');
    if (scale === 'large') document.documentElement.classList.add('a11y-text-large');
    else if (scale === 'larger') document.documentElement.classList.add('a11y-text-larger');
  } catch (e) {}

  function applyState(contrast, textScale) {
    document.documentElement.classList.toggle('a11y-contrast', !!contrast);
    document.documentElement.classList.toggle('a11y-text-large', textScale === 'large');
    document.documentElement.classList.toggle('a11y-text-larger', textScale === 'larger');
    var menu = document.getElementById('a11yMenu');
    if (!menu) return;
    var cN = menu.querySelector('[data-a11y="contrast-0"]'), cH = menu.querySelector('[data-a11y="contrast-1"]');
    var tN = menu.querySelector('[data-a11y="text-normal"]'), tL = menu.querySelector('[data-a11y="text-large"]'), tR = menu.querySelector('[data-a11y="text-larger"]');
    if (cN) cN.classList.toggle('active', !contrast);
    if (cH) cH.classList.toggle('active', !!contrast);
    if (tN) tN.classList.toggle('active', textScale !== 'large' && textScale !== 'larger');
    if (tL) tL.classList.toggle('active', textScale === 'large');
    if (tR) tR.classList.toggle('active', textScale === 'larger');
  }

  window.setAdminA11yContrast = function (val) {
    applyState(val, localStorage.getItem('admin_a11y_text_scale') || 'normal');
    try { localStorage.setItem('admin_a11y_contrast', val ? '1' : '0'); } catch (e) {}
  };
  window.setAdminA11yTextScale = function (scale) {
    applyState(document.documentElement.classList.contains('a11y-contrast'), scale);
    try { localStorage.setItem('admin_a11y_text_scale', scale); } catch (e) {}
  };
  window.toggleAdminA11yMenu = function () {
    var menu = document.getElementById('a11yMenu');
    if (menu) menu.classList.toggle('open');
  };

  function injectMenu() {
    var slot = document.getElementById('a11yMenuSlot');
    if (!slot) return;
    slot.innerHTML =
      '<button class="a11y-toggle-btn" onclick="toggleAdminA11yMenu()" title="Display settings">Display</button>' +
      '<div class="a11y-menu" id="a11yMenu">' +
        '<div class="a11y-menu-label">Contrast</div>' +
        '<button class="a11y-menu-opt" data-a11y="contrast-0" onclick="setAdminA11yContrast(0)">Normal</button>' +
        '<button class="a11y-menu-opt" data-a11y="contrast-1" onclick="setAdminA11yContrast(1)">High contrast (reversed)</button>' +
        '<div class="a11y-menu-label">Text size</div>' +
        '<button class="a11y-menu-opt" data-a11y="text-normal" onclick="setAdminA11yTextScale(\'normal\')">Normal</button>' +
        '<button class="a11y-menu-opt" data-a11y="text-large" onclick="setAdminA11yTextScale(\'large\')">Large</button>' +
        '<button class="a11y-menu-opt" data-a11y="text-larger" onclick="setAdminA11yTextScale(\'larger\')">Larger</button>' +
      '</div>';
    applyState(document.documentElement.classList.contains('a11y-contrast'),
      document.documentElement.classList.contains('a11y-text-larger') ? 'larger' : (document.documentElement.classList.contains('a11y-text-large') ? 'large' : 'normal'));
    document.addEventListener('click', function (e) {
      var menu = document.getElementById('a11yMenu');
      if (menu && menu.classList.contains('open') && !menu.contains(e.target) && !e.target.closest('.a11y-toggle-btn')) {
        menu.classList.remove('open');
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectMenu);
  else injectMenu();
})();
