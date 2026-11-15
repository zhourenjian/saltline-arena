// ---- part 2: skeleton and body ------------------------------------------------------------------
// Rest pose: standing, arms straight down, palms towards the thighs. Every bone's rest rotation is
// identity, so a bone's local axes are the avatar's axes at rest (which keeps the IK simple).
const SHOULDER_Y = 1.455, SHOULDER_X = 0.2, ELBOW_Y = 1.17, WRIST_Y = 0.91;
const HIP_Y = 0.935, HIP_X = 0.095, KNEE_Y = 0.5, ANKLE_Y = 0.085;
const HEAD_C = [0, 1.69, 0.004];
const FINGERS = [
  // z across the palm, base y, phalanx lengths, radius (0 = thumb, set apart below)
  null,
  { z: 0.0315, y: 0.812, len: [0.04, 0.025, 0.021], r: 0.0098 },
  { z: 0.0105, y: 0.808, len: [0.044, 0.028, 0.022], r: 0.0102 },
  { z: -0.0105, y: 0.812, len: [0.041, 0.026, 0.021], r: 0.0096 },
  { z: -0.0305, y: 0.822, len: [0.032, 0.02, 0.019], r: 0.0086 },
];
const THUMB = { len: [0.042, 0.032, 0.027], r: 0.0122 };
const SIDES = [['L', 1], ['R', -1]];

// joint positions of one hand's fingers: [finger][joint] plus the tip
function fingerJoints(s) {
  const out = [];
  const td = [-s * 0.3, -0.62, 0.72], tl = Math.hypot(td[0], td[1], td[2]);
  let p = [s * (SHOULDER_X - 0.006), 0.885, 0.034];
  const thumb = [p];
  for (const l of THUMB.len) { p = [p[0] + (td[0] / tl) * l, p[1] + (td[1] / tl) * l, p[2] + (td[2] / tl) * l]; thumb.push(p); }
  out.push(thumb);
  for (let f = 1; f < 5; f++) {
    const F = FINGERS[f], j = [[s * SHOULDER_X, F.y, F.z]];
    let y = F.y;
    for (const l of F.len) { y -= l; j.push([s * SHOULDER_X, y, F.z]); }
    out.push(j);
  }
  return out;
}

function soldierBones() {
  const b = [
    ['hips', null, [0, 0.98, 0]], ['spine', 'hips', [0, 1.08, 0]], ['chest', 'spine', [0, 1.24, 0]],
    ['neck', 'chest', [0, 1.5, 0]], ['head', 'neck', [0, 1.565, 0.004]],
  ];
  for (const [S, s] of SIDES) {
    b.push(['uarm' + S, 'chest', [s * SHOULDER_X, SHOULDER_Y, 0]], ['farm' + S, 'uarm' + S, [s * SHOULDER_X, ELBOW_Y, 0]]);
    b.push(['twist' + S, 'farm' + S, [s * SHOULDER_X, 1.04, 0]], ['hand' + S, 'twist' + S, [s * SHOULDER_X, WRIST_Y, 0]]);
    const fj = fingerJoints(s);
    for (let f = 0; f < 5; f++) for (let j = 0; j < 3; j++) b.push(['f' + f + (j + 1) + S, j ? 'f' + f + j + S : 'hand' + S, fj[f][j]]);
    b.push(['thigh' + S, 'hips', [s * HIP_X, HIP_Y, 0]], ['shin' + S, 'thigh' + S, [s * HIP_X, KNEE_Y, 0]]);
    b.push(['foot' + S, 'shin' + S, [s * HIP_X, ANKLE_Y, 0]], ['toe' + S, 'foot' + S, [s * HIP_X, 0.03, 0.118]]);
  }
  return b;
}

// Builds the shared (per package) geometry: { geos: { material: BufferGeometry }, bones, height }
function buildSoldierBody(THREE, CFG) {
  const K = makeKit(THREE), C = CFG.palette, swat = CFG.style === 'swat';
  const bones = soldierBones(), index = {};
  bones.forEach((b, i) => (index[b[0]] = i));
  const B = K.createBuilder(index);
  const g = (v, c, w) => Math.exp(-(((v - c) / w) ** 2));
  const shade = (hex, k) => { const c = new THREE.Color(hex); c.multiplyScalar(k); return c.getHex(); };

  // ---- torso ----------------------------------------------------------------------------------
  const TORSO = [
    [0.85, 0.105, 0.085, 0.095, 0], [0.9, 0.158, 0.1, 0.112, 0], [0.95, 0.17, 0.104, 0.118, -0.004], [1.02, 0.158, 0.1, 0.108, -0.004],
    [1.09, 0.146, 0.094, 0.098, 0], [1.18, 0.156, 0.106, 0.1, 0.002], [1.29, 0.172, 0.12, 0.106, 0.004], [1.38, 0.18, 0.118, 0.106, 0.002],
    [1.44, 0.176, 0.104, 0.1, 0], [1.475, 0.15, 0.088, 0.09, -0.002], [1.5, 0.1, 0.074, 0.078, -0.004], [1.525, 0.07, 0.064, 0.068, -0.004],
  ];
  function torsoPoint(a, y, k) {
    const r = sample(TORSO, y), cs = Math.cos(a), sn = Math.sin(a), e = 2 / 2.5;
    const x = Math.sign(cs) * Math.abs(cs) ** e * r[1], z = Math.sign(sn) * Math.abs(sn) ** e * (sn > 0 ? r[2] : r[3]);
    return [x * k, y, r[4] + z * k];
  }
  const torsoW = (x, y) => { const t1 = sstep(0.98, 1.08, y), t2 = sstep(1.14, 1.26, y); return [['hips', 1 - t1], ['spine', t1 * (1 - t2)], ['chest', t2]]; };
  function torsoBand(y0, y1, k0, k1, n, o) {
    const rings = [];
    for (let i = 0; i <= n; i++) { const y = lerp(y0, y1, i / n), k = lerp(k0, k1, i / n), r = []; for (let j = 0; j < 36; j++) r.push(torsoPoint((j / 36) * Math.PI * 2, y, k)); rings.push(r); }
    return K.loft(rings, o);
  }
  // wraps a part made around the origin onto the torso: local x runs around it from angle a0
  // (PI/2 = front, -PI/2 = back), local y is height above yc, local z is distance off the surface
  function onTorso(part, a0, yc, lift) {
    return K.warp(part, (p) => {
      const a = a0 - p[0] / 0.165, y = yc + p[1], q = torsoPoint(a, y, 1), zc = sample(TORSO, y)[4];
      const l = Math.hypot(q[0], q[2] - zc) || 1, off = lift + p[2];
      return [q[0] + (q[0] / l) * off, y, q[2] + ((q[2] - zc) / l) * off];
    });
  }
  const beltY = 1.03;
  B.add('cloth', torsoBand(0.85, 1.525, 1, 1, 40, { capA: 'soft' }), torsoW, (x, y) => (y > beltY ? C.uniform : C.pants));
  // collar
  B.add('cloth', torsoBand(1.49, 1.54, 1.13, 1.2, 3, {}), 'chest', shade(C.uniform, 0.85));
  if (!swat) B.add('cloth', torsoBand(1.07, 0.925, 1.035, 1.11, 6, {}), torsoW, C.uniform); // untucked jacket hem
  // belt
  B.add('gear', torsoBand(0.985, 1.04, 1.06, 1.06, 3, { capA: 'hard', capB: 'hard' }), torsoW, C.belt);
  B.add('hard', onTorso(K.rbox(0.05, 0.04, 0.012, 0.004), Math.PI / 2, 1.012, 0.018), 'hips', C.pad);

  // ---- head: one surface from the neck to the crown, shaped like a face under cloth -----------------
  const HEAD = [
    [1.455, 0.06, 0.056, 0.062], [1.5, 0.057, 0.054, 0.06], [1.54, 0.058, 0.06, 0.064], [1.565, 0.064, 0.084, 0.072], [1.59, 0.071, 0.094, 0.082],
    [1.62, 0.076, 0.099, 0.092], [1.65, 0.079, 0.098, 0.098], [1.68, 0.0805, 0.097, 0.102], [1.71, 0.08, 0.099, 0.103], [1.74, 0.075, 0.093, 0.099],
    [1.762, 0.064, 0.078, 0.086], [1.776, 0.043, 0.05, 0.058], [1.781, 0.022, 0.026, 0.03], [1.783, 0, 0, 0],
  ];
  const frontAngle = (a) => { let f = a - Math.PI / 2; while (f > Math.PI) f -= Math.PI * 2; while (f < -Math.PI) f += Math.PI * 2; return f; };
  function headPoint(a, y, k) {
    const r = sample(HEAD, y), cs = Math.cos(a), sn = Math.sin(a), e = 2 / 2.35, fa = frontAngle(a);
    let x = Math.sign(cs) * Math.abs(cs) ** e * r[1], z = Math.sign(sn) * Math.abs(sn) ** e * (sn > 0 ? r[2] : r[3]);
    const bump = 0.017 * g(y, 1.636, 0.022) * g(fa, 0, 0.19) + 0.006 * g(y, 1.655, 0.03) * g(fa, 0, 0.1) // nose
      + 0.004 * g(y, 1.703, 0.012) * g(fa, 0, 0.9) - 0.006 * g(y, 1.673, 0.012) * (g(fa, 0.42, 0.2) + g(fa, -0.42, 0.2)) // brow, eye sockets
      + 0.0035 * g(y, 1.602, 0.012) * g(fa, 0, 0.32) + 0.005 * g(y, 1.572, 0.014) * g(fa, 0, 0.4) // lips, chin
      + 0.007 * g(y, 1.66, 0.028) * g(Math.abs(fa), 1.72, 0.14); // ears under the cloth
    const rad = Math.hypot(x, z) || 1;
    x += (x / rad) * bump; z += (z / rad) * bump;
    return [x * k, HEAD_C[1] + (y - HEAD_C[1]) * k, HEAD_C[2] + z * k];
  }
  const headW = (x, y) => { const tn = sstep(1.47, 1.52, y), th = sstep(1.545, 1.595, y); return [['chest', 1 - tn], ['neck', tn * (1 - th)], ['head', th]]; };
  const headY = (v) => lerp(1.455, 1.783, 1 - (1 - v) ** 1.7);
  const eyeBand = swat ? [1.652, 1.694, 0.95] : [1.657, 1.689, 0.82];
  B.add('cloth', K.surface(56, 44, (u, v) => headPoint(u * Math.PI * 2, headY(v), 1), true), headW, (x, y, z) => {
    const fa = Math.atan2(x, z - HEAD_C[2]);
    return y > eyeBand[0] && y < eyeBand[1] && Math.abs(fa) < eyeBand[2] ? C.skin : C.mask;
  });
  // eyewear: a curved lens over the eye opening on a slightly larger dark frame
  function visor(span, half, yc, k, grow) {
    return K.surface(20, 6, (u, v) => {
      const fa = lerp(-span, span, u) , e = Math.abs(2 * u - 1), h = (half + grow) * (1 - 0.5 * e ** 3);
      const yb = yc - h + 0.009 * g(fa, 0, 0.14), yt = yc + h;
      return headPoint(Math.PI / 2 - fa, lerp(yb, yt, v), k);
    }, false, { flip: false });
  }
  if (swat) {
    B.add('hard', visor(1.0, 0.024, 1.673, 1.115, 0.007), 'head', C.pad);
    B.add('lens', visor(0.9, 0.024, 1.673, 1.15, 0), 'head', C.lens);
    // goggle strap, up and around the helmet
    B.add('gear', K.surface(40, 2, (u, v) => {
      const a = Math.PI / 2 + lerp(1.0, Math.PI * 2 - 1.0, u), e = sstep(0, 0.16, Math.min(u, 1 - u));
      return headPoint(a, lerp(1.673, 1.712, e) + lerp(-0.012, 0.012, v), lerp(1.13, 1.232, e));
    }, false, { flip: true }), 'head', C.strap);
    // helmet: high cut above the ears, lower at the nape, with a rolled rim
    const edge = (a) => { const sn = Math.sin(a); return (sn > 0 ? 1.716 + 0.006 * sn : 1.716 - 0.052 * sstep(0, 0.9, -sn)) + 0.008 * g(sn, -0.15, 0.3); };
    B.add('hard', K.surface(48, 22, (u, v) => {
      const a = u * Math.PI * 2, vv = Math.max(0, (v - 0.06) / 0.94);
      return headPoint(a, lerp(edge(a), 1.783, 1 - (1 - vv) ** 1.7), v < 0.06 ? lerp(1.11, 1.2, v / 0.06) : 1.2);
    }, true), 'head', C.helmet);
    for (const s of [1, -1]) {
      B.add('hard', K.put(K.rbox(0.011, 0.02, 0.085, 0.004), [s * 0.102, 1.727, -0.004]), 'head', C.pad); // accessory rail
      B.add('hard', K.put(K.ellipsoid(0.02, 0.036, 0.03, 14, 8), [s * 0.091, 1.668, -0.004]), 'head', C.pad); // headset cup
    }
    B.add('hard', K.put(K.rbox(0.042, 0.034, 0.012, 0.004), [0, 1.754, 0.1085], [-0.42, 0, 0]), 'head', C.pad); // night-vision mount
    B.add('gear', K.put(K.rbox(0.06, 0.012, 0.09, 0.004), [0, 1.8, -0.012]), 'head', C.strap); // top velcro
    B.add('hard', K.tube([[0.092, 1.652, 0.014], [0.089, 1.626, 0.054], [0.064, 1.612, 0.09], [0.036, 1.609, 0.103]], 0.0035, 6, { side: [1, 0, 0], round: true }), 'head', C.pad);
    B.add('hard', K.put(K.ellipsoid(0.008, 0.008, 0.012, 8, 6), [0.03, 1.609, 0.105]), 'head', C.pad);
    const strap = [];
    for (const q of [[0.086, 1.705, 0.018], [0.082, 1.645, 0.034], [0.064, 1.594, 0.062], [0.034, 1.573, 0.087], [0, 1.567, 0.096]]) strap.push(q);
    for (let i = 3; i >= 0; i--) strap.push([-strap[i][0], strap[i][1], strap[i][2]]);
    B.add('gear', K.tube(strap, 0.0095, 8, { side: [0, 0, 1], flat: 0.3 }), 'head', C.strap);
  } else {
    B.add('hard', visor(0.86, 0.017, 1.673, 1.085, 0.0045), 'head', C.pad);
    B.add('lens', visor(0.8, 0.017, 1.673, 1.115, 0), 'head', C.lens);
    for (const s of [1, -1]) B.add('hard', K.tube([[s * 0.074, 1.676, 0.07], [s * 0.089, 1.676, 0.03], [s * 0.091, 1.672, -0.012]], 0.0038, 6, { side: [0, 1, 0], round: true }), 'head', C.pad);
    // watch cap: knitted, with a folded cuff low over the brow and the ears
    const capEdge = (a) => 1.703 - 0.018 * sstep(0.2, 1, -Math.sin(a)) - 0.008 * g(Math.abs(frontAngle(a)), 1.6, 0.5);
    B.add('cloth', K.surface(44, 20, (u, v) => {
      const a = u * Math.PI * 2, vv = Math.max(0, (v - 0.22) / 0.78), cuff = v < 0.22 ? 1.085 + 0.012 * Math.sin((v / 0.22) * Math.PI) : 1.055;
      const y = v < 0.22 ? capEdge(a) + (v / 0.22) * 0.032 : lerp(capEdge(a) + 0.032, 1.801, 1 - (1 - vv) ** 1.8);
      return headPoint(a, y, cuff);
    }, true), 'head', C.cap || C.pants);
    // shemagh: a thick wrap round the neck with a triangle hanging on the chest
    const wrap = [];
    for (let i = 0; i <= 28; i++) { const t = (i / 28) * Math.PI * 2 - Math.PI / 2; wrap.push([Math.cos(t) * 0.074, 1.515 + 0.008 * Math.sin(2 * t + 1) - 0.014 * Math.sin(t), 0.002 + Math.sin(t) * 0.076]); }
    B.add('cloth', K.tube(wrap, wrap.map((q, i) => 0.026 * (1 + 0.14 * Math.sin(i * 1.3 + 0.5))), 10, { side: [0, 1, 0], flat: 0.8 }), [['chest', 0.6], ['neck', 0.4]], C.scarf);
    const drape = K.warp(K.rbox(0.22, 0.16, 0.022, 0.011, 4), (p) => [p[0] * lerp(0.18, 1, (p[1] + 0.08) / 0.16), p[1], p[2] * lerp(0.6, 1.3, (p[1] + 0.08) / 0.16)]);
    B.add('cloth', onTorso(drape, Math.PI / 2, 1.4, 0.014), 'chest', C.scarf);
  }

  // ---- arms and hands ---------------------------------------------------------------------------
  const ARM = [[1.518, 0.018], [1.505, 0.042], [1.48, 0.057], [1.44, 0.062], [1.37, 0.058], [1.28, 0.053], [1.2, 0.051], [1.17, 0.051], [1.13, 0.05], [1.07, 0.048], [1.0, 0.043], [0.955, 0.039], [0.94, 0.0385]].reverse();
  for (const [S, s] of SIDES) {
    const rings = [];
    for (let y = 1.518; y > 0.939; y -= 0.0165) { const r = sample(ARM, y)[1]; rings.push(K.ring([s * SHOULDER_X, y, 0], [1, 0, 0], [0, 0, 1], r * 0.96, r * 1.05, 16)); }
    const armW = (x, y) => {
      const wc = 0.55 * sstep(1.42, 1.5, y), te = sstep(ELBOW_Y + 0.05, ELBOW_Y - 0.05, y), tt = sstep(1.1, 0.96, y);
      return [['chest', wc], ['uarm' + S, (1 - wc) * (1 - te)], ['farm' + S, te * (1 - tt)], ['twist' + S, te * tt]];
    };
    B.add('cloth', K.loft(rings, { capA: 'soft', capB: 'soft' }), armW, C.uniform);
    B.add('cloth', K.put(K.rbox(0.012, 0.075, 0.062, 0.005), [s * (SHOULDER_X + 0.058), 1.385, 0]), 'uarm' + S, shade(C.uniform, 0.8)); // sleeve pocket
    if (swat) B.add('hard', K.put(K.ellipsoid(0.036, 0.058, 0.03, 12, 8), [s * SHOULDER_X, 1.158, -0.04]), [['farm' + S, 0.6], ['uarm' + S, 0.4]], C.pad);
    else if (s > 0) {
      const band = [];
      for (const y of [1.335, 1.3]) band.push(K.ring([s * SHOULDER_X, y, 0], [1, 0, 0], [0, 0, 1], 0.0595, 0.064, 16));
      B.add('cloth', K.loft(band, { capA: 'hard', capB: 'hard' }), 'uarm' + S, C.accent); // armband
    }
    // glove: cuff, palm, knuckle guard, fingers
    const cuff = [];
    for (const [y, a, b] of [[0.952, 0.033, 0.04], [0.93, 0.031, 0.039], [0.908, 0.028, 0.039], [0.893, 0.024, 0.041]]) cuff.push(K.ring([s * SHOULDER_X, y, 0], [1, 0, 0], [0, 0, 1], a, b, 14, 2.4));
    B.add('rubber', K.loft(cuff, { capA: 'hard', capB: 'soft' }), (x, y) => [['twist' + S, sstep(0.9, 0.925, y)], ['hand' + S, 1 - sstep(0.9, 0.925, y)]], C.glove);
    B.add('rubber', K.put(K.rbox(0.03, 0.102, 0.088, 0.0135, 2), [s * SHOULDER_X, 0.86, 0]), 'hand' + S, C.glove);
    B.add('rubber', K.put(K.ellipsoid(0.015, 0.03, 0.02, 10, 8), [s * (SHOULDER_X - 0.008), 0.872, 0.03]), [['hand' + S, 0.5], ['f01' + S, 0.5]], C.glove);
    B.add('hard', K.put(K.rbox(0.011, 0.028, 0.078, 0.005), [s * (SHOULDER_X + 0.0165), 0.83, 0]), 'hand' + S, C.gloveHard);
    B.add('gear', K.put(K.rbox(0.034, 0.016, 0.082, 0.006), [s * SHOULDER_X, 0.912, 0]), 'hand' + S, C.strap); // wrist strap
    const fj = fingerJoints(s);
    for (let f = 0; f < 5; f++) {
      const j = fj[f], r0 = f ? FINGERS[f].r : THUMB.r, path = [], rad = [];
      const dir = [j[3][0] - j[0][0], j[3][1] - j[0][1], j[3][2] - j[0][2]], len = Math.hypot(dir[0], dir[1], dir[2]);
      const steps = 14, back = 0.014;
      for (let k = 0; k <= steps; k++) {
        const d = lerp(-back, len - r0 * 0.75, k / steps);
        path.push([j[0][0] + (dir[0] / len) * d, j[0][1] + (dir[1] / len) * d, j[0][2] + (dir[2] / len) * d]);
        rad.push(r0 * lerp(1.04, 0.84, clamp(d / len, 0, 1)));
      }
      const along = (x, y, z) => ((x - j[0][0]) * dir[0] + (y - j[0][1]) * dir[1] + (z - j[0][2]) * dir[2]) / len;
      const l1 = Math.hypot(j[1][0] - j[0][0], j[1][1] - j[0][1], j[1][2] - j[0][2]), l2 = l1 + Math.hypot(j[2][0] - j[1][0], j[2][1] - j[1][1], j[2][2] - j[1][2]);
      const fw = (x, y, z) => {
        const d = along(x, y, z), t0 = sstep(-0.012, 0.004, d), t1 = sstep(l1 - 0.005, l1 + 0.005, d), t2 = sstep(l2 - 0.004, l2 + 0.004, d);
        return [['hand' + S, 1 - t0], ['f' + f + '1' + S, t0 * (1 - t1)], ['f' + f + '2' + S, t1 * (1 - t2)], ['f' + f + '3' + S, t2]];
      };
      B.add('rubber', K.tube(path, rad, 8, { side: [0, 0, 1], round: true }), fw, C.glove);
    }
  }

  // ---- legs and boots -----------------------------------------------------------------------------
  const LEG = [[0.995, 0.09, 0], [0.93, 0.097, 0], [0.86, 0.094, 0], [0.75, 0.085, 0], [0.62, 0.073, 0], [0.53, 0.066, 0.003], [0.5, 0.065, 0.004], [0.47, 0.063, 0], [0.4, 0.063, -0.009], [0.3, 0.056, -0.006], [0.23, 0.053, 0], [0.205, 0.058, 0], [0.18, 0.05, 0]].reverse();
  for (const [S, s] of SIDES) {
    const rings = [];
    for (let y = 0.995; y > 0.179; y -= 0.02) { const r = sample(LEG, y); rings.push(K.ring([s * HIP_X, y, r[2]], [1, 0, 0], [0, 0, 1], r[1] * 0.95, r[1] * 1.06, 18)); }
    const legW = (x, y) => { const wh = 0.8 * sstep(0.89, 0.99, y), tk = sstep(KNEE_Y + 0.055, KNEE_Y - 0.055, y); return [['hips', wh], ['thigh' + S, (1 - wh) * (1 - tk)], ['shin' + S, tk]]; };
    B.add('cloth', K.loft(rings, { capA: 'soft', capB: 'soft' }), legW, C.pants);
    // cargo pocket with a flap
    B.add('cloth', K.put(K.rbox(0.02, 0.15, 0.125, 0.009, 2), [s * (HIP_X + 0.083), 0.715, 0.004]), 'thigh' + S, shade(C.pants, 0.9));
    B.add('cloth', K.put(K.rbox(0.024, 0.04, 0.13, 0.008), [s * (HIP_X + 0.084), 0.775, 0.004]), 'thigh' + S, shade(C.pants, 0.78));
    if (swat) {
      B.add('hard', K.put(K.ellipsoid(0.05, 0.066, 0.032, 14, 8), [s * HIP_X, 0.497, 0.052]), [['shin' + S, 0.6], ['thigh' + S, 0.4]], C.pad);
      B.add('gear', K.loft([0.455, 0.43].map((y) => K.ring([s * HIP_X, y, -0.004], [1, 0, 0], [0, 0, 1], 0.064, 0.07, 16)), { capA: 'hard', capB: 'hard' }), 'shin' + S, C.strap);
    }
    // boot: shaft, upper and sole
    const shaft = [];
    for (const [y, r] of [[0.215, 0.047], [0.17, 0.05], [0.12, 0.048], [0.07, 0.05]]) shaft.push(K.ring([s * HIP_X, y, -0.004], [1, 0, 0], [0, 0, 1], r * 0.95, r * 1.12, 14));
    const bootW = (x, y, z) => { const tf = sstep(0.15, 0.085, y), tt = sstep(0.1, 0.136, z); return [['shin' + S, 1 - tf], ['foot' + S, tf * (1 - tt)], ['toe' + S, tf * tt]]; };
    B.add('rubber', K.loft(shaft, { capA: 'soft', capB: 'soft' }), bootW, C.boot);
    const upper = [];
    for (const [z, rx, ry, cy] of [[-0.078, 0.03, 0.036, 0.048], [-0.06, 0.043, 0.05, 0.058], [-0.02, 0.048, 0.058, 0.064], [0.04, 0.05, 0.05, 0.056], [0.1, 0.052, 0.04, 0.047], [0.155, 0.048, 0.033, 0.041], [0.19, 0.036, 0.026, 0.035], [0.2, 0.02, 0.016, 0.03]])
      upper.push(K.ring([s * HIP_X, cy, z], [1, 0, 0], [0, 1, 0], rx, ry, 14, 2.6, (a, x, y) => [x, Math.max(y, -cy + 0.014)]));
    B.add('rubber', K.loft(upper, { capA: 'soft', capB: 'soft' }), bootW, C.boot);
    B.add('hard', K.put(K.rbox(0.108, 0.024, 0.292, 0.01, 3), [s * HIP_X, 0.012, 0.058]), bootW, C.sole);
    B.add('hard', K.put(K.rbox(0.1, 0.012, 0.085, 0.004), [s * HIP_X, 0.006, -0.04]), 'foot' + S, C.sole);
  }
  // pistol holster strapped to the right thigh
  B.add('hard', K.put(K.rbox(0.042, 0.17, 0.085, 0.014), [-(HIP_X + 0.105), 0.8, 0.008], [0, 0, -0.03]), 'thighR', C.pad);
  B.add('hard', K.put(K.rbox(0.03, 0.085, 0.036, 0.01), [-(HIP_X + 0.105), 0.91, -0.03], [0.3, 0, 0]), 'thighR', shade(C.pad, 0.7));
  for (const y of [0.84, 0.76]) B.add('gear', K.loft([y + 0.016, y - 0.016].map((yy) => K.ring([-HIP_X, yy, 0], [1, 0, 0], [0, 0, 1], sample(LEG, yy)[1] * 0.95 + 0.006, sample(LEG, yy)[1] * 1.06 + 0.006, 16)), { capA: 'hard', capB: 'hard' }), 'thighR', C.strap);
  // dump pouch behind the left hip, two pistol magazines in front of it
  B.add('gear', onTorso(K.rbox(0.11, 0.13, 0.05, 0.022, 2), Math.PI + 0.55, 0.955, 0.03), 'hips', C.pouch);
  for (const dx of [-0.028, 0.028]) B.add('gear', onTorso(K.rbox(0.045, 0.1, 0.03, 0.01), Math.PI - 0.75 + dx / 0.165 * 1, 0.975, 0.022), 'hips', C.pouch);

  // ---- load-bearing gear ----------------------------------------------------------------------------
  const F = Math.PI / 2, Bk = -Math.PI / 2;
  if (swat) {
    B.add('gear', onTorso(K.rbox(0.29, 0.345, 0.03, 0.013, 6), F, 1.3, 0.022), 'chest', C.vest); // front plate
    B.add('gear', onTorso(K.rbox(0.29, 0.36, 0.03, 0.013, 6), Bk, 1.3, 0.022), 'chest', C.vest); // back plate
    B.add('gear', torsoBand(1.135, 1.27, 1.09, 1.09, 6, { capA: 'hard', capB: 'hard' }), torsoW, shade(C.vest, 0.9)); // cummerbund
    for (const x of [-0.079, 0, 0.079]) {
      B.add('gear', onTorso(K.put(K.rbox(0.07, 0.125, 0.034, 0.011, 2), [x, 0, 0]), F, 1.205, 0.054), 'chest', C.pouch);
      B.add('gear', onTorso(K.put(K.rbox(0.073, 0.04, 0.038, 0.009), [x, 0.046, 0]), F, 1.205, 0.056), 'chest', shade(C.pouch, 1.25));
    }
    B.add('gear', onTorso(K.rbox(0.16, 0.078, 0.02, 0.009, 3), F, 1.39, 0.047), 'chest', C.pouch);
    B.add('patch', onTorso(K.quad(0.135, 0.036), F, 1.39, 0.0585), 'chest', 0xffffff);
    B.add('patch', onTorso(K.quad(0.21, 0.056), Bk, 1.385, 0.039), 'chest', 0xffffff);
    B.add('gear', onTorso(K.rbox(0.15, 0.2, 0.034, 0.014, 3), Bk, 1.235, 0.054), 'chest', C.pouch);
    B.add('hard', onTorso(K.put(K.rbox(0.05, 0.11, 0.03, 0.008), [-0.105, 0, 0]), Bk, 1.4, 0.052), 'chest', C.pad); // radio
    B.add('hard', K.tube([[0.115, 1.45, -0.135], [0.118, 1.56, -0.142], [0.12, 1.66, -0.15]], 0.003, 5, { side: [1, 0, 0] }), 'chest', C.pad);
  } else {
    B.add('gear', onTorso(K.rbox(0.3, 0.2, 0.018, 0.009, 6), F, 1.2, 0.02), 'chest', C.vest); // chest rig panel
    for (const x of [-0.112, -0.0375, 0.0375, 0.112]) {
      B.add('gear', onTorso(K.put(K.rbox(0.066, 0.15, 0.036, 0.011, 2), [x, 0, 0]), F, 1.205, 0.047), 'chest', C.pouch);
      B.add('gear', onTorso(K.put(K.rbox(0.069, 0.042, 0.04, 0.009), [x, 0.058, 0]), F, 1.205, 0.049), 'chest', shade(C.pouch, 1.25));
    }
    B.add('gear', torsoBand(1.15, 1.215, 1.07, 1.07, 3, { capA: 'hard', capB: 'hard' }), torsoW, C.strap); // waist strap
    B.add('gear', onTorso(K.rbox(0.09, 0.12, 0.04, 0.016, 2), Bk, 1.21, 0.03), 'chest', C.pouch);
  }
  // shoulder straps over the top
  for (const s of [1, -1]) {
    // raider: the jacket's shoulder yoke fills the dip between neck and shoulder (the vest's wide
    // straps do this for the SWAT outfit), so the shoulders slope down instead of looking shrugged
    if (!swat) { const x = 0.112, lo = 1.42; B.add('cloth', K.tube([[s * x, lo, sample(TORSO, lo)[2] - 0.012], [s * (x + 0.004), 1.45, 0.085], [s * (x + 0.008), 1.488, 0.05], [s * (x + 0.01), 1.502, 0], [s * (x + 0.008), 1.486, -0.052], [s * (x + 0.004), 1.44, -0.092], [s * x, lo, -sample(TORSO, lo)[3] + 0.012]], 0.034, 8, { side: [1, 0, 0], flat: 0.3 }), 'chest', C.uniform); }
    const x = swat ? 0.105 : 0.085, r = swat ? 0.032 : 0.022, lo = swat ? 1.44 : 1.3;
    B.add('gear', K.tube([[s * x, lo, sample(TORSO, lo)[2] + 0.018], [s * (x + 0.004), 1.45, 0.1], [s * (x + 0.008), 1.497, 0.058], [s * (x + 0.01), 1.513, 0], [s * (x + 0.008), 1.495, -0.06], [s * (x + 0.004), 1.44, -0.108], [s * x, lo, -sample(TORSO, lo)[3] - 0.016]], r, 8, { side: [1, 0, 0], flat: 0.26 }), 'chest', C.strap);
  }

  const geos = B.build();
  let top = 0;
  for (const k in geos) { const p = geos[k].attributes.position; for (let i = 0; i < p.count; i++) top = Math.max(top, p.getY(i)); }
  return { geos, bones, index, height: top, fingerJoints };
}
