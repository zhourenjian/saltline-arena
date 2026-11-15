// Test package: registers fine, but create() fails (missing model). The world
// must keep the previous avatar and stay interactive.
window.DuoWorldAvatars.register({
  id: "broken-avatar",
  name: "损坏的角色（测试）",
  version: "0.0.1",
  async create(ctx) {
    await ctx.loadGLTF("does-not-exist.glb");
    throw new Error("unreachable");
  },
});
