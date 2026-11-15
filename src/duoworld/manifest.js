// world.json is generated from this module at build time (scripts/build-world-package.mjs), so
// the manifest and the running World can not drift apart. tests/duoworld.test.mjs checks the
// spawn below against the live level.playerStart.
import { WORLD_BOUNDS, PLAYER_DIMENSIONS } from "../core/config.js";
import {
  PROTOCOL,
  PROTOCOL_VERSION,
  WORLD_ID,
  WORLD_VERSION,
  WORLD_COORDINATES,
  WORLD_CAPABILITIES,
  RENDER_CAPABILITIES,
  AVATAR_PROTOCOL_VERSIONS,
  CAMERA_MODES,
} from "./protocol/protocol.js";

function createManifest() {
  return {
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    id: WORLD_ID,
    version: WORLD_VERSION,
    name: "Saltline",
    description:
      "Night harbour shooter: cut the port's three uplink relays and reach the boat.",
    entry: "./world.js",
    entryExport: "default",
    module: "esm",
    coordinates: {
      ...WORLD_COORDINATES,
      handedness: "right",
      // level/placement.js: playerStart pos (-32, 0, 6), yaw -PI/2 → looking down +X
      spawn: { position: [-32, 0, 6], yaw: -Math.PI / 2, forward: [1, 0, 0] },
      bounds: {
        min: WORLD_BOUNDS.min.toArray(),
        max: WORLD_BOUNDS.max.toArray(),
        groundY: WORLD_BOUNDS.groundY,
        seaY: WORLD_BOUNDS.seaY,
      },
    },
    capabilities: [...WORLD_CAPABILITIES],
    render: JSON.parse(JSON.stringify(RENDER_CAPABILITIES)),
    unsupported: {
      representations: ["gaussian-splat", "3dgs", "hybrid"],
      reason:
        "No Gaussian splat renderer; avatars declaring one are rejected with REPRESENTATION_UNSUPPORTED.",
    },
    avatars: {
      protocol: "duoworld-avatar",
      versions: [...AVATAR_PROTOCOL_VERSIONS],
      registry: "window.DuoWorldAvatars",
      packagePath: "avatars/<id>/avatar.js",
      locomotion: {
        gravity: 21,
        mode: "duoworld:walk",
        phases: ["grounded", "takeoff", "airborne", "landing"],
      },
      actions: {
        "duoworld:interact":
          "while cutting an uplink relay (hold E), if the avatar declares it",
      },
    },
    player: {
      controller: "world",
      capsule: {
        radius: PLAYER_DIMENSIONS.radius,
        height: PLAYER_DIMENSIONS.height,
      },
      eyeHeight: PLAYER_DIMENSIONS.eye,
      cameraModes: [...CAMERA_MODES],
      defaultCameraMode: "first-person",
    },
    lifecycle: ["load", "enter", "update", "leave", "dispose"],
    objects: [
      {
        type: "saltline:uplink-relay",
        capabilities: ["saltline:cut"],
        count: 3,
      },
      {
        type: "saltline:extraction",
        capabilities: ["saltline:reach"],
        count: 1,
      },
    ],
    security: {
      sandbox: !1,
      note: "Avatar Package scripts run with full page privileges; only install trusted packages.",
    },
    assets: "./assets/",
  };
}

export { createManifest };
