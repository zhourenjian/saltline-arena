// The PAC-9 as other people see it: the same geometry and materials as the first-person view
// model, put into an avatar's hands by the World. Avatars do not bring their own gun.
//
// Held-item protocol (optional, Avatar 1.1 extension):
//   anchor "weapon"      Object3D owned and moved by the avatar. Origin = where the dominant hand
//                        holds the grip, +Z along the barrel, +Y up. The World parents its gun here.
//   anchor "weaponStow"  optional; where the gun hangs while the avatar's hands are busy (climbing).
//   setLocomotion().held { kind: "rifle", grip, support, action }
//                        grip / support = grasp frames in the weapon anchor's space:
//                        { position [x,y,z], quaternion [x,y,z,w], radius } with the origin at the
//                        centre of the bar being held, +Y along the bar towards the thumb and +Z
//                        along the fingers. grip is for the right hand, support for the left
//                        (null = let go). action: null | "reload" | "inspect" (a hint, e.g. to look
//                        down at the gun). No "held" = empty hands.
import { Euler, Group, Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from "../vendor/three-r180.js";
import { mi, w_ } from "./geometry.js";

const RELOAD_SECONDS = 2.1,
  RELOAD_EMPTY_SECONDS = 2.72,
  INSPECT_SECONDS = 3.5;
const ACTION_NONE = 0,
  ACTION_RELOAD = 1,
  ACTION_INSPECT = 2;

// gun coordinates (-Z forward) -> held coordinates (+Z forward, grip centre at the origin)
const toHeld = (p) => [-p[0], p[1] - mi.grip[1], mi.grip[2] - p[2]];
const HELD_MUZZLE = toHeld(mi.muzzle);

const sstep = (a, b, x) => ((x = Math.max(0, Math.min(1, (x - a) / (b - a)))), x * x * (3 - 2 * x));
const frame = (x, y, z) => new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
// grasp frames, in held coordinates
const GRIP = { p: new Vector3(0, 0.02, 0.002), q: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3), r: 0.02 };
// left hand round the vertical foregrip, the way the first-person view holds it: palm on the left
// of the grip, thumb up, knuckles forward and a little up so the forearm comes in from below
const FOREGRIP = toHeld([0, -0.064, -0.256]);
const GUARD = (() => {
  let x = new Vector3(1, 0, 0),
    y = new Vector3(0, Math.cos(0.3), -Math.sin(0.3)),
    z = new Vector3().crossVectors(x, y);
  return { p: new Vector3(...FOREGRIP), q: frame(x, y, z), r: 0.015 };
})();
const MAG = (() => {
  // left hand round the magazine from the left: thumb up, fingers round the front
  let y = new Vector3(0, 0.97, 0.24).normalize(),
    x = new Vector3(1, 0, 0),
    z = new Vector3().crossVectors(x, y);
  return { p: new Vector3(...toHeld([0, -0.15, -0.085])), q: frame(x, y, z), r: 0.016 };
})();
// charging handle on the left of the receiver: the hand comes in from the left, thumb up, and
// hooks it with the fingers
const HANDLE = { p: new Vector3(...toHeld(mi.handlePos)).add(new Vector3(0.014, -0.01, 0.01)), q: new Quaternion(), r: 0.008 };
// where the spare magazines are, in the anchor's space (left side of the belt)
const BELT = { p: new Vector3(0.2, -0.36, -0.1), q: frame(new Vector3(0.9, 0, -0.44).normalize(), new Vector3(0, 1, 0), new Vector3(0.44, 0, 0.9).normalize()), r: 0.016 };

// support-hand tracks: [time, key, rig-relative?]
const TRACK = [
  [0, "guard"],
  [0.1, "guard"],
  [0.36, "mag"],
  [0.47, "mag"],
  [0.8, "belt"],
  [0.98, "belt"],
  [1.28, "low"],
  [1.345, "mag"],
  [1.45, "tapLow"],
  [1.52, "mag"],
  [1.62, "mag"],
  [2.02, "guard"],
];
const TRACK_EMPTY = [
  ...TRACK.slice(0, -1),
  [1.96, "handle"],
  [2.1, "back"],
  [2.19, "handle"],
  [2.3, "handle"],
  [2.66, "guard"],
];
const MAG_OUT = 0.47,
  MAG_IN = 1.345;

/**
 * The gun's motion and the two hands' grasp frames at time t of an action. Pure: the same call
 * drives the local third-person body and every remote player.
 * @param {number} action  ACTION_NONE | ACTION_RELOAD | ACTION_INSPECT
 * @param {number} t       seconds since the action started
 * @param {boolean} empty  reload from an empty magazine (adds the charging-handle pull)
 * @param {object} [out]   reused result
 */
function heldGunPose(action, t, empty, out) {
  out = out || createPose();
  let rig = out.rigQuaternion,
    rp = out.rigPosition;
  rig.identity();
  rp.set(0, 0, 0);
  out.magOffset.set(0, 0, 0);
  out.magVisible = !0;
  out.bolt = 0;
  out.action = null;
  let key = "guard",
    key2 = "guard",
    k = 0;
  if (action === ACTION_RELOAD) {
    let T = empty ? RELOAD_EMPTY_SECONDS : RELOAD_SECONDS,
      env = sstep(0, 0.3, t) * (1 - sstep(T - 0.4, T, t));
    t = Math.max(0, Math.min(T, t));
    out.action = "reload";
    // tip the muzzle up and roll the magazine well towards the support hand
    rig.setFromEuler(E.set(-0.3 * env, 0.12 * env, 0.34 * env, "YXZ"));
    rp.set(0.012 * env, -0.02 * env, -0.012 * env);
    let track = empty ? TRACK_EMPTY : TRACK,
      i = 0;
    while (i < track.length - 2 && t >= track[i + 1][0]) i++;
    key = track[i][1];
    key2 = track[i + 1][1];
    k = sstep(track[i][0], track[i + 1][0], t);
    out.magVisible = !(t > 0.74 && t < 0.86);
    out.bolt = empty ? 1 - sstep(2.1, 2.19, t) : 0;
  } else if (action === ACTION_INSPECT) {
    t = Math.max(0, Math.min(INSPECT_SECONDS, t));
    out.action = "inspect";
    // the same three beats as the first-person inspect: roll one way, then the other, muzzle raised
    let a = sstep(0, 0.5, t) * (1 - sstep(1.4, 1.9, t)),
      b = sstep(1.5, 2, t) * (1 - sstep(2.8, 3.3, t)),
      c = sstep(0, 0.5, t) * (1 - sstep(2.9, 3.4, t));
    rig.setFromEuler(E.set(-0.34 * c, 0.3 * b - 0.1 * a, 0.62 * a - 0.5 * b, "YXZ"));
    rp.set(0.03 * c, 0.02 * c, -0.03 * c);
  }
  // right hand: always on the grip, which moves with the gun
  out.grip.position.copy(GRIP.p).applyQuaternion(rig).add(rp);
  out.grip.quaternion.copy(rig).multiply(GRIP.q);
  out.grip.radius = GRIP.r;
  // left hand
  resolve(key, rig, rp, P1, Q1);
  resolve(key2, rig, rp, P2, Q2);
  out.support.position.copy(P1).lerp(P2, k);
  out.support.quaternion.copy(Q1).slerp(Q2, k);
  out.support.radius = key === "guard" && key2 === "guard" ? GUARD.r : key === "handle" || key2 === "handle" || key === "back" ? HANDLE.r : MAG.r;
  if (action === ACTION_RELOAD && t >= MAG_OUT && t < MAG_IN) {
    // the magazine travels with the hand: its offset from the seat, in gun coordinates
    resolve("mag", rig, rp, P1, Q1);
    V.copy(out.support.position).sub(P1).applyQuaternion(Q2.copy(rig).invert());
    out.magOffset.set(-V.x, V.y, -V.z);
  }
  return out;
}
const E = new Euler(),
  P1 = new Vector3(),
  P2 = new Vector3(),
  Q1 = new Quaternion(),
  Q2 = new Quaternion(),
  V = new Vector3();
function resolve(key, rig, rp, p, q) {
  if (key === "belt") return (p.copy(BELT.p), q.copy(BELT.q));
  let src = key === "guard" ? GUARD : key === "handle" || key === "back" ? HANDLE : MAG;
  p.copy(src.p);
  key === "low" && (p.y -= 0.16);
  key === "tapLow" && (p.y -= 0.035);
  key === "back" && (p.z -= mi.boltTravel);
  p.applyQuaternion(rig).add(rp);
  q.copy(rig).multiply(src.q);
}
function createPose() {
  return {
    action: null,
    rigPosition: new Vector3(),
    rigQuaternion: new Quaternion(),
    grip: { position: new Vector3(), quaternion: new Quaternion(), radius: 0.02 },
    support: { position: new Vector3(), quaternion: new Quaternion(), radius: 0.02 },
    magOffset: new Vector3(),
    magVisible: !0,
    bolt: 0,
  };
}

// Shared gun parts for one World: the first-person view model registers what it built.
const KITS = new WeakMap();
function registerGunKit(context, kit) {
  KITS.set(context, kit);
}
/** Geometry + materials of the gun for this World (the view model's own when it exists). */
function gunKit(context) {
  let kit = KITS.get(context);
  if (!kit) {
    // no view model (e.g. a tool page): plain materials on the same geometry
    let m = (color, rough, metal) => new MeshStandardMaterial({ color, roughness: rough, metalness: metal, vertexColors: !0 });
    kit = { geo: w_(), mats: { ano: m(0x1b1c1f, 0.4, 0.45), gun: m(0x232326, 0.5, 0.7), poly: m(0x1e1f21, 0.62, 0), plain: m(0xffffff, 0.92, 0), mag: m(0x5b4b36, 0.62, 0), brass: m(0xb08d4a, 0.35, 1) }, own: !0 };
    KITS.set(context, kit);
  }
  return kit;
}

/**
 * A gun to put under an avatar's "weapon" anchor.
 *   object3D          add this to the anchor
 *   held              the object to pass as setLocomotion().held
 *   setAction(a,t,e)  pose the gun, magazine, bolt and grasp frames
 *   muzzle(pos, dir)  world-space muzzle position and direction
 */
function createHeldGun(kit) {
  let root = new Group(),
    rig = new Group(),
    model = new Group(),
    mesh = (g, m) => {
      let o = new Mesh(g, m);
      o.castShadow = !0;
      o.receiveShadow = !0;
      return o;
    },
    { geo, mats } = kit;
  root.name = "DuoWorld:HeldGun";
  model.rotation.y = Math.PI;
  model.position.set(0, -mi.grip[1], mi.grip[2]);
  model.add(mesh(geo.ano, mats.ano), mesh(geo.gun, mats.gun), mesh(geo.poly, mats.poly), mesh(geo.plain, mats.plain));
  let bolt = mesh(geo.bolt, mats.gun),
    mag = new Group(),
    muzzle = new Object3D();
  mag.position.fromArray(mi.magPos);
  mag.add(mesh(geo.mag, mats.mag), mesh(geo.round, mats.brass));
  muzzle.position.fromArray(mi.muzzle);
  model.add(bolt, mag, muzzle);
  rig.add(model);
  root.add(rig);
  let pose = createPose(),
    held = { kind: "rifle", grip: frameData(), support: frameData(), action: null },
    publish = (dst, src) => {
      src.position.toArray(dst.position);
      src.quaternion.toArray(dst.quaternion);
      dst.radius = src.radius;
    },
    api = {
      object3D: root,
      held,
      pose,
      setAction(action, t, empty) {
        heldGunPose(action || ACTION_NONE, t || 0, !!empty, pose);
        rig.position.copy(pose.rigPosition);
        rig.quaternion.copy(pose.rigQuaternion);
        mag.position.fromArray(mi.magPos).add(pose.magOffset);
        mag.visible = pose.magVisible;
        bolt.position.z = mi.boltTravel * pose.bolt;
        publish(held.grip, pose.grip);
        publish(held.support, pose.support);
        held.action = pose.action;
      },
      /** Stowed (e.g. on the back while climbing): the gun at rest, nobody holding it. */
      rest() {
        api.setAction(ACTION_NONE, 0, !1);
      },
      muzzle(outPos, outDir) {
        muzzle.updateWorldMatrix(!0, !1);
        outPos.setFromMatrixPosition(muzzle.matrixWorld);
        outDir && outDir.set(0, 0, -1).transformDirection(muzzle.matrixWorld);
        return outPos;
      },
      dispose() {
        root.parent && root.parent.remove(root);
        if (kit.own) return; // geometry and materials belong to the kit
      },
    };
  api.rest();
  return api;
}
/**
 * Put this World's gun into an avatar's hands. Works only through the avatar's declared anchors
 * ("weapon", optional "weaponStow"); returns null for avatars without them.
 *   apply(state, act, stowed)  call before instance.setLocomotion(state): poses the gun for
 *                              act = { a, t, empty } and sets state.held (or removes it when the
 *                              gun is stowed, e.g. while climbing)
 *   muzzle(pos, dir)           false while the gun is not in the hands
 */
function attachHeldGun(context, instance) {
  let anchor = null,
    stow = null;
  if (!instance || typeof instance.getAnchor != "function") return null;
  try {
    anchor = instance.getAnchor("weapon");
    stow = instance.getAnchor("weaponStow");
  } catch {}
  if (!anchor || !anchor.isObject3D) return null;
  (stow && stow.isObject3D) || (stow = null);
  let gun = createHeldGun(gunKit(context)),
    root = gun.object3D,
    inHands = !1;
  return {
    gun,
    get inHands() {
      return inHands;
    },
    apply(state, act, stowed) {
      if (stowed) {
        inHands = !1;
        stow ? (root.parent !== stow && stow.add(root), (root.visible = !0)) : (root.visible = !1);
        gun.rest();
        delete state.held;
      } else {
        inHands = !0;
        root.parent !== anchor && anchor.add(root);
        root.visible = !0;
        gun.setAction(act ? act.a : ACTION_NONE, act ? act.t : 0, !!(act && act.empty));
        state.held = gun.held;
      }
      return state;
    },
    muzzle(outPos, outDir) {
      if (!inHands || !root.parent) return !1;
      gun.muzzle(outPos, outDir);
      return !0;
    },
    dispose() {
      inHands = !1;
      gun.dispose();
    },
  };
}
function frameData() {
  return { position: [0, 0, 0], quaternion: [0, 0, 0, 1], radius: 0.02 };
}

export {
  ACTION_NONE,
  ACTION_RELOAD,
  ACTION_INSPECT,
  RELOAD_SECONDS,
  RELOAD_EMPTY_SECONDS,
  INSPECT_SECONDS,
  HELD_MUZZLE,
  heldGunPose,
  createHeldGun,
  attachHeldGun,
  gunKit,
  registerGunKit,
};
