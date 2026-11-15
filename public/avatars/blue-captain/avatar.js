// Avatar Package · blue-captain (Avatar interface v1.1)
// 蓝衣船长: a bearded harbour captain in a navy coat and white cap. Blocky rigid-part model (model.glb, node animations
// idle / walk / run / jump / fall / land / wave), built by scripts/build-avatar-models.mjs.
// setLocomotion() is driven by the world's real physics (grounded / takeoff /
// airborne / landing, speed, velocity); also offers playAction('wave') and anchors.
window.DuoWorldAvatars.register('blue-captain', {
  name: '蓝衣船长',
  version: '1.1.0',
  metadata: { height: 1.6, radius: 0.3, eyeHeight: 1.42, gender: 'male' },
  async create(ctx) {
    const { THREE } = ctx;
    const gltf = await ctx.loadGLTF('model.glb');
    const root = new THREE.Group();
    root.add(gltf.scene);
    const mixer = new THREE.AnimationMixer(gltf.scene);
    const A = {};
    for (const clip of gltf.animations) A[clip.name] = mixer.clipAction(clip);
    for (const n of ['jump', 'land']) if (A[n]) { A[n].setLoop(THREE.LoopOnce, 1); A[n].clampWhenFinished = true; }
    if (A.fall) { A.fall.setLoop(THREE.LoopPingPong, Infinity); }
    let base = null, waving = null;
    const fade = (name, t = 0.18) => {
      const a = A[name];
      if (!a || a === base) return a;
      a.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(t).play();
      if (base) base.fadeOut(t);
      base = a;
      return a;
    };
    fade('idle');
    // anchors are found by this package's own node names (the world never looks at them)
    const sockets = { 'hand.right': gltf.scene.getObjectByName('hand_r_socket'), head: gltf.scene.getObjectByName('head') };
    const lastPhase = { v: 'grounded' };
    // ---- held rifle: this package's own prop and arm pose (the World knows nothing about either).
    // The arms are rigid boxes hanging from a shoulder pivot, so the hold is solved once from this
    // model's own proportions: both straight arms reach forward to a pair of grips side by side,
    // a little below shoulder height (the blocky "aim" pose); a chunky rifle in this avatar's
    // colours sits on the hands (child of the chest, so it follows the torso), and every frame,
    // after the clips have been applied, both arms are pointed at it. Legs, torso and head keep
    // their animation.
    const rifle = ((names, colors) => {
      const V = THREE.Vector3, scene = gltf.scene;
      const chest = scene.getObjectByName(names.chest);
      const armT = scene.getObjectByName(names.trigger), armS = scene.getObjectByName(names.support);
      const handT = scene.getObjectByName(names.trigger + '_hand'), handS = scene.getObjectByName(names.support + '_hand');
      if (!chest || !armT || !armS || !handT || !handS) return null;
      const box3 = (m) => (m.geometry.computeBoundingBox(), m.geometry.boundingBox);
      const centre = (m) => box3(m).getCenter(new V()).add(m.position);
      const S1 = armT.position, S2 = armS.position, r1 = centre(handT).length(), r2 = centre(handS).length();
      const side = Math.sign(S2.x - S1.x) || 1, mid = (S1.x + S2.x) / 2;
      const half = (box3(handT).max.x - box3(handT).min.x) / 2 + 0.003; // hands side by side
      const want = S1.y - 0.13; // grip height: a little below the shoulders
      const C = new V(), best = new V(), GT = new V(), GS = new V();
      let cost = Infinity;
      for (let ix = -10; ix <= 10; ix++)
        for (let iy = 0; iy <= 40; iy++)
          for (let iz = 0; iz <= 70; iz++) {
            C.set(mid + ix * 0.005, S1.y - iy * 0.01, 0.1 + iz * 0.01);
            GT.copy(C).x -= side * half;
            GS.copy(C).x += side * half;
            const c = (GT.distanceTo(S1) - r1) ** 2 + (GS.distanceTo(S2) - r2) ** 2 + 0.02 * ((C.y - want) ** 2 + (C.x - mid) ** 2);
            if (c < cost) (cost = c), best.copy(C);
          }
      const down = new V(0, -1, 0);
      GT.copy(best).x -= side * half;
      GS.copy(best).x += side * half;
      const qT = new THREE.Quaternion().setFromUnitVectors(down, GT.sub(S1).normalize());
      const qS = new THREE.Quaternion().setFromUnitVectors(down, GS.sub(S2).normalize());
      // the stock stops just in front of the chest
      let front = 0;
      for (const m of chest.children) if (m.isMesh) front = Math.max(front, box3(m).max.z + m.position.z);
      const back = Math.min(-0.16, front + 0.015 - best.z);
      const mat = (hex, metal = 0) => new THREE.MeshStandardMaterial({ color: hex, roughness: metal ? 0.45 : 0.8, metalness: metal });
      const M = { body: mat(colors.body), dark: mat(colors.dark), accent: mat(colors.accent), metal: mat(colors.metal, 0.5) };
      const gun = new THREE.Group();
      gun.name = 'held_rifle';
      gun.position.copy(best);
      // [min, max] boxes in the rifle's frame: origin = between the two hands, +Z = muzzle, +Y = up
      for (const [lo, hi, m] of [
        [[-0.05, 0.045, -0.13], [0.05, 0.15, 0.15], 'body'], // receiver (resting on the hands)
        [[-0.052, 0.085, -0.09], [0.052, 0.11, 0.12], 'accent'], // side stripe
        [[-0.038, 0.04, back + 0.035], [0.038, 0.135, -0.13], 'body'], // stock
        [[-0.045, 0.025, back], [0.045, 0.145, back + 0.035], 'dark'], // butt pad
        [[-0.03, -0.1, 0.07], [0.03, 0.045, 0.14], 'dark'], // magazine
        [[-0.042, 0.06, 0.15], [0.042, 0.14, 0.4], 'dark'], // handguard
        [[-0.044, 0.085, 0.35], [0.044, 0.115, 0.38], 'accent'], // handguard band
        [[-0.02, 0.085, 0.4], [0.02, 0.118, 0.62], 'metal'], // barrel
        [[-0.028, 0.078, 0.6], [0.028, 0.125, 0.66], 'dark'], // muzzle
        [[-0.016, 0.15, -0.07], [0.016, 0.19, 0.0], 'metal'], // rear sight
        [[-0.01, 0.14, 0.36], [0.01, 0.18, 0.38], 'metal'], // front sight
      ]) {
        const g = new THREE.BoxGeometry(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
        g.translate((hi[0] + lo[0]) / 2, (hi[1] + lo[1]) / 2, (hi[2] + lo[2]) / 2);
        const mesh = new THREE.Mesh(g, M[m]);
        mesh.castShadow = mesh.receiveShadow = true;
        gun.add(mesh);
      }
      chest.add(gun);
      let wS = 1; // support arm weight (0 while that arm is busy waving)
      const level = new THREE.Quaternion(), q = new THREE.Quaternion(), arm = best.clone().sub(S1);
      const hold = {
        apply(dt, waving) {
          wS += ((waving ? 0 : 1) - wS) * (dt > 0 ? 1 - Math.exp(-dt / 0.12) : 1);
          // undo the clip's chest lean / sway, so arms and rifle stay level while the torso moves
          level.copy(chest.quaternion).invert();
          gun.quaternion.copy(level);
          gun.position.copy(arm).applyQuaternion(level).add(S1);
          armT.quaternion.multiplyQuaternions(level, qT);
          armS.quaternion.slerp(q.multiplyQuaternions(level, qS), wS);
        },
      };
      hold.apply(0, false);
      return hold;
    })({ 'chest': 'chest', 'trigger': 'upperarm_l', 'support': 'upperarm_r' }, { body: 0x8a5a32, dark: 0x343944, accent: 0xd9a63a, metal: 0xb0b6be });
    return {
      object3D: root,
      setMotion(m) { fade(m); }, // v1 fallback
      setLocomotion(s) {
        if (s.phase === 'takeoff') fade('jump', 0.08);
        else if (s.phase === 'airborne') { if (!(s.velocity.y > 0.5 && base === A.jump)) fade('fall', 0.25); } // rising: hold the jump pose
        else if (s.phase === 'landing') fade('land', 0.06);
        else {
          const name = s.speed < 0.15 ? 'idle' : s.speed > 4 ? 'run' : 'walk';
          const a = fade(name, lastPhase.v === 'landing' ? 0.25 : 0.18);
          if (a && name !== 'idle') a.setEffectiveTimeScale(Math.max(0.5, s.speed / (name === 'run' ? 5.6 : 2.3)));
        }
        lastPhase.v = s.phase;
      },
      update(dt) { mixer.update(dt); if (rifle) rifle.apply(dt, !!waving && waving.isRunning()); },
      playAction(name) {
        if (name !== 'wave' || !A.wave) return false;
        waving = A.wave; waving.reset().setLoop(THREE.LoopOnce, 1); waving.setEffectiveWeight(2.5).play();
        return true;
      },
      stopAction() { if (waving) { waving.fadeOut(0.2); waving = null; } },
      getAnchor(name) { return sockets[name] || null; },
      dispose() {
        mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
        gltf.scene.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) [].concat(o.material).forEach((m) => m.dispose());
        });
        root.clear();
      },
    };
  },
});
