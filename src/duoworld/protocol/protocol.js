// DuoWorld World Protocol 0.1.0 as spoken by Saltline. This is a contract, not an SDK: no
// @duoworld/* package exists yet, so the shapes are documented here and implemented locally.

/**
 * @typedef {'idle'|'walk'|'run'} AvatarMotion
 * @typedef {'grounded'|'takeoff'|'airborne'|'landing'} LocomotionPhase
 * @typedef {Object} LocomotionState                Avatar 1.1 setLocomotion() payload
 * @property {boolean} grounded
 * @property {number} speed                         horizontal speed, m/s
 * @property {{x:number,y:number,z:number}} velocity World frame (+Y up), m/s
 * @property {LocomotionPhase} phase
 * @property {number} deltaSeconds
 * @property {string} [mode]                        extension: always "duoworld:walk" in this World
 * @property {number} [gravity]                     extension: World gravity magnitude, m/s^2
 * @property {'standing'|'crouching'} [stance]      extension
 * @property {boolean} [sprinting]                  extension
 * @property {number} [aimPitch]                   extension: where the player looks, radians, + up (the body aims its rifle there)
 * @property {ClimbState} [climb]                   extension: present while mode is "duoworld:climb"
 *
 * @typedef {Object} ClimbState
 * @property {'mantle'|'ladder'} kind
 * @property {number} progress                      mantle: 0..1 (rise along the wall to 0.65, then over the edge); ladder: 1 once mounted
 * @property {number} ledgeHeight                   mantle: metres from the current feet up to the ledge top
 * @property {number} ledgeDistance                 mantle: horizontal metres from the body to the ledge edge (0 once over it)
 * @property {number} climbSpeed                    vertical m/s, + up (ladder rungs advance with it)
 * @property {boolean} crouchEnd                    mantle: the top is low, the body ends crouched
 *
 * @typedef {Object} AvatarContext                  argument of AvatarDefinition.create()
 * @property {any} THREE                            the World's own Three.js r180 namespace
 * @property {string} baseUrl                       absolute URL of the package folder, ends with "/"
 * @property {(url:string) => Promise<{scene:any, animations:any[]}>} loadGLTF  relative to baseUrl
 * @property {{up:string, forward:string, metersPerUnit:number}} coordinates  Avatar convention
 *
 * @typedef {Object} AvatarInstanceV1
 * @property {any} object3D                         Avatar Visual Root
 * @property {(m:AvatarMotion) => void} setMotion
 * @property {(dt:number) => void} update
 * @property {() => void} dispose
 *
 * @typedef {AvatarInstanceV1 & {
 *   setLocomotion?: (s: LocomotionState) => void,
 *   playAction?: (name: string, options?: object) => any,
 *   stopAction?: (name?: string) => any,
 *   getAnchor?: (name: string) => any,
 *   capabilities?: { actions?: string[], anchors?: string[] },
 * }} AvatarInstanceV1_1
 *
 * Held items (optional): avatars come with empty hands. In play the World parents its own gun to
 * the avatar's "weapon" anchor (origin = dominant-hand grip, +Z along the barrel, +Y up; the avatar
 * moves it) and passes setLocomotion().held = { kind: "rifle", grip, support, action }: grasp frames
 * { position, quaternion, radius } in the anchor's space for the right and left hand (support may
 * be null), action null | "reload" | "inspect". No "held" = empty hands. While the avatar climbs
 * the gun hangs on the optional "weaponStow" anchor. See src/weapons/held-gun.js.
 * Optional action: "duoworld:fire" (a short recoil, played for every shot the body fires).
 * Optional metadata: firstPersonArms { sleeve, glove } (#rrggbb): the World re-colours the
 * first-person arms to match the outfit.
 *
 * @typedef {Object} WorldEnterContext
 * @property {string|null} [avatar]                 avatar id to wear on entry
 * @property {'first-person'|'third-person'} [cameraMode]
 * @property {boolean} [autostart]                  skip the title screen and start the mission
 *
 * @typedef {{ id: string, type: string, capabilities?: string[] }} WorldObjectDescriptor
 */

var PROTOCOL = "duoworld.world";

var PROTOCOL_VERSION = "0.1.0";

// Stable, long-lived identifier of this World. Never generated.
var WORLD_ID = "saltline.harbor";

var WORLD_VERSION = "1.1.0";

// The World's native frame: the player looks down -Z at yaw 0 (see player/player.js).
var WORLD_COORDINATES = Object.freeze({
  up: "+Y",
  forward: "-Z",
  metersPerUnit: 1,
});

// The frame avatars are authored in (glTF convention). AvatarHost converts between the two.
var AVATAR_COORDINATES = Object.freeze({
  up: "+Y",
  forward: "+Z",
  metersPerUnit: 1,
});

// Only capabilities that are implemented and covered by tests/duoworld.test.mjs.
var WORLD_CAPABILITIES = Object.freeze([
  "duoworld.lifecycle@1",
  "duoworld.avatar-host@1",
  "duoworld.avatar-locomotion@1.1",
  "duoworld.avatar-actions@1.1",
  "duoworld.world-objects@1",
  "duoworld.camera-modes@1",
]);

// A single WebGL2 canvas rendered by the World's Three.js r180. No Gaussian splat renderer.
var RENDER_CAPABILITIES = Object.freeze({
  backend: "three.webgl2@r180",
  representations: Object.freeze(["three.object3d", "mesh.glb", "mesh.gltf"]),
  composition: Object.freeze({
    // avatars are scene children drawn by the World's own player camera in the same passes
    sharedCamera: !0,
    // no splat renderer exists in this World, so there is nothing to occlude against
    meshSplatOcclusion: !1,
    // the post chain keeps its depth copy private; no depth texture is offered to plugins
    depthTexture: !1,
    // transparent avatar materials are sorted with the World's in the same scene render
    transparentComposition: !0,
  }),
});

var AVATAR_PROTOCOL_VERSIONS = Object.freeze(["1.0", "1.1"]);

var MOTIONS = Object.freeze(["idle", "walk", "run"]);

var PHASES = Object.freeze(["grounded", "takeoff", "airborne", "landing"]);

var CAMERA_MODES = Object.freeze(["first-person", "third-person"]);

var AVATAR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

class DuoWorldError extends Error {
  constructor(code, message) {
    (super(message), (this.name = "DuoWorldError"), (this.code = code));
  }
}

export {
  PROTOCOL,
  PROTOCOL_VERSION,
  WORLD_ID,
  WORLD_VERSION,
  WORLD_COORDINATES,
  AVATAR_COORDINATES,
  WORLD_CAPABILITIES,
  RENDER_CAPABILITIES,
  AVATAR_PROTOCOL_VERSIONS,
  MOTIONS,
  PHASES,
  CAMERA_MODES,
  AVATAR_ID_PATTERN,
  DuoWorldError,
};
