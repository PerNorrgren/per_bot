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
