// DOM menus, persisted settings and controls panels.
import { listen } from "../core/lifetime.js";
import { PLAYER_DIMENSIONS, QUALITY_PRESETS } from "../core/config.js";

var SETTINGS_KEY = "saltline.settings.v1";

var DEFAULT_SETTINGS = {
  quality: "auto",
  sens: 1,
  invertY: !1,
  volume: 0.8,
  fov: PLAYER_DIMENSIONS.fov,
};

var QUALITY_NAMES = ["low", "medium", "high", "ultra"];

function loadSettings() {
  let i = {
    ...DEFAULT_SETTINGS,
  };
  try {
    let e = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    e &&
      typeof e == "object" &&
      ((e.quality === "auto" || QUALITY_NAMES.includes(e.quality)) &&
        (i.quality = e.quality),
      Number.isFinite(e.sens) && (i.sens = Math.min(3, Math.max(0.2, e.sens))),
      (i.invertY = !!e.invertY),
      Number.isFinite(e.volume) &&
        (i.volume = Math.min(1, Math.max(0, e.volume))),
      Number.isFinite(e.fov) && (i.fov = Math.min(95, Math.max(60, e.fov))));
  } catch {}
  return i;
}

function saveSettings(i) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(i));
  } catch {}
}

var KEYBOARD_CONTROLS_HTML = `
  <dl class="keys">
    <div><dt>Move</dt><dd><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dd></div>
    <div><dt>Look</dt><dd>Mouse</dd></div>
    <div><dt>Fire</dt><dd>Left button</dd></div>
    <div><dt>Aim</dt><dd>Right button</dd></div>
    <div><dt>Reload</dt><dd><kbd>R</kbd></dd></div>
    <div><dt>Cut relay</dt><dd>Hold <kbd>E</kbd></dd></div>
    <div><dt>Jump</dt><dd><kbd>Space</kbd></dd></div>
    <div><dt>Climb</dt><dd><kbd>W</kbd> + <kbd>Space</kbd> at a ledge</dd></div>
    <div><dt>Ladder</dt><dd><kbd>E</kbd> or <kbd>W</kbd> + <kbd>Space</kbd>, then <kbd>W</kbd> / <kbd>S</kbd></dd></div>
    <div><dt>Sprint</dt><dd><kbd>Shift</kbd></dd></div>
    <div><dt>Crouch</dt><dd><kbd>C</kbd> or <kbd>Ctrl</kbd></dd></div>
    <div><dt>Melee</dt><dd><kbd>F</kbd></dd></div>
    <div><dt>Pause</dt><dd><kbd>Esc</kbd> or <kbd>P</kbd></dd></div>
  </dl>`;

var TOUCH_CONTROLS_HTML = `
  <dl class="keys">
    <div><dt>Move</dt><dd>Left thumb, anywhere</dd></div>
    <div><dt>Look</dt><dd>Drag the right side</dd></div>
    <div><dt>Fire</dt><dd>Hold FIRE, drag to track</dd></div>
    <div><dt>Aim</dt><dd>AIM toggles</dd></div>
    <div><dt>Reload</dt><dd>RLD</dd></div>
    <div><dt>Jump</dt><dd>JUMP</dd></div>
    <div><dt>Climb</dt><dd>JUMP while moving at a ledge</dd></div>
    <div><dt>Ladder</dt><dd>USE at a ladder, then the stick</dd></div>
    <div><dt>Cut relay</dt><dd>Hold USE at a relay</dd></div>
    <div><dt>Sprint</dt><dd>Push the stick fully forward</dd></div>
  </dl>`;

function createMenus(context, e) {
  let t = document.getElementById("ui"),
    n = loadSettings(),
    s = document.createElement("div");
  ((s.className = "menu"),
    (s.dataset.screen = "none"),
    (s.innerHTML = `
    <div class="m-veil"></div>
    <div class="m-bars"><i></i><i></i></div>

    <section class="m-screen m-title" data-s="title" aria-label="Saltline Arena">
      <div class="m-title-main">
        <div class="m-eyebrow"><span class="m-tag">B4</span><span>Live multiplayer shooter</span><span class="m-dim">Up to 6 players \xB7 free \xB7 no sign-up</span></div>
        <h1 class="m-word" aria-label="Saltline Arena"><span>SALTLINE</span><span class="m-word-sub">ARENA</span></h1>
        <p class="m-premise">Drop into a live brawl with players worldwide. Last place is cut every minute. Be the one still standing.</p>
        <div class="m-actions m-main" role="group" aria-label="Main menu">
          <button class="btn primary" data-act="brawl">Play</button>
          <button class="btn" data-act="character">Character</button>
          <button class="btn" data-act="settings">Settings</button>
          <button class="btn m-only-narrow" data-act="controls">Controls</button>
          <button class="btn m-more-btn" data-act="more" aria-expanded="false" aria-controls="m-more">More modes</button>
          <div class="m-more" id="m-more" hidden>
            <button class="btn" data-act="deploy">Mission \xB7 solo</button>
            <button class="btn" data-act="versus">1v1 Duel</button>
          </div>
        </div>
        <p class="m-wearing">Character <b data-f="char-name">Operator</b></p>
        <p class="m-install" hidden><a href="#" data-install>Play full screen: add to Home Screen \u203A</a></p>
        <p class="m-note">Every surface, machine and sound is generated in your browser. Nothing is downloaded.</p>
        <p class="m-gh"><a href="https://github.com/zhourenjian/saltline-arena" target="_blank" rel="noopener noreferrer" data-gh>Available on GitHub \u203A</a></p>
      </div>
      <aside class="m-legend" aria-label="Controls at a glance">
        <div><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Move</span><span><kbd>Mouse</kbd> Look</span><span><kbd>LMB</kbd> Fire</span><span><kbd>RMB</kbd> Aim</span><span><kbd>R</kbd> Reload</span></div>
        <div><span><kbd>E</kbd> Cut relay</span><span><kbd>Space</kbd> Jump / climb</span><span><kbd>Shift</kbd> Sprint</span><span><kbd>C</kbd> Crouch</span><span><kbd>Esc</kbd> Pause</span></div>
        <div class="lg-touch"><em>Touch</em><span>Left thumb moves</span><span>Right thumb looks</span><span>Fire \xB7 Aim \xB7 Reload \xB7 Jump on screen</span></div>
      </aside>
    </section>

    <section class="m-screen m-card" data-s="paused" aria-label="Paused">
      <div class="m-k">Operation on hold</div>
      <h2 class="m-h">Paused</h2>
      <p class="m-line" data-f="lookmode"></p>
      <div class="m-actions col">
        <button class="btn primary" data-act="resume">Resume</button>
        <button class="btn" data-act="settings">Settings</button>
        <button class="btn" data-act="controls">Controls</button>
        <button class="btn" data-act="restart" data-only="mission">Restart mission</button>
        <button class="btn" data-act="br-watch" data-only="brawl">Leave seat \xB7 watch</button>
        <button class="btn" data-act="quit">Main menu</button>
      </div>
    </section>

    <section class="m-screen m-card m-dead" data-s="dead" aria-label="Signal lost">
      <div class="m-k">Breacher down</div>
      <h2 class="m-h">Signal lost</h2>
      <dl class="m-stats"><div><dt>Time survived</dt><dd data-f="dead-time">00:00</dd></div><div><dt>Relays cut</dt><dd data-f="dead-relays">0/3</dd></div></dl>
      <div class="m-actions col"><button class="btn primary" data-act="retry">Retry</button><button class="btn" data-act="quit">Main menu</button></div>
    </section>

    <section class="m-screen m-card m-debrief" data-s="complete" aria-label="Debrief">
      <div class="m-k">Berth 4 \xB7 Debrief</div>
      <h2 class="m-h">Saltline is dark</h2>
      <div class="m-rating"><span>Rating</span><b data-f="rating">Clean</b></div>
      <dl class="m-stats">
        <div><dt>Time</dt><dd data-f="time">00:00</dd></div>
        <div><dt>Accuracy</dt><dd data-f="acc">0%</dd></div>
        <div><dt>Machines destroyed</dt><dd data-f="kills">0</dd></div>
        <div><dt>Retries</dt><dd data-f="retries">0</dd></div>
      </dl>
      <div class="m-actions col"><button class="btn primary" data-act="redeploy">Redeploy</button><button class="btn" data-act="quit">Main menu</button></div>
    </section>

    <section class="m-screen m-card m-chars" data-s="character" aria-label="Character">
      <div class="m-k">Loadout \xB7 Body</div>
      <h2 class="m-h">Character</h2>
      <p class="m-line">Your pick is what the other player sees in a duel, and what you see in third person (<kbd>T</kbd>).</p>
      <div class="ch-list" data-f="ch-list" role="listbox" aria-label="Characters"></div>
      <p class="ch-info" data-f="ch-info" role="status"></p>
      <div class="m-actions"><button class="btn primary" data-act="ch-done">Done</button></div>
    </section>

    <section class="m-screen m-card m-versus" data-s="versus" aria-label="1v1 duel">
      <div class="m-k">Harbor \xB7 1v1</div>
      <h2 class="m-h">Duel</h2>
      <p class="m-line">First to 5 kills. No machines. Respawn 3 s after a death. Both players connect to the same duel server (<code>npm run server</code>).</p>
      <div class="vs-form">
        <label class="vs-field" hidden><span>Server</span><input data-f="vs-server" type="text" spellcheck="false" autocomplete="off" inputmode="url"></label>
        <label class="vs-field"><span>Callsign</span><input data-f="vs-name" type="text" minlength="3" maxlength="8" spellcheck="false" autocomplete="off"></label>
      </div>
      <div class="vs-lobby" data-f="vs-lobby">
        <button class="btn primary" data-act="vs-create">Create room</button>
        <div class="vs-join">
          <input data-f="vs-code" type="text" maxlength="4" placeholder="CODE" aria-label="Room code" spellcheck="false" autocomplete="off" autocapitalize="characters">
          <button class="btn" data-act="vs-join">Join</button>
        </div>
      </div>
      <div class="vs-room" data-f="vs-room" hidden>
        <div class="vs-code-row"><span>Room code</span><b data-f="vs-room-code">----</b></div>
        <ol class="vs-players" data-f="vs-players"></ol>
      </div>
      <p class="vs-status" data-f="vs-status" role="status" aria-live="polite"></p>
      <div class="m-actions"><button class="btn" data-act="vs-back">Back</button></div>
    </section>

    <section class="m-screen m-card m-versus" data-s="brawl" aria-label="Brawl">
      <div class="m-k">Harbor \xB7 free for all</div>
      <h2 class="m-h">Brawl</h2>
      <p class="m-line">Up to 6 players, everyone against everyone. Arena full? You queue and watch. Last place is cut every minute while people wait.</p>
      <div class="vs-form">
        <label class="vs-field" hidden><span>Server</span><input data-f="br-server" type="text" spellcheck="false" autocomplete="off" inputmode="url"></label>
        <label class="vs-field"><span>Callsign</span><input data-f="br-name" type="text" minlength="3" maxlength="8" spellcheck="false" autocomplete="off"></label>
      </div>
      <p class="vs-status" data-f="br-status" role="status" aria-live="polite"></p>
      <div class="m-actions"><button class="btn primary" data-act="br-enter">Join the brawl</button><button class="btn" data-act="br-watch-only">Watch only</button><button class="btn" data-act="br-back">Back</button></div>
    </section>

    <section class="m-screen m-card m-vsresult" data-s="vs-result" aria-label="Duel result">
      <div class="m-k" data-f="vsr-kicker">Duel over</div>
      <h2 class="m-h" data-f="vsr-title">Victory</h2>
      <div class="vsr-score"><span data-f="vsr-you">You</span><b data-f="vsr-score">5 : 0</b><span data-f="vsr-them">Opponent</span></div>
      <p class="vs-status" data-f="vsr-status" role="status" aria-live="polite"></p>
      <div class="m-actions col"><button class="btn primary" data-act="vs-rematch">Rematch</button><button class="btn" data-act="quit">Main menu</button></div>
    </section>

    <div class="panel" role="dialog" aria-modal="true" aria-label="Settings and controls" tabindex="-1" hidden>
      <header class="panel-h">
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" data-tab="settings" aria-selected="true">Settings</button>
          <button class="tab" role="tab" data-tab="controls" aria-selected="false">Controls</button>
        </div>
        <button class="btn small" data-act="close-panel">Close</button>
      </header>
      <div class="panel-b" data-pane="settings">
        <div class="row"><label id="l-q">Graphics quality</label>
          <div class="seg" role="group" aria-labelledby="l-q">${QUALITY_NAMES.map((U) => `<button data-q="${U}" aria-pressed="false">${U}</button>`).join("")}</div></div>
        <div class="row"><label for="s-sens">Mouse sensitivity</label><div class="slider"><input id="s-sens" type="range" min="0.2" max="3" step="0.05"><output data-o="sens"></output></div></div>
        <div class="row"><label id="l-inv">Invert Y</label><button class="toggle" data-act="invert" aria-labelledby="l-inv" aria-pressed="false"><i></i><span>Off</span></button></div>
        <div class="row"><label for="s-vol">Master volume</label><div class="slider"><input id="s-vol" type="range" min="0" max="100" step="1"><output data-o="vol"></output></div></div>
        <div class="row"><label for="s-fov">Field of view</label><div class="slider"><input id="s-fov" type="range" min="60" max="95" step="1"><output data-o="fov"></output></div></div>
        <div class="row" data-row="fs"><label id="l-fs">Display</label><button class="btn small" data-act="fullscreen" aria-labelledby="l-fs fs-t"><span id="fs-t">Enter fullscreen</span></button></div>
        <p class="panel-note" data-f="qnote"></p>
      </div>
      <div class="panel-b" data-pane="controls" hidden>
        <h3>Keyboard \xB7 Mouse</h3>${KEYBOARD_CONTROLS_HTML}
        <p class="panel-note">If the browser will not capture the mouse, hold a mouse button and drag to look (left also fires, right also aims). Arrow keys or <kbd>I</kbd><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd> turn, <kbd>Enter</kbd> fires.</p>
        <h3>Touch</h3>${TOUCH_CONTROLS_HTML}
        <h3>Gamepad</h3>
        <p class="panel-note">Sticks move and look \xB7 RT fire \xB7 LT aim \xB7 A jump \xB7 B crouch \xB7 X reload \xB7 Y cut relay \xB7 L3 sprint \xB7 Start pause.</p>
      </div>
    </div>

    <div class="loc-card" aria-hidden="true"><i></i><b>Saltline Terminal \xB7 Berth 4 \xB7 05:42</b><span>Port Authority Breach Unit \u2014 one breacher, no backup</span></div>
  `),
    t.appendChild(s));
  let o = (U) => s.querySelector(U),
    r = (U) => [...s.querySelectorAll(U)],
    a = o(".panel"),
    l = o(".loc-card"),
    c = (U) => s.querySelector(`[data-f="${U}"]`),
    u = o("#s-sens"),
    h = o("#s-vol"),
    f = o("#s-fov"),
    p = "none",
    d = null;
  function v(U) {
    if (
      ((!U || U === "sens") && (context.input.sensitivity = n.sens),
      (!U || U === "invertY") && (context.input.invertY = n.invertY),
      !U || U === "volume")
    )
      try {
        context.audio &&
          context.audio.setVolume &&
          context.audio.setVolume(n.volume);
      } catch (T) {
        console.error(T);
      }
    if (
      ((!U || U === "fov") &&
        context.player &&
        context.player.setFov &&
        context.player.setFov(n.fov),
      U === "quality" ||
        (!U &&
          n.quality !== "auto" &&
          !context.params.shot &&
          !context.params.q &&
          n.quality !== (context.quality && context.quality.name)))
    ) {
      let T = QUALITY_PRESETS[n.quality];
      if (T)
        try {
          context.render && context.render.setQuality
            ? context.render.setQuality({
                ...T,
              })
            : (context.quality = {
                ...T,
              });
        } catch (D) {
          console.error("[game] setQuality failed", D);
        }
    }
  }
  function g() {
    let U =
      n.quality === "auto"
        ? context.quality && context.quality.name
        : n.quality;
    for (let D of r(".seg button"))
      D.setAttribute("aria-pressed", String(D.dataset.q === U));
    ((u.value = n.sens),
      (h.value = Math.round(n.volume * 100)),
      (f.value = n.fov),
      (o('[data-o="sens"]').textContent = n.sens.toFixed(2) + "\xD7"),
      (o('[data-o="vol"]').textContent = Math.round(n.volume * 100) + "%"),
      (o('[data-o="fov"]').textContent = Math.round(n.fov) + "\xB0"));
    let T = o('[data-act="invert"]');
    (T.setAttribute("aria-pressed", String(n.invertY)),
      (T.querySelector("span").textContent = n.invertY ? "On" : "Off"),
      (c("qnote").textContent =
        n.quality === "auto"
          ? `Quality was picked for this device (${U || "default"}). Lower it if the frame rate struggles.`
          : "Quality changes apply at once; shadows and reflections may take a moment to rebuild."));
  }
  (listen(context, u, "input", () => {
    ((n.sens = +u.value), v("sens"), g(), saveSettings(n));
  }),
    listen(context, h, "input", () => {
      ((n.volume = +h.value / 100), v("volume"), g(), saveSettings(n));
    }),
    listen(context, f, "input", () => {
      ((n.fov = +f.value), v("fov"), g(), saveSettings(n));
    }));
  let x = o('[data-row="fs"]'),
    y = o("#fs-t"),
    b = () =>
      document.fullscreenElement || document.webkitFullscreenElement || null,
    m = document.getElementById("app") || document.documentElement;
  (m &&
    (m.requestFullscreen || m.webkitRequestFullscreen) &&
    document.fullscreenEnabled !== !1 &&
    document.webkitFullscreenEnabled !== !1) ||
    (x.hidden = !0);
  function _() {
    y.textContent = "Fullscreen is not available here";
  }
  function M() {
    try {
      if (b()) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(
          document,
        );
        return;
      }
      let U = (m.requestFullscreen || m.webkitRequestFullscreen).call(m);
      U && U.catch && U.catch(_);
    } catch {
      _();
    }
  }
  let E = () => {
    y.textContent = b() ? "Exit fullscreen" : "Enter fullscreen";
  };
  (listen(context, document, "fullscreenchange", E, void 0, !1),
    listen(context, document, "webkitfullscreenchange", E, void 0, !1));
  function w(U) {
    ((d = document.activeElement),
      (a.hidden = !1),
      s.classList.add("panel-open"),
      z(U || "settings"));
    try {
      a.focus({
        preventScroll: !0,
      });
    } catch {}
  }
  function S() {
    return a.hidden
      ? !1
      : ((a.hidden = !0),
        s.classList.remove("panel-open"),
        d && d.focus && s.contains(d) ? d.focus() : H(),
        !0);
  }
  function z(U) {
    for (let T of r(".tab"))
      T.setAttribute("aria-selected", String(T.dataset.tab === U));
    for (let T of r(".panel-b")) T.hidden = T.dataset.pane !== U;
  }
  function H() {
    let U = s.querySelector(`.m-screen[data-s="${p}"] .btn.primary`);
    if (U)
      try {
        U.focus({
          preventScroll: !0,
        });
      } catch {}
  }
  (listen(context, s, "click", (U) => {
    let T = U.target.closest("button");
    if (!T || !s.contains(T)) return;
    if ((context.events.emit("ui:click", {}), T.dataset.q)) {
      ((n.quality = T.dataset.q), v("quality"), g(), saveSettings(n));
      return;
    }
    if (T.dataset.tab) {
      z(T.dataset.tab);
      return;
    }
    let D = T.dataset.act;
    D === "more"
      ? (() => {
          let box = s.querySelector(".m-more");
          box.hidden = !box.hidden;
          T.setAttribute("aria-expanded", String(!box.hidden));
        })()
      : D === "settings"
      ? w("settings")
      : D === "controls"
        ? w("controls")
        : D === "close-panel"
          ? S()
          : D === "invert"
            ? ((n.invertY = !n.invertY), v("invertY"), g(), saveSettings(n))
            : D === "fullscreen"
              ? M()
              : D && e[D]
                ? e[D](U)
                : D === "ch-done" || D === "vs-back" || D === "br-back"
                  ? (context.events.emit("menu:action", { act: D, el: T }), q.show("title"))
                  : D && context.events.emit("menu:action", { act: D, el: T });
  }),
    // Escape on a main-menu sub screen goes back to the title
    listen(context, window, "keydown", (U) => {
      U.code !== "Escape" ||
        !a.hidden ||
        (p !== "character" && p !== "versus" && p !== "brawl") ||
        (U.preventDefault(),
        context.events.emit("menu:action", {
          act: p === "character" ? "ch-done" : p === "brawl" ? "br-back" : "vs-back",
          el: null,
        }),
        q.show("title"));
    }),
    listen(context, s, "mouseover", (U) => {
      let T = U.target.closest("button");
      T &&
        U.relatedTarget &&
        !T.contains(U.relatedTarget) &&
        context.events.emit("ui:hover", {});
    }),
    listen(context, s, "keydown", (U) => {
      if (
        (U.code === "Escape" &&
          !a.hidden &&
          (S(), U.stopPropagation(), U.preventDefault()),
        U.code === "Tab" && !a.hidden)
      ) {
        let T = [...a.querySelectorAll("button, input")].filter(
          (G) => G.offsetParent !== null,
        );
        if (!T.length) return;
        let D = T[0],
          C = T[T.length - 1];
        U.shiftKey && document.activeElement === D
          ? (C.focus(), U.preventDefault())
          : !U.shiftKey &&
            document.activeElement === C &&
            (D.focus(), U.preventDefault());
      }
    }));
  let O = (U) => (
      (U = Math.max(0, Math.floor(U))),
      String(Math.floor(U / 60)).padStart(2, "0") +
        ":" +
        String(U % 60).padStart(2, "0")
    ),
    q = {
      root: s,
      settings: n,
      fmtTime: O,
      get screen() {
        return p;
      },
      get panelOpen() {
        return !a.hidden;
      },
      closePanel: S,
      field: c,
      show(U) {
        let prev = p;
        s.dataset.mode = (context.game && context.game.mode) || "mission";
        U !== p &&
          ((p = U),
          (s.dataset.screen = U),
          S(),
          s.classList.toggle("open", U !== "none"),
          U !== "none"
            ? (g(), setTimeout(H, 30))
            : document.activeElement &&
              s.contains(document.activeElement) &&
              document.activeElement.blur(),
          context.events.emit("menu:screen", { screen: U, prev }));
      },
      locationCard(U) {
        l.classList.toggle("on", !!U);
      },
      setLookMode(U) {
        c("lookmode").textContent = U || "";
      },
      setDead({ time: U, relays: T, total: D }) {
        ((c("dead-time").textContent = O(U)),
          (c("dead-relays").textContent = `${T}/${D}`));
      },
      setDebrief({ time: U, accuracy: T, kills: D, retries: C, rating: G }) {
        ((c("time").textContent = O(U)),
          (c("acc").textContent =
            T == null ? "\u2014" : Math.round(T * 100) + "%"),
          (c("kills").textContent = String(D)),
          (c("retries").textContent = String(C)),
          (c("rating").textContent = G));
      },
      applySettings: v,
    };
  return (g(), q);
}

export {
  createMenus,
  loadSettings,
  saveSettings,
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  QUALITY_NAMES,
  KEYBOARD_CONTROLS_HTML,
  TOUCH_CONTROLS_HTML,
};
