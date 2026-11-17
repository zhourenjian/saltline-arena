// ?perf=1 - a frame-cost breakdown to run on a phone. Nothing here runs without ?perf=1.
//
// Frame rate is useless for this on iOS: Safari presents on vsync, so a frame takes 16.7 or 33.3 ms
// and a few ms more or less flips between the two (and the phone heating up flips it too). So every
// frame is timed to the end of its GPU work instead: after rendering, a 1-pixel readPixels waits for the
// GPU to finish, and "work" is the time from the start of the frame to then. And every item is measured
// against its own neighbours - switched off and on in turn, three times, in the order on-off, off-on,
// on-off - so slow drift from heating up cancels out of the difference instead of favouring "off".
import { Vector3 } from "../vendor/three-r180.js";

function enablePerfProbe(context) {
  let box = document.createElement("pre");
  ((box.id = "perf"),
    (box.style.cssText =
      'position:absolute;left:max(10px,env(safe-area-inset-left));top:max(10px,env(safe-area-inset-top));z-index:90;margin:0;padding:10px 12px;font:11px/1.4 "IBM Plex Mono",ui-monospace,monospace;color:#d8f0d0;background:rgba(0,0,0,.82);white-space:pre;max-width:calc(100% - 20px);max-height:calc(100% - 20px);overflow:auto;pointer-events:auto;-webkit-user-select:text;user-select:text'),
    document.getElementById("app").appendChild(box));
  let gl = context.renderer.getContext(),
    gpu = "unknown";
  try {
    let ext = gl.getExtension("WEBGL_debug_renderer_info");
    gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {}
  let flags = (context.perfFlags = {}),
    path = context.level && context.level.cinematicPath,
    view = (k, p, l) => [new Vector3(...((path && path[k] && path[k].pos) || p)), new Vector3(...((path && path[k] && path[k].look) || l))],
    // view 1 looks down the length of the yard (sees ~90% of it), view 2 into one corner (~30%)
    VIEWS = [view(0, [-34, 1.6, 6.2], [-12, 2.6, 6.6]), view(5, [-3.2, 2.2, -15], [-2, 2.2, -20.5])],
    q0 = { ...context.quality },
    byName = (n) => context.scene.getObjectByName(n),
    hide = (objs) => {
      let was = objs.filter(Boolean).map((o) => [o, o.visible]);
      for (let [o] of was) o.visible = !1;
      return () => {
        for (let [o, v] of was) o.visible = v;
      };
    },
    // meshes whose owner sets .visible every frame (rain): switch the material off instead
    hideMat = (objs) => {
      let was = objs.filter((o) => o && o.material).map((o) => [o.material, o.material.visible]);
      for (let [m] of was) m.visible = !1;
      return () => {
        for (let [m, v] of was) m.visible = v;
      };
    },
    setQ = (patch) => (context.render.setQuality({ ...q0, ...patch }), () => context.render.setQuality({ ...q0 })),
    TESTS = [
      ["half resolution", () => setQ({ scale: (q0.scale || 1) * 0.5 })],
      ["volumetric light", () => setQ({ volSteps: 0 })],
      ["bloom", () => setQ({ bloom: !1 })],
      q0.ao && ["AO", () => setQ({ ao: !1 })],
      ["shadow map update", () => ((flags.noShadow = !0), () => (flags.noShadow = !1))],
      ["rain drops/splash", () => hideMat([byName("rain"), byName("rainSplash")])],
      ["ground + sea", () => hide([context.ground && context.ground.apron, context.ground && context.ground.sea])],
      ["characters", () => hide([byName("enemies"), byName("saltline:opponent"), byName("DuoWorld:PlayerControlRoot")])],
      ["gun (first person)", () => (context.weapon && context.weapon.setVisible ? (context.weapon.setVisible(!1), () => context.weapon.setVisible(!0)) : () => {})],
      ["level props", () => hide([byName("level")])],
      ["backdrop", () => hide([byName("backdrop")])],
      ["effects group", () => hide([byName("fx")])],
      // view 2: what the level costs where most of it is out of sight, and what culling the cells saves
      ["level props, view 2", () => hide([byName("level")]), { view: 1 }],
      [
        "cell culling, view 2",
        () => {
          let was = [];
          (byName("level-merged") || { children: [] }).children.forEach((o) => (was.push([o, o.frustumCulled]), (o.frustumCulled = !1)));
          return () => was.forEach(([o, v]) => (o.frustumCulled = v));
        },
        { view: 1, invert: !0 },
      ],
    ].filter(Boolean),
    CYCLES = 3,
    SETTLE = 0.45,
    MEASURE = 1.0,
    PHASE = SETTLE + MEASURE,
    results = [],
    onAll = [],
    item = -1,
    phase = 0, // 0..2*CYCLES-1; see isOff
    t = 0,
    undo = null,
    work = [],
    cpu = [],
    vs = [],
    cur = null,
    pixel = new Uint8Array(4),
    lastCpu = 0,
    lastWork = 0,
    started = !1,
    done = !1,
    // after the run: frame rate with and without waiting for the GPU each frame, 10 s each in turn
    after = { sync: !0, t0: 0, frames: 0, log: [] };

  context.player && (context.player.enabled = !1);
  context.frameCap = 0;

  // cycle 0: on, off; cycle 1: off, on; cycle 2: on, off ...
  let isOff = (ph) => ((ph >> 1) & 1 ? ph % 2 === 0 : ph % 2 === 1),
    trimmed = (a) => {
      if (!a.length) return 0;
      let s = a.slice().sort((x, y) => x - y).slice(0, Math.max(1, Math.ceil(a.length * 0.9)));
      return s.reduce((x, y) => x + y, 0) / s.length;
    },
    mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0),
    pad = (s, n) => (s + " ".repeat(n)).slice(0, n),
    num = (x, n = 1) => x.toFixed(n).padStart(6),
    baseWork = () => mean(onAll.map((p) => p.work));

  function header() {
    let st = context.render.stats ? context.render.stats() : {},
      res = st.res || [0, 0];
    return `SALTLINE PERF v4  ${new Date().toISOString().slice(0, 16).replace("T", " ")}
GPU ${gpu}
screen ${innerWidth}x${innerHeight} css  dpr ${devicePixelRatio}  render ${res[0]}x${res[1]}  quality ${q0.name}${q0.phone ? " (phone)" : ""}
msaa ${q0.msaa} shadow ${q0.shadow} vol ${q0.volSteps} ao ${q0.ao ? 1 : 0} planar ${q0.planar} lite ${q0.lite ? 1 : 0}
`;
  }
  function body() {
    let b = baseWork(),
      first = onAll[0],
      last = onAll[onAll.length - 1],
      lines = results.map((r) =>
        r.view
          ? `${pad(r.name, 20)}${num(r.cost)} ms  (all on there: ${r.on.toFixed(1)} ms)`
          : `${pad(r.name, 20)}${num(r.cost)} ms ${num((100 * r.cost) / Math.max(b, 0.1), 0)}%`,
      );
    return (
      (onAll.length
        ? `all on: work ${b.toFixed(1)} ms (cpu ${mean(onAll.map((p) => p.cpu)).toFixed(1)} ms)  display ${mean(onAll.map((p) => p.vs)).toFixed(1)} ms/frame\nheat drift: first ${first.work.toFixed(1)} -> latest ${last.work.toFixed(1)} ms\n\n`
        : "") +
      `${pad("switched off", 20)}  saves     share\n` +
      lines.join("\n")
    );
  }
  let final = "";
  function afterRun() {
    // wall clock, not the game's dt (which is clamped on slow frames)
    let now = performance.now();
    after.t0 || (after.t0 = now);
    after.frames++;
    let sec = (now - after.t0) / 1000;
    if (sec < 10) return;
    after.log.push(`${after.sync ? "waiting for GPU" : "not waiting    "}  ${(after.frames / sec).toFixed(1).padStart(5)} fps`);
    after.log.length > 8 && after.log.shift();
    ((after.sync = !after.sync), (after.t0 = now), (after.frames = 0));
    box.textContent =
      final + `\n\nafter the run, view 1, 10 s each (keep still):\n` + after.log.join("\n") + `\nnow: ${after.sync ? "waiting for GPU" : "not waiting"}...`;
  }
  function status() {
    box.textContent =
      header() + "\n" + body() + `\n\nmeasuring ${item + 1}/${TESTS.length}: ${TESTS[item][0]} ${isOff(phase) ? "OFF" : "on"} (${(phase >> 1) + 1}/${CYCLES})... keep still`;
  }
  function endPhase() {
    let p = { work: trimmed(work), cpu: trimmed(cpu), vs: trimmed(vs) };
    ((work = []), (cpu = []), (vs = []));
    if (isOff(phase)) cur.off.push(p);
    else (cur.opt.view || onAll.push(p), cur.on.push(p));
  }

  context.perfProbe = {
    get results() {
      return results;
    },
    get done() {
      return done;
    },
    get text() {
      return box.textContent;
    },
    // called before the frame is rendered: fixed camera, the schedule
    frame(dt, frameSec) {
      let [pos, look] = VIEWS[(cur && cur.opt.view) || 0];
      context.camera.position.copy(pos);
      context.camera.lookAt(look);
      if (done) return void afterRun();
      t += dt;
      if (!started) {
        if (t < 3) return void (box.textContent = header() + `\nwarming up... keep the phone still, do not touch`);
        ((started = !0), (t = PHASE), (phase = 2 * CYCLES - 1));
      }
      if (t >= SETTLE && t < PHASE && cur) (work.push(lastWork), cpu.push(lastCpu), vs.push(frameSec * 1000));
      if (t < PHASE) return;
      t = 0;
      if (cur) endPhase();
      if (cur && phase === 2 * CYCLES - 1) {
        // item finished: the cost is the mean "on" work minus the mean "off" work of its own phases
        let d = mean(cur.on.map((p) => p.work)) - mean(cur.off.map((p) => p.work));
        results.push({ name: cur.name, cost: cur.opt.invert ? -d : d, view: cur.opt.view, on: mean(cur.on.map((p) => p.work)) });
        cur = null;
      }
      if (phase === 2 * CYCLES - 1) {
        (item++, (phase = 0));
        if (item >= TESTS.length) {
          done = !0;
          let top = results.filter((r) => r.name !== "half resolution" && !r.view).sort((a, b) => b.cost - a.cost);
          final =
            header() +
            "\n" +
            body() +
            `\n\nmost expensive: ${top
              .slice(0, 3)
              .map((r) => `${r.name} ${r.cost.toFixed(1)} ms`)
              .join(", ")}\n(screenshot this and send it)`;
          box.textContent = final;
          console.log("[perf]\n" + final);
          return;
        }
        cur = { name: TESTS[item][0], on: [], off: [], opt: TESTS[item][2] || {} };
      } else phase++;
      if (isOff(phase)) {
        if (undo) return void status();
        try {
          undo = TESTS[item][1]();
        } catch (e) {
          ((undo = null), console.error("[perf] " + TESTS[item][0] + ": " + e));
        }
      } else (undo && undo(), (undo = null));
      status();
    },
    // called after the frame is rendered: wait for the GPU, time the whole frame's work
    afterRender(start) {
      if (!started || (done && !after.sync)) return;
      lastCpu = performance.now() - start;
      try {
        (context.renderer.setRenderTarget(null), gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel));
      } catch {}
      lastWork = performance.now() - start;
    },
  };
}

export { enablePerfProbe };
