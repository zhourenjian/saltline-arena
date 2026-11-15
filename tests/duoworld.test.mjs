// DuoWorld compatibility suite for Saltline. Runs the real builds in headless Chrome:
//   node tests/duoworld.test.mjs            (builds first if dist/ is missing)
//   node tests/duoworld.test.mjs --build    (always rebuild)
//   BASELINE=/path/to/original/dist node tests/duoworld.test.mjs   (compare with the pre-retrofit build)
//
// Every protocol test item gets PASS / FAIL / N/A. An item is PASS only if each of its checks
// ran and held; results go to tests/out/results.{json,md} with screenshots.
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./lib/browser.mjs";
import { serve } from "./lib/serve.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/out");
// SALTLINE_DIST=/some/dir tests a build made elsewhere (<dir>/standalone, <dir>/world-package)
const DIST = process.env.SALTLINE_DIST ? path.resolve(process.env.SALTLINE_DIST) : path.join(ROOT, "dist");
const STANDALONE = path.join(DIST, "standalone");
const PACKAGE = path.join(DIST, "world-package");
const BASELINE = process.env.BASELINE || "/tmp/saltline-base/dist";
const FIXTURE_AVATARS = path.join(ROOT, "tests/fixtures/avatars");
const PUBLIC_AVATARS = path.join(ROOT, "public/avatars");
const PARAMS = "autostart=1&q=low&noaudio=1";
mkdirSync(OUT, { recursive: true });

if (
  process.argv.includes("--build") ||
  !existsSync(STANDALONE) ||
  !existsSync(PACKAGE)
) {
  if (process.env.SALTLINE_DIST) throw new Error(`no build in ${DIST} (SALTLINE_DIST)`);
  console.log("building (npm run build) ...");
  execSync("npm run build", { cwd: ROOT, stdio: "inherit" });
}

// ---------------------------------------------------------------- result bookkeeping
const ITEMS = [
  [1, "Original world works with no avatar"],
  [2, "Avatar 1.0 (setMotion) loads"],
  [3, "Avatar 1.1 (setLocomotion) loads"],
  [4, "Avatar moves with the existing controller"],
  [5, "Physics and gravity unchanged"],
  [6, "Jump / fall / landing coordinated with the avatar"],
  [7, "Dynamic switching without a page refresh"],
  [
    8,
    "No duplicate renderer / controller / listeners after repeated switching",
  ],
  [9, "Collision and camera correct after switching"],
  [10, "Avatar load failure keeps the previous / fallback avatar playable"],
  [11, "Standalone mode works"],
  [12, "Repeated load / enter / leave / dispose without leaks"],
  [13, "Capability declarations match the implementation"],
  [14, "No avatar-ID hardcoding"],
  [15, "3DGS mesh / splat occlusion"],
];
const results = new Map(
  ITEMS.map(([n, title]) => [
    n,
    { n, title, status: null, checks: [], note: "" },
  ]),
);
function check(n, name, ok, detail = "") {
  const r = results.get(n);
  r.checks.push({
    name,
    ok: !!ok,
    detail: typeof detail === "string" ? detail : JSON.stringify(detail),
  });
  console.log(
    `  [${ok ? "ok" : "FAIL"}] #${n} ${name}${detail ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`,
  );
}
function notApplicable(n, note) {
  const r = results.get(n);
  ((r.status = "N/A"), (r.note = note));
}
async function section(n, name, fn) {
  try {
    await fn();
  } catch (e) {
    check(
      n,
      `${name} (threw)`,
      false,
      String((e && e.stack) || e)
        .split("\n")
        .slice(0, 3)
        .join(" | "),
    );
  }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- servers
const misses = [];
const routes = [
  ["/", STANDALONE],
  ["/fixtures/", path.join(ROOT, "tests/fixtures")],
  ["/avatars/", PUBLIC_AVATARS],
  // standalone build mounted under an arbitrary path too (relative asset URLs)
  ["/nested/path/standalone/", STANDALONE],
  // World Package + host under a deep, arbitrary mount
  ["/some/deep/mount/pkg/", PACKAGE],
  ["/some/deep/mount/host/", path.join(ROOT, "tests/fixtures/host")],
  ["/some/deep/mount/avatars/", PUBLIC_AVATARS],
];
// test-only Avatar Packages are installed the same way as real ones: <avatarRoot>/<id>/avatar.js
for (const id of readdirSync(FIXTURE_AVATARS)) {
  routes.push([`/avatars/${id}/`, path.join(FIXTURE_AVATARS, id)]);
  routes.push([
    `/some/deep/mount/avatars/${id}/`,
    path.join(FIXTURE_AVATARS, id),
  ]);
}
const hasBaseline = existsSync(path.join(BASELINE, "index.html"));
hasBaseline && routes.push(["/base/", BASELINE]);
const server = await serve(routes, { misses });
const U = (p) => server.url + p;

// counts WebGL contexts the page creates, so "one renderer" is measured rather than assumed
const INIT = `
  window.__ctxs = [];
  const _gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, ...a) {
    const c = _gc.call(this, t, ...a);
    if (c && /webgl/.test(t) && !window.__ctxs.includes(c)) window.__ctxs.push(c);
    return c;
  };
  const _raf = window.requestAnimationFrame.bind(window);
  window.__rafCalls = 0;
  window.requestAnimationFrame = (f) => (window.__rafCalls++, _raf(f));
`;

// in-page helpers (installed after boot)
const HELPERS = `
  window.T = {
    sampling: null,
    startSampling() {
      const s = (this.sampling = { rows: [], on: true });
      const tick = () => {
        if (!s.on) return;
        const p = __G.player;
        s.rows.push({ y: p.pos.y, vy: p.vel.y, g: p.onGround, x: p.pos.x, z: p.pos.z });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    stopSampling() { this.sampling.on = false; return this.sampling.rows; },
    teleport(x, y, z, yaw) {
      const p = __G.player;
      p.pos.set(x, y, z); p.vel.set(0, 0, 0); if (yaw != null) p.yaw = yaw; p.pitch = 0;
    },
    safe() { __G.player.invulnerable = true; if (__G.player.health != null) __G.player.health = __G.player.maxHealth || 100; },
    roots() { return __G.scene.getObjectsByProperty("name", "DuoWorld:PlayerControlRoot"); },
    listenerCounts() {
      const sum = (t) => Object.values(getEventListeners(t)).reduce((a, l) => a + l.length, 0);
      return { window: sum(window), document: sum(document), canvas: document.querySelector("canvas") ? sum(document.querySelector("canvas")) : 0 };
    },
    liveContexts() { return __ctxs.filter((c) => !c.isContextLost()).length; },
  };
`;

const ready = `window.__ready && window.__G && window.__G.game && window.__G.game.state === "playing"`;
const browser = await launch();
const shots = [];
async function shot(page, name) {
  const f = path.join(OUT, name + ".jpg");
  writeFileSync(f, await page.screenshot());
  shots.push(path.relative(ROOT, f));
}
async function openGame(url, wait = ready) {
  const page = await browser.open(url, { init: INIT, wait });
  await page.ev(HELPERS);
  await page.ev(`T.safe()`);
  return page;
}
async function hold(page, code, ms) {
  await page.keyDown(code);
  await sleep(ms);
  await page.keyUp(code);
}
// walk forward for ms, return horizontal displacement
async function walk(page, ms = 800) {
  const a = await page.ev(`return [__G.player.pos.x, __G.player.pos.z]`);
  await hold(page, "KeyW", ms);
  await sleep(250);
  const b = await page.ev(`return [__G.player.pos.x, __G.player.pos.z]`);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}
async function jump(page) {
  await page.waitFor(`__G.player.onGround`, 5000);
  await sleep(150);
  // ground height read before the key goes down (sampling may only start after take-off)
  const y0 = await page.ev(
    `T.startSampling(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return __G.player.pos.y`,
  );
  await page.press("Space", 80);
  await sleep(1300);
  const rows = await page.ev(`return T.stopSampling()`);
  const apex = Math.max(...rows.map((r) => r.y)) - y0,
    airborne = rows.filter((r) => !r.g).length,
    end = rows[rows.length - 1];
  const firstAir = rows.findIndex((r) => !r.g),
    land = rows.findIndex((r, i) => i > firstAir && r.g);
  return {
    y0,
    apex,
    airborne,
    landedY: end.y,
    landed: end.g,
    maxVy: Math.max(...rows.map((r) => r.vy)),
    minVy: Math.min(...rows.map((r) => r.vy)),
    airFrames: land - firstAir,
  };
}
// features of the original game, measured the same way on the baseline and the retrofit
async function featureProbe(page) {
  const out = {};
  await page.ev(`T.teleport(-32, 0, 6, -Math.PI / 2)`);
  await sleep(300);
  out.walk = await walk(page, 800);
  await page.ev(`T.teleport(-32, 0, 6, -Math.PI / 2)`);
  await sleep(300);
  out.jump = await jump(page);
  const ammo0 = await page.ev(`return __G.weapon.ammo`);
  await hold(page, "Enter", 250);
  await sleep(200);
  out.fired = ammo0 - (await page.ev(`return __G.weapon.ammo`));
  out.relays = await page.ev(`return __G.game.run.relays.map(r => r.id)`);
  out.state = await page.ev(`return __G.game.state`);
  return out;
}

let report = {};
try {
  // ============================================================== baseline (original build)
  let base = null;
  if (hasBaseline) {
    console.log("\n== baseline (original Saltline build)");
    const page = await openGame(U(`/base/?${PARAMS}`));
    base = await featureProbe(page);
    console.log("  baseline:", JSON.stringify(base));
    page.close();
  } else
    console.log(
      "\n(no baseline build at " + BASELINE + "; baseline comparison skipped)",
    );

  // ============================================================== standalone, no avatar
  console.log("\n== standalone, no avatar (items 1, 5, 11)");
  {
    const page = await openGame(
      U(`/?${PARAMS}`),
      `${ready} && window.DuoWorld`,
    );
    await page.ev(`window.DuoWorld.setAvatar(null)`);
    await page.ev(`T.safe()`);
    await section(1, "original features", async () => {
      const f = await featureProbe(page);
      report.noAvatar = f;
      check(
        1,
        "game reaches 'playing' without any avatar worn",
        f.state === "playing" &&
          (await page.ev(`return DuoWorld.getAvatar() === null`)),
      );
      check(
        1,
        "W moves the player",
        f.walk > 2,
        `moved ${f.walk.toFixed(2)} m in 0.8 s`,
      );
      check(
        1,
        "Space jumps and lands",
        f.jump.apex > 0.8 &&
          f.jump.landed &&
          near(f.jump.landedY, f.jump.y0, 0.05),
        `apex ${f.jump.apex.toFixed(3)} m`,
      );
      check(1, "firing spends ammo", f.fired > 0, `${f.fired} rounds`);
      check(
        1,
        "three uplink relays",
        f.relays.length === 3,
        f.relays.join(","),
      );
      check(
        1,
        "first-person viewmodel still rendered (view camera mask intact)",
        await page.ev(`return __G.viewCamera.layers.mask !== 0`),
      );
      check(
        1,
        "avatar control root hidden in first-person",
        await page.ev(`return T.roots().length === 1 && !T.roots()[0].visible`),
      );
      if (base) {
        check(
          1,
          "walk distance matches original build",
          near(f.walk, base.walk, 0.6),
          `orig ${base.walk.toFixed(2)} / now ${f.walk.toFixed(2)}`,
        );
        check(
          1,
          "jump apex matches original build",
          near(f.jump.apex, base.jump.apex, 0.08),
          `orig ${base.jump.apex.toFixed(3)} / now ${f.jump.apex.toFixed(3)}`,
        );
        check(
          1,
          "fire behaviour matches original build",
          f.fired > 0 && base.fired > 0,
          `orig ${base.fired} / now ${f.fired}`,
        );
        check(
          1,
          "same relays as original build",
          JSON.stringify(f.relays) === JSON.stringify(base.relays),
        );
      }
      await shot(page, "01-standalone-first-person");
    });
    await section(5, "gravity", async () => {
      const j = report.noAvatar.jump,
        g = await page.ev(`return ${21}`);
      // apex = v^2 / 2g with v = sqrt(2 g apex) and apex 1 m; air time = 2 v / g
      const v = Math.sqrt(2 * g * 1);
      check(
        5,
        "jump apex ≈ 1 m (v²/2g with g = 21)",
        near(j.apex, 1, 0.12),
        `apex ${j.apex.toFixed(3)}`,
      );
      check(
        5,
        "take-off speed ≈ √(2g·1)",
        near(j.maxVy, v, 0.4),
        `vy ${j.maxVy.toFixed(2)} vs ${v.toFixed(2)}`,
      );
      check(
        5,
        "lands back on the ground plane",
        j.landed && near(j.landedY, j.y0, 0.05),
      );
      if (base)
        check(
          5,
          "apex equals the original build",
          near(j.apex, base.jump.apex, 0.08),
          `orig ${base.jump.apex.toFixed(3)}`,
        );
      else
        check(
          5,
          "baseline comparison",
          false,
          "baseline build missing; only the analytical check ran",
        );
    });
    await section(11, "standalone", async () => {
      check(
        11,
        "window.DuoWorld installed by the RuntimeBridge",
        await page.ev(
          `return !!DuoWorld.__bridge && typeof DuoWorld.setAvatar === "function"`,
        ),
      );
      check(
        11,
        "plain <script src> avatar packages registered",
        await page.ev(
          `return ${JSON.stringify(readdirSync(PUBLIC_AVATARS).filter((d) => existsSync(path.join(PUBLIC_AVATARS, d, "avatar.js"))))}.every(id => DuoWorld.listAvatars().some(a => a.id === id))`,
        ),
      );
      check(
        11,
        "single rAF loop drives frames",
        await page.ev(
          `const f = __frames; await new Promise(r => setTimeout(r, 500)); return __frames - f > 10`,
        ),
      );
      check(
        11,
        "fonts load from relative URLs",
        await page.ev(
          `await document.fonts.ready; return [...document.fonts].some(f => f.status === "loaded")`,
        ),
      );
    });
    page.close();
  }
  // standalone under a nested path (relative base), with an initial avatar from ?avatar=
  await section(11, "nested mount", async () => {
    const before = misses.length;
    const page = await openGame(
      U(`/nested/path/standalone/?${PARAMS}&avatar=voxel-walker&view=third`),
      `${ready} && window.DuoWorld && DuoWorld.getAvatar()`,
    );
    check(
      11,
      "boots under /nested/path/standalone/ with ?avatar= and ?view=third",
      (await page.ev(
        `return DuoWorld.getAvatar().id + "/" + DuoWorld.getCameraMode()`,
      )) === "voxel-walker/third-person",
    );
    const miss = misses.slice(before).filter((u) => !/favicon/.test(u));
    check(
      11,
      "no 404s for relative assets",
      miss.length === 0,
      miss.join(", "),
    );
    await shot(page, "11-nested-standalone-third-person");
    page.close();
  });
  await section(11, "DuoWorldInitialAvatar", async () => {
    const page = await browser.open(U(`/?${PARAMS}`), {
      init: INIT + `window.DuoWorldInitialAvatar = "violet-girl";`,
      wait: `${ready} && window.DuoWorld && DuoWorld.getAvatar()`,
    });
    check(
      11,
      "window.DuoWorldInitialAvatar selects the default avatar",
      (await page.ev(`return DuoWorld.getAvatar().id`)) === "violet-girl",
    );
    page.close();
  });

  // ============================================================== avatars in standalone
  console.log("\n== avatars (items 2, 3, 4, 6, 7, 8, 9, 10)");
  {
    const page = await openGame(
      U(`/?${PARAMS}`),
      `${ready} && window.DuoWorld`,
    );
    await page.ev(`window.__marker = Math.random()`);
    const marker = await page.ev(`return __marker`);
    const L0 = await page.ev(`return T.listenerCounts()`);

    await section(2, "v1", async () => {
      const v = await page.ev(`return DuoWorld.setAvatar("voxel-walker")`);
      check(
        2,
        "voxel-walker (1.0 package) loads",
        v && v.id === "voxel-walker" && v.interface === "1.0",
        v,
      );
      const p = await page.ev(`return DuoWorld.setAvatar("probe-v1")`);
      check(
        2,
        "probe-v1 loads (create() returns a Promise, installed by script injection)",
        p && p.id === "probe-v1" && p.interface === "1.0",
      );
      await page.ev(
        `DuoWorld.setCameraMode("third-person"); T.teleport(-32, 0, 6, -Math.PI / 2)`,
      );
      await sleep(300);
      await hold(page, "KeyW", 700);
      await page.keyDown("ShiftLeft");
      await hold(page, "KeyW", 900);
      await page.keyUp("ShiftLeft");
      await sleep(800);
      const rec = await page.ev(`return __probe["probe-v1"]`);
      check(
        2,
        "setMotion receives idle → walk → run → idle from the controller",
        ["idle", "walk", "run"].every((m) => rec.motions.includes(m)) &&
          rec.motions[rec.motions.length - 1] === "idle",
        rec.motions.join(">"),
      );
      check(
        2,
        "setMotion is sent on change only",
        rec.motions.every((m, i) => i === 0 || m !== rec.motions[i - 1]),
      );
      check(
        2,
        "update(dt) called every frame",
        rec.updates > 60,
        `${rec.updates} updates`,
      );
    });

    await section(3, "v1.1", async () => {
      const loaded = {};
      for (const id of ["girl-purple", "violet-girl"]) {
        const info = (loaded[id] = await page.ev(
          `return DuoWorld.setAvatar(${JSON.stringify(id)})`,
        ));
        check(
          3,
          `${id} loads with setLocomotion`,
          info && info.id === id && info.interface === "1.1",
          info && {
            interface: info.interface,
            protocol: info.protocol,
            optional: info.optional,
          },
        );
        await sleep(400);
        await shot(page, `03-${id}`);
      }
      const gp = loaded["girl-purple"].representation;
      const glb = await page.ev(
        `await DuoWorld.setAvatar("girl-purple"); let n = 0; T.roots()[0].traverse(o => o.isSkinnedMesh && n++); return n`,
      );
      check(
        3,
        "girl-purple (mesh.glb) loaded its skinned GLB via ctx.loadGLTF",
        gp === "mesh.glb" && glb > 0,
        `${gp}, ${glb} skinned meshes`,
      );
      const info = await page.ev(`return DuoWorld.setAvatar("probe-v11")`);
      const rec = await page.ev(`return __probe["probe-v11"]`);
      check(
        3,
        "probe-v11 loads; AvatarContext = {THREE, baseUrl, loadGLTF}",
        info.interface === "1.1" &&
          rec.contexts[0].hasTHREE &&
          rec.contexts[0].loadGLTF === "function" &&
          /\/avatars\/probe-v11\/$/.test(rec.contexts[0].baseUrl),
        rec.contexts[0],
      );
      check(
        3,
        "avatar shares the World's THREE (object3D is an instance of the scene's Object3D)",
        await page.ev(
          `return T.roots()[0].children[0].children[0].children[0] instanceof __G.scene.constructor.__proto__`,
        ),
      );
    });

    await section(4, "controller drives avatar", async () => {
      await page.ev(
        `DuoWorld.setCameraMode("third-person"); T.teleport(-32, 0, 6, -Math.PI / 2)`,
      );
      await sleep(300);
      const d = await walk(page, 900);
      const m = await page.ev(`
        const p = __G.player, root = T.roots()[0], v = new p.pos.constructor();
        root.children[0].children[0].children[0].getWorldPosition(v);
        return { root: [root.position.x - p.pos.x, root.position.y - p.pos.y, root.position.z - p.pos.z], vis: v.distanceTo(p.pos), yaw: root.rotation.y - p.yaw, visible: root.visible };
      `);
      const rec = await page.ev(`return __probe["probe-v11"]`);
      check(
        4,
        "player moved through the World controller",
        d > 2,
        `${d.toFixed(2)} m`,
      );
      check(
        4,
        "control root follows the player transform exactly",
        m.root.every((x) => Math.abs(x) < 1e-6) && Math.abs(m.yaw) < 1e-6,
        m,
      );
      check(4, "avatar visual sits at the player's feet", m.vis < 1e-4, m.vis);
      check(4, "avatar visible in third-person", m.visible);
      check(
        4,
        "locomotion speed comes from the controller",
        rec.maxSpeed > 3 && rec.maxSpeed < 12,
        `max ${rec.maxSpeed.toFixed(2)} m/s`,
      );
      const fp = await page.ev(
        `DuoWorld.setCameraMode("first-person"); await new Promise(r => setTimeout(r, 100)); return { visible: T.roots()[0].visible, mask: __G.viewCamera.layers.mask }`,
      );
      check(
        4,
        "first-person hides the body and restores the viewmodel",
        !fp.visible && fp.mask !== 0,
        fp,
      );
      await page.ev(`DuoWorld.setCameraMode("third-person")`);
    });

    await section(6, "jump phases", async () => {
      await page.ev(
        `T.teleport(-32, 0, 6, -Math.PI / 2); __probe["probe-v11"].phases = []; __probe["probe-v11"].maxUp = 0; __probe["probe-v11"].minDown = 0`,
      );
      await sleep(400);
      const j = await jump(page);
      await sleep(300);
      const rec = await page.ev(`return __probe["probe-v11"]`);
      const seq = rec.phases.join(">");
      const order = ["takeoff", "airborne", "landing", "grounded"];
      let k = 0;
      for (const ph of rec.phases) ph === order[k] && k++;
      check(
        6,
        "phase sequence takeoff → airborne → landing → grounded",
        k === 4,
        seq,
      );
      check(
        6,
        "velocity.y > 0 on the way up and < 0 on the way down (from physics)",
        rec.maxUp > 4 && rec.minDown < -4,
        `up ${rec.maxUp.toFixed(2)} down ${rec.minDown.toFixed(2)}`,
      );
      check(
        6,
        "World gravity reported to the avatar",
        rec.last.gravity === 21 && rec.last.mode === "duoworld:walk",
        { gravity: rec.last.gravity, mode: rec.last.mode },
      );
      check(
        6,
        "jump itself unchanged with an avatar worn",
        near(j.apex, 1, 0.12),
        `apex ${j.apex.toFixed(3)}`,
      );
      // walking off a ledge = fall without a takeoff: drop the player from 3 m
      await page.ev(
        `__probe["probe-v11"].phases = []; T.teleport(-32, 3, 6, -Math.PI / 2); __G.player.onGround = false`,
      );
      await sleep(1200);
      const fall = await page.ev(
        `return __probe["probe-v11"].phases.join(">")`,
      );
      check(
        6,
        "a fall without jumping reports airborne → landing → grounded",
        /airborne>landing>grounded/.test(fall) && !/takeoff/.test(fall),
        fall,
      );
    });

    await section(7, "switching", async () => {
      await page.ev(`T.teleport(-30, 0, 4, 0.7)`);
      await sleep(300);
      const pose0 = await page.ev(
        `return [__G.player.pos.x, __G.player.pos.y, __G.player.pos.z, __G.player.yaw]`,
      );
      const seq = [
        "voxel-walker",
        "girl-purple",
        "violet-girl",
        "probe-v1",
        "probe-v11",
      ];
      const got = [];
      for (const id of seq) {
        got.push(
          (await page.ev(
            `return (await DuoWorld.setAvatar(${JSON.stringify(id)})).id`,
          )) + "",
        );
        await sleep(120);
      }
      const pose1 = await page.ev(
        `return [__G.player.pos.x, __G.player.pos.y, __G.player.pos.z, __G.player.yaw]`,
      );
      check(
        7,
        "each setAvatar resolves to the requested avatar",
        JSON.stringify(got) === JSON.stringify(seq),
        got.join(","),
      );
      check(
        7,
        "no page reload (window marker survives)",
        (await page.ev(`return __marker`)) === marker,
      );
      check(
        7,
        "position and facing preserved across switches",
        pose0.every((v, i) => near(v, pose1[i], 1e-3)),
        { pose0, pose1 },
      );
      check(
        7,
        "game state and camera mode preserved",
        (await page.ev(
          `return __G.game.state + "/" + DuoWorld.getCameraMode()`,
        )) === "playing/third-person",
      );
      const race = await page.ev(`
        const a = DuoWorld.setAvatar("voxel-walker").then(i => i.id, e => e.code);
        const b = DuoWorld.setAvatar("violet-girl").then(i => i.id, e => e.code);
        return [await a, await b, DuoWorld.getAvatar().id, T.roots()[0].children[0].children.length];
      `);
      check(
        7,
        "overlapping setAvatar calls: last one wins, earlier one superseded",
        race[0] === "AVATAR_SUPERSEDED" &&
          race[1] === "violet-girl" &&
          race[2] === "violet-girl" &&
          race[3] === 1,
        race,
      );
    });

    await section(8, "repeated switching", async () => {
      const before = await page.ev(
        `return { l: T.listenerCounts(), ctx: T.liveContexts(), canv: document.querySelectorAll("canvas").length, hooks: __G.frameHooks.length, roots: T.roots().length, scripts: document.querySelectorAll("script[data-duoworld-avatar]").length, geo: __G.renderer.info.memory.geometries }`,
      );
      const p0 = await page.ev(
        `return { c: __probe["probe-v11"].creates, d: __probe["probe-v11"].disposes }`,
      );
      for (let i = 0; i < 12; i++)
        for (const id of [
          "probe-v11",
          "voxel-walker",
          "probe-v1",
          "violet-girl",
        ])
          await page.ev(`await DuoWorld.setAvatar(${JSON.stringify(id)})`);
      await page.ev(`await DuoWorld.setAvatar("probe-v11")`);
      await sleep(400);
      await page.gc();
      const after = await page.ev(
        `return { l: T.listenerCounts(), ctx: T.liveContexts(), canv: document.querySelectorAll("canvas").length, hooks: __G.frameHooks.length, roots: T.roots().length, scripts: document.querySelectorAll("script[data-duoworld-avatar]").length, geo: __G.renderer.info.memory.geometries, children: T.roots()[0].children[0].children.length }`,
      );
      const p1 = await page.ev(
        `return { c: __probe["probe-v11"].creates, d: __probe["probe-v11"].disposes }`,
      );
      check(
        8,
        "one WebGL context, one canvas",
        after.ctx === 1 && after.canv === 1 && before.ctx === 1,
        { before: before.ctx, after: after.ctx, canvases: after.canv },
      );
      check(
        8,
        "window/document/canvas listener counts unchanged after 49 switches",
        JSON.stringify(after.l) === JSON.stringify(before.l) &&
          JSON.stringify(after.l) === JSON.stringify(L0),
        { start: L0, before: before.l, after: after.l },
      );
      check(
        8,
        "frame hooks unchanged (no second controller/loop)",
        after.hooks === before.hooks,
        `${before.hooks} → ${after.hooks}`,
      );
      check(
        8,
        "exactly one control root with one avatar visual",
        after.roots === 1 && after.children === 1,
        after,
      );
      check(
        8,
        "each injected package script added once",
        after.scripts === before.scripts,
        `${before.scripts} → ${after.scripts}`,
      );
      check(
        8,
        "every replaced instance disposed (creates − disposes = 1 worn)",
        p1.c - p1.d === 1 && p1.c - p0.c === 13,
        { before: p0, after: p1 },
      );
      check(
        8,
        "GPU geometry count stable",
        after.geo <= before.geo + 2,
        `${before.geo} → ${after.geo}`,
      );
      check(
        8,
        "rAF re-requests stay one per frame",
        await page.ev(
          `const r = __rafCalls, f = __frames; await new Promise(r => setTimeout(r, 1000)); return (__rafCalls - r) <= (__frames - f) + 3`,
        ),
      );
    });

    await section(9, "collision + camera after switch", async () => {
      await page.ev(
        `await DuoWorld.setAvatar("girl-purple"); DuoWorld.setCameraMode("third-person")`,
      );
      // find a solid collider 2–9 m away with the World's own physics raycast
      const target = await page.ev(`
        const P = __G.physics, p = __G.player, V = p.pos.constructor;
        for (const [x, z] of [[-32, 6], [-20, 0], [-10, 5], [0, 0], [10, -5], [-25, -10]]) {
          T.teleport(x, 0, z, 0);
          await new Promise(r => setTimeout(r, 200));
          if (!p.onGround) continue;
          const o = new V(p.pos.x, p.pos.y + 0.9, p.pos.z);
          let best = null;
          for (let i = 0; i < 48; i++) {
            const a = i / 48 * Math.PI * 2, d = new V(Math.sin(a), 0, Math.cos(a));
            const h = P.raycast(o, d, 10), h2 = P.raycast(new V(o.x, p.pos.y + 0.35, o.z), d, 10), h3 = P.raycast(new V(o.x, p.pos.y + 1.6, o.z), d, 10);
            if (h && h2 && h3 && h.dist > 2 && h.dist < 9 && Math.abs(h.dist - h2.dist) < 0.15 && Math.abs(h.dist - h3.dist) < 0.15 && (!best || h.dist < best.dist)) best = { a, dist: h.dist, from: [p.pos.x, p.pos.z] };
          }
          if (best) return best;
        }
        return null;`);
      check(9, "found a wall to walk into", !!target, target);
      if (!target) return;
      // forward = (-sin yaw, -cos yaw); face the wall
      const yaw = Math.atan2(-Math.sin(target.a), -Math.cos(target.a));
      await page.ev(
        `T.teleport(${target.from[0]}, 0, ${target.from[1]}, ${yaw})`,
      );
      await sleep(300);
      await hold(page, "KeyW", 2200);
      await sleep(300);
      const r = await page.ev(`
        const p = __G.player, c = __G.camera, V = p.pos.constructor;
        const dx = p.pos.x - ${target.from[0]}, dz = p.pos.z - ${target.from[1]};
        const pivot = new V(p.pos.x, p.pos.y + 1.5, p.pos.z);
        const toCam = c.position.clone().sub(pivot), d = toCam.length();
        const hit = __G.physics.raycast(pivot, toCam.clone().normalize(), d);
        const fwd = new V(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
        return { along: dx * Math.sin(${target.a}) + dz * Math.cos(${target.a}), camDist: d, camBlocked: !!hit && hit.dist < d - 0.05, behind: toCam.x * fwd.x + toCam.z * fwd.z, onGround: p.onGround };
      `);
      check(
        9,
        "player stops at the wall (no tunnelling)",
        r.along < target.dist && r.along > target.dist - 1.2,
        `wall ${target.dist.toFixed(2)} m, stopped at ${r.along.toFixed(2)} m`,
      );
      check(
        9,
        "third-person camera behind the player and not inside geometry",
        r.behind < 0 && !r.camBlocked && r.camDist < 3.4,
        r,
      );
      await shot(page, "09-girl-purple-at-wall");
      // turn round to face away from the wall: camera must pull in instead of clipping into it
      await page.ev(`__G.player.yaw += Math.PI`);
      await sleep(600);
      const c2 = await page.ev(`
        const p = __G.player, c = __G.camera, V = p.pos.constructor, pivot = new V(p.pos.x, p.pos.y + 1.5, p.pos.z);
        const toCam = c.position.clone().sub(pivot), d = toCam.length(), hit = __G.physics.raycast(pivot, toCam.clone().normalize(), 10);
        return { camDist: d, wallDist: hit ? hit.dist : null };`);
      check(
        9,
        "camera pulls in when the wall is behind the player",
        c2.wallDist == null || c2.camDist <= c2.wallDist,
        c2,
      );
      await shot(page, "09-camera-pulled-in");
    });

    await section(10, "failure handling", async () => {
      await page.ev(`await DuoWorld.setAvatar("probe-v11")`);
      const cases = [
        ["broken-avatar", "AVATAR_CREATE_FAILED"],
        ["bad-shape", "AVATAR_INVALID"],
        ["splat-only", "REPRESENTATION_UNSUPPORTED"],
        ["no-such-avatar", null],
        ["../escape", "AVATAR_ID_INVALID"],
      ];
      for (const [id, code] of cases) {
        const r = await page.ev(`
          try { await DuoWorld.setAvatar(${JSON.stringify(id)}); return { ok: true }; }
          catch (e) { return { ok: false, code: e.code, msg: e.message, worn: DuoWorld.getAvatar() && DuoWorld.getAvatar().id, roots: T.roots().length, kids: T.roots()[0].children[0].children.length }; }`);
        check(
          10,
          `${id} rejected${code ? " with " + code : ""}, probe-v11 kept`,
          !r.ok &&
            (!code || r.code === code) &&
            r.worn === "probe-v11" &&
            r.roots === 1 &&
            r.kids === 1,
          r,
        );
      }
      const d = await (async () => (
        await page.ev(`T.teleport(-32, 0, 6, -Math.PI / 2)`),
        await sleep(300),
        walk(page, 700)
      ))();
      check(
        10,
        "still playable after the failures",
        d > 1.5 && (await page.ev(`return __G.game.state`)) === "playing",
        `${d.toFixed(2)} m`,
      );
      // no previous avatar: the fallback is the original first-person player
      await page.ev(
        `await DuoWorld.setAvatar(null); DuoWorld.setCameraMode("first-person")`,
      );
      const r = await page.ev(
        `try { await DuoWorld.setAvatar("broken-avatar"); return "loaded?"; } catch (e) { return DuoWorld.getAvatar() === null ? "fallback:" + e.code : "wrong"; }`,
      );
      await page.ev(`T.teleport(-32, 0, 6, -Math.PI / 2)`);
      await sleep(300);
      const d2 = await walk(page, 700);
      check(
        10,
        "with no previous avatar, failure leaves the original player playable",
        r === "fallback:AVATAR_CREATE_FAILED" && d2 > 1.5,
        `${r}, moved ${d2.toFixed(2)} m`,
      );
      check(
        10,
        "no uncaught exceptions on the page",
        !page.logs.some((l) => l.startsWith("EXC")),
        page.logs.filter((l) => l.startsWith("EXC")).join(" | "),
      );
    });

    await section(13, "runtime capability behaviour", async () => {
      await page.ev(
        `await DuoWorld.setAvatar("probe-v11"); DuoWorld.setCameraMode("third-person")`,
      );
      const w = await page.ev(
        `return { caps: DuoWorld.world.capabilities, render: DuoWorld.world.renderCapabilities, coords: DuoWorld.world.coordinates }`,
      );
      report.capabilities = w;
      const caps = Object.fromEntries(
        (w.caps || []).map((c) =>
          typeof c === "string"
            ? [c.split("@")[0], c.split("@")[1]]
            : [c.id || c.name, c.version],
        ),
      );
      report.capabilityMap = caps;
      // avatar-actions: real relay cut while wearing an avatar that declares duoworld:interact
      const relay = await page.ev(`
        __probe["probe-v11"].actions = []; __probe["probe-v11"].stops = 0;
        const o = __G.level.objectives[0], p = __G.player;
        T.teleport(o.pos.x + 0.6, o.pos.y || 0, o.pos.z, Math.atan2(0.6, 0)); return o.id;`);
      await sleep(250);
      await page.ev(
        `T.teleport(__G.level.objectives[0].pos.x + 0.6, __G.level.objectives[0].pos.y || 0, __G.level.objectives[0].pos.z)`,
      );
      await hold(page, "KeyE", 300);
      await sleep(200);
      const a = await page.ev(
        `return { actions: __probe["probe-v11"].actions, stops: __probe["probe-v11"].stops }`,
      );
      check(
        13,
        "avatar-actions: cutting a relay plays duoworld:interact on the avatar, releasing stops it",
        a.actions.some((x) => x[0] === "duoworld:interact" && x[1] === relay) &&
          a.stops >= 1,
        a,
      );
      const unsupported = await page.ev(
        `await DuoWorld.setAvatar("voxel-walker"); return [await DuoWorld.playAction("duoworld:wave"), await DuoWorld.stopAction("duoworld:wave"), DuoWorld.getAnchor("head")]`,
      );
      check(
        13,
        "missing playAction/stopAction/getAnchor handled gracefully",
        unsupported[0].ok === false &&
          unsupported[1].ok === false &&
          unsupported[2] === null,
        unsupported,
      );
      const gp = await page.ev(
        `await DuoWorld.setAvatar("girl-purple"); return await DuoWorld.playAction("duoworld:jump-flip")`,
      );
      check(
        13,
        "action the avatar rejects → {ok:false} (no throw)",
        gp.ok === false,
        gp,
      );
      const anchor = await page.ev(
        `await DuoWorld.setAvatar("probe-v11"); const a = DuoWorld.getAnchor("head"); return a && a.isObject3D`,
      );
      check(13, "getAnchor passes through to the avatar", anchor === true);
      // world-objects
      const objs = await page.ev(`
        const seen = []; const off = DuoWorld.objects.on(e => seen.push(e.id + ":" + e.cause));
        const list0 = DuoWorld.objects.list(); __G.game.debugCut(); const list1 = DuoWorld.objects.list(); off();
        return { list0, list1, seen };`);
      const typeOk = objs.list0.every(
        (o) =>
          /^[a-z0-9-]+:[a-z0-9-]+$/.test(o.type) &&
          o.id &&
          Array.isArray(o.capabilities),
      );
      check(
        13,
        "world-objects: namespaced WorldObjectDescriptor {id, type, capabilities} for 3 relays + extraction",
        objs.list0.length === 4 && typeOk,
        objs.list0.map((o) => `${o.id}:${o.type}[${o.capabilities}]`).join(" "),
      );
      check(
        13,
        "world-objects: state change reported through on()",
        objs.seen.some((s) => /objective:done/.test(s)) &&
          objs.list1.filter((o) => o.state === "cut").length >= 1,
        objs.seen,
      );
      // camera-modes
      const cm = await page.ev(
        `const r = []; for (const m of ["first-person", "third-person"]) { DuoWorld.setCameraMode(m); r.push(DuoWorld.getCameraMode()); } try { DuoWorld.setCameraMode("orbit"); r.push("accepted"); } catch (e) { r.push(e.code); } return r;`,
      );
      check(
        13,
        "camera-modes: first/third-person work, undeclared mode refused",
        JSON.stringify(cm) ===
          JSON.stringify([
            "first-person",
            "third-person",
            "CAMERA_MODE_UNSUPPORTED",
          ]),
        cm,
      );
      // render capabilities: splat representations rejected, listed as unsupported
      const rc = await page.ev(
        `return DuoWorld.listAvatars().filter(a => /splat/.test(a.representation)).map(a => a.id + ":" + a.supported)`,
      );
      check(
        13,
        "renderCapabilities: no splat representation; splat avatars listed as unsupported",
        !w.render.representations.some((r) => /splat|3dgs/i.test(r)) &&
          w.render.composition.meshSplatOcclusion === false &&
          rc.every((s) => s.endsWith(":false")),
        { representations: w.render.representations, rc },
      );
    });
    page.close();
  }

  // ============================================================== World Package in a host
  console.log("\n== World Package in a DuoWorld host (items 12, 13)");
  {
    const page = await browser.open(U(`/some/deep/mount/host/?pkg=../pkg/`), {
      init: INIT,
      wait: "window.HOST_READY",
    });
    await section(13, "manifest", async () => {
      const m = await page.ev(`return HOST.manifest`);
      report.manifest = m;
      check(
        13,
        "world.json: protocol duoworld.world 0.1.0, stable id, ESM entry ./world.js",
        m.protocol === "duoworld.world" &&
          m.protocolVersion === "0.1.0" &&
          m.id === "saltline.harbor" &&
          m.entry === "./world.js",
      );
      const rel = JSON.stringify(m).match(/"(https?:|\/)[^"]*"/g) || [];
      check(
        13,
        "world.json contains only relative paths",
        rel.length === 0,
        rel.join(","),
      );
      await page.ev(`await HOST.create(); await HOST.load()`);
      const live = await page.ev(
        `const w = HOST.world, l = w.context.level; return { caps: w.capabilities, render: w.renderCapabilities, coords: w.coordinates, start: [l.playerStart.pos.x, l.playerStart.pos.y, l.playerStart.pos.z, l.playerStart.yaw], id: w.id, version: w.version }`,
      );
      check(
        13,
        "world.json capabilities == world module capabilities",
        JSON.stringify(m.capabilities) === JSON.stringify(live.caps),
        m.capabilities,
      );
      check(
        13,
        "world.json render capabilities == runtime",
        JSON.stringify(m.render) === JSON.stringify(live.render),
      );
      check(
        13,
        "spawn in world.json is the real level spawn",
        m.coordinates.spawn.position.every((v, i) =>
          near(v, live.start[i], 1e-6),
        ) && near(m.coordinates.spawn.yaw, live.start[3], 1e-6),
        { manifest: m.coordinates.spawn, level: live.start },
      );
      check(
        13,
        "id/version match the module",
        m.id === live.id && m.version === live.version,
      );
      check(
        13,
        "gaussian-splat declared unsupported, not faked",
        (m.unsupported.representations || []).includes("gaussian-splat") &&
          m.render.composition.meshSplatOcclusion === false,
      );
      // every installed package, worn by the player and as an extra instance (lobby preview /
      // 1v1 opponent), must be drawn at the same standing height whatever size it was modelled at
      const pkgIds = readdirSync(PUBLIC_AVATARS).filter((d) =>
        existsSync(path.join(PUBLIC_AVATARS, d, "avatar.js")),
      );
      const sizes = await page.ev(`
        const h = HOST.world.avatarHost, scene = HOST.world.context.scene, V = scene.position.constructor;
        const height = (obj) => {
          // updateMatrixWorld (as the renderer does), so skinned meshes refresh bindMatrixInverse
          scene.updateMatrixWorld(true);
          const v = new V(); let lo = Infinity, hi = -Infinity;
          obj.traverse((o) => {
            if (!o.isMesh || !o.visible || !o.geometry.attributes.position) return;
            for (let i = 0, n = o.geometry.attributes.position.count; i < n; i++) {
              o.getVertexPosition(i, v); v.applyMatrix4(o.matrixWorld);
              lo = Math.min(lo, v.y); hi = Math.max(hi, v.y);
            }
          });
          return +(hi - lo).toFixed(3);
        };
        // measured standing still on the ground, with the idle clip fully faded in
        const idle = { grounded: true, speed: 0, velocity: { x: 0, y: 0, z: 0 }, phase: "grounded", deltaSeconds: 0.2, mode: "duoworld:walk", gravity: 21, stance: "standing", sprinting: false };
        const stand = (inst) => {
          for (let i = 0; i < 5; i++) {
            inst.setLocomotion ? inst.setLocomotion(idle) : inst.setMotion("idle");
            inst.update(0.2);
          }
        };
        await HOST.world.setCameraMode("third-person");
        const out = {};
        for (const id of ${JSON.stringify(pkgIds)}) {
          await HOST.world.setAvatar(id);
          stand(h.instance);
          const worn = height(h.root), follow = +h.camera.followHeight.toFixed(3), v = h.visual;
          const e = await h.createInstance(id);
          scene.add(e.object3D);
          stand(e.instance);
          const extra = height(e.object3D);
          h.releaseInstance(e);
          out[id] = { worn, extra, follow, model: v.modelHeight, scale: +v.scale.toFixed(4), raw: +(worn / v.scale).toFixed(3) };
        }
        await HOST.world.setAvatar(null);
        await HOST.world.setCameraMode("first-person");
        return { out };
      `);
      report.avatarHeights = sizes.out;
      const STD = 1.75;
      const off = Object.entries(sizes.out).filter(
        ([, r]) => !near(r.worn, STD, STD * 0.03) || !near(r.extra, STD, STD * 0.03),
      );
      check(
        13,
        `every installed avatar (${pkgIds.length}) is drawn at the standard ${STD} m (±3%), worn and as an extra instance`,
        pkgIds.length >= 7 && off.length === 0,
        sizes.out,
      );
      check(
        13,
        "declared metadata.height matches the modelled size (±3%)",
        Object.values(sizes.out).every((r) => near(r.raw, r.model, r.model * 0.03)),
        sizes.out,
      );
      check(
        13,
        "third-person follow height = (eyeHeight, else height×0.92) × the same normalization scale",
        near(sizes.out["voxel-walker"].follow, (1.62 * STD) / 1.96, 2e-3) &&
          near(sizes.out["girl-purple"].follow, 1.64 * 0.92 * (STD / 1.64), 2e-3),
        sizes.out,
      );
    });

    await section(12, "lifecycle cycles", async () => {
      const L = [];
      const snap = () =>
        page.ev(
          `return { l: (() => { const s = t => Object.values(getEventListeners(t)).reduce((a, l) => a + l.length, 0); return { w: s(window), d: s(document) }; })(), canvases: document.querySelectorAll("canvas").length, live: __ctxs.filter(c => !c.isContextLost()).length, styles: document.querySelectorAll("style[data-duoworld-world]").length, app: !!document.getElementById("app"), heap: performance.memory.usedJSHeapSize, state: HOST.world.state }`,
        );
      // world loaded above; dispose it to get the clean reference point
      await page.ev(`await HOST.dispose()`);
      await page.gc();
      const clean = await snap();
      L.push(["clean", clean]);
      const heaps = [];
      for (let i = 0; i < 5; i++) {
        const s1 = await page.ev(`return HOST.load()`);
        // loaded but not entered: input must not drive the player
        const idle = await page.ev(
          `HOST.world.context.game.start({ skipIntro: true }); HOST.world.context.player.invulnerable = true; return HOST.world.context.player.pos.x`,
        );
        await page.keyDown("KeyW");
        await sleep(400);
        await page.keyUp("KeyW");
        const notEntered = await page.ev(
          `return { x: HOST.world.context.player.pos.x, frame: HOST.world.context.time.frame }`,
        );
        const e = await page.ev(
          `return HOST.enter({ avatar: "voxel-walker", cameraMode: "third-person" })`,
        );
        await page.ev(`HOST.world.context.player.invulnerable = true`);
        const f0 = await page.ev(`return HOST.frames`);
        await hold(page, "KeyW", 500);
        await sleep(200);
        const entered = await page.ev(
          `return { x: HOST.world.context.player.pos.x, frames: HOST.frames, avatar: HOST.world.getAvatar() && HOST.world.getAvatar().id, roots: HOST.world.context.scene.getObjectsByProperty("name", "DuoWorld:PlayerControlRoot").length, live: __ctxs.filter(c => !c.isContextLost()).length, geo: HOST.world.context.renderer.info.memory.geometries, tex: HOST.world.context.renderer.info.memory.textures }`,
        );
        i === 0 && (await shot(page, "12-world-package-in-host"));
        const lv = await page.ev(`return HOST.leave()`);
        const t0 = await page.ev(`return HOST.world.context.time.frame`);
        await sleep(400);
        const t1 = await page.ev(`return HOST.world.context.time.frame`);
        const d = await page.ev(`return HOST.dispose()`);
        await page.gc();
        const after = await snap();
        heaps.push(after.heap);
        L.push([
          `cycle ${i + 1}`,
          {
            s1,
            notEntered,
            idle,
            e,
            entered,
            f0,
            lv,
            frozen: t0 === t1,
            d,
            after,
          },
        ]);
        check(
          12,
          `cycle ${i + 1}: load → loaded, enter → entered, leave → loaded, dispose → created`,
          s1 === "loaded" &&
            e === "entered" &&
            lv === "loaded" &&
            d === "created",
          [s1, e, lv, d].join(","),
        );
        check(
          12,
          `cycle ${i + 1}: no frames and no movement before enter (world has no loop of its own)`,
          notEntered.frame === 0 && near(notEntered.x, idle, 1e-6),
          notEntered,
        );
        check(
          12,
          `cycle ${i + 1}: entered world runs host frames, moves, wears avatar, one renderer`,
          entered.frames > f0 + 10 &&
            Math.abs(entered.x - idle) > 1 &&
            entered.avatar === "voxel-walker" &&
            entered.roots === 1 &&
            entered.live === 1,
          entered,
        );
        check(
          12,
          `cycle ${i + 1}: leave stops simulation (no internal loop)`,
          t0 === t1,
          `${t0} → ${t1}`,
        );
        check(
          12,
          `cycle ${i + 1}: dispose restores listeners/canvas/styles/GL contexts`,
          JSON.stringify(after.l) === JSON.stringify(clean.l) &&
            after.canvases === clean.canvases &&
            after.live === 0 &&
            after.styles === 0 &&
            !after.app,
          {
            clean: clean.l,
            after: after.l,
            canvases: after.canvases,
            live: after.live,
            styles: after.styles,
          },
        );
        if (i > 0) {
          const prev = L[L.length - 2][1].entered;
          check(
            12,
            `cycle ${i + 1}: same GPU geometry/texture counts as cycle 1`,
            entered.geo === L[1][1].entered.geo &&
              entered.tex === L[1][1].entered.tex,
            {
              geo: [L[1][1].entered.geo, entered.geo],
              tex: [L[1][1].entered.tex, entered.tex],
              prev: prev.geo,
            },
          );
        }
      }
      const growth = (heaps[heaps.length - 1] - heaps[0]) / 1048576;
      report.heapMB = heaps.map((h) => +(h / 1048576).toFixed(1));
      check(
        12,
        "JS heap after dispose does not grow across cycles 1→5",
        growth < 8,
        `${report.heapMB.join(" → ")} MB (Δ ${growth.toFixed(1)} MB)`,
      );
      report.lifecycle = L;
      // dispose during an in-flight load
      const race = await page.ev(
        `const p = HOST.world.load(); await new Promise(r => setTimeout(r, 30)); await HOST.world.dispose(); const r = await p.then(() => "resolved", e => e.code); return { r, state: HOST.world.state, canvases: document.querySelectorAll("canvas").length, live: __ctxs.filter(c => !c.isContextLost()).length }`,
      );
      check(
        12,
        "dispose() during load releases the half-built world",
        race.r === "WORLD_DISPOSED" &&
          race.state === "created" &&
          race.canvases === 0 &&
          race.live === 0,
        race,
      );
      const again = await page.ev(
        `await HOST.load(); await HOST.enter({}); await new Promise(r => setTimeout(r, 400)); const f = HOST.frames; await new Promise(r => setTimeout(r, 300)); const ok = HOST.frames > f; await HOST.dispose(); return ok`,
      );
      check(12, "world reloads and runs after the aborted load", again);
      check(
        12,
        "no uncaught exceptions in the host",
        !page.logs.some((l) => l.startsWith("EXC")),
        page.logs.filter((l) => l.startsWith("EXC")).join(" | "),
      );
    });
    page.close();
  }

  // ============================================================== static checks
  console.log("\n== static checks (items 14, 13)");
  await section(14, "hardcoding", async () => {
    const ids = [
      ...readdirSync(PUBLIC_AVATARS),
      ...readdirSync(FIXTURE_AVATARS),
    ];
    const files = [];
    const walkDir = (d) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) f !== "vendor" && walkDir(p);
        else /\.js$/.test(f) && files.push(p);
      }
    };
    walkDir(path.join(ROOT, "src"));
    const stripComments = (s) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    const hits = [];
    for (const f of files) {
      const code = stripComments(readFileSync(f, "utf8"));
      for (const id of ids)
        code.includes(id) && hits.push(`${path.relative(ROOT, f)}: "${id}"`);
    }
    check(
      14,
      `no avatar package id in World code (${files.length} files, ${ids.length} ids)`,
      hits.length === 0,
      hits.join(", "),
    );
    const host = [
      "src/duoworld/AvatarHost.js",
      "src/duoworld/WorldAdapter.js",
      "src/duoworld/RuntimeBridge.js",
      "src/player/third-person-camera.js",
      "src/lobby/characters.js",
      "src/versus/opponent.js",
    ]
      .map((f) => stripComments(readFileSync(path.join(ROOT, f), "utf8")))
      .join("\n");
    const bonePatterns = [
      /getObjectByName\s*\(/,
      /getBoneByName/,
      /\.skeleton\b/,
      /\.bones\b/,
      /mixamo/i,
      /morphTargetDictionary/,
      /\.traverse\s*\(/,
    ];
    const boneHits = bonePatterns.filter((r) => r.test(host)).map(String);
    check(
      14,
      "avatar host never looks up bones/meshes by name or walks the avatar's tree",
      boneHits.length === 0,
      boneHits.join(", "),
    );
    const branch = /\b(id|avatarId)\s*[!=]==?\s*["'`](?!saltline\.)[^"'`]/.test(
      host,
    );
    check(14, "no branches on specific avatar ids", !branch);
  });
  await section(13, "package build", async () => {
    const js = readFileSync(path.join(PACKAGE, "world.js"), "utf8");
    const bad = [
      "localhost",
      "127.0.0.1",
      "/@vite",
      "/src/",
      "/node_modules/",
    ].filter((s) => js.includes(s));
    check(
      13,
      "world.js is self-contained (no dev-server or source paths)",
      bad.length === 0,
      bad.join(","),
    );
    check(
      13,
      "world-package layout: world.json + world.js + assets/",
      ["world.json", "world.js", "assets"].every((f) =>
        existsSync(path.join(PACKAGE, f)),
      ),
    );
  });

  notApplicable(
    15,
    "This World renders Three.js meshes only (renderCapabilities.representations = three.object3d, mesh.glb, mesh.gltf; composition.meshSplatOcclusion = false). Gaussian-splat avatars are rejected with REPRESENTATION_UNSUPPORTED (verified in #10/#13). Mesh/splat depth occlusion was not implemented and was not tested; it is reported as a limitation, not as Passed.",
  );
} finally {
  browser.kill();
  server.close();
}

// ---------------------------------------------------------------- report
for (const r of results.values()) {
  if (r.status) continue;
  r.status =
    r.checks.length === 0
      ? "NOT RUN"
      : r.checks.every((c) => c.ok)
        ? "PASS"
        : "FAIL";
}
const list = [...results.values()];
writeFileSync(
  path.join(OUT, "results.json"),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      baseline: hasBaseline ? BASELINE : null,
      items: list,
      report,
      screenshots: shots,
    },
    null,
    2,
  ),
);
const md = [
  "# DuoWorld compatibility test results",
  "",
  `Run: ${new Date().toISOString()} · headless Chrome · baseline build: ${hasBaseline ? "yes" : "no"}`,
  "",
  "| # | Item | Result | Checks |",
  "|---|------|--------|--------|",
  ...list.map(
    (r) =>
      `| ${r.n} | ${r.title} | **${r.status}** | ${r.status === "N/A" ? r.note : `${r.checks.filter((c) => c.ok).length}/${r.checks.length}`} |`,
  ),
  "",
  ...list.flatMap((r) => [
    `## ${r.n}. ${r.title} — ${r.status}`,
    "",
    ...(r.note ? [r.note, ""] : []),
    ...r.checks.map(
      (c) =>
        `- ${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? ` — \`${c.detail.replace(/`/g, "'").slice(0, 300)}\`` : ""}`,
    ),
    "",
  ]),
  "Screenshots: " + shots.join(", "),
  "",
].join("\n");
writeFileSync(path.join(OUT, "results.md"), md);
console.log(
  "\n" +
    list
      .map(
        (r) => `#${String(r.n).padStart(2)} ${r.status.padEnd(7)} ${r.title}`,
      )
      .join("\n"),
);
console.log(`\nwritten: tests/out/results.md`);
process.exit(
  list.some((r) => r.status === "FAIL" || r.status === "NOT RUN") ? 1 : 0,
);
