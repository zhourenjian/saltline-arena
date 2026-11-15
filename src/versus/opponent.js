// The other player in a 1v1 duel: a body built from their chosen Avatar Package (through
// AvatarHost.createInstance — never by reaching into the package), moved from interpolated
// network snapshots, with a capsule + head hitbox registered as a combat shot target.
//
// Remote avatar ids are sanitized by the server and again here, and load only from this World's
// own avatarRoot; if the package is missing or unsupported the built-in operator is used.
import { Group, Vector3 } from "../vendor/three-r180.js";
import { AVATAR_COORDINATES } from "../duoworld/protocol/protocol.js";
import { PLAYER_MOVEMENT } from "../player/player.js";
import { attachHeldGun } from "../weapons/held-gun.js";
import { DUEL_RULES, sanitizeAvatar } from "./rules.js";

var OPPONENT = {
  bufferSize: 24,
  maxExtrapolate: 0.25, // s beyond the newest snapshot before the body just holds still
  snapDistance: 6, // m: a jump larger than this between snapshots teleports
  deathTipSeconds: 0.55,
  deathHideSeconds: 1.6,
  headRadius: 0.2,
};

var _a = new Vector3(),
  _b = new Vector3();

function lerpAngle(a, b, t) {
  let d = ((((b - a) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return a + d * t;
}

// ray (o, unit d) against a sphere; distance or -1
function raySphere(o, d, c, r) {
  let ox = o.x - c.x,
    oy = o.y - c.y,
    oz = o.z - c.z,
    b = ox * d.x + oy * d.y + oz * d.z,
    q = ox * ox + oy * oy + oz * oz - r * r,
    h = b * b - q;
  if (h < 0) return -1;
  h = Math.sqrt(h);
  let t = -b - h;
  return t >= 0 ? t : q < 0 ? 0 : -1;
}

// ray against a vertical capsule (foot at base.y, total height h, radius r); distance or -1
function rayCapsule(o, d, base, h, r) {
  let best = -1,
    y0 = base.y + r,
    y1 = base.y + Math.max(r, h - r),
    // infinite vertical cylinder in XZ
    ox = o.x - base.x,
    oz = o.z - base.z,
    a = d.x * d.x + d.z * d.z;
  if (a > 1e-9) {
    let b = ox * d.x + oz * d.z,
      c = ox * ox + oz * oz - r * r,
      disc = b * b - a * c;
    if (disc >= 0) {
      let t = (-b - Math.sqrt(disc)) / a;
      if (t >= 0) {
        let y = o.y + d.y * t;
        y >= y0 && y <= y1 && (best = t);
      }
    }
  }
  for (let y of [y0, y1]) {
    let t = raySphere(o, d, _a.set(base.x, y, base.z), r);
    t >= 0 && (best < 0 || t < best) && (best = t);
  }
  return best;
}

function createOpponent(context, avatars, { onHit, minDelay } = {}) {
  let root = new Group(),
    scaleNode = new Group(),
    entry = null,
    avatarId = void 0,
    buildToken = 0,
    buffer = [], // { at, p: Vector3, v, yaw, pitch, crouch, loco }
    clock = 0,
    lastArrival = -1,
    gap = 0, // smoothed time between snapshots
    dev = 0, // smoothed deviation of that time (network jitter)
    baseDelay = minDelay || DUEL_RULES.interpolationDelay,
    pos = new Vector3(),
    vel = new Vector3(),
    yaw = 0,
    pitch = 0,
    crouch = 0,
    loco = null,
    alive = !0,
    present = !1, // a snapshot has arrived since the last (re)spawn
    deadFor = 0,
    shieldLeft = 0,
    lastPhase = "grounded",
    act = { a: 0, t: 0, empty: !1 }, // what their hands are doing with the gun (reload / inspect)
    disposed = !1;
  ((root.name = "saltline:opponent"),
    (scaleNode.rotation.y = AVATAR_COORDINATES.forward === "+Z" ? Math.PI : 0),
    root.add(scaleNode),
    (root.visible = !1),
    context.scene.add(root));

  async function setAvatar(id) {
    id = sanitizeAvatar(id);
    if (id === avatarId && entry) return;
    avatarId = id;
    let my = ++buildToken,
      next;
    try {
      next = await avatars.createInstance(id);
    } catch (e) {
      console.warn(`[versus] opponent avatar "${id}" unavailable, using the operator:`, e && e.message);
      if (my !== buildToken || disposed) return;
      try {
        next = await avatars.createInstance(null);
      } catch {
        return;
      }
    }
    if (my !== buildToken || disposed) return void avatars.releaseInstance(next);
    entry && avatars.releaseInstance(entry);
    entry = next;
    scaleNode.add(entry.object3D); // height-normalized wrapper (AvatarHost)
    // in a fight everybody carries this World's gun; released with the entry (AvatarHost)
    entry.heldRig = attachHeldGun(context, entry.instance);
  }

  function push(m) {
    if (!Array.isArray(m.p)) return;
    let p = new Vector3(m.p[0], m.p[1], m.p[2]),
      last = buffer[buffer.length - 1];
    // a big jump (respawn, server correction) starts a fresh track
    last && last.p.distanceTo(p) > OPPONENT.snapDistance && (buffer.length = 0);
    buffer.push({
      at: clock,
      p,
      v: Array.isArray(m.v) ? new Vector3(m.v[0], m.v[1], m.v[2]) : new Vector3(),
      yaw: +m.yaw || 0,
      pitch: +m.pitch || 0,
      crouch: !!m.crouch,
      loco: m.loco || null,
    });
    buffer.length > OPPONENT.bufferSize && buffer.shift();
    // render far enough behind the newest snapshot to always have two to blend between, even
    // when they arrive late or in bursts (spectators get only 10 per second)
    if (lastArrival >= 0) {
      let d = clock - lastArrival;
      if (d < 1) {
        gap = gap ? gap + (d - gap) * 0.1 : d;
        dev += (Math.abs(d - gap) - dev) * 0.1;
      }
    }
    lastArrival = clock;
    present || ((present = !0), pos.copy(p), (yaw = +m.yaw || 0));
  }

  function sample() {
    if (!buffer.length) return;
    let t = clock - Math.min(0.6, Math.max(baseDelay, gap * 1.15 + dev * 3)),
      i = buffer.length - 1;
    while (i > 0 && buffer[i - 1].at > t) i--;
    let b = buffer[i],
      a = buffer[i - 1];
    if (a && b.at > a.at && t <= b.at) {
      let k = Math.max(0, Math.min(1, (t - a.at) / (b.at - a.at)));
      (pos.lerpVectors(a.p, b.p, k), vel.lerpVectors(a.v, b.v, k), (yaw = lerpAngle(a.yaw, b.yaw, k)));
      pitch = a.pitch + (b.pitch - a.pitch) * k;
      loco = k < 0.5 ? a.loco : b.loco;
      crouch += ((b.crouch ? 1 : 0) - crouch) * 0.25;
    } else {
      // newest snapshot is older than the render time: extrapolate briefly, then hold
      let n = buffer[buffer.length - 1],
        ahead = Math.min(Math.max(0, t - n.at), OPPONENT.maxExtrapolate + gap);
      (pos.copy(n.p).addScaledVector(n.v, ahead), vel.copy(n.v), (yaw = n.yaw), (pitch = n.pitch), (loco = n.loco));
      crouch += ((n.crouch ? 1 : 0) - crouch) * 0.25;
    }
  }

  function locomotion(dt) {
    let l = loco || {},
      speed = Math.hypot(vel.x, vel.z);
    // landing is derived locally from the remote phase
    let phase = l.phase || "grounded";
    (lastPhase === "airborne" || lastPhase === "takeoff") && phase === "grounded" && (phase = "landing");
    lastPhase = l.phase || "grounded";
    // reload / inspect: the sender's clock on a change, ours in between
    let w = alive && Array.isArray(l.w) ? l.w : null,
      a = w ? w[0] : 0;
    a !== act.a || (w && Math.abs(w[1] - act.t) > 0.6) ? ((act.a = a), (act.t = w ? +w[1] || 0 : 0), (act.empty = !!(w && w[2]))) : a && (act.t += dt);
    return {
      grounded: phase !== "airborne" && phase !== "takeoff",
      speed: alive ? (Number.isFinite(l.speed) ? l.speed : speed) : 0,
      velocity: { x: vel.x, y: vel.y, z: vel.z },
      phase,
      deltaSeconds: dt,
      mode: l.mode === "duoworld:climb" ? "duoworld:climb" : "duoworld:walk",
      gravity: PLAYER_MOVEMENT.gravity,
      stance: crouch > 0.5 ? "crouching" : "standing",
      sprinting: !!l.sprinting,
      aimPitch: pitch,
      ...(l.climb && l.mode === "duoworld:climb" ? { climb: { ...l.climb } } : {}),
    };
  }

  function height() {
    let r = DUEL_RULES.hitbox;
    return r.height + (r.crouchHeight - r.height) * crouch;
  }

  function frame(dt) {
    if (disposed) return;
    clock += dt;
    shieldLeft = Math.max(0, shieldLeft - dt);
    alive ? sample() : (deadFor += dt);
    let tip = alive ? 0 : Math.min(1, deadFor / OPPONENT.deathTipSeconds);
    (root.position.copy(pos),
      (root.rotation.y = yaw),
      // dying: fall backwards (+Z is behind a body looking down -Z)
      (root.rotation.x = -tip * tip * (Math.PI / 2) * 0.92),
      (root.visible = present && !!entry && (alive || deadFor < OPPONENT.deathHideSeconds)));
    if (!entry || !root.visible) return;
    let inst = entry.instance,
      paused = context.game && context.game.state === "paused";
    if (paused) return;
    try {
      let state = typeof inst.setLocomotion == "function" || entry.heldRig ? locomotion(dt) : null;
      entry.heldRig && entry.heldRig.apply(state, act, !alive ? !1 : state.mode === "duoworld:climb");
      typeof inst.setLocomotion == "function"
        ? inst.setLocomotion(state)
        : inst.setMotion(!alive ? "idle" : Math.hypot(vel.x, vel.z) < 0.3 ? "idle" : Math.hypot(vel.x, vel.z) > 5 ? "run" : "walk");
      inst.update(dt);
    } catch (e) {}
  }

  // combat shot target (src/combat/combat.js): nearest hit in front of walls wins
  let target = {
    ref: { opponent: !0, get pos() { return pos; } },
    raycast(o, d, max) {
      if (!alive || !present) return null;
      let h = height(),
        r = DUEL_RULES.hitbox.radius,
        hr = OPPONENT.headRadius,
        headC = _b.set(pos.x, pos.y + h - hr * 0.8, pos.z),
        th = raySphere(o, d, headC, hr),
        tb = rayCapsule(o, d, pos, h - DUEL_RULES.hitbox.head * 0.7, r),
        t = -1,
        part = "body";
      th >= 0 && (tb < 0 || th <= tb + 0.05) ? ((t = th), (part = "head")) : tb >= 0 && (t = tb);
      if (t < 0 || t > max) return null;
      let point = new Vector3().copy(o).addScaledVector(d, t),
        normal = new Vector3(point.x - pos.x, 0, point.z - pos.z);
      normal.lengthSq() < 1e-6 ? normal.copy(d).negate() : normal.normalize();
      return { dist: t, point, normal, part };
    },
    onHit(hit) {
      onHit && onHit(hit);
    },
  };
  (context.shotTargets || (context.shotTargets = [])).push(target);
  context.frameHooks.push(frame);

  return {
    root,
    target,
    get pos() {
      return pos;
    },
    get alive() {
      return alive;
    },
    get present() {
      return present;
    },
    get visible() {
      return root.visible;
    },
    get avatarId() {
      return avatarId;
    },
    get headPosition() {
      return _a.set(pos.x, pos.y + height() + 0.25, pos.z);
    },
    get shielded() {
      return shieldLeft > 0;
    },
    setAvatar,
    // Where the muzzle of the gun in their hands is right now. Flash and tracer start there, so
    // what a player sees at the gun they are looking at is what shoots. Returns false when the
    // body carries no gun (avatar without a "weapon" anchor), has it stowed, or is not shown.
    muzzle(outPos, outDir) {
      if (!root.visible || !entry || !entry.heldRig) return !1;
      root.updateWorldMatrix(!0, !1);
      return entry.heldRig.muzzle(outPos, outDir);
    },
    get heldAction() {
      return act;
    },
    get heldRig() {
      return entry ? entry.heldRig || null : null;
    },
    // a short recoil on the body, for bodies that declare the action
    fire() {
      let inst = entry && entry.instance,
        acts = inst && inst.capabilities && inst.capabilities.actions;
      if (!inst || typeof inst.playAction != "function" || !Array.isArray(acts) || !acts.includes("duoworld:fire")) return;
      try {
        let r = inst.playAction("duoworld:fire");
        r && typeof r.catch == "function" && r.catch(() => {});
      } catch {}
    },
    push,
    kill() {
      alive && ((alive = !1), (deadFor = 0));
    },
    // back to life somewhere new; hidden until their first snapshot arrives there
    spawn(shieldSeconds = 0) {
      ((alive = !0), (present = !1), (buffer.length = 0), (deadFor = 0), (crouch = 0), (shieldLeft = shieldSeconds));
      root.rotation.x = 0;
    },
    reset() {
      ((alive = !0), (present = !1), (buffer.length = 0), (deadFor = 0), (shieldLeft = 0), (root.visible = !1));
    },
    dispose() {
      if (disposed) return;
      ((disposed = !0), buildToken++);
      entry && (avatars.releaseInstance(entry), (entry = null));
      let i = context.frameHooks.indexOf(frame);
      i >= 0 && context.frameHooks.splice(i, 1);
      let j = context.shotTargets ? context.shotTargets.indexOf(target) : -1;
      j >= 0 && context.shotTargets.splice(j, 1);
      context.scene.remove(root);
    },
  };
}

export { createOpponent, rayCapsule, raySphere, OPPONENT };
