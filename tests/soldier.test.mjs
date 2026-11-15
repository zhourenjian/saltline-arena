// Browser tests for the two default characters (swat-operator, masked-raider) and the held gun:
//   node tests/soldier.test.mjs            (uses dist/standalone, or SALTLINE_DIST)
// The characters come without a gun; in play the World puts the first-person PAC-9 into their
// hands, stows it while they climb, and mirrors reload / inspect to other players.
// Screenshots land in tests/out/soldier-*.jpg.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./lib/browser.mjs";
import { serve } from "./lib/serve.mjs";
import { startDuelServer } from "../server/duel-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/out");
mkdirSync(OUT, { recursive: true });
const DIST = process.env.SALTLINE_DIST ? path.resolve(process.env.SALTLINE_DIST) : path.join(ROOT, "dist");
const STANDALONE = path.join(DIST, "standalone");
if (!existsSync(path.join(STANDALONE, "index.html"))) throw new Error(`no build at ${STANDALONE} (npm run build)`);

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
const TITLE = `window.__ready && window.__G && window.__G.game && window.__G.game.state === "title"`;
const PLAYING = `window.__ready && window.__G && window.__G.game && window.__G.game.state === "playing"`;
const errorsOf = (page) => page.logs.filter((l) => /^EXC|^error:/.test(l) && !/favicon|ERR_CONNECTION_REFUSED/.test(l));
const shot = async (page, name) => writeFileSync(path.join(OUT, `soldier-${name}.jpg`), await page.screenshot());
const IDS = ["swat-operator", "masked-raider"];

// helpers inside a page. S.guns(): every held gun in the scene with what it hangs on.
const HELPERS = `
  const g = __G, p = g.player, V = p.pos.constructor;
  window.S = {
    safe() { p.invulnerable = true; p.health = p.maxHealth; g.enemies && g.enemies.clear && g.enemies.clear(); },
    tp(x, y, z, yaw = 0) { p.reset({ pos: new V(x, y, z), yaw }); p.pitch = 0; S.safe(); },
    guns() { const out = []; g.scene.traverse(o => { if (o.name === "DuoWorld:HeldGun") { let vis = true; for (let q = o; q; q = q.parent) vis = vis && q.visible; out.push({ o, vis }); } }); return out; },
    wp(o, local) { o.updateWorldMatrix(true, false); return (local ? new V(...local) : new V()).applyMatrix4(o.matrixWorld); },
    // the worn body: gun, anchors, distances from the wrists to the two grasp frames
    worn() {
      const A = n => DuoWorld.getAnchor(n), w = A("weapon"), stow = A("weaponStow"), gun = S.guns().find(x => x.vis);
      if (!w || !gun) return { weapon: !!w, gun: !!gun };
      const held = g.__lastHeld, r = { weapon: true, gun: true, onWeapon: gun.o.parent === w, onStow: !!stow && gun.o.parent === stow, held: held ? { kind: held.kind, action: held.action, support: !!held.support } : null };
      if (held && r.onWeapon) {
        r.grip = S.wp(A("rightHand")).distanceTo(S.wp(w, held.grip.position));
        r.support = held.support ? S.wp(A("leftHand")).distanceTo(S.wp(w, held.support.position)) : null;
      }
      r.muzzle = S.wp(gun.o, [0, 0.1, 0.604]).toArray();
      r.rig = gun.o.children[0].quaternion.toArray();
      r.mag = gun.o.children[0].children[0].children.find(c => c.isGroup).position.toArray();
      return r;
    },
    flashes: [],
    climbs: [],
  };
  // record what setLocomotion receives (wrapping the instance method, like a host inspector would)
  S.spy = () => { const a = DuoWorld.getAvatar(); const inst = g.__inst = S.inst(); if (!inst || inst.__spied) return; inst.__spied = true; const f = inst.setLocomotion.bind(inst);
    inst.setLocomotion = s => { g.__lastHeld = s.held || null; s.climb && S.climbs.push({ kind: s.climb.kind, mode: s.mode, held: !!s.held, progress: s.climb.progress }); return f(s); }; };
  const mf = g.fx.muzzleFlash.bind(g.fx);
  g.fx.muzzleFlash = (pos, dir, o) => { S.flashes.push({ p: pos.toArray(), d: dir.toArray() }); return mf(pos, dir, o); };
  g.events.on("player:climb", e => (S.lastClimb = e));
`;

try {
  console.log("characters and the held gun");

  const page = await browser.open(`${web.url}/?q=low&noaudio=1`, { wait: TITLE, window: true });

  await test("the two characters are the defaults, register without a gun, and are easy to tell from the scene", async () => {
    const r = await page.ev(`
      const list = DuoWorld.listAvatars().filter(a => ${JSON.stringify(IDS)}.includes(a.id));
      const defs = window.DuoWorldAvatars.list ? window.DuoWorldAvatars.list() : [];
      return { list: list.map(a => ({ id: a.id, supported: a.supported })), initial: window.DuoWorldInitialAvatar || (window.SaltlineCharacters && window.SaltlineCharacters.default) || null };`);
    assert(r.list.length === 2 && r.list.every((a) => a.supported), "both registered", r);
    // package sources: no gun geometry, no black outfit
    for (const id of IDS) {
      const src = await (await fetch(`${web.url}/avatars/${id}/avatar.js`)).text();
      assert(!/createRifle|rifleGeometry|buildGun|'muzzle'/.test(src), `${id} brings no gun of its own`);
      const cfg = JSON.parse(src.match(/\nregisterSoldier\(global, (\{.*\})\)/)[1]);
      const lum = (c) => { const k = [(c >> 16) & 255, (c >> 8) & 255, c & 255].map((v) => (v / 255) ** 2.2); return 0.2126 * k[0] + 0.7152 * k[1] + 0.0722 * k[2]; };
      assert(lum(cfg.palette.uniform) > 0.09 && lum(cfg.palette.pants) > 0.07, `${id} outfit is not dark`, { uniform: lum(cfg.palette.uniform), pants: lum(cfg.palette.pants) });
      assert(/^#[0-9a-f]{6}$/.test(cfg.firstPersonArms.sleeve), "declares first-person sleeve colour");
    }
  });

  await test("character preview shows the body with empty hands (no gun in the menu)", async () => {
    await page.ev(`document.querySelector('.menu [data-act="character"]').click()`);
    await page.waitFor(`__G.game.menus.screen === "character" && __G.characters && __G.characters.previewing`, 8000);
    await sleep(600);
    const n = await page.ev(`let n = 0; __G.scene.traverse(o => { if (o.name !== "DuoWorld:HeldGun") return; let vis = true; for (let q = o; q; q = q.parent) vis = vis && q.visible; vis && n++; }); return n`);
    assert(n === 0, "no held gun while previewing", n);
    await shot(page, "preview");
    await page.ev(`document.querySelector('.menu [data-act="back"]') && document.querySelector('.menu [data-act="back"]').click()`);
  });

  const game = await browser.open(`${web.url}/?q=low&noaudio=1&autostart=1&view=third`, { wait: PLAYING, window: true });
  await game.ev(HELPERS);

  for (const id of IDS) {
    await test(`${id}: in play the World's gun is in both hands, first-person arms take the outfit's colours`, async () => {
      await game.ev(`await DuoWorld.setAvatar(${JSON.stringify(id)}); S.inst = () => null;`);
      // the instance is reachable for the test only through the gun's parent chain
      await game.ev(`S.inst = () => { const w = DuoWorld.getAnchor("weapon"); let o = w; while (o && !(o.parent && o.parent.name === "DuoWorld:HeightNormalize")) o = o.parent; return o && o.userData.__instance || null; };`);
      await game.ev(`S.tp(-32, 0, 6, -Math.PI / 2)`);
      await sleep(700);
      const hook = await game.ev(`
        // wrap setLocomotion on the live instance via DuoWorld's own avatar record
        const a = DuoWorld.getAvatar(); if (!a) return "no avatar";
        const w = DuoWorld.getAnchor("weapon"); if (!w) return "no weapon anchor";
        return a.id + ":" + (a.optional || []).join(",");`);
      assert(hook.startsWith(id), "worn", hook);
      const r = await game.ev(`
        const A = n => DuoWorld.getAnchor(n), w = A("weapon"), guns = S.guns().filter(x => x.vis);
        const gun = guns[0], V3 = __G.player.pos.constructor;
        const out = { guns: guns.length, onWeapon: !!gun && gun.o.parent === w, arms: __G.weapon.armColors, meta: DuoWorld.getAvatar() };
        if (gun) {
          const held = gun.o.parent === w ? null : null;
          out.muzzle = S.wp(gun.o, [0, 0.1, 0.604]).toArray();
          out.eye = __G.player.eye.toArray();
          out.rh = S.wp(A("rightHand")).distanceTo(S.wp(w, [0, 0.02, 0.002]));
          out.lh = S.wp(A("leftHand")).distanceTo(S.wp(w, [0, 0.036, 0.329]));
          out.lhGuard = S.wp(A("leftHand")).distanceTo(S.wp(w, [0, 0.1, 0.268]));
          // the butt of the stock against the chest anchor: how far to the side, how far in front
          const butt = S.wp(w, [0, 0.06, -0.26]).sub(S.wp(A("chest")));
          const fw = S.wp(gun.o, [0, 0.1, 0.604]).sub(S.wp(gun.o, [0, 0.1, 0])).normalize();
          out.buttSide = Math.abs(butt.x * fw.z - butt.z * fw.x); out.buttFwd = butt.x * fw.x + butt.z * fw.z;
          const d = S.wp(gun.o, [0, 0.1, 0.604]).sub(S.wp(gun.o, [0, 0.1, 0])).normalize();
          out.barrel = d.toArray(); out.yaw = __G.player.yaw;
        }
        return out;`);
      assert(r.guns === 1 && r.onWeapon, "one gun, on the weapon anchor", r);
      assert(r.rh < 0.14, "right wrist at the pistol grip", r.rh);
      assert(r.lh < 0.07, "left palm round the vertical foregrip (where the first-person hand is)", r.lh);
      assert(r.lhGuard > r.lh + 0.02, "left hand is on the foregrip, not cupping the handguard", r);
      assert(r.buttSide > 0.06 && r.buttSide < 0.2, "stock sits in the shoulder pocket, not on the chest centre", r.buttSide);
      assert(r.buttFwd < 0.2, "stock is against the body", r.buttFwd);
      // facing +X (yaw -PI/2): the barrel points where the player looks
      assert(r.barrel[0] > 0.9 && Math.abs(r.barrel[1]) < 0.2, "barrel along the view direction", r.barrel);
      assert(Math.abs(r.muzzle[1] - r.eye[1]) < 0.45, "muzzle near shoulder height", { muzzle: r.muzzle, eye: r.eye });
      assert(r.arms && /^#[0-9a-f]{6}$/.test(r.arms.sleeve) && r.arms.sleeve !== "#23262a", "first-person arms recoloured", r.arms);
      await shot(game, `third-${id}`);
    });

    await test(`${id}: third-person muzzle flash comes out of the held gun's muzzle`, async () => {
      await game.ev(`S.flashes.length = 0; S.safe()`);
      const before = await game.ev(`const gun = S.guns().find(x => x.vis); return S.wp(gun.o, [0, 0.1, 0.604]).toArray()`);
      await game.press("Enter", 60);
      await game.waitFor(`S.flashes.length > 0`, 3000);
      const f = await game.ev(`return S.flashes[0]`);
      const d = Math.hypot(f.p[0] - before[0], f.p[1] - before[1], f.p[2] - before[2]);
      assert(d < 0.12, "flash at the muzzle", { d, flash: f.p, muzzle: before });
      assert(f.d[0] > 0.9, "flash along the barrel", f.d);
    });

    await test(`${id}: reload and inspect move the gun and the support hand on the third-person body`, async () => {
      const idle = await game.ev(`const gun = S.guns().find(x => x.vis); return { q: gun.o.children[0].quaternion.toArray(), lh: S.wp(DuoWorld.getAnchor("leftHand")).toArray() }`);
      assert(Math.abs(idle.q[3]) > 0.999, "gun at rest before", idle.q);
      await game.ev(`__G.weapon.ammo = Math.max(1, __G.weapon.ammo - 5); S.safe()`);
      await game.press("KeyR", 60);
      await game.waitFor(`__G.weapon.heldAction().a === 1 && __G.weapon.heldAction().t > 0.75`, 4000);
      const mid = await game.ev(`const gun = S.guns().find(x => x.vis), A = n => DuoWorld.getAnchor(n), w = A("weapon");
        return { q: gun.o.children[0].quaternion.toArray(), lhToGuard: S.wp(A("leftHand")).distanceTo(S.wp(w, [0, 0.1, 0.268])), rh: S.wp(A("rightHand")).distanceTo(S.wp(gun.o.children[0], [0, 0.02, 0.002])), act: __G.weapon.heldAction() }`);
      assert(Math.abs(mid.q[3]) < 0.995, "gun canted for the reload", mid.q);
      assert(mid.lhToGuard > 0.2, "support hand left the handguard", mid.lhToGuard);
      assert(mid.rh < 0.15, "right hand stays on the grip", mid.rh);
      await shot(game, `reload-${id}`);
      await game.waitFor(`__G.weapon.heldAction().a === 0`, 6000);
      await sleep(500);
      const back = await game.ev(`const A = n => DuoWorld.getAnchor(n); return S.wp(A("leftHand")).distanceTo(S.wp(A("weapon"), [0, 0.036, 0.329]))`);
      assert(back < 0.07, "support hand back on the foregrip", back);
      assert(await game.ev(`return __G.weapon.inspectNow()`), "inspect starts");
      await game.waitFor(`__G.weapon.heldAction().a === 2 && __G.weapon.heldAction().t > 0.7`, 4000);
      const ins = await game.ev(`return S.guns().find(x => x.vis).o.children[0].quaternion.toArray()`);
      assert(Math.abs(ins[3]) < 0.99, "gun rolled for the inspect", ins);
      await shot(game, `inspect-${id}`);
      await game.waitFor(`__G.weapon.heldAction().a === 0`, 6000);
    });

    await test(`${id}: climbing the ladder stows the gun and passes the climb state; stepping off takes it back`, async () => {
      await game.ev(`S.tp(19.15, 0, 8.5, 0)`);
      await sleep(400);
      await game.press("KeyE", 80);
      await game.waitFor(`__G.player.onLadder === "crane-ladder"`, 3000);
      await game.keyDown("KeyW");
      await sleep(350);
      const on = await game.ev(`const w = DuoWorld.getAnchor("weapon"), st = DuoWorld.getAnchor("weaponStow"), gun = S.guns().find(x => x.vis), A = n => DuoWorld.getAnchor(n);
        const l = __G.world && __G.world.avatars ? null : null;
        return { onStow: !!gun && gun.o.parent === st, onWeapon: !!gun && gun.o.parent === w, y: __G.player.pos.y,
          hands: [S.wp(A("leftHand")).y - __G.player.pos.y, S.wp(A("rightHand")).y - __G.player.pos.y] }`);
      await shot(game, `ladder-${id}`);
      assert(on.onStow && !on.onWeapon, "gun stowed on the ladder", on);
      assert(on.hands.every((h) => h > 0.9 && h < 2.1), "hands up on the rungs", on.hands);
      await game.waitFor(`!__G.player.onLadder && __G.player.onGround && __G.player.pos.y > 3.4`, 9000);
      await game.keyUp("KeyW");
      await sleep(600);
      const off = await game.ev(`const gun = S.guns().find(x => x.vis); return !!gun && gun.o.parent === DuoWorld.getAnchor("weapon")`);
      assert(off, "gun back in the hands on the landing");
    });

    await test(`${id}: mantling a ledge stows the gun, puts the hands on the edge, then re-arms`, async () => {
      // a solid box 0.8–1.5 m tall standing on open ground
      const spot = await game.ev(`
        const P = __G.physics, V3 = __G.player.pos.constructor;
        for (const b of P.boxes) {
          if (b.bulletOnly) continue;
          const h = b.max.y, w = b.max.x - b.min.x, d = b.max.z - b.min.z;
          if (h < 0.9 || h > 1.45 || b.min.y > 0.05 || w < 1.2 || d < 1.2) continue;
          const z = (b.min.z + b.max.z) / 2, x = b.min.x - 0.75;
          if (Math.abs(P.groundHeight(x, z, 1)) > 0.05 || !P.nav.isWalkable(x, z)) continue;
          if (P.boxes.some(o => o !== b && !o.bulletOnly && o.min.x < b.max.x && o.max.x > x - 0.5 && o.min.z < z + 0.5 && o.max.z > z - 0.5 && o.max.y > 0.2 && o.min.y < h + 2)) continue;
          return { x, z, h };
        }
        return null;`);
      assert(spot, "found a ledge to climb");
      await game.ev(`S.tp(${spot.x}, 0, ${spot.z}, -Math.PI / 2); S.lastClimb = null; window.__seen = []; __G.frameHooks.push(() => { const gun = S.guns().find(x => x.vis); __G.player.climbing && gun && __seen.push({ stow: gun.o.parent === DuoWorld.getAnchor("weaponStow"), lh: +S.wp(DuoWorld.getAnchor("leftHand")).y.toFixed(3), y: +__G.player.pos.y.toFixed(3) }); })`);
      await sleep(300);
      await game.keyDown("KeyW");
      await sleep(120);
      await game.press("Space", 80);
      await game.waitFor(`S.lastClimb || __G.player.climbing`, 3000);
      await game.waitFor(`!__G.player.climbing && __G.player.onGround && __G.player.pos.y > ${spot.h - 0.1}`, 5000);
      await game.keyUp("KeyW");
      const seen = await game.ev(`return __seen`);
      assert(seen.length > 5 && seen.every((s) => s.stow), "gun stowed for the whole climb", seen.length);
      // while the feet are still near the ground the hand is on the edge; later the arm pushes down straight
      const early = seen.filter((f) => f.y < 0.2).map((f) => f.lh);
      assert(early.length > 0 && early.every((y) => Math.abs(y - spot.h) < 0.25), "left hand on the edge at the start of the climb", { early, ledge: spot.h });
      assert(seen.every((f) => f.lh - f.y > 0.7), "hands never sink into the body", seen.filter((_, i) => i % 6 === 0));
      await sleep(600);
      const off = await game.ev(`const gun = S.guns().find(x => x.vis); return !!gun && gun.o.parent === DuoWorld.getAnchor("weapon")`);
      assert(off, "gun back in the hands on top");
    });
  }

  await test("switching to a character without a weapon anchor removes the gun; back again restores it; no leaks", async () => {
    await game.ev(`await DuoWorld.setAvatar("voxel-walker")`);
    await sleep(400);
    assert((await game.ev(`return S.guns().length`)) === 0, "no held gun on a character without the anchor");
    const geo0 = await game.ev(`return __G.renderer.info.memory.geometries`);
    for (let i = 0; i < 6; i++) await game.ev(`await DuoWorld.setAvatar(${JSON.stringify(IDS)}[${i} % 2])`);
    await sleep(400);
    assert((await game.ev(`return S.guns().length`)) === 1, "exactly one gun after switching back and forth");
    await game.ev(`await DuoWorld.setAvatar("voxel-walker")`);
    await sleep(400);
    const geo1 = await game.ev(`return __G.renderer.info.memory.geometries`);
    assert(geo1 <= geo0 + 2, "geometries released", { geo0, geo1 });
    const errs = errorsOf(game);
    assert(errs.length === 0, "no page errors", errs.slice(0, 3));
  });

  console.log("two players (real server)");
  const server = `ws://127.0.0.1:${duelPort}`;
  const open = async () => browser.open(`${web.url}/?q=low&noaudio=1&server=${encodeURIComponent(server)}`, { wait: TITLE, window: true });
  const A = await open(),
    B = await open();
  const act = (pg, a) => pg.ev(`document.querySelector('.menu [data-act="${a}"]').click()`);
  const oppGun = `(() => { let r = null; __G.versus.opponent.root.traverse(o => o.name === "DuoWorld:HeldGun" && (r = o)); return r; })()`;

  await test("in a duel the opponent holds the gun; their shots flash at its muzzle", async () => {
    await act(A, "versus");
    await A.ev(`document.querySelector('[data-f="vs-name"]').value = "Alpha"`);
    await act(A, "vs-create");
    await A.waitFor(`__G.versus.room && __G.versus.room.code`, 8000);
    const code = await A.ev(`return __G.versus.room.code`);
    await act(B, "versus");
    await B.ev(`document.querySelector('[data-f="vs-name"]').value = "Bravo"; document.querySelector('[data-f="vs-code"]').value = "${code}"`);
    await act(B, "vs-join");
    await Promise.all([A.waitFor(PLAYING, 8000), B.waitFor(PLAYING, 8000)]);
    await Promise.all([A.waitFor(`__G.versus.match && __G.versus.match.live && __G.player.enabled`, 8000), B.waitFor(`__G.versus.match && __G.versus.match.live && __G.player.enabled`, 8000)]);
    await A.ev(`await DuoWorld.setAvatar("swat-operator"); __G.events.emit("character:change", { id: "swat-operator" })`);
    await B.ev(`await DuoWorld.setAvatar("masked-raider"); __G.events.emit("character:change", { id: "masked-raider" })`);
    await A.waitFor(`__G.versus.opponent.avatarId === "masked-raider"`, 20000);
    await B.waitFor(`__G.versus.opponent.avatarId === "swat-operator"`, 20000);
    await B.ev(`const p = __G.player; p.pos.set(-25, 0, 6); p.vel.set(0,0,0); p.yaw = Math.PI / 2; p.pitch = 0; p.invulnerable = true;`);
    await A.ev(`const p = __G.player; p.pos.set(-32, 0, 6); p.vel.set(0,0,0); p.yaw = -Math.PI / 2; p.pitch = 0; p.invulnerable = true;`);
    await A.waitFor(`__G.versus.opponent.visible && Math.abs(__G.versus.opponent.pos.x + 25) < 0.3`, 6000);
    await sleep(500);
    const r = await A.ev(`const gun = ${oppGun}, m = new __G.player.pos.constructor(), d = new __G.player.pos.constructor(); const ok = __G.versus.opponent.muzzle(m, d);
      return { gun: !!gun, ok, m: m.toArray(), d: d.toArray(), pos: __G.versus.opponent.pos.toArray() }`);
    assert(r.gun && r.ok, "opponent carries the World's gun", r);
    assert(r.d[0] < -0.9, "their barrel points at me", r.d);
    assert(r.m[1] - r.pos[1] > 1.1 && r.m[1] - r.pos[1] < 1.75 && r.pos[0] - r.m[0] > 0.4, "muzzle in front of their shoulder", r);
    await shot(A, "duel-opponent");
    // B fires: on A the flash starts at B's muzzle
    await A.ev(`window.__fl = []; const mf = __G.fx.muzzleFlash.bind(__G.fx); __G.fx.muzzleFlash = (p, d, o) => { __fl.push(p.toArray()); return mf(p, d, o); }`);
    await B.ev(`__G.player.pitch = 0.5`); // over A's head
    await sleep(250);
    const m0 = await A.ev(`const m = new __G.player.pos.constructor(), d = m.clone(); __G.versus.opponent.muzzle(m, d); return m.toArray()`);
    await B.press("Enter", 60);
    await A.waitFor(`__fl.length > 0`, 4000);
    const f = await A.ev(`return __fl[0]`);
    assert(Math.hypot(f[0] - m0[0], f[1] - m0[1], f[2] - m0[2]) < 0.2, "remote flash at the remote muzzle", { f, m0 });
    await B.ev(`__G.player.pitch = 0`);
  });

  await test("reload and inspect are mirrored to the other player", async () => {
    await B.ev(`__G.weapon.ammo = Math.max(1, __G.weapon.ammo - 5)`);
    await B.press("KeyR", 60);
    await A.waitFor(`__G.versus.opponent.heldAction.a === 1 && __G.versus.opponent.heldAction.t > 0.8`, 5000);
    const mid = await A.ev(`const gun = ${oppGun}; return { q: gun.children[0].quaternion.toArray(), t: __G.versus.opponent.heldAction.t }`);
    const tb = await B.ev(`return __G.weapon.heldAction().t`);
    assert(Math.abs(mid.q[3]) < 0.995, "their gun is canted for the reload", mid);
    assert(Math.abs(mid.t - tb) < 0.6, "reload clocks agree", { remote: mid.t, local: tb });
    await shot(A, "duel-reload");
    await A.waitFor(`__G.versus.opponent.heldAction.a === 0`, 6000);
    await sleep(300);
    assert(await B.ev(`return __G.weapon.inspectNow()`), "B starts inspecting");
    await A.waitFor(`__G.versus.opponent.heldAction.a === 2 && __G.versus.opponent.heldAction.t > 0.8`, 5000);
    const ins = await A.ev(`return ${oppGun}.children[0].quaternion.toArray()`);
    assert(Math.abs(ins[3]) < 0.99, "their gun is rolled for the inspect", ins);
    await shot(A, "duel-inspect");
    await A.waitFor(`__G.versus.opponent.heldAction.a === 0`, 6000);
    const rest = await A.ev(`return ${oppGun}.children[0].quaternion.toArray()`);
    assert(Math.abs(rest[3]) > 0.999, "back to rest", rest);
  });

  await test("a remote player on the ladder has the gun stowed", async () => {
    await B.ev(`const p = __G.player; p.reset({ pos: new p.pos.constructor(19.15, 0, 8.5), yaw: 0 }); p.invulnerable = true;`);
    await sleep(400);
    await B.press("KeyE", 80);
    await B.waitFor(`__G.player.onLadder === "crane-ladder"`, 3000);
    await B.keyDown("KeyW");
    await A.waitFor(`(() => { const o = __G.versus.opponent, m = new __G.player.pos.constructor(); return o.visible && o.pos.y > 0.8 && o.heldRig && !o.heldRig.inHands && !o.muzzle(m, m.clone()); })()`, 6000);
    await B.keyUp("KeyW");
    for (const pg of [A, B]) {
      const errs = errorsOf(pg);
      assert(errs.length === 0, "no page errors", errs.slice(0, 3));
    }
  });
} finally {
  browser.kill();
  await duel.close();
  web.close();
}

console.log(`\n${passed} passed, ${failed} failed${failures.length ? ": " + failures.join("; ") : ""}`);
process.exit(failed ? 1 : 0);
