// ?perf=1 - a frame-cost breakdown to run on a phone. From one fixed camera, with dynamic resolution and
// the frame cap off, it measures the frame time with everything on, then with one thing switched off at a
// time (each restored before the next), then with everything on again (so heating up shows as drift), and
// lists what each item costs. Nothing here runs unless the page was opened with ?perf=1.
import { Vector3 } from "../vendor/three-r180.js";

function enablePerfProbe(context) {
  let box = document.createElement("pre");
  ((box.id = "perf"),
    (box.style.cssText =
      'position:absolute;left:max(10px,env(safe-area-inset-left));top:max(10px,env(safe-area-inset-top));z-index:90;margin:0;padding:10px 12px;font:11px/1.4 "IBM Plex Mono",ui-monospace,monospace;color:#d8f0d0;background:rgba(0,0,0,.8);white-space:pre;max-height:calc(100% - 20px);overflow:auto;pointer-events:auto;-webkit-user-select:text;user-select:text'),
    document.getElementById("app").appendChild(box));
  let gpu = "unknown";
  try {
    let gl = context.renderer.getContext(),
      ext = gl.getExtension("WEBGL_debug_renderer_info");
    gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {}
  let flags = (context.perfFlags = {}),
    path = context.level && context.level.cinematicPath,
    pos = new Vector3(...((path && path[0] && path[0].pos) || [-34, 1.6, 6.2])),
    look = new Vector3(...((path && path[0] && path[0].look) || [-12, 2.6, 6.6])),
    q0 = context.quality,
    byName = (n) => context.scene.getObjectByName(n),
    hide = (objs) => {
      let was = objs.filter(Boolean).map((o) => [o, o.visible]);
      for (let [o] of was) o.visible = !1;
      return () => {
        for (let [o, v] of was) o.visible = v;
      };
    },
    // a mesh whose visibility its owner sets every frame (rain): switch its material off instead
    hideMat = (objs) => {
      let was = objs.filter((o) => o && o.material).map((o) => [o.material, o.material.visible]);
      for (let [m] of was) m.visible = !1;
      return () => {
        for (let [m, v] of was) m.visible = v;
      };
    },
    setQ = (patch) => {
      context.render.setQuality({ ...context.quality, ...patch });
      return () => context.render.setQuality(q0);
    },
    TESTS = [
      ["everything on", () => () => {}],
      ["half resolution", () => setQ({ scale: (q0.scale || 1) * 0.5 })],
      ["no volumetric light", () => setQ({ volSteps: 0 })],
      ["no bloom", () => setQ({ bloom: !1 })],
      ["no AO", () => setQ({ ao: !1 })],
      ["no shadow map update", () => ((flags.noShadow = !0), () => (flags.noShadow = !1))],
      ["no rain drops/splash", () => hideMat([byName("rain"), byName("rainSplash")])],
      ["no ground/sea", () => hide([context.ground && context.ground.apron, context.ground && context.ground.sea])],
      ["no characters", () => hide([byName("enemies"), byName("saltline:opponent"), byName("DuoWorld:PlayerControlRoot")])],
      ["no level props", () => hide([byName("level")])],
      ["no backdrop", () => hide([byName("backdrop")])],
      ["no effects group", () => hide([byName("fx")])],
      ["everything on (again)", () => () => {}],
    ],
    SETTLE = 1.5,
    MEASURE = 4,
    results = [],
    i = -1,
    t = 0,
    undo = null,
    samples = [],
    cpu = [],
    started = !1,
    done = !1;

  context.player && (context.player.enabled = !1);
  context.frameCap = 0;

  let mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0),
    pad = (s, n) => (s + " ".repeat(n)).slice(0, n),
    num = (x, n = 1) => x.toFixed(n).padStart(6);

  function header() {
    let st = context.render.stats ? context.render.stats() : {},
      res = st.res || [0, 0];
    return `SALTLINE PERF  ${new Date().toISOString().slice(0, 16).replace("T", " ")}
GPU ${gpu}
screen ${innerWidth}x${innerHeight} css  dpr ${devicePixelRatio}  render ${res[0]}x${res[1]}  quality ${q0.name}${q0.phone ? " (phone)" : ""}
msaa ${q0.msaa} shadow ${q0.shadow} vol ${q0.volSteps} ao ${q0.ao ? 1 : 0} planar ${q0.planar} lite ${q0.lite ? 1 : 0}
`;
  }
  function table() {
    let base = results[0] ? results[0].ms : 0,
      lines = results.map(
        (r) =>
          `${pad(r.name, 22)}${num(r.ms)} ms${num(1000 / r.ms, 0)} fps  cpu${num(r.cpu)}${i > 0 && r !== results[0] ? "  " + (r.ms - base >= 0 ? "+" : "") + (r.ms - base).toFixed(1) : ""}`,
      );
    return lines.join("\n");
  }

  context.perfProbe = {
    get results() {
      return results;
    },
    get done() {
      return done;
    },
    frame(dt, frameSec, cpuMs) {
      if (done) return;
      context.camera.position.copy(pos);
      context.camera.lookAt(look);
      t += dt;
      if (!started) {
        // let the level, shaders and shadows settle before the first item
        if (t < 3) return void (box.textContent = header() + `\nwarming up... keep the phone still, do not touch`);
        ((started = !0), (t = SETTLE + MEASURE));
      }
      if (t >= SETTLE && t < SETTLE + MEASURE) (samples.push(frameSec * 1000), cpu.push(cpuMs));
      if (t < SETTLE + MEASURE) return;
      if (i >= 0) {
        // drop the slowest 5% (a GC pause or a notification is not what is measured here)
        let s = samples.slice().sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(samples.length * 0.95)));
        (results.push({ name: TESTS[i][0], ms: mean(s), cpu: mean(cpu), n: samples.length }), undo && undo());
      }
      ((samples = []), (cpu = []), (t = 0), i++);
      if (i >= TESTS.length) {
        done = !0;
        let base = results[0].ms,
          costs = results
            .slice(1, -1)
            .filter((r) => r.name !== "half resolution")
            .map((r) => [r.name, base - r.ms])
            .sort((a, b) => b[1] - a[1]);
        box.textContent =
          header() +
          "\n" +
          table() +
          `\n\nbiggest savings: ${costs
            .slice(0, 3)
            .map(([n, d]) => `${n} ${d.toFixed(1)} ms`)
            .join(", ")}\n(screenshot this and send it)`;
        console.log("[perf]\n" + box.textContent);
        return;
      }
      try {
        undo = TESTS[i][1]();
      } catch (e) {
        ((undo = null), console.error("[perf] " + TESTS[i][0] + ": " + e));
      }
      box.textContent = header() + "\n" + table() + `\n\nmeasuring ${i + 1}/${TESTS.length}: ${TESTS[i][0]}... keep the phone still`;
    },
  };
}

export { enablePerfProbe };
