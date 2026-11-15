// Player movement, camera, health, recoil and regeneration.
import { Euler, Vector3 } from "../vendor/three-r180.js";
import { PLAYER_DIMENSIONS, WORLD_BOUNDS } from "../core/config.js";
import { clamp, damp, lerp, saturate, smoothstep } from "../core/math.js";

var PLAYER_MOVEMENT = {
  walk: 3.8,
  sprint: 6.4,
  crouch: 1.9,
  ads: 2.4,
  accelGround: 34,
  decelGround: 26,
  accelAir: 9,
  gravity: 21,
  jumpApex: 1,
  coyote: 0.12,
  jumpBuffer: 0.13,
  standHeight: PLAYER_DIMENSIONS.height,
  crouchHeight: 1.15,
  eyeRate: 11,
  stride: {
    walk: 1.55,
    sprint: 2.1,
    crouch: 1.05,
  },
  bobY: 0.024,
  bobX: 0.013,
  bobSprint: 1.9,
  bobAds: 0.22,
  rollStrafe: 0.02,
  landDip: 0.36,
  landDipMax: 0.2,
  fovSprint: 6,
  fovAds: 52,
  adsLook: 0.6,
  regenDelay: 4,
  regenRate: 25,
  recoilKeep: 0.35,
  recoilApply: 34,
  recoilRecover: 6.5,
  recoilHold: 0.09,
  shakeDecay: 1.7,
  shakePitch: 0.03,
  shakeYaw: 0.03,
  shakeRoll: 0.045,
  pitchLimit: 1.5,
  // climbing / mantling (see findLedge): rise limits are measured from the feet
  climbGroundMin: 0.62,
  climbGroundMax: 1.65,
  climbAirMin: 0.45,
  climbAirMax: 2.25,
  climbReach: 0.75,
  climbBaseTime: 0.28,
  climbTimePerMeter: 0.22,
  climbLiftShare: 0.65,
  climbCooldown: 0.25,
  climbExitSpeed: 1.4,
  // ladders (physics.ladders): E, or W + Space, near one grabs it; W/S climb, Space jumps off
  ladderSpeed: 2.3,
  ladderReach: 1.35,
  ladderStandOff: 0.36,
  ladderMountTime: 0.22,
  ladderTopMountTime: 0.42,
  ladderTopReach: 1,
  ladderExitRise: 1,
  ladderJumpOff: 3.2,
  ladderJumpUp: 3.4,
  ladderStepEvery: 0.6,
};

var JUMP_SPEED = Math.sqrt(
  2 * PLAYER_MOVEMENT.gravity * PLAYER_MOVEMENT.jumpApex,
);

function createPlayer(context) {
  let e = context.camera,
    t = () => (context.render && context.render.post) || n,
    n = {},
    s = PLAYER_DIMENSIONS.eye,
    o = PLAYER_MOVEMENT.standHeight,
    r = 0,
    a = 0,
    l = !0,
    c = 0,
    u = 0,
    h = 0,
    f = 0,
    p = 0,
    d = 0,
    v = 0,
    g = {
      x: 0,
      v: 0,
    },
    x = 0,
    y = 0,
    b = 0,
    m = 0,
    A = 0,
    _ = 0,
    M = 0,
    E = 99,
    w = 0,
    S = 0,
    z = 0,
    H = PLAYER_DIMENSIONS.fov,
    O = 0,
    q = "concrete",
    cl = null,
    clCd = 0,
    clFrom = new Vector3(),
    clTo = new Vector3(),
    ld = null,
    U = new Vector3(),
    T = new Euler(0, 0, 0, "YXZ"),
    D = new Vector3(),
    C = {
      pos: new Vector3(),
      eye: new Vector3(),
      vel: new Vector3(),
      forward: new Vector3(0, 0, -1),
      yaw: 0,
      pitch: 0,
      health: 100,
      maxHealth: 100,
      alive: !0,
      onGround: !0,
      sprinting: !1,
      crouching: !1,
      climbing: !1,
      climbProgress: 0,
      // what a body needs to animate a climb (AvatarHost / net): null when not climbing
      climb: null,
      onLadder: null,
      ads: 0,
      speed: 0,
      enabled: !0,
      invulnerable: !1,
      baseFov: PLAYER_DIMENSIONS.fov,
      hurtPulse: 0,
      lookScale: 1,
      lastSafe: D,
      tuning: PLAYER_MOVEMENT,
      reset(F) {
        let X = F ||
          (context.level && context.level.playerStart) || {
            pos: new Vector3(),
            yaw: 0,
          };
        (C.pos.copy(X.pos),
          (C.yaw = X.yaw || 0),
          (C.pitch = 0),
          C.vel.set(0, 0, 0),
          (C.health = C.maxHealth),
          (C.alive = !0),
          (C.onGround = !0),
          (C.sprinting = !1),
          (C.crouching = !1),
          (C.climbing = !1),
          (C.climb = null),
          (C.climbProgress = 0),
          (cl = null),
          (clCd = 0),
          (ld = null),
          (C.onLadder = null),
          (C.invulnerable = !1),
          (C.speed = 0),
          (s = PLAYER_DIMENSIONS.eye),
          (o = PLAYER_MOVEMENT.standHeight),
          (r = 0),
          (a = 0),
          (l = !0),
          (c = 0),
          (u = 0),
          (h = 0),
          (f = 0),
          (p = d = 0),
          (v = 0),
          (g.x = g.v = 0),
          (x = y = b = m = 0),
          (A = 0),
          (_ = 0),
          (E = 99),
          (w = 0),
          (S = 0),
          (z = 0),
          (C.hurtPulse = 0),
          D.copy(C.pos));
        let ne = t();
        ((ne.damage = 0), (ne.lowHealth = 0), (ne.ads = 0), K(0));
      },
      // optional: (amount, fromPos) => false to stop local damage (1v1 mode forwards it to the
      // match server, which owns health there)
      damageFilter: null,
      damage(F, X) {
        if (C.damageFilter && C.alive && F > 0 && C.damageFilter(F, X) === !1) return;
        !C.alive ||
          C.invulnerable ||
          !(F > 0) ||
          ((C.health = Math.max(0, C.health - F)),
          (E = 0),
          (w = Math.min(1, w + 0.35 + F / 40)),
          C.addShake(0.22 + F / 70),
          context.events.emit("player:hit", {
            amount: F,
            fromPos: X,
          }),
          C.health <= 0 &&
            ((C.alive = !1),
            (cl = null),
            ld && ((ld = null), (C.onLadder = null)),
            (C.climbing = !1),
            (C.climb = null),
            (z = 0),
            (C.sprinting = !1),
            context.events.emit("player:dead", {})));
      },
      heal(F) {
        C.alive && (C.health = Math.min(C.maxHealth, C.health + F));
      },
      addRecoil(F = 0, X = 0) {
        let ne = PLAYER_MOVEMENT.recoilKeep;
        ((C.pitch = clamp(
          C.pitch + F * ne,
          -PLAYER_MOVEMENT.pitchLimit,
          PLAYER_MOVEMENT.pitchLimit,
        )),
          (C.yaw += X * ne),
          (x += F * (1 - ne)),
          (y += X * (1 - ne)),
          (x = clamp(x, -0.3, 0.3)),
          (y = clamp(y, -0.2, 0.2)),
          (A = PLAYER_MOVEMENT.recoilHold));
      },
      addShake(F = 0.3) {
        _ = Math.min(1, _ + F);
      },
      setFov(F) {
        C.baseFov = clamp(+F || PLAYER_DIMENSIONS.fov, 55, 100);
      },
      update: N,
    };
  context.events.on("explosion", (F) => {
    if (!F || !F.pos) return;
    let X = C.eye.distanceTo(F.pos),
      ne = F.size || 1,
      re = saturate(1 - X / (14 + ne * 10)) * (0.35 + 0.35 * ne);
    re > 0.01 && C.addShake(re);
  });
  function G() {
    let F = context.physics && context.physics.boxes;
    if (!F) return !0;
    let X = PLAYER_DIMENSIONS.radius * 0.9,
      ne = C.pos.y + PLAYER_MOVEMENT.crouchHeight - 0.05,
      re = C.pos.y + PLAYER_MOVEMENT.standHeight;
    for (let $ = 0; $ < F.length; $++) {
      let ue = F[$];
      if (
        !ue.bulletOnly &&
        !(
          C.pos.x + X < ue.min.x ||
          C.pos.x - X > ue.max.x ||
          C.pos.z + X < ue.min.z ||
          C.pos.z - X > ue.max.z
        ) &&
        ue.min.y < re &&
        ue.max.y > ne
      )
        return !1;
    }
    return !0;
  }
  // true when no solid (non bullet-only) box overlaps the vertical column [y0, y1] of radius r
  function columnClear(x, z, y0, y1, r) {
    let F = context.physics && context.physics.boxes;
    if (!F) return !1;
    for (let i = 0; i < F.length; i++) {
      let b = F[i];
      if (
        !b.bulletOnly &&
        x + r > b.min.x &&
        x - r < b.max.x &&
        z + r > b.min.z &&
        z - r < b.max.z &&
        b.min.y < y1 &&
        b.max.y > y0
      )
        return !1;
    }
    return !0;
  }
  // Looks for a flat ledge in front of the player whose top is minRise..maxRise above the feet,
  // with room to stand (or crouch) on it and a clear path straight up to it.
  // Returns { x, y, z, rise, crouch } or null. Uses only the World's collision boxes.
  function findLedge(minRise, maxRise) {
    let ph = context.physics;
    if (!ph || !ph.groundHeight) return null;
    let fx = -Math.sin(C.yaw),
      fz = -Math.cos(C.yaw),
      R = PLAYER_DIMENSIONS.radius,
      base = C.pos.y,
      top = base + maxRise;
    for (let d = R * 0.6; d <= R + PLAYER_MOVEMENT.climbReach + 1e-6; d += 0.1) {
      let h = ph.groundHeight(C.pos.x + fx * d, C.pos.z + fz * d, top),
        rise = h - base;
      if (rise < minRise) continue;
      let ld = d + R + 0.06,
        x = C.pos.x + fx * ld,
        z = C.pos.z + fz * ld,
        hl = ph.groundHeight(x, z, top),
        hf = ph.groundHeight(x + fx * 0.25, z + fz * 0.25, top);
      if (Math.abs(hl - h) > 0.1 || Math.abs(hf - h) > 0.25) return null;
      let I = ph.bounds;
      if (
        I &&
        (x < I.min.x + 0.4 || x > I.max.x - 0.4 || z < I.min.z + 0.4 || z > I.max.z - 0.4)
      )
        return null;
      // room to rise in place, then to slide over the lip at crouch height
      if (!columnClear(C.pos.x, C.pos.z, base + 0.3, h + PLAYER_MOVEMENT.crouchHeight, R * 0.9))
        return null;
      let mx = (C.pos.x + x) / 2,
        mz = (C.pos.z + z) / 2;
      if (!columnClear(mx, mz, h + 0.02, h + PLAYER_MOVEMENT.crouchHeight, R * 0.9)) return null;
      let stand = columnClear(x, z, h + 0.02, h + PLAYER_MOVEMENT.standHeight, R * 0.95);
      if (!stand && !columnClear(x, z, h + 0.02, h + PLAYER_MOVEMENT.crouchHeight, R * 0.95))
        return null;
      return { x, y: hl, z, rise: hl - base, crouch: !stand };
    }
    return null;
  }
  function startClimb(L) {
    (clFrom.copy(C.pos),
      clTo.set(L.x, L.y, L.z),
      (cl = {
        t: 0,
        dur: PLAYER_MOVEMENT.climbBaseTime + L.rise * PLAYER_MOVEMENT.climbTimePerMeter,
        rise: L.rise,
        crouch: L.crouch,
      }),
      (C.climbing = !0),
      (C.climbProgress = 0),
      (C.climb = { kind: "mantle", progress: 0, ledgeHeight: L.rise, ledgeDistance: Math.max(0, Math.hypot(L.x - C.pos.x, L.z - C.pos.z) - PLAYER_DIMENSIONS.radius - 0.06), climbSpeed: 0, crouchEnd: !!L.crouch }),
      (C.sprinting = !1),
      (C.onGround = !1),
      (a = 0),
      (r = 0),
      C.vel.set(0, 0, 0),
      context.events.emit("player:climb", {
        phase: "start",
        height: L.rise,
        pos: C.pos,
      }));
  }
  function climbStep(F) {
    cl.t += F;
    let k = Math.min(1, cl.t / cl.dur),
      s1 = PLAYER_MOVEMENT.climbLiftShare,
      px = C.pos.x,
      py = C.pos.y,
      pz = C.pos.z;
    if (k < s1) {
      let e1 = smoothstep(0, 1, k / s1);
      C.pos.set(clFrom.x, lerp(clFrom.y, clTo.y + 0.03, e1), clFrom.z);
    } else {
      let e2 = smoothstep(0, 1, (k - s1) / (1 - s1));
      C.pos.set(lerp(clFrom.x, clTo.x, e2), clTo.y + 0.03 * (1 - e2), lerp(clFrom.z, clTo.z, e2));
    }
    F > 0 && C.vel.set((C.pos.x - px) / F, (C.pos.y - py) / F, (C.pos.z - pz) / F);
    ((C.climbProgress = k), (C.speed = Math.hypot(C.vel.x, C.vel.z)));
    C.climb && ((C.climb.progress = k), (C.climb.ledgeHeight = clTo.y - C.pos.y), (C.climb.ledgeDistance = Math.max(0, Math.hypot(clTo.x - C.pos.x, clTo.z - C.pos.z) - PLAYER_DIMENSIONS.radius - 0.06)), (C.climb.climbSpeed = C.vel.y));
    ((f = damp(f, 0, 10, F)), (p *= 0.9), (d *= 0.9));
    if (k >= 1) {
      let fx = -Math.sin(C.yaw),
        fz = -Math.cos(C.yaw);
      (C.pos.copy(clTo),
        C.vel.set(fx * PLAYER_MOVEMENT.climbExitSpeed, 0, fz * PLAYER_MOVEMENT.climbExitSpeed),
        (C.speed = PLAYER_MOVEMENT.climbExitSpeed),
        (C.onGround = !0),
        (l = !0),
        (c = 0),
        (u = 0),
        (r = PLAYER_MOVEMENT.coyote),
        cl.crouch && ((C.crouching = !0), (o = PLAYER_MOVEMENT.crouchHeight)),
        (C.climbing = !1),
        (C.climb = null),
        (clCd = PLAYER_MOVEMENT.climbCooldown),
        context.events.emit("player:climb", {
          phase: "end",
          height: cl.rise,
          pos: C.pos,
        }),
        (cl = null));
    }
  }
  function j() {
    let F = C.pos.x,
      X = C.pos.z;
    try {
      if (
        context.ground &&
        context.ground.isPuddle &&
        C.pos.y < 0.05 &&
        context.ground.isPuddle(F, X)
      )
        return "water";
    } catch {}
    if (q && q !== "concrete") return q;
    try {
      return (
        (context.level &&
          context.level.groundSurfaceAt &&
          context.level.groundSurfaceAt(F, X)) ||
        q ||
        "concrete"
      );
    } catch {
      return q || "concrete";
    }
  }
  function N(F) {
    let X = context.input,
      ne = context.weapon || {};
    if (
      (ne.stub || typeof ne.ads != "number"
        ? ((O = damp(O, C.enabled && X.ads ? 1 : 0, 14, F)), (C.ads = O))
        : (C.ads = saturate(ne.ads)),
      !C.alive)
    ) {
      ((z += F), Q(F), K(F), ie(F));
      return;
    }
    let re = C.enabled;
    ((C.lookScale = lerp(1, PLAYER_MOVEMENT.adsLook, C.ads)),
      re &&
        ((C.yaw -= X.look.dx * C.lookScale),
        (C.pitch = clamp(
          C.pitch - X.look.dy * C.lookScale,
          -PLAYER_MOVEMENT.pitchLimit,
          PLAYER_MOVEMENT.pitchLimit,
        )),
        (C.yaw > Math.PI * 4 || C.yaw < -Math.PI * 4) &&
          (C.yaw = C.yaw % (Math.PI * 2))),
      re && X.crouch
        ? (C.crouching = !0)
        : C.crouching && G() && (C.crouching = !1),
      (o = C.crouching
        ? PLAYER_MOVEMENT.crouchHeight
        : PLAYER_MOVEMENT.standHeight));
    clCd = Math.max(0, clCd - F);
    if (cl) {
      (climbStep(F), regen(F), K(F), ie(F));
      return;
    }
    if (ld || (re && clCd <= 0 && tryLadder(X))) {
      (ld && ladderStep(F, X, re), regen(F), K(F), ie(F));
      return;
    }
    let ue = re ? X.move.x : 0,
      me = re ? X.move.y : 0,
      ee = ue * ue + me * me > 0.01,
      B =
        re &&
        X.sprint &&
        me > 0.55 &&
        Math.abs(ue) < 0.6 &&
        !C.crouching &&
        C.ads < 0.35 &&
        !X.fire;
    C.sprinting =
      (B && C.onGround && C.speed > PLAYER_MOVEMENT.walk * 0.6) ||
      (B && !C.onGround && C.sprinting);
    let P = PLAYER_MOVEMENT.walk;
    (C.crouching
      ? (P = PLAYER_MOVEMENT.crouch)
      : B && (P = PLAYER_MOVEMENT.sprint),
      (P = lerp(P, Math.min(P, PLAYER_MOVEMENT.ads), C.ads)),
      me < 0 && (P *= lerp(1, 0.82, -me)));
    let V = Math.sin(C.yaw),
      Y = Math.cos(C.yaw);
    U.set(ue * Y - me * V, 0, -ue * V - me * Y).multiplyScalar(P);
    let L = C.onGround
        ? ee
          ? PLAYER_MOVEMENT.accelGround
          : PLAYER_MOVEMENT.decelGround
        : ee
          ? PLAYER_MOVEMENT.accelAir
          : 0.6,
      Z = U.x - C.vel.x,
      J = U.z - C.vel.z;
    !C.onGround && !ee && ((Z = -C.vel.x), (J = -C.vel.z));
    let oe = Math.hypot(Z, J),
      fe = L * F;
    (oe <= fe || oe < 1e-6
      ? (C.onGround || ee) && ((C.vel.x = U.x), (C.vel.z = U.z))
      : ((C.vel.x += (Z / oe) * fe), (C.vel.z += (J / oe) * fe)),
      (r = C.onGround ? PLAYER_MOVEMENT.coyote : Math.max(0, r - F)),
      (a =
        re && X.pressed("jump")
          ? PLAYER_MOVEMENT.jumpBuffer
          : Math.max(0, a - F)),
      re && me > 0.3 && clCd <= 0 && tryClimb(X),
      !cl &&
        a > 0 &&
        r > 0 &&
        (!C.crouching || G()) &&
        ((C.vel.y = JUMP_SPEED),
        (a = 0),
        (r = 0),
        (C.onGround = !1),
        (C.crouching = !1),
        (o = PLAYER_MOVEMENT.standHeight),
        context.events.emit("player:jump", {
          pos: C.pos,
        })),
      (C.vel.y -= PLAYER_MOVEMENT.gravity * F * 0.5),
      C.vel.y < -40 && (C.vel.y = -40));
    if (cl) {
      (regen(F), K(F), ie(F));
      return;
    }
    let le = C.vel.y,
      R =
        context.physics.moveCapsule(
          C.pos,
          C.vel,
          F,
          PLAYER_DIMENSIONS.radius,
          o,
          l,
        ) || {};
    R.onGround || (C.vel.y -= PLAYER_MOVEMENT.gravity * F * 0.5);
    let I = context.physics.bounds;
    if (
      (I &&
        ((C.pos.x = clamp(C.pos.x, I.min.x + 0.4, I.max.x - 0.4)),
        (C.pos.z = clamp(C.pos.z, I.min.z + 0.4, I.max.z - 0.4))),
      (C.onGround = !!R.onGround),
      R.surface && (q = R.surface),
      C.onGround)
    ) {
      if (!l && c > 0.12) {
        let ce = Math.max(0, -le, u);
        ((g.v -= Math.min(ce * PLAYER_MOVEMENT.landDip, 3.2)),
          ce > 7.5 && C.addShake(Math.min(0.5, (ce - 7.5) * 0.06)),
          context.events.emit("player:land", {
            speed: ce,
            surface: j(),
            pos: C.pos,
          }),
          ce > 13 && C.damage((ce - 13) * 7, null),
          (h = 0.35));
      }
      ((c = 0),
        (u = 0),
        C.pos.x <= WORLD_BOUNDS.quayX - 1.2 && C.pos.y > -0.5 && D.copy(C.pos));
    } else ((c += F), (u = Math.max(u, -C.vel.y)));
    ((l = C.onGround),
      C.pos.y < WORLD_BOUNDS.seaY - 2.2 &&
        (C.pos.copy(D),
        C.vel.set(0, 0, 0),
        (C.onGround = !0),
        (l = !0),
        (_ = 0.6),
        (C.yaw += Math.PI),
        C.damage(12, null),
        context.events.emit("player:rescued", {})),
      (C.speed = Math.hypot(C.vel.x, C.vel.z)));
    let se = C.crouching
      ? PLAYER_MOVEMENT.stride.crouch
      : C.sprinting
        ? PLAYER_MOVEMENT.stride.sprint
        : PLAYER_MOVEMENT.stride.walk;
    if (C.onGround && C.speed > 0.5) {
      let ce = h;
      ((h += (C.speed * F) / se),
        Math.floor(h) > Math.floor(ce) &&
          context.events.emit("player:step", {
            surface: j(),
            sprint: C.sprinting,
            pos: C.pos,
          }));
    } else C.onGround && (h = damp(h, Math.round(h), 8, F));
    let ae = C.onGround
      ? saturate(C.speed / PLAYER_MOVEMENT.walk) *
        (C.sprinting ? PLAYER_MOVEMENT.bobSprint : 1) *
        lerp(1, PLAYER_MOVEMENT.bobAds, C.ads) *
        (C.crouching ? 0.7 : 1)
      : 0;
    ((f = damp(f, ae, 9, F)),
      (d = -Math.cos(h * Math.PI * 2) * PLAYER_MOVEMENT.bobY * f),
      (p = Math.sin(h * Math.PI) * PLAYER_MOVEMENT.bobX * f));
    let k = C.vel.x * Y - C.vel.z * V;
    ((v = damp(
      v,
      (-k / PLAYER_MOVEMENT.sprint) *
        PLAYER_MOVEMENT.rollStrafe *
        lerp(1, 0.4, C.ads),
      8,
      F,
    )),
      regen(F),
      K(F),
      ie(F));
  }
  function regen(F) {
    ((E += F),
      E > PLAYER_MOVEMENT.regenDelay &&
        C.health < C.maxHealth &&
        (C.health = Math.min(
          C.maxHealth,
          C.health + PLAYER_MOVEMENT.regenRate * F,
        )));
  }
  // Ground: jump + forward next to a waist-to-head-high ledge mantles instead of jumping.
  // Air: holding jump + forward while touching a ledge grabs it.
  function tryClimb(X) {
    let L = null;
    C.onGround || r > 0
      ? a > 0 &&
        (L = findLedge(PLAYER_MOVEMENT.climbGroundMin, PLAYER_MOVEMENT.climbGroundMax))
      : X.down("jump") &&
        C.vel.y < JUMP_SPEED * 0.85 &&
        (L = findLedge(PLAYER_MOVEMENT.climbAirMin, PLAYER_MOVEMENT.climbAirMax));
    L && startClimb(L);
  }
  // --- ladders --------------------------------------------------------------------------
  // A ladder is a rung line (x, z) climbed while facing `facing`; the climber hangs
  // ladderStandOff behind it. Mount from below/beside (E, or W + Space) or from the top exit
  // (E, or walking back into the opening). Gravity and collision are off while attached.
  function findLadder(walkIn) {
    let ph = context.physics,
      Ls = ph && ph.ladders;
    if (!Ls || !Ls.length) return null;
    let fx = -Math.sin(C.yaw),
      fz = -Math.cos(C.yaw),
      best = null,
      bd = 1 / 0;
    for (let L of Ls) {
      let dx = C.pos.x - L.x,
        dz = C.pos.z - L.z,
        dist = Math.hypot(dx, dz),
        along = dx * L.facing[0] + dz * L.facing[1],
        lat = dz * L.facing[0] - dx * L.facing[1],
        face = fx * L.facing[0] + fz * L.facing[1];
      if (
        C.pos.y >= L.bottom - 0.5 &&
        C.pos.y <= L.top - PLAYER_MOVEMENT.ladderExitRise - 0.05 &&
        along < 0.05 &&
        dist <= PLAYER_MOVEMENT.ladderReach &&
        (dist < 0.55 || (-fx * dx - fz * dz) / dist > 0.35 || face > 0.5) &&
        dist < bd
      ) {
        ((best = { L, top: !1, walk: !1 }), (bd = dist));
        continue;
      }
      if (L.exit && Math.abs(C.pos.y - L.top) < 0.45 && along > 0) {
        let de = Math.hypot(C.pos.x - L.exit.x, C.pos.z - L.exit.z);
        de <= PLAYER_MOVEMENT.ladderTopReach &&
          face < -0.3 &&
          de < bd &&
          ((best = {
            L,
            top: !0,
            walk: walkIn && face < -0.6 && along < 0.55 && Math.abs(lat) < 0.3,
          }),
          (bd = de));
      }
    }
    return best;
  }
  function tryLadder(X) {
    let fwd = X.move.y > 0.3,
      useE = X.pressed("interact"),
      useJ = fwd && X.pressed("jump");
    if (!useE && !useJ && !fwd) return !1;
    let hit = findLadder(fwd);
    if (!hit || !(useE || (hit.top ? hit.walk : useJ))) return !1;
    attachLadder(hit.L, hit.top);
    return !0;
  }
  function attachLadder(L, fromTop) {
    let ph = context.physics,
      M = PLAYER_MOVEMENT,
      sx = L.x - L.facing[0] * M.ladderStandOff,
      sz = L.z - L.facing[1] * M.ladderStandOff,
      floor = Math.max(L.bottom, ph.groundHeight(sx, sz, L.top - 0.3)),
      hi = L.top - M.ladderExitRise - 0.1,
      y = fromTop ? hi - 0.05 : clamp(C.pos.y, floor, hi),
      fy = Math.atan2(-L.facing[0], -L.facing[1]),
      dy = Math.atan2(Math.sin(fy - C.yaw), Math.cos(fy - C.yaw));
    ((ld = {
      L,
      t: 0,
      dur: fromTop ? M.ladderTopMountTime : M.ladderMountTime,
      from: C.pos.clone(),
      to: new Vector3(sx, y, sz),
      floor,
      yaw0: C.yaw,
      // turn to face the rungs when stepping on from the top (from below the player is
      // already looking at them)
      dyaw: fromTop ? dy : 0,
      acc: 0,
    }),
      (C.climbing = !0),
      (C.climbProgress = 0),
      (C.climb = { kind: "ladder", progress: 0, ledgeHeight: 0, ledgeDistance: 0, climbSpeed: 0, crouchEnd: !1 }),
      (C.onLadder = L.id),
      (C.sprinting = !1),
      (C.crouching = !1),
      (o = M.standHeight),
      (C.onGround = !1),
      (a = 0),
      (r = 0),
      C.vel.set(0, 0, 0),
      (C.speed = 0),
      context.events.emit("player:ladder", {
        on: !0,
        id: L.id,
        from: fromTop ? "top" : "bottom",
        pos: C.pos,
      }));
  }
  function detachLadder(how) {
    let L = ld && ld.L;
    ((ld = null),
      (C.onLadder = null),
      (C.climbing = !1),
      (C.climb = null),
      (clCd = PLAYER_MOVEMENT.climbCooldown),
      (c = 0),
      (u = 0),
      context.events.emit("player:ladder", {
        on: !1,
        id: L && L.id,
        how,
        pos: C.pos,
      }));
  }
  function ladderStep(F, X, re) {
    let L = ld.L,
      M = PLAYER_MOVEMENT;
    ((C.crouching = !1),
      (o = M.standHeight),
      (C.onGround = !1),
      (C.sprinting = !1),
      (f = damp(f, 0, 10, F)),
      (p *= 0.9),
      (d *= 0.9));
    if (ld.t < ld.dur) {
      ld.t += F;
      let k = smoothstep(0, 1, Math.min(1, ld.t / ld.dur));
      (C.pos.lerpVectors(ld.from, ld.to, k),
        ld.dyaw && (C.yaw = ld.yaw0 + ld.dyaw * k),
        C.vel.set(0, 0, 0),
        (C.speed = 0),
        C.climb && ((C.climb.progress = k), (C.climb.climbSpeed = 0)));
      return;
    }
    if (re && X.pressed("jump")) {
      (detachLadder("jump"),
        C.vel.set(-L.facing[0] * M.ladderJumpOff, M.ladderJumpUp, -L.facing[1] * M.ladderJumpOff),
        (l = !1),
        context.events.emit("player:jump", { pos: C.pos }));
      return;
    }
    if (re && X.pressed("interact")) {
      (detachLadder("drop"), C.vel.set(0, 0, 0), (l = !1));
      return;
    }
    // forward climbs; looking well down turns forward into down (so W from the top descends)
    let me = re ? X.move.y : 0,
      vy = (C.pitch < -0.6 ? -me : me) * M.ladderSpeed;
    ((C.pos.x = ld.to.x), (C.pos.z = ld.to.z), (C.pos.y += vy * F));
    ((ld.acc += Math.abs(vy) * F),
      ld.acc >= M.ladderStepEvery &&
        ((ld.acc -= M.ladderStepEvery),
        context.events.emit("player:step", {
          surface: "metal",
          sprint: !1,
          pos: C.pos,
        })));
    C.climbProgress = saturate((C.pos.y - L.bottom) / Math.max(0.1, L.top - L.bottom));
    C.climb && ((C.climb.progress = 1), (C.climb.climbSpeed = vy));
    if (vy > 0 && L.exit && C.pos.y >= L.top - M.ladderExitRise) {
      // over the top: hand over to the mantle onto the landing
      (detachLadder("top"),
        (clCd = 0),
        startClimb({
          x: L.exit.x,
          y: L.exit.y,
          z: L.exit.z,
          rise: L.exit.y - C.pos.y,
          crouch: !1,
        }));
      return;
    }
    L.exit || (C.pos.y = Math.min(C.pos.y, L.top - M.ladderExitRise));
    if (vy < 0 && C.pos.y <= ld.floor) {
      ((C.pos.y = ld.floor),
        detachLadder("bottom"),
        C.vel.set(0, 0, 0),
        (C.onGround = !0),
        (l = !0),
        (r = M.coyote));
      return;
    }
    (C.vel.set(0, vy, 0), (C.speed = 0));
  }
  function Q(F) {
    ((C.vel.x = damp(C.vel.x, 0, 5, F)),
      (C.vel.z = damp(C.vel.z, 0, 5, F)),
      (C.vel.y -= PLAYER_MOVEMENT.gravity * F));
    try {
      let X = context.physics.moveCapsule(
        C.pos,
        C.vel,
        F,
        PLAYER_DIMENSIONS.radius,
        0.6,
        l,
      );
      l = !!(X && X.onGround);
    } catch {}
    (C.pos.y < WORLD_BOUNDS.seaY - 1 &&
      ((C.pos.y = WORLD_BOUNDS.seaY - 1), (C.vel.y = 0)),
      (C.speed = 0),
      (C.sprinting = !1),
      (f = damp(f, 0, 10, F)),
      (p *= 0.9),
      (d *= 0.9));
  }
  function K(F) {
    let X = C.crouching ? PLAYER_DIMENSIONS.crouchEye : PLAYER_DIMENSIONS.eye,
      ne = 0,
      re = 0;
    if (C.alive) F > 0 ? (s = damp(s, X, PLAYER_MOVEMENT.eyeRate, F)) : (s = X);
    else {
      let Z = smoothstep(0, 0.85, z),
        J = Z * Z;
      ((X = lerp(PLAYER_DIMENSIONS.eye, 0.22, J)),
        (s = damp(s, X, 18, F)),
        (ne = 1.15 * J),
        (re = -0.25 * Z + 0.12 * Math.sin(Z * Math.PI)));
    }
    if (F > 0) {
      let Z = -g.x * 150 - g.v * 17;
      ((g.v += Z * F),
        (g.x += g.v * F),
        (g.x = clamp(g.x, -PLAYER_MOVEMENT.landDipMax, 0.05)),
        (A -= F),
        A <= 0 &&
          ((x = damp(x, 0, PLAYER_MOVEMENT.recoilRecover, F)),
          (y = damp(y, 0, PLAYER_MOVEMENT.recoilRecover, F))),
        (b = damp(b, x, PLAYER_MOVEMENT.recoilApply, F)),
        (m = damp(m, y, PLAYER_MOVEMENT.recoilApply, F)),
        (_ = Math.max(0, _ - PLAYER_MOVEMENT.shakeDecay * F)),
        (M += F));
    }
    let $ = Math.sin(C.yaw),
      ue = Math.cos(C.yaw);
    C.eye.set(C.pos.x + p * ue, C.pos.y + s + d + g.x, C.pos.z - p * $);
    let me = clamp(C.pitch + b, -1.55, 1.55),
      ee = C.yaw + m;
    (T.set(me, ee, 0, "YXZ"), C.forward.set(0, 0, -1).applyEuler(T));
    let B = _ * _,
      P = M,
      V =
        B *
        PLAYER_MOVEMENT.shakePitch *
        (Math.sin(P * 43.1) + 0.6 * Math.sin(P * 71.7 + 1.3)),
      Y =
        B *
        PLAYER_MOVEMENT.shakeYaw *
        (Math.sin(P * 37.3 + 2.1) + 0.6 * Math.sin(P * 83.9)),
      L =
        B *
        PLAYER_MOVEMENT.shakeRoll *
        (Math.sin(P * 29.7 + 0.7) + 0.5 * Math.sin(P * 61.3 + 4));
    if (
      (e.position.copy(C.eye),
      e.rotation.set(
        me + V + re + g.x * 0.12,
        ee + Y,
        v + L + ne + p * 0.35,
        "YXZ",
      ),
      !context.params || !context.params.fov)
    ) {
      let Z = lerp(
        C.baseFov + (C.sprinting ? PLAYER_MOVEMENT.fovSprint : 0),
        PLAYER_MOVEMENT.fovAds,
        C.ads,
      );
      ((H = F > 0 ? damp(H, Z, C.ads > 0.02 && C.ads < 0.98 ? 30 : 7, F) : Z),
        Math.abs(e.fov - H) > 0.01 &&
          ((e.fov = H), e.updateProjectionMatrix()));
    }
  }
  function ie(F) {
    ((w = Math.max(0, w - F * 1.9)), (C.hurtPulse = w));
    let X = C.alive ? smoothstep(0.55, 0.12, C.health / C.maxHealth) : 1;
    S = damp(S, X, 4, F);
    let ne = t();
    ((ne.damage = w), (ne.lowHealth = S), (ne.ads = C.ads));
  }
  return C;
}

export { createPlayer, PLAYER_MOVEMENT, JUMP_SPEED };
