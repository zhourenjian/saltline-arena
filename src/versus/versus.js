// 1v1 duel mode: lobby UI ⇄ duel server ⇄ game flow.
//
// The server (server/hub.mjs) owns the match: rooms, countdown, health, damage, kills, score,
// respawn timing and spawn choice. This client sends its own pose at 20 Hz, its shots (for the
// peer's tracers) and hit claims ("I hit you in the head"), and applies whatever the server
// decides. It is a friendly relay, not an anti-cheat: a modified client can still lie about
// what it hit (the server only rate-limits and range-checks hits).
import { Vector3 } from "../vendor/three-r180.js";
import { DUEL_RULES, DUEL_SPAWNS, normalizeRoomCode, packLoco, sanitizeName, nameProblem } from "./rules.js";
import { connectDuel, defaultServerUrl, normalizeServerUrl, loadVersusPrefs, saveVersusPrefs } from "./net.js";
import { createOpponent } from "./opponent.js";
import { createVersusHud } from "./versus-hud.js";

var SPAWN_CENTER = DUEL_SPAWNS.reduce((c, s) => [c[0] + s[0] / DUEL_SPAWNS.length, c[1] + s[1] / DUEL_SPAWNS.length], [0, 0]);

var ERRORS = {
  ROOM_NOT_FOUND: "No room with that code.",
  ROOM_FULL: "That room already has two players.",
  PROTOCOL_MISMATCH: "The server runs a different version of the duel. Update the game or the server.",
};

function createVersus(context, avatars, options = {}) {
  let game = context.game,
    menus = game && game.menus,
    f = (n) => menus && menus.field(n),
    ui = {
      server: f("vs-server"),
      name: f("vs-name"),
      code: f("vs-code"),
      lobby: f("vs-lobby"),
      room: f("vs-room"),
      roomCode: f("vs-room-code"),
      players: f("vs-players"),
      status: f("vs-status"),
      rTitle: f("vsr-title"),
      rKicker: f("vsr-kicker"),
      rYou: f("vsr-you"),
      rScore: f("vsr-score"),
      rThem: f("vsr-them"),
      rStatus: f("vsr-status"),
    },
    resultCard = menus && menus.root.querySelector('[data-s="vs-result"]'),
    prefs = loadVersusPrefs(),
    client = null,
    connecting = null,
    room = null, // last "room" view from the server
    match = null, // { scores, killsToWin, live }
    peer = null, // { id, name, avatar }
    applying = !1,
    sendClock = 0,
    lastHit = null, // { frame, point } from this frame's onHit
    leavingQuietly = !1,
    note = "", // e.g. "Bravo left." — kept in front of the room status until the room changes
    disposed = !1,
    offs = [],
    tmpA = new Vector3(),
    tmpB = new Vector3(),
    tmpD = new Vector3(),
    tmpMuzzle = new Vector3(),
    tmpBarrel = new Vector3();

  let hud = createVersusHud(context),
    opponent = createOpponent(context, avatars, {
      onHit(hit) {
        if (!client || !peer || !match || !match.live) return;
        ((lastHit = { frame: context.time.frame, point: hit.point.clone() }),
          client.send("hit", { target: peer.id, part: hit.part === "head" ? "head" : "body" }));
      },
    });

  // ---- small helpers
  let me = () => (client ? client.id : null),
    myName = () => sanitizeName((ui.name && ui.name.value) || prefs.name),
    myAvatar = () => {
      let a = avatars.getAvatar();
      return a ? a.id : null;
    },
    inMatch = () => !!match && game.mode === "versus" && game.state !== "title";

  function status(text, err) {
    ui.status && ((ui.status.textContent = text || ""), ui.status.classList.toggle("err", !!err));
  }

  function serverUrl() {
    let typed = ui.server && ui.server.value.trim();
    return normalizeServerUrl(typed || context.params.server || prefs.server || defaultServerUrl());
  }

  function savePrefs() {
    ((prefs.server = (ui.server && ui.server.value.trim()) || ""), (prefs.name = myName()), saveVersusPrefs(prefs));
  }

  function setBusy(b) {
    menus &&
      menus.root
        .querySelectorAll('[data-act="vs-create"],[data-act="vs-join"]')
        .forEach((x) => (x.disabled = !!b));
  }

  function poseFor(index) {
    let s = DUEL_SPAWNS[index] || DUEL_SPAWNS[0],
      x = s[0],
      z = s[1],
      y = 0;
    try {
      y = context.physics.groundHeight(x, z, 3);
    } catch {}
    // face the middle of the harbor
    let dx = SPAWN_CENTER[0] - x,
      dz = SPAWN_CENTER[1] - z;
    return { pos: new Vector3(x, y, z), yaw: Math.atan2(-dx, -dz) };
  }

  // ---- connection
  async function ensureClient() {
    if (client && client.open) return client;
    if (connecting) return connecting;
    let url = serverUrl();
    if (!url) throw new Error("Enter the duel server address, e.g. ws://192.168.1.20:8787");
    let bad = nameProblem(ui.name && ui.name.value);
    if (bad) throw new Error(bad);
    savePrefs();
    status(`Connecting to ${url}…`);
    setBusy(!0);
    connecting = connectDuel(url, { name: myName(), avatar: myAvatar() })
      .then((c) => {
        if (disposed) throw (c.close(), new Error("closed"));
        client = c;
        wire(c);
        status(`Connected to ${url}.`);
        return c;
      })
      .finally(() => ((connecting = null), setBusy(!1)));
    return connecting;
  }

  function disconnect() {
    let c = client;
    note = "";
    ((client = null), (room = null), (peer = null), (match = null));
    c && (c.send("leave"), c.close(1000, "left"));
    renderRoom();
  }

  function wire(c) {
    let on = (t, fn) => c.on(t, (m) => client === c && fn(m));
    on("room", (m) => {
      room = m;
      let other = m && m.players.find((p) => p.id !== me());
      if (other) {
        let changed = !peer || peer.id !== other.id || peer.avatar !== other.avatar;
        peer = { id: other.id, name: other.name, avatar: other.avatar };
        changed && opponent.setAvatar(other.avatar);
        hud.setNames(myName(), other.name);
      } else peer = null;
      renderRoom();
    });
    on("start", (m) => {
      let mine = m.spawns && m.spawns[me()];
      ((match = { scores: {}, killsToWin: m.killsToWin || DUEL_RULES.killsToWin, live: !1 }),
        m.room && (room = m.room));
      let other = room && room.players.find((p) => p.id !== me());
      other && (peer = { id: other.id, name: other.name, avatar: other.avatar });
      peer && opponent.setAvatar(peer.avatar);
      opponent.reset();
      resultCard && resultCard.classList.remove("lost");
      ((context.player.damageFilter = damageFilter), (sendClock = 0));
      game.startVersus(poseFor(mine));
      context.player.enabled = !1;
      hud.show(!0);
      hud.setNames(myName(), peer ? peer.name : "Opponent");
      hud.setScore(0, 0, match.killsToWin);
      hud.countdown(m.countdown || DUEL_RULES.countdownSeconds, peer ? `vs ${peer.name}` : "Get ready");
      context.events.emit("versus:start", { room: room && room.code, peer: peer && peer.id });
    });
    on("live", () => {
      if (!match) return;
      match.live = !0;
      game.state === "playing" && (context.player.enabled = !0);
      context.events.emit("versus:live", {});
    });
    on("state", (m) => peer && m.id === peer.id && opponent.push(m));
    on("shot", (m) => peer && m.id === peer.id && remoteShot(m));
    on("damage", (m) => {
      if (m.target !== me()) return;
      let p = context.player,
        from = opponent.present ? opponent.pos.clone().setY(opponent.pos.y + 1.4) : null;
      if (!p.alive) return;
      applying = !0;
      try {
        ((p.health = Math.min(p.maxHealth, m.hp + m.amount)), p.damage(m.amount, from));
      } finally {
        applying = !1;
      }
      p.alive && (p.health = m.hp);
    });
    on("kill", (m) => {
      if (!match) return;
      match.scores = m.scores || {};
      let mine = match.scores[me()] || 0,
        theirs = peer ? match.scores[peer.id] || 0 : 0;
      hud.setScore(mine, theirs, match.killsToWin);
      if (m.victim === me()) {
        let p = context.player;
        if (p.alive) {
          applying = !0;
          try {
            p.damage(p.health + 1, null);
          } finally {
            applying = !1;
          }
        }
        let by = m.killer ? (peer ? peer.name : "Opponent") : null;
        m.respawnIn != null && hud.respawnIn(m.respawnIn, by ? `Killed by ${by} · respawning in` : "Respawning in");
        context.hud.feed && context.hud.feed(by ? `${by} got you` : "You went down");
      } else {
        opponent.kill();
        m.killer === me() && context.hud.feed && context.hud.feed(`Eliminated ${peer ? peer.name : "opponent"}`);
        m.respawnIn != null && hud.banner("", `${mine} – ${theirs}`, 1.6);
      }
      context.events.emit("versus:kill", { ...m, me: me() });
    });
    on("spawn", (m) => {
      if (m.id === me()) {
        (game.respawn(poseFor(m.spawn)), hud.clear(), (sendClock = 0));
        context.player.enabled = game.state === "playing";
      } else opponent.spawn(m.shield || 0);
    });
    on("end", (m) => {
      if (!match) return;
      ((match.live = !1), (match.scores = m.scores || match.scores));
      let mine = match.scores[me()] || 0,
        theirs = peer ? match.scores[peer.id] || 0 : 0,
        won = m.winner === me();
      hud.setScore(mine, theirs, match.killsToWin);
      ui.rKicker && (ui.rKicker.textContent = `Duel over · first to ${match.killsToWin}`);
      ui.rTitle && (ui.rTitle.textContent = won ? "Victory" : "Defeat");
      ui.rYou && (ui.rYou.textContent = myName());
      ui.rThem && (ui.rThem.textContent = peer ? peer.name : "Opponent");
      ui.rScore && (ui.rScore.textContent = `${mine} : ${theirs}`);
      let st = m.stats && m.stats[me()];
      ui.rStatus && (ui.rStatus.textContent = st ? `${st.kills} kills · ${st.deaths} deaths` : "");
      resultCard && resultCard.classList.toggle("lost", !won);
      (hud.show(!1), game.endVersus());
      context.events.emit("versus:end", { ...m, me: me(), won });
    });
    on("rematch", (m) => {
      let ids = m.ids || [];
      ui.rStatus &&
        (ui.rStatus.textContent = ids.includes(me())
          ? `Waiting for ${peer ? peer.name : "your opponent"}…`
          : peer && ids.includes(peer.id)
            ? `${peer.name} wants a rematch.`
            : "");
    });
    on("peer:left", (m) => {
      let name = peer ? peer.name : "Your opponent";
      peer = null;
      note = `${name} ${m.reason === "disconnected" ? "disconnected" : "left"}.`;
      (match || game.mode === "versus") && (endLocalMatch(), menus.show("versus"));
      status(`${note} Waiting for a new opponent…`);
    });
    on("error", (m) => status(ERRORS[m.code] || m.message || m.code, !0));
    on("close", (m) => {
      client = null;
      let wasMatch = !!match || game.mode === "versus";
      ((room = null), (peer = null), (match = null));
      if (m.local) return;
      wasMatch && (endLocalMatch(), menus.show("versus"));
      (renderRoom(), status(m.code === 4000 ? ERRORS.PROTOCOL_MISMATCH : "Connection to the duel server was lost.", !0));
    });
  }

  // back to the menus without telling the server (it already knows)
  function endLocalMatch() {
    match = null;
    context.player.damageFilter = null;
    (hud.show(!1), opponent.reset());
    if (game.mode === "versus" || game.state === "over") ((leavingQuietly = !0), game.toTitle(), (leavingQuietly = !1));
  }

  // ---- lobby rendering
  function renderRoom() {
    let inRoom = !!room;
    (ui.lobby && (ui.lobby.hidden = inRoom), ui.room && (ui.room.hidden = !inRoom));
    if (!inRoom || !ui.players) return;
    ui.roomCode && (ui.roomCode.textContent = room.code);
    let items = room.players.map((p) => {
      let li = document.createElement("li");
      return ((li.textContent = p.id === me() ? `${p.name} (you)` : p.name), li);
    });
    if (room.players.length < 2) {
      let li = document.createElement("li");
      ((li.className = "waiting"), (li.textContent = "Waiting for an opponent…"), items.push(li));
      status(`${note ? note + " " : ""}Share the room code ${room.code} with your opponent.`);
    }
    else note = "";
    ui.players.replaceChildren(...items);
  }

  function openLobby() {
    (ui.server && !ui.server.value && (ui.server.value = context.params.server || prefs.server || defaultServerUrl()),
      ui.name && !ui.name.value && (ui.name.value = prefs.name || ""),
      renderRoom(),
      client || status(""));
    menus.show("versus");
  }

  // ---- in-match traffic
  function damageFilter(amount) {
    if (applying) return !0;
    // world damage (falls) goes to the server, which owns health in a duel
    return (client && inMatch() && client.send("hurt", { amount: Math.min(500, amount) }), !1);
  }

  let r3 = (v) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];

  function sendState(dt) {
    if (!client || !match || game.mode !== "versus") return;
    // pausing and resuming during the countdown must not release the player early
    !match.live && game.state === "playing" && (context.player.enabled = !1);
    if (game.state !== "playing" && game.state !== "paused") return;
    sendClock -= dt;
    if (sendClock > 0) return;
    sendClock = 1 / DUEL_RULES.stateHz;
    let p = context.player;
    if (!p.alive) return;
    let l = avatars.locomotion;
    client.send("state", {
      p: r3(p.pos),
      v: r3(p.vel),
      yaw: +p.yaw.toFixed(4),
      pitch: +p.pitch.toFixed(4),
      crouch: !!p.crouching,
      loco: packLoco(l, context.weapon && context.weapon.heldAction ? context.weapon.heldAction() : null),
    });
  }

  function localShot(e) {
    if (!client || !match || game.mode !== "versus" || !e || !e.origin) return;
    let hit = lastHit && lastHit.frame === context.time.frame,
      end;
    if (hit) end = lastHit.point;
    else {
      let r = null;
      try {
        r = context.physics.raycast(e.origin, e.dir, DUEL_RULES.maxHitDistance);
      } catch {}
      end = r && r.point ? r.point : tmpA.copy(e.origin).addScaledVector(e.dir, DUEL_RULES.maxHitDistance);
    }
    lastHit = null;
    client.send("shot", { o: r3(e.muzzle || e.origin), e: r3(end), hit: !!hit });
  }

  function remoteShot(m) {
    if (!Array.isArray(m.o) || !Array.isArray(m.e)) return;
    let o = tmpA.set(m.o[0], m.o[1], m.o[2]),
      e = tmpB.set(m.e[0], m.e[1], m.e[2]),
      d = tmpD.subVectors(e, o),
      len = d.length();
    if (!(len > 0.01)) return;
    d.multiplyScalar(1 / len);
    // flash and tracer start at the opponent's rifle as we see it (its muzzle anchor), not at the
    // muzzle of their first-person view, which is somewhere else on screen
    let barrel = opponent.muzzle(tmpMuzzle, tmpBarrel),
      fo = barrel ? tmpMuzzle : o,
      fd = barrel ? tmpBarrel : d;
    barrel && opponent.fire();
    let fx = context.fx;
    try {
      (fx && fx.tracer && fx.tracer(fo.clone(), e.clone()),
        fx && fx.muzzleFlash && fx.muzzleFlash(fo.clone(), fd.clone(), { scale: 0.8 }),
        context.render && context.render.lightPool && context.render.lightPool.flash(fo.clone(), 16756832, 45, 9, 0.05));
    } catch {}
    context.events.emit("versus:fire", { pos: fo.clone() });
    if (!m.hit) {
      let r = null;
      try {
        r = context.physics.raycast(o, d, len + 0.5);
      } catch {}
      r &&
        r.point &&
        context.events.emit("impact", {
          point: r.point.clone ? r.point.clone() : r.point,
          normal: r.normal,
          surface: r.surface,
          dir: d.clone(),
          from: "versus",
        });
    }
  }

  // ---- menu wiring
  offs.push(
    context.events.on("menu:action", ({ act }) => {
      if (act === "versus") return openLobby();
      if (act === "vs-create")
        return void ensureClient()
          .then((c) => c.send("create"))
          .catch((e) => status(e.message, !0));
      if (act === "vs-join") {
        let code = normalizeRoomCode(ui.code && ui.code.value);
        if (code.length !== DUEL_RULES.roomCodeLength) return status("Enter the 4-letter room code.", !0);
        return void ensureClient()
          .then((c) => c.send("join", { code }))
          .catch((e) => status(e.message, !0));
      }
      if (act === "vs-back") return (savePrefs(), disconnect(), status(""));
      if (act === "vs-rematch") {
        if (!client || !peer) {
          ui.rStatus && (ui.rStatus.textContent = "Your opponent is gone.");
          return;
        }
        client.send("rematch");
      }
    }),
    context.events.on("game:quit", ({ mode }) => {
      if (leavingQuietly) return;
      mode === "versus" && ((match = null), (context.player.damageFilter = null), hud.show(!1), opponent.reset(), disconnect());
    }),
    context.events.on("character:change", ({ id }) => {
      client && client.send("profile", { avatar: id ?? null, name: myName() });
    }),
    context.events.on("weapon:fire", localShot),
  );
  if (ui.code) {
    let h = (e) => {
      e.code === "Enter" &&
        (e.preventDefault(), e.stopPropagation(), context.events.emit("menu:action", { act: "vs-join", el: ui.code }));
    };
    ui.code.addEventListener("keydown", h);
    offs.push(() => ui.code.removeEventListener("keydown", h));
  }
  if (ui.name) {
    let h = () => {
      let bad = nameProblem(ui.name.value);
      if (bad) return status(bad, !0);
      savePrefs();
      client && client.send("profile", { name: myName() });
    };
    ui.name.addEventListener("change", h);
    offs.push(() => ui.name.removeEventListener("change", h));
  }
  context.frameHooks.push(sendState);

  let api = {
    opponent,
    hud,
    get client() {
      return client;
    },
    get id() {
      return me();
    },
    get room() {
      return room;
    },
    get peer() {
      return peer;
    },
    get match() {
      return match ? { ...match, scores: { ...match.scores } } : null;
    },
    get serverUrl() {
      return serverUrl();
    },
    open: openLobby,
    connect: ensureClient,
    leave: disconnect,
    dispose() {
      if (disposed) return;
      disposed = !0;
      (client && client.close(1000, "world disposed"), (client = null));
      context.player && context.player.damageFilter === damageFilter && (context.player.damageFilter = null);
      let i = context.frameHooks.indexOf(sendState);
      (i >= 0 && context.frameHooks.splice(i, 1), offs.forEach((f) => f()), opponent.dispose(), hud.dispose());
      context.versus === api && (context.versus = null);
    },
  };
  return (context.versus = api);
}

export { createVersus, SPAWN_CENTER };
