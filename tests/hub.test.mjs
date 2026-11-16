// Unit tests for the duel hub (server/hub.mjs) with a fake clock, plus a smoke test of the real
// WebSocket server (server/duel-server.mjs) using Node's built-in WebSocket client.
import assert from "node:assert/strict";
import { createDuelHub } from "../server/hub.mjs";
import { startDuelServer } from "../server/duel-server.mjs";
import { acceptKey } from "../server/websocket.mjs";
import {
  DUEL_PROTOCOL,
  DUEL_RULES,
  DUEL_SPAWNS,
  healthAt,
  pickSpawn,
  sanitizeName,
  nameProblem,
  sanitizeAvatar,
  normalizeRoomCode,
  sanitizeLoco,
  packLoco,
} from "../src/versus/rules.js";

let passed = 0,
  failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.stack.split("\n").slice(0, 3).join("\n       ")}`);
  }
}

function fakeWorld() {
  let t = 1000,
    seq = 0;
  const timers = new Map();
  const hub = createDuelHub({
    now: () => t,
    random: () => 0.37,
    setTimer: (fn, s) => (timers.set(++seq, { at: t + s, fn }), seq),
    clearTimer: (id) => timers.delete(id),
  });
  const advance = (s) => {
    const end = t + s;
    for (;;) {
      const due = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = due[1].at;
      due[1].fn();
    }
    t = end;
  };
  const player = (name, backlog = null) => {
    const inbox = [];
    let closed = null;
    const c = hub.connect(
      (s) => inbox.push(JSON.parse(s)),
      (code) => (closed = code),
      { backlog },
    );
    const p = {
      c,
      inbox,
      get closed() {
        return closed;
      },
      send: (m) => c.receive(JSON.stringify(m)),
      last: (type) => [...inbox].reverse().find((m) => m.t === type),
      all: (type) => inbox.filter((m) => m.t === type),
      clear: () => (inbox.length = 0),
    };
    name && p.send({ t: "hello", v: DUEL_PROTOCOL, name, avatar: null });
    return p;
  };
  return { hub, advance, player, timers, now: () => t };
}

async function pairedLive() {
  const w = fakeWorld(),
    a = w.player("Alpha"),
    b = w.player("Bravo");
  a.send({ t: "create" });
  b.send({ t: "join", code: a.last("room").code });
  w.advance(DUEL_RULES.countdownSeconds + 0.01);
  a.send({ t: "state", p: [0, 0, 0] });
  b.send({ t: "state", p: [10, 0, 0] });
  return { w, a, b, aid: a.last("welcome").id, bid: b.last("welcome").id };
}

console.log("duel rules / hub");

await test("rules helpers sanitize input", () => {
  assert.equal(sanitizeName("  <b>Neo</b>\u0007  "), "bNeo/b");
  assert.equal(sanitizeName(""), "Breacher");
  assert.equal(sanitizeName("x".repeat(40)).length, DUEL_RULES.maxNameLength);
  assert.equal(DUEL_RULES.minNameLength, 3);
  assert.equal(DUEL_RULES.maxNameLength, 8);
  for (const bad of ["ab", "   ", "  ?!  ", "---", "!@#$%", " a ", "\u0007\u0008"]) assert.equal(sanitizeName(bad), "Breacher", JSON.stringify(bad));
  assert.equal(sanitizeName("  Neo  Trinity-long"), "Neo Trin");
  assert.equal(sanitizeName("玩家一号"), "玩家一号");
  assert.equal(sanitizeName("a_b"), "a_b");
  assert.equal(sanitizeName("😀😀😀😀"), "Breacher", "emoji alone are not letters or digits");
  assert.equal(nameProblem(""), "", "empty = use the default");
  assert.ok(nameProblem("ab") && nameProblem("123456789") && nameProblem("   !!!   "), "too short / long / no letters");
  assert.equal(nameProblem("Neo7"), "");
  assert.equal(sanitizeAvatar("masked-raider"), "masked-raider");
  assert.equal(sanitizeAvatar("../etc"), null);
  assert.equal(sanitizeAvatar(42), null);
  assert.equal(normalizeRoomCode(" ab-c9x "), "ABC9");
});

await test("health regenerates like the client", () => {
  const p = { alive: true, health: 40, lastHurtAt: 0 };
  assert.equal(healthAt(p, 3), 40);
  assert.equal(healthAt(p, 5), 65);
  assert.equal(healthAt(p, 100), 100);
  assert.equal(healthAt({ ...p, alive: false }, 5), 0);
});

await test("spawn choice avoids the opponent", () => {
  for (let i = 0; i < DUEL_SPAWNS.length; i++) {
    const avoid = DUEL_SPAWNS[i];
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const s = pickSpawn(avoid, () => r);
      assert.notEqual(s, i);
      const d = Math.hypot(DUEL_SPAWNS[s][0] - avoid[0], DUEL_SPAWNS[s][1] - avoid[1]);
      const ds = DUEL_SPAWNS.map((q) => Math.hypot(q[0] - avoid[0], q[1] - avoid[1])).sort(
        (x, y) => x - y,
      );
      assert.ok(d >= ds[Math.floor(ds.length / 2) - 1], `spawn ${s} too close to ${i}`);
    }
  }
});

await test("hello is required and the protocol version is checked", () => {
  const w = fakeWorld(),
    p = w.player(null);
  p.send({ t: "create" });
  assert.equal(p.last("error").code, "HELLO_FIRST");
  p.send({ t: "hello", v: 99 });
  assert.equal(p.last("error").code, "PROTOCOL_MISMATCH");
  assert.equal(p.closed, 4000);
  const q = w.player("Q");
  assert.ok(q.last("welcome").id);
  q.c.receive("{not json");
  assert.equal(q.last("error").code, "BAD_MESSAGE");
});

await test("create / join / full / not found / leave", () => {
  const w = fakeWorld(),
    a = w.player("A"),
    b = w.player("B"),
    c = w.player("C");
  a.send({ t: "create" });
  const code = a.last("room").code;
  assert.match(code, /^[A-Z2-9]{4}$/);
  c.send({ t: "join", code: "ZZZZ" });
  assert.equal(c.last("error").code, "ROOM_NOT_FOUND");
  b.send({ t: "join", code: code.toLowerCase() });
  assert.equal(b.last("room").players.length, 2);
  assert.ok(a.last("start") && b.last("start"));
  const st = a.last("start");
  assert.notEqual(st.spawns[a.c.id], st.spawns[b.c.id]);
  c.send({ t: "join", code });
  assert.equal(c.last("error").code, "ROOM_FULL");
  b.send({ t: "leave" });
  assert.equal(a.last("peer:left").id, b.c.id);
  assert.equal(a.last("room").players.length, 1);
  assert.equal(a.last("room").phase, "waiting");
  a.send({ t: "leave" });
  assert.equal(w.hub.rooms.size, 0);
  assert.equal(w.timers.size, 0, "no timers left behind");
});

await test("countdown → live; hits during countdown are ignored", () => {
  const w = fakeWorld(),
    a = w.player("A"),
    b = w.player("B");
  a.send({ t: "create" });
  b.send({ t: "join", code: a.last("room").code });
  a.send({ t: "hit", target: b.c.id, part: "head" });
  assert.equal(a.all("damage").length, 0);
  w.advance(DUEL_RULES.countdownSeconds);
  assert.ok(a.last("live") && b.last("live"));
});

await test("server decides damage, kill, score and respawn", async () => {
  const { w, a, b, aid, bid } = await pairedLive();
  a.send({ t: "hit", target: bid, part: "body" });
  let d = b.last("damage");
  assert.deepEqual(
    { target: d.target, from: d.from, amount: d.amount, hp: d.hp },
    { target: bid, from: aid, amount: DUEL_RULES.damage.body, hp: 80 },
  );
  a.send({ t: "hit", target: bid, part: "head", amount: 9999 });
  assert.equal(b.last("damage").hp, 30, "client-sent amount is ignored");
  a.send({ t: "hit", target: aid, part: "head" });
  assert.equal(a.all("damage").length, 2, "cannot hit yourself");
  a.send({ t: "hit", target: bid, part: "head" });
  const k = a.last("kill");
  assert.deepEqual(
    { victim: k.victim, killer: k.killer, score: k.scores[aid] },
    { victim: bid, killer: aid, score: 1 },
  );
  assert.equal(k.respawnIn, DUEL_RULES.respawnSeconds);
  a.send({ t: "hit", target: bid, part: "head" });
  assert.equal(a.all("damage").length, 3, "dead players take no damage");
  w.advance(DUEL_RULES.respawnSeconds + 0.01);
  const sp = b.last("spawn");
  assert.equal(sp.id, bid);
  assert.ok(sp.spawn >= 0 && sp.spawn < DUEL_SPAWNS.length);
  a.send({ t: "hit", target: bid, part: "body" });
  assert.equal(a.all("damage").length, 3, "spawn shield");
  w.advance(DUEL_RULES.spawnShieldSeconds + 1);
  a.send({ t: "hit", target: bid, part: "body" });
  assert.equal(a.last("damage").hp, 80);
});

await test("hit rate is capped at the rifle's fire rate", async () => {
  const { w, a, b, bid } = await pairedLive();
  for (let i = 0; i < 20; i++) a.send({ t: "hit", target: bid, part: "body" });
  const n = b.all("damage").length;
  assert.ok(n <= DUEL_RULES.hitBurst, `burst of ${n}`);
});

await test("hits beyond the weapon range are dropped", async () => {
  const { w, a, b, bid } = await pairedLive();
  w.advance(0.1);
  b.send({ t: "state", p: [0, 0, 0] });
  a.send({ t: "state", p: [DUEL_RULES.maxHitDistance + 50, 0, 0] });
  assert.deepEqual(a.c.lastPos, [DUEL_RULES.maxHitDistance + 50, 0, 0]);
  a.c.lastPos = [DUEL_RULES.maxHitDistance + 50, 0, 0];
  b.c.lastPos = [0, 0, 0];
  a.send({ t: "hit", target: bid, part: "body" });
  assert.equal(b.all("damage").length, 0);
});

await test("self damage kills without credit; regen restores health", async () => {
  const { w, a, b, aid, bid } = await pairedLive();
  a.send({ t: "hit", target: bid, part: "head" });
  assert.equal(b.last("damage").hp, 50);
  w.advance(DUEL_RULES.regenDelay + 1);
  a.send({ t: "hit", target: bid, part: "body" });
  assert.equal(b.last("damage").hp, Math.min(100, 50 + DUEL_RULES.regenRate) - 20);
  b.send({ t: "hurt", amount: 500 });
  const k = a.last("kill");
  assert.equal(k.victim, bid);
  assert.equal(k.killer, null);
  assert.equal(k.scores[aid], 0);
});

await test("first to five wins; rematch needs both players", async () => {
  const { w, a, b, aid, bid } = await pairedLive();
  for (let kill = 0; kill < DUEL_RULES.killsToWin; kill++) {
    w.advance(1);
    a.send({ t: "hit", target: bid, part: "head" });
    w.advance(0.2);
    a.send({ t: "hit", target: bid, part: "head" });
    if (kill < DUEL_RULES.killsToWin - 1) w.advance(DUEL_RULES.respawnSeconds + DUEL_RULES.spawnShieldSeconds + 0.1);
  }
  const end = b.last("end");
  assert.ok(end, "end sent");
  assert.equal(end.winner, aid);
  assert.equal(end.scores[aid], DUEL_RULES.killsToWin);
  assert.equal(end.stats[bid].deaths, DUEL_RULES.killsToWin);
  assert.equal(a.last("kill").respawnIn, null);
  w.advance(10);
  assert.equal(b.all("spawn").length, DUEL_RULES.killsToWin - 1, "no respawn after the end");
  a.send({ t: "hit", target: bid, part: "head" });
  assert.equal(a.last("kill").scores[aid], DUEL_RULES.killsToWin);
  const starts = a.all("start").length;
  a.send({ t: "rematch" });
  assert.deepEqual(b.last("rematch").ids, [aid]);
  assert.equal(a.all("start").length, starts);
  b.send({ t: "rematch" });
  assert.equal(a.all("start").length, starts + 1);
  assert.equal(a.last("start").room.players.every((p) => p.score === 0), true);
});

await test("state and shots are relayed only to the peer, with clean fields", async () => {
  const { w, a, b, aid } = await pairedLive();
  w.advance(0.1);
  a.send({ t: "state", p: [1, 2, 3], v: "x", yaw: 1, pitch: NaN, loco: { phase: "takeoff", evil: 1 } });
  const s = b.last("state");
  assert.deepEqual(s.p, [1, 2, 3]);
  assert.deepEqual(s.v, [0, 0, 0]);
  assert.equal(s.pitch, 0);
  assert.equal(s.loco.phase, "takeoff");
  assert.equal(s.loco.evil, undefined);
  assert.equal(s.id, aid);
  assert.equal(a.all("state").filter((m) => m.id === aid).length, 0, "no echo to sender");
  w.advance(0.1);
  a.send({ t: "state", p: [1, 2, "3"] });
  assert.equal(b.all("state").length, 2, "malformed position is dropped");
  a.send({ t: "shot", o: [0, 1, 0], e: [5, 1, 0], hit: false });
  assert.deepEqual(b.last("shot").e, [5, 1, 0]);
});

await test("disconnect cleans up the room and timers", async () => {
  const { w, a, b } = await pairedLive();
  a.c.disconnect();
  assert.equal(b.last("peer:left").reason, "disconnected");
  b.c.disconnect();
  assert.equal(w.hub.rooms.size, 0);
  assert.equal(w.hub.clients.size, 0);
  assert.equal(w.timers.size, 0);
});

await test("websocket accept key matches RFC 6455 example", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

await test("locomotion relay: sanitizeLoco bounds climb state and drops unknown fields; packLoco round-trips", () => {
  assert.equal(sanitizeLoco(null), null);
  assert.equal(sanitizeLoco("x"), null);
  const dirty = { grounded: 1, phase: "x".repeat(99), speed: 1e9, evil: { a: 1 }, climb: { kind: "rope", progress: 7, ledgeHeight: NaN, ledgeDistance: -4, climbSpeed: 99, crouchEnd: 1, extra: 1 } };
  const c = sanitizeLoco(dirty);
  assert.equal(c.evil, undefined);
  assert.equal(c.phase.length, 16);
  assert.equal(c.speed, 100);
  assert.deepEqual(c.climb, { kind: "mantle", progress: 1, ledgeHeight: 0, ledgeDistance: 0, climbSpeed: 10, crouchEnd: true });
  const packed = packLoco({ grounded: true, phase: "grounded", mode: "duoworld:climb", sprinting: false, speed: 1.23456, climb: { kind: "ladder", progress: 0.123456, ledgeHeight: 0.5, ledgeDistance: 0, climbSpeed: 2.34567, crouchEnd: false } });
  assert.equal(packed.speed, 1.23);
  assert.equal(packed.climb.progress, 0.123);
  assert.deepEqual(sanitizeLoco(packed).climb, packed.climb);
  assert.equal(packLoco({ grounded: true, phase: "grounded", mode: "m", speed: 0 }).climb, undefined);
  // reload / inspect: [action, seconds, empty]; anything else is dropped or clamped
  assert.deepEqual(sanitizeLoco({ w: [1, 1.234, 1] }).w, [1, 1.234, 1]);
  assert.deepEqual(sanitizeLoco({ w: [2, 99, "x"] }).w, [2, 4, 1]);
  assert.deepEqual(sanitizeLoco({ w: [2, -3, 0] }).w, [2, 0, 0]);
  for (const bad of [[0, 1, 0], [3, 1, 0], ["1", 1, 0], "reload", { 0: 1 }, [1, NaN, 0].slice(0, 0)]) assert.equal(sanitizeLoco({ w: bad }).w, undefined);
  assert.deepEqual(sanitizeLoco({ w: [1, NaN, 0] }).w, [1, 0, 0]);
  const base = { grounded: true, phase: "grounded", mode: "duoworld:walk", speed: 0 };
  assert.deepEqual(packLoco(base, { a: 1, t: 0.98765, empty: true }).w, [1, 0.99, 1]);
  assert.equal(packLoco(base, { a: 0, t: 0, empty: false }).w, undefined);
  assert.equal(packLoco(base, null).w, undefined);
  assert.equal(packLoco({ ...base, held: { kind: "rifle" } }, null).held, undefined);
});

await test("poses are dropped (not queued) for a client whose link is backed up; events still go through", async () => {
  const w = fakeWorld();
  let stuck = 0;
  const a = w.player("Alpha"),
    b = w.player("Bravo", () => stuck);
  a.send({ t: "create" });
  b.send({ t: "join", code: a.last("room").code });
  w.advance(DUEL_RULES.countdownSeconds + 0.01);
  b.clear();
  a.send({ t: "state", p: [1, 0, 0] });
  assert.equal(b.all("state").length, 1);
  stuck = 100000;
  w.advance(0.1);
  a.send({ t: "state", p: [2, 0, 0] });
  assert.equal(b.all("state").length, 1, "stale pose not sent");
  assert.equal(b.c.dropped, 1);
  stuck = 0;
  w.advance(0.1);
  a.send({ t: "state", p: [3, 0, 0] });
  assert.equal(b.last("state").p[0], 3, "newest pose goes out once the link drains");
});

console.log("duel server (real sockets)");

if (typeof WebSocket !== "function") {
  console.log("  skip real-socket tests: this Node has no global WebSocket (needs Node 22+)");
} else {
  await test("two clients play over the real WebSocket server", async () => {
    const srv = startDuelServer({ port: 0, host: "127.0.0.1", quiet: true });
    const port = await srv.ready;
    try {
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      assert.equal(health.ok, true);
      assert.equal(health.protocol, DUEL_PROTOCOL);
      const open = () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}`),
            inbox = [],
            waiters = [];
          ws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            inbox.push(m);
            waiters.slice().forEach((w) => w.test(m) && (waiters.splice(waiters.indexOf(w), 1), w.resolve(m)));
          };
          ws.onerror = reject;
          ws.onopen = () =>
            resolve({
              ws,
              inbox,
              send: (m) => ws.send(JSON.stringify(m)),
              wait: (t, pred = () => true) =>
                new Promise((res, rej) => {
                  const hit = inbox.find((m) => m.t === t && pred(m));
                  if (hit) return res(hit);
                  waiters.push({ test: (m) => m.t === t && pred(m), resolve: res });
                  setTimeout(() => rej(new Error(`timeout waiting for ${t}`)), 8000);
                }),
            });
        });
      const a = await open(),
        b = await open();
      a.send({ t: "hello", v: DUEL_PROTOCOL, name: "Aaa" });
      b.send({ t: "hello", v: DUEL_PROTOCOL, name: "Bbb" });
      const aw = await a.wait("welcome"),
        bw = await b.wait("welcome");
      a.send({ t: "create" });
      const room = await a.wait("room", (m) => m && m.code);
      b.send({ t: "join", code: room.code });
      await Promise.all([a.wait("start"), b.wait("start")]);
      await a.wait("live");
      // a large (fragmented-size) message is accepted, an oversize one closes the socket
      a.send({ t: "ping", at: "x".repeat(8000) });
      assert.equal((await a.wait("pong")).at.length, 8000);
      // a burst of poses (a stalled link catching up) is relayed as its newest pose
      for (let i = 1; i <= 6; i++) a.send({ t: "state", p: [i, 0, 0], yaw: 0, pitch: 0 });
      await new Promise((r) => setTimeout(r, 300));
      const poses = b.inbox.filter((m) => m.t === "state");
      assert.equal(poses[poses.length - 1].p[0], 6, "the newest pose arrives last");
      // netstat is accepted with junk values and never answered or fatal
      a.send({ t: "netstat", n: "x", avg: -5, p95: 1e12, max: null, via: "4g".repeat(20) });
      a.send({ t: "ping", at: 1 });
      assert.equal((await a.wait("pong", (m) => m.at === 1)).at, 1);
      a.send({ t: "hit", target: bw.id, part: "head" });
      const d = await b.wait("damage");
      assert.equal(d.from, aw.id);
      assert.equal(d.hp, 50);
      const closed = new Promise((r) => (b.ws.onclose = (e) => r(e.code)));
      b.send({ t: "ping", at: "y".repeat(DUEL_RULES.maxMessageBytes + 10) });
      assert.equal(await closed, 1009);
      const left = await a.wait("peer:left");
      assert.equal(left.id, bw.id);
      a.ws.close();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(srv.hub.rooms.size, 0);
    } finally {
      await srv.close();
    }
  });

  await test("ALLOWED_ORIGINS rejects other pages", async () => {
    const srv = startDuelServer({
      port: 0,
      host: "127.0.0.1",
      quiet: true,
      allowedOrigins: ["https://allowed.example"],
    });
    const port = await srv.ready;
    try {
      const code = await new Promise((r) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.onopen = () => r("open");
        ws.onerror = () => r("error");
      });
      assert.equal(code, "error");
    } finally {
      await srv.close();
    }
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
