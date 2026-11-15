// Keeps the game exactly the size of the visible screen on phones and tablets.
//
// iOS (and some Android WebViews) report a stale innerWidth/innerHeight for a while after a
// rotation, fire "resize" before layout has settled, and can leave the page scrolled a little
// (the old status-bar height), which shifts every touch target vertically and leaves the canvas
// with the wrong aspect ratio. So: the app box fills the screen with inset: 0 (no pixel sizes), its size is measured
// again over the second after any viewport change, the page is pinned to the top-left, and
// "saltline-viewport" is dispatched whenever the size actually changed (the renderer and the HUD
// re-measure on it instead of trusting the early "resize").
import { listen } from "../core/lifetime.js";

function isStandalone() {
  try {
    return !!navigator.standalone || matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches;
  } catch {
    return !1;
  }
}

function installViewport(context) {
  let root = document.documentElement,
    size = "",
    app = null,
    pending = [],
    why = "init",
    lastRaw = "",
    events = [],
    settle = (reason) => {
      typeof reason == "string" && (why = reason);
      // The numbers come from the window itself, never from #app: #app's own box depends on the
      // --fill / class set by the previous round, and measuring it feeds that back (the app box
      // used to flip between 874 and 936 px tall on an iPhone 16 Pro, several times a second).
      let vv = window.visualViewport,
        w = Math.round(window.innerWidth || (vv && vv.width) || 0),
        ih = Math.round(window.innerHeight || (vv && vv.height) || 0),
        h = ih;
      // every distinct set of numbers, with what triggered the measurement (see ?vpdebug=1)
      let vvh = vv ? Math.round(vv.height) : -1,
        raw = [window.innerWidth, window.innerHeight, vvh, root.clientHeight, w, h, app && app.clientHeight, root.style.getPropertyValue("--fill")].join("/");
      if (raw !== lastRaw) {
        lastRaw = raw;
        let line = `[vp] ${why} inner=${window.innerWidth}x${window.innerHeight} vv=${vv ? Math.round(vv.width) + "x" + vvh + "@" + Math.round(vv.offsetTop) : "-"} html=${root.clientWidth}x${root.clientHeight} calc=${w}x${h} appbox=${(app || (app = document.getElementById("app"))).clientWidth}x${app.clientHeight} fill=${root.style.getPropertyValue("--fill") || 0} screen=${screen.width}x${screen.height} avail=${screen.availWidth}x${screen.availHeight} standalone=${isStandalone()} scroll=${window.scrollY}`;
        (events.push(line), events.length > 6 && events.shift(), console.log(line));
      }
      if (!w || !h) return;
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      // Home Screen app: some iOS versions end the layout viewport above the home-indicator strip,
      // which shows as a black bar. The screen itself is taller than the layout by exactly that
      // strip, so grow the app box down to the real bottom edge (never more than 80 px, and
      // never while the numbers are mid-rotation).
      // Only when the window is exactly one of the screen's two orientations (not mid-rotation).
      let long = Math.max(screen.width, screen.height),
        short = Math.min(screen.width, screen.height),
        portrait = w <= h,
        full = portrait ? long : short,
        sane = portrait ? Math.abs(w - short) <= 1 : Math.abs(w - long) <= 1,
        gap = isStandalone() && sane ? full - ih : 0;
      gap = gap > 0 && gap <= 80 ? Math.round(gap) : 0;
      h = ih + gap;
      let next = w + "x" + h + "+" + gap;
      if (next === size) return;
      size = next;
      root.style.setProperty("--fill", gap + "px");
      root.style.setProperty("--vw", w + "px");
      root.style.setProperty("--vh", h + "px");
      window.dispatchEvent(new Event("saltline-viewport"));
    },
    measure = (e) => {
      let base = (e && e.type) || "measure";
      settle(base);
      // the numbers keep changing for a moment after a rotation or a toolbar change
      for (let id of pending) clearTimeout(id);
      pending = [60, 160, 320, 600, 1000, 1600].map((ms) => setTimeout(() => settle(`${base}+${ms}ms`), ms));
      requestAnimationFrame(() => requestAnimationFrame(() => settle(`${base}+raf`)));
    };
  for (let type of ["resize", "orientationchange", "pageshow", "focus"]) listen(context, window, type, measure, void 0, !1);
  window.visualViewport && listen(context, window.visualViewport, "resize", measure, void 0, !1);
  screen.orientation && listen(context, screen.orientation, "change", measure, void 0, !1);
  listen(context, document, "visibilitychange", () => document.visibilityState === "visible" && measure({ type: "visible" }), void 0, !1);
  // no pinch / double-tap zoom, and no rubber-band scrolling of the page behind the game
  for (let type of ["gesturestart", "gesturechange", "gestureend"]) listen(context, document, type, (e) => e.preventDefault(), { passive: !1 }, !1);
  listen(context, window, "scroll", () => (window.scrollX || window.scrollY) && window.scrollTo(0, 0), void 0, !1);
  // see ui.css html.is-standalone: the document itself must be as tall as the screen
  isStandalone() && root.classList.add("is-standalone");
  // ?vpdebug=1 prints the numbers on screen, for reporting layout problems from a real device
  let dbg = /[?&]vpdebug=1/.test(location.search);
  try { dbg = dbg || localStorage.getItem("saltline.vpdebug") === "1"; } catch {}
  // while a finger is on the left stick, say what the input and the player are doing (console)
  let stickLog = setInterval(() => {
    let g = window.__G || {},
      d = g.input && g.input.debug ? g.input.debug() : null;
    d && d.w >= 0 && g.player && console.log(`[stick] H=${d.H.toFixed(2)} O=${d.O.toFixed(2)} r=${d.r} move=${g.input.move.x.toFixed(2)},${g.input.move.y.toFixed(2)} spd=${(g.player.speed || 0).toFixed(2)} gnd=${g.player.onGround} crouch=${g.player.crouching} en=${g.player.enabled} pos=${g.player.pos.x.toFixed(1)},${g.player.pos.z.toFixed(1)} dt=${g.time && g.time.dt} state=${g.game && g.game.state}`);
  }, 500);
  if (dbg) {
    let box = document.createElement("pre");
    box.style.cssText = "position:fixed;left:6px;top:70px;z-index:99;margin:0;padding:4px 6px;font:10px/1.3 monospace;color:#9f9;background:rgba(0,0,0,.7);pointer-events:none;white-space:pre";
    document.body.appendChild(box);
    let inputLine = () => {
      let g = window.__G || {},
        i = g.input,
        p = g.player;
      if (!i || !p) return "input -";
      let d = i.debug ? i.debug() : {};
      return [
        `stick H${(d.H || 0).toFixed(2)} O${(d.O || 0).toFixed(2)} w${d.w} q${d.q} gp${+!!i.gamepad} r${+!!d.r} crouchT${+!!d.jc}`,
        `move ${i.move.x.toFixed(2)},${i.move.y.toFixed(2)} sprint${+!!i.sprint} spd${(p.speed || 0).toFixed(2)} gnd${+!!p.onGround} crch${+!!p.crouching} en${+!!p.enabled} alive${+!!p.alive}`,
        `pos ${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)},${p.pos.z.toFixed(1)} dt${((g.time && g.time.dt) || 0).toFixed(3)} frame${g.time && g.time.frame} cap${g.frameCap}`,
      ].join("\n");
    };
    let show = () => {
      let vv = window.visualViewport,
        a = document.getElementById("app");
      box.textContent = [
        `inner ${innerWidth}x${innerHeight}  vv ${vv ? Math.round(vv.width) + "x" + Math.round(vv.height) : "-"}`,
        `html ${root.clientWidth}x${root.clientHeight}  app ${a.clientWidth}x${a.clientHeight}`,
        `screen ${screen.width}x${screen.height} avail ${screen.availWidth}x${screen.availHeight}`,
        `standalone ${isStandalone()}  fill ${root.style.getPropertyValue("--fill") || 0}  capped ${root.classList.contains("vp-capped")}`,
        `sab ${getComputedStyle(root).getPropertyValue("--sab")} sat ${getComputedStyle(root).getPropertyValue("--sat")}`,
        inputLine(),
        ...events.slice(-3).map((l) => l.slice(5, 120)),
      ].join("\n");
    };
    setInterval(show, 500);
    show();
  }
  measure();
  return { measure, get size() { return size; } };
}

export { installViewport };
