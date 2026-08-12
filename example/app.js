/*
 * Webphone call client. Connects to livekit-client and to the token-service
 * in this repo.
 *
 * The token-service has no auth, so `continuity_key` is sent directly from
 * the browser rather than derived server-side — see token-service/main.py.
 */
(function () {
  "use strict";

  const TOKEN_SERVICE_URL = "http://localhost:8080/call";
  const SDK_URL =
    "https://cdn.jsdelivr.net/npm/livekit-client@2.21.0/dist/livekit-client.umd.min.js";

  const S = {
    room: null,
    status: "idle",
    detail: "",
    meters: {},
    raf: null,
    userHungUp: false,
    speaking: { agent: false, you: false },
    agentAudio: false,
    device: "",
    quality: "",
  };

  // Meter ballistics — what a meter's perceived lag actually comes from.
  const GAIN = 2.6; // tune by eye on a real call: too low reads dead, too high pins
  const DECAY = 0.04; // per frame; instant rise, ~0.4s fall. Symmetric looks late both ways
  const SPEAKING_LEVEL = 0.06;

  const LABELS = {
    idle: "Idle",
    connecting: "Connecting…",
    connected: "Connected",
    ended: "Call ended",
    error: "Error",
  };

  const root = document.querySelector(".wp-root");
  const audioEl = document.getElementById("agent-audio");

  function el(role) {
    return root.querySelector(`[data-role="${role}"]`);
  }

  function text(role, value) {
    const node = el(role);
    if (node) node.textContent = value;
  }

  function pill(role, label, active) {
    const node = el(role);
    if (!node) return;
    node.textContent = label;
    node.dataset.active = active ? "1" : "0";
  }

  function glow(role, active) {
    const node = el("avatar-" + role);
    if (node) node.dataset.speaking = active ? "1" : "0";
  }

  function muted() {
    return !!S.room && !S.room.localParticipant.isMicrophoneEnabled;
  }

  function render() {
    const connected = S.status === "connected";
    const off = muted();
    root.dataset.status = S.status; // drives whether the call surface shows at all

    text("status", (LABELS[S.status] || S.status) + (S.detail ? " — " + S.detail : ""));

    let agentState = "Idle";
    if (connected) {
      agentState = !S.agentAudio ? "No audio" : S.speaking.agent ? "Speaking" : "Listening";
    }
    pill("agent-state", agentState, S.speaking.agent);
    pill("mic-state", off ? "Mic off" : connected ? "Mic on" : "Mic idle", !off && connected);

    glow("agent", S.speaking.agent);
    glow("you", S.speaking.you && !off);

    text("quality", S.quality || "—");
    text("device", S.device || "—");

    const callBtn = document.getElementById("call");
    if (callBtn) callBtn.disabled = connected || S.status === "connecting";

    const mute = el("mute");
    if (mute) {
      mute.textContent = off ? "🔇" : "🎙️";
      mute.dataset.on = off ? "1" : "0";
      mute.title = off ? "Unmute" : "Mute";
      mute.disabled = !connected;
    }
    const hang = el("hangup");
    if (hang) hang.disabled = S.status === "idle" || S.status === "ended" || S.status === "error";

    // Autoplay is blocked until the tab has audio permission; without this escape
    // hatch the call connects silently one-way.
    const cta = el("audio");
    if (cta) cta.style.display = S.room && S.room.canPlaybackAudio === false ? "" : "none";
  }

  function fail(detail) {
    S.status = "error";
    S.detail = detail;
    stopMeters();
    render();
  }

  function describe(err) {
    if (err && err.name === "NotAllowedError") return "microphone permission denied";
    if (err && err.name === "NotFoundError") return "no microphone found";
    return (err && err.message) || String(err);
  }

  let sdkPromise = null;
  function loadSdk() {
    if (window.LivekitClient) return Promise.resolve();
    if (!sdkPromise) {
      sdkPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = SDK_URL;
        s.onload = resolve;
        s.onerror = () => reject(new Error("could not load the WebRTC SDK"));
        document.head.appendChild(s);
      });
    }
    return sdkPromise;
  }

  /* A local tap on the track, never connected to the destination, so it cannot
     double-play the agent or echo the mic back. Not ActiveSpeakersChanged: that
     arrives from the server on its own interval, well behind the audio. */
  function attachMeter(role, track) {
    stopMeter(role);
    try {
      S.meters[role] = {
        // Off the SDK defaults: 0.8 smoothing averages away the attack, and a
        // -100..-80 window is 20dB wide, so ordinary speech saturates it.
        audio: window.LivekitClient.createAudioAnalyser(track, {
          fftSize: 256,
          smoothingTimeConstant: 0.2,
          minDecibels: -85,
          maxDecibels: -25,
        }),
        level: 0,
      };
    } catch {
      return; // no AudioContext — the call still works, only the meters go dark
    }
    if (S.raf === null) S.raf = requestAnimationFrame(paint);
  }

  function paint() {
    S.raf = null;
    const roles = Object.keys(S.meters);
    if (!roles.length) return;
    roles.forEach((role) => {
      const meter = S.meters[role];
      const level = Math.min(1, meter.audio.calculateVolume() * GAIN);
      meter.level = Math.max(level, meter.level - DECAY);

      const bar = el("level-" + role);
      if (bar) bar.style.width = Math.round(meter.level * 100) + "%";

      const speaking = meter.level > SPEAKING_LEVEL;
      if (speaking !== S.speaking[role]) {
        S.speaking[role] = speaking;
        render();
      }
    });
    S.raf = requestAnimationFrame(paint);
  }

  function stopMeter(role) {
    const meter = S.meters[role];
    if (!meter) return;
    meter.audio.cleanup();
    delete S.meters[role];
    S.speaking[role] = false;
    const bar = el("level-" + role);
    if (bar) bar.style.width = "0%";
  }

  function stopMeters() {
    Object.keys(S.meters).forEach(stopMeter);
  }

  async function fetchCredential() {
    const continuityInput = document.getElementById("continuity");
    const res = await fetch(TOKEN_SERVICE_URL, {
      method: "POST",
      credentials: "omit", // the token-service has no session for a cookie to join
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ continuity_key: continuityInput.value || null }),
    });
    if (!res.ok) throw new Error(`token-service returned ${res.status}`);
    return res.json();
  }

  async function placeCall() {
    if (S.room) return; // Call is disabled while connected/connecting; belt and suspenders.
    S.status = "connecting";
    S.detail = "";
    S.userHungUp = false;
    render();

    if (!window.isSecureContext) {
      fail("microphone access needs HTTPS (or localhost)");
      return;
    }

    let credential;
    try {
      credential = await fetchCredential();
    } catch (err) {
      fail(describe(err));
      return;
    }

    try {
      await loadSdk();
    } catch (err) {
      fail(describe(err));
      return;
    }

    const LK = window.LivekitClient;
    const room = new LK.Room({ adaptiveStream: true, dynacast: true });
    S.room = room;

    /* Handlers close over `room` but write to the shared `S`, and a replaced room
       keeps emitting — a new call disconnects the old one, whose Disconnected
       lands after placeCall() has reset state. Dropping events from a room that
       is no longer live is what stops "Connected — connection lost". */
    function on(event, handler) {
      room.on(event, (...args) => {
        if (S.room !== room) return;
        handler(...args);
      });
    }

    on(LK.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== "audio") return;
      track.attach(audioEl);
      attachMeter("agent", track);
      S.agentAudio = true;
      render();
    });
    on(LK.RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind !== "audio") return;
      stopMeter("agent");
      S.agentAudio = false;
      render();
    });
    // Also fires on republish after unmute, so the meter never watches a track
    // the SDK has replaced.
    on(LK.RoomEvent.LocalTrackPublished, (pub) => {
      if (pub.kind !== "audio" || !pub.track) return;
      S.device = pub.track.mediaStreamTrack.label || "Default microphone";
      attachMeter("you", pub.track);
      render();
    });
    // Muting unpublishes the mic track; don't leave an analyser on a dead one.
    on(LK.RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.kind === "audio") stopMeter("you");
      render();
    });
    on(LK.RoomEvent.TrackMuted, render);
    on(LK.RoomEvent.TrackUnmuted, render);
    on(LK.RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      // A string enum ("excellent"/"good"/…). Show nothing rather than a
      // meaningless integer if a version hands back a raw number.
      if (participant && participant.isLocal) {
        S.quality = typeof quality === "string" ? quality : "";
        render();
      }
    });
    on(LK.RoomEvent.Reconnecting, () => {
      if (S.status === "connected") {
        S.status = "connecting";
        S.detail = "reconnecting";
        render();
      }
    });
    on(LK.RoomEvent.Reconnected, () => {
      S.status = "connected";
      S.detail = "";
      render();
    });
    on(LK.RoomEvent.Disconnected, (reason) => {
      stopMeters();
      S.agentAudio = false;
      S.room = null;
      // An error already on screen is the better message; this is its consequence.
      if (S.status === "error") {
        render();
        return;
      }
      if (S.userHungUp || reason === LK.DisconnectReason.CLIENT_INITIATED) {
        // A hangup we asked for has nothing left to show — back to a clean slate,
        // which is also what hides the tiles and dock again.
        S.status = "idle";
        S.detail = "";
      } else {
        S.status = "ended";
        // ROOM_DELETED is overwhelmingly the pipeline's idle timeout (90s, and
        // only speech resets it), so name the likely cause, not "room deleted".
        S.detail =
          reason === LK.DisconnectReason.ROOM_DELETED
            ? "session ended by the agent or idle timeout"
            : "connection lost";
      }
      render();
    });
    on(LK.RoomEvent.AudioPlaybackStatusChanged, render);

    // Guarded like the handlers: getUserMedia can sit on a permission prompt long
    // enough for this room to be replaced before the chain settles.
    try {
      await room.connect(credential.url, credential.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      if (S.room !== room) return;
      S.status = "connected";
      S.detail = "";
      render();
    } catch (err) {
      room.disconnect();
      if (S.room === room) {
        S.room = null;
        fail(describe(err));
      }
    }
  }

  function toggleMute() {
    if (!S.room) return;
    const local = S.room.localParticipant;
    local.setMicrophoneEnabled(!local.isMicrophoneEnabled).then(render, render);
  }

  function hangup() {
    S.userHungUp = true;
    if (S.room) S.room.disconnect();
  }

  document.getElementById("call").addEventListener("click", placeCall);
  document.getElementById("new-key").addEventListener("click", () => {
    document.getElementById("continuity").value = crypto.randomUUID();
  });
  el("mute").addEventListener("click", toggleMute);
  el("hangup").addEventListener("click", hangup);
  el("audio").addEventListener("click", () => {
    if (S.room) S.room.startAudio().then(render, render);
  });

  document.getElementById("continuity").value = crypto.randomUUID();
  render();
})();
