// Procedurally builds the blocky rigid-part avatar models shipped in public/avatars/:
//   node scripts/build-avatar-models.mjs            → writes <id>/model.glb for every design below
//   node scripts/build-avatar-models.mjs --check    → only prints the measured sizes
//
// The models mirror the structure of violet-girl/model.glb: one box mesh per rigid part, a
// pelvis → chest → head / upperarm_l / upperarm_r and pelvis → thigh_l / thigh_r node tree, an
// empty hand_r_socket anchor node, and node (TRS) animation clips named
// idle, walk, run, jump, fall, land, wave. Every design is built to the same overall height
// (feet at y = 0, top of the head/hat at DESIGN_HEIGHT), facing +Z, 1 unit = 1 m.
import { writeFileSync, existsSync } from "node:fs";
import { buildRigidGLB, writeGLB, srgb } from "./lib/glb.mjs";

const DESIGN_HEIGHT = 1.6;
const AVATARS = new URL("../public/avatars/", import.meta.url);

// ---------------------------------------------------------------- designs
// All lengths in metres. `extras` are decorative boxes attached to a named part
// ([parent, name, translation, [min, max], material, rotation?]).
const DESIGNS = [
  {
    id: "blue-captain",
    root: "BlueCaptain",
    gender: "male",
    torso: { h: 0.52, w: 0.44, d: 0.26 },
    head: { s: 0.29 },
    arm: { len: 0.5, w: 0.14, x: 0.3 },
    leg: { w: 0.16, x: 0.11 },
    foot: { h: 0.09, l: 0.26 },
    stride: 1.1,
    mats: {
      coat: 0x1f2f5c, skin: 0xe0ac84, hair: 0x3a2618, eye: 0x101014, trousers: 0x1a1c24,
      boots: 0x14110e, gold: 0xd9a63a, hat: 0xf2f0ea, brim: 0x15161c, beard: 0xa8a39a,
    },
    parts: { torso: "coat", arm: "coat", hand: "skin", leg: "trousers", foot: "boots", head: "skin", hair: "hair", eye: "eye" },
    hair: false,
    extras: [
      ["head", "beard", [0, 0.02, 0.13], [[-0.13, 0, -0.02], [0.13, 0.09, 0.03]], "beard"],
      ["head", "hat_band", [0, 0.25, 0], [[-0.17, 0, -0.17], [0.17, 0.05, 0.17]], "brim"],
      ["head", "hat_brim", [0, 0.25, 0.06], [[-0.19, 0, -0.12], [0.19, 0.02, 0.17]], "brim"],
      ["head", "hat_crown", [0, 0.3, -0.01], [[-0.19, 0, -0.19], [0.19, 0.08, 0.19]], "hat"],
      ["head", "hat_badge", [0, 0.27, 0.175], [[-0.04, 0, 0], [0.04, 0.07, 0.015]], "gold"],
      ["chest", "coat_buttons", [0, 0.08, 0.13], [[-0.05, 0, 0], [0.05, 0.4, 0.012]], "gold"],
      ["chest", "epaulette_l", [-0.22, 0.48, 0], [[-0.07, 0, -0.08], [0.06, 0.04, 0.08]], "gold"],
      ["chest", "epaulette_r", [0.22, 0.48, 0], [[-0.06, 0, -0.08], [0.07, 0.04, 0.08]], "gold"],
      ["pelvis", "coat_tail", [0, 0.04, 0], [[-0.23, -0.3, -0.145], [0.23, 0, 0.145]], "coat"],
    ],
  },
  {
    id: "orange-mechanic",
    root: "OrangeMechanic",
    gender: "male",
    torso: { h: 0.56, w: 0.42, d: 0.26 },
    head: { s: 0.3 },
    arm: { len: 0.5, w: 0.14, x: 0.29 },
    leg: { w: 0.16, x: 0.11 },
    foot: { h: 0.1, l: 0.26 },
    stride: 1.1,
    mats: {
      suit: 0xe07a1f, skin: 0xc98d63, hair: 0x2a1d14, eye: 0x101014, glove: 0x4a4d52,
      boots: 0x3b3f45, belt: 0x5a3b22, strap: 0x222326, lens: 0x58d0e0, pack: 0x6d7378,
    },
    parts: { torso: "suit", arm: "suit", hand: "glove", leg: "suit", foot: "boots", head: "skin", hair: "hair", eye: "eye" },
    hair: { h: 0.12, w: 0.33 },
    extras: [
      ["head", "hair_spike_a", [-0.07, 0.3, 0], [[-0.05, 0, -0.05], [0.05, 0.07, 0.05]], "hair"],
      ["head", "hair_spike_b", [0.06, 0.3, -0.03], [[-0.05, 0, -0.05], [0.05, 0.06, 0.05]], "hair"],
      ["head", "goggle_band", [0, 0.235, 0], [[-0.17, 0, -0.17], [0.17, 0.04, 0.17]], "strap"],
      ["head", "goggle_l", [-0.065, 0.225, 0.165], [[-0.045, 0, 0], [0.045, 0.06, 0.03]], "lens"],
      ["head", "goggle_r", [0.065, 0.225, 0.165], [[-0.045, 0, 0], [0.045, 0.06, 0.03]], "lens"],
      ["chest", "chest_pocket", [0.09, 0.3, 0.13], [[-0.06, 0, 0], [0.06, 0.09, 0.015]], "belt"],
      ["chest", "tool_pack", [0, 0.16, -0.13], [[-0.16, 0, -0.12], [0.16, 0.3, 0]], "pack"],
      ["pelvis", "tool_belt", [0, -0.03, 0], [[-0.22, 0, -0.14], [0.22, 0.08, 0.14]], "belt"],
      ["pelvis", "belt_pouch", [0.18, -0.08, 0.06], [[-0.05, 0, -0.04], [0.05, 0.09, 0.05]], "belt"],
    ],
  },
  {
    id: "jade-swordswoman",
    root: "JadeSwordswoman",
    gender: "female",
    torso: { h: 0.5, w: 0.36, d: 0.23 },
    head: { s: 0.3 },
    arm: { len: 0.47, w: 0.12, x: 0.25 },
    leg: { w: 0.14, x: 0.1 },
    foot: { h: 0.08, l: 0.23 },
    stride: 1,
    mats: {
      robe: 0x2f8f6f, skin: 0xf0c7a4, hair: 0x14100e, eye: 0x101014, sash: 0xb3262e,
      trim: 0xe8e2cf, boots: 0x1d3a30, steel: 0xb8c0c8, hilt: 0x6b3a1e,
    },
    parts: { torso: "robe", arm: "robe", hand: "skin", leg: "boots", foot: "boots", head: "skin", hair: "hair", eye: "eye" },
    hair: { h: 0.135, w: 0.34 },
    extras: [
      ["head", "hair_bun", [0, 0.3, -0.04], [[-0.08, 0, -0.08], [0.08, 0.13, 0.08]], "hair"],
      ["head", "hair_pin", [0, 0.37, -0.04], [[-0.12, 0, -0.01], [0.12, 0.02, 0.01]], "steel"],
      ["head", "ponytail", [0, 0.27, -0.16], [[-0.05, -0.36, -0.04], [0.05, 0, 0.03]], "hair"],
      ["chest", "robe_collar", [0, 0.36, 0.115], [[-0.06, 0, 0], [0.06, 0.14, 0.012]], "trim"],
      ["chest", "sash", [0, 0, 0], [[-0.19, 0, -0.125], [0.19, 0.07, 0.125]], "sash"],
      // sword on the back, tilted across the shoulders
      ["chest", "sword", [0.02, 0.26, -0.15], [[-0.025, -0.36, -0.015], [0.025, 0.36, 0.015]], "steel", [0, 0, 0.3827, 0.9239]],
      ["chest", "sword_hilt", [-0.13, 0.57, -0.15], [[-0.03, -0.09, -0.025], [0.03, 0.09, 0.025]], "hilt", [0, 0, 0.3827, 0.9239]],
      ["pelvis", "robe_skirt", [0, 0.02, 0], [[-0.21, -0.5, -0.15], [0.21, 0, 0.15]], "robe"],
      ["pelvis", "robe_hem", [0, -0.48, 0], [[-0.215, 0, -0.155], [0.215, 0.04, 0.155]], "trim"],
    ],
  },
  {
    id: "red-runner",
    root: "RedRunner",
    gender: "female",
    torso: { h: 0.5, w: 0.36, d: 0.23 },
    head: { s: 0.3 },
    arm: { len: 0.47, w: 0.12, x: 0.25 },
    leg: { w: 0.14, x: 0.1 },
    foot: { h: 0.08, l: 0.24 },
    stride: 1.05,
    mats: {
      jacket: 0xd23a34, skin: 0xe8b48e, hair: 0x7a3d1c, eye: 0x101014, stripe: 0xf4f4f2,
      shorts: 0x1c1d22, shoe: 0xf2f2f0, sole: 0x2b7de0, band: 0xf4f4f2,
    },
    parts: { torso: "jacket", arm: "jacket", hand: "skin", leg: "skin", foot: "shoe", head: "skin", hair: "hair", eye: "eye" },
    hair: { h: 0.135, w: 0.34 },
    extras: [
      ["head", "hair_bob_back", [0, 0.07, -0.16], [[-0.17, 0, -0.03], [0.17, 0.25, 0.04]], "hair"],
      ["head", "hair_bob_l", [-0.16, 0.08, 0], [[-0.02, 0, -0.15], [0.02, 0.2, 0.12]], "hair"],
      ["head", "hair_bob_r", [0.16, 0.08, 0], [[-0.02, 0, -0.15], [0.02, 0.2, 0.12]], "hair"],
      ["head", "headband", [0, 0.235, 0], [[-0.175, 0, -0.175], [0.175, 0.035, 0.175]], "band"],
      ["chest", "jacket_stripe_l", [-0.14, 0, 0.116], [[-0.015, 0, 0], [0.015, 0.5, 0.01]], "stripe"],
      ["chest", "jacket_stripe_r", [0.14, 0, 0.116], [[-0.015, 0, 0], [0.015, 0.5, 0.01]], "stripe"],
      ["chest", "jacket_zip", [0, 0, 0.116], [[-0.01, 0, 0], [0.01, 0.46, 0.012]], "stripe"],
      ["upperarm_l", "sleeve_stripe_l", [-0.062, -0.4, 0], [[-0.005, 0, -0.03], [0.005, 0.4, 0.03]], "stripe"],
      ["upperarm_r", "sleeve_stripe_r", [0.062, -0.4, 0], [[-0.005, 0, -0.03], [0.005, 0.4, 0.03]], "stripe"],
      ["pelvis", "shorts", [0, 0.03, 0], [[-0.19, -0.2, -0.125], [0.19, 0, 0.125]], "shorts"],
      ["thigh_l", "sock_l", [0, -0.6, 0], [[-0.075, -0.08, -0.075], [0.075, 0.08, 0.075]], "stripe"],
      ["thigh_r", "sock_r", [0, -0.6, 0], [[-0.075, -0.08, -0.075], [0.075, 0.08, 0.075]], "stripe"],
    ],
  },
];

// ---------------------------------------------------------------- body
// H = pelvis height; the legs always reach exactly down to y = 0
function body(d, H) {
  const T = d.torso.h,
    hs = d.head.s,
    hairH = d.hair ? d.hair.h : 0,
    L = H - d.foot.h; // leg length down to the top of the foot
  const box = (w, y0, y1, dz, z0 = -dz / 2) => [[-w / 2, y0, z0], [w / 2, y1, z0 + dz]];
  const P = d.parts;
  const parts = [
    { name: "pelvis", t: [0, H, 0] },
    { name: "chest", parent: "pelvis" },
    { name: "chest_mesh", parent: "chest", box: box(d.torso.w, 0, T, d.torso.d), material: P.torso },
    { name: "head", parent: "chest", t: [0, T, 0] },
    { name: "head_mesh", parent: "head", t: [0, 0.02, 0], box: box(hs, 0, hs, hs), material: P.head },
    ...(d.hair ? [{ name: "hair", parent: "head", t: [0, 0.186, -0.01], box: box(d.hair.w, 0, hairH, d.hair.w), material: P.hair }] : []),
    { name: "eye_l", parent: "head", t: [-0.06, 0.02 + hs * 0.55, hs / 2 + 0.01], box: box(0.04, 0, 0.04, 0.02), material: P.eye },
    { name: "eye_r", parent: "head", t: [0.06, 0.02 + hs * 0.55, hs / 2 + 0.01], box: box(0.04, 0, 0.04, 0.02), material: P.eye },
  ];
  for (const [side, sx] of [["l", -1], ["r", 1]]) {
    const arm = `upperarm_${side}`;
    parts.push(
      { name: arm, parent: "chest", t: [sx * d.arm.x, T - 0.04, 0] },
      { name: `${arm}_mesh`, parent: arm, box: box(d.arm.w, -d.arm.len, 0, d.arm.w + 0.01), material: P.arm },
      { name: `${arm}_hand`, parent: arm, t: [0, -d.arm.len, 0], box: box(d.arm.w - 0.01, -0.1, 0, d.arm.w - 0.01), material: P.hand },
    );
    side === "r" && parts.push({ name: "hand_r_socket", parent: arm, t: [0, -d.arm.len - 0.05, 0.02] });
  }
  for (const [side, sx] of [["l", -1], ["r", 1]]) {
    const leg = `thigh_${side}`;
    parts.push(
      { name: leg, parent: "pelvis", t: [sx * d.leg.x, 0, 0] },
      { name: `${leg}_mesh`, parent: leg, box: box(d.leg.w, -L, 0, d.leg.w + 0.01), material: P.leg },
      { name: `${leg}_foot`, parent: leg, t: [0, -L, 0.03], box: box(d.leg.w + 0.01, -d.foot.h, 0, d.foot.l), material: P.foot },
    );
  }
  for (const [parent, name, t, b, material, r] of d.extras) parts.push({ name, parent, t, box: b, material, ...(r ? { r } : {}) });
  return { parts, T };
}

// ---------------------------------------------------------------- clips (same set and timing as violet-girl)
const qx = (a) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
const norm = (q) => {
  const l = Math.hypot(...q);
  return q.map((v) => +(v / l).toFixed(5));
};
const flat = (qs) => qs.flatMap(norm);
const times = (n, dur) => Array.from({ length: n }, (_, i) => +((i * dur) / (n - 1)).toFixed(5));
function cycle(dur, amp) {
  // 9 keys over one stride: 0, +, ++, +, 0, -, --, -, 0
  const k = [0, 0.707, 1, 0.707, 0, -0.707, -1, -0.707, 0];
  return { t: times(9, dur), pos: flat(k.map((s) => qx(s * amp))), neg: flat(k.map((s) => qx(-s * amp))) };
}
function clips(H, stride) {
  const pel = (offs) => offs.flatMap((o) => [0, +(H + o).toFixed(4), 0]);
  const walk = cycle(0.95, 0.5 * stride),
    walkArm = cycle(0.95, 0.35 * stride),
    run = cycle(0.58, 0.9 * stride),
    runArm = cycle(0.58, 0.85 * stride);
  const id = [0, 0, 0, 1];
  return [
    {
      name: "idle",
      tracks: [
        { node: "upperarm_l", path: "rotation", times: [0, 1.2, 2.4], values: flat([[0.02, 0, 0.025, 0.999], [0.045, -0.002, 0.04, 0.998], [0.02, 0, 0.025, 0.999]]) },
        { node: "upperarm_r", path: "rotation", times: [0, 1.2, 2.4], values: flat([[0.02, 0, -0.025, 0.999], [0.045, 0.002, -0.04, 0.998], [0.02, 0, -0.025, 0.999]]) },
        { node: "thigh_l", path: "rotation", times: [0, 1.2, 2.4], values: flat([id, id, id]) },
        { node: "thigh_r", path: "rotation", times: [0, 1.2, 2.4], values: flat([id, id, id]) },
        { node: "chest", path: "rotation", times: [0, 1.2, 2.4], values: flat([id, qx(0.03), id]) },
        { node: "head", path: "rotation", times: [0, 1.2, 2.4], values: flat([id, qx(-0.05), id]) },
        { node: "pelvis", path: "translation", times: [0, 1.2, 2.4], values: pel([0, -0.015, 0]) },
      ],
    },
    {
      name: "walk",
      tracks: [
        { node: "thigh_l", path: "rotation", times: walk.t, values: walk.pos },
        { node: "thigh_r", path: "rotation", times: walk.t, values: walk.neg },
        { node: "upperarm_l", path: "rotation", times: walk.t, values: walkArm.neg },
        { node: "upperarm_r", path: "rotation", times: walk.t, values: walkArm.pos },
        { node: "chest", path: "rotation", times: walk.t, values: flat(walk.t.map(() => qx(0.03))) },
        { node: "pelvis", path: "translation", times: walk.t, values: pel([0.018, 0.007, -0.018, 0.007, 0.018, 0.007, -0.018, 0.007, 0.018]) },
      ],
    },
    {
      name: "run",
      tracks: [
        { node: "thigh_l", path: "rotation", times: run.t, values: run.pos },
        { node: "thigh_r", path: "rotation", times: run.t, values: run.neg },
        { node: "upperarm_l", path: "rotation", times: run.t, values: runArm.neg },
        { node: "upperarm_r", path: "rotation", times: run.t, values: runArm.pos },
        { node: "chest", path: "rotation", times: run.t, values: flat(run.t.map(() => qx(0.18))) },
        { node: "pelvis", path: "translation", times: run.t, values: pel([0.04, 0.017, -0.04, 0.017, 0.04, 0.017, -0.04, 0.017, 0.04]) },
      ],
    },
    {
      name: "jump",
      tracks: [
        { node: "thigh_l", path: "rotation", times: [0, 0.25], values: flat([id, qx(-0.9)]) },
        { node: "thigh_r", path: "rotation", times: [0, 0.25], values: flat([id, qx(0.5)]) },
        { node: "upperarm_l", path: "rotation", times: [0, 0.25], values: flat([[0, 0, 0.125, 0.992], [-0.918, 0.162, 0.063, 0.357]]) },
        { node: "upperarm_r", path: "rotation", times: [0, 0.25], values: flat([[0, 0, -0.125, 0.992], [-0.918, -0.162, -0.063, 0.357]]) },
        { node: "chest", path: "rotation", times: [0, 0.25], values: flat([id, qx(-0.1)]) },
        { node: "pelvis", path: "translation", times: [0, 0.25], values: pel([-0.08, 0]) },
      ],
    },
    {
      name: "fall",
      tracks: [
        { node: "thigh_l", path: "rotation", times: [0, 0.5], values: flat([qx(-0.4), qx(-0.25)]) },
        { node: "thigh_r", path: "rotation", times: [0, 0.5], values: flat([qx(0.3), qx(0.2)]) },
        { node: "upperarm_l", path: "rotation", times: [0, 0.5], values: flat([[-0.835, 0.105, 0.067, 0.536], [-0.949, 0.168, 0.047, 0.263]]) },
        { node: "upperarm_r", path: "rotation", times: [0, 0.5], values: flat([[-0.835, -0.105, -0.067, 0.536], [-0.949, -0.168, -0.047, 0.263]]) },
        { node: "chest", path: "rotation", times: [0, 0.5], values: flat([qx(-0.1), qx(-0.05)]) },
        { node: "pelvis", path: "translation", times: [0, 0.5], values: pel([0, 0]) },
      ],
    },
    {
      name: "land",
      tracks: [
        { node: "thigh_l", path: "rotation", times: [0, 0.3], values: flat([qx(-0.7), id]) },
        { node: "thigh_r", path: "rotation", times: [0, 0.3], values: flat([qx(-0.7), id]) },
        { node: "upperarm_l", path: "rotation", times: [0, 0.3], values: flat([[-0.293, 0.037, 0.119, 0.948], [0, 0, 0.174, 0.985]]) },
        { node: "upperarm_r", path: "rotation", times: [0, 0.3], values: flat([[-0.293, -0.037, -0.119, 0.948], [0, 0, -0.174, 0.985]]) },
        { node: "chest", path: "rotation", times: [0, 0.3], values: flat([qx(0.3), id]) },
        { node: "pelvis", path: "translation", times: [0, 0.3], values: pel([-0.16, 0]) },
      ],
    },
    {
      name: "wave",
      tracks: [
        {
          node: "upperarm_r",
          path: "rotation",
          times: [0, 0.4, 0.8, 1.2, 1.6],
          values: flat([id, [-0.971, -0.097, -0.022, 0.218], [-0.932, -0.288, -0.065, 0.209], [-0.971, -0.097, -0.022, 0.218], id]),
        },
      ],
    },
  ];
}

// static (rest-pose) bounding box, honouring node translations and rotations about Z only
function restBounds(json) {
  let lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  const walk = (i, o) => {
    const n = json.nodes[i],
      t = n.translation || [0, 0, 0],
      p = [o[0] + t[0], o[1] + t[1], o[2] + t[2]];
    if (n.mesh != null) {
      const a = json.accessors[json.meshes[n.mesh].primitives[0].attributes.POSITION];
      const r = n.rotation || [0, 0, 0, 1],
        ang = 2 * Math.atan2(r[2], r[3]),
        c = Math.cos(ang),
        s = Math.sin(ang);
      for (const x of [a.min[0], a.max[0]])
        for (const y of [a.min[1], a.max[1]])
          for (const z of [a.min[2], a.max[2]]) {
            const v = [p[0] + x * c - y * s, p[1] + x * s + y * c, p[2] + z];
            for (let k = 0; k < 3; k++) ((lo[k] = Math.min(lo[k], v[k])), (hi[k] = Math.max(hi[k], v[k])));
          }
    }
    for (const ch of n.children || []) walk(ch, p);
  };
  json.scenes[0].nodes.forEach((r) => walk(r, [0, 0, 0]));
  return { lo, hi };
}

const matsOf = (d) => Object.fromEntries(Object.entries(d.mats).map(([k, hex]) => [k, { color: srgb(hex) }]));
const checkOnly = process.argv.includes("--check");
for (const d of DESIGNS) {
  // solve the pelvis height so that the rest-pose top lands exactly on DESIGN_HEIGHT
  const probe = buildRigidGLB({ rootName: d.root, parts: body(d, 1).parts, materials: matsOf(d), clips: [], generator: "" });
  const H = +(DESIGN_HEIGHT - (restBounds(probe.json).hi[1] - 1)).toFixed(4);
  const { parts, T } = body(d, H);
  const gltf = buildRigidGLB({ rootName: d.root, parts, materials: matsOf(d), clips: clips(H, d.stride), generator: "saltline build-avatar-models" });
  const { lo, hi } = restBounds(gltf.json);
  const eye = H + T + 0.02 + d.head.s * 0.55 + 0.02;
  console.log(
    `${d.id.padEnd(18)} ${d.gender.padEnd(6)} height ${(hi[1] - lo[1]).toFixed(3)} m (feet ${lo[1].toFixed(3)}), eye ${eye.toFixed(3)}, width ${(hi[0] - lo[0]).toFixed(3)}, pelvis ${H.toFixed(3)}, ${parts.length} nodes`,
  );
  if (checkOnly) continue;
  const dir = new URL(`${d.id}/`, AVATARS);
  if (!existsSync(dir)) throw new Error(`${dir.pathname} missing (avatar.js must exist first)`);
  writeFileSync(new URL("model.glb", dir), writeGLB(gltf));
}
