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
      border: 2px solid rgba(180,230,200,0.5); background: #0d1210;
      box-shadow: 0 4px 18px rgba(0,0,0,0.35); transition: transform 0.2s;
    }
    #tomte-fab:hover { transform: scale(1.06); }
    #tomte-fab img { width: 100%; height: 100%; object-fit: cover; object-position: 50% 15%; }
    #tomte-fab .tomte-badge {
      position: absolute; top: -3px; right: -3px; width: 14px; height: 14px; border-radius: 50%;
      background: rgba(180,230,200,0.9); border: 2px solid #0d1210; display: none;
    }
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
    #tomte-messages { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; min-height: 80px; }
    .tomte-msg { max-width: 88%; padding: 8px 11px; border-radius: 10px; font-size: 12.5px; line-height: 1.5; }
    .tomte-msg.tomte-bot { background: rgba(180,230,200,0.1); border: 1px solid rgba(180,230,200,0.2); color: rgba(220,255,235,0.9); align-self: flex-start; }
    .tomte-msg.tomte-user { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.8); align-self: flex-end; }
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
    .tomte-icon-btn.tomte-mic-on { border-color: rgba(255,120,100,0.5); background: rgba(255,120,100,0.1); color: rgba(255,150,130,0.9); }
    .tomte-icon-btn.tomte-primary { border-color: rgba(180,230,200,0.35); color: rgba(180,230,200,0.85); }
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
        <button id="tomte-close" aria-label="Close">×</button>
      </div>
      <div id="tomte-messages"><div class="tomte-empty">Ask me anything about this page — what a button does, where to find something, how a field works.</div></div>
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
    const inputEl = document.getElementById('tomte-input');
    const micBtn = document.getElementById('tomte-mic-btn');
    const sendBtn = document.getElementById('tomte-send-btn');
    const closeBtn = document.getElementById('tomte-close');

    let ws = null;
    let wsReady = false;
    let pendingContext = null;
    let lastFocusDescription = '';
    let isListening = false;
    let mediaStream = null;
    let mediaRecorder = null;

    function pageName() {
      return window.TOMTE_PAGE || document.title || location.pathname;
    }

    // Personalization (Per Bot 8) — silently falls back to the default
    // name/image if the person isn't logged in, or just hasn't set
    // anything. Public pages will always hit the "not logged in" case,
    // which is expected and not an error.
    (async function applyPersonalization() {
      try {
        const res = await fetch('/api/my/tomte-settings');
        if (!res.ok) return; // not logged in — defaults stay as-is
        const data = await res.json();
        if (data.name) {
          document.querySelectorAll('#tomte-header .tomte-title').forEach(el => el.textContent = data.name);
          fab.title = `Ask ${data.name} how this works`;
        }
        if (data.imageUrl) {
          document.querySelectorAll('#tomte-fab img, #tomte-header img').forEach(img => { img.src = data.imageUrl; });
        }
      } catch(e) { /* not logged in, or a network hiccup — defaults are fine */ }
    })();

    function connect() {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/tomte`);
      ws.onopen = () => {
        wsReady = true;
        sendContext();
      };
      ws.onclose = () => { wsReady = false; };
      ws.onerror = () => {
        wsReady = false;
        addMessage('bot', "I couldn't connect just now — try again in a moment, or refresh the page.");
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'response_text') addMessage('bot', msg.text);
        if (msg.type === 'final_transcript') addMessage('user', msg.text);
        if (msg.type === 'audio') playAudio(msg.data);
        if (msg.type === 'listening_started') { /* no-op, UI already shows mic state */ }
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
      const ctx = { type: 'context', page: pageName(), focus: lastFocusDescription };
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

    function openPanel() {
      panel.classList.add('tomte-open');
      connect();
      inputEl.focus();
      // First contact (Per Bot 8) — greets once per browser session, not
      // every time the panel opens, so it doesn't get repetitive if
      // someone opens/closes him a few times while using the app.
      if (!sessionStorage.getItem('tomte_greeted')) {
        sessionStorage.setItem('tomte_greeted', '1');
        whenReady(() => ws.send(JSON.stringify({ type: 'greet', page: pageName() })));
      }
    }
    function closePanel() { panel.classList.remove('tomte-open'); }

    fab.addEventListener('click', () => {
      if (panel.classList.contains('tomte-open')) closePanel(); else openPanel();
    });
    closeBtn.addEventListener('click', closePanel);

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
      try { mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch(e) { addMessage('bot', "I couldn't access your microphone — check your browser's permission settings."); return; }
      isListening = true;
      fab.classList.add('tomte-listening');
      micBtn.classList.add('tomte-mic-on');
      connect();
      whenReady(() => ws.send(JSON.stringify({ type: 'start_listening' })));
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0 && wsReady) {
          const r = new FileReader();
          r.onload = () => ws.send(JSON.stringify({ type: 'audio_chunk', data: r.result.split(',')[1] }));
          r.readAsDataURL(e.data);
        }
      };
      mediaRecorder.start(200);
    }
    function stopListening() {
      if (!isListening) return;
      isListening = false;
      fab.classList.remove('tomte-listening');
      micBtn.classList.remove('tomte-mic-on');
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
      if (wsReady) ws.send(JSON.stringify({ type: 'stop_listening' }));
    }
    micBtn.addEventListener('click', () => { isListening ? stopListening() : startListening(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
