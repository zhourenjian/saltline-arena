// Unit tests for the brawl (server/brawl.mjs through server/hub.mjs) with a fake clock: seats,
// queue, offers, culls, death limit, AFK, extra arenas, spectator snapshots, chat, thumbs-down
// mutes, mic grabbing and voice relay. Plus the shared rules helpers (src/brawl/rules.js).
import assert from "node:assert/strict";
import { createDuelHub } from "../server/hub.mjs";
import { DUEL_PROTOCOL } from "../src/versus/rules.js";
import {
  BRAWL_RULES,
  brawlRulesFromEnv,
  rankPlayers,
  pickBrawlSpawn,
  sanitizeChat,
  muLawEncode,
  muLawDecode,
} from "../src/brawl/rules.js";

let passed = 0,
  failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.stack.split("\n").slice(0, 4).join("\n       ")}`);
  }
}

function world(rules = {}) {
  let t = 1000;
  const hub = createDuelHub({
    now: () => t,
    random: () => 0.37,
    setTimer: () => 0,
    clearTimer: () => {},
    brawlRules: { ...BRAWL_RULES, ...rules },
  });
  // advance in 100 ms ticks like the real server
  const advance = (s) => {
    const end = t + s;
    while (t < end - 1e-9) ((t = Math.min(end, +(t + 0.1).toFixed(6))), hub.tick());
  };
  const join = (name, { key, enter = true } = {}) => {
    const inbox = [];
    const c = hub.connect((s) => inbox.push(JSON.parse(s)), () => {}, { key });
    const p = {
      c,
      inbox,
      id: c.id,
      send: (msg) => c.receive(JSON.stringify(msg)),
      last: (type) => [...inbox].reverse().find((m) => m.t === type),
      all: (type) => inbox.filter((m) => m.t === type),
      clear: () => (inbox.length = 0),
      get member() {
        return hub.brawl.members.get(c);
      },
      get role() {
        return hub.brawl.members.get(c)?.role;
      },
      // a pose message so the player counts as active
      move(x = Math.random() * 10) {
        p.send({ t: "br.state", p: [x, 0, 0], v: [0, 0, 0], yaw: x, pitch: 0 });
      },
    };
    p.send({ t: "hello", v: DUEL_PROTOCOL, name });
    enter && p.send({ t: "br.enter" });
    return p;
  };
  return { hub, join, advance, tick: () => hub.tick(), get t() { return t; } };
}

const playing = (w) => [...w.hub.brawl.arenas.values()].reduce((n, a) => n + a.players.size, 0);

console.log("brawl rules");
await test("env overrides are clamped and parsed", () => {
  const r = brawlRulesFromEnv({ BRAWL_MAX_PLAYERS: "8", BRAWL_CULL_SECONDS: "5", BRAWL_CULL_COUNT: "2", BRAWL_CULL_COUNT_BUSY: "1" });
  assert.equal(r.maxPlayers, 8);
  assert.equal(r.cullSeconds, 30, "clamped to 30 s minimum");
  assert.equal(r.cullCount, 2);
  assert.equal(r.cullCountBusy, 2, "busy count never below the normal count");
  assert.equal(brawlRulesFromEnv({}).maxPlayers, BRAWL_RULES.maxPlayers);
});
await test("ranking: kills, then fewer deaths, then the later joiner ranks higher", () => {
  const r = rankPlayers([
    { id: "a", kills: 2, deaths: 5, joinedAt: 1 },
    { id: "b", kills: 2, deaths: 1, joinedAt: 1 },
    { id: "c", kills: 0, deaths: 0, joinedAt: 9 },
    { id: "d", kills: 0, deaths: 0, joinedAt: 2 },
  ]);
  assert.deepEqual(r.map((p) => p.id), ["b", "a", "c", "d"]);
});
await test("spawn far from living players", () => {
  const i = pickBrawlSpawn([[-32, 0, 6]], () => 0);
  assert.notDeepEqual(i, 0);
});
await test("chat text is cleaned and capped", () => {
  assert.equal(sanitizeChat("  hi\u0000\nthere‮  "), "hi there");
  assert.equal(sanitizeChat("x".repeat(500)).length, BRAWL_RULES.chatMaxChars);
});
await test("µ-law round trip stays close", () => {
  for (const v of [0, 0.01, -0.2, 0.5, -0.99]) assert.ok(Math.abs(muLawDecode(muLawEncode(v)) - v) < 0.03, `${v}`);
});

console.log("seats and queue");
await test("first players play at once; the 7th is queued", () => {
  const w = world();
  const ps = Array.from({ length: 6 }, (_, i) => w.join("Pl" + i));
  assert.equal(ps[0].last("br.welcome").canPlayNow, true);
  ps.forEach((p) => p.send({ t: "br.play" }));
  assert.equal(playing(w), 6);
  assert.ok(ps[5].last("br.joined"), "joined message");
  assert.ok(ps[0].all("br.notice").some((n) => n.kind === "join" && n.name === "Pl5"), "others told who joined");
  const late = w.join("Late");
  assert.equal(late.last("br.welcome").canPlayNow, false);
  late.send({ t: "br.play" });
  assert.equal(late.role, "queued");
  w.tick();
  assert.equal(late.last("br.lobby").position, 1);
});
await test("a free seat is offered to the head of the queue; accept seats them", () => {
  const w = world();
  const ps = Array.from({ length: 6 }, (_, i) => w.join("Pl" + i));
  ps.forEach((p) => p.send({ t: "br.play" }));
  const q1 = w.join("Qu1"),
    q2 = w.join("Qu2");
  (q1.send({ t: "br.play" }), q2.send({ t: "br.play" }));
  ps[2].send({ t: "br.watch" }); // leaves the arena, keeps watching
  assert.equal(ps[2].role, "lobby");
  assert.ok(ps[0].all("br.notice").some((n) => n.kind === "left" && n.name === "Pl2"));
  assert.equal(q1.last("br.offer").seconds, BRAWL_RULES.offerSeconds);
  assert.equal(q2.last("br.offer"), undefined, "only one seat");
  // somebody new cannot jump the queue while a seat is held
  const cheeky = w.join("Cheeky");
  cheeky.send({ t: "br.play" });
  assert.equal(cheeky.role, "queued");
  q1.send({ t: "br.accept" });
  assert.equal(q1.role, "playing");
  assert.equal(playing(w), 6);
});
await test("an unanswered offer expires and moves on", () => {
  const w = world();
  const ps = Array.from({ length: 6 }, (_, i) => w.join("Pl" + i));
  ps.forEach((p) => p.send({ t: "br.play" }));
  const q1 = w.join("Qu1"),
    q2 = w.join("Qu2");
  (q1.send({ t: "br.play" }), q2.send({ t: "br.play" }));
  ps[0].c.disconnect();
  assert.ok(q1.last("br.offer"));
  w.advance(BRAWL_RULES.offerSeconds + 0.2);
  assert.equal(q1.last("br.offer").expired, true);
  assert.equal(q1.role, "lobby");
  assert.equal(q2.role, "offered");
});

console.log("culls, deaths, AFK");
await test("every cull round the last place goes back to the queue and the next one gets a seat", () => {
  const w = world();
  const ps = Array.from({ length: 6 }, (_, i) => w.join("Pl" + i));
  ps.forEach((p) => p.send({ t: "br.play" }));
  const q = w.join("Que");
  q.send({ t: "br.play" });
  // P0 scores, everybody else even; P5 joined last but P1..P5 all have 0 kills, 0 deaths
  ps.forEach((p, i) => p.move(i));
  w.advance(BRAWL_RULES.spawnShieldSeconds + 0.1);
  ps[0].send({ t: "br.hit", target: ps[1].id, part: "head" });
  ps[0].send({ t: "br.hit", target: ps[1].id, part: "head" });
  assert.ok(ps[1].all("br.kill").length === 1, "Pl1 died");
  // keep everyone active until the cull
  for (let s = 0; s < BRAWL_RULES.cullSeconds; s += 5) (w.advance(5), ps.forEach((p, i) => p.move(i + s)));
  const out = ps.find((p) => p.last("br.out"));
  assert.ok(out, "someone was culled");
  assert.equal(out.id, ps[1].id, "the one with a death and no kills");
  assert.equal(out.last("br.out").reason, "culled");
  assert.equal(out.last("br.out").requeued, true);
  assert.equal(out.role, "queued");
  assert.equal(q.role, "offered");
  assert.ok(ps[0].all("br.notice").some((n) => n.kind === "culled"));
});
await test("no cull while nobody waits, and never inside the grace period", () => {
  const w = world();
  const ps = Array.from({ length: 6 }, (_, i) => w.join("Pl" + i));
  ps.forEach((p) => p.send({ t: "br.play" }));
  for (let s = 0; s < 130; s += 5) (w.advance(5), ps.forEach((p, i) => p.move(i + s)));
  assert.equal(playing(w), 6, "no queue: nobody culled");
  const w2 = world({ cullSeconds: 30, cullGraceSeconds: 45 });
  const qs = Array.from({ length: 6 }, (_, i) => w2.join("Pl" + i));
  qs.forEach((p) => p.send({ t: "br.play" }));
  w2.join("Que").send({ t: "br.play" });
  for (let s = 0; s < 32; s += 2) (w2.advance(2), qs.forEach((p, i) => p.move(i + s)));
  assert.equal(qs.filter((p) => p.last("br.out")).length, 0, "everyone still inside the grace period");
  for (let s = 0; s < 30; s += 2) (w2.advance(2), qs.forEach((p, i) => p.move(i + s)));
  assert.equal(qs.filter((p) => p.last("br.out")).length, 1, "the second round culls");
});
await test("a long queue culls two per round", () => {
  const w = world({ busyQueue: 3, maxArenas: 1 });
  const ps = Array.from({ length: 6 }, (_, i) => w.join("Pl" + i));
  ps.forEach((p) => p.send({ t: "br.play" }));
  ["A", "B", "C"].forEach((n) => w.join(n).send({ t: "br.play" }));
  for (let s = 0; s < BRAWL_RULES.cullSeconds; s += 5) (w.advance(5), ps.forEach((p, i) => p.move(i + s)));
  assert.equal(ps.filter((p) => p.last("br.out")).length, 2);
});
await test("too many deaths end a stint while people wait", () => {
  const w = world({ deathLimit: 3 });
  const ps = Array.from({ length: 6 }, (_, i) => w.join("Pl" + i));
  ps.forEach((p) => p.send({ t: "br.play" }));
  w.join("Que").send({ t: "br.play" });
  for (let k = 0; k < 3; k++) {
    ps.forEach((p, i) => p.move(i + k));
    w.advance(BRAWL_RULES.spawnShieldSeconds + 0.1);
    ps[0].send({ t: "br.hit", target: ps[1].id, part: "head" });
    ps[0].send({ t: "br.hit", target: ps[1].id, part: "head" });
    w.advance(BRAWL_RULES.respawnSeconds + BRAWL_RULES.spawnShieldSeconds + 0.3);
  }
  assert.equal(ps[1].last("br.out").reason, "deaths");
});
await test("an idle player loses the seat only while people wait", () => {
  const w = world();
  const a = w.join("Idle"),
    b = w.join("Busy");
  (a.send({ t: "br.play" }), b.send({ t: "br.play" }));
  for (let s = 0; s < 60; s += 2) (w.advance(2), b.move(s));
  assert.equal(a.role, "playing", "nobody waiting: idle is fine");
  const w2 = world({ maxPlayers: 2 });
  const x = w2.join("Idle"),
    y = w2.join("Busy");
  (x.send({ t: "br.play" }), y.send({ t: "br.play" }), x.move(1));
  w2.join("Que").send({ t: "br.play" });
  for (let s = 0; s < BRAWL_RULES.afkSeconds + 2; s += 2) (w2.advance(2), y.move(s));
  assert.equal(x.last("br.out").reason, "afk");
  assert.equal(y.role, "playing");
});
await test("a long queue opens another arena; empty extra arenas close", () => {
  const w = world({ maxPlayers: 2, openArenaQueue: 2, maxArenas: 3 });
  const ps = Array.from({ length: 4 }, (_, i) => w.join("Pl" + i));
  ps.forEach((p) => p.send({ t: "br.play" }));
  assert.equal(w.hub.brawl.arenas.size, 2);
  ps.filter((p) => p.role === "offered").forEach((p) => p.send({ t: "br.accept" }));
  assert.equal(playing(w), 4);
  const arena2 = [...w.hub.brawl.arenas.values()].find((a) => a.id !== 1);
  [...arena2.players.values()].forEach((m) => m.client.disconnect());
  w.tick();
  assert.equal(w.hub.brawl.arenas.size, 1);
});

console.log("combat and spectating");
await test("head hits do more damage than body hits", () => {
  const w = world();
  const a = w.join("Aaa"),
    b = w.join("Bbb");
  (a.send({ t: "br.play" }), b.send({ t: "br.play" }), a.move(0), b.move(5));
  w.advance(BRAWL_RULES.spawnShieldSeconds + 0.2);
  a.send({ t: "br.hit", target: b.id, part: "body" });
  const body = b.last("br.damage").amount;
  w.advance(0.2);
  a.send({ t: "br.hit", target: b.id, part: "head" });
  const head = b.last("br.damage").amount;
  assert.equal(body, BRAWL_RULES.damage.body);
  assert.equal(head, BRAWL_RULES.damage.head);
  assert.ok(head > body);
});
await test("spectators get batched snapshots and kills of the arena they watch", () => {
  const w = world();
  const a = w.join("Aaa"),
    b = w.join("Bbb"),
    s = w.join("Watcher");
  (a.send({ t: "br.play" }), b.send({ t: "br.play" }));
  (a.move(1), b.move(2));
  s.clear();
  w.advance(0.3);
  const snap = s.last("br.snap");
  assert.ok(snap && snap.s.length === 2, "two players in the snapshot");
  assert.equal(s.all("br.state").length, 0, "no per-packet relay to spectators");
  w.advance(BRAWL_RULES.spawnShieldSeconds);
  (a.send({ t: "br.hit", target: b.id, part: "head" }), a.send({ t: "br.hit", target: b.id, part: "head" }));
  assert.ok(s.last("br.kill"));
  assert.equal(s.all("br.damage").length, 0, "health is not shown to spectators");
});
await test("entering the brawl leaves a duel room and creating a room leaves the brawl", () => {
  const w = world();
  const a = w.join("A", { enter: false });
  a.send({ t: "create" });
  assert.ok(a.c.room);
  a.send({ t: "br.enter" });
  assert.equal(a.c.room, null);
  a.send({ t: "br.play" });
  assert.equal(a.role, "playing");
  a.send({ t: "create" });
  assert.equal(a.member, undefined);
  assert.equal(playing(w), 0);
});

console.log("chat");
await test("only spectators chat; players never receive spectator chat", () => {
  const w = world();
  const p = w.join("Player"),
    s1 = w.join("S1"),
    s2 = w.join("S2");
  p.send({ t: "br.play" });
  p.send({ t: "br.say", text: "where are they" });
  assert.equal(p.last("br.error").code, "PLAYERS_CANNOT_CHAT");
  s1.send({ t: "br.say", text: "he is behind the crane" });
  assert.equal(s2.last("br.chat").text, "he is behind the crane");
  assert.equal(p.all("br.chat").length, 0);
  // newcomers get the history
  assert.equal(w.join("S3").last("br.welcome").history.length, 1);
});
await test("6 messages a minute", () => {
  const w = world();
  const s = w.join("S"),
    o = w.join("O");
  for (let i = 0; i < 7; i++) s.send({ t: "br.say", text: "m" + i });
  assert.equal(o.all("br.chat").length, 6);
  assert.equal(s.last("br.error").code, "CHAT_RATE");
  w.advance(60.1);
  s.send({ t: "br.say", text: "again" });
  assert.equal(o.all("br.chat").length, 7);
});
await test("thumbs-down: once per voter, not your own, 10 s of mute per vote, survives a reconnect under the same name", () => {
  const w = world();
  const author = w.join("Author", { key: "1.2.3.4" }),
    v1 = w.join("V1"),
    v2 = w.join("V2");
  author.send({ t: "br.say", text: "spam" });
  const id = v1.last("br.chat").id;
  author.send({ t: "br.down", msg: id });
  assert.equal(author.last("br.error").code, "OWN_MESSAGE");
  v1.send({ t: "br.down", msg: id });
  v1.send({ t: "br.down", msg: id }); // counted once
  v2.send({ t: "br.down", msg: id });
  assert.equal(v2.last("br.vote").downs, 2);
  assert.equal(author.last("br.muted").seconds, 20);
  author.send({ t: "br.say", text: "still here" });
  assert.equal(author.last("br.error").code, "MUTED");
  // reconnecting from the same address with the same callsign keeps the mute
  author.c.disconnect();
  const again = w.join("Author", { key: "1.2.3.4" });
  assert.equal(again.last("br.lobby").muted, 20);
  again.send({ t: "br.mic", on: true });
  assert.equal(again.last("br.mic").code, "MUTED");
  w.advance(20.1);
  again.send({ t: "br.say", text: "back" });
  assert.equal(v1.last("br.chat").text, "back");
});
await test("thumbs-down mutes the author only: same address, other callsign can still chat; one vote per address", () => {
  const w = world();
  const author = w.join("Author", { key: "9.9.9.9" }),
    roommate = w.join("Roommate", { key: "9.9.9.9" }),
    v1 = w.join("V1", { key: "5.5.5.5" }),
    v1b = w.join("V1b", { key: "5.5.5.5" });
  author.send({ t: "br.say", text: "spam" });
  const id = v1.last("br.chat").id;
  v1.send({ t: "br.down", msg: id });
  v1b.send({ t: "br.down", msg: id }); // same address: not counted again
  assert.equal(v1.last("br.vote").downs, 1);
  author.send({ t: "br.say", text: "more" });
  assert.equal(author.last("br.error").code, "MUTED");
  roommate.send({ t: "br.say", text: "not me" });
  assert.equal(v1.last("br.chat").text, "not me");
  // renaming in the lobby does not lift the mute
  author.send({ t: "profile", name: "Someone" });
  author.send({ t: "br.say", text: "renamed" });
  assert.equal(author.last("br.error").code, "MUTED");
});
await test("mic: up to 3 speakers, 3 grabs a minute, 10 s each, voice only to spectators", () => {
  const w = world();
  const talkers = Array.from({ length: 4 }, (_, i) => w.join("T" + i)),
    player = w.join("Player"),
    ear = w.join("Ear");
  player.send({ t: "br.play" });
  talkers.forEach((t) => t.send({ t: "br.mic", on: true }));
  assert.deepEqual(talkers.map((t) => t.last("br.mic").ok), [true, true, true, false]);
  assert.equal(talkers[3].last("br.mic").code, "MIC_BUSY");
  talkers[0].send({ t: "br.voice", seq: 1, data: Buffer.alloc(2000, 0x7f).toString("base64") });
  assert.equal(ear.last("br.voice").from, talkers[0].id);
  assert.equal(player.all("br.voice").length, 0, "the player hears nothing");
  assert.equal(talkers[0].all("br.voice").length, 0, "no echo to the speaker");
  // a voice clip is a message that can be voted on
  assert.ok(ear.all("br.chat").some((m) => m.kind === "voice" && m.from === talkers[0].id));
  // auto release after 10 s
  w.advance(BRAWL_RULES.micSeconds + 0.2);
  assert.equal(talkers[0].last("br.mic").ended, "time");
  // grabs per minute
  const g = talkers[3];
  for (let i = 0; i < 3; i++) (g.send({ t: "br.mic", on: true }), g.send({ t: "br.mic", on: false }));
  g.send({ t: "br.mic", on: true });
  assert.equal(g.last("br.mic").code, "MIC_RATE");
  // oversized / bad chunks are dropped
  const t1 = w.join("Big");
  t1.send({ t: "br.mic", on: true });
  ear.clear();
  t1.send({ t: "br.voice", seq: 1, data: "not base64!" });
  t1.send({ t: "br.voice", seq: 2, data: Buffer.alloc(9000).toString("base64") });
  assert.equal(ear.all("br.voice").length, 0);
});

console.log("abuse");
await test("message floods are dropped", () => {
  const w = world();
  const a = w.join("Aaa"),
    o = w.join("O");
  for (let i = 0; i < 400; i++) a.send({ t: "br.spectate", arena: 1 });
  a.clear();
  a.send({ t: "br.say", text: "after the flood" });
  assert.equal(o.all("br.chat").length, 0, "bucket empty");
  w.advance(1);
  a.send({ t: "br.say", text: "after the flood" });
  assert.equal(o.all("br.chat").length, 1);
});
await test("lobby and queue caps", () => {
  const w = world({ maxSpectators: 2, maxQueue: 1, maxPlayers: 2 });
  const a = w.join("Aaa"),
    b = w.join("Bbb");
  const c = w.join("C");
  assert.equal(c.last("br.error").code, "BRAWL_FULL");
  (a.send({ t: "br.play" }), b.send({ t: "br.play" }));
  const d = w.join("D"),
    e = w.join("E");
  d.send({ t: "br.play" });
  e.send({ t: "br.play" });
  assert.equal(e.last("br.error").code, "QUEUE_FULL");
});

await test("wait list: queue in order with positions, then watch-only newest first, capped at 10; players get none", () => {
  const w = world({ maxPlayers: 2 });
  const a = w.join("Aaa"),
    b = w.join("Bbb");
  (a.send({ t: "br.play" }), b.send({ t: "br.play" }));
  const q = Array.from({ length: 3 }, (_, i) => {
    w.advance(1);
    const p = w.join("Qu" + i);
    p.send({ t: "br.play" });
    return p;
  });
  const watchers = Array.from({ length: 9 }, (_, i) => (w.advance(1), w.join("Wa" + i)));
  w.tick();
  const view = watchers[0].last("br.lobby");
  assert.equal(view.list.length, 10);
  assert.deepEqual(view.list.slice(0, 3).map((x) => [x.name, x.pos]), [["Qu0", 1], ["Qu1", 2], ["Qu2", 3]]);
  assert.deepEqual(view.list.slice(3).map((x) => x.name), ["Wa8", "Wa7", "Wa6", "Wa5", "Wa4", "Wa3", "Wa2"], "newest watchers first");
  assert.ok(view.list.slice(3).every((x) => x.pos === 0), "watch-only has no number");
  assert.equal(view.spectators, 12);
  assert.equal(q[1].last("br.lobby").position, 2, "own place");
  assert.equal(a.last("br.lobby").list, undefined, "players get no list");
  // the head of the queue sees itself first; leaving the queue makes you watch-only
  q[0].send({ t: "br.decline" });
  w.tick();
  const v1 = q[1].last("br.lobby");
  assert.equal(v1.position, 1);
  assert.equal(v1.list[0].name, "Qu1");
  assert.equal(q[0].last("br.lobby").role, "lobby");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
