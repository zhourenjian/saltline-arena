// Spectator voice: push-to-talk capture and playback of other spectators' clips.
//
// Privacy: the microphone is requested only when the player presses the talk key or button,
// through the browser's own permission prompt (getUserMedia). It is never opened in the
// background, and the tracks are stopped as soon as the clip ends, so the browser's recording
// indicator goes away. Audio is sent as 8 kHz 8-bit µ-law in ~250 ms chunks, only while the
// server has granted the mic (at most BRAWL_RULES.micSeconds). Nothing is recorded or stored.
import { BRAWL_RULES, muLawEncode, muLawDecode } from "./rules.js";

var VOICE = {
  chunkSeconds: 0.25,
  jitterSeconds: 0.15, // playback starts this far behind the first chunk
};

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
  return btoa(s);
}

function fromBase64(text) {
  let s = atob(text),
    out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// the microphone API exists only on secure pages: https://, or http://localhost / 127.0.0.1.
// A game opened as http://<LAN address> can listen to voice but cannot record.
function canRecord() {
  return !!(globalThis.isSecureContext !== !1 && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}
function recordProblem() {
  if (globalThis.isSecureContext === !1)
    return `the browser only allows the microphone on https:// pages or pages opened from this same computer (this page is ${location.protocol}//${location.host})`;
  return "this browser cannot record audio";
}

// iPhone / iPad (an iPad can pose as a Mac)
var onIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);

function createVoice({ rate = BRAWL_RULES.voiceRate } = {}) {
  let ctx = null,
    capture = null, // { stream, source, node, buf, fill, acc, accN, step, onChunk }
    players = new Map(), // msg id → { next, gain }
    prevSession = null, // navigator.audioSession.type before the recording (iOS Safari)
    volume = 1;

  function audio() {
    if (!ctx) {
      let AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    ctx.state === "suspended" && ctx.resume().catch(() => {});
    return ctx;
  }

  // Autoplay policy: an AudioContext made outside a click or key press starts "suspended", and
  // resume() only works inside one. Clips from other people arrive from the network, never in a
  // gesture, so the page calls unlock() on every click / key press while in the brawl.
  function unlock() {
    let ac = audio();
    return !!ac && ac.state === "running";
  }

  // ---- capture
  async function start(onChunk) {
    stop();
    if (!canRecord()) throw new Error(recordProblem());
    // iOS: asking for echo cancellation / noise suppression turns on the system's voice-processing
    // unit for the whole page, which leaves every sound hissy and quiet, and it stays that way after
    // the recording stops. So on iOS ask for the raw microphone, and put the audio session in
    // play-and-record only while talking.
    let ios = onIOS(),
      session = navigator.audioSession;
    if (session && ios && !prevSession) {
      try {
        prevSession = session.type;
        session.type = "play-and-record";
      } catch {}
    }
    let stream = await navigator.mediaDevices.getUserMedia({
      audio: ios
        ? { channelCount: 1, echoCancellation: !1, noiseSuppression: !1, autoGainControl: !1 }
        : { channelCount: 1, echoCancellation: !0, noiseSuppression: !0, autoGainControl: !0 },
      video: !1,
    }).catch((e) => {
      restoreSession();
      throw e;
    });
    let ac = audio();
    if (!ac) throw (stream.getTracks().forEach((t) => t.stop()), new Error("no Web Audio"));
    let source = ac.createMediaStreamSource(stream),
      // ScriptProcessor is deprecated but universally available and needs no extra module file
      node = ac.createScriptProcessor(4096, 1, 1),
      chunk = Math.round(rate * VOICE.chunkSeconds),
      c = {
        stream,
        source,
        node,
        buf: new Uint8Array(chunk),
        fill: 0,
        acc: 0,
        accN: 0,
        // input samples per output sample
        step: ac.sampleRate / rate,
        phase: 0,
        onChunk,
      };
    node.onaudioprocess = (e) => {
      if (capture !== c) return;
      let input = e.inputBuffer.getChannelData(0);
      // box-filter downsample to `rate`
      for (let i = 0; i < input.length; i++) {
        c.acc += input[i];
        c.accN++;
        c.phase += 1;
        if (c.phase >= c.step) {
          c.phase -= c.step;
          c.buf[c.fill++] = muLawEncode(c.acc / c.accN);
          c.acc = c.accN = 0;
          if (c.fill === c.buf.length) flush(c);
        }
      }
      // silence the processor's own output
      e.outputBuffer.getChannelData(0).fill(0);
    };
    source.connect(node);
    // a ScriptProcessor only runs while connected to the destination; its output is silent
    node.connect(ac.destination);
    capture = c;
  }

  function flush(c) {
    if (!c.fill) return;
    let bytes = c.buf.slice(0, c.fill);
    c.fill = 0;
    try {
      c.onChunk(toBase64(bytes));
    } catch {}
  }

  function stop() {
    let c = capture;
    if (!c) return;
    capture = null;
    flush(c);
    try {
      (c.node.disconnect(), c.source.disconnect());
    } catch {}
    c.stream.getTracks().forEach((t) => t.stop());
    restoreSession();
  }

  function restoreSession() {
    if (prevSession === null) return;
    try {
      navigator.audioSession.type = prevSession;
    } catch {}
    prevSession = null;
  }

  // ---- playback
  // returns false when the clip could not be played (no Web Audio, or audio still locked)
  function play(msg, data) {
    let ac = audio();
    if (!ac) return !1;
    // still locked: a clip scheduled now would play late in one burst after the unlock
    if (ac.state !== "running") return !1;
    let bytes;
    try {
      bytes = fromBase64(data);
    } catch {
      return;
    }
    if (!bytes.length) return;
    let buffer = ac.createBuffer(1, bytes.length, rate),
      ch = buffer.getChannelData(0);
    for (let i = 0; i < bytes.length; i++) ch[i] = muLawDecode(bytes[i]);
    let p = players.get(msg);
    if (!p) {
      let gain = ac.createGain();
      gain.gain.value = volume;
      gain.connect(ac.destination);
      p = { next: 0, gain, last: 0 };
      players.set(msg, p);
    }
    let src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(p.gain);
    let at = Math.max(p.next, ac.currentTime + VOICE.jitterSeconds);
    src.start(at);
    p.next = at + buffer.duration;
    p.last = ac.currentTime;
    // forget finished clips
    for (let [id, q] of players) ac.currentTime - q.last > 15 && (q.gain.disconnect(), players.delete(id));
    return !0;
  }

  return {
    start,
    stop,
    play,
    unlock,
    get unlocked() {
      return !!ctx && ctx.state === "running";
    },
    // muted message ids stop playing at once
    silence(msg) {
      let p = players.get(msg);
      p && (p.gain.gain.value = 0);
    },
    get capturing() {
      return !!capture;
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, +v || 0));
      for (let p of players.values()) p.gain.gain.value = volume;
    },
    dispose() {
      stop();
      for (let p of players.values())
        try {
          p.gain.disconnect();
        } catch {}
      players.clear();
      ctx && ctx.close().catch(() => {});
      ctx = null;
    },
  };
}

export { createVoice, canRecord, recordProblem, toBase64, fromBase64, VOICE };
