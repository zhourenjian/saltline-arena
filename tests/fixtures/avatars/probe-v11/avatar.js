// Test package (Avatar 1.1): a procedural body that records every call the World makes, so the
// tests can check that locomotion comes from the World's physics. Not a production avatar.
(function () {
  var rec = ((window.__probe = window.__probe || {})["probe-v11"] = {
    creates: 0,
    disposes: 0,
    updates: 0,
    motions: [],
    phases: [],
    last: null,
    maxUp: 0,
    minDown: 0,
    maxSpeed: 0,
    actions: [],
    stops: 0,
    contexts: [],
  });
  window.DuoWorldAvatars.register({
    id: "probe-v11",
    version: "1.1.0",
    protocol: { name: "duoworld-avatar", version: "1.1" },
    metadata: { name: "Probe 1.1", height: 2.0, radius: 0.3 },
    visual: { representation: "three.object3d", adapter: "three" },
    create: function (ctx) {
      var THREE = ctx.THREE;
      rec.creates++;
      rec.contexts.push({
        hasTHREE: !!THREE,
        baseUrl: ctx.baseUrl,
        loadGLTF: typeof ctx.loadGLTF,
      });
      var root = new THREE.Group();
      var geo = new THREE.BoxGeometry(0.5, 2, 0.3),
        mat = new THREE.MeshStandardMaterial({ color: 0x22aa66 });
      var body = new THREE.Mesh(geo, mat);
      body.position.y = 1;
      var head = new THREE.Object3D();
      head.position.set(0, 1.9, 0);
      root.add(body, head);
      return {
        object3D: root,
        capabilities: { actions: ["duoworld:interact"], anchors: ["head"] },
        setMotion: function (m) {
          rec.motions.push(m);
        },
        setLocomotion: function (s) {
          rec.last = JSON.parse(JSON.stringify(s));
          var prev = rec.phases[rec.phases.length - 1];
          if (prev !== s.phase) rec.phases.push(s.phase);
          rec.maxUp = Math.max(rec.maxUp, s.velocity.y);
          rec.minDown = Math.min(rec.minDown, s.velocity.y);
          rec.maxSpeed = Math.max(rec.maxSpeed, s.speed);
        },
        update: function () {
          rec.updates++;
        },
        playAction: function (name, opts) {
          rec.actions.push([name, opts && opts.target]);
          return true;
        },
        stopAction: function (name) {
          rec.stops++;
        },
        getAnchor: function (name) {
          return name === "head" ? head : null;
        },
        dispose: function () {
          rec.disposes++;
          geo.dispose();
          mat.dispose();
          root.clear();
        },
      };
    },
  });
})();
