// 1v1 duel rules, shared by the browser client and the Node relay server (server/duel-server.mjs).
// Pure data and functions only: no DOM, no Three.js, so Node can import this file as-is.

var DUEL_PROTOCOL = 2; // 2: loco.w (reload / inspect). A server still on 1 refuses the hello instead of silently dropping the field.

var DUEL_RULES = {
  killsToWin: 5,
  countdownSeconds: 3,
  respawnSeconds: 3,
  // after a respawn the server ignores hits on that player for this long
  spawnShieldSeconds: 1.5,
  maxHealth: 100,
  // health regeneration mirrors player.js (regenDelay / regenRate) so client and server agree
  regenDelay: 4,
  regenRate: 25,
  // damage is decided by the server from the hit part, never taken from the client
  damage: { body: 20, head: 50 },
  // the rifle fires 720 rpm (12/s); hits above this rate are dropped
  maxHitsPerSecond: 13,
  hitBurst: 6,
  maxHitDistance: 320,
  // network
  stateHz: 20,
  interpolationDelay: 0.1,
  roomCodeLength: 4,
  minNameLength: 3,
  maxNameLength: 8,
  maxMessageBytes: 16384,
  // remote player hitbox (metres, feet origin), matches PLAYER_DIMENSIONS
  hitbox: { radius: 0.42, height: 1.8, crouchHeight: 1.2, head: 0.32 },
};

// Spawn points on the open harbor apron (feet x, z). Index-based on the wire; the server picks
// one far from the opponent. tests/modes.test.mjs checks every point is walkable and clear.
var DUEL_SPAWNS = [
  [-32, 6],
  [-19, -1.4],
  [3.5, -1.6],
  [14.2, 16.4],
  [-3.2, 16.6],
  [-16, 26],
  [6, 26],
  [-9.3, 12.5],
  [18.3, 20.4],
  [27.2, -12.6],
  [19.6, 15.4],
  [-28, -6],
];

// room codes avoid look-alike characters (0/O, 1/I/L)
var ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function normalizeRoomCode(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, DUEL_RULES.roomCodeLength);
}

// callsign: 3-8 characters (code points) with at least one letter or digit (any script); control
// characters and <>&"'` are dropped. Anything else (a name of spaces / symbols only, too short) falls
// back to the default, so the server never shows an empty or unreadable name.
var NAME_HAS_WORD = /[\p{L}\p{N}]/u;
function cleanName(s) {
  return String(s || "")
    .replace(/[\u0000-\u001f\u007f<>&"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function nameProblem(raw) {
  let n = Array.from(cleanName(raw));
  if (!n.length) return "";
  if (n.length < DUEL_RULES.minNameLength || n.length > DUEL_RULES.maxNameLength)
    return `Callsign must be ${DUEL_RULES.minNameLength}-${DUEL_RULES.maxNameLength} characters.`;
  return NAME_HAS_WORD.test(n.join("")) ? "" : "Callsign needs letters or digits, not only spaces and symbols.";
}
function sanitizeName(s) {
  let n = Array.from(cleanName(s)).slice(0, DUEL_RULES.maxNameLength).join("").trim();
  return Array.from(n).length >= DUEL_RULES.minNameLength && NAME_HAS_WORD.test(n) ? n : "Breacher";
}

// avatar ids follow the DuoWorld package id pattern; anything else means "built-in operator"
var AVATAR_ID = /^[a-z0-9][a-z0-9._-]*$/;
function sanitizeAvatar(s) {
  return typeof s === "string" && s.length <= 64 && AVATAR_ID.test(s)
    ? s
    : null;
}

// health with regeneration applied up to `now` (seconds)
function healthAt(p, now) {
  if (!p.alive) return 0;
  let since = now - p.lastHurtAt - DUEL_RULES.regenDelay;
  return since > 0
    ? Math.min(DUEL_RULES.maxHealth, p.health + since * DUEL_RULES.regenRate)
    : p.health;
}

// spawn index far from `avoid` ([x, z] or null): random among the farther half
function pickSpawn(avoid, random = Math.random, exclude = -1) {
  let idx = DUEL_SPAWNS.map((_, i) => i).filter((i) => i !== exclude);
  if (!avoid) return idx[Math.floor(random() * idx.length)];
  idx.sort(
    (a, b) =>
      Math.hypot(DUEL_SPAWNS[b][0] - avoid[0], DUEL_SPAWNS[b][1] - avoid[1]) -
      Math.hypot(DUEL_SPAWNS[a][0] - avoid[0], DUEL_SPAWNS[a][1] - avoid[1]),
  );
  let far = idx.slice(0, Math.max(1, Math.ceil(idx.length / 2)));
  return far[Math.floor(random() * far.length)];
}

// locomotion the sender reports so remote bodies can animate (jumps, climbs). The server relays
// only this shape: bounded numbers and short strings, never anything the sender could stuff in.
function sanitizeLoco(l) {
  if (!l || typeof l !== "object") return null;
  let num = (v, lo, hi, d = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d),
    out = {
      grounded: !!l.grounded,
      phase: String(l.phase || "grounded").slice(0, 16),
      mode: String(l.mode || "duoworld:walk").slice(0, 32),
      sprinting: !!l.sprinting,
      speed: num(l.speed, 0, 100),
    };
  if (l.climb && typeof l.climb === "object") {
    let c = l.climb;
    out.climb = {
      kind: c.kind === "ladder" ? "ladder" : "mantle",
      progress: num(c.progress, 0, 1),
      ledgeHeight: num(c.ledgeHeight, -1, 4),
      ledgeDistance: num(c.ledgeDistance, 0, 3),
      climbSpeed: num(c.climbSpeed, -10, 10),
      crouchEnd: !!c.crouchEnd,
    };
  }
  // what the hands are doing with the gun: [action 0 none | 1 reload | 2 inspect, seconds into it, empty magazine 0|1]
  if (Array.isArray(l.w) && (l.w[0] === 1 || l.w[0] === 2)) out.w = [l.w[0], num(l.w[1], 0, 4), l.w[2] ? 1 : 0];
  return out;
}

// client side: the locomotion state a body reports, rounded for the wire (sanitizeLoco checks it again)
function packLoco(l, act) {
  let r = (v, n = 2) => +(+v || 0).toFixed(n),
    out = { grounded: !!l.grounded, phase: l.phase, mode: l.mode, sprinting: !!l.sprinting, speed: r(l.speed) };
  l.climb &&
    (out.climb = {
      kind: l.climb.kind,
      progress: r(l.climb.progress, 3),
      ledgeHeight: r(l.climb.ledgeHeight),
      ledgeDistance: r(l.climb.ledgeDistance),
      climbSpeed: r(l.climb.climbSpeed),
      crouchEnd: !!l.climb.crouchEnd,
    });
  act && (act.a === 1 || act.a === 2) && (out.w = [act.a, r(act.t), act.empty ? 1 : 0]);
  return out;
}

export {
  packLoco,
  sanitizeLoco,
  DUEL_PROTOCOL,
  DUEL_RULES,
  DUEL_SPAWNS,
  ROOM_CODE_ALPHABET,
  normalizeRoomCode,
  sanitizeName,
  nameProblem,
  sanitizeAvatar,
  healthAt,
  pickSpawn,
};
