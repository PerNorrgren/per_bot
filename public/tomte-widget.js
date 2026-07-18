// ── Tomte widget (Per Bot 8) ──
// Self-contained, drop-in helper widget for any page: <script src="/tomte-widget.js" defer></script>
// Optionally set window.TOMTE_PAGE = 'Login' (or similar) before this script tag for a
// human-readable page name; falls back to document.title if not set.
// Answers ONLY "how does this app work" questions — see the server-side system prompt
// for the actual scope boundary. This file just handles the UI, voice capture, and
// telling the server what page/element the person is currently looking at.
(function () {
  const STYLE = `
    #tomte-fab {
      position: fixed; right: 18px; bottom: 18px; width: 58px; height: 58px;
      border-radius: 50%; overflow: hidden; cursor: pointer; z-index: 99998;
      border: 2px solid rgba(230,175,90,0.5); background: #0d1210;
      box-shadow: 0 4px 18px rgba(0,0,0,0.35); transition: transform 0.2s;
    }
    #tomte-fab:hover { transform: scale(1.06); }
    #tomte-fab { touch-action: none; }
    #tomte-fab.tomte-dragging { transition: none; }
    #tomte-fab img { width: 100%; height: 100%; object-fit: cover; object-position: 50% 15%; }
    #tomte-fab .tomte-badge {
      position: absolute; top: -3px; right: -3px; width: 14px; height: 14px; border-radius: 50%;
      background: rgba(230,175,90,0.9); border: 2px solid #0d1210; display: none;
    }
    /* Per Bot 18 — tip-pending state: bigger badge with a small glyph
       instead of a plain dot, so the "I noticed something" state reads
       differently from an ordinary unread-message dot. Placeholder icon
       (raised hand via CSS content) until real matching artwork exists —
       swapping to a real image later only needs a class/content change
       here, nothing in the tip logic itself. */
    #tomte-fab .tomte-badge.tomte-badge-tip {
      width: 20px; height: 20px; top: -5px; right: -5px; display: flex;
      align-items: center; justify-content: center; font-size: 11px;
      animation: tomte-tip-bounce 2s ease-in-out infinite;
    }
    #tomte-fab .tomte-badge.tomte-badge-tip::after { content: '✋'; }
    @keyframes tomte-tip-bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
    #tomte-fab.tomte-listening { border-color: rgba(255,140,120,0.8); animation: tomte-pulse 1.2s ease-in-out infinite; }
    @keyframes tomte-pulse { 0%,100% { box-shadow: 0 4px 18px rgba(255,140,120,0.15); } 50% { box-shadow: 0 4px 24px rgba(255,140,120,0.45); } }

    #tomte-panel {
      position: fixed; right: 18px; bottom: 86px; width: 320px; max-width: calc(100vw - 36px);
      max-height: 60vh; background: #0d1210; border: 1px solid rgba(255,255,255,0.12);
      border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); z-index: 99999;
      display: none; flex-direction: column; overflow: hidden; font-family: Georgia, serif;
    }
    #tomte-panel.tomte-open { display: flex; }
    #tomte-header {
      display: flex; align-items: center; gap: 10px; padding: 12px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03);
    }
    #tomte-header img { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; object-position: 50% 15%; }
    #tomte-header .tomte-title { flex: 1; color: rgba(255,255,255,0.85); font-size: 14px; }
    #tomte-header .tomte-sub { font-size: 10px; color: rgba(255,255,255,0.35); }
    #tomte-close { background: none; border: none; color: rgba(255,255,255,0.4); font-size: 18px; cursor: pointer; padding: 4px 8px; }
    #tomte-close:hover { color: rgba(255,255,255,0.8); }
    #tomte-voice-toggle { background: none; border: none; color: rgba(255,255,255,0.4); font-size: 15px; cursor: pointer; padding: 4px 6px; }
    #tomte-voice-toggle:hover { color: rgba(255,255,255,0.75); }
    #tomte-voice-toggle.tomte-voice-on { color: rgba(230,175,90,0.9); }
    #tomte-messages { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; min-height: 80px; }
    .tomte-msg { max-width: 88%; padding: 8px 11px; border-radius: 10px; font-size: 12.5px; line-height: 1.5; }
    .tomte-msg.tomte-bot { background: rgba(230,175,90,0.1); border: 1px solid rgba(230,175,90,0.2); color: rgba(255,228,190,0.9); align-self: flex-start; }
    .tomte-msg.tomte-user { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.8); align-self: flex-end; }
    .tomte-tip-action { display: inline-block; margin-top: 8px; font-size: 12px; color: rgba(230,175,90,0.95); text-decoration: none; border-bottom: 1px solid rgba(230,175,90,0.4); }
    .tomte-tip-action:hover { color: rgba(255,210,140,1); }
    .tomte-empty { color: rgba(255,255,255,0.3); font-size: 12px; font-style: italic; text-align: center; padding: 16px 8px; }
    #tomte-input-row { display: flex; gap: 6px; padding: 10px; border-top: 1px solid rgba(255,255,255,0.08); }
    #tomte-input {
      flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px; padding: 8px 10px; color: rgba(255,255,255,0.85); font-size: 12.5px; font-family: inherit;
    }
    .tomte-icon-btn {
      background: none; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
      padding: 7px 9px; cursor: pointer; font-size: 14px; color: rgba(255,255,255,0.6); line-height: 1;
    }
    .tomte-icon-btn.tomte-mic-on { border-color: rgba(255,120,100,0.7); background: rgba(255,120,100,0.18); color: rgba(255,150,130,0.95); animation: tomte-pulse 1.2s ease-in-out infinite; }
    .tomte-icon-btn.tomte-primary { border-color: rgba(230,175,90,0.35); color: rgba(230,175,90,0.85); }
    #tomte-mic-status {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      margin: 0 10px 8px 10px; padding: 8px 12px; border-radius: 8px;
      background: rgba(255,140,120,0.1); border: 1px solid rgba(255,140,120,0.35);
      font-size: 13px; color: rgba(255,190,175,0.95);
    }
    #tomte-mic-status.tomte-mic-ready { background: rgba(230,175,90,0.1); border-color: rgba(230,175,90,0.35); color: rgba(255,224,185,0.95); }
    #tomte-mic-send-btn {
      background: rgba(230,175,90,0.18); border: 1px solid rgba(230,175,90,0.45);
      color: rgba(255,224,185,0.95); border-radius: 6px; padding: 4px 14px;
      font-size: 12px; cursor: pointer; flex-shrink: 0;
    }
  `;

  function injectStyle() {
    const s = document.createElement('style');
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function buildDom() {
    const fab = document.createElement('div');
    fab.id = 'tomte-fab';
    fab.innerHTML = `<img src="/assets/tomte.png" alt="Tomte — app helper"/><div class="tomte-badge" id="tomte-badge"></div>`;
    fab.title = 'Ask Tomte how this works';

    const panel = document.createElement('div');
    panel.id = 'tomte-panel';
    panel.innerHTML = `
      <div id="tomte-header">
        <img src="/assets/tomte.png" alt="Tomte"/>
        <div>
          <div class="tomte-title">Tomte</div>
          <div class="tomte-sub">Ask me how this app works</div>
        </div>
        <button id="tomte-voice-toggle" title="Turn on spoken replies">🔇</button>
        <button id="tomte-close" aria-label="Close">×</button>
      </div>
      <div id="tomte-messages"><div class="tomte-empty">Ask me anything about this page — what a button does, where to find something, how a field works.</div></div>
      <div id="tomte-mic-status" style="display:none">
        <span id="tomte-mic-status-text">Mic loading…</span>
        <button id="tomte-mic-send-btn">Send</button>
      </div>
      <div id="tomte-input-row">
        <input type="text" id="tomte-input" placeholder="Ask Tomte…"/>
        <button class="tomte-icon-btn" id="tomte-mic-btn" title="Ask by voice">🎙️</button>
        <button class="tomte-icon-btn tomte-primary" id="tomte-send-btn" title="Send">➤</button>
      </div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(panel);
    return { fab, panel };
  }

  function describeElement(el) {
    if (!el || el === document.body) return '';
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (!['input', 'textarea', 'select', 'button', 'a'].includes(tag)) {
      // Walk up to the nearest interactive ancestor, since clicks often land on
      // an icon/span inside a button rather than the button itself.
      const closest = el.closest && el.closest('input, textarea, select, button, a');
      if (closest) el = closest; else return '';
    }
    const label =
      el.getAttribute('aria-label') ||
      el.placeholder ||
      (el.id && document.querySelector(`label[for="${el.id}"]`) ? document.querySelector(`label[for="${el.id}"]`).textContent.trim() : '') ||
      (el.textContent && el.textContent.trim().slice(0, 60)) ||
      el.name || el.id || '';
    const kind = el.tagName.toLowerCase() === 'button' || (el.tagName.toLowerCase() === 'input' && el.type === 'submit') ? 'button'
      : el.tagName.toLowerCase() === 'a' ? 'link'
      : el.tagName.toLowerCase() === 'select' ? 'dropdown'
      : 'field';
    return label ? `a ${kind} labelled "${label}"` : '';
  }

  function init() {
    injectStyle();
    const { fab, panel } = buildDom();
    const messagesEl = document.getElementById('tomte-messages');
    const badge = document.getElementById('tomte-badge');
    const inputEl = document.getElementById('tomte-input');
    const micBtn = document.getElementById('tomte-mic-btn');
    const sendBtn = document.getElementById('tomte-send-btn');
    const micStatusEl = document.getElementById('tomte-mic-status');
    const micStatusText = document.getElementById('tomte-mic-status-text');
    const micSendBtn = document.getElementById('tomte-mic-send-btn');
    const closeBtn = document.getElementById('tomte-close');
    const voiceToggleBtn = document.getElementById('tomte-voice-toggle');

    let ws = null;
    let wsReady = false;
    let pendingContext = null;
    let lastFocusDescription = '';
    let isListening = false;
    let mediaStream = null;
    let mediaRecorder = null;
    let defaultImageUrl = '/assets/tomte.png';
    // Tracks the personalized name (set by applyPersonalization() below)
    // so anywhere the widget shows "Ask <name>…" — including the input
    // placeholder, which gets reset every time listening stops — uses the
    // person's chosen name instead of reverting to the hardcoded default.
    let helperName = 'Tomte';
    // Per Bot 11: spoken replies are opt-in, persisted per ACCOUNT now
    // (via /api/my/tomte-settings + PATCH /api/my/tomte-voice) rather than
    // per browser in localStorage — the same toggle now follows someone
    // across devices, and an admin can also set it on someone's behalf
    // from the user details panel. Logged-out visitors have no account to
    // persist to, so their toggle just lives in memory for the session and
    // resets to off on refresh — acceptable, since there's no account to
    // read from either way. Starts false and gets corrected by
    // applyPersonalization() below as soon as that response comes back, to
    // avoid a flash of the wrong icon for a logged-in person.
    let voiceEnabled = false;

    function pageName() {
      return window.TOMTE_PAGE || document.title || location.pathname;
    }

    // Personalization (Per Bot 8) — silently falls back to the default
    // name/image if the person isn't logged in, or just hasn't set
    // anything. Public pages will always hit the "not logged in" case,
    // which is expected and not an error.
    //
    // Per Bot 9: a personal photo can fail to load even when it's set
    // correctly server-side — e.g. a transient Railway volume hiccup, or
    // the file genuinely missing. Either way, this should never surface as
    // a broken image icon. setImgWithFallback() below wires an onerror on
    // every image we touch so a failed load quietly reverts to the plain
    // default asset instead.
    function setImgWithFallback(img, url) {
      img.onerror = () => { img.onerror = null; img.src = '/assets/tomte.png'; };
      img.src = url;
    }
    (async function applyPersonalization() {
      try {
        const res = await fetch('/api/my/tomte-settings');
        if (!res.ok) return; // not logged in — defaults stay as-is
        const data = await res.json();
        if (data.name) {
          helperName = data.name;
          document.querySelectorAll('#tomte-header .tomte-title').forEach(el => el.textContent = data.name);
          fab.title = `Ask ${data.name} how this works`;
          inputEl.placeholder = `Ask ${data.name}…`;
        }
        if (data.imageUrl) {
          defaultImageUrl = data.imageUrl;
          document.querySelectorAll('#tomte-fab img, #tomte-header img').forEach(img => setImgWithFallback(img, data.imageUrl));
        }
        voiceEnabled = !!data.voiceEnabled;
        updateVoiceToggleUI();
        if (wsReady) ws.send(JSON.stringify({ type: 'set_voice', enabled: voiceEnabled }));
      } catch(e) { /* not logged in, or a network hiccup — defaults are fine */ }
    })();

    // Per Bot 18 — proactive tips. Same silent-no-op-if-not-logged-in
    // pattern as applyPersonalization above (tomte-widget.js loads on
    // public pages too, e.g. /promotions, where this route simply won't
    // exist for the visitor). Only ever fetched once per page load — the
    // badge either lights up or it doesn't; no polling.
    let pendingTip = null;
    (async function checkTomteTip() {
      try {
        const res = await fetch('/api/my/tomte-tip');
        if (!res.ok) return;
        const tip = await res.json();
        if (!tip) return;
        pendingTip = tip;
        badge.classList.add('tomte-badge-tip');
        badge.style.display = 'flex';
      } catch(e) { /* quietly no-op */ }
    })();

    // Expressions (Per Bot 8) — swaps to whatever image the server resolved
    // for this action (shrug, smile, thinking, etc.), then quietly reverts
    // to the person's own default a few seconds later so it doesn't get
    // stuck mid-expression. imageUrl can be null (no image uploaded for
    // that action yet) — in which case this just no-ops and the default
    // stays showing, exactly the "use the default" fallback.
    let actionRevertTimer = null;
    function applyAction(imageUrl) {
      if (!imageUrl) return;
      clearTimeout(actionRevertTimer);
      document.querySelectorAll('#tomte-fab img, #tomte-header img').forEach(img => setImgWithFallback(img, imageUrl));
      actionRevertTimer = setTimeout(() => {
        document.querySelectorAll('#tomte-fab img, #tomte-header img').forEach(img => setImgWithFallback(img, defaultImageUrl));
      }, 6000);
    }

    function connect() {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/tomte`;
      console.log('[tomte] connecting to', url);
      ws = new WebSocket(url);
      ws.onopen = () => {
        console.log('[tomte] connection opened');
        wsReady = true;
        sendContext();
        ws.send(JSON.stringify({ type: 'set_voice', enabled: voiceEnabled }));
      };
      ws.onclose = (e) => {
        console.log(`[tomte] connection closed — code=${e.code} reason="${e.reason}" wasClean=${e.wasClean}`);
        wsReady = false;
      };
      ws.onerror = (e) => {
        console.error('[tomte] connection error', e);
        wsReady = false;
        addMessage('bot', "I couldn't connect just now — try again in a moment, or refresh the page.");
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'response_text') addMessage('bot', msg.text);
        if (msg.type === 'final_transcript') addMessage('user', msg.text);
        if (msg.type === 'audio') playAudio(msg.data);
        if (msg.type === 'action') applyAction(msg.imageUrl);
        if (msg.type === 'listening_started') { console.log('[tomte] mic: server confirmed listening'); }
      };
    }

    // Shared by sendText/startListening below — polls briefly for the
    // connection to be ready rather than assuming it always will be; if it
    // never opens (blocked, offline, server hiccup), this surfaces that
    // instead of waiting silently forever with no feedback at all.
    function whenReady(fn) {
      const start = Date.now();
      const tryNow = () => {
        if (wsReady) { fn(); return; }
        if (Date.now() - start > 8000) {
          addMessage('bot', "Still trying to connect — check your connection and try again.");
          return;
        }
        setTimeout(tryNow, 150);
      };
      tryNow();
    }

    function sendContext() {
      const ctx = { type: 'context', page: pageName(), focus: lastFocusDescription, skinSlug: window.__skinSlug || null };
      if (wsReady) ws.send(JSON.stringify(ctx));
      else pendingContext = ctx;
    }

    function addMessage(role, text) {
      const empty = messagesEl.querySelector('.tomte-empty');
      if (empty) empty.remove();
      const div = document.createElement('div');
      div.className = `tomte-msg tomte-${role === 'bot' ? 'bot' : 'user'}`;
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function playAudio(b64) {
      const bytes = atob(b64), arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const audio = new Audio(URL.createObjectURL(new Blob([arr], { type: 'audio/mpeg' })));
      audio.play().catch(() => {});
    }

    // Track focus/click globally so the next question starts from what the
    // person was just looking at, not the whole page — debounced lightly
    // since focus can fire in quick bursts (tabbing through a form).
    let focusDebounce = null;
    function noteFocus(el) {
      const desc = describeElement(el);
      if (!desc || desc === lastFocusDescription) return;
      lastFocusDescription = desc;
      clearTimeout(focusDebounce);
      focusDebounce = setTimeout(sendContext, 250);
    }
    document.addEventListener('focusin', (e) => noteFocus(e.target), true);
    document.addEventListener('click', (e) => noteFocus(e.target), true);

    // iOS/WebKit has a known quirk where showing or hiding one fixed-
    // position element (this panel) can freeze scrolling in an unrelated
    // sibling scroll container elsewhere on the page — reported on the
    // course lesson chooser specifically: opening Tomte over it left the
    // file list stuck, unable to scroll, until reload. Harmless no-op on
    // any page that doesn't have that element.
    function nudgeScrollContainers() {
      document.querySelectorAll('.lesson-chooser-list').forEach((el) => {
        const prev = el.style.overflowY;
        el.style.overflowY = 'hidden';
        void el.offsetHeight; // force reflow
        el.style.overflowY = prev || 'auto';
      });
    }

    // Per Bot 18 — renders a tip with its action link. Separate from
    // addMessage since a tip needs an actual clickable link inside the
    // bubble, not just plain text — content here is always our own
    // hand-written copy from TOMTE_TIPS server-side, never user input, so
    // innerHTML is safe.
    function addTipMessage(tip) {
      const empty = messagesEl.querySelector('.tomte-empty');
      if (empty) empty.remove();
      const div = document.createElement('div');
      div.className = 'tomte-msg tomte-bot';
      div.textContent = tip.text;
      if (tip.actionLabel && tip.actionHref) {
        const a = document.createElement('a');
        a.href = tip.actionHref; a.className = 'tomte-tip-action'; a.textContent = tip.actionLabel + ' →';
        div.appendChild(document.createElement('br'));
        div.appendChild(a);
      }
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function openPanel() {
      panel.classList.add('tomte-open');
      positionPanel();
      connect();
      inputEl.focus();
      nudgeScrollContainers();
      // A pending tip counts as this session's greeting — showing both
      // back to back would feel cluttered for what's meant to be one
      // quiet, easy-to-ignore observation, not two things landing at once.
      if (pendingTip) {
        addTipMessage(pendingTip);
        fetch('/api/my/tomte-tip/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tipId: pendingTip.id }) }).catch(() => {});
        pendingTip = null;
        badge.classList.remove('tomte-badge-tip');
        badge.style.display = 'none';
        sessionStorage.setItem('tomte_greeted', '1');
        return;
      }
      // First contact (Per Bot 8) — greets once per browser session, not
      // every time the panel opens, so it doesn't get repetitive if
      // someone opens/closes him a few times while using the app.
      if (!sessionStorage.getItem('tomte_greeted')) {
        sessionStorage.setItem('tomte_greeted', '1');
        whenReady(() => ws.send(JSON.stringify({ type: 'greet', page: pageName() })));
      }
    }
    function closePanel() { panel.classList.remove('tomte-open'); nudgeScrollContainers(); }

    // ── Movable fab (mobile fix) — the fab defaults to its original
    // bottom-right CSS spot, but on small screens that can sit right on
    // top of a page's own bottom-corner button. Dragging it remembers the
    // new spot per-browser (localStorage) so it stays out of the way from
    // then on; a plain tap (no meaningful movement) still opens/closes the
    // panel exactly as before. Uses Pointer Events so mouse, touch, and
    // pen all go through the same code path.
    const FAB_MARGIN = 8;
    function clampNum(v, min, max) { return Math.min(Math.max(v, min), max); }
    // window.innerWidth/innerHeight don't reliably reflect what's actually
    // visible on mobile — Safari's address bar expanding or collapsing
    // after a position was computed can leave a fixed-position element's
    // top edge sitting behind the toolbar, looking like it "scrolled off"
    // even though nothing moved. visualViewport tracks the true visible
    // area and stays current; fall back to window dimensions where it's
    // not available.
    function viewportWidth() { return window.visualViewport ? window.visualViewport.width : window.innerWidth; }
    function viewportHeight() { return window.visualViewport ? window.visualViewport.height : window.innerHeight; }
    function loadFabPos() {
      try {
        const saved = JSON.parse(localStorage.getItem('tomte_fab_pos') || 'null');
        if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') return saved;
      } catch (e) {}
      return null;
    }
    function saveFabPos(pos) {
      try { localStorage.setItem('tomte_fab_pos', JSON.stringify(pos)); } catch (e) {}
    }
    function applyFabPos(pos) {
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
      fab.style.left = pos.x + 'px';
      fab.style.top = pos.y + 'px';
    }
    function restoreFabPos() {
      const saved = loadFabPos();
      if (!saved) return; // leave default CSS right/bottom spot untouched
      const x = clampNum(saved.x, FAB_MARGIN, viewportWidth() - fab.offsetWidth - FAB_MARGIN);
      const y = clampNum(saved.y, FAB_MARGIN, viewportHeight() - fab.offsetHeight - FAB_MARGIN);
      applyFabPos({ x, y });
    }
    // Wherever the fab ends up, the panel opens near it — above if there's
    // room, below otherwise; same idea horizontally — rather than staying
    // pinned to the original bottom-right corner regardless of where the
    // fab was dragged to.
    function positionPanel() {
      const r = fab.getBoundingClientRect();
      const pw = panel.offsetWidth || 320;
      const ph = panel.offsetHeight || 400;
      let left = r.right - pw;
      if (left < FAB_MARGIN) left = r.left;
      left = clampNum(left, FAB_MARGIN, viewportWidth() - pw - FAB_MARGIN);
      let top = r.top - ph - 8;
      if (top < FAB_MARGIN) top = r.bottom + 8;
      top = clampNum(top, FAB_MARGIN, viewportHeight() - ph - FAB_MARGIN);
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    }
    restoreFabPos();
    window.addEventListener('resize', restoreFabPos);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => {
        restoreFabPos();
        if (panel.classList.contains('tomte-open')) positionPanel();
      });
    }

    let fabDragging = false, fabDragMoved = false;
    let dragStartX = 0, dragStartY = 0, fabStartX = 0, fabStartY = 0;
    const DRAG_THRESHOLD = 6; // px — below this, treat it as a tap, not a drag

    fab.addEventListener('pointerdown', (e) => {
      fabDragging = true;
      fabDragMoved = false;
      dragStartX = e.clientX; dragStartY = e.clientY;
      const r = fab.getBoundingClientRect();
      fabStartX = r.left; fabStartY = r.top;
      fab.setPointerCapture(e.pointerId);
    });
    fab.addEventListener('pointermove', (e) => {
      if (!fabDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (!fabDragMoved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        fabDragMoved = true;
        fab.classList.add('tomte-dragging');
      }
      if (!fabDragMoved) return;
      const x = clampNum(fabStartX + dx, FAB_MARGIN, viewportWidth() - fab.offsetWidth - FAB_MARGIN);
      const y = clampNum(fabStartY + dy, FAB_MARGIN, viewportHeight() - fab.offsetHeight - FAB_MARGIN);
      applyFabPos({ x, y });
    });
    fab.addEventListener('pointerup', (e) => {
      if (!fabDragging) return;
      fabDragging = false;
      fab.classList.remove('tomte-dragging');
      try { fab.releasePointerCapture(e.pointerId); } catch (err) {}
      if (fabDragMoved) {
        const r = fab.getBoundingClientRect();
        saveFabPos({ x: r.left, y: r.top });
        if (panel.classList.contains('tomte-open')) positionPanel();
      } else {
        if (panel.classList.contains('tomte-open')) closePanel(); else openPanel();
      }
    });
    fab.addEventListener('pointercancel', () => {
      fabDragging = false;
      fab.classList.remove('tomte-dragging');
    });
    closeBtn.addEventListener('click', closePanel);

    function updateVoiceToggleUI() {
      voiceToggleBtn.textContent = voiceEnabled ? '🔊' : '🔇';
      voiceToggleBtn.title = voiceEnabled ? 'Turn off spoken replies' : 'Turn on spoken replies';
      voiceToggleBtn.classList.toggle('tomte-voice-on', voiceEnabled);
    }
    updateVoiceToggleUI();
    voiceToggleBtn.addEventListener('click', () => {
      voiceEnabled = !voiceEnabled;
      updateVoiceToggleUI();
      if (wsReady) ws.send(JSON.stringify({ type: 'set_voice', enabled: voiceEnabled }));
      // Best-effort — if there's no account (logged-out visitor) or the
      // request fails, the toggle still works for the rest of this
      // session; it just won't be remembered next time.
      fetch('/api/my/tomte-voice', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: voiceEnabled })
      }).catch(() => {});
    });

    function sendText() {
      const text = inputEl.value.trim();
      if (!text) return;
      connect();
      addMessage('user', text);
      inputEl.value = '';
      whenReady(() => ws.send(JSON.stringify({ type: 'text_input', text })));
    }
    sendBtn.addEventListener('click', sendText);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });

    async function startListening() {
      if (isListening) return;
      console.log('[tomte] mic: requesting access');
      micStatusEl.style.display = 'flex';
      micStatusEl.classList.remove('tomte-mic-ready');
      micStatusText.textContent = 'Mic loading…';
      try { mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch(e) {
        console.error('[tomte] mic: getUserMedia failed', e);
        micStatusEl.style.display = 'none';
        addMessage('bot', "I couldn't access your microphone — check your browser's permission settings.");
        return;
      }
      console.log('[tomte] mic: got stream, starting recorder');
      isListening = true;
      fab.classList.add('tomte-listening');
      micBtn.classList.add('tomte-mic-on');
      inputEl.placeholder = 'Listening…';
      connect();
      whenReady(() => ws.send(JSON.stringify({ type: 'start_listening' })));
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus' });
      let chunkCount = 0;
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0 && wsReady) {
          chunkCount++;
          if (chunkCount === 1 || chunkCount % 10 === 0) console.log(`[tomte] mic: sent chunk #${chunkCount} (${e.data.size} bytes)`);
          const r = new FileReader();
          r.onload = () => ws.send(JSON.stringify({ type: 'audio_chunk', data: r.result.split(',')[1] }));
          r.readAsDataURL(e.data);
        } else if (e.data.size > 0) {
          console.log('[tomte] mic: chunk ready but socket not open yet — dropped');
        }
      };
      mediaRecorder.start(200);
      // Per Bot 9: recording has already started above, so nothing is lost
      // either way — this just holds the "Please speak…" cue back by a
      // beat, giving the mic/browser a moment to actually settle (track
      // init, permission handshake) before telling someone to start
      // talking, since the very first fraction of a second was otherwise
      // easy to talk over before anything was really ready to capture it.
      micStatusText.textContent = 'Loading…';
      setTimeout(() => {
        if (isListening) {
          micStatusEl.classList.add('tomte-mic-ready');
          micStatusText.textContent = 'Please speak…';
        }
      }, 600);
    }
    function stopListening() {
      if (!isListening) return;
      isListening = false;
      fab.classList.remove('tomte-listening');
      micBtn.classList.remove('tomte-mic-on');
      inputEl.placeholder = `Ask ${helperName}…`;
      micStatusEl.style.display = 'none';
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
      if (wsReady) ws.send(JSON.stringify({ type: 'stop_listening' }));
    }
    micBtn.addEventListener('click', () => { isListening ? stopListening() : startListening(); });
    micSendBtn.addEventListener('click', stopListening);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
