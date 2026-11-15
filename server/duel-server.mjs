#!/usr/bin/env node
// Saltline 1v1 duel relay. No dependencies: `npm run server` (or `node server/duel-server.mjs`).
//
//   PORT=8787            listen port (default 8787)
//   HOST=0.0.0.0         listen address (default all interfaces; use 127.0.0.1 for local only)
//   ALLOWED_ORIGINS=...  optional comma-separated list of page origins allowed to connect,
//                        e.g. "https://you.github.io,http://127.0.0.1:5173". Empty = any origin.
//   MAX_CONNECTIONS=1000         total sockets; MAX_CONNECTIONS_PER_IP=4 sockets per address
//   TRUST_PROXY=1                take the client address from X-Forwarded-For (behind a proxy)
//   BRAWL_MAX_PLAYERS=6 BRAWL_CULL_SECONDS=60 BRAWL_CULL_COUNT=1 BRAWL_CULL_COUNT_BUSY=2
//   BRAWL_BUSY_QUEUE=6 BRAWL_MAX_ARENAS=3 BRAWL_OPEN_ARENA_QUEUE=4 BRAWL_DEATH_LIMIT=10
//   BRAWL_MAX_QUEUE=200 BRAWL_MAX_SPECTATORS=500 BRAWL_AFK_SECONDS=45 BRAWL_OFFER_SECONDS=15
//   BRAWL_STALLED_SECONDS=12
//                                                  brawl tuning (see src/brawl/rules.js)
//
// The server keeps rooms in memory only. It stores no accounts, no files and no logs of players.
import http from "node:http";
import { fileURLToPath } from "node:url";
import { acceptWebSocket } from "./websocket.mjs";
import { createDuelHub } from "./hub.mjs";
import { DUEL_PROTOCOL, DUEL_RULES } from "../src/versus/rules.js";
import { brawlRulesFromEnv } from "../src/brawl/rules.js";

export function startDuelServer({
  port = Number(process.env.PORT || 8787),
  host = process.env.HOST || "0.0.0.0",
  allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  quiet = false,
  env = process.env,
  maxConnections = Number(env.MAX_CONNECTIONS || 1000),
  maxPerIp = Number(env.MAX_CONNECTIONS_PER_IP || 4),
  trustProxy = env.TRUST_PROXY === "1",
} = {}) {
  const log = quiet ? () => {} : (...a) => console.log("[duel]", ...a);
  const hub = createDuelHub({ log, brawlRules: brawlRulesFromEnv(env) });
  const sockets = new Set(),
    perIp = new Map();
  const ticker = setInterval(() => hub.tick(), 100);
  ticker.unref();

  const server = http.createServer((req, res) => {
    const cors = { "access-control-allow-origin": "*" };
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end(
        JSON.stringify({
          ok: true,
          service: "saltline-duel",
          protocol: DUEL_PROTOCOL,
          rooms: hub.rooms.size,
          players: hub.clients.size,
          brawl: hub.brawl.stats(),
        }),
      );
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", ...cors });
    res.end("Saltline duel relay. Connect with WebSocket; GET /health for status.\n");
  });

  server.on("upgrade", (req, socket) => {
    const origin = req.headers.origin || "";
    if (allowedOrigins.length && !allowedOrigins.includes(origin)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const ip =
      (trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) ||
      req.socket.remoteAddress ||
      "?";
    if (sockets.size >= maxConnections || (perIp.get(ip) || 0) >= maxPerIp) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    const ws = acceptWebSocket(req, socket, { maxPayload: DUEL_RULES.maxMessageBytes });
    if (!ws) return;
    sockets.add(ws);
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    const client = hub.connect(
      (text) => ws.send(text),
      (code, reason) => ws.close(code, reason),
      { key: ip },
    );
    ws.onmessage = (text) => client.receive(text);
    ws.onclose = () => {
      sockets.delete(ws);
      const n = (perIp.get(ip) || 1) - 1;
      n > 0 ? perIp.set(ip, n) : perIp.delete(ip);
      client.disconnect();
    };
  });

  // heartbeat: drop sockets that stopped answering for 30 s
  const beat = setInterval(() => {
    const cutoff = Date.now() - 30000;
    for (const ws of sockets) ws.lastSeen < cutoff ? ws.close(1001, "timeout") : ws.ping();
  }, 10000);
  beat.unref();

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      log(`listening on ws://${host}:${addr.port} (protocol ${DUEL_PROTOCOL})`);
      allowedOrigins.length && log(`allowed origins: ${allowedOrigins.join(", ")}`);
      resolve(addr.port);
    });
  });

  return {
    hub,
    server,
    ready,
    async close() {
      clearInterval(beat);
      clearInterval(ticker);
      for (const ws of sockets) ws.close(1001, "server shutdown");
      await new Promise((r) => server.close(() => r()));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = startDuelServer();
  s.ready.catch((e) => {
    console.error("[duel] failed to start:", e.message);
    process.exit(1);
  });
  const stop = () => s.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
