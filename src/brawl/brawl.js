// Brawl: a queued free-for-all of up to BRAWL_RULES.maxPlayers on the duel server.
//
// The server (server/brawl.mjs) owns seats, the queue, seat offers, health, kills, the periodic
// cut of the last-placed players and the chat/mic limits. This client:
//   - plays: sends its pose at 20 Hz, its shots and hit claims, applies server damage/kills;
//   - watches: a local spectator camera (follow a player or fly freely) fed by 10 Hz snapshots;
//   - chats while watching: text, 👎 votes and push-to-talk voice (src/brawl/voice.js).
// Like the duel it is a friendly relay, not an anti-cheat.
import { Vector3 } from "../vendor/three-r180.js";
import { DUEL_RULES, DUEL_SPAWNS, packLoco, sanitizeName, nameProblem } from "../versus/rules.js";
import { connectDuel, defaultServerUrl, normalizeServerUrl, loadVersusPrefs, saveVersusPrefs } from "../versus/net.js";
import { createOpponent } from "../versus/opponent.js";
import { createNameTag } from "../versus/nametag.js";
import { SPAWN_CENTER } from "../versus/versus.js";
import { BRAWL_RULES, sanitizeChat } from "./rules.js";
import { createBrawlHud } from "./brawl-hud.js";
import { createSpectatorCamera } from "./spectator.js";
import { createVoice, canRecord, recordProblem } from "./voice.js";

var ERRORS = {
  BRAWL_FULL: "The brawl lobby is full right now. Try again in a minute.",
  QUEUE_FULL: "The queue is full right now. Keep watching and try again shortly.",
  PROTOCOL_MISMATCH: "The server runs a different version. Update the game or the server.",
  NO_BRAWL: "This server is older and has no brawl mode (only 1v1).",
};

var OUT_TEXT = {
  culled: (r) => `Cut — you were last (#${r}) this round.`,
  deaths: () => `Death limit reached (${BRAWL_RULES.deathLimit}) — your seat went to the queue.`,
  afk: () => "Removed for standing still while others were waiting.",
  left: () => "You left the arena. Watching now.",
};

var NOTICE_TEXT = {
  join: (n) => `${n} joined the brawl`,
  left: (n) => `${n} left the brawl`,
  culled: (n, r) => `${n} was cut (last place, #${r})`,
  deaths: (n) => `${n} hit the death limit`,
  afk: (n) => `${n} was idle and removed`,
  disconnected: (n) => `${n} disconnected`,
};

var esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function createBrawl(context, avatars) {
  let game = context.game,
    menus = game && game.menus,
    f = (n) => menus && menus.field(n),
    ui = { server: f("br-server"), name: f("br-name"), status: f("br-status") },
    prefs = loadVersusPrefs(),
    client = null,
    connecting = null,
    entered = !1, // inside the brawl world (watching or playing)
    role = "lobby", // lobby | queued | offered | playing
    lobby = null, // last br.lobby view
    arena = null, // last br.arena view for the arena we play in or watch
    watchId = 1,
    rules = { ...BRAWL_RULES },
    remotes = new Map(), // id → { opp, tag, tagEl, name, avatar }
    applying = !1,
    sendClock = 0,
    lastHit = null,
    leavingQuietly = !1,
    chatOpen = !1,
    cursorFree = !1, // spectator released the mouse (Tab) to use the chat and the buttons
    watchOnly = !1, // entered with "Watch only": do not take a seat or a queue place
    autoJoin = !1, // waiting for the outcome of the automatic br.play after entering
    mic = null, // { want, ok, msg, left, warn, pending: [] }
    micSeq = 0,
    talking = new Map(), // id → { id, name, msg }
    silenced = new Set(), // voice msg ids I thumbed down
    savedCamera = null,
    disposed = !1,
    offs = [],
    tmpA = new Vector3(),
    tmpB = new Vector3(),
    tmpD = new Vector3(),
    tmpMuzzle = new Vector3(),
    tmpBarrel = new Vector3();

  let me = () => (client ? client.id : null),
    myName = () => sanitizeName((ui.name && ui.name.value) || prefs.name),
    myAvatar = () => {
      let a = avatars.getAvatar();
      return a ? a.id : null;
    },
    inBrawl = () => entered && game.mode === "brawl" && game.state !== "title",
    playing = () => inBrawl() && role === "playing",
    nameOf = (id) => {
      if (id === me()) return myName();
      let r = remotes.get(id);
      if (r) return r.name;
      let p = arena && arena.players.find((x) => x.id === id);
      return p ? p.name : "Someone";
    };

  let hud = createBrawlHud(context, { onAction: action }),
    voice = createVoice({ rate: BRAWL_RULES.voiceRate }),
    spectator = createSpectatorCamera(context, () =>
      [...remotes.entries()].map(([id, r]) => ({
        id,
        name: r.name,
        pos: r.opp.pos,
        yaw: r.opp.root.rotation.y,
        alive: r.opp.alive,
        visible: r.opp.visible,
      })),
    );

  function status(text, err) {
    ui.status && ((ui.status.textContent = text || ""), ui.status.classList.toggle("err", !!err));
  }

  function serverUrl() {
    let typed = ui.server && ui.server.value.trim();
    return normalizeServerUrl(typed || context.params.server || prefs.server || defaultServerUrl());
  }

  function savePrefs() {
    ((prefs.server = (ui.server && ui.server.value.trim()) || prefs.server || ""), (prefs.name = myName()), saveVersusPrefs(prefs));
  }

  function poseFor(index) {
    let s = DUEL_SPAWNS[index] || DUEL_SPAWNS[0],
      x = s[0],
      z = s[1],
      y = 0;
    try {
      y = context.physics.groundHeight(x, z, 3);
    } catch {}
    let dx = SPAWN_CENTER[0] - x,
      dz = SPAWN_CENTER[1] - z;
    return { pos: new Vector3(x, y, z), yaw: Math.atan2(-dx, -dz) };
  }

  // ---- connection
  async function ensureClient() {
    if (client && client.open) return client;
    if (connecting) return connecting;
    let url = serverUrl();
    if (!url) throw new Error("Enter the server address, e.g. ws://192.168.1.20:8787");
    let bad = nameProblem(ui.name && ui.name.value);
    if (bad) throw new Error(bad);
    savePrefs();
    status(`Connecting to ${url}…`);
    setBusy(!0);
    connecting = connectDuel(url, { name: myName(), avatar: myAvatar() })
      .then((c) => {
        if (disposed) throw (c.close(), new Error("closed"));
        if (!(c.features || []).includes("brawl")) throw (c.close(1000, "no brawl"), new Error(ERRORS.NO_BRAWL));
        client = c;
        wire(c);
        return c;
      })
      .finally(() => ((connecting = null), setBusy(!1)));
    return connecting;
  }

  function setBusy(b) {
    menus && menus.root.querySelectorAll('[data-act="br-enter"]').forEach((x) => (x.disabled = !!b));
  }

  function disconnect() {
    let c = client;
    client = null;
    c && (c.send("br.exit"), c.close(1000, "left"));
  }

  // ---- remote players
  function syncRemotes(view) {
    let want = new Map();
    if (view) for (let p of view.players) p.id !== me() && want.set(p.id, p);
    for (let [id, r] of remotes) want.has(id) || (dropRemote(r), remotes.delete(id));
    for (let [id, p] of want) {
      let r = remotes.get(id);
      if (!r) {
        let tagEl = document.createElement("div");
        tagEl.className = "vs-tag br-tag";
        let host = (context.hud && context.hud.root) || document.getElementById("ui");
        host && host.appendChild(tagEl);
        let opp = createOpponent(context, avatars, {
          minDelay: 0.12,
          onHit(hit) {
            if (!client || !playing()) return;
            ((lastHit = { frame: context.time.frame, point: hit.point.clone() }),
              client.send("br.hit", { target: id, part: hit.part === "head" ? "head" : "body" }));
          },
        });
        r = { opp, tagEl, tag: createNameTag(context, host, tagEl), name: "", avatar: void 0 };
        remotes.set(id, r);
        p.alive || opp.kill();
      }
      p.name !== r.name && ((r.name = p.name), (r.tagEl.textContent = p.name));
      p.avatar !== r.avatar && ((r.avatar = p.avatar), r.opp.setAvatar(p.avatar));
      // a dead player in the view whose body still stands: they died before we saw it
      !p.alive && r.opp.alive && r.opp.present && r.opp.kill();
    }
  }

  function dropRemote(r) {
    (r.opp.dispose(), r.tag.hide(), r.tagEl.remove());
  }

  function clearRemotes() {
    for (let r of remotes.values()) dropRemote(r);
    remotes.clear();
  }

  // ---- modes
  function enterWorld() {
    entered = !0;
    role = "lobby";
    game.startVersus(poseFor(0), "brawl");
    hud.show(!0);
    hud.clearChat();
    becomeSpectator();
    context.events.emit("brawl:enter", {});
  }

  function becomeSpectator() {
    let p = context.player;
    ((p.enabled = !1), (p.invulnerable = !0), (p.damageFilter = null));
    try {
      context.weapon && context.weapon.setVisible(!1);
    } catch {}
    try {
      let m = avatars.getCameraMode && avatars.getCameraMode();
      m && m !== "first-person" && ((savedCamera = m), avatars.setCameraMode("first-person"));
    } catch {}
    // follow flies freely until there is someone to follow
    spectator.on || spectator.start("follow");
    hud.setRole(role === "playing" ? "lobby" : role);
    context.input && context.input.setGameplay && game.state === "playing" && context.input.setGameplay(!0);
    syncRemotes(arena);
    renderSpectator();
  }

  function becomePlayer(m) {
    autoJoin = !1;
    closeChat();
    lockCursor();
    endMic();
    spectator.stop();
    role = "playing";
    hud.closePrompt();
    hud.setRole("playing");
    arena = m.view || arena;
    watchId = m.arena;
    syncRemotes(arena);
    hud.setBoard(arena, me());
    let p = context.player;
    p.invulnerable = !1;
    p.damageFilter = damageFilter;
    try {
      savedCamera && (avatars.setCameraMode(savedCamera), (savedCamera = null));
    } catch {}
    game.respawn(poseFor(m.spawn));
    try {
      context.weapon && context.weapon.setVisible(!0);
    } catch {}
    p.enabled = game.state === "playing";
    sendClock = 0;
    hud.toast(`You're in — arena ${m.arena}. ${rules.maxPlayers} max · last place is cut while people wait.`, "good", 4.5);
    context.events.emit("brawl:joined", { arena: m.arena });
  }

  function leaveWorld(text, err) {
    let was = entered;
    lockCursor();
    entered = !1;
    role = "lobby";
    (endMic(), closeChat(), spectator.stop(), clearRemotes(), hud.show(!1), hud.setBoard(null));
    talking.clear();
    context.player && context.player.damageFilter === damageFilter && (context.player.damageFilter = null);
    context.player && (context.player.invulnerable = !1);
    if (was && (game.mode === "brawl" || game.state === "paused")) {
      leavingQuietly = !0;
      try {
        game.toTitle();
      } finally {
        leavingQuietly = !1;
      }
      menus.show("brawl");
    }
    text != null && status(text, err);
  }

  // ---- server messages
  function wire(c) {
    let on = (t, fn) => c.on(t, (m) => client === c && fn(m));
    on("br.welcome", (m) => {
      rules = { ...BRAWL_RULES, ...(m.rules || {}) };
      enterWorld();
      for (let h of m.history || []) hud.addMessage(h, me());
      for (let t of m.talking || []) talking.set(t.id, t);
      hud.setTalking([...talking.values()]);
      // no play-or-watch question: a free seat is taken at once, a full arena puts you in the queue
      watchOnly
        ? hud.toast(`Watching only — ${touchUi() ? "tap Play" : "press J"} to join the queue.`, "info", 5)
        : ((autoJoin = !0), c.send("br.play"));
    });
    on("br.lobby", (m) => {
      if (!m) return;
      lobby = m;
      role === "playing" || (role = m.role === "playing" ? role : m.role);
      m.muted > 0 && hud.setMuted(m.muted);
      role !== "playing" && hud.setRole(role);
      role !== "playing" && hud.setWaitList(m, me());
      autoJoin &&
        (m.role === "queued" || m.role === "offered") &&
        ((autoJoin = !1),
        m.role === "queued" &&
          hud.toast(`The arena is full — you're #${m.position} in the queue. Every ${Math.round(rules.cullSeconds / 60) || 1} min the last place is cut.`, "info", 6));
      renderSpectator();
    });
    on("br.arena", (m) => {
      if (!m) return;
      let mine = role === "playing" ? arena && arena.id === m.id : m.id === watchId;
      if (!mine && !(role !== "playing" && !arena)) return;
      ((arena = m), (watchId = m.id));
      hud.setBoard(m, me());
      syncRemotes(m);
      renderSpectator();
    });
    on("br.joined", (m) => becomePlayer(m));
    on("br.offer", (m) => {
      if (m.expired) {
        hud.closePrompt();
        hud.toast("You missed the seat offer — you're out of the queue.", "warn", 5);
        role = "lobby";
        return renderSpectator();
      }
      role = "offered";
      hud.prompt(
        `Seat open in arena ${m.arena}`,
        "Your turn! Take the seat within {s} s or it goes to the next in line.",
        [
          { label: "Take the seat (J)", act: "accept", primary: !0 },
          { label: "Pass", act: "decline" },
        ],
        m.seconds || rules.offerSeconds,
      );
      context.events.emit("brawl:offer", m);
    });
    on("br.out", (m) => {
      let t = (OUT_TEXT[m.reason] || OUT_TEXT.left)(m.rank || "?");
      role = m.requeued ? "queued" : "lobby";
      hud.toast(m.requeued ? `${t} Back in the queue.` : t, m.reason === "left" ? "info" : "warn", 6);
      becomeSpectator();
      context.events.emit("brawl:out", m);
    });
    on("br.notice", (m) => {
      let fn = NOTICE_TEXT[m.kind];
      fn && hud.toast(fn(m.name || "Someone", m.rank || "?"), m.kind === "join" ? "good" : "info");
      context.events.emit("brawl:notice", m);
    });
    on("br.state", (m) => {
      let r = remotes.get(m.id);
      r && playing() && r.opp.push(m);
    });
    on("br.shot", (m) => playing() && remoteShot(m));
    on("br.snap", (m) => {
      if (role === "playing" || m.arena !== watchId) return;
      for (let s of m.s || []) {
        let r = remotes.get(s.id);
        r && (r.opp.alive || r.opp.spawn(0), r.opp.push(s));
      }
      for (let s of m.shots || []) remoteShot(s);
    });
    on("br.damage", (m) => {
      if (m.target !== me() || !playing()) return;
      let p = context.player,
        src = m.from && remotes.get(m.from),
        from = src && src.opp.present ? src.opp.pos.clone().setY(src.opp.pos.y + 1.4) : null;
      if (!p.alive) return;
      applying = !0;
      try {
        ((p.health = Math.min(p.maxHealth, m.hp + m.amount)), p.damage(m.amount, from));
      } finally {
        applying = !1;
      }
      p.alive && (p.health = m.hp);
    });
    on("br.kill", (m) => {
      let killer = m.killer ? nameOf(m.killer) : null,
        victim = nameOf(m.victim),
        feed = context.hud && context.hud.feed;
      if (m.victim === me() && playing()) {
        let p = context.player;
        if (p.alive) {
          applying = !0;
          try {
            p.damage(p.health + 1, null);
          } finally {
            applying = !1;
          }
        }
        context.hud.message &&
          context.hud.message(`${killer ? `Killed by ${killer}` : "You went down"} · respawning in ${m.respawnIn || rules.respawnSeconds} s`, m.respawnIn || 3);
      } else {
        let r = remotes.get(m.victim);
        r && r.opp.kill();
      }
      feed &&
        feed(
          killer
            ? `<b>${esc(m.killer === me() ? "You" : killer)}</b> eliminated <b>${esc(m.victim === me() ? "you" : victim)}</b>`
            : `<b>${esc(m.victim === me() ? "You" : victim)}</b> went down`,
        );
      context.events.emit("brawl:kill", { ...m, me: me() });
    });
    on("br.spawn", (m) => {
      if (m.id === me()) {
        if (!playing()) return;
        (game.respawn(poseFor(m.spawn)), (sendClock = 0));
        context.player.enabled = game.state === "playing";
      } else {
        let r = remotes.get(m.id);
        r && r.opp.spawn(m.shield || 0);
      }
    });
    // ---- chat
    on("br.chat", (m) => hud.addMessage(m, me()));
    on("br.vote", (m) => hud.vote(m.msg, m.downs, !1));
    on("br.muted", (m) => {
      hud.setMuted(m.seconds || rules.voteMuteSeconds);
      endMic();
    });
    on("br.talk", (m) => {
      m.on ? talking.set(m.id, m) : talking.delete(m.id);
      hud.setTalking([...talking.values()]);
    });
    on("br.voice", (m) => {
      if (role === "playing" || silenced.has(m.msg)) return;
      voice.record(m.msg, m.seq, m.data); // kept for the ▶ button, even when it cannot play right now
      voice.play(m.msg, m.data) || audioLocked();
    });
    on("br.mic", (m) => {
      if (m.ok) {
        if (!mic || !mic.want) return void c.send("br.mic", { on: !1 });
        ((mic.ok = !0), (mic.msg = m.msg), (mic.left = m.seconds), (mic.warn = m.warn), (mic.listeners = m.listeners | 0));
        for (let d of mic.pending.splice(0)) (voice.record(mic.msg, micSeq, d), c.send("br.voice", { seq: micSeq++, data: d }));
        hud.addMessage({ id: m.msg, kind: "voice", from: me(), name: myName(), downs: 0 }, me());
        hud.setMic(micText(), !0);
        context.events.emit("brawl:mic", { on: !0 });
        return;
      }
      let why = m.code ? micError(m) : m.ended === "muted" ? "Thumbed down — mic cut." : m.ended ? "Mic time is up." : "";
      (endMic(!0), why && hud.note(why));
      m.code === "MUTED" && m.retryIn && hud.setMuted(m.retryIn);
    });
    on("br.error", (m) => {
      let text = ERRORS[m.code] || m.message || m.code;
      if (m.code === "CHAT_RATE") text = `At most ${rules.chatPerMinute} messages a minute — wait ${m.retryIn || "a few"} s.`;
      if (m.code === "MUTED") return hud.setMuted(m.retryIn || 0);
      if (m.code === "OWN_MESSAGE") text = "You can't thumb down your own message.";
      if (m.code === "PLAYERS_CANNOT_CHAT") text = "Chat is for spectators only.";
      entered ? (m.code === "QUEUE_FULL" ? hud.toast(text, "warn", 5) : hud.note(text)) : status(text, !0);
      m.code === "BRAWL_FULL" && disconnect();
    });
    on("close", (m) => {
      client = null;
      if (m.local) return;
      leaveWorld(m.code === 4000 ? ERRORS.PROTOCOL_MISMATCH : "Connection to the server was lost.", !0);
    });
  }

  function micError(m) {
    if (m.code === "MIC_BUSY") return `${rules.micMaxSpeakers} people are talking — wait for a free mic.`;
    if (m.code === "MIC_RATE") return `At most ${rules.micGrabsPerMinute} mic grabs a minute — wait ${m.retryIn || "a few"} s.`;
    if (m.code === "MUTED") return "";
    return m.message || m.code;
  }

  const touchUi = () => document.documentElement.classList.contains("is-touch"),
    micIdle = () => (touchUi() ? "Hold to talk" : "Hold V to talk");

  // ---- spectator bar: the camera mode on the bottom row, the seat button under the queue list
  function renderSpectator() {
    if (!entered || role === "playing") return;
    mic || hud.setMic(micIdle(), !1);
    let q = lobby ? lobby.queue : 0,
      free = spectator.mode === "free",
      who = spectator.target ? nameOf(spectator.target) : "",
      arenas = lobby && lobby.arenas && lobby.arenas.length > 1 ? `Arena ${watchId} of ${lobby.arenas.length} ([ ])` : "",
      seat = [];
    role === "lobby" && seat.push({ label: q || (arena && arena.players.length >= arena.max) ? "Join queue (J)" : "Play (J)", act: "play", primary: !0 });
    role === "queued" && seat.push({ label: "Watch only", act: "decline" });
    role === "offered" && seat.push({ label: "Take the seat (J)", act: "accept", primary: !0 }, { label: "Watch only", act: "decline" });
    hud.setWaitButtons(seat);
    // Follow: a second tap moves on to the next player; Free cam flies
    hud.setSpectator(
      arenas,
      [
        { label: free || !who ? "Follow" : `Follow · ${who}`, act: "follow", on: !free },
        { label: "Free cam", act: "free", on: free },
      ],
      `F switch · Q/E other player · Tab ${cursorFree ? "back to the view" : "free mouse"}`,
    );
  }

  // ---- HUD actions
  function action(a, data = {}) {
    if (!client) return;
    if (a === "play") return (hud.closePrompt(), (watchOnly = !1), client.send("br.play"));
    if (a === "queue") return (hud.closePrompt(), (watchOnly = !1), client.send("br.queue"));
    if (a === "accept") return (hud.closePrompt(), client.send("br.accept"));
    if (a === "decline") return (hud.closePrompt(), client.send("br.decline"));
    if (a === "close") return hud.closePrompt();
    if (a === "cam") return (spectator.toggle(), renderSpectator());
    if (a === "follow") return (spectator.mode === "free" ? spectator.toggle() : spectator.next(), renderSpectator());
    if (a === "free") return (spectator.mode === "free" || spectator.toggle(), renderSpectator());
    if (a === "say") {
      let text = sanitizeChat(data.text);
      return void (text && client.send("br.say", { text }));
    }
    if (a === "chat-close") return closeChat();
    if (a === "down")
      return (data.msg && (client.send("br.down", { msg: data.msg }), silenced.add(data.msg), voice.silence(data.msg), hud.vote(data.msg, null, !0)), void 0);
    if (a === "replay") {
      if (!data.msg) return;
      return void voice.playClip(data.msg).then((ok) => ok || hud.note(voice.hasClip(data.msg) ? "Audio is still locked — tap once more." : "That voice message is no longer kept."));
    }
    if (a === "mic-down") return void startMic();
    if (a === "mic-up") return void endMic();
  }

  // ---- chat box focus: typing must not move the camera or pause the game
  function openChat() {
    if (!entered || role === "playing" || chatOpen) return;
    chatOpen = !0;
    game.keepPlayingOnUnlock = !0;
    try {
      context.input.exitLock();
    } catch {}
    hud.openChat();
  }

  function closeChat() {
    if (!chatOpen) return;
    chatOpen = !1;
    hud.closeChat();
    // the unlock that follows a blur is still part of closing the chat
    setTimeout(() => chatOpen || cursorFree || (game.keepPlayingOnUnlock = !1), 250);
    if (entered && game.state === "playing" && !cursorFree)
      try {
        context.input.requestLock();
      } catch {}
  }
  hud.chatInput.addEventListener("blur", () => chatOpen && closeChat());

  // ---- free mouse for spectators (Tab): click the chat scrollbar, 👎 and the buttons without
  // pausing; Tab again or a click on the scene takes the mouse back
  function freeCursor() {
    if (!entered || role === "playing" || cursorFree) return;
    cursorFree = !0;
    game.keepPlayingOnUnlock = !0;
    try {
      context.input.exitLock();
    } catch {}
    hud.setCursorFree(!0);
    renderSpectator();
  }
  function lockCursor(relock = !1) {
    if (!cursorFree) return;
    cursorFree = !1;
    hud.setCursorFree(!1);
    // keep the flag a moment: a pending unlock must not turn into a pause
    setTimeout(() => chatOpen || cursorFree || (game.keepPlayingOnUnlock = !1), 250);
    if (relock && entered && game.state === "playing")
      try {
        context.input.requestLock();
      } catch {}
    renderSpectator();
  }
  offs.push(context.events.on("input:lock", ({ locked }) => locked && cursorFree && lockCursor()));

  // ---- push-to-talk
  // voice from others cannot play until this page has had a click or key press
  let lockedNoted = 0;
  function audioLocked() {
    let t = performance.now();
    t - lockedNoted > 4000 && ((lockedNoted = t), hud.note("🔇 Someone is talking — click or press any key to hear voice (▶ in the chat plays it again)."));
  }
  function unlockAudio() {
    entered && !voice.unlocked && voice.unlock() && lockedNoted && ((lockedNoted = 0), hud.note(""));
  }
  voice.onEvict = (id) => hud.expireVoice(id);
  window.addEventListener("pointerdown", unlockAudio, !0);
  window.addEventListener("keydown", unlockAudio, !0);
  offs.push(
    () => window.removeEventListener("pointerdown", unlockAudio, !0),
    () => window.removeEventListener("keydown", unlockAudio, !0),
  );

  function startMic() {
    if (!client || !entered || role === "playing" || (mic && mic.want)) return;
    // say why before asking the server for a mic that cannot be opened
    if (!canRecord()) return void hud.note(`Voice off: ${recordProblem()}. You can still hear others.`);
    mic = { want: !0, ok: !1, msg: 0, left: 0, warn: rules.micWarnSeconds, pending: [] };
    let mine = mic;
    hud.setMic("Asking for the mic…", !0);
    client.send("br.mic", { on: !0 });
    voice
      .start((data) => {
        if (mic !== mine || !client) return;
        mine.ok ? (voice.record(mine.msg, micSeq, data), client.send("br.voice", { seq: micSeq++, data })) : mine.pending.length < 8 && mine.pending.push(data);
      })
      .catch((e) => {
        mic === mine && (endMic(), hud.note(`Microphone unavailable: ${(e && e.message) || e}`));
      });
  }

  // the speaker is told how many spectators are listening (voice never reaches the players)
  function micText() {
    let n = mic.listeners | 0;
    let bars = "▁▂▃▄▅▆▇".charAt(Math.min(6, Math.floor(Math.sqrt(voice.level) * 7)));
    return `🔴 ${bars} Talking · ${Math.ceil(mic.left)} s · ` + (n ? `${n} listening` : "nobody is listening (only spectators hear voice)");
  }

  function endMic(fromServer = !1) {
    let m = mic;
    mic = null;
    voice.capturing && voice.stop();
    hud.setMic(micIdle(), !1);
    m && m.want && !fromServer && client && client.send("br.mic", { on: !1 });
    m && m.ok && context.events.emit("brawl:mic", { on: !1 });
  }

  // ---- per frame
  function damageFilter(amount) {
    if (applying) return !0;
    return (client && playing() && client.send("br.hurt", { amount: Math.min(500, amount) }), !1);
  }

  let r3 = (v) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];

  function frame(dt) {
    if (!entered) return;
    if (game.mode !== "brawl") return;
    // tags: only for players actually in view (never through walls)
    for (let r of remotes.values()) r.tag.update(r.opp.headPosition, r.opp.visible && r.opp.alive);
    // music down while a voice message plays
    context.audio && context.audio.setMusicDuck && context.audio.setMusicDuck(voice.busy ? 0.15 : 1);
    if (mic && mic.ok) {
      // a microphone that delivers only silence (permission, wrong input, iOS muted it) says so
      mic.quiet = voice.level < 0.003 ? (mic.quiet || 0) + dt : 0;
      mic.quiet > 1.2 && hud.note("🎙 The microphone is silent — check the browser's microphone permission or input.");
      mic.left -= dt;
      mic.left <= 0
        ? (endMic(), hud.note("Mic time is up."))
        : hud.setMic(mic.left <= mic.warn ? `🔴 ${Math.ceil(mic.left)} s left` : micText(), !0);
    }
    if (role !== "playing") {
      // spectators: the player body stays parked; the spectator camera owns the view
      context.player.enabled = !1;
      try {
        avatars.getCameraMode && avatars.getCameraMode() !== "first-person" && ((savedCamera = avatars.getCameraMode()), avatars.setCameraMode("first-person"));
      } catch {}
      spectator.on || spectator.start("follow");
      spectator.frame(dt);
      let t = spectator.target;
      t !== frame.lastTarget && ((frame.lastTarget = t), renderSpectator());
      return;
    }
    if (!client || (game.state !== "playing" && game.state !== "paused")) return;
    sendClock -= dt;
    if (sendClock > 0) return;
    sendClock = 1 / DUEL_RULES.stateHz;
    let p = context.player;
    if (!p.alive) return;
    let l = avatars.locomotion;
    client.send("br.state", {
      p: r3(p.pos),
      v: r3(p.vel),
      yaw: +p.yaw.toFixed(4),
      pitch: +p.pitch.toFixed(4),
      crouch: !!p.crouching,
      loco: l ? packLoco(l, context.weapon && context.weapon.heldAction ? context.weapon.heldAction() : null) : null,
    });
  }
  context.frameHooks.push(frame);

  function localShot(e) {
    if (!client || !playing() || !e || !e.origin) return;
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
    client.send("br.shot", { o: r3(e.muzzle || e.origin), e: r3(end), hit: !!hit });
  }

  function remoteShot(m) {
    if (!Array.isArray(m.o) || !Array.isArray(m.e)) return;
    let o = tmpA.set(m.o[0], m.o[1], m.o[2]),
      e = tmpB.set(m.e[0], m.e[1], m.e[2]),
      d = tmpD.subVectors(e, o),
      len = d.length();
    if (!(len > 0.01)) return;
    d.multiplyScalar(1 / len);
    // the flash and the tracer start at the shooter's rifle as the viewer sees it (its muzzle
    // anchor), not at the sender's own first-person muzzle: two bodies side by side see each
    // other's flame at the barrel they are looking at
    let src = m.id && remotes.get(m.id),
      barrel = src && src.opp.muzzle(tmpMuzzle, tmpBarrel);
    barrel && (src.opp.fire(), o.copy(tmpMuzzle));
    let fx = context.fx;
    try {
      (fx && fx.tracer && fx.tracer(o.clone(), e.clone()),
        fx && fx.muzzleFlash && fx.muzzleFlash(o.clone(), barrel ? tmpBarrel.clone() : d.clone(), { scale: 0.8 }),
        barrel && context.render && context.render.lightPool && context.render.lightPool.flash(o.clone(), 16756832, 30, 7, 0.05));
    } catch {}
    context.events.emit("versus:fire", { pos: o.clone() });
  }

  // ---- keys while watching (capture phase, before the game's own bindings)
  function onKey(e) {
    if (!inBrawl() || e.repeat && e.code !== "KeyV") return;
    let t = e.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    let watching = role !== "playing",
      live = game.state === "playing";
    if (e.code === "KeyJ" && live) {
      if (role === "offered") return (e.preventDefault(), action("accept"));
      if (role === "lobby" && watching) return (e.preventDefault(), action("play"));
      return;
    }
    if (!watching || !live) return;
    let handled = !0;
    if (e.code === "Tab") cursorFree ? lockCursor(!0) : freeCursor();
    else if (e.code === "Enter" || e.code === "NumpadEnter") openChat();
    else if (e.code === "KeyQ") (spectator.prev(), renderSpectator());
    else if (e.code === "KeyE") (spectator.next(), renderSpectator());
    else if (e.code === "KeyF") (spectator.toggle(), renderSpectator());
    else if (e.code === "KeyV") e.repeat || startMic();
    else if ((e.code === "BracketLeft" || e.code === "BracketRight") && lobby && lobby.arenas.length > 1) {
      let ids = lobby.arenas.map((a) => a.id),
        i = ids.indexOf(watchId),
        next = ids[(i + (e.code === "BracketRight" ? 1 : -1) + ids.length) % ids.length];
      next !== watchId && ((watchId = next), (arena = null), clearRemotes(), client.send("br.spectate", { arena: next }));
    } else handled = !1;
    handled && (e.preventDefault(), e.stopPropagation());
  }
  function onKeyUp(e) {
    e.code === "KeyV" && mic && endMic();
  }
  window.addEventListener("keydown", onKey, !0);
  window.addEventListener("keyup", onKeyUp, !0);
  offs.push(
    () => window.removeEventListener("keydown", onKey, !0),
    () => window.removeEventListener("keyup", onKeyUp, !0),
  );

  // ---- menus
  function openLobby() {
    (ui.server && !ui.server.value && (ui.server.value = context.params.server || prefs.server || defaultServerUrl()),
      ui.name && !ui.name.value && (ui.name.value = prefs.name || ""),
      client || status(""));
    menus.show("brawl");
  }

  async function enter(only = !1) {
    // called from the menu click: the one gesture every brawl visit has, so voice can play
    voice.unlock();
    watchOnly = !!only;
    autoJoin = !1;
    status("");
    try {
      let c = await ensureClient();
      status("Entering the brawl…");
      c.send("br.enter");
    } catch (e) {
      status(e.message, !0);
    }
  }

  offs.push(
    context.events.on("menu:action", ({ act }) => {
      if (act === "brawl") return openLobby();
      if (act === "br-enter") return void enter();
      if (act === "br-watch-only") return void enter(!0);
      if (act === "br-back") return (savePrefs(), disconnect(), status(""));
      if (act === "br-watch") {
        // pause menu: give the seat back and keep watching
        client && role === "playing" && client.send("br.watch");
        game.state === "paused" && game.resume();
      }
    }),
    context.events.on("game:quit", ({ mode }) => {
      if (leavingQuietly || mode !== "brawl") return;
      lockCursor();
      ((entered = !1), (role = "lobby"), endMic(), spectator.stop(), clearRemotes(), hud.show(!1));
      context.player.damageFilter === damageFilter && (context.player.damageFilter = null);
      context.player.invulnerable = !1;
      disconnect();
    }),
    context.events.on("character:change", ({ id }) => {
      client && client.send("profile", { avatar: id ?? null, name: myName() });
    }),
    context.events.on("weapon:fire", localShot),
  );
  if (ui.name) {
    let h = () => {
      let bad = nameProblem(ui.name.value);
      if (bad) return status(bad, !0);
      status("");
      savePrefs();
      client && client.send("profile", { name: myName() });
    };
    ui.name.addEventListener("change", h);
    offs.push(() => ui.name.removeEventListener("change", h));
  }

  let api = {
    hud,
    spectator,
    voice,
    remotes,
    get client() {
      return client;
    },
    get id() {
      return me();
    },
    get role() {
      return entered ? role : null;
    },
    get lobby() {
      return lobby;
    },
    get arena() {
      return arena;
    },
    get entered() {
      return entered;
    },
    get chatOpen() {
      return chatOpen;
    },
    get cursorFree() {
      return cursorFree;
    },
    get watchOnly() {
      return watchOnly;
    },
    get mic() {
      return mic ? { ok: mic.ok, left: mic.left, msg: mic.msg } : null;
    },
    get serverUrl() {
      return serverUrl();
    },
    open: openLobby,
    enter,
    action,
    openChat,
    closeChat,
    leave() {
      disconnect();
      leaveWorld(null);
    },
    dispose() {
      if (disposed) return;
      disposed = !0;
      (client && client.close(1000, "world disposed"), (client = null));
      context.player && context.player.damageFilter === damageFilter && (context.player.damageFilter = null);
      game.keepPlayingOnUnlock = !1;
      let i = context.frameHooks.indexOf(frame);
      i >= 0 && context.frameHooks.splice(i, 1);
      (offs.forEach((f) => f()), clearRemotes(), voice.dispose(), context.audio && context.audio.setMusicDuck && context.audio.setMusicDuck(1), hud.dispose(), spectator.stop());
      context.brawl === api && (context.brawl = null);
    },
  };
  return (context.brawl = api);
}

export { createBrawl };
