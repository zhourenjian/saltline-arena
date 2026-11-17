// Game context, original system startup order and frame loop.
import { PlaneGeometry, THREE, Vector3 } from "../vendor/three-r180.js";
import { chooseQuality } from "../core/quality.js";
import { createEventBus } from "../core/events.js";
import { createRandom } from "../core/random.js";
import { FALLBACKS } from "../core/fallbacks.js";
import { createMesh } from "../core/geometry.js";
import { createRenderer } from "../render/renderer.js";
import { createMaterials } from "../render/materials/materials.js";
import { createPhysics } from "../world/physics.js";
import { createProps } from "../world/props/props.js";
import { createLevel } from "../world/level/level.js";
import { createBackdrop } from "../world/backdrop/backdrop.js";
import { createGround } from "../world/ground/ground.js";
import { createEffects } from "../effects/effects.js";
import { createAudio } from "../audio/audio.js";
import { createInput } from "../input/input.js";
import { createPlayer } from "../player/player.js";
import { createCombat } from "../combat/combat.js";
import { createWeapon } from "../weapons/weapon.js";
import { createEnemies } from "../enemies/enemies.js";
import { createHUD } from "../ui/hud.js";
import { createGameFlow } from "../game/flow.js";
import { SHOWCASE_MODULES } from "./showcases.js";
import { showFatalError } from "./diagnostics.js";
import { bootElement, setBootProgress } from "./boot-screen.js";
import { enableBenchmark } from "./benchmark.js";
import { enablePerfProbe } from "./perf-probe.js";
import { installViewport } from "./viewport.js";
import { createInstallGuide } from "../ui/install-guide.js";
import { createShowcaseInput, createShowcasePlayer } from "./showcase-stubs.js";

// One world instance: boot() builds every system in the original order, frame(seconds) is the
// original per-frame body (driven by whoever owns the loop: the standalone bridge or a DuoWorld
// host), teardown() releases what boot() created. There is exactly one loop body.
function createWorldRuntime(options = {}) {
  let context = null,
    frame = null,
    booted = !1,
    tornDown = !1;
  async function boot() {
    if (booted) throw new Error("world runtime already booted");
    booted = !0;
    context = await bootSystems(options, (h) => (frame = h));
    return context;
  }
  function teardown() {
    if (tornDown || !context) return;
    ((tornDown = !0), (frame = null), disposeContext(context));
  }
  return {
    boot,
    teardown,
    frame(seconds) {
      frame && !tornDown && frame(seconds);
    },
    get context() {
      return context;
    },
  };
}

async function bootSystems(options, setFrame) {
  let params =
      options.params ||
      Object.fromEntries(new URLSearchParams(location.search)),
    benchmark =
      !!params.bench || (!options.params && location.hash === "#bench");
  benchmark && ((params.noaudio = "1"), (params.autostart = "1"));
  params.perf && ((params.noaudio = "1"), (params.autostart = "1"));
  let context = {
    THREE: THREE,
    params: params,
    events: createEventBus(),
    rng: createRandom(+(params.seed || 4207)),
    time: {
      t: 0,
      dt: 0,
      frame: 0,
      real: 0,
    },
    quality: chooseQuality(params.q || (params.shot ? "test" : "")),
    lifetime: options.lifetime || null,
    // World-owned extension point: fn(dt, simulated) after player/weapon/enemies each frame
    frameHooks: [],
    // 0 = every display frame; ?fps=30 forces a cap, and the renderer sets 30 on a phone that cannot keep up
    frameCap: params.fps ? Math.max(0, Math.min(120, +params.fps || 0)) : 0,
  };
  ((window.__G = context), (window.__frames = 0), (window.__ready = !1));
  // standalone page only: an embedding host owns the layout of its own container
  !options.params && (context.viewport = installViewport(context));
  let showcaseName =
    params.show && SHOWCASE_MODULES[params.show] ? params.show : null;
  context.showcase = showcaseName;
  let cameraOverride = null;
  function setShot(h) {
    if (h.cam) {
      let f = String(h.cam).split(",").map(Number);
      cameraOverride = {
        pos: new Vector3(f[0], f[1], f[2]),
        look: new Vector3(f[3] ?? 0, f[4] ?? 1, f[5] ?? 0),
      };
    }
    (h.cam === "" && (cameraOverride = null),
      h.fov &&
        ((context.camera.fov = +h.fov),
        context.camera.updateProjectionMatrix()),
      h.exposure && (context.render.exposure = +h.exposure));
  }
  window.__setShot = setShot;
  async function initializeSystem(h, f, p, d = !1) {
    let v = performance.now();
    try {
      context[h] = await p();
    } catch (x) {
      if (
        (console.error(`[boot] module "${h}" failed: ${(x && x.stack) || x}`),
        d || !FALLBACKS[h])
      )
        throw x;
      context[h] = FALLBACKS[h]();
    }
    let g = performance.now() - v;
    g > 150 && console.log(`[boot] ${h} ${g.toFixed(0)}ms`);
  }
  if (
    (await setBootProgress("Waking the renderer", 0.04),
    await initializeSystem(
      "render",
      "render",
      () => createRenderer(context),
      !0,
    ),
    (context.renderer = context.render.renderer),
    (context.scene = context.render.scene),
    (context.camera = context.render.camera),
    (context.viewCamera = context.render.viewCamera),
    await setBootProgress("Mixing paint, rust and rain", 0.12),
    await initializeSystem("mats", "materials", () => createMaterials(context)),
    (context.physics = createPhysics(context)),
    (context.props = createProps(context)),
    (context.input = showcaseName
      ? createShowcaseInput()
      : createInput(context)),
    showcaseName)
  ) {
    let h = createMesh(
      new PlaneGeometry(80, 80).rotateX(-Math.PI / 2),
      context.mats.get("concrete"),
      {
        cast: !1,
      },
    );
    if (
      (context.scene.add(h),
      (context.level = {
        stub: !0,
        playerStart: {
          pos: new Vector3(0, 0, 4),
          yaw: 0,
        },
        objectives: [],
        enemySpawns: [],
        zones: [],
        interiorBoxes: [],
        cinematicPath: [],
        extraction: {
          pos: new Vector3(),
          radius: 2,
        },
        groundSurfaceAt: () => "concrete",
        update() {},
      }),
      (context.backdrop = FALLBACKS.backdrop()),
      (context.ground = FALLBACKS.ground()),
      context.physics.build(),
      showcaseName === "fx")
    )
      await initializeSystem("fx", "fx", () => createEffects(context));
    else
      try {
        context.fx = await createEffects(context);
      } catch {
        context.fx = FALLBACKS.fx();
      }
    ((context.audio = FALLBACKS.audio()),
      (context.hud = FALLBACKS.hud()),
      (context.player = createShowcasePlayer(context)),
      (context.combat = createCombat(context)),
      (context.weapon = FALLBACKS.weapon()),
      (context.enemies = FALLBACKS.enemies()),
      (context.game = {
        state: "showcase",
        update: () => !1,
        start() {},
      }));
    let f = null;
    try {
      f = await SHOWCASE_MODULES[showcaseName].showcase(context);
    } catch (p) {
      showFatalError(
        `showcase "${showcaseName}" threw: ${(p && p.stack) || p}`,
      );
    }
    ((context.showcaseInfo = f || {}),
      f &&
        f.cam &&
        setShot({
          cam: [...f.cam, ...(f.target || [0, 1, 0])].join(","),
        }));
  } else {
    if (
      (await setBootProgress("Stacking containers", 0.34),
      await initializeSystem("level", "level", () => createLevel(context), !0),
      await setBootProgress("Raising the cranes", 0.5),
      await initializeSystem("backdrop", "backdrop", () =>
        createBackdrop(context),
      ),
      await setBootProgress("Flooding the apron", 0.58),
      await initializeSystem("ground", "ground", () => createGround(context)),
      context.ground.stub)
    ) {
      let h = createMesh(
        new PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
        context.mats.get("asphalt"),
        {
          cast: !1,
        },
      );
      context.scene.add(h);
    }
    (context.physics.build(),
      await setBootProgress("Loading tracers and smoke", 0.66),
      await initializeSystem("fx", "fx", () => createEffects(context)),
      await initializeSystem("audio", "audio", () =>
        params.noaudio ? FALLBACKS.audio() : createAudio(context),
      ),
      (context.player = createPlayer(context)),
      (context.combat = createCombat(context)),
      await setBootProgress("Checking the rifle", 0.74),
      await initializeSystem("weapon", "weapon", () => createWeapon(context)),
      await setBootProgress("Waking the Harbormaster", 0.82),
      await initializeSystem("enemies", "enemies", () =>
        createEnemies(context),
      ),
      await initializeSystem("hud", "hud", () => createHUD(context)),
      (context.game = createGameFlow(context)),
      // standalone page only (a hosting World does not own the browser chrome)
      !options.params && (context.installGuide = createInstallGuide(context)));
  }
  await setBootProgress("Waiting for first light", 0.92);
  try {
    await context.render.onLevelReady();
  } catch (h) {
    console.error(
      "[boot] render.onLevelReady failed: " + ((h && h.stack) || h),
    );
  }
  let averageFrameSeconds = 0,
    lastCpuMs = 0;
  if (
    ((window.__stats = () => ({
      ...(context.render.stats ? context.render.stats() : {}),
      fps: averageFrameSeconds ? +(1 / averageFrameSeconds).toFixed(1) : 0,
      state: context.game && context.game.state,
    })),
    params.cam && setShot(params),
    params.fov &&
      setShot({
        fov: params.fov,
      }),
    !showcaseName && (params.shot || params.autostart))
  )
    try {
      context.game.start({
        skipIntro: !0,
      });
    } catch (h) {
      console.error("[boot] game.start failed", h);
    }
  (params.noweapon &&
    context.weapon.setVisible &&
    context.weapon.setVisible(!1),
    benchmark && enableBenchmark(context),
    params.perf && enablePerfProbe(context),
    await setBootProgress("Ready", 1));
  let boot = bootElement();
  boot &&
    (boot.classList.add("done"),
    (context.lifetime ? context.lifetime.timeout : setTimeout)(() => {
      boot.hidden = !0;
    }, 700));
  let weaponWetness = 1,
    updateSystem = (h, f) => {
      let p = context[h];
      if (p && p.update)
        try {
          p.update(f);
        } catch (d) {
          updateSystem.err[h] ||
            ((updateSystem.err[h] = 1),
            console.error(`[loop] ${h}.update threw: ${(d && d.stack) || d}`));
        }
    };
  ((updateSystem.err = {}),
    setFrame((seconds) => {
      let h = performance.now(),
        f = Math.max(0, +seconds || 0);
      averageFrameSeconds = averageFrameSeconds
        ? averageFrameSeconds * 0.95 + f * 0.05
        : f;
      let p = Math.min(f, 0.05);
      (params.dt && (p = +params.dt),
        (context.time.dt = p),
        (context.time.t += p),
        (context.time.real = h / 1e3),
        context.time.frame++,
        updateSystem("input", p));
      let d = !1;
      try {
        d =
          context.game.update(p) !== !1 &&
          context.game.state !== "title" &&
          context.game.state !== "paused";
      } catch (v) {
        updateSystem.err.game ||
          ((updateSystem.err.game = 1),
          console.error("[loop] game.update threw: " + ((v && v.stack) || v)));
      }
      if (showcaseName) {
        if (context.showcaseInfo.update)
          try {
            context.showcaseInfo.update(p);
          } catch (v) {
            updateSystem.err.sc ||
              ((updateSystem.err.sc = 1),
              console.error(
                "[loop] showcase update threw: " + ((v && v.stack) || v),
              ));
          }
      } else
        d &&
          (updateSystem("player", p),
          updateSystem("weapon", p),
          updateSystem("enemies", p));
      for (let v of context.frameHooks)
        try {
          v(p, d);
        } catch (g) {
          updateSystem.err.hook ||
            ((updateSystem.err.hook = 1),
            console.error("[loop] frame hook threw: " + ((g && g.stack) || g)));
        }
      if (
        context.weapon &&
        context.weapon.setWetness &&
        context.level &&
        context.level.interiorBoxes &&
        context.level.interiorBoxes[0]
      ) {
        let v = context.level.interiorBoxes[0],
          g = context.camera.position,
          x =
            g.x > v.min.x &&
            g.x < v.max.x &&
            g.z > v.min.z &&
            g.z < v.max.z &&
            g.y < v.max.y;
        weaponWetness +=
          ((x ? 0.3 : 1) - weaponWetness) * Math.min(1, p * (x ? 0.25 : 0.6));
        try {
          context.weapon.setWetness(weaponWetness);
        } catch {}
      }
      (context.game.state !== "paused" &&
        (updateSystem("fx", p),
        updateSystem("ground", p),
        updateSystem("level", p),
        updateSystem("backdrop", p),
        updateSystem("mats", p)),
        updateSystem("audio", p),
        updateSystem("hud", p),
        cameraOverride &&
          (context.camera.position.copy(cameraOverride.pos),
          context.camera.lookAt(cameraOverride.look)),
        context.bench && context.bench.frame(f),
        context.perfProbe && context.perfProbe.frame(p, f, lastCpuMs));
      try {
        context.render.frame(p);
      } catch (v) {
        updateSystem.err.render ||
          ((updateSystem.err.render = 1),
          console.error("[loop] render.frame threw: " + ((v && v.stack) || v)));
      }
      ((lastCpuMs = performance.now() - h),
        context.input.endFrame && context.input.endFrame(),
        window.__frames++,
        window.__frames === 2 && (window.__ready = !0));
    }));
  return context;
}

// Releases everything one boot created: listeners/timers (lifetime), audio, GPU resources and the
// WebGL context, and the diagnostic globals that point at this instance.
function disposeContext(context) {
  try {
    context.lifetime && context.lifetime.dispose();
  } catch {}
  try {
    document.pointerLockElement && document.exitPointerLock();
  } catch {}
  try {
    let a = context.audio && context.audio.ctx;
    a && a.state !== "closed" && a.close().catch(() => {});
  } catch {}
  let renderer = context.renderer,
    scene = context.scene,
    seen = new Set(),
    free = (h) => {
      if (!h || seen.has(h) || typeof h.dispose != "function") return;
      seen.add(h);
      try {
        h.dispose();
      } catch {}
    };
  scene &&
    scene.traverse((h) => {
      free(h.geometry);
      for (let f of h.material
        ? Array.isArray(h.material)
          ? h.material
          : [h.material]
        : []) {
        if (!f) continue;
        for (let p in f) {
          let d = f[p];
          d && d.isTexture && free(d);
        }
        if (f.uniforms)
          for (let p in f.uniforms) {
            let d = f.uniforms[p] && f.uniforms[p].value;
            d && d.isTexture && free(d);
          }
        free(f);
      }
    });
  if (renderer) {
    try {
      renderer.setAnimationLoop(null);
    } catch {}
    try {
      renderer.dispose();
    } catch {}
    try {
      renderer.forceContextLoss();
    } catch {}
  }
  for (let h of ["__G", "__stats", "__setShot"])
    try {
      delete window[h];
    } catch {}
  context.frameHooks.length = 0;
}

export { createWorldRuntime };
