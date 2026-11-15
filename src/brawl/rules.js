// Brawl (free-for-all) rules, shared by the browser client and the Node server (server/brawl.mjs).
// Pure data and functions only: no DOM, no Three.js, so Node can import this file as-is.
//
// Every number the server enforces lives in BRAWL_RULES. The server operator can override the
// ones marked (env) with environment variables (see server/duel-server.mjs and README).
import { DUEL_RULES, DUEL_SPAWNS } from "../versus/rules.js";

var BRAWL_RULES = {
  // ---- arena
  maxPlayers: 6, // (env BRAWL_MAX_PLAYERS, 2..12) players in one arena at once
  minPlayers: 1, // an arena runs even with one player (they roam and wait)
  maxArenas: 3, // (env BRAWL_MAX_ARENAS, 1..20) parallel arenas when the queue is long
  // a new arena opens when every arena is full and at least this many people are queued
  openArenaQueue: 4, // (env BRAWL_OPEN_ARENA_QUEUE)
  // ---- culling ("eliminate the last place so the queue moves")
  cullSeconds: 60, // (env BRAWL_CULL_SECONDS, 30..600) one cull round every N seconds
  cullCount: 1, // (env BRAWL_CULL_COUNT, 1..3) players removed per round …
  cullCountBusy: 2, // … or this many when the queue is at least busyQueue long
  busyQueue: 6, // (env BRAWL_BUSY_QUEUE)
  cullGraceSeconds: 45, // a player who joined less than this long ago is never culled
  deathLimit: 10, // (env BRAWL_DEATH_LIMIT) this many deaths in one stint ends it (only while people wait)
  // ---- seats
  offerSeconds: 15, // a queued player has this long to accept a free seat
  afkSeconds: 45, // no movement for this long while people wait → seat freed
  stalledSeconds: 12, // no pose packets at all for this long while people wait → seat freed
  // ---- combat (same weapon and numbers as the duel)
  respawnSeconds: 3,
  spawnShieldSeconds: 1.5,
  maxHealth: DUEL_RULES.maxHealth,
  regenDelay: DUEL_RULES.regenDelay,
  regenRate: DUEL_RULES.regenRate,
  damage: DUEL_RULES.damage, // { body: 20, head: 50 }
  maxHitsPerSecond: DUEL_RULES.maxHitsPerSecond,
  hitBurst: DUEL_RULES.hitBurst,
  maxHitDistance: DUEL_RULES.maxHitDistance,
  stateHz: DUEL_RULES.stateHz,
  spectatorHz: 10, // spectators get batched snapshots at this rate
  // ---- capacity
  maxQueue: 200, // (env BRAWL_MAX_QUEUE)
  maxSpectators: 500, // (env BRAWL_MAX_SPECTATORS) everyone in the brawl lobby who is not playing
  waitListSize: 10, // spectators see this many names: the queue first, then watch-only, newest first
  // ---- spectator chat (players in an arena never receive it: no calling out positions)
  chatMaxChars: 200,
  chatPerMinute: 6, // text messages per rolling minute
  chatHistory: 60, // messages a newcomer receives
  voteMuteSeconds: 10, // each thumbs-down mutes the author for this much longer
  // ---- voice ("grab the mic")
  micMaxSpeakers: 3, // a grab succeeds when at most micMaxSpeakers-1 others are talking
  micSeconds: 10, // one grab lasts at most this long
  micWarnSeconds: 5, // the client shows a countdown after this
  micGrabsPerMinute: 3,
  voiceRate: 8000, // Hz, 8-bit µ-law mono: 8 kB/s
  voiceChunkMax: 6000, // bytes per chunk after base64 decoding
};

// server-side overrides from the environment; returns a new rules object
function brawlRulesFromEnv(env = {}) {
  let r = { ...BRAWL_RULES },
    int = (name, key, lo, hi) => {
      let v = env[name];
      if (v === undefined || v === "") return;
      let n = Math.round(Number(v));
      Number.isFinite(n) && (r[key] = Math.max(lo, Math.min(hi, n)));
    };
  int("BRAWL_MAX_PLAYERS", "maxPlayers", 2, 12);
  int("BRAWL_MAX_ARENAS", "maxArenas", 1, 20);
  int("BRAWL_OPEN_ARENA_QUEUE", "openArenaQueue", 1, 100);
  int("BRAWL_CULL_SECONDS", "cullSeconds", 30, 600);
  int("BRAWL_CULL_COUNT", "cullCount", 1, 3);
  int("BRAWL_CULL_COUNT_BUSY", "cullCountBusy", 1, 4);
  int("BRAWL_BUSY_QUEUE", "busyQueue", 1, 1000);
  int("BRAWL_DEATH_LIMIT", "deathLimit", 3, 1000);
  int("BRAWL_AFK_SECONDS", "afkSeconds", 15, 3600);
  int("BRAWL_OFFER_SECONDS", "offerSeconds", 5, 120);
  int("BRAWL_STALLED_SECONDS", "stalledSeconds", 5, 3600);
  int("BRAWL_MAX_QUEUE", "maxQueue", 1, 10000);
  int("BRAWL_MAX_SPECTATORS", "maxSpectators", 1, 10000);
  r.cullCountBusy = Math.max(r.cullCount, r.cullCountBusy);
  return r;
}

// standings: more kills first, then fewer deaths, then whoever joined later (they had less time)
function rankPlayers(list) {
  return [...list].sort(
    (a, b) => b.kills - a.kills || a.deaths - b.deaths || b.joinedAt - a.joinedAt,
  );
}

// spawn index whose nearest living player is as far as possible (random among the best third)
function pickBrawlSpawn(others, random = Math.random) {
  let scored = DUEL_SPAWNS.map((s, i) => {
    let near = Infinity;
    for (let o of others) near = Math.min(near, Math.hypot(s[0] - o[0], s[1] - o[2]));
    return { i, near };
  }).sort((a, b) => b.near - a.near);
  let best = scored.slice(0, Math.max(1, Math.ceil(scored.length / 3)));
  return best[Math.floor(random() * best.length)].i;
}

function sanitizeChat(s) {
  return String(s || "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, BRAWL_RULES.chatMaxChars);
}

// ---- µ-law (G.711), used for the spectators' voice chunks. Pure functions so tests can run them.
function muLawEncode(sample) {
  // sample: float -1..1
  let s = Math.max(-1, Math.min(1, sample)) * 32635,
    sign = s < 0 ? 0x80 : 0;
  s = Math.min(32635, Math.abs(s)) + 132;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
  let mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

function muLawDecode(byte) {
  let u = ~byte & 0xff,
    sign = u & 0x80,
    exp = (u >> 4) & 7,
    mant = u & 0x0f,
    s = (((mant << 3) + 132) << exp) - 132;
  return (sign ? -s : s) / 32635;
}

export {
  BRAWL_RULES,
  brawlRulesFromEnv,
  rankPlayers,
  pickBrawlSpawn,
  sanitizeChat,
  muLawEncode,
  muLawDecode,
};
