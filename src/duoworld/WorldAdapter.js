// WorldAdapter: the DuoWorld lifecycle around the unchanged Saltline game.
//
//   load()      build every system once (original boot order), attach AvatarHost + objects
//   enter(ctx)  start reacting to input, optionally wear an avatar / pick a camera / start
//   update(dt)  one frame of the original loop body; the caller owns the loop (no second loop)
//   leave()     pause the mission, release the pointer, stop reacting to input
//   dispose()   release listeners, timers, audio, GPU resources and injected DOM; the same
//               world object can be load()ed again afterwards
//
// The scene code is shared by both modes: standalone (RuntimeBridge drives update) and World
// Package (a DuoWorld host drives update).
import "./compatibility/avatar-registry.js";
import "../world/props/register.js";
import { createLifetime } from "../core/lifetime.js";
import { createWorldRuntime } from "../app/runtime.js";
import { createAvatarHost } from "./AvatarHost.js";
import { createWorldObjects } from "./WorldObjects.js";
import { createCharacterSelect, characterMenuConfig, loadCharacterChoice } from "../lobby/characters.js";
import { createVersus } from "../versus/versus.js";
import { createBrawl } from "../brawl/brawl.js";
import { createNetStats } from "../ui/net-stats.js";
import {
  PROTOCOL,
  PROTOCOL_VERSION,
  WORLD_ID,
  WORLD_VERSION,
  WORLD_CAPABILITIES,
  WORLD_COORDINATES,
  RENDER_CAPABILITIES,
  AVATAR_PROTOCOL_VERSIONS,
  CAMERA_MODES,
  DuoWorldError,
} from "./protocol/protocol.js";

var APP_MARKUP = `<canvas id="view" tabindex="0"></canvas>
<div id="ui"></div>
<div id="boot">
  <div class="boot-mark">SALTLINE</div>
  <div class="boot-sub" id="boot-msg">Raising the terminal</div>
  <div class="boot-bar"><i id="boot-fill"></i></div>
</div>`;

// the systems look up #app/#view/#ui/#boot by id, so one live world per document
var liveWorld = null;

function createSaltlineWorld(options = {}) {
  let state = "created", // created → loaded ⇄ entered → (dispose) → created
    loading = null,
    lifetime = null,
    runtime = null,
    context = null,
    avatars = null,
    objects = null,
    characters = null,
    versus = null,
    brawl = null,
    netStats = null,
    mounted = null, // DOM this world created or changed, restored on dispose
    queuedAvatar = void 0,
    queuedCamera = null,
    cycle = 0;

  function mount() {
    let record = {
      app: null,
      createdApp: !1,
      styles: [],
      bootClass: "",
      bootHidden: !1,
    };
    let app = document.getElementById("app");
    if (!app) {
      ((app = document.createElement("div")),
        (app.id = "app"),
        (app.innerHTML = APP_MARKUP),
        (options.container || document.body).appendChild(app),
        (record.createdApp = !0));
    }
    record.app = app;
    for (let css of options.styles || []) {
      let el = document.createElement("style");
      ((el.dataset.duoworldWorld = WORLD_ID),
        (el.textContent = css),
        document.head.appendChild(el),
        record.styles.push(el));
    }
    let boot = document.getElementById("boot");
    boot &&
      ((record.bootClass = boot.className), (record.bootHidden = boot.hidden));
    return record;
  }

  function unmount(record) {
    if (!record) return;
    for (let el of record.styles) el.remove();
    if (record.createdApp) return void record.app.remove();
    // standalone page: keep its markup, but hand back a fresh canvas (the old one holds a lost
    // WebGL context), an empty #ui and the boot screen as it was
    let canvas = document.getElementById("view");
    if (canvas) {
      let fresh = canvas.cloneNode(!1);
      (fresh.removeAttribute("style"), canvas.replaceWith(fresh));
    }
    let ui = document.getElementById("ui");
    ui && ui.replaceChildren();
    let boot = document.getElementById("boot");
    boot &&
      ((boot.className = record.bootClass), (boot.hidden = record.bootHidden));
  }

  async function doLoad() {
    if (liveWorld && liveWorld !== world)
      throw new DuoWorldError(
        "WORLD_BUSY",
        "another Saltline world is loaded in this document; dispose it first",
      );
    let my = ++cycle,
      myMount = mount(),
      myLifetime = createLifetime(),
      myRuntime = createWorldRuntime({
        params: options.params,
        lifetime: myLifetime,
      }),
      undo = () => {
        (myRuntime.teardown(), myLifetime.dispose(), unmount(myMount));
        runtime === myRuntime &&
          (liveWorld === world && (liveWorld = null),
          (mounted = lifetime = runtime = context = null),
          (state = "created"));
      };
    ((liveWorld = world),
      (myLifetime.active = !1),
      (mounted = myMount),
      (lifetime = myLifetime),
      (runtime = myRuntime));
    let booted;
    try {
      booted = await myRuntime.boot();
    } catch (e) {
      throw (undo(), e);
    }
    // dispose() ran while booting: release what this boot created
    if (my !== cycle)
      throw (
        undo(),
        new DuoWorldError("WORLD_DISPOSED", "world was disposed during load")
      );
    context = booted;
    ((avatars = createAvatarHost(context, { avatarRoot: options.avatarRoot })),
      (objects = createWorldObjects(context)),
      // main-menu modes: character select and the 1v1 duel (standalone game only; a showcase
      // page has no menus)
      context.game && context.game.menus && context.game.menus.field
        ? ((characters = context.characters =
            createCharacterSelect(context, avatars, {
              menu: globalThis.SaltlineCharacters,
              catalogUrl: new URL(
                "catalog.json",
                new URL(options.avatarRoot || "./avatars/", document.baseURI),
              ).href,
            })),
          (versus = createVersus(context, avatars)),
          // the brawl is created after the AvatarHost so its spectator camera hook runs last
          (brawl = createBrawl(context, avatars)),
          (netStats = context.netStats = createNetStats(context)))
        : null,
      // T toggles the over-the-shoulder view, only while an Avatar Package is worn
      lifetime.listen(window, "keydown", (e) => {
        e.code !== "KeyT" ||
          e.repeat ||
          !avatars.getAvatar() ||
          !context.game ||
          context.game.state !== "playing" ||
          avatars.setCameraMode(
            avatars.getCameraMode() === "third-person"
              ? "first-person"
              : "third-person",
          );
      }),
      (state = "loaded"));
    queuedCamera && avatars.setCameraMode(queuedCamera);
    // the player's saved character, unless the host already asked for one
    if (queuedAvatar === void 0 && characters) {
      // a saved choice the menu no longer offers (hidden, or the operator when it is off) falls
      // back to the configured default; the host's own choice (?avatar=, enter()) always wins
      let saved = loadCharacterChoice(),
        menu = characterMenuConfig(globalThis.SaltlineCharacters),
        known = (id) => !!(globalThis.DuoWorldAvatars && globalThis.DuoWorldAvatars.list().some((d) => d.id === id)),
        offered = typeof saved == "string" ? !menu.hide.has(saved) && known(saved) : saved === null && menu.builtIn;
      offered ? saved !== null && (queuedAvatar = saved) : menu.default && (queuedAvatar = menu.default);
    }
    if (queuedAvatar !== void 0) {
      let id = queuedAvatar;
      ((queuedAvatar = void 0),
        await avatars
          .setAvatar(id)
          .catch((e) => console.warn("[duoworld] initial avatar:", e.message)));
    }
    return world;
  }

  function requireLoaded(what) {
    if (state === "created")
      throw new DuoWorldError("WORLD_NOT_LOADED", `${what}: call load() first`);
  }

  let world = {
    id: WORLD_ID,
    version: WORLD_VERSION,
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: WORLD_CAPABILITIES,
    coordinates: WORLD_COORDINATES,
    renderCapabilities: RENDER_CAPABILITIES,
    avatarProtocols: AVATAR_PROTOCOL_VERSIONS,
    cameraModes: CAMERA_MODES,
    get state() {
      return state;
    },
    get context() {
      return context;
    },
    load() {
      if (state !== "created") return Promise.resolve(world);
      if (loading) return loading;
      let p = (loading = doLoad().finally(
        () => loading === p && (loading = null),
      ));
      return p;
    },
    async enter(ctx = {}) {
      (state === "created" && (await world.load()), requireLoaded("enter"));
      if (state !== "entered") {
        ((lifetime.active = !0), (state = "entered"));
        try {
          context.render.resize();
        } catch {}
      }
      ctx.cameraMode && avatars.setCameraMode(ctx.cameraMode);
      if (ctx.avatar !== void 0)
        await avatars
          .setAvatar(ctx.avatar)
          .catch((e) => console.warn("[duoworld] enter avatar:", e.message));
      ctx.autostart &&
        context.game.state === "title" &&
        context.game.start({ skipIntro: !0 });
      return world;
    },
    frameCap() {
      return (context && context.frameCap) || 0;
    },
    update(dt) {
      state === "entered" && runtime.frame(dt);
    },
    async leave() {
      if (state !== "entered") return;
      let game = context.game;
      try {
        game && game.state === "playing" && game.pause();
        context.input &&
          context.input.setGameplay &&
          context.input.setGameplay(!1);
        document.pointerLockElement && document.exitPointerLock();
        context.audio && context.audio.setPaused && context.audio.setPaused(!0);
      } catch (e) {
        console.error("[duoworld] leave", e);
      }
      ((lifetime.active = !1), (state = "loaded"));
    },
    async dispose() {
      if (loading) {
        // boot is in flight: doLoad() sees the new cycle and releases everything it created
        let pendingLoad = loading;
        (cycle++, (loading = null), (queuedAvatar = void 0));
        await pendingLoad.catch(() => {});
        return;
      }
      if (state === "created") return;
      (cycle++, state === "entered" && (await world.leave()));
      (netStats && netStats.dispose(),
        context && context.netStats === netStats && (context.netStats = null),
        brawl && brawl.dispose(),
        versus && versus.dispose(),
        characters && characters.dispose(),
        context && context.characters === characters && (context.characters = null),
        avatars && avatars.dispose(),
        objects && objects.dispose(),
        runtime && runtime.teardown(),
        lifetime && lifetime.dispose());
      (unmount(mounted),
        (mounted = null),
        (avatars = objects = characters = versus = brawl = netStats = null),
        (runtime = context = lifetime = null));
      (liveWorld === world && (liveWorld = null),
        (state = "created"),
        (loading = null));
    },

    // ---- avatar host (also exposed as window.DuoWorld by the RuntimeBridge)
    setAvatar(id) {
      if (!avatars) return ((queuedAvatar = id), Promise.resolve(null));
      return avatars.setAvatar(id);
    },
    getAvatar() {
      return avatars ? avatars.getAvatar() : null;
    },
    listAvatars() {
      if (avatars) return avatars.listAvatars();
      let r = window.DuoWorldAvatars;
      return r && r.list ? r.list().map((d) => ({ id: d.id })) : [];
    },
    setCameraMode(mode) {
      if (!CAMERA_MODES.includes(mode))
        throw new DuoWorldError(
          "CAMERA_MODE_UNSUPPORTED",
          `camera mode "${mode}" is not supported`,
        );
      return avatars ? avatars.setCameraMode(mode) : (queuedCamera = mode);
    },
    getCameraMode() {
      return avatars ? avatars.getCameraMode() : queuedCamera || "first-person";
    },
    playAction(name, opts) {
      return avatars
        ? avatars.playAction(name, opts)
        : Promise.resolve({ ok: !1, reason: "WORLD_NOT_LOADED" });
    },
    stopAction(name) {
      return avatars
        ? avatars.stopAction(name)
        : Promise.resolve({ ok: !1, reason: "WORLD_NOT_LOADED" });
    },
    getAnchor(name) {
      return avatars ? avatars.getAnchor(name) : null;
    },
    get avatarHost() {
      return avatars;
    },
    // ---- world interaction adapter
    objects: {
      list: () => (objects ? objects.list() : []),
      get: (id) => (objects ? objects.get(id) : null),
      on: (fn) => (objects ? objects.on(fn) : () => {}),
    },
  };
  return world;
}

export { createSaltlineWorld };
