// Test package: create() resolves to something that is not an Avatar instance.
window.DuoWorldAvatars.register({
  id: "bad-shape",
  version: "0.0.1",
  create: function () {
    return { object3D: null, setMotion: 1 };
  },
});
