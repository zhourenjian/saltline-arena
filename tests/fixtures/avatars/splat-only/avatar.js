// Test package: declares a Gaussian-splat body. This world renders Three.js
// meshes only, so it must refuse it with an explicit error (never fake it).
window.DuoWorldAvatars.register({
  id: "splat-only",
  name: "3DGS 角色（测试）",
  version: "0.0.1",
  representation: "gaussian-splat",
  create() {
    throw new Error("should never be called by a world without splat support");
  },
});
