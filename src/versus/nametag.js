// Name tags over remote players that do not give their position away.
//
// A tag is drawn only when the player's head can actually be seen from the camera: it must be in
// front of the camera, inside the view, closer than NAMETAG.maxDistance, and the physics ray from
// the camera to the head must not hit a wall, container or crane leg (the same world raycast the
// bullets use). Far tags fade out. The line-of-sight test is re-run every few frames per tag, so
// a tag can never shine through cover the way an always-on-top label does.
import { Vector3 } from "../vendor/three-r180.js";

var NAMETAG = {
  maxDistance: 38, // m: beyond this no tag at all
  fadeFrom: 22, // m: starts fading here
  checkEvery: 3, // frames between line-of-sight checks
};

var _v = new Vector3();

// tag: a DOM element positioned absolutely inside `host`. Returns a small updater.
function createNameTag(context, host, tag) {
  let seen = !1,
    frame = 0;
  return {
    // head: world position just above the head; alive: whether to show at all
    update(head, alive) {
      let cam = context.camera;
      if (!alive || !cam || !head) return void ((seen = !1), tag.classList.remove("on"));
      let dist = cam.position.distanceTo(head);
      if (dist > NAMETAG.maxDistance) return void ((seen = !1), tag.classList.remove("on"));
      _v.copy(head).project(cam);
      let onScreen = _v.z > -1 && _v.z < 1 && Math.abs(_v.x) < 1.05 && Math.abs(_v.y) < 1.05;
      if (!onScreen) return void tag.classList.remove("on");
      if (frame-- <= 0) {
        frame = NAMETAG.checkEvery;
        try {
          // aim a little below the tag anchor: the head itself
          let target = head.clone();
          target.y -= 0.35;
          seen = context.physics ? context.physics.lineOfSight(cam.position, target) : !0;
        } catch {
          seen = !1;
        }
      }
      if (!seen) return void tag.classList.remove("on");
      let w = host ? host.clientWidth || innerWidth : innerWidth,
        h = host ? host.clientHeight || innerHeight : innerHeight,
        k = dist <= NAMETAG.fadeFrom ? 1 : 1 - (dist - NAMETAG.fadeFrom) / (NAMETAG.maxDistance - NAMETAG.fadeFrom);
      tag.classList.add("on");
      tag.style.opacity = k.toFixed(2);
      tag.style.transform = `translate(${((_v.x + 1) / 2) * w}px, ${((1 - _v.y) / 2) * h}px) translate(-50%, -100%)`;
    },
    get visible() {
      return tag.classList.contains("on");
    },
    hide() {
      ((seen = !1), (frame = 0), tag.classList.remove("on"));
    },
  };
}

export { createNameTag, NAMETAG };
