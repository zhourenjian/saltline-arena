// Brawl: free-for-all arenas with one global queue, timed culls, spectators and spectator chat.
//
// Transport-agnostic like hub.mjs: the hub routes every "br.*" message here and calls remove()
// when a client goes away. There are no timers inside: the owner calls tick() (duel-server.mjs
// every 100 ms, the tests whenever they move their fake clock), so everything is deterministic.
//
// People in the brawl are "members". A member is in exactly one role:
//   lobby    watching (spectating an arena), not waiting for a seat
//   queued   watching and waiting in the global queue
//   offered  at the head of the queue with a seat held for offerSeconds
//   playing  in an arena
// Only non-playing members can chat or talk, and only non-playing members receive chat and voice,
// so spectators cannot call out positions to the people playing.
import {
  BRAWL_RULES,
  rankPlayers,
  pickBrawlSpawn,
  sanitizeChat,
} from "../src/brawl/rules.js";
import { healthAt, sanitizeLoco } from "../src/versus/rules.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const vec3 = (a) =>
  Array.isArray(a) && a.length === 3 && a.every(finite) && a.every((n) => Math.abs(n) < 1e4);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function createBrawl({
  rules = BRAWL_RULES,
  now = () => Date.now() / 1000,
  random = Math.random,
  emit, // (client, type, data)
  log = () => {},
} = {}) {
  const R = rules,
    members = new Map(), // client → member
    queue = [], // members with role queued/offered, in order
    arenas = new Map(), // id → arena
    // mute key → muted-until. The key is the address plus the callsign, fixed when the member
    // enters: reconnecting under the same name stays muted, while other people behind the same
    // NAT (an office, a campus, a mobile carrier) are not muted with them.
    mutes = new Map(),
    messages = new Map(), // id → chat/voice message (for thumbs-down)
    history = []; // last chatHistory messages, oldest first
  let nextArena = 1,
    nextMsg = 1,
    lastSnap = 0,
    lobbyDirty = false;

  const send = (m, t, d) => emit(m.client, t, d);
  const spectators = () => [...members.values()].filter((m) => m.role !== "playing");
  const toSpectators = (t, d, except = null) => {
    for (const m of members.values()) m.role !== "playing" && m !== except && send(m, t, d);
  };
  const muteKeyFor = (c) => `${c.key || c.id}|${String(c.name || "").toLowerCase()}`;
  const keyOf = (m) => m.muteKey || muteKeyFor(m.client);
  const addrOf = (c) => c.key || c.id;
  const mutedFor = (m) => Math.max(0, (mutes.get(keyOf(m)) || 0) - now());
  const waiting = () => queue.filter((m) => m.role === "queued").length;

  // ---- arenas
  function newArena() {
    const a = {
      id: nextArena++,
      players: new Map(), // client id → member
      nextCullAt: now() + R.cullSeconds,
      dirty: true,
      shots: [],
    };
    arenas.set(a.id, a);
    log(`brawl: arena ${a.id} opened`);
    return a;
  }
  newArena();

  const offersFor = (a) => queue.filter((m) => m.role === "offered" && m.offer.arena === a.id).length;
  const freeSeats = (a) => R.maxPlayers - a.players.size - offersFor(a);
  const watchersOf = (a) => [...members.values()].filter((m) => m.role !== "playing" && m.watch === a.id);
  function toArena(a, t, d, { watchers = true, except = null } = {}) {
    for (const m of a.players.values()) m !== except && send(m, t, d);
    if (watchers) for (const m of watchersOf(a)) m !== except && send(m, t, d);
  }

  function arenaView(a) {
    const t = now(),
      wait = waiting();
    return {
      id: a.id,
      max: R.maxPlayers,
      players: rankPlayers([...a.players.values()].map((m) => m.p)).map((p) => ({
        id: p.id,
        name: p.member.client.name,
        avatar: p.member.client.avatar,
        kills: p.kills,
        deaths: p.deaths,
        alive: p.alive,
        played: Math.round(t - p.joinedAt),
      })),
      cullIn: Math.max(0, Math.round(a.nextCullAt - t)),
      cullCount: wait > 0 ? Math.min(wait, wait >= R.busyQueue ? R.cullCountBusy : R.cullCount) : 0,
      queue: wait,
    };
  }

  // the spectators' wait list: the queue in order, then watch-only spectators, newest first,
  // at most waitListSize entries. Built once per lobby broadcast.
  function waitList() {
    const q = queue.slice(0, R.waitListSize).map((m, i) => ({ id: m.client.id, name: m.client.name, pos: i + 1, offered: m.role === "offered" }));
    if (q.length >= R.waitListSize) return q;
    const w = [...members.values()]
      .filter((m) => m.role === "lobby")
      .sort((a, b) => b.enteredAt - a.enteredAt)
      .slice(0, R.waitListSize - q.length)
      .map((m) => ({ id: m.client.id, name: m.client.name, pos: 0 }));
    return q.concat(w);
  }

  function lobbyView(m, list) {
    const pos = queue.indexOf(m);
    return {
      // players get no list: who is watching does not matter in the arena
      list: m.role === "playing" ? undefined : list || waitList(),
      role: m.role,
      watch: m.watch,
      arena: m.role === "playing" ? m.arena.id : null,
      position: pos >= 0 ? pos + 1 : 0,
      queue: queue.length,
      spectators: spectators().length,
      arenas: [...arenas.values()].map((a) => ({ id: a.id, players: a.players.size, max: R.maxPlayers })),
      muted: Math.ceil(mutedFor(m)),
    };
  }
  const sendLobby = (m) => send(m, "br.lobby", lobbyView(m));

  // ---- seats
  function fresh(m, a) {
    const t = now();
    return {
      id: m.client.id,
      member: m,
      kills: 0,
      deaths: 0,
      stintDeaths: 0,
      joinedAt: t,
      alive: true,
      health: R.maxHealth,
      lastHurtAt: -1e9,
      shieldUntil: t + R.spawnShieldSeconds,
      respawnAt: 0,
      lastPos: null,
      lastYaw: 0,
      lastMoveAt: t,
      lastStateAt: t,
      hitTokens: R.hitBurst,
      lastHitAt: 0,
    };
  }

  function others(a, except) {
    return [...a.players.values()]
      .filter((m) => m !== except && m.p.alive && m.p.lastPos)
      .map((m) => m.p.lastPos);
  }

  function seat(m, a) {
    dequeue(m);
    m.role = "playing";
    m.arena = a;
    m.watch = a.id;
    m.offer = null;
    endMic(m);
    m.p = fresh(m, a);
    a.players.set(m.client.id, m);
    const spawn = pickBrawlSpawn(others(a, m), random);
    send(m, "br.joined", {
      arena: a.id,
      spawn,
      shield: R.spawnShieldSeconds,
      view: arenaView(a),
    });
    toArena(a, "br.notice", { kind: "join", id: m.client.id, name: m.client.name }, { except: m });
    a.dirty = true;
    lobbyDirty = true;
    log(`brawl: ${m.client.name} joined arena ${a.id}`);
  }

  // out of an arena; reason: left | culled | deaths | afk | disconnected
  function unseat(m, reason, requeue = false) {
    const a = m.arena;
    if (!a || m.role !== "playing") return;
    const rank = rankPlayers([...a.players.values()].map((x) => x.p)).findIndex((p) => p.member === m) + 1;
    a.players.delete(m.client.id);
    m.arena = null;
    m.p = null;
    m.role = "lobby";
    m.watch = a.id;
    toArena(a, "br.notice", { kind: reason, id: m.client.id, name: m.client.name, rank }, { except: m });
    if (reason !== "disconnected") {
      send(m, "br.out", { reason, rank, requeued: requeue });
      requeue && enqueue(m);
    }
    a.dirty = true;
    lobbyDirty = true;
    log(`brawl: ${m.client.name} out of arena ${a.id} (${reason})`);
  }

  function enqueue(m) {
    if (queue.includes(m)) return true;
    if (queue.length >= R.maxQueue) return (send(m, "br.error", { code: "QUEUE_FULL", message: "the queue is full, try again later" }), false);
    m.role = "queued";
    m.queuedAt = now();
    queue.push(m);
    lobbyDirty = true;
    return true;
  }

  function dequeue(m) {
    const i = queue.indexOf(m);
    i >= 0 && (queue.splice(i, 1), (lobbyDirty = true));
    m.role === "queued" || m.role === "offered" ? (m.role = "lobby") : null;
    m.offer = null;
  }

  // free seats go to the head of the queue as offers; open another arena when the queue is long
  function serveQueue() {
    const t = now();
    for (const m of [...queue])
      if (m.role === "offered" && m.offer.until <= t) {
        dequeue(m);
        send(m, "br.offer", { expired: true });
      }
    for (const m of queue) {
      if (m.role !== "queued") continue;
      let a = [...arenas.values()].find((x) => freeSeats(x) > 0);
      if (!a && waiting() >= R.openArenaQueue && arenas.size < R.maxArenas) a = newArena();
      if (!a) break;
      m.role = "offered";
      m.offer = { arena: a.id, until: t + R.offerSeconds };
      send(m, "br.offer", { arena: a.id, seconds: R.offerSeconds });
      lobbyDirty = true;
    }
    // close empty extra arenas
    for (const a of [...arenas.values()])
      if (a.id !== 1 && !a.players.size && !offersFor(a) && arenas.size > 1) {
        arenas.delete(a.id);
        for (const m of members.values()) m.watch === a.id && (m.watch = 1);
        lobbyDirty = true;
        log(`brawl: arena ${a.id} closed`);
      }
  }

  // ---- culls, AFK, respawns
  function cull(a) {
    const t = now(),
      wait = waiting();
    a.nextCullAt = t + R.cullSeconds;
    a.dirty = true;
    if (!wait) return;
    const count = Math.min(wait, wait >= R.busyQueue ? R.cullCountBusy : R.cullCount),
      ranked = rankPlayers([...a.players.values()].map((m) => m.p)),
      out = [];
    for (let i = ranked.length - 1; i >= 0 && out.length < count; i--)
      t - ranked[i].joinedAt >= R.cullGraceSeconds && out.push(ranked[i].member);
    for (const m of out) unseat(m, "culled", true);
  }

  function respawn(a, m) {
    const p = m.p;
    Object.assign(p, {
      alive: true,
      health: R.maxHealth,
      lastHurtAt: -1e9,
      shieldUntil: now() + R.spawnShieldSeconds,
      respawnAt: 0,
      lastPos: null,
      lastMoveAt: now(),
    });
    toArena(a, "br.spawn", { id: m.client.id, spawn: pickBrawlSpawn(others(a, m), random), shield: R.spawnShieldSeconds });
  }

  function tick() {
    const t = now(),
      wait = waiting();
    for (const a of arenas.values()) {
      for (const m of [...a.players.values()]) {
        const p = m.p;
        if (!p.alive && p.respawnAt && t >= p.respawnAt) respawn(a, m);
        if (wait && (t - p.lastMoveAt > R.afkSeconds || t - p.lastStateAt > R.stalledSeconds)) unseat(m, "afk");
      }
      t >= a.nextCullAt && cull(a);
    }
    for (const m of members.values()) m.talk && t > m.talk.until && endMic(m, "time");
    serveQueue();
    if (lobbyDirty) {
      lobbyDirty = false;
      const list = waitList();
      for (const m of members.values()) send(m, "br.lobby", lobbyView(m, m.role === "playing" ? null : list));
    }
    for (const a of arenas.values())
      if (a.dirty) {
        a.dirty = false;
        toArena(a, "br.arena", arenaView(a));
      }
    // spectators: one batched snapshot per arena at spectatorHz
    if (t - lastSnap >= 1 / R.spectatorHz - 1e-6) {
      lastSnap = t;
      for (const a of arenas.values()) {
        const w = watchersOf(a);
        if (!w.length) {
          a.shots.length = 0;
          continue;
        }
        const s = [...a.players.values()]
          .filter((m) => m.p.alive && m.lastState)
          .map((m) => ({ id: m.client.id, ...m.lastState }));
        const snap = { arena: a.id, s, shots: a.shots.splice(0) };
        for (const m of w) send(m, "br.snap", snap);
      }
    }
  }

  // ---- combat
  function hurt(a, victim, amount, shooter, part) {
    const p = victim.p,
      t = now(),
      hp = Math.max(0, healthAt(p, t) - amount);
    ((p.health = hp), (p.lastHurtAt = t));
    toArena(a, "br.damage", { target: victim.client.id, from: shooter ? shooter.client.id : null, amount, hp, part: part || null }, { watchers: false });
    hp <= 0 && kill(a, victim, shooter);
  }

  function kill(a, victim, killer) {
    const v = victim.p;
    ((v.alive = false), (v.health = 0), v.deaths++, v.stintDeaths++, (v.respawnAt = now() + R.respawnSeconds));
    killer && killer.p && killer.p.kills++;
    toArena(a, "br.kill", {
      victim: victim.client.id,
      killer: killer ? killer.client.id : null,
      respawnIn: R.respawnSeconds,
    });
    a.dirty = true;
    // too many deaths while others wait: the seat goes to the queue
    if (v.stintDeaths >= R.deathLimit && waiting() > 0) unseat(victim, "deaths", true);
  }

  // ---- chat and voice
  function addMessage(m, kind, text) {
    const msg = {
      id: nextMsg++,
      kind,
      from: m.client.id,
      key: keyOf(m),
      name: m.client.name,
      text,
      at: now(),
      downs: new Set(),
      // one vote per address too, so reconnecting does not stack thumbs-downs
      voters: new Set(),
    };
    messages.set(msg.id, msg);
    // forget old messages for voting after a while
    if (messages.size > 1000) messages.delete(messages.keys().next().value);
    if (kind === "text") {
      history.push(msg);
      history.length > R.chatHistory && history.shift();
    }
    return msg;
  }
  const msgView = (msg) => ({ id: msg.id, kind: msg.kind, from: msg.from, name: msg.name, text: msg.text, downs: msg.downs.size });

  function recent(list, seconds) {
    const t = now();
    while (list.length && t - list[0] >= seconds) list.shift();
    return list;
  }

  function endMic(m, why = "released") {
    if (!m.talk) return;
    const msg = m.talk.msg;
    m.talk = null;
    send(m, "br.mic", { ok: false, ended: why });
    toSpectators("br.talk", { id: m.client.id, msg, on: false }, m);
  }

  const handlers = {
    enter(c) {
      let m = members.get(c);
      if (!m) {
        if (spectators().length >= R.maxSpectators)
          return emit(c, "br.error", { code: "BRAWL_FULL", message: "the brawl lobby is full, try again later" });
        m = { enteredAt: now(), muteKey: muteKeyFor(c), client: c, role: "lobby", watch: 1, arena: null, p: null, offer: null, chat: [], grabs: [], talk: null, lastState: null };
        members.set(c, m);
      }
      const a = [...arenas.values()].find((x) => x.players.size) || arenas.get(1) || [...arenas.values()][0];
      m.watch = a.id;
      send(m, "br.welcome", {
        rules: {
          maxPlayers: R.maxPlayers,
          cullSeconds: R.cullSeconds,
          offerSeconds: R.offerSeconds,
          deathLimit: R.deathLimit,
          respawnSeconds: R.respawnSeconds,
          chatPerMinute: R.chatPerMinute,
          chatMaxChars: R.chatMaxChars,
          micSeconds: R.micSeconds,
          micWarnSeconds: R.micWarnSeconds,
          micGrabsPerMinute: R.micGrabsPerMinute,
          micMaxSpeakers: R.micMaxSpeakers,
          voteMuteSeconds: R.voteMuteSeconds,
          voiceRate: R.voiceRate,
        },
        canPlayNow: !waiting() && [...arenas.values()].some((x) => freeSeats(x) > 0),
        history: history.map(msgView),
        talking: [...members.values()].filter((x) => x.talk).map((x) => ({ id: x.client.id, name: x.client.name, msg: x.talk.msg })),
      });
      sendLobby(m);
      send(m, "br.arena", arenaView(a));
      lobbyDirty = true;
    },
    // play now if a seat is free and nobody is waiting, otherwise queue
    play(c) {
      const m = members.get(c);
      if (!m || m.role === "playing") return;
      if (m.role === "offered") return handlers.accept(c);
      if (!waiting()) {
        const a = [...arenas.values()].find((x) => freeSeats(x) > 0);
        if (a) return seat(m, a);
      }
      enqueue(m) && (serveQueue(), sendLobby(m));
    },
    queue(c) {
      const m = members.get(c);
      m && m.role === "lobby" && enqueue(m) && (serveQueue(), sendLobby(m));
    },
    accept(c) {
      const m = members.get(c);
      if (!m || m.role !== "offered") return;
      const a = arenas.get(m.offer.arena);
      // the held seat is gone (should not happen): back to the front of the queue
      if (!a || a.players.size >= R.maxPlayers)
        return ((m.role = "queued"), (m.offer = null), serveQueue(), sendLobby(m));
      seat(m, a);
    },
    decline(c) {
      const m = members.get(c);
      m && (m.role === "offered" || m.role === "queued") && (dequeue(m), serveQueue(), sendLobby(m));
    },
    // leave the arena (or the queue) and keep watching
    watch(c) {
      const m = members.get(c);
      if (!m) return;
      m.role === "playing" ? unseat(m, "left") : dequeue(m);
      serveQueue();
    },
    spectate(c, msg) {
      const m = members.get(c),
        a = arenas.get(msg.arena | 0);
      if (!m || !a || m.role === "playing") return;
      m.watch = a.id;
      send(m, "br.arena", arenaView(a));
      sendLobby(m);
    },
    exit(c) {
      remove(c, "left");
      emit(c, "br.lobby", null);
    },

    state(c, msg) {
      const m = members.get(c);
      if (!m || m.role !== "playing" || !vec3(msg.p)) return;
      const p = m.p,
        t = now();
      if (t - p.lastStateAt < 0.02 && p.lastPos) return;
      const yaw = finite(msg.yaw) ? msg.yaw : 0;
      if (!p.lastPos || Math.hypot(msg.p[0] - p.lastPos[0], msg.p[1] - p.lastPos[1], msg.p[2] - p.lastPos[2]) > 0.05 || Math.abs(yaw - p.lastYaw) > 0.02)
        p.lastMoveAt = t;
      ((p.lastStateAt = t), (p.lastPos = msg.p), (p.lastYaw = yaw));
      if (!p.alive) return;
      const out = {
        p: msg.p,
        v: vec3(msg.v) ? msg.v : [0, 0, 0],
        yaw,
        pitch: finite(msg.pitch) ? msg.pitch : 0,
        crouch: !!msg.crouch,
        loco: sanitizeLoco(msg.loco),
      };
      m.lastState = out;
      for (const o of m.arena.players.values()) o !== m && send(o, "br.state", { id: c.id, ...out });
    },
    shot(c, msg) {
      const m = members.get(c);
      if (!m || m.role !== "playing" || !m.p.alive || !vec3(msg.o) || !vec3(msg.e)) return;
      const s = { id: c.id, o: msg.o, e: msg.e, hit: !!msg.hit };
      for (const o of m.arena.players.values()) o !== m && send(o, "br.shot", s);
      m.arena.shots.length < 64 && m.arena.shots.push(s);
    },
    hit(c, msg) {
      const m = members.get(c);
      if (!m || m.role !== "playing") return;
      const a = m.arena,
        target = a.players.get(String(msg.target || ""));
      if (!target || target === m) return;
      const t = now(),
        me = m.p,
        them = target.p;
      if (!me.alive || !them.alive || t < them.shieldUntil) return;
      me.hitTokens = Math.min(R.hitBurst, me.hitTokens + (t - (me.lastHitAt || t)) * R.maxHitsPerSecond);
      me.lastHitAt = t;
      if (me.hitTokens < 1) return;
      me.hitTokens -= 1;
      if (me.lastPos && them.lastPos && Math.hypot(me.lastPos[0] - them.lastPos[0], me.lastPos[1] - them.lastPos[1], me.lastPos[2] - them.lastPos[2]) > R.maxHitDistance) return;
      const part = msg.part === "head" ? "head" : "body";
      hurt(a, target, R.damage[part], m, part);
    },
    hurt(c, msg) {
      const m = members.get(c);
      if (!m || m.role !== "playing" || !m.p.alive) return;
      const amount = Math.min(R.maxHealth, Math.max(0, +msg.amount || 0));
      amount > 0 && hurt(m.arena, m, amount, null, null);
    },

    say(c, msg) {
      const m = members.get(c);
      if (!m) return;
      if (m.role === "playing") return send(m, "br.error", { code: "PLAYERS_CANNOT_CHAT", message: "chat is for spectators" });
      const text = sanitizeChat(msg.text);
      if (!text) return;
      const muted = mutedFor(m);
      if (muted > 0) return send(m, "br.error", { code: "MUTED", retryIn: Math.ceil(muted), message: `muted for ${Math.ceil(muted)} s` });
      const sent = recent(m.chat, 60);
      if (sent.length >= R.chatPerMinute)
        return send(m, "br.error", { code: "CHAT_RATE", retryIn: Math.ceil(60 - (now() - sent[0])), message: `at most ${R.chatPerMinute} messages a minute` });
      sent.push(now());
      toSpectators("br.chat", msgView(addMessage(m, "text", text)));
    },
    down(c, msg) {
      const m = members.get(c),
        target = messages.get(msg.msg | 0);
      if (!m || m.role === "playing" || !target) return;
      if (target.from === c.id) return send(m, "br.error", { code: "OWN_MESSAGE", message: "you cannot vote on your own message" });
      if (target.downs.has(c.id) || target.voters.has(addrOf(c))) return;
      target.downs.add(c.id);
      target.voters.add(addrOf(c));
      const until = Math.max(now(), mutes.get(target.key) || 0) + R.voteMuteSeconds;
      mutes.set(target.key, until);
      toSpectators("br.vote", { msg: target.id, downs: target.downs.size });
      for (const x of members.values())
        if (keyOf(x) === target.key) {
          send(x, "br.muted", { seconds: Math.ceil(until - now()) });
          endMic(x, "muted");
        }
    },
    mic(c, msg) {
      const m = members.get(c);
      if (!m) return;
      if (!msg.on) return endMic(m);
      if (m.talk) return;
      const fail = (code, message, retryIn) => send(m, "br.mic", { ok: false, code, message, retryIn });
      if (m.role === "playing") return fail("PLAYERS_CANNOT_CHAT", "voice is for spectators");
      const muted = mutedFor(m);
      if (muted > 0) return fail("MUTED", `muted for ${Math.ceil(muted)} s`, Math.ceil(muted));
      const grabs = recent(m.grabs, 60);
      if (grabs.length >= R.micGrabsPerMinute)
        return fail("MIC_RATE", `at most ${R.micGrabsPerMinute} mic grabs a minute`, Math.ceil(60 - (now() - grabs[0])));
      const talking = [...members.values()].filter((x) => x.talk && x !== m).length;
      if (talking >= R.micMaxSpeakers) return fail("MIC_BUSY", `${talking} people are already talking`);
      grabs.push(now());
      const v = addMessage(m, "voice", "");
      m.talk = { until: now() + R.micSeconds, msg: v.id, bytes: 0 };
      send(m, "br.mic", { ok: true, seconds: R.micSeconds, warn: R.micWarnSeconds, msg: v.id, rate: R.voiceRate });
      toSpectators("br.chat", msgView(v), m);
      toSpectators("br.talk", { id: c.id, name: c.name, msg: v.id, on: true }, m);
    },
    voice(c, msg) {
      const m = members.get(c);
      if (!m || !m.talk || m.role === "playing") return;
      const data = typeof msg.data === "string" ? msg.data : "";
      if (!data || data.length > Math.ceil((R.voiceChunkMax * 4) / 3) + 4 || !BASE64.test(data)) return;
      const bytes = Math.floor((data.length * 3) / 4);
      m.talk.bytes += bytes;
      if (m.talk.bytes > R.voiceRate * R.micSeconds * 1.25) return endMic(m, "too much audio");
      toSpectators("br.voice", { from: c.id, msg: m.talk.msg, seq: msg.seq | 0, data }, m);
    },
  };

  function remove(c, reason = "disconnected") {
    const m = members.get(c);
    if (!m) return;
    endMic(m, reason);
    m.role === "playing" && unseat(m, reason === "left" ? "left" : "disconnected");
    dequeue(m);
    members.delete(c);
    lobbyDirty = true;
    serveQueue();
  }

  return {
    rules: R,
    members,
    queue,
    arenas,
    tick,
    has: (c) => members.has(c),
    receive(c, msg) {
      const h = handlers[msg.t.slice(3)];
      h && h(c, msg);
    },
    remove,
    // for /health
    stats() {
      return {
        arenas: arenas.size,
        playing: [...arenas.values()].reduce((n, a) => n + a.players.size, 0),
        queued: queue.length,
        watching: spectators().length,
      };
    },
  };
}
