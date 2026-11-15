// Avatar Package · voxel-walker (Avatar interface v1: setMotion only)
// Loaded by <script src="avatars/voxel-walker/avatar.js">; registers itself.
window.DuoWorldAvatars.register({
  id: 'voxel-walker',
  name: '墨衣行者',
  version: '1.0.0',
  metadata: { height: 1.96, radius: 0.28, eyeHeight: 1.62 },
  async create(ctx) {
    const { THREE } = ctx;
    const gltf = await ctx.loadGLTF('model.glb'); // relative to this package
    const root = new THREE.Group();
    root.add(gltf.scene);
    const mixer = new THREE.AnimationMixer(gltf.scene);
    const actions = {};
    for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);
    let current = null;
    const play = (name) => {
      const a = actions[name];
      if (!a || a === current) return;
      a.reset().setEffectiveWeight(1).fadeIn(0.2).play();
      if (current) current.fadeOut(0.2);
      current = a;
    };
    play('idle');
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
    })({ 'chest': 'J_Spine', 'trigger': 'J_ArmL', 'support': 'J_ArmR' }, { body: 0x7a5636, dark: 0x2a2b30, accent: 0xb02a2a, metal: 0x9a9ea6 });
    return {
      object3D: root,
      setMotion(m) { play(m); },
      update(dt) { mixer.update(dt); if (rifle) rifle.apply(dt, false); },
      dispose() {
        mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
        gltf.scene.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) [].concat(o.material).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
        });
        root.clear();
      },
    };
  },
});
