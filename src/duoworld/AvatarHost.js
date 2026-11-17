// AvatarHost: puts an Avatar Package's visual on the World-owned player.
//
// Hierarchy (World Scene → Player Control Root → Avatar Visual Root):
//   scene
//   └─ DuoWorld:PlayerControlRoot   World-owned. Its transform is written here, once per frame,
//      │                            from player.pos / player.yaw. Nothing else writes it.
//      └─ DuoWorld:WorldScale       instance-level world scaling + avatar→world facing (+Z → -Z)
//         └─ DuoWorld:HeightNormalize   uniform scale STANDARD_HEIGHT / metadata.height, so every
//            │                          body is drawn the same size (the hitbox is fixed anyway)
//            └─ instance.object3D   Avatar Visual Root. The avatar owns everything below it.
//
// The World controller (player.js: input, velocity, gravity, collision, jump, camera, rules)
// is unchanged and never reads avatar bones, meshes or ids. The avatar only receives
// setLocomotion() (1.1) or setMotion() (1.0) derived from the controller's real physics state.
import {
  THREE,
  Group,
  Mesh,
  MeshStandardMaterial,
  Box3,
  CapsuleGeometry,
  SphereGeometry,
  BoxGeometry,
  Vector3,
} from "../vendor/three-r180.js";
import { GLTFLoader } from "../vendor/three-r180-gltf-loader.js";
import { PLAYER_MOVEMENT } from "../player/player.js";
import { attachHeldGun } from "../weapons/held-gun.js";
import { createThirdPersonCamera } from "../player/third-person-camera.js";
import {
  AVATAR_COORDINATES,
  AVATAR_ID_PATTERN,
  CAMERA_MODES,
  DuoWorldError,
  RENDER_CAPABILITIES,
} from "./protocol/protocol.js";

var AVATAR_TUNING = {
  // instance-level world scale: both frames are metres, so 1
  worldScale: 1,
  createTimeoutMs: 30000,
  scriptTimeoutMs: 15000,
  // locomotion phase timing (coyote-consistent with player.js)
  airborneAfter: 0.1,
  landingHold: 0.14,
  // v1 setMotion thresholds (m/s, horizontal)
  idleBelow: 0.3,
  runAbove: 5,
  defaultFollowHeight: 1.55,
  // every avatar is drawn at this standing height (metres), whatever size it was modelled at,
  // so no body looks bigger or smaller than another; matches the 1.8 m player capsule
  // (eye height 1.68). The scale comes from metadata.height, or the measured bounds when a
  // package declares none, and is clamped to visualScaleRange.
  standardHeight: 1.75,
  visualScaleRange: [0.25, 4],
};

// height the package was modelled at: metadata.height, else the measured bounds of its visual
function modelledHeight(meta, object3D) {
  let h = +(meta && meta.height);
  if (h > 0) return h;
  try {
    let box = new Box3().setFromObject(object3D, !0);
    h = box.isEmpty() ? 0 : box.max.y - box.min.y;
  } catch {
    h = 0;
  }
  return h > 0.05 ? h : AVATAR_TUNING.standardHeight;
}

// one generic rule for every body: uniform scale to the standard height
function visualScaleFor(height) {
  let [lo, hi] = AVATAR_TUNING.visualScaleRange,
    s = AVATAR_TUNING.standardHeight / height;
  return Math.min(hi, Math.max(lo, s));
}

// Wraps an instance's Avatar Visual Root in the World-owned DuoWorld:HeightNormalize node and
// completes the entry: entry.object3D is what the World places in the scene, entry.visualScale
// the factor applied, entry.followHeight the scaled third-person eye height.
function normalizeEntry(entry, meta) {
  let inst = entry.instance,
    height = modelledHeight(meta, inst.object3D),
    scale = visualScaleFor(height),
    eye = +(meta && meta.eyeHeight),
    wrap = new Group();
  ((wrap.name = "DuoWorld:HeightNormalize"),
    wrap.scale.setScalar(scale),
    wrap.add(inst.object3D));
  return Object.assign(entry, {
    object3D: wrap,
    modelHeight: height,
    visualScale: scale,
    visualHeight: height * scale,
    followHeight: (eye > 0 ? eye : height * 0.92) * scale,
  });
}

var SPLAT_HINTS = /splat|3dgs|gaussian/i;

function representationOf(def) {
  let visual = def && def.visual;
  return String(
    (def && def.representation) ||
      (visual && visual.representation) ||
      "three.object3d",
  );
}

// declared Avatar protocol version; packages that declare none are treated as 1.x and their
// effective interface (1.0 or 1.1) is read from the instance they create
function protocolVersionOf(def) {
  let p = def && def.protocol;
  if (!p) return null;
  if (typeof p === "string")
    return (/(\d+(\.\d+)?)\s*$/.exec(p) || [0, "1.0"])[1];
  return String(p.version || "1.0");
}

function describeDefinition(def) {
  let rep = representationOf(def),
    supported = RENDER_CAPABILITIES.representations.includes(rep),
    adapter = def.visual && def.visual.adapter;
  adapter && adapter !== "three" && (supported = !1);
  return {
    id: def.id,
    name: (def.metadata && def.metadata.name) || def.name || def.id,
    version: def.version || null,
    protocol: protocolVersionOf(def),
    representation: rep,
    supported: supported,
    metadata: def.metadata ? { ...def.metadata } : {},
  };
}

function withTimeout(promise, ms, code, message) {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DuoWorldError(code, message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Real physics → Avatar 1.1 locomotion. Phases come from player.onGround and the controller's
// own jump event, never from key state.
function createLocomotionTracker(context) {
  let tuning = AVATAR_TUNING,
    jumped = !1,
    airTime = 0,
    landingLeft = 0,
    wasAirborne = !1,
    velocity = { x: 0, y: 0, z: 0 },
    state = {
      grounded: !0,
      speed: 0,
      velocity: velocity,
      phase: "grounded",
      deltaSeconds: 0,
      mode: "duoworld:walk",
      gravity: PLAYER_MOVEMENT.gravity,
      stance: "standing",
      sprinting: !1,
      aimPitch: 0,
    },
    off = context.events.on("player:jump", () => {
      jumped = !0;
    });
  return {
    state,
    reset() {
      ((jumped = !1),
        (airTime = 0),
        (landingLeft = 0),
        (wasAirborne = !1),
        (state.phase = "grounded"));
    },
    step(dt) {
      let p = context.player,
        grounded = !!p.onGround,
        phase;
      if (p.climbing)
        // a mantle is neither a jump nor a fall; avatars see it as airborne, in climb mode
        ((phase = "airborne"), (jumped = !1), (wasAirborne = !0), (airTime = 0));
      else if (jumped)
        ((phase = "takeoff"), (jumped = !1), (wasAirborne = !0), (airTime = 0));
      else if (!grounded)
        ((airTime += dt),
          airTime > tuning.airborneAfter || wasAirborne
            ? ((phase = "airborne"), (wasAirborne = !0))
            : (phase = "grounded"));
      else
        (wasAirborne &&
          ((landingLeft = tuning.landingHold), (wasAirborne = !1)),
          (airTime = 0),
          landingLeft > 0
            ? ((phase = "landing"), (landingLeft -= dt))
            : (phase = "grounded"));
      ((velocity.x = p.vel.x),
        (velocity.y = p.vel.y),
        (velocity.z = p.vel.z),
        (state.grounded = grounded && phase !== "takeoff"),
        (state.speed = p.alive ? p.speed : 0),
        (state.phase = phase),
        (state.deltaSeconds = dt),
        (state.mode = p.climbing ? "duoworld:climb" : "duoworld:walk"),
        (state.stance = p.crouching ? "crouching" : "standing"),
        (state.sprinting = !!p.sprinting),
        (state.aimPitch = p.pitch || 0));
      // climb detail only while climbing (a copy: avatars may keep it)
      p.climbing && p.climb ? (state.climb = { ...p.climb }) : delete state.climb;
      return state;
    },
    motion(previous) {
      // v1 fallback keeps the last ground motion through the air
      if (state.phase === "airborne" || state.phase === "takeoff")
        return previous || "idle";
      return state.speed < tuning.idleBelow
        ? "idle"
        : state.sprinting || state.speed > tuning.runAbove
          ? "run"
          : "walk";
    },
    dispose() {
      off();
    },
  };
}

// Minimal World-side body used only for the third-person view when no Avatar Package is worn.
function createBuiltinOperator() {
  let root = new Group(),
    suit = new MeshStandardMaterial({
      color: 0x3a4148,
      roughness: 0.8,
      metalness: 0.05,
    }),
    vest = new MeshStandardMaterial({ color: 0x6b5a3a, roughness: 0.9 }),
    geoms = [
      new CapsuleGeometry(0.24, 0.9, 4, 12),
      new SphereGeometry(0.13, 16, 12),
      new BoxGeometry(0.44, 0.42, 0.26),
    ],
    body = new Mesh(geoms[0], suit),
    head = new Mesh(geoms[1], suit),
    torso = new Mesh(geoms[2], vest);
  ((body.position.y = 0.69),
    (head.position.y = 1.55),
    torso.position.set(0, 1.1, 0.02));
  for (let m of [body, head, torso]) ((m.castShadow = !0), root.add(m));
  root.name = "saltline:operator";
  let t = 0,
    motion = "idle";
  return {
    object3D: root,
    setMotion(m) {
      motion = m;
    },
    setLocomotion(s) {
      motion = s.speed > 0.3 ? (s.speed > 5 ? "run" : "walk") : "idle";
    },
    update(dt) {
      t += dt * (motion === "run" ? 11 : motion === "walk" ? 7 : 1.5);
      root.children[0].position.y =
        0.69 + Math.abs(Math.sin(t)) * (motion === "idle" ? 0.005 : 0.03);
    },
    dispose() {
      for (let g of geoms) g.dispose();
      (suit.dispose(), vest.dispose(), root.clear());
    },
  };
}

function createAvatarHost(context, options = {}) {
  let registry = options.registry || window.DuoWorldAvatars,
    avatarRoot = new URL(options.avatarRoot || "./avatars/", document.baseURI)
      .href,
    scene = context.scene,
    controlRoot = new Group(),
    scaleNode = new Group(),
    tracker = createLocomotionTracker(context),
    camera3p = createThirdPersonCamera(context),
    current = null, // { id, def, info, instance, builtin }
    builtin = null,
    motion = "idle",
    token = 0,
    pending = null,
    cameraMode = "first-person",
    savedViewMask = context.viewCamera ? context.viewCamera.layers.mask : 1,
    viewHidden = !1,
    action = null,
    injected = new Map(),
    extras = new Set(),
    errorsLogged = new Set(),
    disposed = !1;
  ((controlRoot.name = "DuoWorld:PlayerControlRoot"),
    (scaleNode.name = "DuoWorld:WorldScale"),
    scaleNode.scale.setScalar(AVATAR_TUNING.worldScale),
    // avatars face +Z (glTF); the player looks down -Z at yaw 0
    (scaleNode.rotation.y = AVATAR_COORDINATES.forward === "+Z" ? Math.PI : 0),
    controlRoot.add(scaleNode),
    (controlRoot.visible = !1),
    scene.add(controlRoot));

  function logOnce(key, err) {
    errorsLogged.has(key) ||
      (errorsLogged.add(key), console.error(`[avatar] ${key}:`, err));
  }

  function loadGLTF(baseUrl) {
    return (url) =>
      new Promise((resolve, reject) => {
        let abs = new URL(String(url), baseUrl).href;
        new GLTFLoader().load(
          abs,
          (gltf) => resolve(gltf),
          void 0,
          (e) =>
            reject(
              new DuoWorldError(
                "ASSET_LOAD_FAILED",
                `loadGLTF(${abs}) failed: ${(e && e.message) || e}`,
              ),
            ),
        );
      });
  }

  function ensureScript(id) {
    if (registry && registry.has && registry.has(id)) return Promise.resolve();
    if (injected.has(id)) return injected.get(id);
    let src = `${avatarRoot}${encodeURIComponent(id)}/avatar.js?v=ads7`, // ?v: bump when an avatar.js changes (it is cached for a week)
      promise = withTimeout(
        new Promise((resolve, reject) => {
          let el = document.createElement("script");
          ((el.src = src),
            (el.async = !0),
            (el.dataset.duoworldAvatar = id),
            (el.onload = () => resolve()),
            (el.onerror = () =>
              reject(
                new DuoWorldError(
                  "AVATAR_NOT_FOUND",
                  `avatar package "${id}" not found at ${src}`,
                ),
              )),
            document.head.appendChild(el));
        }),
        AVATAR_TUNING.scriptTimeoutMs,
        "AVATAR_NOT_FOUND",
        `avatar package "${id}" did not load in time`,
      ).then(() => {
        registry = window.DuoWorldAvatars || registry;
        if (!registry || !registry.has(id))
          throw new DuoWorldError(
            "AVATAR_NOT_REGISTERED",
            `${src} loaded but did not register "${id}"`,
          );
      });
    // a failed injection may be retried later
    return (
      injected.set(id, promise),
      promise.catch(() => injected.delete(id)),
      promise
    );
  }

  function validateInstance(inst) {
    let missing = [];
    (inst && inst.object3D && inst.object3D.isObject3D) ||
      missing.push("object3D");
    for (let k of ["setMotion", "update", "dispose"])
      (inst && typeof inst[k] == "function") || missing.push(k + "()");
    return missing;
  }

  function attach(entry) {
    (scaleNode.add(entry.object3D),
      camera3p.setFollowHeight(entry.followHeight),
      prime(entry));
  }

  function detach(entry) {
    if (!entry) return;
    entry.heldRig && (entry.heldRig.dispose(), (entry.heldRig = void 0));
    entry.object3D.parent === scaleNode && scaleNode.remove(entry.object3D);
    try {
      entry.instance.dispose();
    } catch (e) {
      logOnce(`${entry.id}.dispose threw`, e);
    }
  }

  // carry motion state over to a freshly attached avatar
  function prime(entry) {
    let inst = entry.instance;
    try {
      typeof inst.setLocomotion == "function"
        ? inst.setLocomotion({
            ...tracker.state,
            velocity: { ...tracker.state.velocity },
            deltaSeconds: 0,
          })
        : inst.setMotion(motion);
      inst.update(0);
    } catch (e) {
      logOnce(`${entry.id} prime threw`, e);
    }
  }

  function wearBuiltin() {
    builtin ||
      ((builtin = normalizeEntry({
        id: "saltline.operator",
        builtin: !0,
        info: {
          id: "saltline.operator",
          name: "Saltline operator (built-in)",
          builtin: !0,
          protocol: "1.1",
          representation: "three.object3d",
          supported: !0,
          metadata: { height: 1.75, eyeHeight: 1.6 },
        },
        instance: createBuiltinOperator(),
      }, { height: 1.75, eyeHeight: 1.6 })),
      attach(builtin));
  }

  function dropBuiltin() {
    builtin && (detach(builtin), (builtin = null));
  }

  // Loads, validates and creates one avatar instance; never attaches it to the scene.
  async function buildEntry(id) {
    await ensureScript(id);
    let def = registry.get(id),
      info = describeDefinition(def);
    if (!info.supported)
      throw new DuoWorldError(
        "REPRESENTATION_UNSUPPORTED",
        `avatar "${id}" uses representation "${info.representation}"${def.visual && def.visual.adapter ? ` (adapter "${def.visual.adapter}")` : ""}; this World renders ${RENDER_CAPABILITIES.representations.join(", ")} only` +
          (SPLAT_HINTS.test(info.representation)
            ? " and has no Gaussian splat renderer"
            : ""),
      );
    if (info.protocol && +info.protocol.split(".")[0] !== 1)
      throw new DuoWorldError(
        "AVATAR_PROTOCOL_UNSUPPORTED",
        `avatar "${id}" speaks protocol ${info.protocol}; supported: 1.0, 1.1`,
      );
    let baseUrl =
        (registry.baseUrlOf && registry.baseUrlOf(id)) ||
        `${avatarRoot}${encodeURIComponent(id)}/`,
      ctx = {
        THREE: THREE,
        baseUrl: baseUrl,
        loadGLTF: loadGLTF(baseUrl),
        coordinates: AVATAR_COORDINATES,
      },
      instance;
    try {
      instance = await withTimeout(
        Promise.resolve().then(() => def.create(ctx)),
        AVATAR_TUNING.createTimeoutMs,
        "AVATAR_CREATE_TIMEOUT",
        `avatar "${id}" create() timed out`,
      );
    } catch (e) {
      throw e instanceof DuoWorldError && e.code !== "ASSET_LOAD_FAILED"
        ? e
        : Object.assign(
            new DuoWorldError(
              "AVATAR_CREATE_FAILED",
              `avatar "${id}" create() failed: ${(e && e.message) || e}`,
            ),
            { cause: e },
          );
    }
    let missing = validateInstance(instance);
    if (missing.length) {
      try {
        instance &&
          typeof instance.dispose == "function" &&
          instance.dispose();
      } catch {}
      throw new DuoWorldError(
        "AVATAR_INVALID",
        `avatar "${id}" instance is missing ${missing.join(", ")}`,
      );
    }
    let iface = typeof instance.setLocomotion == "function" ? "1.1" : "1.0";
    return normalizeEntry({
      id,
      def,
      info: {
        ...info,
        loaded: !0,
        interface: iface,
        optional: [
          "setLocomotion",
          "playAction",
          "stopAction",
          "getAnchor",
        ].filter((k) => typeof instance[k] == "function"),
      },
      instance,
    }, def.metadata);
  }

  // The first-person arms take the worn character's sleeve and glove colours (optional metadata
  // `firstPersonArms: { sleeve, glove }` as #rrggbb), so the arm you see matches the body others see.
  function wearArms(entry) {
    let a = entry && entry.info && entry.info.metadata && entry.info.metadata.firstPersonArms,
      ok = (v) => typeof v == "string" && /^#[0-9a-f]{6}$/i.test(v),
      w = context.weapon;
    try {
      w && w.setArmColors && w.setArmColors(a && typeof a == "object" ? { sleeve: ok(a.sleeve) ? a.sleeve : null, glove: ok(a.glove) ? a.glove : null } : null);
    } catch {}
  }

  async function setAvatar(id) {
    if (disposed)
      throw new DuoWorldError("WORLD_DISPOSED", "world was disposed");
    let my = ++token;
    if (id == null || id === "") {
      let old = current;
      return (
        (current = null),
        wearArms(null),
        detach(old),
        cameraMode === "third-person" && wearBuiltin(),
        null
      );
    }
    id = String(id);
    if (!AVATAR_ID_PATTERN.test(id))
      throw new DuoWorldError("AVATAR_ID_INVALID", `invalid avatar id "${id}"`);
    if (current && current.id === id) return current.info;
    let run = buildEntry(id);
    pending = run;
    let entry;
    try {
      entry = await run;
    } finally {
      pending === run && (pending = null);
    }
    if (my !== token || disposed) {
      // superseded by a later setAvatar() (or the world went away): never attach
      detach(entry);
      throw new DuoWorldError(
        "AVATAR_SUPERSEDED",
        `setAvatar("${id}") was superseded`,
      );
    }
    // swap only after the new avatar succeeded; the previous one stays until here
    let old = current;
    return (
      (current = entry),
      wearArms(entry),
      dropBuiltin(),
      detach(old),
      attach(entry),
      action && (action = null),
      entry.info
    );
  }

  // Extra, independent instances for other bodies in the World (the 1v1 opponent, the
  // character-select preview). The caller owns placement and per-frame calls and must hand the
  // entry back to releaseInstance(); dispose() releases anything still outstanding.
  // id null → the built-in operator body. Place entry.object3D (the World-owned height-normalized
  // wrapper around instance.object3D), not the instance's own root.
  async function createInstance(id) {
    if (disposed)
      throw new DuoWorldError("WORLD_DISPOSED", "world was disposed");
    let entry;
    if (id == null || id === "")
      entry = normalizeEntry({
        id: "saltline.operator",
        builtin: !0,
        info: {
          id: "saltline.operator",
          name: "Saltline operator (built-in)",
          builtin: !0,
          interface: "1.1",
          representation: "three.object3d",
          supported: !0,
          metadata: { height: 1.75, eyeHeight: 1.6 },
        },
        instance: createBuiltinOperator(),
      }, { height: 1.75, eyeHeight: 1.6 });
    else {
      id = String(id);
      if (!AVATAR_ID_PATTERN.test(id))
        throw new DuoWorldError("AVATAR_ID_INVALID", `invalid avatar id "${id}"`);
      entry = await buildEntry(id);
    }
    if (disposed) {
      detach(entry);
      throw new DuoWorldError("WORLD_DISPOSED", "world was disposed");
    }
    return (extras.add(entry), entry);
  }

  function releaseInstance(entry) {
    if (!entry || !extras.has(entry)) return;
    extras.delete(entry);
    entry.heldRig && (entry.heldRig.dispose(), (entry.heldRig = void 0));
    let obj = entry.object3D;
    obj.parent && obj.parent.remove(obj);
    try {
      entry.instance.dispose();
    } catch (e) {
      logOnce(`${entry.id}.dispose threw`, e);
    }
  }

  // registers a package (injecting its avatar.js if needed) without creating an instance;
  // resolves to its description, or rejects like setAvatar() would
  async function describeAvatar(id) {
    id = String(id);
    if (!AVATAR_ID_PATTERN.test(id))
      throw new DuoWorldError("AVATAR_ID_INVALID", `invalid avatar id "${id}"`);
    await ensureScript(id);
    return describeDefinition(registry.get(id));
  }

  function worn() {
    return current || builtin;
  }

  function setCameraMode(mode) {
    if (!CAMERA_MODES.includes(mode))
      throw new DuoWorldError(
        "CAMERA_MODE_UNSUPPORTED",
        `camera mode "${mode}" is not supported (${CAMERA_MODES.join(", ")})`,
      );
    if (mode === cameraMode) return mode;
    ((cameraMode = mode), camera3p.reset());
    mode === "third-person"
      ? current || wearBuiltin()
      : (dropBuiltin(), restoreViewModel());
    return (context.events.emit("duoworld:camera-mode", { mode }), mode);
  }

  function restoreViewModel() {
    viewHidden &&
      context.viewCamera &&
      ((context.viewCamera.layers.mask = savedViewMask), (viewHidden = !1));
  }

  // frame hook: runs after player/weapon/enemies, before effects and render
  function frame(dt, simulated) {
    if (disposed) return;
    let p = context.player,
      entry = worn(),
      third = cameraMode === "third-person",
      alive = !!(p && p.alive);
    if (!p) return;
    // the single writer of the Player Control Root transform
    (controlRoot.position.copy(p.pos),
      (controlRoot.rotation.y = p.yaw),
      (controlRoot.visible = !!entry && third && alive));
    if (third && alive) {
      context.viewCamera &&
        !viewHidden &&
        ((savedViewMask = context.viewCamera.layers.mask),
        (context.viewCamera.layers.mask = 0),
        (viewHidden = !0));
      simulated && camera3p.apply(dt);
    } else restoreViewModel();
    let paused = context.game && context.game.state === "paused";
    if (!entry || paused) return;
    let loco = tracker.step(simulated ? dt : 0),
      inst = entry.instance;
    // 1.1 avatars get setLocomotion() every frame; 1.0 avatars get setMotion() on change only.
    // motion is tracked either way so a later 1.0 avatar starts in the right state.
    let m = tracker.motion(motion),
      changed = m !== motion;
    motion = m;
    // in play the body carries this World's gun (avatars that declare a "weapon" anchor)
    entry.heldRig === void 0 && (entry.heldRig = attachHeldGun(context, inst));
    entry.heldRig
      ? entry.heldRig.apply(loco, context.weapon && context.weapon.heldAction ? context.weapon.heldAction(heldAct) : null, loco.mode === "duoworld:climb")
      : delete loco.held;
    try {
      typeof inst.setLocomotion == "function"
        ? inst.setLocomotion(loco)
        : changed && inst.setMotion(m);
    } catch (e) {
      logOnce(`${entry.id}.setLocomotion/setMotion threw`, e);
    }
    try {
      inst.update(dt);
    } catch (e) {
      logOnce(`${entry.id}.update threw`, e);
    }
  }

  // optional 1.1 actions; absent methods and refusals are not errors for the World
  function supportsAction(inst, name) {
    let caps = inst && inst.capabilities;
    return !!(
      caps &&
      Array.isArray(caps.actions) &&
      caps.actions.includes(name)
    );
  }

  function playAction(name, opts) {
    let entry = worn(),
      inst = entry && entry.instance;
    if (!inst || typeof inst.playAction != "function")
      return Promise.resolve({ ok: !1, reason: "ACTION_UNSUPPORTED" });
    return Promise.resolve()
      .then(() => inst.playAction(name, opts))
      .then(
        (r) =>
          r === !1
            ? { ok: !1, reason: "ACTION_UNSUPPORTED" }
            : ((action = name), { ok: !0 }),
        (e) => ({
          ok: !1,
          reason: (e && e.code) || "ACTION_FAILED",
          message: e && e.message,
        }),
      );
  }

  function stopAction(name) {
    let entry = worn(),
      inst = entry && entry.instance;
    action = null;
    if (!inst || typeof inst.stopAction != "function")
      return Promise.resolve({ ok: !1, reason: "ACTION_UNSUPPORTED" });
    return Promise.resolve()
      .then(() => inst.stopAction(name))
      .then(
        () => ({ ok: !0 }),
        (e) => ({ ok: !1, reason: (e && e.code) || "ACTION_FAILED" }),
      );
  }

  function getAnchor(name) {
    let entry = worn(),
      inst = entry && entry.instance;
    if (!inst || typeof inst.getAnchor != "function") return null;
    try {
      return inst.getAnchor(name) || null;
    } catch {
      return null;
    }
  }

  // the World's existing interaction (holding E on a relay) mapped onto an avatar action,
  // only for avatars that declare it
  let interacting = null,
    muzzlePos = new Vector3(),
    muzzleDir = new Vector3(),
    heldAct = { a: 0, t: 0, empty: !1 },
    offs = [
      context.events.on("objective:progress", (e) => {
        let inst = current && current.instance;
        if (!inst) return;
        e.t > 0 && interacting !== e.id
          ? ((interacting = e.id),
            supportsAction(inst, "duoworld:interact") &&
              playAction("duoworld:interact", { target: e.id }))
          : e.t <= 0 &&
            interacting === e.id &&
            ((interacting = null),
            supportsAction(inst, "duoworld:interact") &&
              stopAction("duoworld:interact"));
      }),
      context.events.on("objective:done", (e) => {
        let inst = current && current.instance;
        interacting === e.id &&
          ((interacting = null),
          inst &&
            supportsAction(inst, "duoworld:interact") &&
            stopAction("duoworld:interact"));
      }),
      context.events.on("player:dead", () => tracker.reset()),
      // seen from outside, the body's own rifle fires: flash at its muzzle anchor and a recoil
      // (the first-person viewmodel and its flash are hidden in the third-person view)
      context.events.on("weapon:fire", () => {
        let entry = worn(),
          inst = entry && entry.instance;
        if (cameraMode !== "third-person" || !inst) return;
        try {
          entry.heldRig &&
            entry.heldRig.muzzle(muzzlePos, muzzleDir) &&
            context.fx &&
            context.fx.muzzleFlash &&
            context.fx.muzzleFlash(muzzlePos.clone(), muzzleDir.clone(), { scale: 0.8 });
          supportsAction(inst, "duoworld:fire") && typeof inst.playAction == "function" && inst.playAction("duoworld:fire");
        } catch {}
      }),
    ];
  context.frameHooks.push(frame);

  return {
    root: controlRoot,
    setAvatar,
    createInstance,
    releaseInstance,
    describeAvatar,
    getAvatar() {
      return current ? { ...current.info } : null;
    },
    listAvatars() {
      let list =
        registry && registry.list
          ? registry.list().map(describeDefinition)
          : [];
      return list.map((d) => ({
        ...d,
        loaded: !!(current && current.id === d.id),
      }));
    },
    get pending() {
      return !!pending;
    },
    setCameraMode,
    getCameraMode: () => cameraMode,
    playAction,
    stopAction,
    getAnchor,
    get locomotion() {
      return { ...tracker.state, velocity: { ...tracker.state.velocity } };
    },
    get camera() {
      return camera3p;
    },
    // diagnostics only (tests, devtools); not part of the protocol surface
    get instance() {
      let entry = worn();
      return entry ? entry.instance : null;
    },
    get visual() {
      let entry = worn();
      return entry
        ? {
            modelHeight: entry.modelHeight,
            scale: entry.visualScale,
            height: entry.visualHeight,
          }
        : null;
    },
    dispose() {
      if (disposed) return;
      ((disposed = !0), token++);
      let i = context.frameHooks.indexOf(frame);
      (i >= 0 && context.frameHooks.splice(i, 1),
        offs.forEach((f) => f()),
        tracker.dispose(),
        restoreViewModel());
      (detach(current),
        (current = null),
        dropBuiltin(),
        scene.remove(controlRoot));
      for (let entry of [...extras]) releaseInstance(entry);
      for (let el of document.querySelectorAll("script[data-duoworld-avatar]"))
        el.remove();
      injected.clear();
    },
  };
}

export {
  createAvatarHost,
  createBuiltinOperator,
  createLocomotionTracker,
  describeDefinition,
  visualScaleFor,
  AVATAR_TUNING,
};
