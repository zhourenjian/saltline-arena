// Spectator voice: push-to-talk capture and playback of other spectators' clips.
//
// Privacy: the microphone is requested only when the player presses the talk key or button,
// through the browser's own permission prompt (getUserMedia). It is never opened in the
// background, and the tracks are stopped as soon as the clip ends, so the browser's recording
// indicator goes away. Audio is sent as 8 kHz 8-bit µ-law in ~250 ms chunks, only while the
// server has granted the mic (at most BRAWL_RULES.micSeconds). Nothing is recorded or stored.
import { BRAWL_RULES, muLawEncode, muLawDecode } from "./rules.js";

var VOICE = {
  keepClips: 20, // the last N voice messages stay in memory so they can be played again
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
    clips = new Map(), // message id → [{ seq, data }] kept for replay, oldest first
    onEvict = null,
    prevSession = null, // navigator.audioSession.type before the recording (iOS Safari)
    volume = 1,
    level = 0, // recent microphone peak (0..1) before the auto gain
    playing = 0; // when the last clip is expected to end (audio-clock seconds)

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
    // iPhone: Web Audio is silenced by the ring/silent switch unless the page declares it is
    // playing media (iOS 17+); without this, clips from others are inaudible with the switch on
    try {
      onIOS() && navigator.audioSession && !capture && navigator.audioSession.type !== "playback" && (navigator.audioSession.type = "playback");
    } catch {}
    let ac = audio();
    return !!ac && ac.state === "running";
  }

  // ---- capture
  var MIC_KEY = "saltline.mic.v1";
  let savedInput = () => {
    try {
      return localStorage.getItem(MIC_KEY) || "";
    } catch {
      return "";
    }
  };
  // opts.deviceId: a specific microphone; opts.tried: device ids already found silent this talk
  async function start(onChunk, opts = {}) {
    stop();
    level = 0; // the previous talk's loudness says nothing about this microphone
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
    let want = opts.deviceId || (opts.tried ? "" : savedInput()),
      audioConstraints = ios
        ? { channelCount: 1, echoCancellation: !1, noiseSuppression: !1, autoGainControl: !1 }
        : { channelCount: 1, echoCancellation: !0, noiseSuppression: !0, autoGainControl: !0 };
    want && (audioConstraints.deviceId = { ideal: want });
    let stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
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
        gain: 1, // software auto gain: phones' raw microphones are often very quiet
        onChunk,
        deviceId: (stream.getAudioTracks()[0] && stream.getAudioTracks()[0].getSettings && stream.getAudioTracks()[0].getSettings().deviceId) || "",
        tried: new Set([...(opts.tried || [])]),
      };
    c.deviceId && c.tried.add(c.deviceId);
    node.onaudioprocess = (e) => {
      if (capture !== c) return;
      let input = e.inputBuffer.getChannelData(0),
        peak = 0;
      for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i]));
      level = Math.max(peak, level * 0.9);
      // bring speech to about 0.6 of full scale (at most 12x); do not pump up the background hiss
      if (peak > 0.004) {
        let want = Math.max(1, Math.min(12, 0.6 / peak));
        c.gain += (want - c.gain) * (want < c.gain ? 0.8 : 0.2);
      }
      // box-filter downsample to `rate`
      for (let i = 0; i < input.length; i++) {
        c.acc += input[i] * c.gain;
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

  // The browser's default microphone can be one that only delivers silence (a MacBook with the lid
  // closed, a disconnected headset, a muted Bluetooth device). Switch to the next input that has not
  // been tried in this talk; resolves to its name, or "" when there is none left.
  async function nextInput() {
    let c = capture;
    if (!c || !navigator.mediaDevices.enumerateDevices) return "";
    let list = [];
    try {
      list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "communications" && !c.tried.has(d.deviceId));
    } catch {}
    // "default" would just be the same device again
    let next = list.find((d) => d.deviceId !== "default") || list[0];
    if (!next || capture !== c) return "";
    let cb = c.onChunk;
    await start(cb, { deviceId: next.deviceId, tried: c.tried });
    return next.label || "another microphone";
  }

  // keep the microphone that produced sound, for the next time
  function rememberInput() {
    try {
      capture && capture.deviceId && localStorage.setItem(MIC_KEY, capture.deviceId);
    } catch {}
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
    playing = Math.max(playing, p.next);
    p.last = ac.currentTime;
    // forget finished clips
    for (let [id, q] of players) ac.currentTime - q.last > 15 && (q.gain.disconnect(), players.delete(id));
    return !0;
  }

  // ---- replay: every clip that was heard (or could not be, because audio was still locked) is kept
  function record(msg, seq, data) {
    if (!msg || typeof data != "string") return;
    let list = clips.get(msg);
    if (!list) {
      list = [];
      clips.set(msg, list);
      while (clips.size > VOICE.keepClips) {
        let old = clips.keys().next().value;
        clips.delete(old);
        onEvict && onEvict(old);
      }
    }
    list.push({ seq: seq | 0, data });
  }

  // plays a kept clip from the start. Call it from a click: that also unlocks the audio.
  async function playClip(msg) {
    let list = clips.get(msg);
    if (!list || !list.length) return !1;
    let ac = audio();
    if (!ac) return !1;
    try {
      ac.state !== "running" && (await ac.resume());
    } catch {}
    if (ac.state !== "running") return !1;
    let gain = ac.createGain(),
      at = ac.currentTime + 0.08;
    gain.gain.value = volume;
    gain.connect(ac.destination);
    for (let { data } of [...list].sort((a, b) => a.seq - b.seq)) {
      let bytes;
      try {
        bytes = fromBase64(data);
      } catch {
        continue;
      }
      if (!bytes.length) continue;
      let buffer = ac.createBuffer(1, bytes.length, rate),
        ch = buffer.getChannelData(0);
      for (let i = 0; i < bytes.length; i++) ch[i] = muLawDecode(bytes[i]);
      let src = ac.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      src.start(at);
      at += buffer.duration;
    }
    playing = Math.max(playing, at);
    return !0;
  }

  return {
    start,
    stop,
    play,
    record,
    playClip,
    nextInput,
    rememberInput,
    hasClip: (msg) => clips.has(msg),
    // a voice clip is sounding (or about to): the game turns its music down meanwhile
    get busy() {
      return !!ctx && ctx.currentTime < playing + 0.15;
    },
    get level() {
      return level;
    },
    // loudest sample of a kept clip (0..1), to tell a silent recording from a quiet one
    clipPeak(msg) {
      let peak = 0;
      for (let { data } of clips.get(msg) || []) for (let b of fromBase64(data)) peak = Math.max(peak, Math.abs(muLawDecode(b)));
      return peak;
    },
    get clipCount() {
      return clips.size;
    },
    set onEvict(fn) {
      onEvict = fn;
    },
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
      clips.clear();
      ctx && ctx.close().catch(() => {});
      ctx = null;
    },
  };
}

export { createVoice, canRecord, recordProblem, toBase64, fromBase64, VOICE };
