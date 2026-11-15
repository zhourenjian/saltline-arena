// "Add to Home Screen" guide for phones and tablets. Opened from the title screen, and once by
// itself on the first visit in a browser tab (not when already running from the Home Screen).
// Standalone (Home Screen) mode has no browser bars and the page can use the whole screen, so
// the game asks for it; the steps differ per platform:
//   iOS / iPadOS  Share ▸ Add to Home Screen (any browser on iOS 16.4+)
//   Android       Chrome menu ▸ Install app / Add to Home screen (a real Install button when the
//                 browser offers one), plus the Fullscreen API for a quick full screen in a tab
import { listen } from "../core/lifetime.js";

const HIDE_KEY = "saltline.install.hideUntil";
const HIDE_DAYS = 7;

function detectDevice(nav = navigator, win = window) {
  let ua = nav.userAgent || "",
    ipadOS = /Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1,
    ios = /iPhone|iPad|iPod/.test(ua) || ipadOS,
    android = /Android/.test(ua),
    coarse = !!(win.matchMedia && win.matchMedia("(pointer: coarse)").matches),
    standalone = !!(nav.standalone || (win.matchMedia && (win.matchMedia("(display-mode: standalone)").matches || win.matchMedia("(display-mode: fullscreen)").matches))),
    safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Android/.test(ua);
  return { ios, android, touch: ios || android || (coarse && (nav.maxTouchPoints || 0) > 0), standalone, safari, platform: ios ? "ios" : android ? "android" : "other" };
}

const STEPS = {
  ios: [
    ["Tap the Share button", "The square with an arrow, in the bar at the bottom (or top) of the browser."],
    ["Choose \u201CAdd to Home Screen\u201D", "Scroll down the list if you do not see it. Turn on \u201COpen as Web App\u201D if it is offered."],
    ["Tap Add", "A Saltline icon appears on your Home Screen."],
    ["Open Saltline from the Home Screen", "It now runs full screen, with no address bar. Rotating to landscape gives the most room."],
  ],
  android: [
    ["Open the browser menu", "The \u22EE button in Chrome (or \u2630 in other browsers)."],
    ["Choose \u201CInstall app\u201D", "Or \u201CAdd to Home screen\u201D. Accept the prompt."],
    ["Open Saltline from the Home Screen", "It now runs full screen, with no address bar. Rotating to landscape gives the most room."],
  ],
  other: [
    ["Use your browser\u2019s \u201CAdd to Home Screen\u201D / \u201CInstall app\u201D", "Then open Saltline from the icon: it runs full screen without browser bars."],
  ],
};

function createInstallGuide(context) {
  let dev = detectDevice(),
    host = document.getElementById("ui") || document.body,
    deferred = null,
    root = document.createElement("div"),
    storage = {
      get() {
        try {
          return +localStorage.getItem(HIDE_KEY) || 0;
        } catch {
          return 0;
        }
      },
      set(v) {
        try {
          localStorage.setItem(HIDE_KEY, String(v));
        } catch {}
      },
    },
    canFullscreen = !!(document.documentElement.requestFullscreen && !dev.ios);

  root.className = "install-guide";
  root.hidden = !0;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Add Saltline to your Home Screen");
  host.appendChild(root);

  function render() {
    let steps = STEPS[dev.platform],
      note =
        dev.ios && !dev.safari
          ? "<p class=\"ig-note\">On iPhone and iPad, Add to Home Screen works in Safari and, from iOS 16.4, in Chrome and other browsers.</p>"
          : "";
    root.innerHTML = `
      <div class="ig-card">
        <div class="ig-k">Full screen</div>
        <h2 class="ig-h">Play from your Home Screen</h2>
        <p class="ig-p">In a browser tab the address bar and toolbar eat the screen and can jump around when you turn the device. Added to the Home Screen, Saltline fills the whole display.</p>
        <ol class="ig-steps">${steps.map((s, i) => `<li><b>${i + 1}</b><span><strong>${s[0]}</strong><small>${s[1]}</small></span></li>`).join("")}</ol>
        ${note}
        <div class="ig-actions">
          ${deferred ? '<button class="btn primary" data-ig="install">Install now</button>' : ""}
          ${canFullscreen ? `<button class="btn${deferred ? "" : " primary"}" data-ig="fullscreen">Full screen now</button>` : ""}
          <button class="btn${deferred || canFullscreen ? "" : " primary"}" data-ig="close">Got it</button>
          <button class="btn" data-ig="later">Don\u2019t remind me for a week</button>
        </div>
      </div>`;
  }
  function open() {
    render();
    root.hidden = !1;
    let b = root.querySelector(".btn.primary");
    b && b.focus({ preventScroll: !0 });
    context.events && context.events.emit && context.events.emit("install-guide:open", {});
  }
  function close(days = 0) {
    root.hidden = !0;
    days && storage.set(Date.now() + days * 864e5);
  }
  listen(context, root, "click", async (e) => {
    let b = e.target.closest("[data-ig]");
    if (!b) return void (e.target === root && close(1));
    let a = b.dataset.ig;
    if (a === "close") close(1);
    else if (a === "later") close(HIDE_DAYS);
    else if (a === "fullscreen") {
      try {
        await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      } catch {}
      close();
    } else if (a === "install" && deferred) {
      try {
        deferred.prompt();
        await deferred.userChoice;
      } catch {}
      deferred = null;
      close(HIDE_DAYS);
    }
  }, void 0, !1);
  listen(context, window, "beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
  }, void 0, !1);
  listen(context, window, "appinstalled", () => close(HIDE_DAYS), void 0, !1);

  // the title screen's link (a plain <a>, so the menu's own button handler leaves it alone)
  let link = document.querySelector("[data-install]");
  if (link) {
    let wrap = link.closest(".m-install") || link;
    wrap.hidden = !(dev.touch && !dev.standalone);
    listen(context, link, "click", (e) => (e.preventDefault(), open()), void 0, !1);
  }
  // once, a moment after the title screen shows (never in the installed app)
  let params = context.params || {};
  if (dev.touch && !dev.standalone && !params.noinstall && (Date.now() > storage.get() || params.install === "1")) {
    let t = setTimeout(() => {
      context.game && context.game.state === "title" && root.hidden && open();
    }, 1800);
    context.lifetime && context.lifetime.signal && context.lifetime.signal.addEventListener("abort", () => clearTimeout(t));
  }
  return { root, open, close, device: dev, get visible() { return !root.hidden; } };
}

export { createInstallGuide, detectDevice };
