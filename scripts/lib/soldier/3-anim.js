// ---- part 3: shared resources, instance, IK and procedural animation ----------------------------
const ARM1 = SHOULDER_Y - ELBOW_Y, ARM2 = ELBOW_Y - WRIST_Y, LEG1 = HIP_Y - KNEE_Y, LEG2 = KNEE_Y - ANKLE_Y;
const PALM = 0.085, PALM_T = 0.016; // wrist -> centre of a grasped bar, along the fingers / off the palm

// geometry, textures and materials are built once per package and shared by every instance
let SHARED = null;
function acquireShared(THREE, CFG) {
  if (SHARED && SHARED.THREE === THREE) { SHARED.refs++; return SHARED; }
  const K = makeKit(THREE), body = buildSoldierBody(THREE, CFG);
  const twill = K.fabricTextures('twill'), web = K.fabricTextures('web'), knit = K.fabricTextures('knit');
  const textures = [twill.normal, twill.albedo, web.normal, web.albedo, knit.normal, knit.albedo];
  // a little self-illumination in the surface's own colour: against the light or in deep shadow the
  // outfit keeps its colour instead of turning into a black silhouette (readability, fair play)
  const FILL = 0.2;
  const M = (o) => {
    const m = new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, metalness: 0 }, o));
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * ' + FILL.toFixed(2) + ';');
    };
    m.customProgramCacheKey = () => 'soldier-fill';
    return m;
  };
  const mats = {
    cloth: M({ map: twill.albedo, normalMap: twill.normal, roughness: 0.93 }),
    gear: M({ map: web.albedo, normalMap: web.normal, roughness: 0.84 }),
    hard: M({ roughness: 0.5, metalness: 0.12 }),
    rubber: M({ map: knit.albedo, normalMap: knit.normal, roughness: 0.72 }),
    lens: M({ roughness: 0.1, metalness: 0.9 }),
  };
  if (body.geos.patch) {
    const label = K.labelTexture(CFG.label || 'POLICE', '#e9edf2', '#16233a');
    textures.push(label);
    mats.patch = new THREE.MeshStandardMaterial({ map: label, roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  }
  for (const k in mats) mats[k].name = 'soldier_' + k;
  SHARED = { THREE, refs: 1, body, mats, textures };
  return SHARED;
}
function releaseShared(S) {
  if (--S.refs > 0) return;
  for (const k in S.body.geos) S.body.geos[k].dispose();
  for (const k in S.mats) S.mats[k].dispose();
  for (const t of S.textures) t.dispose();
  if (SHARED === S) SHARED = null;
}

// finger poses: [thumb oppose, thumb 1..3, then mcp/pip/dip for index, middle, ring, pinky]
function wrapPose(r, trigger) {
  const R = r + 0.011, m = clamp(0.034 / R, 0.2, 1.4), p = clamp(0.036 / R, 0.2, 1.55), d = clamp(0.025 / R, 0.15, 1.05);
  // thin bars (grips, rungs, magazines) get the thumb wrapped round; wide ones are cupped
  const out = trigger || r < 0.019 ? [0.75, 0.3, 0.3, 0.25] : [0, -0.12, 0.1, 0.12];
  for (let f = 0; f < 4; f++) out.push(m * (1 - 0.03 * f), p, d);
  if (trigger) { out[4] = 0.34; out[5] = 0.86; out[6] = 0.5; } // index finger inside the guard, on the trigger
  return out;
}
const POSE_RELAX = [0.2, 0.12, 0.18, 0.18, 0.2, 0.38, 0.26, 0.26, 0.44, 0.3, 0.32, 0.5, 0.32, 0.38, 0.55, 0.34];
const POSE_FLAT = [0.05, 0, 0.05, 0.05, 0.06, 0.1, 0.08, 0.06, 0.1, 0.08, 0.06, 0.1, 0.08, 0.06, 0.1, 0.08];
const POSE_RUNG = wrapPose(0.016, false);

function createSoldierInstance(THREE, CFG) {
  const V = THREE.Vector3, Q = THREE.Quaternion;
  const S = acquireShared(THREE, CFG);
  const root = new THREE.Group();
  root.name = 'avatar:' + CFG.id;

  // ---- skeleton -----------------------------------------------------------------------------------
  const B = {}, list = [], restAbs = {};
  for (const [name, parent, pos] of S.body.bones) {
    const b = new THREE.Bone();
    b.name = name;
    restAbs[name] = pos;
    const pp = parent ? restAbs[parent] : [0, 0, 0];
    b.position.set(pos[0] - pp[0], pos[1] - pp[1], pos[2] - pp[2]);
    (parent ? B[parent] : root).add(b);
    B[name] = b; list.push(b);
  }
  const skeleton = new THREE.Skeleton(list, S.body.bones.map((b) => new THREE.Matrix4().makeTranslation(-b[2][0], -b[2][1], -b[2][2])));
  const meshes = [];
  for (const m in S.body.geos) {
    const mesh = new THREE.SkinnedMesh(S.body.geos[m], S.mats[m]);
    mesh.name = 'body:' + m;
    mesh.bind(skeleton, new THREE.Matrix4());
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
    root.add(mesh); meshes.push(mesh);
  }

  // ---- anchors --------------------------------------------------------------------------------------
  const anchor = (name, parent, pos) => { const o = new THREE.Object3D(); o.name = 'anchor:' + name; if (pos) o.position.set(pos[0], pos[1], pos[2]); parent.add(o); return o; };
  const weapon = anchor('weapon', root, [-0.085, 1.4, 0.25]);
  const anchors = {
    weapon,
    head: anchor('head', B.head, [0, 0.125, 0]),
    chest: anchor('chest', B.chest, [0, 0.08, 0.13]),
    leftHand: anchor('leftHand', B.handL, [-0.02, -PALM, 0]),
    rightHand: anchor('rightHand', B.handR, [0.02, -PALM, 0]),
    // slung across the back, muzzle down to the left, the gun's left side against the body
    weaponStow: anchor('weaponStow', B.chest, [-0.06, 0.17, CFG.style === 'swat' ? -0.215 : -0.165]),
  };
  {
    const z = new V(0.36, -0.933, 0).normalize(), x = new V(0, 0, 1), y = new V().crossVectors(z, x);
    anchors.weaponStow.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  }

  // ---- maths helpers ----------------------------------------------------------------------------------
  const AX = new V(1, 0, 0), AY = new V(0, 1, 0), AZ = new V(0, 0, 1), eu = new THREE.Euler(), mB = new THREE.Matrix4();
  const ypr = (q, pitch, yaw, roll) => q.setFromEuler(eu.set(pitch, yaw || 0, roll || 0, 'YXZ'));
  const basisQ = (q, x, y, z) => q.setFromRotationMatrix(mB.makeBasis(x, y, z));
  const QC = new Q().setFromAxisAngle(AX, -Math.PI / 2); // grasp frame -> hand bone
  const rp = { hips: new V(), spine: new V(), chest: new V(), neck: new V(), head: new V() };
  const rq = { hips: new Q(), spine: new Q(), chest: new Q(), neck: new Q(), head: new Q() };
  const t = { a: new V(), d: new V(), pp: new V(), mid: new V(), end: new V(), y1: new V(), z1: new V(), x1: new V(), y2: new V(), z2: new V(), sd: new V(), q1: new Q(), q2: new Q(), qT: new Q(), rel: new Q(), tw: new Q() };
  function two(a, target, pole, l1, l2) {
    t.d.subVectors(target, a);
    let len = t.d.length();
    if (len < 1e-5) { t.d.set(0, -1, 0); len = 1e-5; }
    t.d.multiplyScalar(1 / len);
    len = clamp(len, Math.abs(l1 - l2) + 0.03, (l1 + l2) * 0.998);
    t.end.copy(a).addScaledVector(t.d, len);
    const k = (l1 * l1 - l2 * l2 + len * len) / (2 * len), h = Math.sqrt(Math.max(0, l1 * l1 - k * k));
    t.pp.copy(pole).addScaledVector(t.d, -pole.dot(t.d));
    if (t.pp.lengthSq() < 1e-8) t.pp.set(t.d.y, -t.d.x, 0);
    t.pp.normalize();
    t.mid.copy(a).addScaledVector(t.d, k).addScaledVector(t.pp, h);
  }
  // arm: wrist target and elbow pole in root space; handQ = hand orientation in root space (or null)
  function solveArm(side, wrist, pole, handQ, wq) {
    const u = B['uarm' + side], f = B['farm' + side], tw = B['twist' + side], h = B['hand' + side];
    t.a.copy(u.position).applyQuaternion(rq.chest).add(rp.chest);
    two(t.a, wrist, pole, ARM1, ARM2);
    t.y1.subVectors(t.a, t.mid).normalize();
    t.sd.subVectors(t.end, t.mid).normalize();
    t.z1.copy(t.sd).addScaledVector(t.y1, -t.sd.dot(t.y1));
    if (t.z1.lengthSq() < 1e-6) t.z1.copy(t.pp).negate();
    t.z1.normalize();
    t.x1.crossVectors(t.y1, t.z1);
    basisQ(t.q1, t.x1, t.y1, t.z1);
    t.y2.copy(t.sd).negate(); t.z2.crossVectors(t.x1, t.y2);
    basisQ(t.q2, t.x1, t.y2, t.z2);
    u.quaternion.copy(t.qT.copy(rq.chest).invert()).multiply(t.q1);
    f.quaternion.copy(t.qT.copy(t.q1).invert()).multiply(t.q2);
    if (handQ && wq > 0.001) {
      t.rel.copy(t.qT.copy(t.q2).invert()).multiply(handQ);
      if (t.rel.w < 0) t.rel.set(-t.rel.x, -t.rel.y, -t.rel.z, -t.rel.w);
      if (wq < 0.999) t.rel.slerp(t.qT.identity(), 1 - wq);
      // the forearm takes the roll about its own axis, the wrist only bends
      t.tw.set(0, t.rel.y, 0, t.rel.w);
      if (t.tw.lengthSq() < 1e-8) t.tw.identity(); else t.tw.normalize();
      tw.quaternion.copy(t.tw);
      h.quaternion.copy(t.tw).invert().multiply(t.rel);
    } else { tw.quaternion.identity(); h.quaternion.identity(); }
  }
  function solveLeg(side, ankle, pole, footQ) {
    const th = B['thigh' + side], sh = B['shin' + side], ft = B['foot' + side];
    t.a.copy(th.position).applyQuaternion(rq.hips).add(rp.hips);
    two(t.a, ankle, pole, LEG1, LEG2);
    t.y1.subVectors(t.a, t.mid).normalize();
    t.sd.subVectors(t.end, t.mid).normalize();
    t.z1.copy(t.sd).addScaledVector(t.y1, -t.sd.dot(t.y1)).negate();
    if (t.z1.lengthSq() < 1e-6) t.z1.copy(t.pp);
    t.z1.normalize();
    t.x1.crossVectors(t.y1, t.z1);
    basisQ(t.q1, t.x1, t.y1, t.z1);
    t.y2.copy(t.sd).negate(); t.z2.crossVectors(t.x1, t.y2);
    basisQ(t.q2, t.x1, t.y2, t.z2);
    th.quaternion.copy(t.qT.copy(rq.hips).invert()).multiply(t.q1);
    sh.quaternion.copy(t.qT.copy(t.q1).invert()).multiply(t.q2);
    ft.quaternion.copy(t.qT.copy(t.q2).invert()).multiply(footQ);
  }
  // fingers
  const fingerBones = {}, thumbAxis = {};
  for (const [side, s] of SIDES) {
    fingerBones[side] = [];
    for (let f = 0; f < 5; f++) for (let j = 1; j <= 3; j++) fingerBones[side].push(B['f' + f + j + side]);
    thumbAxis[side] = new V(-s * 0.3, -0.62, 0.72).normalize().cross(new V(-s, 0, 0)).normalize();
  }
  const fq = new Q();
  function setFingers(side, s, p) {
    const fb = fingerBones[side], ax = thumbAxis[side];
    fb[0].quaternion.setFromAxisAngle(AY, -s * p[0]).multiply(fq.setFromAxisAngle(ax, p[1]));
    fb[1].quaternion.setFromAxisAngle(ax, p[2]);
    fb[2].quaternion.setFromAxisAngle(ax, p[3]);
    for (let k = 3; k < 15; k++) fb[k].quaternion.setFromAxisAngle(AZ, -s * p[k + 1]);
  }
  const mix = (out, a, b, w) => { for (let k = 0; k < 16; k++) out[k] = a[k] + (b[k] - a[k]) * w; return out; };

  // ---- state ------------------------------------------------------------------------------------------
  let st = { grounded: true, speed: 0, velocity: { x: 0, y: 0, z: 0 }, phase: 'grounded', mode: 'duoworld:walk', stance: 'standing', sprinting: false, aimPitch: 0 };
  let time = Math.random() * 10, phase = 0, wArm = 0, wCrouch = 0, wAir = 0, wMantle = 0, wLadder = 0, wSprint = 0, wAct = 0, mv = 0, gdx = 0, gdz = 1, pitch = 0;
  let recoil = 0, land = 0, lastPhase = 'grounded', climbed = 0, ledgeH = 1, ledgeZ = 0.5, spd = 0, vy = 0, disposed = false;
  const hand = {
    L: { pos: new V(), pole: new V(), q: new Q(), wq: 0, pose: new Array(16).fill(0), grip: wrapPose(0.015, false) },
    R: { pos: new V(), pole: new V(), q: new Q(), wq: 0, pose: new Array(16).fill(0), grip: wrapPose(0.02, true) },
  };
  const foot = { L: { pos: new V(), pole: new V(), q: new Q(), g: { o: 0, h: 0, p: 0 } }, R: { pos: new V(), pole: new V(), q: new Q(), g: { o: 0, h: 0, p: 0 } } };
  const w = { vL: new V(), qW: new Q(), q: new Q(), qa: new Q(), qb: new Q(), v: new V(), v2: new V(), c: new V(), gp: new V(), gq: new Q(), F: new V(), N: new V(), X: new V(), Yv: new V(), Zv: new V(), sh: new V(), tp: new V(), tq: new Q(), tpose: new Array(16).fill(0) };
  const arr = (a, i) => (a.length !== undefined ? a[i] : i === 0 ? a.x : i === 1 ? a.y : i === 2 ? a.z : a.w);

  // hand around a bar: grasp frame (centre, +Y bar axis towards the thumb, +Z along the fingers)
  // given in the weapon anchor's frame -> wrist position and hand orientation in root space
  function grasp(s, src, defPos, defQ, outPos, outQ) {
    const p = src && src.position, q = src && src.quaternion, r = (src && +src.radius) || 0.02;
    if (p) w.gp.set(arr(p, 0), arr(p, 1), arr(p, 2)); else w.gp.copy(defPos);
    if (q) w.gq.set(arr(q, 0), arr(q, 1), arr(q, 2), arr(q, 3)).normalize(); else w.gq.copy(defQ);
    outQ.copy(weapon.quaternion).multiply(w.gq).multiply(QC);
    w.c.copy(w.gp).applyQuaternion(weapon.quaternion).add(weapon.position);
    outPos.copy(w.c).sub(w.v.set(-s * (PALM_T + r), -PALM, 0).applyQuaternion(outQ));
    return r;
  }
  // hand from the direction of the fingers F and the palm normal N (root space), palm centre at c
  function palmAt(s, c, F, N, r, outPos, outQ) {
    w.X.copy(N).multiplyScalar(-s); w.Yv.copy(F).negate(); w.Zv.crossVectors(w.X, w.Yv);
    basisQ(outQ, w.X, w.Yv, w.Zv);
    outPos.copy(c).addScaledVector(N, -(PALM_T + r)).addScaledVector(F, -PALM);
  }
  const DEF_GRIP_Q = new Q().setFromAxisAngle(AX, 0.26), DEF_GRIP_P = new V(0, -0.005, 0);
  const DEF_SUP_P = new V(0, 0.036, 0.329), DEF_SUP_Q = new Q(); // the vertical foregrip
  { const x = new V(1, 0, 0), y = new V(0, Math.cos(0.3), -Math.sin(0.3)), z = new V().crossVectors(x, y); DEF_SUP_Q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)); }

  function gait(p, A, lift, stf, run, g) {
    p -= Math.floor(p);
    if (p < stf) {
      const u = p / stf;
      g.o = lerp(A, -A, u); g.h = 0;
      g.p = (0.45 + 0.35 * run) * sstep(0.55, 1, u) - 0.22 * (1 - sstep(0, 0.22, u));
    } else {
      const u = (p - stf) / (1 - stf);
      g.o = lerp(-A, A, u * u * (3 - 2 * u));
      g.h = lift * Math.sin(Math.PI * Math.pow(u, 0.8));
      g.p = lerp(0.45 + 0.75 * run, -0.22, sstep(0, 0.85, u));
    }
    if (g.p > 0) g.h += Math.sin(g.p) * 0.1;
  }

  function update(dt) {
    if (disposed) return;
    dt = clamp(+dt || 0, 0, 0.1);
    time += dt;
    // ---- inputs -> smoothed weights
    const vel = st.velocity || w.v.set(0, 0, 0);
    root.getWorldQuaternion(w.qW);
    w.vL.set(vel.x || 0, vel.y || 0, vel.z || 0).applyQuaternion(w.qW.invert());
    const climb = st.mode === 'duoworld:climb' && st.climb ? st.climb : null;
    const mantle = !!climb && climb.kind !== 'ladder', ladder = !!climb && climb.kind === 'ladder';
    const held = st.held && !climb ? st.held : null;
    const sXZ = climb ? 0 : Math.hypot(w.vL.x, w.vL.z), air = !st.grounded && !climb;
    spd = damp(spd, sXZ, 12, dt); vy = damp(vy, w.vL.y, 10, dt);
    wArm = damp(wArm, held ? 1 : 0, 11, dt);
    wCrouch = damp(wCrouch, st.stance === 'crouching' && !climb ? 1 : 0, 10, dt);
    wAir = damp(wAir, air ? 1 : 0, 13, dt);
    wMantle = damp(wMantle, mantle ? 1 : 0, 13, dt);
    wLadder = damp(wLadder, ladder ? 1 : 0, 11, dt);
    wSprint = damp(wSprint, st.sprinting && sXZ > 4.6 && !air ? 1 : 0, 8, dt);
    wAct = damp(wAct, held && held.action ? 1 : 0, 6, dt);
    mv = damp(mv, sstep(0.2, 1.4, sXZ), 10, dt);
    pitch = damp(pitch, clamp(+st.aimPitch || 0, -1.45, 1.45), 20, dt);
    if (sXZ > 0.2) { gdx = damp(gdx, w.vL.x / sXZ, 12, dt); gdz = damp(gdz, w.vL.z / sXZ, 12, dt); const l = Math.hypot(gdx, gdz) || 1; gdx /= l; gdz /= l; }
    recoil = damp(recoil, 0, 15, dt); land = damp(land, 0, 8, dt);
    if (st.phase === 'landing' && lastPhase !== 'landing') land = 1;
    lastPhase = st.phase;
    const cycle = 0.8 + 0.28 * spd;
    if (!air) phase += (dt * spd) / cycle;
    if (ladder) climbed += (+climb.climbSpeed || 0) * dt;
    if (mantle) { ledgeH = +climb.ledgeHeight || 0; ledgeZ = (+climb.ledgeDistance || 0) + 0.3; }
    const run = sstep(3.2, 6.2, spd), ph = phase * Math.PI * 2, wClimb = Math.max(wMantle, wLadder), armed = wArm * (1 - wClimb);
    const mantleUp = wMantle * sstep(0.15, 0.6, ledgeH);

    // ---- pelvis and spine
    const stride = Math.cos(ph * 2), sway = Math.sin(ph);
    const hipY = 0.968 - 0.03 * armed - 0.41 * wCrouch - mv * (0.018 + 0.04 * run) - mv * (0.014 + 0.016 * run) * stride - land * 0.15 * (1 - wAir) - 0.05 * wLadder - 0.02 * wAir;
    B.hips.position.set(mv * 0.012 * sway + 0.01 * wLadder * Math.sin(climbed * 5.2), hipY, -0.07 * wCrouch + 0.05 * wLadder + 0.05 * mantleUp - 0.02 * armed);
    const bodyYaw = -0.2 * armed * (1 - 0.6 * wSprint);
    ypr(B.hips.quaternion, 0.03 * armed + 0.1 * wSprint * mv + 0.1 * wCrouch + 0.06 * mv * run + 0.16 * mantleUp + 0.05 * wLadder, bodyYaw + mv * 0.07 * sway, mv * 0.03 * sway);
    ypr(B.spine.quaternion, 0.05 * armed + 0.26 * wCrouch + 0.12 * wSprint * mv - pitch * 0.22 * armed + 0.14 * mantleUp + 0.05 * wLadder + land * 0.12, -0.1 * armed - mv * 0.1 * sway, -mv * 0.03 * sway);
    ypr(B.chest.quaternion, 0.04 * armed + 0.2 * wCrouch + 0.1 * wSprint * mv - pitch * 0.2 * armed + 0.1 * mantleUp + 0.012 * Math.sin(time * 1.5), -0.14 * armed * (1 - 0.6 * wSprint) - mv * 0.08 * sway, 0);
    rp.hips.copy(B.hips.position); rq.hips.copy(B.hips.quaternion);
    rq.spine.multiplyQuaternions(rq.hips, B.spine.quaternion); rp.spine.copy(B.spine.position).applyQuaternion(rq.hips).add(rp.hips);
    rq.chest.multiplyQuaternions(rq.spine, B.chest.quaternion); rp.chest.copy(B.chest.position).applyQuaternion(rq.spine).add(rp.spine);
    // head keeps facing where the player looks, whatever the torso does
    ypr(w.q, -pitch * 0.72 + 0.34 * wAct * armed + 0.1 * wSprint * mv - 0.3 * mantleUp - 0.25 * wLadder + 0.1 * wCrouch * (1 - armed), 0.14 * wAct * armed, 0.24 * armed * (1 - wSprint) * (1 - wAct));
    B.neck.quaternion.copy(w.qa.copy(rq.chest).invert().multiply(w.q)).slerp(w.qb.identity(), 0.55);
    rq.neck.multiplyQuaternions(rq.chest, B.neck.quaternion);
    B.head.quaternion.copy(w.qa.copy(rq.neck).invert()).multiply(w.q);

    // ---- weapon anchor: pivots at the shoulder pocket, barrel along the line of sight
    ypr(w.qa, -pitch, 0, 0);
    ypr(w.qb, 0.62, 0.8, -0.25); // sprint: low ready across the body
    weapon.quaternion.copy(w.qa).slerp(w.qb, wSprint * mv);
    w.v.set(-0.105, 0.222, 0.075).applyQuaternion(rq.chest).add(rp.chest); // shoulder pocket: inboard of the right shoulder joint
    w.v2.set(0, -0.058, 0.262).applyQuaternion(w.qa).add(w.v);
    w.v.set(-0.13, -0.06, 0.2).applyQuaternion(rq.chest).add(rp.chest);
    weapon.position.copy(w.v2).lerp(w.v, wSprint * mv);
    weapon.position.y += 0.0025 * Math.sin(time * 1.7) + mv * 0.006 * Math.cos(ph * 2 + 0.6);
    weapon.position.addScaledVector(w.v.set(0, 0.004, -0.024).applyQuaternion(weapon.quaternion), recoil);
    weapon.quaternion.multiply(w.q.setFromAxisAngle(AX, -0.035 * recoil));

    // ---- arms
    for (const [side, s] of SIDES) {
      const h = hand[side], isR = s < 0;
      w.sh.copy(B['uarm' + side].position).applyQuaternion(rq.chest).add(rp.chest);
      // relaxed / running / airborne
      const sw = mv * Math.sin(ph + (isR ? 0 : Math.PI)) * (0.16 + 0.1 * run);
      h.pos.set(s * (0.05 + 0.12 * wAir), -0.5 + 0.13 * run * mv + 0.12 * wAir + Math.abs(sw) * 0.25, 0.05 + 0.12 * run * mv + sw + 0.1 * wAir).applyQuaternion(rq.hips).add(w.sh);
      h.pole.set(s * 0.25, 0.15, -1);
      h.wq = 0;
      mix(h.pose, POSE_RELAX, POSE_RUNG, 0.35 * run * mv);
      // armed: the World's grasp targets on the gun
      if (armed > 0.001) {
        const src = held ? (isR ? held.grip : held.support) : null;
        if (isR || !held || held.support !== null) {
          const r = grasp(s, src, isR ? DEF_GRIP_P : DEF_SUP_P, isR ? DEF_GRIP_Q : DEF_SUP_Q, w.tp, w.tq);
          h.pos.lerp(w.tp, armed); h.q.copy(w.tq); h.wq = armed;
          h.pole.lerp(isR ? w.v.set(-0.3, -1, -0.55) : w.v.set(0.35, -1, -0.1), armed);
          if (src) h.grip = wrapPose(r, isR);
          mix(h.pose, h.pose, h.grip, armed);
        }
      }
      if (wMantle > 0.001) {
        // palms flat on the ledge; above it they push down beside the hips
        w.c.set(s * 0.2, clamp(ledgeH, -0.2, 2.3) + 0.012, ledgeZ + 0.1);
        palmAt(s, w.c, w.F.set(-s * 0.2, 0, 0.98).normalize(), w.N.set(0, -1, 0), 0, w.tp, w.tq);
        const k = wMantle * sstep(0.1, 0.45, ledgeH);
        h.pos.lerp(w.tp, k); if (h.wq > 0.001) h.q.slerp(w.tq, k); else h.q.copy(w.tq); h.wq = Math.max(h.wq * (1 - k), k);
        h.pole.lerp(w.v.set(s * 0.8, -0.5, -0.5), k);
        mix(h.pose, h.pose, POSE_FLAT, k);
      }
      if (wLadder > 0.001) {
        const u = (climbed + 1.52 - (isR ? 0.3 : 0)) / 0.6, f = Math.floor(u), y = 0.6 * (f + sstep(0.25, 0.75, u - f)) + (isR ? 0.3 : 0) - climbed;
        const reach = Math.sin(Math.PI * sstep(0.25, 0.75, u - f)) * 0.07;
        w.c.set(s * 0.17, y, 0.4 - reach);
        palmAt(s, w.c, w.F.set(0, 0.25, 0.97).normalize(), w.N.set(0, -0.97, 0.25).normalize(), 0.016, w.tp, w.tq);
        h.pos.lerp(w.tp, wLadder); if (h.wq > 0.001) h.q.slerp(w.tq, wLadder); else h.q.copy(w.tq); h.wq = Math.max(h.wq * (1 - wLadder), wLadder);
        h.pole.lerp(w.v.set(s * 0.6, -1, -0.3), wLadder);
        mix(h.pose, h.pose, POSE_RUNG, wLadder * (1 - 0.6 * Math.sin(Math.PI * sstep(0.25, 0.75, u - f))));
      }
      solveArm(side, h.pos, h.pole, h.q, h.wq);
      setFingers(side, s, h.pose);
    }

    // ---- legs
    const stf = lerp(0.62, 0.4, run), A = Math.min(0.42, (stf * cycle) / 2) * (1 - 0.35 * wCrouch), lift = lerp(0.07, 0.24, run);
    const stag = armed * (1 - 0.7 * mv) + 0.6 * wCrouch * (1 - armed);
    for (const [side, s] of SIDES) {
      const f = foot[side], isR = s < 0, g = f.g;
      gait(phase + (isR ? 0.5 : 0), A, lift, stf, run, g);
      let yaw = (isR ? -0.42 : 0.06) * stag + s * 0.08, fp = g.p * mv;
      f.pos.set(s * (0.1 + 0.022 * stag) + gdx * g.o * mv, ANKLE_Y + g.h * mv, (isR ? -0.11 : 0.11) * stag + gdz * g.o * mv - 0.02 * armed);
      if (isR && wCrouch > 0.001) { fp += 0.5 * wCrouch * (1 - mv); f.pos.y += 0.045 * wCrouch * (1 - mv); f.pos.z -= 0.08 * wCrouch; }
      f.pole.set(s * 0.12 + Math.sin(yaw) * 0.6, 0, 1);
      if (wAir > 0.001) {
        const tuck = clamp(vy / 6, -0.6, 1);
        w.v.set(s * 0.1, hipY - 0.045 - (isR ? 0.72 : 0.6) + 0.1 * tuck, (isR ? -0.14 : 0.16) + 0.04 * tuck);
        f.pos.lerp(w.v, wAir); fp = lerp(fp, isR ? 0.55 : 0.2, wAir);
      }
      if (wMantle > 0.001) {
        // left knee comes up onto the ledge, the right leg trails
        if (isR) w.v.set(-0.11, Math.min(0.12, ledgeH * 0.2) + ANKLE_Y, -0.16);
        else { const on = sstep(1.15, 0.75, ledgeH); w.v.set(0.13, lerp(0.34, Math.max(0, ledgeH) + ANKLE_Y + 0.01, on), lerp(ledgeZ - 0.2, ledgeZ + 0.06, on)); }
        f.pos.lerp(w.v, mantleUp); fp = lerp(fp, isR ? 0.7 : 0.05, mantleUp);
        f.pole.lerp(w.v2.set(s * 0.35, 0.2, 1), mantleUp);
      }
      if (wLadder > 0.001) {
        const u = (climbed + 0.3 - (isR ? 0 : 0.3)) / 0.6, fl = Math.floor(u), k = sstep(0.25, 0.75, u - fl), y = 0.6 * (fl + k) + (isR ? 0 : 0.3) - climbed;
        w.v.set(s * 0.11, y + ANKLE_Y + 0.025, 0.28 - Math.sin(Math.PI * k) * 0.06);
        f.pos.lerp(w.v, wLadder); fp = lerp(fp, 0.12, wLadder); yaw = lerp(yaw, s * 0.2, wLadder);
        f.pole.lerp(w.v2.set(s * 0.55, 0, 1), wLadder);
      }
      ypr(f.q, fp, bodyYaw * 0.3 + yaw, 0);
      solveLeg(side, f.pos, f.pole, f.q);
      B['toe' + side].quaternion.setFromAxisAngle(AX, -Math.max(0, fp) * 0.8 * (1 - wAir));
    }
  }

  const capabilities = soldierCapabilities();
  return {
    object3D: root,
    capabilities,
    setLocomotion(state) { if (state) st = state; },
    setMotion() {},
    update,
    getAnchor(name) { return Object.prototype.hasOwnProperty.call(anchors, name) ? anchors[name] : null; },
    playAction(name) {
      if (name !== 'duoworld:fire') return { ok: false, reason: 'ACTION_UNSUPPORTED' };
      recoil = 1;
      return { ok: true };
    },
    stopAction() { return { ok: true }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (root.parent) root.parent.remove(root);
      for (const m of meshes) root.remove(m);
      skeleton.dispose();
      releaseShared(S);
    },
  };
}

function soldierCapabilities() {
  return {
    locomotion: { walk: { referenceSpeed: 3.8 }, run: { referenceSpeed: 6.4 }, jump: true, fall: true, land: true, modes: ['duoworld:climb'] },
    actions: ['duoworld:fire'],
    anchors: ['weapon', 'weaponStow', 'head', 'chest', 'leftHand', 'rightHand'],
    held: ['rifle'],
  };
}

function registerSoldier(global, CFG) {
  global.DuoWorldAvatars.register({
    id: CFG.id,
    version: CFG.version,
    metadata: { name: CFG.name, height: CFG.height, radius: 0.3, eyeHeight: 1.67, gender: 'male', firstPersonArms: CFG.firstPersonArms },
    protocol: { name: 'duoworld-avatar', version: '1.1', compatible: ['1.0', '1.1'] },
    capabilities: soldierCapabilities(),
    visual: { representation: 'three.object3d', adapter: 'three' },
    create: function (ctx) { return Promise.resolve(createSoldierInstance(ctx.THREE, CFG)); },
  });
}
