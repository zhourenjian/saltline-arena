// 1v1 duel client: one WebSocket to the relay (server/duel-server.mjs), JSON messages {t, ...}.
// The page only ever connects to the address the player typed (or ?server=); nothing else.
import { DUEL_PROTOCOL, DUEL_RULES, sanitizeName } from "./rules.js";
import { openUdp, rtcWanted } from "./rtc.js";

var VERSUS_KEY = "saltline.versus.v1";

var OFFICIAL_SERVER = "wss://saltline.kakoola.com/ws";

function defaultServerUrl(loc = location) {
  let host = loc.hostname,
    secure = loc.protocol === "https:";
  if (!host) return "";
  // the official game server; github.io copies of the page play there too
  if (/(^|\.)github\.io$/.test(host)) return OFFICIAL_SERVER;
  // an https site on the default port is served behind a reverse proxy that forwards /ws
  if (secure && !loc.port && host.includes(".") && !/^[\d.]+$/.test(host) && !host.includes(":")) return `wss://${host}/ws`;
  return `${secure ? "wss" : "ws"}://${host.includes(":") ? `[${host}]` : host}:8787`;
}

// "host:port", "ws://…", "wss://…", "http(s)://…" → a ws(s) URL, or null
function normalizeServerUrl(text) {
  let s = String(text || "").trim();
  if (!s) return null;
  /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || (s = `${location.protocol === "https:" ? "wss" : "ws"}://${s}`);
  try {
    let u = new URL(s);
    u.protocol === "http:" && (u.protocol = "ws:");
    u.protocol === "https:" && (u.protocol = "wss:");
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    return (u.hash = ""), u.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function loadVersusPrefs() {
  try {
    let v = JSON.parse(localStorage.getItem(VERSUS_KEY) || "null");
    if (v && typeof v == "object")
      return {
        server: typeof v.server == "string" ? v.server.slice(0, 200) : "",
        name: typeof v.name == "string" ? sanitizeName(v.name) : "",
      };
  } catch {}
  return { server: "", name: "" };
}

function saveVersusPrefs(p) {
  try {
    localStorage.setItem(VERSUS_KEY, JSON.stringify({ server: p.server || "", name: p.name || "" }));
  } catch {}
}

// connect(url, {name, avatar}) → Promise<client>; resolves after "welcome".
// client: { id, url, features, rtt, on(type, fn) → off, send(t, data), close(), get open }
// rtt is the round trip to the server in ms (ping every PING_SECONDS, smoothed), null until known.
var PING_SECONDS = 2;
var REPORT_SECONDS = 30; // how often a client reports its ping summary to the server (for diagnosing mobile links)
function connectDuel(url, hello, { timeoutMs = 6000, WebSocketImpl = globalThis.WebSocket } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocketImpl !== "function") return reject(new Error("this browser has no WebSocket"));
    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch (e) {
      return reject(new Error(`bad server address: ${(e && e.message) || e}`));
    }
    let handlers = new Map(),
      settled = !1,
      closed = !1,
      client = {
        id: null,
        url,
        rules: null,
        features: [],
        rtt: null,
        get transport() {
          return udp && udp.open ? "udp" : "ws";
        },
        // summary of the last ~30 s of pings (ms): total, network part, time queued behind our own main thread
        pingStats() {
          if (!samples.length) return null;
          let ms = samples.map((x) => x.ms).sort((a, b) => a - b),
            max = (k) => Math.round(Math.max(...samples.map((x) => x[k])));
          let u = usamples.slice().sort((a, b) => a - b),
            lost = Math.max(0, usent - u.length);
          return {
            udp: udp && udp.open ? 1 : 0,
            un: u.length,
            uavg: u.length ? Math.round(u.reduce((a, b) => a + b, 0) / u.length) : 0,
            umax: u.length ? Math.round(u[u.length - 1]) : 0,
            uloss: usent ? Math.round((lost * 100) / usent) : 0,
            n: ms.length,
            avg: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length),
            p95: Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))]),
            max: Math.round(ms[ms.length - 1]),
            netMax: max("net"),
            lagMax: max("lag"),
            over200: ms.filter((x) => x > 200).length,
          };
        },
        get open() {
          return !closed && ws.readyState === 1;
        },
        on(type, fn) {
          handlers.has(type) || handlers.set(type, new Set());
          handlers.get(type).add(fn);
          return () => handlers.get(type).delete(fn);
        },
        send(t, data = {}) {
          if (closed || ws.readyState !== 1) return !1;
          let text = JSON.stringify({ ...data, t });
          if (text.length > DUEL_RULES.maxMessageBytes) return !1;
          // poses (and the UDP ping) go over the data channel when there is one; losing one is fine
          if ((t === "state" || t === "br.state") && udp && udp.send(text)) return !0;
          return (ws.send(text), !0);
        },
        close(code = 1000, reason = "bye") {
          if (closed) return;
          closed = !0;
          clearInterval(pinger);
          udp && udp.close();
          try {
            ws.close(code, reason);
          } catch {}
          fire("close", { code, reason, local: !0 });
        },
      },
      fire = (type, msg) => {
        for (let fn of [...(handlers.get(type) || [])])
          try {
            fn(msg);
          } catch (e) {
            console.error(`[versus] ${type} handler threw`, e);
          }
        for (let fn of [...(handlers.get("*") || [])])
          try {
            fn(msg, type);
          } catch {}
      },
      timer = setTimeout(() => fail(new Error(`no answer from ${url}`)), timeoutMs),
      pinger = 0,
      samples = [], // last ping samples: { ms, net, lag }
      usamples = [], // UDP ping round trips since the last report, ms
      usent = 0, // UDP pings sent since the last report
      udp = null,
      answers = new Set(),
      lastReport = performance.now(),
      report = () => {
        lastReport = performance.now();
        let s = client.pingStats();
        s && client.send("netstat", { ...s, via: (navigator.connection && navigator.connection.effectiveType) || null });
        usamples.length = usent = 0;
      },
      ping = () => {
        client.send("ping", { at: performance.now() });
        if (udp && udp.open) {
          usent++;
          udp.send(JSON.stringify({ t: "ping", at: performance.now(), u: 1 }));
        }
      },
      fail = (err) => {
        if (settled) return;
        ((settled = !0), clearTimeout(timer), (closed = !0));
        try {
          ws.close();
        } catch {}
        reject(err);
      };
    ws.onopen = () => client.send("hello", { v: DUEL_PROTOCOL, name: hello.name, avatar: hello.avatar ?? null });
    ws.onerror = () => fail(new Error(`could not connect to ${url}`));
    ws.onclose = (e) => {
      if (!settled) return fail(new Error(`connection to ${url} closed (${e.code})`));
      clearInterval(pinger);
      udp && udp.close();
      closed || ((closed = !0), fire("close", { code: e.code, reason: e.reason, local: !1 }));
    };
    ws.onmessage = (e) => handle(e.data, e);
    let handle = (data, e) => {
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (!m || typeof m.t != "string") return;
      if (!settled) {
        if (m.t === "error") return fail(Object.assign(new Error(m.message || m.code), { code: m.code }));
        if (m.t !== "welcome") return;
        ((settled = !0), clearTimeout(timer), (client.id = m.id), (client.rules = m.rules || null));
        client.features = Array.isArray(m.features) ? m.features.map(String) : ["duel"];
        (ping(), (pinger = setInterval(ping, PING_SECONDS * 1000)));
        try { globalThis.__saltlineNet = client; } catch {}
        client.features.includes("rtc") &&
          rtcWanted() &&
          (udp = openUdp({
            signal: (sdp) => client.send("rtc.offer", { sdp }),
            onAnswer: (fn) => (answers.add(fn), () => answers.delete(fn)),
            onText: (text, ev) => handle(text, ev),
          }));
        return resolve(client);
      }
      if (m.t === "rtc.answer") return void answers.forEach((fn) => fn(m.sdp));
      if (m.t === "pong" && m.u === 1) {
        let ms = performance.now() - +m.at;
        Number.isFinite(ms) && ms >= 0 && ms < 60000 && (usamples.push(ms), usamples.length > 100 && usamples.shift());
        return;
      }
      if (m.t === "pong") {
        let now = performance.now(),
          ms = now - +m.at;
        if (Number.isFinite(ms) && ms >= 0 && ms < 60000) {
          client.rtt = client.rtt == null ? ms : client.rtt * 0.6 + ms * 0.4;
          // ms: send → handled here. e.timeStamp: when the browser got the packet, so
          // (timeStamp - at) is the network part and (now - timeStamp) waited behind our own work
          let arrived = Number.isFinite(e.timeStamp) && e.timeStamp > +m.at && e.timeStamp <= now ? e.timeStamp : now;
          samples.push({ ms, net: arrived - +m.at, lag: now - arrived });
          samples.length > 15 && samples.shift();
          now - lastReport > REPORT_SECONDS * 1000 && samples.length >= 5 && report();
        }
      }
      fire(m.t, m);
    };
  });
}

export { connectDuel, defaultServerUrl, normalizeServerUrl, loadVersusPrefs, saveVersusPrefs, VERSUS_KEY };
