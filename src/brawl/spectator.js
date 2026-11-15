// Spectator camera for the brawl. Purely local: it moves only this browser's camera and sends
// nothing to the server, so watching never affects the match.
//   follow  chase camera behind one player (Q / E cycle, mouse orbits)
//   free    "god view": fly anywhere (WASD, Space up, C down, Shift fast, mouse looks)
import { Vector3 } from "../vendor/three-r180.js";
import { clamp, damp } from "../core/math.js";

var SPECTATOR = {
  flySpeed: 9,
  flyFast: 24,
  chaseDistance: 3.4,
  chaseHeight: 1.1,
  lookHeight: 1.55,
  bounds: { x: [-70, 90], y: [0.6, 60], z: [-60, 60] },
};

var _a = new Vector3(),
  _b = new Vector3(),
  _d = new Vector3();

// targets(): [{ id, name, pos: Vector3, yaw, alive, visible }]
function createSpectatorCamera(context, targets) {
  let on = !1,
    mode = "follow",
    targetId = null,
    pos = new Vector3(0, 12, 20),
    yaw = 0,
    pitch = -0.35,
    orbit = 0,
    orbitPitch = 0.18,
    camPos = new Vector3(),
    headS = new Vector3(),
    yawS = 0,
    smooth = !1;

  function current() {
    let list = targets();
    return list.find((t) => t.id === targetId && t.visible) || null;
  }

  function cycle(dir = 1) {
    let list = targets().filter((t) => t.visible);
    if (!list.length) return ((targetId = null), null);
    let i = list.findIndex((t) => t.id === targetId);
    let next = list[(i + dir + list.length) % list.length];
    return ((targetId = next.id), (orbit = 0), (smooth = !1), next);
  }

  function frame(dt) {
    if (!on) return;
    let cam = context.camera,
      input = context.input;
    if (!cam) return;
    let look = (input && input.look) || { dx: 0, dy: 0 },
      // the paused menu and the chat box keep the camera still
      live = context.game && context.game.state === "playing";
    // follow mode with nobody to follow yet flies freely until someone shows up
    let t = mode === "follow" ? current() || (live && cycle(1)) || null : null;
    if (t) {
      live && ((orbit -= look.dx), (orbitPitch = clamp(orbitPitch + look.dy, -0.35, 0.9)));
      // the followed body is already interpolated; filter what is left so the camera glides
      if (!smooth) (headS.copy(t.pos), (yawS = t.yaw));
      else {
        let k = 1 - Math.exp(-12 * dt),
          dy = Math.atan2(Math.sin(t.yaw - yawS), Math.cos(t.yaw - yawS));
        (headS.lerp(t.pos, k), (yawS += dy * k));
      }
      let ang = yawS + orbit,
        head = _a.set(headS.x, headS.y + SPECTATOR.lookHeight, headS.z),
        want = _b.set(
          head.x + Math.sin(ang) * SPECTATOR.chaseDistance * Math.cos(orbitPitch),
          head.y + SPECTATOR.chaseHeight * 0.4 + Math.sin(orbitPitch) * SPECTATOR.chaseDistance,
          head.z + Math.cos(ang) * SPECTATOR.chaseDistance * Math.cos(orbitPitch),
        );
      // keep the camera out of walls: stop short of whatever is between the head and the camera
      try {
        let dir = _d.subVectors(want, head),
          len = dir.length();
        dir.multiplyScalar(1 / len);
        let hit = context.physics.raycast(head, dir, len);
        hit && hit.dist != null && want.copy(head).addScaledVector(dir, Math.max(0.4, hit.dist - 0.25));
      } catch {}
      smooth ? camPos.set(damp(camPos.x, want.x, 10, dt), damp(camPos.y, want.y, 10, dt), damp(camPos.z, want.z, 10, dt)) : camPos.copy(want);
      smooth = !0;
      cam.position.copy(camPos);
      cam.lookAt(head);
      // free mode starts from here when toggled
      (pos.copy(camPos), (yaw = Math.atan2(camPos.x - head.x, camPos.z - head.z)), (pitch = -0.3));
      return;
    }
    // free flight
    if (live) {
      ((yaw -= look.dx), (pitch = clamp(pitch - look.dy, -1.5, 1.5)));
      let m = input.move || { x: 0, y: 0 },
        sp = input.sprint ? SPECTATOR.flyFast : SPECTATOR.flySpeed,
        up = (input.down && input.down("jump") ? 1 : 0) - (input.crouch ? 1 : 0),
        sy = Math.sin(yaw),
        cy = Math.cos(yaw),
        cp = Math.cos(pitch),
        sp2 = Math.sin(pitch);
      // forward follows the view (including pitch), strafe stays level
      pos.x += (-sy * cp * m.y + cy * m.x) * sp * dt;
      pos.z += (-cy * cp * m.y - sy * m.x) * sp * dt;
      pos.y += (sp2 * m.y + up) * sp * dt;
      let b = SPECTATOR.bounds;
      pos.set(clamp(pos.x, b.x[0], b.x[1]), clamp(pos.y, b.y[0], b.y[1]), clamp(pos.z, b.z[0], b.z[1]));
    }
    cam.position.copy(pos);
    cam.rotation.set(pitch, yaw, 0, "YXZ");
  }

  return {
    frame,
    start(m = "follow") {
      ((on = !0), (mode = m), (smooth = !1));
      let cam = context.camera;
      cam && m === "free" && (pos.copy(cam.position), (pitch = -0.3));
    },
    stop() {
      on = !1;
    },
    toggle() {
      mode = mode === "follow" ? "free" : "follow";
      mode === "follow" && (cycle(0) || cycle(1), (smooth = !1));
      return mode;
    },
    next: () => (mode = "follow", cycle(1)),
    prev: () => (mode = "follow", cycle(-1)),
    follow(id) {
      ((mode = "follow"), (targetId = id), (orbit = 0), (smooth = !1));
    },
    get on() {
      return on;
    },
    get mode() {
      return mode;
    },
    get target() {
      let t = current();
      return t ? t.id : null;
    },
    get position() {
      return mode === "free" ? pos.clone() : camPos.clone();
    },
  };
}

export { createSpectatorCamera, SPECTATOR };
