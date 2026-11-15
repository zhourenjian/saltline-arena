// Browser tests for the main menu, character select, climbing and the 1v1 duel, against the
// real standalone build and the real duel server (two headless Chrome pages):
//   node tests/modes.test.mjs            (builds first if dist/ is missing)
//   node tests/modes.test.mjs --build    (always rebuild)
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./lib/browser.mjs";
import { serve } from "./lib/serve.mjs";
import { startDuelServer } from "../server/duel-server.mjs";
import { DUEL_RULES, DUEL_SPAWNS } from "../src/versus/rules.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/out");
// SALTLINE_DIST=/some/dir tests a build made elsewhere (<dir>/standalone, <dir>/world-package)
const DIST = process.env.SALTLINE_DIST ? path.resolve(process.env.SALTLINE_DIST) : path.join(ROOT, "dist");
const STANDALONE = path.join(DIST, "standalone");
mkdirSync(OUT, { recursive: true });
if (process.argv.includes("--build") || !existsSync(STANDALONE)) {
  if (process.env.SALTLINE_DIST) throw new Error(`no build in ${DIST} (SALTLINE_DIST)`);
  console.log("building (npm run build) ...");
  execSync("npm run build", { cwd: ROOT, stdio: "inherit" });
}

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

const web = await serve([["/", STANDALONE]]);
const duel = startDuelServer({ port: 0, host: "127.0.0.1", quiet: true });
const duelPort = await duel.ready;
const browser = await launch();
const pages = [];
const TITLE = `window.__ready && window.__G && window.__G.game && window.__G.game.state === "title"`;
const PLAYING = `window.__ready && window.__G && window.__G.game && window.__G.game.state === "playing"`;

async function open(query, wait = TITLE) {
  const page = await browser.open(`${web.url}/?q=low&noaudio=1${query ? "&" + query : ""}`, { wait, window: true });
  pages.push(page);
  return page;
}
const screen = (page) => page.ev(`return __G.game.menus.screen`);
const act = (page, a) => page.ev(`document.querySelector('.menu [data-act="${a}"]').click()`);
async function shot(page, name) {
  writeFileSync(path.join(OUT, `modes-${name}.jpg`), await page.screenshot());
}
const errorsOf = (page) => page.logs.filter((l) => /^EXC|^error:/.test(l) && !/favicon|ERR_CONNECTION_REFUSED/.test(l));

try {
  console.log("main menu / character select");

  await test("title menu: Play first; Mission and 1v1 one tap deeper under More modes", async () => {
    const page = await open("");
    assert((await screen(page)) === "title", "title screen");
    const acts = await page.ev(
      `return [...document.querySelectorAll('.menu [data-s="title"] [data-act]')].filter(b => b.offsetParent).map(b => b.dataset.act)`,
    );
    assert(acts[0] === "brawl", "Play (brawl) is the first button", acts);
    for (const a of ["brawl", "character", "settings", "more"]) assert(acts.includes(a), `button ${a}`, acts);
    assert(!acts.includes("deploy") && !acts.includes("versus"), "Mission and 1v1 are folded away", acts);
    await act(page, "more");
    const deeper = await page.ev(`return [...document.querySelectorAll('.menu [data-s="title"] .m-more [data-act]')].filter(b => b.offsetParent).map(b => b.dataset.act)`);
    assert(deeper.includes("deploy") && deeper.includes("versus"), "More modes shows Mission and 1v1", deeper);
    await act(page, "controls");
    const help = await page.ev(`return document.getElementById('ui').textContent`);
    assert(/Climb/.test(help), "controls mention climbing");
    await page.ev(`__G.game.menus.closePanel()`);
    await shot(page, "title");
  });

  await test("nothing covers the menu buttons: the label and the padding both hit the button", async () => {
    const page = pages[0];
    // a grid of points over every visible button; each must land on the button or its own text
    const probe = `
      const bad = [];
      for (const b of document.querySelectorAll('.menu [data-s="' + __G.game.menus.screen + '"] button, .menu [data-s="' + __G.game.menus.screen + '"] [data-act]')) {
        const r = b.getBoundingClientRect();
        if (!b.offsetParent || r.width < 4 || r.height < 4) continue;
        for (const fx of [0.15, 0.5, 0.85]) for (const fy of [0.3, 0.5, 0.7]) {
          const e = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
          if (e !== b && !b.contains(e)) bad.push([b.dataset.act || b.textContent.trim(), fx, fy, e && (e.className || e.tagName)]);
        }
      }
      return bad;`;
    for (const scr of ["title", "character", "brawl"]) {
      if (scr !== "title") await act(page, scr);
      await page.waitFor(`__G.game.menus.screen === ${JSON.stringify(scr)}`, 3000);
      await sleep(scr === "character" ? 800 : 200);
      const bad = await page.ev(probe);
      assert(bad.length === 0, `${scr}: buttons covered`, bad);
      if (scr !== "title") {
        await page.keyDown("Escape");
        await page.keyUp("Escape");
        await page.waitFor(`__G.game.menus.screen === "title"`, 3000);
      }
    }
  });

  await test("character select: list, live preview, wear, persist, Escape back", async () => {
    const page = pages[0];
    await act(page, "character");
    assert((await screen(page)) === "character", "character screen");
    await page.waitFor(`document.querySelectorAll('.ch-item').length >= 2`, 8000);
    const items = await page.ev(`return [...document.querySelectorAll('.ch-item')].map(b => b.dataset.character)`);
    // index.html shows only the two tactical characters (window.SaltlineCharacters hides the rest)
    assert(!items.includes(""), "no built-in operator entry", items);
    for (const id of ["swat-operator", "masked-raider"]) assert(items.includes(id), `lists ${id}`, items);
    assert(items.length === 2, "two characters", items);
    // a fresh player wears the configured default
    await page.waitFor(`DuoWorld.getAvatar() && DuoWorld.getAvatar().id === "swat-operator" && __G.characters.previewing === "swat-operator"`, 30000);
    await page.ev(`document.querySelector('.ch-item[data-character="masked-raider"]').click()`);
    await page.waitFor(`__G.characters.choice === "masked-raider" && DuoWorld.getAvatar() && DuoWorld.getAvatar().id === "masked-raider"`, 30000);
    await page.waitFor(`__G.characters.previewing === "masked-raider"`, 30000);
    const view = await page.ev(`
      const c = __G.camera;
      const saved = JSON.parse(localStorage.getItem("saltline.character.v1"));
      return { saved, chip: document.querySelector('[data-f="char-name"]').textContent, sel: document.querySelector('.ch-item[aria-selected="true"]').dataset.character, cam: [c.position.x, c.position.y, c.position.z] };`);
    assert(view.saved && view.saved.id === "masked-raider", "choice saved", view);
    assert(view.sel === "masked-raider", "selected in list", view);
    await sleep(600);
    await shot(page, "character");
    // the preview is on screen: project its root into NDC
    const ndc = await page.ev(`
      const c = __G.camera; let found = null;
      for (const o of __G.scene.children) if (o.isObject3D && o.visible && o.name !== "DuoWorld:PlayerControlRoot" && o.position.distanceTo(c.position) < 4.5 && o.position.distanceTo(c.position) > 1.5) found = o;
      if (!found) return null; const v = found.position.clone(); v.y += 1; v.project(c); return [v.x, v.y, v.z, found.name, found.scale.y];`);
    assert(ndc && Math.abs(ndc[0]) < 0.9 && Math.abs(ndc[1]) < 0.9 && ndc[2] < 1, "preview model is in view", ndc);
    // the preview is the same height-normalized body the player and the opponent wear (these packages are already 1.75 m)
    assert(ndc[3] === "DuoWorld:HeightNormalize" && Math.abs(ndc[4] - 1) < 0.05, "preview is height-normalized", ndc);
    await page.keyDown("Escape");
    await page.keyUp("Escape");
    await page.waitFor(`__G.game.menus.screen === "title"`, 3000);
    await page.waitFor(`__G.characters.previewing === undefined`, 3000);
    const chip = await page.ev(`return document.querySelector('[data-f="char-name"]').textContent`);
    const worn = await page.ev(`return DuoWorld.getAvatar().name`);
    assert(chip.includes(worn), "title shows the worn character", { chip, worn });
    assert(errorsOf(page).length === 0, "no page errors", errorsOf(page));
  });

  await test("saved character is worn again after a reload; a saved choice that is no longer offered falls back to the default", async () => {
    const page = await open("");
    await page.waitFor(`DuoWorld.getAvatar() && DuoWorld.getAvatar().id === "masked-raider"`, 30000);
    // an old save of the operator or a hidden package
    for (const old of [null, "no-such-avatar"]) {
      await page.ev(`localStorage.setItem("saltline.character.v1", JSON.stringify({ id: ${JSON.stringify(old)} }))`);
      const again = await open("");
      await again.waitFor(`DuoWorld.getAvatar() && DuoWorld.getAvatar().id === "swat-operator"`, 30000);
      again.close();
    }
    page.close();
    // ?avatar= wins over the saved choice
    const param = await open("avatar=masked-raider");
    await param.waitFor(`DuoWorld.getAvatar() && DuoWorld.getAvatar().id === "masked-raider"`, 30000);
    param.close();
  });

  await test("mission → pause → main menu returns to the title", async () => {
    const page = pages[0];
    await act(page, "deploy");
    await page.waitFor(PLAYING, 20000);
    await page.ev(`__G.game.pause()`);
    await page.waitFor(`__G.game.menus.screen === "paused"`, 3000);
    const visible = await page.ev(`return [...document.querySelectorAll('.menu [data-s="paused"] [data-act]')].filter(b => b.offsetParent).map(b => b.dataset.act)`);
    assert(visible.includes("quit"), "pause offers Main menu", visible);
    await act(page, "quit");
    await page.waitFor(`__G.game.state === "title" && __G.game.menus.screen === "title"`, 5000);
    assert((await page.ev(`return __G.game.mode`)) === "mission", "mode reset");
  });

  console.log("climbing");

  await test("W + Space at a container edge climbs onto it; walls too tall are refused", async () => {
    const page = await open("autostart=1", PLAYING);
    await page.ev(`__G.player.invulnerable = true; __G.enemies.clear && __G.enemies.clear()`);
    // candidate ledges: solid boxes 0.8–1.5 m tall standing on the ground, with room on top
    const cands = await page.ev(`
      const P = __G.physics, out = [];
      for (const b of P.boxes) {
        if (b.bulletOnly || b.playerOnly) continue;
        const h = b.max.y, sx = b.max.x - b.min.x, sz = b.max.z - b.min.z;
        if (b.min.y > 0.2 || h < 0.8 || h > 1.5 || sx < 1.4 || sz < 1.4) continue;
        const cz = (b.min.z + b.max.z) / 2, x = b.min.x - 0.75;
        if (P.groundHeight(x, cz, 0.5) > 0.1 || !P.nav.isWalkable(x - 1, cz)) continue;
        if (Math.abs(P.groundHeight(b.min.x + 0.7, cz, h + 0.5) - h) > 0.05) continue;
        out.push({ x, z: cz, top: h, d: Math.hypot(x + 32, cz - 6) });
      }
      return out.sort((a, b) => a.d - b.d).slice(0, 6);`);
    assert(cands.length > 0, "found a ledge to test");
    let done = null;
    const tries = [];
    for (const c of cands) {
      await page.ev(`
        const p = __G.player; p.pos.set(${c.x}, 0, ${c.z}); p.vel.set(0,0,0); p.yaw = -Math.PI / 2; p.pitch = 0;
        window.__climbs = []; window.__offClimb && window.__offClimb();
        window.__climbEnd = null;
        window.__offClimb = __G.events.on("player:climb", e => { __climbs.push(e.phase); e.phase === "end" && (__climbEnd = { x: __G.player.pos.x, y: __G.player.pos.y }); });`);
      await sleep(350);
      await page.keyDown("KeyW");
      await sleep(60);
      await page.press("Space", 90);
      await page.waitFor(`__climbEnd || !__climbs.length`, 1500).catch(() => {});
      await page.keyUp("KeyW");
      await sleep(250);
      const r = await page.ev(`const e = __climbEnd || __G.player.pos; return { y: e.y, x: e.x, phases: __climbs, ground: __G.player.onGround, nowY: __G.player.pos.y }`);
      tries.push({ c, r });
      if (r.phases.includes("start") && r.phases.includes("end")) {
        done = { c, r };
        break;
      }
    }
    assert(done, "climbed one of the ledges", tries);
    assert(Math.abs(done.r.y - done.c.top) < 0.08 && Math.abs(done.r.nowY - done.c.top) < 0.08 && done.r.ground, "stands on top", done);
    assert(done.r.x > done.c.x + 0.6, "moved onto the box", done);
    await shot(page, "climb");
    // a 2.6 m wall cannot be mantled
    const wall = await page.ev(`
      const P = __G.physics;
      for (const b of P.boxes) {
        if (b.bulletOnly || b.playerOnly || b.min.y > 0.2 || b.max.y < 3) continue;
        const cz = (b.min.z + b.max.z) / 2, x = b.min.x - 0.6;
        if (b.max.z - b.min.z < 2 || P.groundHeight(x, cz, 0.5) > 0.1 || !P.nav.isWalkable(x - 1, cz)) continue;
        return { x, z: cz, top: b.max.y };
      }
      return null;`);
    if (wall) {
      await page.ev(`const p = __G.player; p.pos.set(${wall.x}, 0, ${wall.z}); p.vel.set(0,0,0); p.yaw = -Math.PI / 2; __climbs.length = 0;`);
      await sleep(300);
      await page.keyDown("KeyW");
      await page.press("Space", 90);
      await sleep(900);
      await page.keyUp("KeyW");
      const r = await page.ev(`return { y: __G.player.pos.y, phases: __climbs }`);
      assert(!r.phases.includes("start") && r.y < 1.5, "tall wall refused", { wall, r });
    }
    assert(errorsOf(page).length === 0, "no page errors", errorsOf(page));
    page.close();
  });

  console.log("1v1 duel (two pages, real server)");

  await test("all duel spawns are walkable and clear", async () => {
    const page = pages[0];
    const bad = await page.ev(`
      const P = __G.physics, S = ${JSON.stringify(DUEL_SPAWNS)}, R = 0.4, bad = [];
      for (const [x, z] of S) {
        const y = P.groundHeight(x, z, 3);
        const blocked = P.boxes.some(b => !b.bulletOnly && x > b.min.x - R && x < b.max.x + R && z > b.min.z - R && z < b.max.z + R && b.min.y < y + 1.8 && b.max.y > y + 0.25);
        if (!P.nav.isWalkable(x, z) || blocked || y > 0.6) bad.push({ x, z, y, walk: P.nav.isWalkable(x, z), blocked });
      }
      return bad;`);
    assert(bad.length === 0, "spawns ok", bad);
  });

  const server = `ws://127.0.0.1:${duelPort}`;
  let A, B;
  await test("create a room, join it by code, countdown, then live", async () => {
    A = await open(`server=${encodeURIComponent(server)}`);
    B = await open(`server=${encodeURIComponent(server)}`);
    await act(A, "versus");
    assert((await screen(A)) === "versus", "duel screen");
    assert((await A.ev(`return document.querySelector('[data-f="vs-server"]').value`)) === server, "?server= prefilled");
    await A.ev(`document.querySelector('[data-f="vs-name"]').value = "Alpha"`);
    await act(A, "vs-create");
    await A.waitFor(`__G.versus.room && __G.versus.room.code`, 8000);
    const code = await A.ev(`return __G.versus.room.code`);
    assert(/^[A-Z2-9]{4}$/.test(code), "room code", code);
    assert((await A.ev(`return document.querySelector('[data-f="vs-room-code"]').textContent`)) === code, "code shown");
    await shot(A, "lobby");
    await act(B, "versus");
    await B.ev(`document.querySelector('[data-f="vs-name"]').value = "Bravo"; document.querySelector('[data-f="vs-code"]').value = "${code.toLowerCase()}"`);
    await act(B, "vs-join");
    await Promise.all([A.waitFor(PLAYING, 8000), B.waitFor(PLAYING, 8000)]);
    assert((await A.ev(`return __G.game.mode`)) === "versus", "versus mode");
    assert((await A.ev(`return __G.player.enabled`)) === false, "frozen during countdown");
    const hudText = await A.ev(`return __G.versus.hud.text`);
    assert(/Bravo/.test(hudText), "countdown names the opponent", hudText);
    const noRelays = await A.ev(`return getComputedStyle(document.querySelector('.h-relays')).display`);
    assert(noRelays === "none", "relay counter hidden");
    await Promise.all([A.waitFor(`__G.versus.match && __G.versus.match.live && __G.player.enabled`, 6000), B.waitFor(`__G.versus.match && __G.versus.match.live`, 6000)]);
    const enemies = await A.ev(`return __G.enemies.list ? __G.enemies.list.length : (__G.enemies.count || 0)`);
    assert(!enemies, "no AI enemies in a duel", enemies);
    const p = await Promise.all([A, B].map((pg) => pg.ev(`return [__G.player.pos.x, __G.player.pos.z]`)));
    assert(Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) > 8, "spawned apart", p);
  });

  // put both players in the open: A at the quay end looking +X, B 9 m in front
  const place = async () => {
    await B.ev(`const p = __G.player; p.pos.set(-23, 0, 6); p.vel.set(0,0,0); p.yaw = Math.PI / 2;`);
    await A.ev(`const p = __G.player; p.pos.set(-32, 0, 6); p.vel.set(0,0,0); p.yaw = -Math.PI / 2;`);
    await A.waitFor(`__G.versus.opponent.visible && __G.versus.opponent.pos.distanceTo(new __G.player.pos.constructor(-23, 0, 6)) < 0.3`, 5000);
  };
  const aimA = (y) =>
    A.ev(`const p = __G.player, o = __G.versus.opponent.pos; const dx = o.x - p.pos.x, dz = o.z - p.pos.z, d = Math.hypot(dx, dz);
      p.yaw = Math.atan2(-dx, -dz); p.pitch = Math.atan2(o.y + ${y} - p.eye.y, d);`);

  await test("opponent is visible with their character, shots hit, server applies damage", async () => {
    await B.ev(`await DuoWorld.setAvatar("masked-raider"); __G.events.emit("character:change", { id: "masked-raider" })`);
    await A.waitFor(`__G.versus.peer && __G.versus.peer.avatar === "masked-raider"`, 5000);
    await A.waitFor(`__G.versus.opponent.avatarId === "masked-raider"`, 30000);
    await place();
    await sleep(300);
    const los = await A.ev(`const e = __G.player.eye.clone(), o = __G.versus.opponent.pos.clone(); o.y += 1.2; const d = o.clone().sub(e); const L = d.length(); const r = __G.physics.raycast(e, d.normalize(), L); return r ? r.dist : null`);
    assert(los === null, "clear line of sight for the test", los);
    await shot(A, "opponent");
    await aimA(1.15);
    await sleep(120);
    const hp0 = await B.ev(`return __G.player.health`);
    await A.press("Enter", 70);
    await B.waitFor(`__G.player.health < ${hp0}`, 3000);
    const hp1 = await B.ev(`return __G.player.health`);
    const dmg = hp0 - hp1, D = DUEL_RULES.damage;
    // the key press may fire once or twice: every total must be built from server damage values
    assert([D.body, D.head, 2 * D.body, D.body + D.head, 2 * D.head].includes(dmg), "rifle hit = server damage", { hp0, hp1 });
    const marker = await A.ev(`return document.querySelector('.h-hit').className`);
    assert(/on|hit/.test(marker), "hitmarker on the shooter", marker);
  });

  await test("five kills end the match with the result screen on both sides", async () => {
    for (let kill = 0; kill < DUEL_RULES.killsToWin; kill++) {
      await B.waitFor(`__G.player.alive && __G.versus.match && __G.versus.match.live`, 8000);
      await place();
      await sleep(DUEL_RULES.spawnShieldSeconds * 1000 + 200);
      let tries = 0;
      while ((await B.ev(`return __G.player.alive`)) && tries++ < 12) {
        await aimA(1.6);
        await A.press("Enter", 140);
        await sleep(120);
        (await A.ev(`return __G.weapon.ammo`)) < 6 && (await A.press("KeyR", 60), await sleep(2600));
      }
      await B.waitFor(`!__G.player.alive`, 3000);
      const sc = await A.ev(`return __G.versus.match ? __G.versus.match.scores[__G.versus.id] : -1`);
      if (kill < DUEL_RULES.killsToWin - 1) {
        assert(sc === kill + 1, `score after kill ${kill + 1}`, sc);
        await B.waitFor(`/respawning in/i.test(__G.versus.hud.text)`, 2000);
        kill === 0 && (await shot(B, "respawn"));
      }
    }
    await Promise.all([A.waitFor(`__G.game.state === "over" && __G.game.menus.screen === "vs-result"`, 6000), B.waitFor(`__G.game.state === "over"`, 6000)]);
    const ra = await A.ev(`return [document.querySelector('[data-f="vsr-title"]').textContent, document.querySelector('[data-f="vsr-score"]').textContent]`);
    const rb = await B.ev(`return [document.querySelector('[data-f="vsr-title"]').textContent, document.querySelector('[data-f="vsr-score"]').textContent]`);
    assert(ra[0] === "Victory" && ra[1] === `${DUEL_RULES.killsToWin} : 0`, "winner screen", ra);
    assert(rb[0] === "Defeat" && rb[1] === `0 : ${DUEL_RULES.killsToWin}`, "loser screen", rb);
    await shot(A, "victory");
  });

  await test("rematch needs both players and resets the score", async () => {
    await act(A, "vs-rematch");
    await B.waitFor(`/wants a rematch/.test(document.querySelector('[data-f="vsr-status"]').textContent)`, 4000);
    await act(B, "vs-rematch");
    await Promise.all([A.waitFor(PLAYING, 6000), B.waitFor(PLAYING, 6000)]);
    const s = await A.ev(`return __G.versus.match.scores`);
    assert(Object.values(s).every((v) => !v), "fresh scores", s);
    assert((await B.ev(`return __G.player.health`)) === 100, "full health");
  });

  await test("falling damage goes through the server; leaving returns the peer to the lobby", async () => {
    await Promise.all([A.waitFor(`__G.versus.match.live`, 6000), B.waitFor(`__G.versus.match.live`, 6000)]);
    // self-inflicted damage (a fall) is reported as "hurt", not applied locally first
    await B.ev(`__G.player.damage(30, null)`);
    await B.waitFor(`__G.player.health === 70`, 3000);
    await B.ev(`__G.game.pause()`);
    await act(B, "quit");
    await B.waitFor(`__G.game.state === "title" && !__G.versus.client`, 4000);
    await A.waitFor(`__G.game.state === "title" && __G.game.menus.screen === "versus"`, 4000);
    const st = await A.ev(`return document.querySelector('[data-f="vs-status"]').textContent`);
    assert(/Bravo/.test(st) && /left/.test(st), "peer-left message", st);
    assert((await A.ev(`return __G.versus.room && __G.versus.room.players.length`)) === 1, "A still holds the room");
    await act(A, "vs-back");
    await A.waitFor(`!__G.versus.client && __G.game.menus.screen === "title"`, 3000);
    await sleep(200);
    assert(duel.hub.rooms.size === 0, "server cleaned up", duel.hub.rooms.size);
    for (const pg of [A, B]) assert(errorsOf(pg).length === 0, "no page errors", errorsOf(pg));
  });

  await test("a server that is not running gives a clear error", async () => {
    const page = await open(`server=${encodeURIComponent("ws://127.0.0.1:1")}`);
    await act(page, "versus");
    await act(page, "vs-create");
    await page.waitFor(`document.querySelector('[data-f="vs-status"]').classList.contains("err")`, 8000);
    const st = await page.ev(`return document.querySelector('[data-f="vs-status"]').textContent`);
    assert(/connect|closed|answer/i.test(st), "error text", st);
    assert((await page.ev(`return __G.game.state`)) === "title", "still on the menu");
  });
} finally {
  for (const p of pages) p.close();
  browser.kill();
  await duel.close();
  web.close();
}

console.log(`\n${passed} passed, ${failed} failed${failures.length ? ": " + failures.join("; ") : ""}`);
process.exit(failed ? 1 : 0);
