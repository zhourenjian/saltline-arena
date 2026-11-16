// Duel rooms and match rules. Transport-agnostic: the WebSocket server (duel-server.mjs) and the
// unit tests (tests/hub.test.mjs) drive it through connect(send, close) → client.receive(text).
//
// Authority split: position, movement and hit detection run on the shooter's client ("favor the
// shooter"); the hub owns health, damage amounts, kills, score, respawn timing and spawn choice,
// and sanity-checks every hit claim (rate, distance, alive, spawn shield). This is a friendly
// match relay, not an anti-cheat system: a modified client can still aim for you.
import {
  DUEL_PROTOCOL,
  DUEL_RULES,
  DUEL_SPAWNS,
  ROOM_CODE_ALPHABET,
  normalizeRoomCode,
  sanitizeName,
  sanitizeAvatar,
  sanitizeLoco,
  healthAt,
  pickSpawn,
} from "../src/versus/rules.js";
import { createBrawl } from "./brawl.mjs";
import { BRAWL_RULES } from "../src/brawl/rules.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const vec3 = (a) =>
  Array.isArray(a) && a.length === 3 && a.every(finite) && a.every((n) => Math.abs(n) < 1e4);

export function createDuelHub({
  now = () => Date.now() / 1000,
  random = Math.random,
  setTimer = (fn, s) => setTimeout(fn, s * 1000),
  clearTimer = (t) => clearTimeout(t),
  log = () => {},
  brawlRules = BRAWL_RULES,
  rtc = false, // advertise the WebRTC data channel in the welcome message
  // per-client message flood guard (token bucket); voice chunks and 20 Hz poses fit easily
  messagesPerSecond = 120,
  messageBurst = 240,
} = {}) {
  const rooms = new Map(),
    clients = new Set();
  let nextId = 1;
  // emit is a hoisted function declaration, so the brawl can use it right away
  const brawl = createBrawl({ rules: brawlRules, now, random, emit, log });

  function newCode() {
    for (let tries = 0; tries < 1000; tries++) {
      let code = "";
      for (let i = 0; i < DUEL_RULES.roomCodeLength; i++)
        code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
    throw new Error("no free room code");
  }

  // Poses are replaced by the next one 50-100 ms later, so when a client's link is stalled
  // (socket buffer already holding this much) they are dropped instead of queued: when the link
  // recovers it gets the newest state, not a burst of old ones to replay.
  const STALE_BACKLOG = 6000;
  const droppable = (t, data) =>
    t === "state" || t === "br.state" || (t === "pong" && data.u === 1) || (t === "br.snap" && !(data.shots && data.shots.length));
  function emit(client, t, data = {}) {
    const fast = droppable(t, data);
    try {
      const text = JSON.stringify({ t, ...data });
      // over the UDP data channel when the player has one; otherwise the WebSocket, unless that is backed up
      if (fast && client.sendFast && client.sendFast(text)) return;
      if (fast && client.backlog && client.backlog() > STALE_BACKLOG) return void (client.dropped = (client.dropped || 0) + 1);
      client.send(text);
    } catch (e) {
      log("send failed", e);
    }
  }
  const broadcast = (room, t, data) => room.players.forEach((c) => emit(c, t, data));
  const peerOf = (client) =>
    client.room && client.room.players.find((c) => c !== client);

  function roomView(room) {
    return {
      code: room.code,
      players: room.players.map((c) => ({
        id: c.id,
        name: c.name,
        avatar: c.avatar,
        score: room.match ? room.match.scores[c.id] || 0 : 0,
      })),
      phase: room.match ? room.match.phase : "waiting",
      killsToWin: DUEL_RULES.killsToWin,
    };
  }
  const sendRoom = (room) => broadcast(room, "room", roomView(room));

  function clearMatch(room) {
    const m = room.match;
    if (!m) return;
    for (const t of m.timers) clearTimer(t);
    m.timers.clear();
    room.match = null;
  }

  function later(room, seconds, fn) {
    const m = room.match,
      t = setTimer(() => {
        m.timers.delete(t);
        room.match === m && fn();
      }, seconds);
    m.timers.add(t);
  }

  function startMatch(room) {
    clearMatch(room);
    const [a, b] = room.players,
      sa = pickSpawn(null, random),
      sb = pickSpawn(DUEL_SPAWNS[sa], random, sa),
      t = now();
    const fresh = (spawn) => ({
      alive: true,
      health: DUEL_RULES.maxHealth,
      lastHurtAt: -1e9,
      shieldUntil: t + DUEL_RULES.countdownSeconds,
      spawn,
      kills: 0,
      deaths: 0,
    });
    room.match = {
      phase: "countdown",
      scores: { [a.id]: 0, [b.id]: 0 },
      pl: { [a.id]: fresh(sa), [b.id]: fresh(sb) },
      rematch: new Set(),
      timers: new Set(),
      startedAt: t,
    };
    room.players.forEach((c) => ((c.lastPos = null), (c.hitTokens = DUEL_RULES.hitBurst)));
    broadcast(room, "start", {
      spawns: { [a.id]: sa, [b.id]: sb },
      countdown: DUEL_RULES.countdownSeconds,
      killsToWin: DUEL_RULES.killsToWin,
      room: roomView(room),
    });
    later(room, DUEL_RULES.countdownSeconds, () => {
      room.match.phase = "live";
      broadcast(room, "live", {});
    });
    log(`room ${room.code}: match start`);
  }

  function kill(room, victim, killer) {
    const m = room.match,
      v = m.pl[victim.id];
    ((v.alive = false), (v.health = 0), v.deaths++);
    killer && (m.scores[killer.id]++, m.pl[killer.id].kills++);
    const winner = killer && m.scores[killer.id] >= DUEL_RULES.killsToWin ? killer : null;
    broadcast(room, "kill", {
      victim: victim.id,
      killer: killer ? killer.id : null,
      scores: { ...m.scores },
      respawnIn: winner ? null : DUEL_RULES.respawnSeconds,
    });
    if (winner) {
      m.phase = "over";
      for (const t of m.timers) clearTimer(t);
      m.timers.clear();
      broadcast(room, "end", {
        winner: winner.id,
        scores: { ...m.scores },
        stats: Object.fromEntries(
          Object.entries(m.pl).map(([id, p]) => [id, { kills: p.kills, deaths: p.deaths }]),
        ),
      });
      sendRoom(room);
      log(`room ${room.code}: ${winner.name} wins`);
      return;
    }
    later(room, DUEL_RULES.respawnSeconds, () => {
      const peer = peerOf(victim),
        spawn = pickSpawn(peer && peer.lastPos ? [peer.lastPos[0], peer.lastPos[2]] : null, random);
      Object.assign(v, {
        alive: true,
        health: DUEL_RULES.maxHealth,
        lastHurtAt: -1e9,
        shieldUntil: now() + DUEL_RULES.spawnShieldSeconds,
        spawn,
      });
      victim.lastPos = null;
      broadcast(room, "spawn", {
        id: victim.id,
        spawn,
        shield: DUEL_RULES.spawnShieldSeconds,
      });
    });
  }

  function hurt(room, victim, amount, shooter, part) {
    const m = room.match,
      v = m.pl[victim.id],
      t = now(),
      hp = Math.max(0, healthAt(v, t) - amount);
    ((v.health = hp), (v.lastHurtAt = t));
    broadcast(room, "damage", {
      target: victim.id,
      from: shooter ? shooter.id : null,
      amount,
      hp,
      part: part || null,
    });
    hp <= 0 && kill(room, victim, shooter);
  }

  function leaveRoom(client, reason = "left") {
    const room = client.room;
    if (!room) return;
    room.players = room.players.filter((c) => c !== client);
    client.room = null;
    const wasPlaying = !!room.match;
    clearMatch(room);
    if (!room.players.length) return void rooms.delete(room.code);
    wasPlaying && broadcast(room, "peer:left", { id: client.id, reason });
    sendRoom(room);
  }

  const handlers = {
    hello(c, m) {
      if (m.v !== DUEL_PROTOCOL)
        return (
          emit(c, "error", {
            code: "PROTOCOL_MISMATCH",
            message: `server speaks duel protocol ${DUEL_PROTOCOL}`,
          }),
          c.close(4000, "protocol mismatch")
        );
      ((c.name = sanitizeName(m.name)), (c.avatar = sanitizeAvatar(m.avatar)), (c.hello = true));
      emit(c, "welcome", {
        id: c.id,
        v: DUEL_PROTOCOL,
        features: rtc ? ["duel", "brawl", "rtc"] : ["duel", "brawl"],
        rules: {
          killsToWin: DUEL_RULES.killsToWin,
          respawnSeconds: DUEL_RULES.respawnSeconds,
          countdownSeconds: DUEL_RULES.countdownSeconds,
        },
      });
    },
    profile(c, m) {
      ((c.name = sanitizeName(m.name ?? c.name)),
        (c.avatar = m.avatar === undefined ? c.avatar : sanitizeAvatar(m.avatar)));
      c.room && sendRoom(c.room);
    },
    create(c) {
      brawl.remove(c, "left");
      leaveRoom(c);
      const room = { code: newCode(), players: [c], match: null };
      (rooms.set(room.code, room), (c.room = room));
      sendRoom(room);
      log(`room ${room.code} created by ${c.name}`);
    },
    join(c, m) {
      const code = normalizeRoomCode(m.code),
        room = rooms.get(code);
      if (c.room && c.room === room) return sendRoom(room);
      if (!room) return emit(c, "error", { code: "ROOM_NOT_FOUND", message: `no room ${code || "(empty)"}` });
      if (room.players.length >= 2) return emit(c, "error", { code: "ROOM_FULL", message: `room ${code} is full` });
      brawl.remove(c, "left");
      leaveRoom(c);
      (room.players.push(c), (c.room = room));
      sendRoom(room);
      room.players.length === 2 && startMatch(room);
    },
    leave(c) {
      leaveRoom(c);
      emit(c, "room", null);
    },
    state(c, m) {
      const room = c.room,
        peer = peerOf(c);
      if (!room || !room.match || !vec3(m.p)) return;
      const t = now();
      // drop floods (the client sends 20 Hz)
      if (c.lastStateAt && t - c.lastStateAt < 0.02) return;
      ((c.lastStateAt = t), (c.lastPos = m.p));
      peer &&
        emit(peer, "state", {
          id: c.id,
          p: m.p,
          v: vec3(m.v) ? m.v : [0, 0, 0],
          yaw: finite(m.yaw) ? m.yaw : 0,
          pitch: finite(m.pitch) ? m.pitch : 0,
          crouch: !!m.crouch,
          loco: sanitizeLoco(m.loco),
        });
    },
    shot(c, m) {
      const peer = peerOf(c),
        match = c.room && c.room.match;
      if (!peer || !match || match.phase === "over" || !vec3(m.o) || !vec3(m.e)) return;
      if (!match.pl[c.id].alive) return;
      emit(peer, "shot", { id: c.id, o: m.o, e: m.e, hit: !!m.hit });
    },
    hit(c, m) {
      const room = c.room,
        match = room && room.match,
        target = peerOf(c);
      if (!match || match.phase !== "live" || !target || m.target !== target.id) return;
      const t = now(),
        me = match.pl[c.id],
        them = match.pl[target.id];
      if (!me.alive || !them.alive || t < them.shieldUntil) return;
      // token bucket: the rifle cannot land more than maxHitsPerSecond
      c.hitTokens = Math.min(
        DUEL_RULES.hitBurst,
        (c.hitTokens ?? DUEL_RULES.hitBurst) + (t - (c.lastHitAt || t)) * DUEL_RULES.maxHitsPerSecond,
      );
      c.lastHitAt = t;
      if (c.hitTokens < 1) return;
      c.hitTokens -= 1;
      if (
        c.lastPos &&
        target.lastPos &&
        Math.hypot(
          c.lastPos[0] - target.lastPos[0],
          c.lastPos[1] - target.lastPos[1],
          c.lastPos[2] - target.lastPos[2],
        ) > DUEL_RULES.maxHitDistance
      )
        return;
      const part = m.part === "head" ? "head" : "body";
      hurt(room, target, DUEL_RULES.damage[part], c, part);
    },
    // self-inflicted damage (falls, the sea); no kill credit
    hurt(c, m) {
      const match = c.room && c.room.match;
      if (!match || match.phase !== "live" || !match.pl[c.id].alive) return;
      const amount = Math.min(DUEL_RULES.maxHealth, Math.max(0, +m.amount || 0));
      amount > 0 && hurt(c.room, c, amount, null, null);
    },
    rematch(c) {
      const room = c.room,
        match = room && room.match;
      if (!match || match.phase !== "over") return;
      match.rematch.add(c.id);
      broadcast(room, "rematch", { ids: [...match.rematch] });
      room.players.length === 2 &&
        room.players.every((p) => match.rematch.has(p.id)) &&
        startMatch(room);
    },
    ping(c, m) {
      emit(c, "pong", m.u === 1 ? { at: m.at, u: 1 } : { at: m.at });
    },
    // a client's own summary of its last ~30 s of ping samples (see src/versus/net.js); only logged
    netstat(c, m) {
      const n = (v, max = 60000) => (Number.isFinite(+v) ? Math.max(0, Math.min(max, Math.round(+v))) : 0);
      log(
        `net ${c.name || c.id}: udp=${n(m.udp, 1)} un=${n(m.un, 100)} uavg=${n(m.uavg)} umax=${n(m.umax)} uloss=${n(m.uloss, 100)} n=${n(m.n, 100)} avg=${n(m.avg)} p95=${n(m.p95)} max=${n(m.max)} net-max=${n(m.netMax)} queue-max=${n(m.lagMax)} over200=${n(m.over200, 100)} via=${String(m.via || "-").slice(0, 12)}`,
      );
    },
  };

  return {
    rooms,
    clients,
    brawl,
    tick: () => brawl.tick(),
    // key: who this connection is for mutes that must survive a reconnect (the server passes the
    // remote address); defaults to the connection id
    connect(send, close = () => {}, { key = null, backlog = null, sendFast = null } = {}) {
      const id = "p" + nextId++;
      let tokens = messageBurst,
        tokensAt = now();
      const client = {
        id,
        key: key || id,
        name: "Breacher",
        avatar: null,
        room: null,
        hello: false,
        send,
        close,
        backlog,
        sendFast,
        dropped: 0,
        lastPos: null,
        receive(text) {
          let m;
          try {
            m = JSON.parse(text);
          } catch {
            return emit(client, "error", { code: "BAD_MESSAGE", message: "not JSON" });
          }
          const t = now();
          tokens = Math.min(messageBurst, tokens + (t - tokensAt) * messagesPerSecond);
          tokensAt = t;
          if (tokens < 1) return;
          tokens -= 1;
          if (!m || typeof m.t !== "string") return;
          const brawlMsg = m.t.startsWith("br.");
          if (!brawlMsg && !handlers[m.t]) return;
          if (!client.hello && m.t !== "hello")
            return emit(client, "error", { code: "HELLO_FIRST", message: "send hello first" });
          if (brawlMsg) {
            // entering the brawl leaves any duel room
            m.t === "br.enter" && client.room && leaveRoom(client);
            return brawl.receive(client, m);
          }
          handlers[m.t](client, m);
        },
        disconnect() {
          clients.delete(client);
          brawl.remove(client, "disconnected");
          leaveRoom(client, "disconnected");
        },
      };
      clients.add(client);
      return client;
    },
  };
}
