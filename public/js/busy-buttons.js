/* Per App 38 (21) — automatic "working" spinner for every save button.

   Per: "when adding files to a lesson, pressing save does not give me the
   spinning button, just nothing ... can you add this visual feedback to all
   places in admin where we save please, a generic save button."

   How it works, without touching any page's own code:
   - Remembers which button was just clicked.
   - Watches every request the page sends (fetch and XMLHttpRequest).
     Anything that changes data (POST, PUT, PATCH, DELETE) and starts
     within 1.5 seconds of a click is tied to that button.
   - While any of those requests are still running, the button shows the
     rotating yin-yang in front of its label and ignores further clicks.
   - A save made of several requests in a row (upload, then save, then
     refresh) keeps spinning across the gaps instead of flickering.
   - It never changes the button's text or its disabled state, so a page
     that writes "Saved" onto the button afterwards still works as before.
   - Buttons that already show their own spinner (setBtnLoading) are left
     alone.
   - Clicking OK in one of the app's own confirm boxes counts as the
     original button, so "Are you sure? → OK → save" spins the button you
     first pressed. */
(function () {
  if (window.__dmBusyButtons) return;
  window.__dmBusyButtons = true;

  var CLICK_WINDOW = 1500; // ms after a click in which a request belongs to it
  var GRACE = 350;         // ms to keep spinning between back-to-back requests
  var MIN_SHOW = 450;      // ms minimum, so a fast save still visibly spins

  var SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
    "<circle cx='50' cy='50' r='46' fill='rgba(180,230,200,0.95)'/>" +
    "<path d='M50,4 A46,46 0 0,1 50,96 A23,23 0 0,1 50,50 A23,23 0 0,0 50,4 Z' fill='%23141a17'/>" +
    "<circle cx='50' cy='27' r='7' fill='%23141a17'/>" +
    "<circle cx='50' cy='73' r='7' fill='rgba(180,230,200,0.95)'/></svg>";

  var css =
    '@keyframes dm-busy-spin{to{transform:rotate(360deg)}}' +
    '.dm-busy{pointer-events:none!important;cursor:progress!important}' +
    '.dm-busy::before{content:"";display:inline-block;width:13px;height:13px;' +
    'margin-right:6px;vertical-align:-2px;flex:none;' +
    'background:url("data:image/svg+xml,' + SVG.replace(/"/g, "'").replace(/</g, '%3C').replace(/>/g, '%3E') + '") center/contain no-repeat;' +
    'animation:dm-busy-spin .85s linear infinite}';
  function addStyle() {
    if (document.getElementById('dm-busy-style')) return;
    var s = document.createElement('style');
    s.id = 'dm-busy-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }
  if (document.head) addStyle(); else document.addEventListener('DOMContentLoaded', addStyle);

  var BTN_SEL = 'button, input[type=submit], input[type=button], [role=button], a.btn, a.button';
  var lastClick = null;   // { btn, t }
  var current = null;     // button currently spinning or in its grace period
  var states = new WeakMap();

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  function onClick(e) {
    var t = e.target;
    var b = t && t.closest ? t.closest(BTN_SEL) : null;
    if (!b || b.disabled) return;
    // OK / Cancel inside the app's own dialogs: keep the button that opened
    // the dialog, and restart its clock (the person may have read for a while).
    if (b.closest('.app-dialog-overlay')) {
      if (lastClick) lastClick.t = now();
      return;
    }
    lastClick = { btn: b, t: now() };
  }
  document.addEventListener('click', onClick, true);
  // Enter key in a form submits it: treat the form's submit button as clicked.
  document.addEventListener('submit', function (e) {
    var b = e.submitter || (e.target && e.target.querySelector && e.target.querySelector('[type=submit]'));
    if (b) lastClick = { btn: b, t: now() };
  }, true);

  function pickButton() {
    if (current && current.isConnected) return current;
    if (lastClick && lastClick.btn.isConnected && now() - lastClick.t < CLICK_WINDOW) return lastClick.btn;
    return null;
  }

  function begin() {
    var b = pickButton();
    if (!b) return null;
    // The page is already showing its own spinner on this button.
    if (b.querySelector && b.querySelector('.btn-spinner')) return null;
    var st = states.get(b);
    if (!st) { st = { pending: 0, shownAt: 0, timer: null }; states.set(b, st); }
    clearTimeout(st.timer);
    st.pending++;
    if (!b.classList.contains('dm-busy')) {
      b.classList.add('dm-busy');
      b.setAttribute('aria-busy', 'true');
      st.shownAt = now();
    }
    current = b;
    return b;
  }

  function end(b) {
    if (!b) return;
    var st = states.get(b);
    if (!st) return;
    st.pending = Math.max(0, st.pending - 1);
    if (st.pending > 0) return;
    var wait = Math.max(GRACE, MIN_SHOW - (now() - st.shownAt));
    st.timer = setTimeout(function () {
      if (st.pending > 0) return;
      b.classList.remove('dm-busy');
      b.removeAttribute('aria-busy');
      if (current === b) current = null;
      lastClick = null;
    }, wait);
  }

  function changesData(method) {
    var m = String(method || 'GET').toUpperCase();
    return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
  }

  // fetch
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
      var b = changesData(method) ? begin() : null;
      var p;
      try { p = origFetch.apply(this, arguments); }
      catch (err) { end(b); throw err; }
      if (b) p.then(function () { end(b); }, function () { end(b); });
      return p;
    };
  }

  // XMLHttpRequest (file uploads with a progress bar use this)
  if (window.XMLHttpRequest) {
    var XP = XMLHttpRequest.prototype;
    var origOpen = XP.open, origSend = XP.send;
    XP.open = function (method) {
      this.__dmMethod = method;
      return origOpen.apply(this, arguments);
    };
    XP.send = function () {
      var b = changesData(this.__dmMethod) ? begin() : null;
      if (b) {
        var done = false, xhr = this;
        var finish = function () { if (!done) { done = true; end(b); } };
        xhr.addEventListener('loadend', finish);
      }
      try { return origSend.apply(this, arguments); }
      catch (err) { if (b) end(b); throw err; }
    };
  }
})();
