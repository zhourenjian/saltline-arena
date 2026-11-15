// 1v1 HUD layer: scoreboard, centre banner (countdown / respawn) and the opponent's nametag.
// Mounted inside the existing HUD root so it shows and hides with it. The nametag only shows
// when the opponent is actually in sight (src/versus/nametag.js), never through walls.
import { createNameTag } from "./nametag.js";

function el(tag, cls, text) {
  let e = document.createElement(tag);
  return (cls && (e.className = cls), text != null && (e.textContent = text), e);
}

function createVersusHud(context) {
  let hud = context.hud,
    host = (hud && hud.root) || document.getElementById("ui"),
    root = el("div", "vs-hud"),
    score = el("div", "vs-score"),
    me = el("span", "me"),
    meName = el("span", "vs-name", "You"),
    meScore = el("b", "", "0"),
    to = el("span", "to", "First to 5"),
    them = el("span", "them"),
    themName = el("span", "vs-name", "Opponent"),
    themScore = el("b", "", "0"),
    center = el("div", "vs-center"),
    big = el("b"),
    small = el("span"),
    tag = el("div", "vs-tag"),
    timer = null; // { until, label, big? } counts down on its own
  let nameTag = createNameTag(context, host, tag);
  (me.append(meName, meScore),
    them.append(themScore, themName),
    score.append(me, to, them),
    center.append(big, small),
    root.append(score, center, tag),
    host && host.appendChild(root));

  function banner(b, s) {
    ((big.textContent = b || ""), (small.textContent = s || ""), (center.hidden = !b && !s));
  }
  banner();

  function frame(dt) {
    if (!root.classList.contains("on")) return;
    if (timer) {
      timer.left -= dt;
      let n = Math.max(0, Math.ceil(timer.left));
      if (timer.left <= 0)
        timer.done ? (banner(timer.done, ""), (timer = { kind: "flash", left: 0.8 })) : ((timer = null), banner());
      else if (timer.kind === "count") banner(String(n), timer.label);
      else if (timer.kind === "respawn") banner("", `${timer.label} ${n}`);
    }
    let opp = context.versus && context.versus.opponent;
    nameTag.update(opp && opp.headPosition, !!opp && opp.visible && opp.alive);
  }
  context.frameHooks.push(frame);

  return {
    root,
    show(on) {
      (root.classList.toggle("on", !!on), hud && hud.root && hud.root.classList.toggle("versus", !!on));
      on || (nameTag.hide(), (timer = null), banner());
    },
    setNames(mine, theirs) {
      ((meName.textContent = mine || "You"), (themName.textContent = theirs || "Opponent"), (tag.textContent = theirs || "Opponent"));
    },
    setScore(mine, theirs, killsToWin) {
      ((meScore.textContent = String(mine | 0)), (themScore.textContent = String(theirs | 0)));
      killsToWin && (to.textContent = `First to ${killsToWin}`);
    },
    countdown(seconds, label = "Get ready", done = "Fight") {
      timer = { kind: "count", left: seconds, label, done };
      banner(String(Math.ceil(seconds)), label);
    },
    respawnIn(seconds, label = "Respawning in") {
      timer = { kind: "respawn", left: seconds, label, done: "" };
      banner("", `${label} ${Math.ceil(seconds)}`);
    },
    banner(b, s, seconds) {
      ((timer = seconds ? { kind: "flash", left: seconds } : null), banner(b, s));
    },
    clear() {
      ((timer = null), banner());
    },
    get text() {
      return `${big.textContent} ${small.textContent}`.trim();
    },
    dispose() {
      let i = context.frameHooks.indexOf(frame);
      (i >= 0 && context.frameHooks.splice(i, 1), root.remove());
      hud && hud.root && hud.root.classList.remove("versus");
    },
  };
}

export { createVersusHud };
