// Optional over-the-shoulder view. The first-person camera in player.js stays authoritative for
// simulation (shots, muzzle, interaction all use the eye); this only moves the render camera
// after the simulation step of a frame and before effects/render. It uses the World's own
// physics raycast so the camera never sinks into containers or walls.
import { Vector3 } from "../vendor/three-r180.js";
import { clamp, damp } from "../core/math.js";

var THIRD_PERSON = {
  distance: 3.1,
  shoulder: 0.55,
  lift: 0.12,
  minDistance: 0.45,
  wallPadding: 0.22,
  pullIn: 30,
  pushOut: 4,
};

function createThirdPersonCamera(context) {
  let pivot = new Vector3(),
    back = new Vector3(),
    right = new Vector3(),
    dir = new Vector3(),
    desired = new Vector3(),
    current = THIRD_PERSON.distance,
    followHeight = 1.55;
  return {
    tuning: THIRD_PERSON,
    setFollowHeight(h) {
      followHeight = clamp(+h || 1.55, 0.6, 3.2);
    },
    get followHeight() {
      return followHeight;
    },
    reset() {
      current = THIRD_PERSON.distance;
    },
    // camera already holds the first-person pose for this frame (set by player.update)
    apply(dt) {
      let player = context.player,
        camera = context.camera;
      if (!player || !camera) return;
      let crouch = player.crouching ? 0.62 : 1;
      (pivot.set(
        player.pos.x,
        player.pos.y + followHeight * crouch,
        player.pos.z,
      ),
        back.set(0, 0, 1).applyQuaternion(camera.quaternion),
        right.set(1, 0, 0).applyQuaternion(camera.quaternion),
        desired
          .copy(pivot)
          .addScaledVector(back, THIRD_PERSON.distance)
          .addScaledVector(right, THIRD_PERSON.shoulder),
        (desired.y += THIRD_PERSON.lift),
        dir.copy(desired).sub(pivot));
      let want = dir.length();
      dir.multiplyScalar(1 / Math.max(want, 1e-6));
      let hit = null;
      try {
        hit = context.physics && context.physics.raycast(pivot, dir, want);
      } catch {}
      let limit = hit
        ? Math.max(
            THIRD_PERSON.minDistance,
            hit.dist - THIRD_PERSON.wallPadding,
          )
        : want;
      ((current =
        limit < current
          ? damp(current, limit, THIRD_PERSON.pullIn, dt || 1)
          : damp(current, limit, THIRD_PERSON.pushOut, dt || 1)),
        (current = Math.min(current, limit)),
        camera.position.copy(pivot).addScaledVector(dir, current),
        camera.updateMatrixWorld());
    },
  };
}

export { createThirdPersonCamera, THIRD_PERSON };
