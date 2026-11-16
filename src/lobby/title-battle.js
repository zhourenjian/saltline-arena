// The title screen's background: besides the camera flying over the harbour, a few fighters run
// around in an open spot ahead of the camera and shoot at each other, so the first thing a
// visitor sees is what the game is — a brawl. They are ordinary remote-player bodies (the same
// avatars, held gun, muzzle flash, tracers and impacts as in a real match) driven by a tiny script
// instead of the network. They exist only while the title (or a title-side menu) is on screen;
// anywhere else they are hidden, and they never touch the score or the server.
//
//   ?battle=0 turns it off, ?battle=1 forces it on (it is also off for ?q=low and when the
//   visitor prefers reduced motion).
import { Vector3 } from "../vendor/three-r180.js";
import { createOpponent } from "../versus/opponent.js";

var BATTLE = {
  bots: 2,
  avatars: ["swat-operator", "masked-raider"],
  ring: 5.5, // fighters stay within this radius of the spot centre (they start ~10 m apart)
  speed: 3.3, // m/s
  hz: 20, // pose rate fed to the bodies
  respawnSeconds: 2.6,
  distances: [9, 11, 13, 16, 20, 25],
  laterals: [0, -3, 3, -6, 6, -10, 10],
};

function battleWanted() {
  try {
    let q = new URLSearchParams(location.search);
    if (q.get("battle") === "0") return !1;
    if (q.get("battle") === "1") return !0;
    if (q.get("q") === "low") return !1;
    return !(matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch {
    return !1;
  }
}

function createTitleBattle(context, avatars, random = Math.random) {
  if (!battleWanted()) return null;
  let bots = [],
    spot = null, // { x, z, y }: the centre of the open ground the fighters use
    spotClock = 0,
    spotSide = 0,
    poseClock = 0,
    shots = 0,
    kills = 0,
    wasActive = !1,
    disposed = !1,
    cam = new Vector3(),
    fwd = new Vector3(),
    a = new Vector3(),
    b = new Vector3(),
    muzzle = new Vector3(),
    barrel = new Vector3(),
    ph = () => context.physics,
    rnd = (lo, hi) => lo + random() * (hi - lo);

  function ground(x, z, y) {
    try {
      let g = ph().groundHeight(x, z, y);
      return Number.isFinite(g) ? g : null;
    } catch {
      return null;
    }
  }

  // a flat, open patch: the ground under a ring of points is level and nothing stands in the way
  function openAt(x, z, camY) {
    let g = ground(x, z, camY + 3);
    if (g == null || camY - g < 0.8 || camY - g > 10) return null;
    // never over the sea: the ground and the ring around it must all be dry
    try {
      let w = ph().raycast(a.set(x, g + 3, z), b.set(0, -1, 0), 8);
      if (!w || w.surface === "water") return null;
    } catch {
      return null;
    }
    for (let i = 0; i < 8; i++) {
      let ang = (i / 8) * Math.PI * 2,
        dx = Math.cos(ang),
        dz = Math.sin(ang),
        px = x + dx * (BATTLE.ring + 0.4),
        pz = z + dz * (BATTLE.ring + 0.4),
        gg = ground(px, pz, g + 2.5);
      if (gg == null || Math.abs(gg - g) > 0.5) return null;
      try {
        let w = ph().raycast(a.set(px, gg + 3, pz), b.set(0, -1, 0), 8);
        if (!w || w.surface === "water") return null;
        if (ph().raycast(a.set(x, g + 0.9, z), b.set(dx, 0, dz), BATTLE.ring * 0.7)) return null;
      } catch {
        return null;
      }
    }
    return g;
  }

  // can the camera see the fighters there: on screen (clear of the title text on the left of a wide
  // screen) and with nothing solid in between
  function seen(x, z, y) {
    let camera = context.camera;
    camera.getWorldPosition(cam);
    muzzle.set(x, y + 1.1, z).project(camera);
    let wide = (camera.aspect || 1) > 1;
    if (muzzle.z >= 1 || Math.abs(muzzle.y) > 0.55 || muzzle.x < (wide ? -0.15 : -0.6) || muzzle.x > (wide ? 0.6 : 0.6)) return !1;
    a.set(x, y + 1.1, z).sub(cam);
    let d = a.length();
    a.multiplyScalar(1 / d);
    try {
      return !ph().raycast(cam, a, d - BATTLE.ring - 0.5);
    } catch {
      return !1;
    }
  }

  function pickSpot() {
    let camera = context.camera;
    camera.getWorldPosition(cam);
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) return;
    fwd.normalize();
    for (let d of BATTLE.distances)
      for (let l of BATTLE.laterals) {
        let x = cam.x + fwd.x * d - fwd.z * l,
          z = cam.z + fwd.z * d + fwd.x * l,
          g = openAt(x, z, cam.y);
        if (g != null && seen(x, z, g)) return move({ x, z, y: g });
      }
  }

  function move(next) {
    let first = !spot;
    spot = next;
    for (let bot of bots) place(bot, first);
  }

  // is the current spot still a good thing to look at?
  function spotInView() {
    return !!spot && seen(spot.x, spot.z, spot.y);
  }

  function newBot(i) {
    let opp = createOpponent(context, avatars, { minDelay: 0.1 });
    opp.setAvatar(BATTLE.avatars[i % BATTLE.avatars.length]);
    return {
      opp,
      p: new Vector3(),
      v: new Vector3(),
      goal: new Vector3(),
      yaw: 0,
      hp: 100,
      hold: rnd(0, 1),
      target: null,
      retarget: 0,
      burst: 0, // shots left in the burst
      nextShot: rnd(0.4, 1.6),
      deadFor: 0,
      side: i * Math.PI + (spotSide += 0),
      placed: !1,
    };
  }

  function place(bot, instant) {
    if (!spot) return;
    // each fighter holds its own side of the spot, so they open fire from a distance
    let ang = bot.side + rnd(-0.3, 0.3),
      r = BATTLE.ring * rnd(0.7, 0.9);
    bot.p.set(spot.x + Math.cos(ang) * r, spot.y, spot.z + Math.sin(ang) * r);
    bot.goal.copy(bot.p);
    bot.v.set(0, 0, 0);
    bot.hp = 100;
    bot.deadFor = 0;
    bot.burst = 0;
    bot.nextShot = rnd(0.5, 1.8);
    bot.opp.spawn(0);
    bot.placed = !0;
    bot.sent = 0;
  }

  function aliveOthers(bot) {
    return bots.filter((o) => o !== bot && o.placed && o.hp > 0);
  }

  function fire(bot, tgt) {
    let o = bot.opp,
      eye = a.set(bot.p.x, bot.p.y + 1.35, bot.p.z),
      chest = b.set(tgt.p.x + rnd(-0.25, 0.25), tgt.p.y + rnd(0.7, 1.55), tgt.p.z + rnd(-0.25, 0.25)),
      hit = random() < 0.5;
    if (!hit) chest.add(barrel.set(rnd(-1.6, 1.6), rnd(-0.8, 0.9), rnd(-1.6, 1.6)));
    let dir = barrel.subVectors(chest, eye).normalize(),
      from = o.muzzle(muzzle, a) ? muzzle : eye.addScaledVector(dir, 0.6),
      end = chest,
      normal = a.copy(dir).negate();
    // a miss ends on whatever it hits behind; a hit ends on the body
    if (!hit) {
      try {
        let r = ph().raycast(from, dir, 60);
        r && r.point && ((end = r.point), r.normal && (normal = r.normal));
      } catch {}
    }
    let fx = context.fx;
    try {
      o.fire();
      fx && fx.tracer && fx.tracer(from.clone(), end.clone());
      fx && fx.muzzleFlash && fx.muzzleFlash(from.clone(), dir.clone(), { scale: 0.8 });
      context.render && context.render.lightPool && context.render.lightPool.flash(from.clone(), 16756832, 30, 7, 0.05);
      context.events.emit("impact", { point: end.clone(), normal: normal.clone ? normal.clone() : normal, dir: dir.clone(), surface: hit ? "enemy" : "concrete", enemy: hit ? {} : null, from: "player" });
      context.events.emit("versus:fire", { pos: from.clone() });
    } catch {}
    shots++;
    if (hit) {
      tgt.hp -= rnd(18, 34);
      if (tgt.hp <= 0) {
        tgt.opp.kill();
        tgt.deadFor = 0;
        kills++;
      }
    }
  }

  function step(bot, dt, t) {
    if (bot.hp <= 0) {
      bot.deadFor += dt;
      bot.deadFor > BATTLE.respawnSeconds && place(bot, !1);
      bot.v.set(0, 0, 0);
      return;
    }
    // wander inside the ring, in short dashes
    let toGoal = a.set(bot.goal.x - bot.p.x, 0, bot.goal.z - bot.p.z),
      dist = toGoal.length();
    if (dist < 0.25) {
      bot.v.set(0, 0, 0);
      bot.hold -= dt;
      if (bot.hold <= 0) {
        // run around on its own side of the spot, never across to the other fighter
        let ang = bot.side + rnd(-1.0, 1.0),
          r = BATTLE.ring * rnd(0.45, 0.95);
        bot.goal.set(spot.x + Math.cos(ang) * r, bot.p.y, spot.z + Math.sin(ang) * r);
        bot.hold = rnd(0, 0.25);
      }
    } else {
      bot.v.copy(toGoal.multiplyScalar(BATTLE.speed / dist));
      let nx = bot.p.x + bot.v.x * dt,
        nz = bot.p.z + bot.v.z * dt,
        g = ground(nx, nz, bot.p.y + 1.2);
      if (g != null && Math.abs(g - bot.p.y) < 0.5) {
        bot.p.set(nx, g, nz);
      } else {
        bot.v.set(0, 0, 0);
        bot.goal.copy(bot.p); // blocked: stop here
      }
    }
    // choose and face an enemy
    bot.retarget -= dt;
    if (!bot.target || bot.target.hp <= 0 || bot.retarget <= 0) {
      let others = aliveOthers(bot);
      bot.target = others.length ? others[Math.floor(random() * others.length)] : null;
      bot.retarget = rnd(2, 4.5);
    }
    let want = bot.yaw;
    if (bot.target) want = Math.atan2(-(bot.target.p.x - bot.p.x), -(bot.target.p.z - bot.p.z));
    else if (bot.v.lengthSq() > 0.01) want = Math.atan2(-bot.v.x, -bot.v.z);
    let dy = Math.atan2(Math.sin(want - bot.yaw), Math.cos(want - bot.yaw));
    bot.yaw += dy * Math.min(1, dt * 8);
    // bursts of three to five rounds
    bot.nextShot -= dt;
    if (bot.target && bot.nextShot <= 0 && Math.abs(dy) < 0.5) {
      if (bot.burst <= 0) bot.burst = 3 + Math.floor(random() * 3);
      fire(bot, bot.target);
      bot.burst--;
      bot.nextShot = bot.burst > 0 ? 0.1 : rnd(0.8, 2.2);
    }
  }

  function send(bot) {
    if (!bot.placed) return;
    let moving = Math.hypot(bot.v.x, bot.v.z);
    bot.opp.push({
      p: [bot.p.x, bot.p.y, bot.p.z],
      v: [bot.v.x, 0, bot.v.z],
      yaw: bot.yaw,
      pitch: api.pitch || 0,
      crouch: !1,
      loco: { phase: "grounded", speed: moving, mode: "duoworld:walk", ad: bot.target && (bot.burst > 0 || bot.nextShot < 0.7) ? 1 : 0 },
    });
  }

  function active() {
    let g = context.game;
    return !!g && g.state === "title" && !(g.menus && g.menus.screen === "character") && !document.hidden;
  }

  function frame(dt) {
    if (disposed) return;
    dt = Math.min(dt, 0.1);
    let on = active();
    if (!on) {
      if (wasActive) {
        for (let bot of bots) (bot.opp.reset(), (bot.placed = !1));
        spot = null;
        wasActive = !1;
      }
      return;
    }
    if (!wasActive) {
      wasActive = !0;
      spotClock = 0;
    }
    bots.length || (bots = Array.from({ length: BATTLE.bots }, (_, i) => newBot(i)));
    spotClock -= dt;
    if (spotClock <= 0) {
      spotClock = spot ? 0.3 : 0.4;
      if (!spot || !spotInView()) {
        pickSpot();
        // nowhere good in view (indoors, by the water, mid-turn): nobody fights until there is
        if (spot && !spotInView()) {
          for (let bot of bots) (bot.opp.reset(), (bot.placed = !1));
          spot = null;
        }
      }
    }
    if (!spot) return;
    for (let bot of bots) bot.placed || place(bot, !0);
    let t = context.time ? context.time.t : 0;
    for (let bot of bots) step(bot, dt, t);
    poseClock -= dt;
    if (poseClock <= 0) {
      poseClock = 1 / BATTLE.hz;
      for (let bot of bots) bot.hp > 0 && send(bot);
    }
  }

  context.frameHooks.push(frame);
  let api = {
    pitch: 0, // (tests set it to look at the aim pose at different pitches)
    bots: () => bots,
    stats: () => ({ bots: bots.length, visible: bots.filter((x) => x.opp.visible).length, alive: bots.filter((x) => x.hp > 0).length, shots, kills, spot: !!spot, at: bots.map((x) => [x.p.x, x.p.y, x.p.z]) }),
    dispose() {
      if (disposed) return;
      disposed = !0;
      let i = context.frameHooks.indexOf(frame);
      i >= 0 && context.frameHooks.splice(i, 1);
      for (let bot of bots) bot.opp.dispose();
      bots = [];
    },
  };
  return api;
}

export { createTitleBattle, BATTLE };
