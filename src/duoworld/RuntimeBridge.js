// RuntimeBridge: what a DuoWorld host runtime would otherwise provide, for standalone mode.
//   - owns the single requestAnimationFrame loop and calls world.update(dt)
//   - exposes window.DuoWorld = { setAvatar, getAvatar, listAvatars, ... }
//   - picks the initial avatar from window.DuoWorldInitialAvatar or ?avatar=
//
// It is deliberately thin so a future @duoworld/sdk host can replace it: if a host already
// installed window.DuoWorld (marked with __host), the bridge leaves it alone and only drives the
// loop when asked. No sandbox is provided: Avatar Package scripts run with page privileges.
import { DuoWorldError } from "./protocol/protocol.js";

var BRIDGE_VERSION = "0.1.0";

function createRuntimeBridge(world, options = {}) {
  let global = options.global || window,
    raf = 0,
    last = 0,
    installed = null,
    running = !1;

  function tick(now) {
    raf = global.requestAnimationFrame(tick);
    // optional frame cap (the World decides): skip display frames instead of running late
    let cap = typeof world.frameCap == "function" ? world.frameCap() : 0;
    if (cap > 0 && now - last < 1000 / cap - 3) return;
    let dt = (now - last) / 1e3;
    last = now;
    try {
      world.update(dt);
    } catch (e) {
      console.error("[bridge] world.update threw", e);
    }
  }

  function api() {
    return {
      __bridge: BRIDGE_VERSION,
      version: BRIDGE_VERSION,
      world: {
        id: world.id,
        version: world.version,
        protocol: world.protocol,
        protocolVersion: world.protocolVersion,
        capabilities: world.capabilities,
        coordinates: world.coordinates,
        renderCapabilities: world.renderCapabilities,
        get state() {
          return world.state;
        },
      },
      setAvatar: (id) => world.setAvatar(id),
      getAvatar: () => world.getAvatar(),
      listAvatars: () => world.listAvatars(),
      setCameraMode: (mode) => world.setCameraMode(mode),
      getCameraMode: () => world.getCameraMode(),
      playAction: (name, opts) => world.playAction(name, opts),
      stopAction: (name) => world.stopAction(name),
      getAnchor: (name) => world.getAnchor(name),
      objects: world.objects,
      sandbox: { untrustedCode: "not-isolated" },
    };
  }

  function initialAvatar(params) {
    let fromGlobal = global.DuoWorldInitialAvatar;
    if (typeof fromGlobal === "string" && fromGlobal) return fromGlobal;
    return (params && params.avatar) || null;
  }

  return {
    async start({ params } = {}) {
      if (running)
        throw new DuoWorldError("BRIDGE_RUNNING", "bridge already started");
      running = !0;
      let host = global.DuoWorld;
      host && host.__host
        ? console.info(
            "[bridge] a DuoWorld host owns window.DuoWorld; not replacing it",
          )
        : (global.DuoWorld = installed = api());
      await world.load();
      let id = initialAvatar(params),
        cameraMode =
          params &&
          (params.view === "third"
            ? "third-person"
            : params.view === "first"
              ? "first-person"
              : null);
      ((last = performance.now()), (raf = global.requestAnimationFrame(tick)));
      await world.enter({
        avatar: id || void 0,
        cameraMode: cameraMode || void 0,
      });
      return world;
    },
    async stop() {
      if (!running) return;
      ((running = !1),
        global.cancelAnimationFrame(raf),
        (raf = 0),
        await world.dispose());
      installed && global.DuoWorld === installed && delete global.DuoWorld;
      installed = null;
    },
    get running() {
      return running;
    },
  };
}

export { createRuntimeBridge, BRIDGE_VERSION };
