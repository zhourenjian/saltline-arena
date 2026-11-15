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
    settle = () => {
      // the layout box of #app (position: fixed; inset: 0) is the truth: it follows the real visible
      // area, including the home-indicator strip, where innerHeight can come up short
      let vv = window.visualViewport,
        box = app || (app = document.getElementById("app")),
        w = Math.round((box && box.clientWidth) || window.innerWidth || (vv && vv.width) || 0),
        h = Math.round((box && box.clientHeight) || window.innerHeight || (vv && vv.height) || 0);
      if (!w || !h) return;
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      // Home Screen app: some iOS versions end the layout viewport above the home-indicator strip,
      // which shows as a black bar. The screen itself is taller than the layout by exactly that
      // strip, so grow the app box down to the real bottom edge (never more than 80 px, and
      // never while the numbers are mid-rotation).
      let lh = root.clientHeight,
        lw = root.clientWidth,
        long = Math.max(screen.width, screen.height),
        short = Math.min(screen.width, screen.height),
        full = lh >= lw ? long : short,
        gap = isStandalone() ? full - lh : 0;
      gap = gap > 0 && gap <= 80 ? Math.round(gap) : 0;
      let next = w + "x" + h + "+" + gap;
      if (next === size) return;
      size = next;
      root.style.setProperty("--fill", gap + "px");
      root.style.setProperty("--vw", w + "px");
      root.style.setProperty("--vh", h + "px");
      window.dispatchEvent(new Event("saltline-viewport"));
    },
    measure = () => {
      settle();
      // the numbers keep changing for a moment after a rotation or a toolbar change
      for (let id of pending) clearTimeout(id);
      pending = [60, 160, 320, 600, 1000, 1600].map((ms) => setTimeout(settle, ms));
      requestAnimationFrame(() => requestAnimationFrame(settle));
    };
  for (let type of ["resize", "orientationchange", "pageshow", "focus"]) listen(context, window, type, measure, void 0, !1);
  window.visualViewport && listen(context, window.visualViewport, "resize", measure, void 0, !1);
  screen.orientation && listen(context, screen.orientation, "change", measure, void 0, !1);
  listen(context, document, "visibilitychange", () => document.visibilityState === "visible" && measure(), void 0, !1);
  // no pinch / double-tap zoom, and no rubber-band scrolling of the page behind the game
  for (let type of ["gesturestart", "gesturechange", "gestureend"]) listen(context, document, type, (e) => e.preventDefault(), { passive: !1 }, !1);
  listen(context, window, "scroll", () => (window.scrollX || window.scrollY) && window.scrollTo(0, 0), void 0, !1);
  // see ui.css html.is-standalone: the document itself must be as tall as the screen
  isStandalone() && root.classList.add("is-standalone");
  measure();
  return { measure, get size() { return size; } };
}

export { installViewport };
