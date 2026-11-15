/*!
 * DuoWorld Avatar plugin — "girl-purple"
 * Protocol: DuoWorld Avatar 1.1 (backwards compatible with 1.0 Worlds)
 *
 * Plain browser script (no ES module, no imports, no bundled three.js).
 * On execution it synchronously registers an AvatarDefinition with
 * window.DuoWorldAvatars. Everything it needs at runtime comes from the
 * AvatarContext passed to create(): { THREE, baseUrl, loadGLTF }.
 *
 * Structure (one file, three independent layers):
 *   identity  – who the avatar is (id, version, name, size); no rendering, no behaviour
 *   behavior  – locomotion blending, jump / air / landing phases, actions; renderer-agnostic
 *               (it only drives "channels" through a pose sink)
 *   visual    – the representation adapter. This build ships ONE adapter:
 *               representation "mesh.glb", adapter "three" (skinned glTF on context.THREE).
 *               Other representations (e.g. 3D Gaussian splats, hybrid) would provide the same
 *               adapter interface; none is implemented or bundled here.
 *
 * The avatar never reads input, never runs its own loop, never creates a renderer /
 * camera / scene, never moves its root in the world and never touches other avatars,
 * World physics, accounts or economy. The World owns the trajectory; update(dt) is the
 * only clock.
 *
 * Generated file, with one Saltline addition: createRifle() (the avatar's own rifle and a
 * two-handed hold applied on top of the clips; see "held rifle" below).
 */
(function (global) {
  'use strict';

  // Filled in by the package build (id, version, name, measured height/radius, clip names ...).
  var BUILD = {"id":"girl-purple","version":"1.1.0","name":"Sakura Girl (purple scarf)","height":1.64,"radius":0.29,"model":"model.glb","clips":{"idle":"Idle","walk":"Walk","run":"Run","takeoff":"JumpTakeoff","rise":"JumpRise","fall":"JumpFall","land":"JumpLand","float":"Float","sit":"Sit","wave":"Wave"},"overlays":["wave"],"motionSpeeds":{"walk":1.05,"run":2.85},"visual":{"representation":"mesh.glb","adapter":"three"},"capabilities":{"locomotion":{"walk":{"referenceSpeed":1.05},"run":{"referenceSpeed":2.85},"jump":true,"fall":true,"land":true,"modes":["duoworld:float"]},"actions":["duoworld:wave","duoworld:sit"],"anchors":["head","neck","chest","back","leftHand","rightHand","leftFoot","rightFoot"]}};

  var PROTOCOL = { name: 'duoworld-avatar', version: '1.1', compatible: ['1.0', '1.1'] };
  var MOTIONS = ['idle', 'walk', 'run'];

  // blend time constants (seconds)
  var BLEND_SECONDS = 0.14; // locomotion cross-fades
  var AIR_BLEND = 0.07; // take-off / air / landing (fast, the World's trajectory does not wait)
  var SIT_BLEND = 0.25;
  var WAVE_BLEND = 0.15;
  // playback-rate limits for the gait cycle (outside them the World is faster / slower than
  // any natural cadence; the avatar then accepts a little foot sliding instead of absurd cadences)
  var MIN_RATE = 0.3;
  var MAX_RATE = 2.2;

  var ACTIONS = {
    'duoworld:wave': { clip: 'wave', layer: 'upper', loop: false },
    'duoworld:sit': { clip: 'sit', layer: 'body', loop: true },
  };
  var ALIASES = { wave: 'duoworld:wave', sit: 'duoworld:sit' };

  // Semantic anchors -> bone + offset in the bone's frame. In the bind (T) pose every bone
  // frame is aligned with the avatar: +Y up, +Z front, +X = the avatar's left.
  var ANCHORS = {
    head: { bone: 'head', offset: [0, 0.11, 0.01] }, // centre of the head
    neck: { bone: 'neck', offset: [0, 0.03, 0] },
    chest: { bone: 'upperChest', offset: [0, 0.02, 0.11] }, // front of the chest
    back: { bone: 'upperChest', offset: [0, 0, -0.14] }, // between the shoulder blades, on the clothing
    leftHand: { bone: 'leftHand', offset: [0.07, 0, 0] }, // palm centre
    rightHand: { bone: 'rightHand', offset: [-0.07, 0, 0] },
    leftFoot: { bone: 'leftFoot', offset: [0, -0.07, 0.04] }, // sole centre
    rightFoot: { bone: 'rightFoot', offset: [0, -0.07, 0.04] },
  };
  var ANCHOR_NAMES = Object.keys(ANCHORS);

  var FLOAT_MODES = { float: true, 'duoworld:float': true, 'zero-g': true, 'duoworld:zero-g': true };

  // Directory of this script, captured synchronously while the script executes.
  // Only used as a fallback when the World does not pass context.baseUrl.
  var scriptBase = '';
  try {
    var current = global.document && global.document.currentScript;
    if (current && current.src) scriptBase = current.src.slice(0, current.src.lastIndexOf('/') + 1);
  } catch (e) {
    /* non-DOM host */
  }

  // ------------------------------------------------------------- registry
  function ensureRegistry() {
    var reg = global.DuoWorldAvatars;
    if (reg && typeof reg.register === 'function') return reg;
    // The World has not created a registry (yet): create a compatible one.
    var definitions = (reg && reg.definitions) || {};
    reg = {
      protocol: 'duoworld-avatar/1',
      protocolVersions: PROTOCOL.compatible.slice(),
      definitions: definitions,
      register: function (definition) {
        if (!definition || typeof definition.id !== 'string' || typeof definition.create !== 'function') {
          throw new Error('DuoWorldAvatars.register: definition needs a string id and a create() function');
        }
        definitions[definition.id] = definition;
        try {
          if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
            global.dispatchEvent(new global.CustomEvent('duoworld:avatar-registered', { detail: { id: definition.id } }));
          }
        } catch (e) {
          /* events are a convenience only */
        }
        return definition;
      },
      get: function (id) {
        return Object.prototype.hasOwnProperty.call(definitions, id) ? definitions[id] : undefined;
      },
      has: function (id) {
        return Object.prototype.hasOwnProperty.call(definitions, id);
      },
      list: function () {
        return Object.keys(definitions).map(function (k) {
          return definitions[k];
        });
      },
    };
    global.DuoWorldAvatars = reg;
    return reg;
  }

  // -------------------------------------------------------------- helpers
  function resolveUrl(baseUrl, file) {
    var base = typeof baseUrl === 'string' && baseUrl.length ? baseUrl : scriptBase;
    if (!base) throw new Error('[' + BUILD.id + '] context.baseUrl is missing and the script URL is unknown');
    if (base.charAt(base.length - 1) !== '/') base += '/';
    return base + file;
  }

  function clamp(x, a, b) {
    return x < a ? a : x > b ? b : x;
  }
  function sstep(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function num(x, fallback) {
    x = Number(x);
    return isFinite(x) ? x : fallback;
  }
  function warnOnce(store, key, msg) {
    if (store[key]) return;
    store[key] = true;
    if (global.console) global.console.warn('[' + BUILD.id + '] ' + msg);
  }
  function actionError(code, message, action) {
    var e = new Error('[' + BUILD.id + '] ' + message);
    e.name = 'DuoWorldAvatarActionError';
    e.code = code;
    e.action = action;
    return e;
  }

  /**
   * Deep clone of a skinned hierarchy (what SkeletonUtils.clone does, but
   * using only the core THREE namespace supplied by the World). Geometries,
   * materials and textures are shared; nodes, bones and skeletons are not,
   * so every avatar instance animates independently even when the World's
   * loadGLTF() returns a cached scene.
   */
  function cloneSkinned(THREE, source) {
    var clone = source.clone(true);
    var src = [];
    var dst = [];
    source.traverse(function (o) {
      src.push(o);
    });
    clone.traverse(function (o) {
      dst.push(o);
    });
    var lookup = new Map();
    for (var i = 0; i < src.length; i++) lookup.set(src[i], dst[i]);
    var skeletons = new Map();
    for (var k = 0; k < src.length; k++) {
      var s = src[k];
      var d = dst[k];
      if (!s.isSkinnedMesh || !s.skeleton) continue;
      var skeleton = skeletons.get(s.skeleton);
      if (!skeleton) {
        var bones = s.skeleton.bones.map(function (b) {
          return lookup.get(b) || b;
        });
        var inverses = s.skeleton.boneInverses.map(function (m) {
          return m.clone();
        });
        skeleton = new THREE.Skeleton(bones, inverses);
        skeletons.set(s.skeleton, skeleton);
      }
      d.bind(skeleton, s.bindMatrix);
    }
    return { root: clone, skeletons: Array.from(skeletons.values()) };
  }

  // GPU resources are shared between instances cloned from the same source,
  // so they are reference counted and only disposed with the last user.
  var refCounts = new WeakMap();
  function retain(res) {
    refCounts.set(res, (refCounts.get(res) || 0) + 1);
  }
  function release(res) {
    var n = (refCounts.get(res) || 0) - 1;
    if (n > 0) {
      refCounts.set(res, n);
      return;
    }
    refCounts.delete(res);
    if (typeof res.dispose === 'function') res.dispose();
  }
  function collectResources(root) {
    var set = new Set();
    root.traverse(function (o) {
      if (!o.isMesh) return;
      if (o.geometry) set.add(o.geometry);
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(function (m) {
        if (!m) return;
        set.add(m);
        for (var key in m) {
          var v = m[key];
          if (v && v.isTexture) set.add(v);
        }
      });
    });
    return Array.from(set);
  }

  function findClip(animations, name) {
    if (!name) return null;
    var want = String(name).toLowerCase();
    for (var i = 0; i < animations.length; i++) {
      if (String(animations[i].name).toLowerCase() === want) return animations[i];
    }
    return null;
  }

  // ========================================================= held rifle
  /**
   * The avatar's own rifle and two-handed hold (Saltline bundle addition; the World knows
   * nothing about either). The rifle hangs from the upper chest, so it follows the torso of
   * whatever clip is playing; after the clips are applied, each arm is bent onto the rifle with
   * an analytic two-bone IK (shoulder → elbow → wrist) and the hand is turned onto its grip.
   * Legs, hips, spine, head and fingers keep their animation. hold(wTrigger, wSupport) blends
   * the arms from the clip pose (0) to the hold (1).
   *
   * Frames are taken from the skeleton's bind pose (boneInverses), not assumed: each bone's
   * length axis is the direction to its child, and its twist reference is the bind-pose
   * "back" (elbow side) / "palm" direction.
   */
  var RIFLE = {
    parent: 'upperChest',
    // rifle origin (= trigger-hand grip) in the upper-chest frame (+Y up, +Z front, +X avatar's left)
    origin: [-0.15, -0.03, 0.27],
    colors: { body: 0x4b3d63, dark: 0x1f1c27, accent: 0xc9a2e6, metal: 0x9a98a6, wood: 0x7d5a3c },
    arms: {
      // grip: point in the rifle frame the palm closes on; finger / palm: wanted directions in
      // avatar space; pole: where the elbow points
      trigger: { upper: 'rightUpperArm', lower: 'rightLowerArm', hand: 'rightHand', grip: [0, 0, 0], finger: [0.12, -0.55, 0.82], palm: [1, 0, 0.1], pole: [-1, -0.75, -0.35], palmDepth: 0.028 },
      support: { upper: 'leftUpperArm', lower: 'leftLowerArm', hand: 'leftHand', grip: [0, 0.055, 0.14], finger: [-0.3, 0.05, 0.95], palm: [-0.35, 1, 0], pole: [0.6, -1, -0.2], palmDepth: 0.03 },
    },
    palmLength: 0.07, // wrist → palm centre (the rightHand / leftHand anchor offset)
  };

  function createRifle(THREE, bones, skeletons, avatarRoot) {
    var parent = bones[RIFLE.parent];
    if (!parent) return null;
    var V = THREE.Vector3;
    var Q = THREE.Quaternion;

    // bind-pose rotation of every bone in model space
    var bindQ = function (bone) {
      for (var i = 0; i < skeletons.length; i++) {
        var k = skeletons[i].bones.indexOf(bone);
        if (k >= 0) {
          var m = skeletons[i].boneInverses[k].clone().invert();
          var p = new V(), q = new Q(), s = new V();
          m.decompose(p, q, s);
          return q;
        }
      }
      return new Q();
    };
    var childDir = function (bone, fallback) {
      for (var i = 0; i < bone.children.length; i++) {
        var c = bone.children[i];
        if (c.isBone && c.position.lengthSq() > 1e-8) return c.position.clone().normalize();
      }
      return fallback.clone();
    };

    var arms = [];
    for (var key in RIFLE.arms) {
      var spec = RIFLE.arms[key];
      var upper = bones[spec.upper], lower = bones[spec.lower], hand = bones[spec.hand];
      if (!upper || !lower || !hand) return null;
      var dirU = lower.position.clone().normalize();
      var dirL = hand.position.clone().normalize();
      var dirH = childDir(hand, dirL);
      var bu = bindQ(upper).invert(), bl = bindQ(lower).invert(), bh = bindQ(hand).invert();
      arms.push({
        upper: upper, lower: lower, hand: hand,
        lenU: lower.position.length(), lenL: hand.position.length(),
        // local axes: bone length axis + twist reference (bind-pose back of the arm / palm)
        axU: dirU, refU: new V(0, 0, -1).applyQuaternion(bu),
        axL: dirL, refL: new V(0, 0, -1).applyQuaternion(bl),
        axH: dirH, refH: new V(0, -1, 0).applyQuaternion(bh),
        grip: new V().fromArray(spec.grip),
        finger: new V().fromArray(spec.finger).normalize(),
        palm: new V().fromArray(spec.palm).normalize(),
        pole: new V().fromArray(spec.pole).normalize(),
        palmDepth: spec.palmDepth,
      });
    }

    // ---- the rifle: a few bevel-free blocks and cylinders, lilac and plum like the outfit
    var C = RIFLE.colors;
    var mat = function (hex, metal) {
      return new THREE.MeshStandardMaterial({ color: hex, roughness: metal ? 0.4 : 0.7, metalness: metal ? 0.6 : 0.05 });
    };
    var M = { body: mat(C.body), dark: mat(C.dark), accent: mat(C.accent), metal: mat(C.metal, true), wood: mat(C.wood) };
    var gun = new THREE.Group();
    gun.name = BUILD.id + ':rifle';
    gun.position.fromArray(RIFLE.origin);
    var geoms = [];
    var add = function (g, m, at, rx) {
      if (rx) g.rotateX(rx);
      g.translate(at[0], at[1], at[2]);
      geoms.push(g);
      var mesh = new THREE.Mesh(g, M[m]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      gun.add(mesh);
    };
    var box = function (lo, hi, m) {
      add(new THREE.BoxGeometry(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), m, [(hi[0] + lo[0]) / 2, (hi[1] + lo[1]) / 2, (hi[2] + lo[2]) / 2]);
    };
    var tube = function (r, z0, z1, y, m) {
      add(new THREE.CylinderGeometry(r, r, z1 - z0, 14), m, [0, y, (z0 + z1) / 2], Math.PI / 2);
    };
    box([-0.018, -0.05, -0.03], [0.018, 0.05, 0.02], 'dark'); // pistol grip
    box([-0.03, 0.045, -0.1], [0.03, 0.118, 0.1], 'body'); // receiver
    box([-0.032, 0.07, -0.06], [0.032, 0.085, 0.07], 'accent'); // side stripe
    box([-0.022, 0.04, -0.2], [0.022, 0.105, -0.1], 'wood'); // stock
    box([-0.026, 0.03, -0.225], [0.026, 0.115, -0.2], 'dark'); // butt pad
    box([-0.02, -0.07, 0.03], [0.02, 0.05, 0.075], 'dark'); // magazine
    tube(0.03, 0.1, 0.34, 0.085, 'dark'); // handguard
    tube(0.032, 0.3, 0.315, 0.085, 'accent'); // handguard band
    tube(0.011, 0.34, 0.54, 0.088, 'metal'); // barrel
    tube(0.018, 0.52, 0.57, 0.088, 'dark'); // muzzle
    box([-0.01, 0.118, -0.04], [0.01, 0.145, 0.03], 'metal'); // rear sight
    box([-0.006, 0.115, 0.31], [0.006, 0.14, 0.325], 'metal'); // front sight
    parent.add(gun);

    // ---- per-frame scratch
    var v1 = new V(), v2 = new V(), S = new V(), W = new V(), E = new V(), T = new V(), n = new V(), m = new V();
    var dir = new V(), ref = new V(), modelQ = new Q(), pq = new Q(), want = new Q(), tmp = new Q();
    var L = new THREE.Matrix4(), Wm = new THREE.Matrix4(), z = new V(), z2 = new V();
    var scale = new V();

    // world rotation that maps the local (axis, ref) pair onto the world (dirW, refW) pair
    function frame(axis, refLocal, dirW, refW, out) {
      v1.copy(refLocal).addScaledVector(axis, -refLocal.dot(axis)).normalize();
      z.crossVectors(axis, v1);
      L.makeBasis(axis, v1, z);
      v2.copy(refW).addScaledVector(dirW, -refW.dot(dirW));
      if (v2.lengthSq() < 1e-8) v2.set(0, 1, 0).addScaledVector(dirW, -dirW.y);
      v2.normalize();
      z2.crossVectors(dirW, v2);
      Wm.makeBasis(dirW, v2, z2);
      Wm.multiply(L.transpose());
      return out.setFromRotationMatrix(Wm);
    }
    // turn `bone` (world rotation `worldQ`) and blend its local rotation by w
    function setWorld(bone, worldQ, w) {
      bone.parent.getWorldQuaternion(pq);
      tmp.copy(pq).invert().multiply(worldQ);
      bone.quaternion.slerp(tmp, w);
      bone.updateMatrixWorld(true);
    }

    function solve(a, w) {
      if (!(w > 1e-3)) return;
      a.upper.getWorldPosition(S);
      gun.localToWorld(T.copy(a.grip));
      var k = scale.x;
      // wrist target: back off from the grip along the fingers, and out of the grip along the palm
      ref.copy(a.finger).applyQuaternion(modelQ); // finger direction (world)
      dir.copy(a.palm).applyQuaternion(modelQ); // palm normal (world)
      W.copy(T).addScaledVector(ref, -RIFLE.palmLength * k).addScaledVector(dir, -a.palmDepth * k);
      var lu = a.lenU * k, ll = a.lenL * k;
      n.subVectors(W, S);
      var d = Math.min(Math.max(n.length(), Math.abs(lu - ll) + 1e-4), (lu + ll) * 0.999);
      n.normalize();
      m.copy(a.pole).applyQuaternion(modelQ);
      m.addScaledVector(n, -m.dot(n));
      if (m.lengthSq() < 1e-8) m.set(0, -1, 0).addScaledVector(n, -n.y);
      m.normalize();
      var cosA = (lu * lu + d * d - ll * ll) / (2 * lu * d);
      var sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
      E.copy(S).addScaledVector(n, lu * cosA).addScaledVector(m, lu * sinA);
      W.copy(S).addScaledVector(n, d);
      // upper arm: towards the elbow, back of the arm towards the pole
      setWorld(a.upper, frame(a.axU, a.refU, v1.subVectors(E, S).normalize().clone(), m, want), w);
      // forearm: towards the wrist, same twist reference
      a.lower.getWorldPosition(E);
      setWorld(a.lower, frame(a.axL, a.refL, v1.subVectors(W, E).normalize().clone(), m, want), w);
      // hand: fingers along the grip, palm onto it
      setWorld(a.hand, frame(a.axH, a.refH, ref.clone(), dir.clone(), want), w);
    }

    return {
      object3D: gun,
      /** wT / wS: trigger / support arm blend weights in 0..1; called after the clips were applied */
      hold: function (wT, wS) {
        gun.visible = Math.max(wT, wS) > 0.4;
        if (!(wT > 1e-3) && !(wS > 1e-3)) return;
        // avatar space (+Y up, +Z front) → world: the visual root's world rotation / scale
        avatarRoot.getWorldQuaternion(modelQ);
        avatarRoot.getWorldScale(scale);
        // the rifle rides on the upper chest but stays level with the avatar (it does not dip
        // with the run lean or the idle sway)
        parent.getWorldQuaternion(pq);
        gun.quaternion.copy(pq.invert().multiply(modelQ));
        gun.updateWorldMatrix(true, false);
        solve(arms[0], wT);
        solve(arms[1], wS);
      },
      dispose: function () {
        if (gun.parent) gun.parent.remove(gun);
        geoms.forEach(function (g) {
          g.dispose();
        });
        for (var k in M) M[k].dispose();
      },
    };
  }

  // ======================================================= visual adapter
  /**
   * Representation "mesh.glb" on adapter "three". The behaviour layer talks to it only
   * through this small interface, so another representation (splats, hybrid ...) can be
   * dropped in later without touching locomotion / action logic:
   *   has(channel) · duration(channel) · pose({channel: {time, weight}}) · overlay(channel, time, weight)
   *   anchor(name) · object3D · dispose()
   */
  function createThreeMeshVisual(THREE, gltf) {
    var animations = gltf.animations || [];
    var clips = {};
    for (var key in BUILD.clips) {
      var clip = findClip(animations, BUILD.clips[key]);
      if (clip) clips[key] = clip;
    }
    MOTIONS.forEach(function (motion) {
      // never pretend a motion exists: fail loudly instead of silently standing still
      if (!clips[motion]) throw new Error('[' + BUILD.id + '] model has no "' + BUILD.clips[motion] + '" animation clip for motion "' + motion + '"');
    });

    var cloned = cloneSkinned(THREE, gltf.scene);
    var model = cloned.root;
    model.name = BUILD.id + ':model';

    // Adapter node handed to the World. The model is already authored in the
    // DuoWorld convention (+Y up, +Z front, metres, origin on the ground
    // between the feet), so the adapter is an identity transform; it exists
    // so the World can freely move / rotate / scale object3D without
    // touching anything the animation system writes to.
    var object3D = new THREE.Group();
    object3D.name = 'DuoWorldAvatar:' + BUILD.id;
    object3D.add(model);

    var bones = {};
    model.traverse(function (o) {
      if (o.isBone && !bones[o.name]) bones[o.name] = o;
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      // bounds of a skinned mesh are those of the bind pose; never cull the avatar by them
      o.frustumCulled = false;
    });
    var resources = collectResources(model);
    resources.forEach(retain);
    // per-instance rifle (not shared, not reference counted)
    var rifle = createRifle(THREE, bones, cloned.skeletons, object3D);

    // full-body clips go through the mixer (weights normalised per bone);
    // overlay clips (keyed on a few bones only) are applied on top afterwards
    var mixer = new THREE.AnimationMixer(model);
    var actions = {};
    var overlays = {};
    Object.keys(clips).forEach(function (ch) {
      if ((BUILD.overlays || []).indexOf(ch) >= 0) {
        overlays[ch] = clips[ch].tracks
          .map(function (track) {
            var parsed = THREE.PropertyBinding.parseTrackName(track.name);
            var target = bones[parsed.nodeName] || model.getObjectByName(parsed.nodeName);
            if (!target || parsed.propertyName !== 'quaternion') return null;
            return { target: target, interpolant: track.createInterpolant(), q: new THREE.Quaternion() };
          })
          .filter(Boolean);
        return;
      }
      var action = mixer.clipAction(clips[ch]);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      action.setEffectiveWeight(ch === 'idle' ? 1 : 0);
      actions[ch] = action;
    });

    var anchors = {};
    var disposed = false;

    return {
      object3D: object3D,
      has: function (ch) {
        return !!clips[ch];
      },
      duration: function (ch) {
        return clips[ch] ? clips[ch].duration : 0;
      },
      /** channels: { name: { time, weight } } — absolute times, weights already normalised */
      pose: function (channels) {
        for (var ch in actions) {
          var c = channels[ch];
          var a = actions[ch];
          var w = c ? c.weight : 0;
          // keep the time strictly inside the clip so LoopRepeat never wraps a clamped one-shot
          a.time = c ? clamp(c.time, 0, clips[ch].duration - 1e-4) : 0;
          a.setEffectiveWeight(w);
        }
        mixer.update(0);
      },
      overlay: function (ch, time, weight) {
        var list = overlays[ch];
        if (!list || !(weight > 0)) return;
        var t = time % clips[ch].duration;
        for (var i = 0; i < list.length; i++) {
          var o = list[i];
          var r = o.interpolant.evaluate(t);
          o.q.set(r[0], r[1], r[2], r[3]);
          o.target.quaternion.slerp(o.q, weight);
        }
      },
      anchor: function (name) {
        if (disposed || !Object.prototype.hasOwnProperty.call(ANCHORS, name)) return null;
        if (anchors[name]) return anchors[name];
        var spec = ANCHORS[name];
        var bone = bones[spec.bone];
        if (!bone) return null;
        var node = new THREE.Object3D();
        node.name = 'anchor:' + name;
        node.position.fromArray(spec.offset);
        bone.add(node);
        anchors[name] = node;
        return node;
      },
      /** two-handed rifle hold on top of the clip pose: 0 = clip arms, 1 = holding */
      hold: function (wTrigger, wSupport) {
        if (rifle && !disposed) rifle.hold(wTrigger, wSupport);
      },
      hasAnchor: function (name) {
        return Object.prototype.hasOwnProperty.call(ANCHORS, name) && !!bones[ANCHORS[name].bone];
      },
      dispose: function () {
        if (disposed) return;
        disposed = true;
        mixer.stopAllAction();
        mixer.uncacheRoot(model);
        if (rifle) rifle.dispose();
        if (object3D.parent) object3D.parent.remove(object3D);
        cloned.skeletons.forEach(function (s) {
          s.dispose();
        });
        // only the avatar's own resources are released; whatever the World attached
        // to an anchor stays the World's to manage
        resources.forEach(release);
        resources.length = 0;
      },
    };
  }

  // ============================================================ behaviour
  /** Renderer-agnostic locomotion + action state machine driving a visual adapter. */
  function createBehavior(visual) {
    var REF = { walk: BUILD.motionSpeeds.walk, run: BUILD.motionSpeeds.run };
    var DUR = { walk: visual.duration('walk'), run: visual.duration('run') };
    var can = {
      jump: visual.has('takeoff') && visual.has('rise'),
      fall: visual.has('fall'),
      land: visual.has('land'),
      float: visual.has('float'),
    };

    // ---- what the World asked for (last write wins: setMotion or setLocomotion)
    var target = { grounded: true, speed: 0, vy: 0, phase: 'grounded', float: false };

    // ---- internal state
    var speed = 0; // smoothed horizontal speed used for the blend weights
    var gaitPhase = 0; // shared by walk + run so the feet stay in step while blending
    var idleTime = 0;
    var air = 'ground'; // ground | takeoff | air | land
    var tTake = 0;
    var tAir = 0;
    var tLand = 0;
    var landStrength = 1;
    var lastAirVy = 0;
    var weights = { idle: 1 };
    var layers = { body: null, upper: null }; // running actions
    var sitTime = 0;
    var disposed = false;
    var warned = {};

    function gaitWeights(s) {
      var g = sstep(0.05, 0.4, s);
      var r = sstep(0, 1, (s - REF.walk) / (REF.run - REF.walk));
      return { idle: 1 - g, walk: g * (1 - r), run: g * r, g: g, r: r };
    }

    function phaseOf(state) {
      var p = state.phase;
      if (p === 'grounded' || p === 'takeoff' || p === 'airborne' || p === 'landing') return p;
      return state.grounded === false ? 'airborne' : 'grounded';
    }

    function setLocomotion(state) {
      if (disposed || !state || typeof state !== 'object') return;
      var v = state.velocity || {};
      var vx = num(v.x, 0);
      var vz = num(v.z, 0);
      var p = phaseOf(state);
      var mode = typeof state.mode === 'string' ? state.mode : '';
      if (mode && !FLOAT_MODES[mode] && mode !== 'duoworld:walk' && mode !== 'walk') {
        warnOnce(warned, 'mode:' + mode, 'locomotion mode "' + mode + '" is not supported; using the phase / velocity only');
      }
      // optional hint: magnitude of the World's gravity (number in m/s^2 or a vector)
      var gHint = state.gravity;
      var gMag = typeof gHint === 'number' ? Math.abs(gHint) : gHint && typeof gHint === 'object' ? Math.hypot(num(gHint.x, 0), num(gHint.y, 0), num(gHint.z, 0)) : NaN;
      target = {
        grounded: p === 'grounded' || p === 'landing',
        // horizontal speed: the World's value wins; otherwise derived from the velocity
        speed: Math.max(0, num(state.speed, Math.hypot(vx, vz))),
        vy: num(v.y, 0),
        phase: p,
        float: !!FLOAT_MODES[mode] || (isFinite(gMag) && gMag < 0.3),
      };
    }

    function setMotion(next) {
      if (disposed) return;
      if (MOTIONS.indexOf(next) < 0) {
        warnOnce(warned, 'motion:' + next, 'unsupported motion "' + next + '" (setMotion supports: ' + MOTIONS.join(', ') + '; use setLocomotion() for jumps)');
        return;
      }
      // a v1 World: the motion name stands for "on the ground at the reference speed"
      target = { grounded: true, speed: next === 'idle' ? 0 : REF[next], vy: 0, phase: 'grounded', float: false };
    }

    // -------------------------------------------------------------- actions
    function normalise(name) {
      var n = String(name);
      return ALIASES[n] || n;
    }
    function supportedActions() {
      return Object.keys(ACTIONS).filter(function (n) {
        return visual.has(ACTIONS[n].clip);
      });
    }

    function finish(act) {
      if (layers[act.layer] === act) layers[act.layer] = null;
      act.resolve();
    }

    function playAction(name, options) {
      var id = normalise(name);
      if (disposed) return Promise.reject(actionError('AVATAR_DISPOSED', 'playAction("' + name + '") after dispose()', id));
      var spec = ACTIONS[id];
      if (!spec || !visual.has(spec.clip)) {
        return Promise.reject(actionError('ACTION_UNSUPPORTED', 'action "' + name + '" is not supported by this avatar (supported: ' + supportedActions().join(', ') + ')', id));
      }
      options = options || {};
      var params = options.params || {};
      var prev = layers[spec.layer];
      return new Promise(function (resolve) {
        var act = {
          id: id,
          layer: spec.layer,
          loop: options.loop === undefined ? spec.loop : !!options.loop,
          params: params,
          elapsed: 0,
          weight: prev && prev.id === id ? prev.weight : 0, // replacing the same action: no pop
          stopping: false,
          resolve: resolve,
        };
        if (prev) finish(prev); // a new action on the same layer replaces the old one (its promise settles)
        if (id === 'duoworld:sit' && !(prev && prev.id === id)) sitTime = 0;
        layers[spec.layer] = act;
      });
    }

    function stopAction(name) {
      var id = name === undefined ? null : normalise(name);
      var waits = [];
      ['body', 'upper'].forEach(function (layer) {
        var act = layers[layer];
        if (!act || (id && act.id !== id)) return;
        act.stopping = true; // fades back to locomotion; settles when the fade is done
        waits.push(
          new Promise(function (r) {
            var done = act.resolve;
            act.resolve = function () {
              done();
              r();
            };
          }),
        );
      });
      return Promise.all(waits).then(function () {});
    }

    // ---------------------------------------------------------------- clock
    function update(deltaSeconds) {
      if (disposed) return;
      var dt = Number(deltaSeconds);
      if (!(dt > 0)) dt = 0;
      if (dt > 0.25) dt = 0.25; // tab was in the background: do not jump

      // ---- jump / air / landing state, driven only by the World's phase
      var p = target.phase;
      if (!can.jump && (p === 'takeoff' || p === 'airborne')) {
        warnOnce(warned, 'jump', 'model has no jump clips; staying in the ground motions');
        p = 'grounded';
      }
      if (p === 'takeoff') {
        if (air !== 'takeoff') (air = 'takeoff'), (tTake = 0);
      } else if (p === 'airborne') {
        if (air !== 'air') (air = 'air'), (tAir = 0);
        lastAirVy = target.vy;
      } else if (p === 'landing' || air === 'air' || air === 'takeoff') {
        if (air !== 'land') {
          air = can.land ? 'land' : 'ground';
          tLand = 0;
          // a harder impact (World-reported vertical speed) gives a deeper cushion; no gravity is assumed
          var impact = Math.max(0, -lastAirVy);
          landStrength = lastAirVy === 0 ? 0.8 : 0.35 + 0.65 * sstep(0.2, 4, impact);
          lastAirVy = 0;
        }
      }
      if (air === 'land' && p !== 'landing' && tLand >= visual.duration('land')) air = 'ground';

      // ---- speed: weights follow a smoothed speed, cadence follows the World's real speed
      var kSpeed = 1 - Math.exp(-dt / BLEND_SECONDS);
      speed += (target.speed - speed) * kSpeed;
      if (Math.abs(target.speed - speed) < 1e-4) speed = target.speed;
      var gw = gaitWeights(speed);
      var ref = REF.walk + (REF.run - REF.walk) * gw.r;
      var rate = clamp(target.speed / ref, MIN_RATE, MAX_RATE);
      var cycle = DUR.walk + (DUR.run - DUR.walk) * gw.r;

      // ---- actions
      var body = layers.body;
      if (body) {
        body.elapsed += dt;
        // movement always wins over a non-movement action: if the World moves or leaves the
        // ground, the avatar stands up and the action ends (World state is never overridden)
        if (!body.stopping && (target.speed > 0.3 || air !== 'ground')) body.stopping = true;
        if (!body.loop && !body.stopping && body.elapsed >= num(body.params.duration, 2.5)) body.stopping = true;
      }
      var upper = layers.upper;
      if (upper) {
        upper.elapsed += dt;
        var cycles = Math.max(1, num(upper.params.cycles, 2));
        if (!upper.loop && !upper.stopping && upper.elapsed >= cycles * visual.duration('wave') - WAVE_BLEND * 2) upper.stopping = true;
        upper.weight += ((upper.stopping ? 0 : 1) - upper.weight) * (1 - Math.exp(-dt / WAVE_BLEND));
        if (upper.stopping && upper.weight < 0.01) finish(upper);
      }

      // ---- target weights
      var t = {};
      var sitOn = body && !body.stopping ? 1 : 0;
      t.idle = gw.idle;
      t.walk = gw.walk;
      t.run = gw.run;
      if (visual.has('sit')) {
        for (var k0 in t) t[k0] *= 1 - sitOn;
        t.sit = sitOn;
      }
      var tau = BLEND_SECONDS;
      if (air === 'takeoff' || air === 'air') {
        for (var k1 in t) t[k1] = 0;
        if (air === 'takeoff') t.takeoff = 1;
        else if (target.float && can.float) t.float = 1;
        else {
          var rise = can.fall ? sstep(-0.4, 0.4, target.vy) : 1;
          t.rise = rise;
          if (can.fall) t.fall = 1 - rise;
        }
        tau = AIR_BLEND;
      } else if (air === 'land') {
        var u = tLand / visual.duration('land');
        var L = landStrength * (1 - 0.6 * gw.g) * (1 - sstep(0.55, 1, u));
        for (var k2 in t) t[k2] *= 1 - L;
        t.land = L;
        tau = AIR_BLEND;
      }

      var kw = 1 - Math.exp(-dt / tau);
      var kSit = 1 - Math.exp(-dt / SIT_BLEND);
      var sum = 0;
      var all = {};
      for (var a in weights) all[a] = true;
      for (var b in t) all[b] = true;
      for (var ch in all) {
        var w = weights[ch] || 0;
        w += ((t[ch] || 0) - w) * (ch === 'sit' ? kSit : kw);
        if (w < 1e-4) w = 0;
        weights[ch] = w;
        sum += w;
      }
      if (sum < 1e-6) (weights.idle = 1), (sum = 1);
      for (var c2 in weights) weights[c2] /= sum;
      if (body && body.stopping && (weights.sit || 0) < 0.02) finish(body);

      // ---- clocks
      idleTime += dt;
      // fully idle: hold the gait at phase 0, so every walk / run starts from the same foot
      gaitPhase = gw.g < 1e-3 ? 0 : (gaitPhase + (dt * rate) / cycle) % 1;
      tTake += dt;
      tAir += dt;
      tLand += dt;
      sitTime += dt;

      render();
    }

    function render() {
      visual.pose({
        idle: { time: idleTime % visual.duration('idle'), weight: weights.idle || 0 },
        walk: { time: gaitPhase * DUR.walk, weight: weights.walk || 0 },
        run: { time: gaitPhase * DUR.run, weight: weights.run || 0 },
        takeoff: { time: tTake, weight: weights.takeoff || 0 },
        rise: { time: tAir % (visual.duration('rise') || 1), weight: weights.rise || 0 },
        fall: { time: tAir % (visual.duration('fall') || 1), weight: weights.fall || 0 },
        float: { time: tAir % (visual.duration('float') || 1), weight: weights.float || 0 },
        land: { time: tLand, weight: weights.land || 0 },
        sit: { time: sitTime % (visual.duration('sit') || 1), weight: weights.sit || 0 },
      });
      // both hands on the rifle, except while sitting (the wave overlay below takes the right arm)
      var holdW = 1 - (weights.sit || 0);
      visual.hold(holdW, holdW);
      var up = layers.upper;
      if (up) visual.overlay('wave', up.elapsed, up.weight);
    }

    function capabilities() {
      var loco = { walk: { referenceSpeed: REF.walk }, run: { referenceSpeed: REF.run }, jump: can.jump, fall: can.fall, land: can.land };
      if (can.float) loco.modes = ['duoworld:float'];
      return {
        locomotion: loco,
        actions: supportedActions(),
        anchors: ANCHOR_NAMES.filter(function (n) {
          return visual.hasAnchor(n);
        }),
      };
    }

    /** Read-only diagnostics (not part of the protocol; for tests / debugging tools). */
    function inspect() {
      var w = {};
      for (var k in weights) if (weights[k] > 1e-3) w[k] = +weights[k].toFixed(3);
      var ref = REF.walk + (REF.run - REF.walk) * gaitWeights(speed).r;
      return {
        air: air,
        phase: target.phase,
        speed: target.speed,
        gaitPhase: gaitPhase,
        idleTime: idleTime,
        playbackRate: clamp(target.speed / ref, MIN_RATE, MAX_RATE),
        weights: w,
        actions: ['body', 'upper']
          .filter(function (l) {
            return layers[l];
          })
          .map(function (l) {
            return layers[l].id;
          }),
      };
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      ['body', 'upper'].forEach(function (l) {
        if (layers[l]) finish(layers[l]); // pending action promises settle, nothing hangs
      });
    }

    render(); // first frame already shows the idle pose
    return {
      setMotion: setMotion,
      setLocomotion: setLocomotion,
      update: update,
      playAction: playAction,
      stopAction: stopAction,
      capabilities: capabilities,
      inspect: inspect,
      dispose: dispose,
    };
  }

  // --------------------------------------------------------------- create
  function create(context) {
    if (!context || !context.THREE || typeof context.loadGLTF !== 'function') {
      return Promise.reject(new Error('[' + BUILD.id + '] create(context) needs context.THREE and context.loadGLTF'));
    }
    var THREE = context.THREE;
    var url = resolveUrl(context.baseUrl, BUILD.model);

    return Promise.resolve(context.loadGLTF(url)).then(function (gltf) {
      if (!gltf || !gltf.scene) throw new Error('[' + BUILD.id + '] loadGLTF("' + url + '") returned no scene');
      var visual = createThreeMeshVisual(THREE, gltf);
      var behavior = createBehavior(visual);
      var disposed = false;

      return {
        // ---- DuoWorld Avatar 1.0
        object3D: visual.object3D,
        setMotion: behavior.setMotion,
        update: behavior.update,
        dispose: function () {
          if (disposed) return;
          disposed = true;
          behavior.dispose();
          visual.dispose();
        },
        // ---- DuoWorld Avatar 1.1 (all optional for Worlds)
        protocol: PROTOCOL.version,
        capabilities: behavior.capabilities(),
        visual: { representation: BUILD.visual.representation, adapter: BUILD.visual.adapter, object3D: visual.object3D },
        setLocomotion: behavior.setLocomotion,
        playAction: behavior.playAction,
        stopAction: behavior.stopAction,
        getAnchor: function (name) {
          return disposed ? null : visual.anchor(name);
        },
        inspect: behavior.inspect,
      };
    });
  }

  ensureRegistry().register({
    id: BUILD.id,
    version: BUILD.version,
    metadata: {
      name: BUILD.name,
      height: BUILD.height,
      radius: BUILD.radius,
      // optional hint (kept from 1.0): ground speed in m/s at which the walk / run
      // cycles show no foot sliding; the avatar adapts to any other World speed
      motionSpeeds: BUILD.motionSpeeds,
    },
    // ---- 1.1 additions
    protocol: PROTOCOL,
    identity: { id: BUILD.id, version: BUILD.version, name: BUILD.name, height: BUILD.height, radius: BUILD.radius },
    visual: { representation: BUILD.visual.representation, adapter: BUILD.visual.adapter },
    // static summary; the authoritative runtime set is instance.capabilities
    capabilities: BUILD.capabilities,
    create: create,
  });
})(typeof window !== 'undefined' ? window : globalThis);
