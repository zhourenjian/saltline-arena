// Browser tests for the crane ladder and the walkable stair tower next to the quay:
//   node tests/ladder.test.mjs              (builds into a temp dir first)
//   node tests/ladder.test.mjs --dist DIR   (test an existing standalone build instead)
// Screenshots land in tests/out/ladder-*.jpg.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./lib/browser.mjs";
import { serve } from "./lib/serve.mjs";
import { DUEL_SPAWNS } from "../src/versus/rules.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/out");
mkdirSync(OUT, { recursive: true });
const distArg = process.argv.indexOf("--dist");
let STANDALONE;
if (distArg > 0) STANDALONE = path.resolve(process.argv[distArg + 1]);
else {
  STANDALONE = path.join(os.tmpdir(), "saltline-ladder-test", "standalone");
  console.log(`building standalone into ${STANDALONE} ...`);
  execSync(`npx vite build --outDir "${STANDALONE}" --emptyOutDir --logLevel warn`, { cwd: ROOT, stdio: "inherit" });
}
if (!existsSync(path.join(STANDALONE, "index.html"))) throw new Error(`no build at ${STANDALONE}`);

let passed = 0,
  failed = 0;
const failures = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(e.stack || e).split("\n").slice(0, 4).join("\n       ")}`);
  }
}
function assert(ok, msg, detail) {
  if (!ok) throw new Error(msg + (detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""));
}

// crane geometry (src/world/backdrop/cranes.js)
const LADDER = { x: 19.35, z: 7.35, top: 3.6 };
const LANE = [6.55, 7.39]; // stair lane centre lines (z)
const G = 20.05, // x on the ladder-side landings
  J = 26.95; // x on the far landings
const LANDINGS = [
  [G, 3.6],
  [J, 6.9],
  [G, 10.2],
  [J, 13.5],
  [G, 16.8],
  [J, 20.1],
];
const DECK = { x: 22.95, y: 21.9 };
const WALK_Z = 2.7;

const web = await serve([["/", STANDALONE]]);
const browser = await launch();
const PLAYING = `window.__ready && window.__G && window.__G.game && window.__G.game.state === "playing"`;
const errorsOf = (page) => page.logs.filter((l) => /^EXC|^error:/.test(l) && !/favicon|ERR_CONNECTION_REFUSED/.test(l));
async function shot(page, name) {
  writeFileSync(path.join(OUT, `ladder-${name}.jpg`), await page.screenshot());
}

const page = await browser.open(`${web.url}/?q=low&noaudio=1&autostart=1`, { wait: PLAYING, window: true });
// test helpers inside the page: teleport, state, a waypoint autopilot that steers while W is held
await page.ev(`
  const g = __G, p = g.player;
  window.L = {
    safe() { p.invulnerable = true; p.health = p.maxHealth; g.enemies && g.enemies.clear && g.enemies.clear(); },
    tp(x, y, z, yaw = 0, pitch = 0) { p.reset({ pos: new p.pos.constructor(x, y, z), yaw }); p.pitch = pitch; L.safe(); },
    st() { return { x: p.pos.x, y: p.pos.y, z: p.pos.z, on: p.onLadder, cl: p.climbing, g: p.onGround, yaw: p.yaw }; },
    events: [],
    route: null, idx: 0, trace: [],
    go(pts) { L.route = pts; L.idx = 0; L.trace = []; },
  };
  g.events.on("player:ladder", (e) => L.events.push((e.on ? "on:" + e.from : "off:" + e.how)));
  g.frameHooks.push(() => {
    const r = L.route; if (!r) return;
    if (L.idx >= r.length) { L.route = null; return; }
    const [tx, tz] = r[L.idx], dx = tx - p.pos.x, dz = tz - p.pos.z, d = Math.hypot(dx, dz);
    L.trace.push([+p.pos.x.toFixed(2), +p.pos.y.toFixed(2), +p.pos.z.toFixed(2)]);
    if (d < 0.18) { L.idx++; return; }
    p.yaw = Math.atan2(-dx, -dz); p.pitch = 0;
  });
`);
await page.ev(`L.safe()`);
await sleep(500);

// hold W along a route; resolves when the route is done (or stalls)
async function walkRoute(pts, ms = 40000) {
  await page.ev(`L.go(${JSON.stringify(pts)})`);
  await page.keyDown("KeyW");
  const t0 = Date.now();
  let last = null,
    still = 0;
  try {
    while (Date.now() - t0 < ms) {
      await sleep(250);
      const s = await page.ev(`L.safe(); return { done: !L.route, idx: L.idx, ...L.st() }`);
      if (s.done) break;
      if (last && Math.hypot(s.x - last.x, s.z - last.z) + Math.abs(s.y - last.y) < 0.02) still++;
      else still = 0;
      if (still > 12) throw new Error(`stalled at waypoint ${s.idx} ${JSON.stringify(pts[s.idx])} — ${JSON.stringify(s)}`);
      last = s;
    }
  } finally {
    await page.keyUp("KeyW");
  }
  await sleep(150);
  return page.ev(`L.route = null; return { trace: L.trace, ...L.st() }`);
}

// from the ladder-top landing up every flight to the deck (lane 0 goes +x, lane 1 goes -x)
const UP = [
  [G, LANE[0]],
  [J, LANE[0]],
  [J, LANE[1]],
  [G, LANE[1]],
  [G, LANE[0]],
  [J, LANE[0]],
  [J, LANE[1]],
  [G, LANE[1]],
  [G, LANE[0]],
  [J, LANE[0]],
  [J, LANE[1]],
  [DECK.x, LANE[1]],
  [DECK.x, WALK_Z],
];

try {
  console.log("crane ladder / stair tower");

  await test("ladder registered; landings, deck, walkways have ground; spawns and ground nav untouched", async () => {
    const r = await page.ev(`
      const P = __G.physics, gh = (x, z, y) => P.groundHeight(x, z, y + 0.1);
      const pts = ${JSON.stringify([
        ...LANDINGS.map(([x, y]) => [x, (LANE[0] + LANE[1]) / 2, y]),
        [DECK.x, 5, DECK.y],
        [21, WALK_Z, 21.9],
        [27.3, WALK_Z, 21.9],
        [23, 4.5, 13.55],
        [19.35, 0, 13.5],
        [27, 5.5, 13.5],
      ])};
      return {
        ladders: P.ladders.map(l => l.id),
        ground: pts.map(([x, z, y]) => [x, z, y, gh(x, z, y)]),
        // a few steps along the first flight rise monotonically
        flight: [21, 22, 23, 24, 25, 26].map(x => gh(x, ${LANE[0]}, 7)),
        // the quay under the tower stays walkable for enemies (nav ignores boxes above 1.5 m)
        nav: [[21, 7.1], [23, 7.1], [25, 6.6]].map(([x, z]) => P.nav.isWalkable(x, z)),
        highNav: P.boxes.filter(b => b.tag === "backdrop" && !b.noNav && !b.bulletOnly && b.min.y <= 1.5 && b.max.y >= 0.47 && b.min.x > 19.45 && b.max.x < 28 && b.min.z > 6).length,
      };`);
    assert(r.ladders.includes("crane-ladder"), "crane ladder registered", r.ladders);
    for (const [x, z, y, h] of r.ground) assert(Math.abs(h - y) < 0.06, `ground at ${x},${z} is ${y}`, h);
    for (let i = 1; i < r.flight.length; i++) assert(r.flight[i] > r.flight[i - 1] + 0.3, "first flight rises", r.flight);
    assert(r.flight[0] > 3.6 && r.flight[5] < 6.95, "first flight between landings", r.flight);
    assert(r.nav.every(Boolean), "ground nav around the tower", r.nav);
    assert(r.highNav === 0, "no new ground-level blockers under the tower", r.highNav);
    const bad = await page.ev(`
      const P = __G.physics, S = ${JSON.stringify(DUEL_SPAWNS)}, R = 0.4, bad = [];
      for (const [x, z] of S) {
        const y = P.groundHeight(x, z, 3);
        const blocked = P.boxes.some(b => !b.bulletOnly && x > b.min.x - R && x < b.max.x + R && z > b.min.z - R && z < b.max.z + R && b.min.y < y + 1.8 && b.max.y > y + 0.25);
        if (!P.nav.isWalkable(x, z) || blocked || y > 0.6) bad.push({ x, z, y });
      }
      return bad;`);
    assert(bad.length === 0, "duel spawns ok", bad);
  });

  await test("E at the foot grabs the ladder, W climbs it and steps onto the 3.6 m landing; no firing on it", async () => {
    await page.ev(`L.tp(19.15, 0, 8.5, 0, 0); L.events.length = 0`);
    await sleep(400);
    const g0 = await page.ev(`return L.st()`);
    assert(g0.y < 0.05 && g0.g, "standing on the quay", g0);
    await page.press("KeyE", 80);
    await page.waitFor(`__G.player.onLadder === "crane-ladder"`, 2000);
    await sleep(400);
    const on = await page.ev(`return { ...L.st(), ammo: __G.weapon.ammo }`);
    assert(Math.abs(on.x - (LADDER.x - 0.36)) < 0.02 && Math.abs(on.z - LADDER.z) < 0.02 && on.cl, "hangs on the ladder", on);
    // fire is blocked while climbing
    await page.keyDown("Enter");
    await sleep(350);
    await page.keyUp("Enter");
    const ammo = await page.ev(`return __G.weapon.ammo`);
    assert(ammo === on.ammo, "no shots on the ladder", { before: on.ammo, after: ammo });
    // climb a bit, screenshot looking up the rungs, then go over the top
    await page.keyDown("KeyW");
    await sleep(350);
    await page.keyUp("KeyW");
    const mid = await page.ev(`return L.st()`);
    assert(mid.y > on.y + 0.4 && mid.on, "W climbs", { on, mid });
    await page.ev(`__G.player.pitch = 0.25`);
    await sleep(250);
    await shot(page, "on-ladder");
    await page.keyDown("KeyW");
    await page.waitFor(`__G.player.pos.y > 3.5 && !__G.player.climbing`, 6000).finally(() => page.keyUp("KeyW"));
    await sleep(300);
    const top = await page.ev(`return { ...L.st(), ev: L.events.slice() }`);
    assert(Math.abs(top.y - 3.6) < 0.05 && top.g && top.x > 19.6 && !top.on, "on the first landing", top);
    assert(top.ev.includes("on:bottom") && top.ev.includes("off:top"), "ladder events", top.ev);
  });

  await test("W + Space also grabs it; S climbs down and steps off at the bottom; Space jumps off", async () => {
    await page.ev(`L.tp(19.15, 0, 8.5, 0, 0); L.events.length = 0`);
    await sleep(400);
    await page.keyDown("KeyW");
    await sleep(60);
    await page.press("Space", 80);
    await page.waitFor(`__G.player.onLadder === "crane-ladder"`, 2000);
    await sleep(500);
    await page.keyUp("KeyW");
    const up = await page.ev(`return L.st()`);
    assert(up.on && up.y > 1.6, "attached and climbing", up);
    await page.keyDown("KeyS");
    await page.waitFor(`!__G.player.onLadder`, 4000).finally(() => page.keyUp("KeyS"));
    await sleep(300);
    const down = await page.ev(`return { ...L.st(), ev: L.events.slice(), hp: __G.player.health }`);
    assert(down.g && down.ev.includes("off:bottom") && down.y < 1.6, "stepped off at the bottom", down);
    // grab again and jump off backwards
    await page.ev(`L.tp(19.15, 0, 8.5, 0, 0); L.events.length = 0`);
    await sleep(300);
    await page.press("KeyE", 80);
    await page.waitFor(`__G.player.onLadder`, 2000);
    await page.keyDown("KeyW");
    await sleep(500);
    await page.keyUp("KeyW");
    await page.press("Space", 80);
    await sleep(1200);
    const off = await page.ev(`return { ...L.st(), ev: L.events.slice() }`);
    assert(off.ev.includes("off:jump") && !off.on && off.g && off.x < LADDER.x - 0.5, "jumped off backwards", off);
  });

  await test("walk the landing and every stair flight up to the deck and the boom walkway", async () => {
    await page.ev(`L.tp(19.9, 3.6, 7.35, -Math.PI / 2, 0)`);
    await sleep(400);
    const r = await walkRoute(UP);
    assert(Math.abs(r.y - 21.9) < 0.05 && Math.abs(r.z - WALK_Z) < 0.3, "on the boom walkway", r);
    // passed every landing at its height
    for (const [x, y] of LANDINGS)
      assert(r.trace.some(([tx, ty]) => Math.abs(tx - x) < 0.6 && Math.abs(ty - y) < 0.05), `reached landing ${y}`);
    const ys = r.trace.map((t) => t[1]);
    const drops = ys.slice(1).filter((y, i) => y < ys[i] - 0.3);
    assert(drops.length === 0, "never fell", drops);
    await page.ev(`__G.player.yaw = Math.PI * 0.75; __G.player.pitch = -0.15`);
    await sleep(300);
    await shot(page, "walkway");
  });

  await test("the boom walkway is closed off before the sea; the deck rails hold", async () => {
    await page.ev(`L.tp(26, 21.9, ${WALK_Z}, -Math.PI / 2, 0)`);
    await sleep(300);
    const r = await walkRoute([[33, WALK_Z]], 2500).catch((e) => ({ err: String(e) }));
    const s = await page.ev(`return L.st()`);
    assert(s.x < 28 && Math.abs(s.y - 21.9) < 0.05, "stopped by the leg-top beam", { r: r.err, s });
    // push against each deck rail
    for (const [tx, tz] of [
      [20, 6],
      [26, 6],
      [DECK.x, 9],
    ]) {
      await page.ev(`L.tp(${DECK.x}, 21.9, 5.5, 0, 0)`);
      await sleep(200);
      await walkRoute([[tx, tz]], 1500).catch(() => {});
      const d = await page.ev(`return L.st()`);
      assert(Math.abs(d.y - 21.9) < 0.05 && d.x > 22.5 && d.x < 23.4 && d.z < 7.8, `deck rail toward ${tx},${tz}`, d);
    }
  });

  await test("the mid-level beam walkway is walkable and railed", async () => {
    await page.ev(`L.tp(${J}, 13.5, ${LANE[0]}, 0, 0)`);
    await sleep(300);
    const r = await walkRoute([
      [27.05, 5.4],
      [27.05, 4.5],
      [20.2, 4.5],
      [19.34, 4.4],
      [19.34, 3.3],
      [19.34, -4.1],
    ]);
    assert(Math.abs(r.y - 13.5) < 0.05 && r.z < -3.9, "crossed to the far side at 13.5", r);
    const low = r.trace.filter((t) => t[1] < 13.4);
    assert(!low.length, "stayed on the beams", low.slice(0, 3));
    await walkRoute([[17, -4.1]], 1500).catch(() => {});
    const s = await page.ev(`return L.st()`);
    assert(s.x > 19.2 && Math.abs(s.y - 13.5) < 0.05, "outer edge railed", s);
  });

  await test("walk back down every flight and climb down the ladder from the top", async () => {
    await page.ev(`L.tp(${DECK.x}, 21.9, ${WALK_Z}, 0, 0); L.events.length = 0`);
    await sleep(300);
    const down = [...UP].reverse().slice(1);
    const r = await walkRoute([...down, [20.1, 7.35]]);
    assert(Math.abs(r.y - 3.6) < 0.05, "back on the first landing", r);
    // walking into the opening at the top grabs the ladder
    await page.ev(`__G.player.yaw = Math.PI / 2; __G.player.pitch = -0.3`);
    await sleep(100);
    await page.keyDown("KeyW");
    await page.waitFor(`__G.player.onLadder`, 3000).finally(() => page.keyUp("KeyW"));
    await sleep(600);
    const on = await page.ev(`return { ...L.st(), ev: L.events.slice() }`);
    assert(on.on && on.ev.includes("on:top") && Math.abs(on.x - (LADDER.x - 0.36)) < 0.02, "grabbed from the top", on);
    await page.keyDown("KeyS");
    await page.waitFor(`!__G.player.onLadder`, 4000).finally(() => page.keyUp("KeyS"));
    await sleep(300);
    const off = await page.ev(`return { ...L.st(), ev: L.events.slice(), hp: __G.player.health }`);
    assert(off.g && off.y < 1.6 && off.ev.includes("off:bottom"), "down at the foot", off);
    // E from the top also works
    await page.ev(`L.tp(19.9, 3.6, 7.35, Math.PI / 2, 0); L.events.length = 0`);
    await sleep(300);
    await page.press("KeyE", 80);
    await page.waitFor(`__G.player.onLadder`, 2000);
    assert((await page.ev(`return L.events.slice()`)).includes("on:top"), "E grabs from the top");
    await sleep(500);
    await page.press("KeyE", 80);
    await sleep(900);
    const drop = await page.ev(`return L.st()`);
    assert(!drop.on && drop.g, "E lets go", drop);
  });

  await test("no page errors", async () => {
    assert(errorsOf(page).length === 0, "no page errors", errorsOf(page));
  });
} finally {
  page.close();
  browser.kill();
  web.close && web.close();
}
console.log(`\n${passed} passed, ${failed} failed${failures.length ? ": " + failures.join("; ") : ""}`);
process.exit(failed ? 1 : 0);
