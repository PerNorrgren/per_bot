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
})();
