/**
 * tomte.js — Deeper Mindfulness Platform
 * The Tomten helper — typewriter, voice, chat, event bus.
 * 
 * Usage:
 *   window.Tomte.say("Message here")
 *   window.Tomte.ask("Question?", [{label:"Yes", action:fn}, {label:"No", action:fn}])
 *   window.Tomte.event("comms:sent", { count: 186 })
 * 
 * Page context: set window.TOMTE_CONTEXT before this script loads.
 *   e.g. <script>window.TOMTE_CONTEXT = { page: "comms", role: "admin" }</script>
 */

(function() {
  'use strict';

  // ─── State ───────────────────────────────────────────────
  let isMuted = (sessionStorage.getItem('tomte-muted') === 'true');
  let isOpen = false;
  let isThinking = false;
  let typewriterTimer = null;
  let currentAudio = null;
  let mediaRecorder = null;
  let isRecording = false;
  let messageHistory = []; // for Claude context

  // ─── DOM refs ────────────────────────────────────────────
  const root       = () => document.getElementById('tomte-root');
  const bubble     = () => document.getElementById('tomte-bubble');
  const textEl     = () => document.getElementById('tomte-text');
  const cursorEl   = () => document.querySelector('.tomte-cursor');
  const actionsEl  = () => document.getElementById('tomte-actions');
  const inputEl    = () => document.getElementById('tomte-input');
  const svgEl      = () => document.getElementById('tomte-svg');
  const thinkingEl = () => document.getElementById('tomte-thinking');
  const dotEl      = () => document.getElementById('tomte-dot');
  const dotTextEl  = () => document.getElementById('tomte-dot-text');
  const muteBtn    = () => document.getElementById('tomte-mute');

  // ─── Open / close ─────────────────────────────────────────
  function open() {
    isOpen = true;
    bubble().classList.remove('tomte-hidden');
    bubble().classList.add('tomte-visible');
    hideDot();
    // If no message yet, greet based on page context
    if (!textEl().textContent) {
      greetForPage();
    }
  }

  function close() {
    isOpen = false;
    bubble().classList.remove('tomte-visible');
    bubble().classList.add('tomte-hidden');
    stopAudio();
  }

  // ─── Notification dot ────────────────────────────────────
  function showDot(n) {
    dotEl().style.display = 'block';
    dotTextEl().textContent = n != null ? String(n) : '!';
  }

  function hideDot() {
    dotEl().style.display = 'none';
  }

  // ─── Typewriter ──────────────────────────────────────────
  function typewrite(text, onDone) {
    stopTypewriter();
    textEl().textContent = '';
    cursorEl().style.display = 'inline-block';

    let i = 0;
    const speed = Math.max(18, Math.min(38, 800 / text.length)); // adaptive speed

    function tick() {
      if (i < text.length) {
        textEl().textContent += text[i++];
        typewriterTimer = setTimeout(tick, speed);
      } else {
        // Pause cursor 1s then hide
        setTimeout(() => {
          if (cursorEl()) cursorEl().style.display = 'none';
        }, 1200);
        if (onDone) onDone();
      }
    }
    tick();
  }

  function stopTypewriter() {
    if (typewriterTimer) {
      clearTimeout(typewriterTimer);
      typewriterTimer = null;
    }
  }

  // ─── Audio / Voice ───────────────────────────────────────
  async function speak(text) {
    if (isMuted) return;
    stopAudio();

    try {
      const res = await fetch('/api/tomte/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });

      if (!res.ok) return;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      currentAudio = new Audio(url);

      // Speaking animation
      svgEl().classList.add('is-speaking');
      currentAudio.addEventListener('ended', () => {
        svgEl().classList.remove('is-speaking');
        URL.revokeObjectURL(url);
        currentAudio = null;
      });
      currentAudio.play().catch(() => {
        svgEl().classList.remove('is-speaking');
      });
    } catch (e) {
      console.warn('[Tomte] Voice unavailable:', e.message);
    }
  }

  function stopAudio() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    if (svgEl()) svgEl().classList.remove('is-speaking');
  }

  // ─── Thinking state ──────────────────────────────────────
  function showThinking() {
    isThinking = true;
    thinkingEl().style.display = 'flex';
    svgEl().style.animation = 'none'; // pause sway
  }

  function hideThinking() {
    isThinking = false;
    thinkingEl().style.display = 'none';
    svgEl().style.animation = ''; // restore sway
  }

  // ─── Main say function ───────────────────────────────────
  /**
   * Make Tomte say something.
   * @param {string} text - The message
   * @param {Array}  actions - Optional [{label, action, primary}]
   * @param {boolean} forceOpen - Open bubble even if closed
   */
  function say(text, actions, forceOpen = true) {
    hideThinking();
    clearActions();

    if (forceOpen && !isOpen) {
      open();
    }

    if (!isOpen) {
      // Don't open but show notification dot
      showDot('!');
      return;
    }

    // Typewrite and speak simultaneously
    typewrite(text, () => {
      if (actions && actions.length) {
        showActions(actions);
      }
    });
    speak(text);
  }

  // ─── ask() - message with confirmation buttons ────────────
  /**
   * Ask a question with action buttons (replaces native confirm/alert)
   * @param {string} text
   * @param {Array}  actions - [{label, action, primary, spinner}]
   */
  function ask(text, actions) {
    if (!isOpen) open();
    say(text, actions);
  }

  // ─── Actions ─────────────────────────────────────────────
  function showActions(actions) {
    const el = actionsEl();
    el.innerHTML = '';
    el.style.display = 'flex';

    actions.forEach(({ label, action, primary, spinner }) => {
      const btn = document.createElement('button');
      btn.className = 'tomte-action-btn' + (primary ? ' primary' : '');
      btn.textContent = label;

      btn.addEventListener('click', async () => {
        if (spinner) {
          btn.innerHTML = '<span class="tomte-btn-spinner"></span>' + label;
          btn.disabled = true;
        }
        if (action) await action(btn);
      });

      el.appendChild(btn);
    });
  }

  function clearActions() {
    const el = actionsEl();
    if (el) {
      el.innerHTML = '';
      el.style.display = 'none';
    }
  }

  // ─── Claude API chat ─────────────────────────────────────
  async function askClaude(userMessage) {
    showThinking();

    // Add to history
    messageHistory.push({ role: 'user', content: userMessage });

    // Keep last 10 turns
    if (messageHistory.length > 20) messageHistory = messageHistory.slice(-20);

    try {
      const res = await fetch('/api/tomte/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messageHistory,
          context: window.TOMTE_CONTEXT || {}
        })
      });

      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      const reply = data.reply || "I'm not sure about that. Could you ask differently?";

      messageHistory.push({ role: 'assistant', content: reply });
      hideThinking();
      say(reply, null, true);

    } catch (e) {
      hideThinking();
      say("Something went quiet on my end. Try again?", null, true);
      console.error('[Tomte] Chat error:', e);
    }
  }

  // ─── STT via Deepgram ────────────────────────────────────
  async function startRecording() {
    if (!navigator.mediaDevices) {
      say("Microphone access isn't available here.", null, true);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const micBtn = document.getElementById('tomte-mic');
      micBtn.classList.add('recording');
      isRecording = true;

      const chunks = [];
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      
      mediaRecorder.onstop = async () => {
        micBtn.classList.remove('recording');
        stream.getTracks().forEach(t => t.stop());
        isRecording = false;

        const blob = new Blob(chunks, { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('audio', blob, 'voice.webm');
        formData.append('language', 'en');

        showThinking();
        try {
          const res = await fetch('/api/tomte/transcribe', {
            method: 'POST',
            body: formData
          });
          const data = await res.json();
          if (data.transcript) {
            inputEl().value = data.transcript;
            hideThinking();
            await askClaude(data.transcript);
          } else {
            hideThinking();
            say("I didn't catch that. Try again?", null, true);
          }
        } catch (e) {
          hideThinking();
          say("Voice transcription didn't work. Type instead?", null, true);
        }
      };

      mediaRecorder.start();

      // Auto-stop after 8s
      setTimeout(() => {
        if (isRecording && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
      }, 8000);

    } catch (e) {
      say("I need microphone permission to listen.", null, true);
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }

  // ─── Mute toggle ─────────────────────────────────────────
  function toggleMute() {
    isMuted = !isMuted;
    sessionStorage.setItem('tomte-muted', isMuted);

    const wave1 = document.getElementById('tomte-wave1');
    const wave2 = document.getElementById('tomte-wave2');
    const mutedLine = document.getElementById('tomte-muted-line');

    if (isMuted) {
      if (wave1) wave1.style.display = 'none';
      if (wave2) wave2.style.display = 'none';
      if (mutedLine) mutedLine.style.display = 'block';
      stopAudio();
    } else {
      if (wave1) wave1.style.display = '';
      if (wave2) wave2.style.display = '';
      if (mutedLine) mutedLine.style.display = 'none';
    }
  }

  // ─── Page-aware greeting ─────────────────────────────────
  function greetForPage() {
    const ctx = window.TOMTE_CONTEXT || {};
    const greetings = {
      'comms':    "Here to help with your message. I can tell you who's been reached and who still needs sending — just ask.",
      'members':  "I'm keeping an eye on the member list. Need to find someone, or want to know how many are active?",
      'sessions': "Session overview is ready. Ask me about any client or session, and I'll find it.",
      'library':  "The practice library is all here. What are you looking for?",
      'courses':  "Course builder is open. I can help you with structure, sessions, or anything you need.",
      'default':  "Endast tomten är vaken — only Tomten is awake. I'm here if you need me."
    };

    const msg = greetings[ctx.page] || greetings.default;
    typewrite(msg);
    // Don't auto-speak greeting — wait for user to initiate
  }

  // ─── Event bus ───────────────────────────────────────────
  /**
   * Fire a named event to trigger Tomte messages from your app code.
   * 
   * window.Tomte.event('comms:check', { total: 379, reached: 193, missing: 186 })
   * window.Tomte.event('comms:sent', { count: 186 })
   * window.Tomte.event('comms:error', { message: '...' })
   * window.Tomte.event('member:saved', { name: 'Anna' })
   * window.Tomte.event('upload:complete', { filename: 'practice.mp3' })
   */
  function event(name, data) {
    data = data || {};

    const events = {
      // ── Comms events ──
      'comms:check': () => {
        const { total, reached, missing } = data;
        if (missing === 0) {
          say(`All ${total} recipients have been reached. Nothing missing.`);
        } else {
          ask(
            `${reached} of ${total} already received this message. ${missing} still haven't been reached — shall I send to them now?`,
            [
              {
                label: 'Send to remaining ' + missing,
                primary: true,
                spinner: true,
                action: (btn) => {
                  document.dispatchEvent(new CustomEvent('tomte:retry-comms'));
                }
              },
              {
                label: 'Leave it for now',
                action: () => {
                  say("No problem. I'll be here when you're ready.");
                  clearActions();
                }
              }
            ]
          );
        }
      },

      'comms:sending': () => {
        say(`Sending to ${data.count || 'the remaining recipients'} now. I'll let you know when it's done.`);
      },

      'comms:sent': () => {
        const c = data.count;
        say(`Done. ${c ? c + (c === 1 ? ' message sent.' : ' messages sent.') : 'All sent.'} Everyone has been reached.`);
      },

      'comms:error': () => {
        say(`Something went wrong with the send: ${data.message || 'unknown error'}. Worth trying again, or check the logs.`);
      },

      // ── Member events ──
      'member:saved': () => {
        say(`${data.name ? data.name + ' has' : 'Member'} been saved.`);
      },

      'member:deleted': () => {
        say(`${data.name ? data.name + ' has' : 'Member'} been removed.`);
      },

      // ── Upload events ──
      'upload:complete': () => {
        say(`"${data.filename || 'File'}" uploaded successfully.`);
      },

      'upload:error': () => {
        say(`Upload failed${data.filename ? ' for "' + data.filename + '"' : ''}. Check the file and try again.`);
      },

      // ── Password events ──
      'password:reset': () => {
        say(`Password reset email sent to ${data.email || 'the member'}.`);
      },

      // ── Generic ──
      'success': () => {
        say(data.message || 'Done.');
      },

      'error': () => {
        say(data.message || 'Something went wrong. Worth trying again.');
      },

      'info': () => {
        say(data.message || '');
      }
    };

    const handler = events[name];
    if (handler) {
      if (!isOpen) showDot('!');
      open();
      handler();
    } else {
      console.warn('[Tomte] Unknown event:', name);
    }
  }

  // ─── Event listeners ─────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {

    // Character click
    document.getElementById('tomte-character').addEventListener('click', () => {
      isOpen ? close() : open();
    });

    // Close button
    document.getElementById('tomte-close').addEventListener('click', (e) => {
      e.stopPropagation();
      close();
    });

    // Mute button
    document.getElementById('tomte-mute').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMute();
    });

    // Send button
    document.getElementById('tomte-send').addEventListener('click', () => {
      const val = inputEl().value.trim();
      if (!val) return;
      inputEl().value = '';
      askClaude(val);
    });

    // Enter key in input
    inputEl().addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const val = inputEl().value.trim();
        if (!val) return;
        inputEl().value = '';
        askClaude(val);
      }
    });

    // Mic button - tap to start, tap again to stop
    document.getElementById('tomte-mic').addEventListener('click', () => {
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    });

    // Restore mute state from session
    if (isMuted) toggleMute(); // apply the visual state

  });

  // ─── Public API ──────────────────────────────────────────
  window.Tomte = { say, ask, event, open, close };

})();
