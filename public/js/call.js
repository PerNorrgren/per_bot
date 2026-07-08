// ── call.js (Per Bot 12) ──
// Shared 1:1 video/audio call widget for facilitator <-> client sessions.
// Media flows directly between the two browsers (WebRTC) once connected;
// this file only handles the signaling handshake (via /call, a plain
// relay WebSocket — see server.js), the call UI overlay, the client's
// recording-consent prompt, and — facilitator side only — recording the
// call and uploading it afterward.
//
// Usage:
//   Facilitator page: window.PerBotCall.startAsFacilitator(clientId, clientName)
//   Client page:       window.PerBotCall.watchForIncomingCalls() — call once on page load;
//                       polls quietly and shows an incoming-call banner on its own.
//
// Known limitation (v1): the recording is composed and held in the
// facilitator's browser for the whole call, then uploaded once at the
// end — a crashed tab or lost connection mid-call loses that session's
// recording (the call itself isn't affected, only the recording). A
// chunked/incremental upload would close that gap but is a meaningfully
// bigger lift; worth revisiting if a lost recording actually happens in
// practice.
(function () {
  const STYLE = `
    #pbcall-overlay {
      position: fixed; inset: 0; z-index: 100050; background: #0a0f0d;
      display: none; flex-direction: column; font-family: Georgia, serif;
    }
    #pbcall-overlay.pbcall-open { display: flex; }
    #pbcall-stage { flex: 1; position: relative; min-height: 0; background: #050806; }
    #pbcall-remote { width: 100%; height: 100%; object-fit: contain; background: #000; }
    #pbcall-local {
      position: absolute; right: 16px; bottom: 16px; width: 120px; height: 90px;
      object-fit: cover; border-radius: 10px; border: 1px solid rgba(255,255,255,0.2);
      background: #000; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    }
    #pbcall-status {
      position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
      color: rgba(255,255,255,0.8); font-size: 13px; background: rgba(0,0,0,0.45);
      padding: 6px 16px; border-radius: 20px; letter-spacing: 0.03em;
    }
    #pbcall-rec-dot {
      display: none; align-items: center; gap: 6px; position: absolute; top: 16px; right: 16px;
      color: rgba(255,150,140,0.95); font-size: 12px; background: rgba(0,0,0,0.45);
      padding: 6px 12px; border-radius: 20px;
    }
    #pbcall-rec-dot.pbcall-active { display: flex; }
    #pbcall-rec-dot .pbcall-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: pbcall-pulse 1.1s ease-in-out infinite; }
    @keyframes pbcall-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
    #pbcall-controls {
      flex-shrink: 0; display: flex; align-items: center; justify-content: center; gap: 14px;
      padding: 18px; background: rgba(255,255,255,0.03); border-top: 1px solid rgba(255,255,255,0.08);
    }
    .pbcall-btn {
      width: 54px; height: 54px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.16);
      background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.85); font-size: 20px;
      display: flex; align-items: center; justify-content: center; cursor: pointer;
    }
    .pbcall-btn.pbcall-off { background: rgba(255,255,255,0.18); color: rgba(255,255,255,0.5); }
    .pbcall-btn.pbcall-end { background: rgba(255,90,80,0.85); border-color: rgba(255,90,80,0.9); color: #fff; }

    #pbcall-incoming-banner {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 100040;
      background: #141a17; border: 1px solid rgba(180,230,200,0.35); border-radius: 14px;
      padding: 14px 18px; display: none; align-items: center; gap: 14px; box-shadow: 0 10px 30px rgba(0,0,0,0.4);
      font-family: Georgia, serif; max-width: calc(100vw - 28px);
    }
    #pbcall-incoming-banner.pbcall-open { display: flex; }
    #pbcall-incoming-text { color: rgba(255,255,255,0.85); font-size: 14px; }
    #pbcall-incoming-btns { display: flex; gap: 8px; flex-shrink: 0; }
    .pbcall-mini-btn { padding: 7px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: none; color: rgba(255,255,255,0.7); font-size: 12px; cursor: pointer; font-family: Georgia, serif; }
    .pbcall-mini-btn.pbcall-accept { background: rgba(180,230,200,0.15); border-color: rgba(180,230,200,0.4); color: rgba(190,235,210,0.95); }
    .pbcall-mini-btn.pbcall-decline { background: rgba(255,120,100,0.12); border-color: rgba(255,120,100,0.35); color: rgba(255,160,145,0.9); }

    #pbcall-consent-overlay {
      position: fixed; inset: 0; z-index: 100060; background: rgba(0,0,0,0.65);
      display: none; align-items: center; justify-content: center; padding: 20px;
      font-family: Georgia, serif;
    }
    #pbcall-consent-overlay.pbcall-open { display: flex; }
    #pbcall-consent-box { background: #141a17; border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; padding: 24px; max-width: 380px; }
    #pbcall-consent-box h3 { font-weight: normal; font-size: 16px; color: rgba(255,255,255,0.88); margin-bottom: 10px; }
    #pbcall-consent-box p { font-size: 13.5px; color: rgba(255,255,255,0.55); line-height: 1.6; margin-bottom: 18px; }
    #pbcall-consent-btns { display: flex; gap: 10px; justify-content: flex-end; }
  `;

  function injectStyle() {
    if (document.getElementById('pbcall-style')) return;
    const s = document.createElement('style');
    s.id = 'pbcall-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function buildOverlay() {
    if (document.getElementById('pbcall-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'pbcall-overlay';
    overlay.innerHTML = `
      <div id="pbcall-stage">
        <video id="pbcall-remote" autoplay playsinline></video>
        <video id="pbcall-local" autoplay playsinline muted></video>
        <div id="pbcall-audio-placeholder" style="display:none; position:absolute; inset:0; align-items:center; justify-content:center; flex-direction:column; gap:10px; color:rgba(255,255,255,0.5)">
          <div style="font-size:48px">🎙️</div>
          <div style="font-size:13px" id="pbcall-audio-label">Audio call</div>
        </div>
        <div id="pbcall-status">Connecting…</div>
        <div id="pbcall-rec-dot"><span class="pbcall-dot"></span> Recording</div>
      </div>
      <div id="pbcall-controls">
        <button class="pbcall-btn" id="pbcall-mic-btn" title="Mute/unmute">🎙️</button>
        <button class="pbcall-btn" id="pbcall-cam-btn" title="Camera on/off">📷</button>
        <button class="pbcall-btn pbcall-end" id="pbcall-end-btn" title="End call">⏹</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const banner = document.createElement('div');
    banner.id = 'pbcall-incoming-banner';
    banner.innerHTML = `
      <div id="pbcall-incoming-text"></div>
      <div id="pbcall-incoming-btns">
        <button class="pbcall-mini-btn pbcall-decline" id="pbcall-decline-btn">Decline</button>
        <button class="pbcall-mini-btn pbcall-accept" id="pbcall-accept-btn">Accept</button>
      </div>
    `;
    document.body.appendChild(banner);

    const consent = document.createElement('div');
    consent.id = 'pbcall-consent-overlay';
    consent.innerHTML = `
      <div id="pbcall-consent-box">
        <h3 id="pbcall-consent-title">Record this session?</h3>
        <p id="pbcall-consent-body">Your facilitator would like to record this call so you both have it to refer back to. You can say no — the call will still go ahead either way.</p>
        <div id="pbcall-consent-btns">
          <button class="pbcall-mini-btn pbcall-decline" id="pbcall-consent-decline">No, don't record</button>
          <button class="pbcall-mini-btn pbcall-accept" id="pbcall-consent-accept">Yes, that's fine</button>
        </div>
      </div>
    `;
    document.body.appendChild(consent);
  }

  let state = null; // set fresh each call — see resetState()
  function resetState() {
    state = {
      callId: null, role: null, callType: 'video', ws: null, pc: null,
      localStream: null, remoteStream: null,
      recorder: null, recordedChunks: [], recordingStartedAt: null,
      audioCtx: null, canvasRafId: null,
      ended: false,
    };
  }
  resetState();

  async function getIceServers() {
    try {
      const res = await fetch('/api/ice-servers');
      const data = await res.json();
      return data.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
    } catch (e) {
      return [{ urls: 'stun:stun.l.google.com:19302' }];
    }
  }

  function setStatus(text) {
    const el = document.getElementById('pbcall-status');
    if (el) el.textContent = text;
  }

  function openOverlay() { document.getElementById('pbcall-overlay').classList.add('pbcall-open'); }
  function closeOverlay() { document.getElementById('pbcall-overlay').classList.remove('pbcall-open'); }

  function connectSignaling(callId) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/call?callId=${encodeURIComponent(callId)}`);
    return ws;
  }

  async function setupPeerConnection(iceServers, isCaller) {
    const pc = new RTCPeerConnection({ iceServers });
    state.remoteStream = new MediaStream();
    document.getElementById('pbcall-remote').srcObject = state.remoteStream;

    state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));

    pc.ontrack = (e) => { e.streams[0].getTracks().forEach(t => state.remoteStream.addTrack(t)); };
    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal({ type: 'ice-candidate', candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setStatus('Connected');
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') setStatus('Connection lost…');
    };
    return pc;
  }

  function sendSignal(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
  }

  async function handleSignal(msg) {
    const pc = state.pc;
    if (msg.type === 'ready' && state.role === 'facilitator') {
      // We're the fixed "caller" role — create and send the offer now that
      // both sides are present in the signaling room.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ type: 'offer', sdp: offer });
    } else if (msg.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: answer });
    } else if (msg.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } else if (msg.type === 'ice-candidate' && msg.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch (e) { /* benign if it arrives late */ }
    } else if (msg.type === 'peer-left') {
      setStatus('The other person left the call.');
      endCall({ remoteEnded: true });
    }
  }

  // ── Recording (facilitator side only, only once consent is granted) ──
  // Video calls: composites local + remote video onto a canvas (so the
  // recording is a single normal video file, not two separate tracks to
  // reconcile later) and mixes both audio tracks via the Web Audio API
  // into that same file. Audio calls: there's no video to composite, so
  // this just mixes the two audio tracks and records that directly —
  // same audio-mixing code either way, canvas step skipped entirely.
  function startRecording() {
    const isAudioOnly = state.callType === 'audio';
    let canvasStream = null;

    if (!isAudioOnly) {
      const localVideo = document.getElementById('pbcall-local');
      const remoteVideo = document.getElementById('pbcall-remote');
      const canvas = document.createElement('canvas');
      canvas.width = 960; canvas.height = 540;
      const ctx = canvas.getContext('2d');

      function draw() {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (remoteVideo.videoWidth) ctx.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);
        if (localVideo.videoWidth) {
          const pipW = 200, pipH = 150;
          ctx.drawImage(localVideo, canvas.width - pipW - 16, canvas.height - pipH - 16, pipW, pipH);
        }
        state.canvasRafId = requestAnimationFrame(draw);
      }
      draw();
      canvasStream = canvas.captureStream(25);
    }

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.audioCtx = audioCtx;
    const dest = audioCtx.createMediaStreamDestination();
    try { audioCtx.createMediaStreamSource(state.localStream).connect(dest); } catch (e) {}
    try { audioCtx.createMediaStreamSource(state.remoteStream).connect(dest); } catch (e) {}

    const combined = isAudioOnly
      ? new MediaStream([...dest.stream.getAudioTracks()])
      : new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mimeType = isAudioOnly
      ? (MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm')
      : (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm');
    state.recorder = new MediaRecorder(combined, { mimeType });
    state.recordedChunks = [];
    state.recorder.ondataavailable = (e) => { if (e.data.size) state.recordedChunks.push(e.data); };
    state.recorder.start(1000);
    state.recordingStartedAt = Date.now();
    document.getElementById('pbcall-rec-dot').classList.add('pbcall-active');
  }

  function stopRecordingAndGetBlob() {
    return new Promise((resolve) => {
      if (!state.recorder || state.recorder.state === 'inactive') { resolve(null); return; }
      const isAudioOnly = state.callType === 'audio';
      state.recorder.onstop = () => {
        if (state.canvasRafId) cancelAnimationFrame(state.canvasRafId);
        if (state.audioCtx) state.audioCtx.close().catch(() => {});
        const blob = new Blob(state.recordedChunks, { type: isAudioOnly ? 'audio/webm' : 'video/webm' });
        const durationSeconds = Math.round((Date.now() - state.recordingStartedAt) / 1000);
        resolve({ blob, durationSeconds });
      };
      state.recorder.stop();
    });
  }

  async function uploadRecording(callId, blob, durationSeconds) {
    try {
      const fd = new FormData();
      fd.append('file', blob, 'session.webm');
      fd.append('durationSeconds', String(durationSeconds));
      await fetch(`/api/calls/${callId}/recording`, { method: 'POST', body: fd });
    } catch (e) {
      console.error('[call] recording upload failed:', e);
    }
  }

  // ── Shared teardown ──
  async function endCall(opts) {
    opts = opts || {};
    if (state.ended) return;
    state.ended = true;

    let recordingResult = null;
    if (state.recorder && state.recorder.state !== 'inactive') {
      recordingResult = await stopRecordingAndGetBlob();
    }
    if (state.localStream) state.localStream.getTracks().forEach(t => t.stop());
    if (state.pc) state.pc.close();
    if (state.ws) state.ws.close();
    closeOverlay();

    if (!opts.remoteEnded) {
      fetch(`/api/calls/${state.callId}/end`, { method: 'PATCH' }).catch(() => {});
    }
    if (recordingResult && recordingResult.blob && recordingResult.blob.size > 0) {
      await uploadRecording(state.callId, recordingResult.blob, recordingResult.durationSeconds);
    }
    resetState();
  }

  function wireControls() {
    const micBtn = document.getElementById('pbcall-mic-btn');
    const camBtn = document.getElementById('pbcall-cam-btn');
    const endBtn = document.getElementById('pbcall-end-btn');
    micBtn.onclick = () => {
      const track = state.localStream.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      micBtn.classList.toggle('pbcall-off', !track.enabled);
    };
    camBtn.onclick = () => {
      const track = state.localStream.getVideoTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      camBtn.classList.toggle('pbcall-off', !track.enabled);
    };
    endBtn.onclick = () => endCall();
  }

  // ── Entry point: joining the actual call (both roles, once accepted) ──
  async function joinCall(callId, role, shouldRecord, callType) {
    injectStyle();
    buildOverlay();
    resetState();
    state.callId = callId;
    state.role = role;
    state.callType = callType === 'audio' ? 'audio' : 'video';
    const isAudioOnly = state.callType === 'audio';
    setStatus(isAudioOnly ? 'Getting microphone…' : 'Getting camera and microphone…');
    openOverlay();

    // Audio-only skips the camera entirely — no permission prompt for it,
    // no video track to send, and the stage shows a simple placeholder
    // instead of two video elements with nothing in them.
    document.getElementById('pbcall-remote').style.display = isAudioOnly ? 'none' : '';
    document.getElementById('pbcall-local').style.display = isAudioOnly ? 'none' : '';
    document.getElementById('pbcall-cam-btn').style.display = isAudioOnly ? 'none' : '';
    document.getElementById('pbcall-audio-placeholder').style.display = isAudioOnly ? 'flex' : 'none';

    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !isAudioOnly });
    } catch (e) {
      setStatus(isAudioOnly ? 'Could not access microphone.' : 'Could not access camera/microphone.');
      appAlert && appAlert(`Could not access your ${isAudioOnly ? 'microphone' : 'camera or microphone'} — check your browser permissions and try again.`);
      closeOverlay();
      resetState();
      return;
    }
    if (!isAudioOnly) document.getElementById('pbcall-local').srcObject = state.localStream;
    wireControls();

    const iceServers = await getIceServers();
    state.pc = await setupPeerConnection(iceServers, role === 'facilitator');

    setStatus('Waiting for the other person…');
    state.ws = connectSignaling(callId);
    state.ws.onmessage = (e) => { try { handleSignal(JSON.parse(e.data)); } catch (err) { console.error('[call] signal parse error', err); } };
    state.ws.onerror = () => setStatus('Connection error.');

    if (role === 'facilitator' && shouldRecord) {
      // Recording starts once media is actually flowing, not at connect
      // time — otherwise the composite would just be two blank frames
      // for however long the handshake takes.
      const waitForConnected = setInterval(() => {
        if (state.pc && state.pc.connectionState === 'connected') {
          clearInterval(waitForConnected);
          startRecording();
        }
        if (state.ended) clearInterval(waitForConnected);
      }, 500);
    }
  }

  // ── Facilitator entry point ──
  async function startAsFacilitator(clientId, clientName, callType) {
    injectStyle();
    buildOverlay();
    const type = callType === 'audio' ? 'audio' : 'video';
    let call;
    try {
      const res = await fetch('/api/facilitator/calls', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, callType: type }),
      });
      call = await res.json();
      if (!call.id) throw new Error(call.error || 'Could not start the call.');
    } catch (e) {
      appAlert && appAlert('Could not start the call right now — please try again.');
      return;
    }

    setStatus(`Calling ${clientName || 'client'}…`);
    openOverlay();
    document.getElementById('pbcall-rec-dot').classList.remove('pbcall-active');
    let activeSeenAt = null;

    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/facilitator/calls/${call.id}`);
        const updated = await res.json();
        if (updated.status === 'active') {
          // The client answers the consent prompt as a separate step right
          // after accepting — recording_consent can still be null for a
          // few seconds after status flips to 'active'. Give it a short
          // window rather than locking in "don't record" the instant we
          // see 'active', which would otherwise race the client's own
          // decision. After 15s with no answer, proceed without recording
          // — the safe default is never recording without an explicit yes.
          if (updated.recording_consent === null) {
            if (!activeSeenAt) activeSeenAt = Date.now();
            if (Date.now() - activeSeenAt < 15000) return;
          }
          clearInterval(poll);
          const shouldRecord = updated.recording_consent === 'granted';
          joinCall(call.id, 'facilitator', shouldRecord, type);
        } else if (updated.status === 'declined') {
          clearInterval(poll);
          setStatus(`${clientName || 'They'} declined the call.`);
          setTimeout(closeOverlay, 2000);
        } else if (updated.status === 'ended') {
          clearInterval(poll);
          closeOverlay();
        }
      } catch (e) { /* keep polling — a transient network hiccup shouldn't cancel a call attempt */ }
    }, 1500);

    document.getElementById('pbcall-end-btn').onclick = () => {
      clearInterval(poll);
      fetch(`/api/calls/${call.id}/end`, { method: 'PATCH' }).catch(() => {});
      closeOverlay();
    };
  }

  // ── Client entry point — quietly polls for an incoming call ──
  let _incomingPoll = null;
  function watchForIncomingCalls() {
    if (_incomingPoll) return; // already watching
    injectStyle();
    buildOverlay();
    _incomingPoll = setInterval(async () => {
      if (state.callId) return; // already on a call, or handling one
      try {
        const res = await fetch('/api/client/calls/incoming');
        const data = await res.json();
        if (data.call) showIncomingBanner(data.call);
      } catch (e) { /* quiet — same tolerance as the messages poll */ }
    }, 4000);
  }

  function showIncomingBanner(call) {
    const banner = document.getElementById('pbcall-incoming-banner');
    const kind = call.call_type === 'audio' ? 'an audio' : 'a video';
    document.getElementById('pbcall-incoming-text').textContent = `${call.facilitatorName || 'Your facilitator'} is calling — ${kind} call…`;
    banner.classList.add('pbcall-open');

    const cleanup = () => banner.classList.remove('pbcall-open');

    document.getElementById('pbcall-decline-btn').onclick = async () => {
      cleanup();
      fetch(`/api/calls/${call.id}/respond`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accept: false }),
      }).catch(() => {});
    };
    document.getElementById('pbcall-accept-btn').onclick = async () => {
      cleanup();
      try {
        await fetch(`/api/calls/${call.id}/respond`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accept: true }),
        });
      } catch (e) { return; }
      showConsentPrompt(call.id, call.call_type);
    };
  }

  function showConsentPrompt(callId, callType) {
    const overlay = document.getElementById('pbcall-consent-overlay');
    overlay.classList.add('pbcall-open');
    document.getElementById('pbcall-consent-decline').onclick = async () => {
      overlay.classList.remove('pbcall-open');
      await fetch(`/api/calls/${callId}/consent`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ granted: false }),
      }).catch(() => {});
      joinCall(callId, 'client', false, callType);
    };
    document.getElementById('pbcall-consent-accept').onclick = async () => {
      overlay.classList.remove('pbcall-open');
      await fetch(`/api/calls/${callId}/consent`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ granted: true }),
      }).catch(() => {});
      joinCall(callId, 'client', false, callType); // client never records its own copy — facilitator's browser does
    };
  }

  window.PerBotCall = { startAsFacilitator, watchForIncomingCalls };
})();
