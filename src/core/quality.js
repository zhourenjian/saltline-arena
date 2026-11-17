import { QUALITY_PRESETS } from "./config.js";

function isPhone() {
  return (
    /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900)
  );
}

// On a phone a higher preset means a sharper picture, not heavier effects: every preset drops motion
// blur and the lens extras, keeps MSAA low (FXAA + sharpening do the edges) and caps shadows, volumetric
// steps and rain, so the frame time goes into resolution, which is what makes players readable. A phone
// that renders a heavy preset at 16 fps ends up at a fraction of the resolution, which is far blurrier.
var PHONE = {
  low: { msaa: 0, shadow: 1024, tex: 512, volSteps: 8, ao: !1, planar: 0, rain: 0.35 },
  medium: { msaa: 0, shadow: 1024, tex: 1024, volSteps: 8, ao: !1, planar: 0, rain: 0.35 },
  high: { msaa: 0, shadow: 2048, tex: 1024, volSteps: 10, ao: !1, planar: 0.5, rain: 0.45 },
  ultra: { msaa: 2, shadow: 2048, tex: 1024, volSteps: 12, ao: !0, planar: 0.5, rain: 0.5 },
};

// a preset adjusted for this device (the settings menu and the automatic downgrade use this too,
// so a phone keeps its adjustments whichever preset is picked)
function presetFor(name) {
  let p = QUALITY_PRESETS[name];
  if (!p) return null;
  return name in PHONE && isPhone()
    ? {
        ...p,
        ...PHONE[name],
        motionBlur: !1,
        // no lens extras (sun flare, lens dirt, anamorphic streak and its two blur passes, film grain):
        // they do not help to see players and cost full-screen passes on a phone that already runs warm
        lite: !0,
        phone: !0,
      }
    : { ...p };
}

function chooseQuality(i) {
  if (i && QUALITY_PRESETS[i]) return presetFor(i);
  if (isPhone()) return presetFor("low");
  let t = "";
  try {
    let s = document.createElement("canvas"),
      o = s.getContext("webgl2") || s.getContext("webgl");
    if (o) {
      let r = o.getExtension("WEBGL_debug_renderer_info");
      t = String(
        r
          ? o.getParameter(r.UNMASKED_RENDERER_WEBGL)
          : o.getParameter(o.RENDERER),
      );
      let a = o.getExtension("WEBGL_lose_context");
      a && a.loseContext();
    }
  } catch {}
  return presetFor(
    /SwiftShader|llvmpipe|Software|Mali|Adreno|PowerVR/i.test(t) ||
      (/Intel/i.test(t) && !/Arc/i.test(t))
      ? "medium"
      : "high",
  );
}

export { chooseQuality, isPhone, presetFor };
