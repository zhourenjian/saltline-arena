// Test package (Avatar 1.0): setMotion only. Records the motions the World sends.
(function () {
  var rec = ((window.__probe = window.__probe || {})["probe-v1"] = {
    creates: 0,
    disposes: 0,
    updates: 0,
    motions: [],
  });
  window.DuoWorldAvatars.register({
    id: "probe-v1",
    version: "1.0.0",
    metadata: { height: 1.5 },
    create: function (ctx) {
      var THREE = ctx.THREE;
      rec.creates++;
      var root = new THREE.Group(),
        geo = new THREE.CylinderGeometry(0.25, 0.25, 1.5),
        mat = new THREE.MeshStandardMaterial({ color: 0xaa4422 });
      var m = new THREE.Mesh(geo, mat);
      m.position.y = 0.75;
      root.add(m);
      return Promise.resolve({
        object3D: root,
        setMotion: function (x) {
          rec.motions.push(x);
        },
        update: function () {
          rec.updates++;
        },
        dispose: function () {
          rec.disposes++;
          geo.dispose();
          mat.dispose();
        },
      });
    },
  });
})();
