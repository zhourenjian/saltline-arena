// 1v1 duel client: one WebSocket to the relay (server/duel-server.mjs), JSON messages {t, ...}.
// The page only ever connects to the address the player typed (or ?server=); nothing else.
import { DUEL_PROTOCOL, DUEL_RULES, sanitizeName } from "./rules.js";

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
          return (ws.send(text), !0);
        },
        close(code = 1000, reason = "bye") {
          if (closed) return;
          closed = !0;
          clearInterval(pinger);
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
      ping = () => client.send("ping", { at: performance.now() }),
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
      closed || ((closed = !0), fire("close", { code: e.code, reason: e.reason, local: !1 }));
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
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
        return resolve(client);
      }
      if (m.t === "pong") {
        let ms = performance.now() - +m.at;
        Number.isFinite(ms) && ms >= 0 && ms < 60000 && (client.rtt = client.rtt == null ? ms : client.rtt * 0.6 + ms * 0.4);
      }
      fire(m.t, m);
    };
  });
}

export { connectDuel, defaultServerUrl, normalizeServerUrl, loadVersusPrefs, saveVersusPrefs, VERSUS_KEY };
