// Character select: pick which body you wear (an installed Avatar Package, or the built-in
// operator). The choice is worn through AvatarHost.setAvatar(), shown live on a small stage in
// the harbor while the "character" screen is open, remembered in localStorage and sent to the
// other player in a 1v1 duel.
//
// Package-agnostic: the list comes from the avatar registry plus <avatarRoot>/catalog.json; no
// package id appears in this file, and the preview only calls the public instance API.
import { Vector3 } from "../vendor/three-r180.js";
import { AVATAR_COORDINATES } from "../duoworld/protocol/protocol.js";
import { PLAYER_MOVEMENT } from "../player/player.js";

var CHARACTER_KEY = "saltline.character.v1";
var ID = /^[a-z0-9][a-z0-9._-]*$/;

function loadCharacterChoice() {
  try {
    let v = JSON.parse(localStorage.getItem(CHARACTER_KEY) || "null");
    if (v && typeof v == "object" && "id" in v)
      return v.id === null ? null : ID.test(String(v.id)) ? String(v.id) : void 0;
  } catch {}
  return void 0; // nothing saved
}

function saveCharacterChoice(id) {
  try {
    localStorage.setItem(CHARACTER_KEY, JSON.stringify({ id: id ?? null }));
  } catch {}
}

var PREVIEW = {
  distance: 3.1, // camera → model, metres
  side: 0, // the picture is shifted into the free part of the screen instead (see layoutView)
  fov: 36,
  turnRate: 0.35, // rad/s idle turntable
};

// host config for the list (index.html sets window.SaltlineCharacters):
//   builtIn: false  → no "Operator" (no-avatar) entry
//   hide: [ids]     → installed packages that are not offered
//   default: id     → worn by players with no saved choice
function characterMenuConfig(cfg) {
  cfg = cfg && typeof cfg == "object" ? cfg : {};
  let hide = new Set((Array.isArray(cfg.hide) ? cfg.hide : []).filter((x) => typeof x == "string" && ID.test(x))),
    def = typeof cfg.default == "string" && ID.test(cfg.default) && !hide.has(cfg.default) ? cfg.default : null;
  return { builtIn: cfg.builtIn !== !1, hide, default: def };
}

function createCharacterSelect(context, avatars, options = {}) {
  let cfg = characterMenuConfig(options.menu),
    menus = context.game && context.game.menus,
    list = menus && menus.field("ch-list"),
    info = menus && menus.field("ch-info"),
    chip = menus && menus.field("char-name"),
    saved = loadCharacterChoice(),
    choice = saved === void 0 ? null : saved,
    catalog = [],
    names = new Map(),
    preview = null, // { entry, id }
    previewToken = 0,
    wearToken = 0,
    open = !1,
    turn = 0,
    stage = new Vector3(),
    eye = new Vector3(),
    look = new Vector3(),
    disposed = !1,
    offs = [];

  // ---- catalog
  async function loadCatalog() {
    if (!options.catalogUrl) return;
    try {
      let res = await fetch(options.catalogUrl, { cache: "no-cache" });
      if (!res.ok) return;
      let json = await res.json(),
        ids = Array.isArray(json && json.avatars) ? json.avatars : [];
      catalog = ids.filter((x) => typeof x == "string" && ID.test(x));
      open && render();
    } catch {}
  }

  function entries() {
    let known = new Map();
    for (let d of avatars.listAvatars()) known.set(d.id, d);
    for (let id of catalog) known.has(id) || known.set(id, { id, name: names.get(id) || id, pending: !0, supported: !0 });
    choice && !known.has(choice) && known.set(choice, { id: choice, name: names.get(choice) || choice, pending: !0, supported: !0 });
    for (let id of cfg.hide) known.delete(id);
    return [
      ...(cfg.builtIn ? [{ id: null, name: "Operator", note: "Built-in body", supported: !0 }] : []),
      ...[...known.values()].map((d) => ({
        id: d.id,
        name: d.name || d.id,
        note: d.pending
          ? "Avatar package"
          : d.supported
            ? `Avatar ${d.protocol || "1.x"} · ${d.representation}`
            : `Unsupported: ${d.representation}`,
        supported: d.supported !== !1,
      })),
    ];
  }

  function nameOf(id) {
    if (id == null) return "Operator";
    let d = avatars.listAvatars().find((x) => x.id === id);
    return (d && d.name) || names.get(id) || id;
  }

  function render() {
    if (!list) return;
    let items = entries();
    list.replaceChildren(
      ...items.map((it) => {
        let b = document.createElement("button"),
          small = document.createElement("small");
        ((b.type = "button"),
          (b.className = "ch-item"),
          b.setAttribute("role", "option"),
          b.setAttribute("aria-selected", String(it.id === choice)),
          (b.dataset.character = it.id ?? ""),
          (b.disabled = !it.supported),
          b.append(it.name),
          (small.textContent = it.note),
          b.append(small));
        return b;
      }),
    );
    chip && (chip.textContent = nameOf(choice));
  }

  function syncWorn() {
    let a = avatars.getAvatar();
    choice = a ? a.id : null;
  }

  function say(text, err) {
    info && ((info.textContent = text || ""), info.classList.toggle("err", !!err));
  }

  // ---- choosing
  async function select(id) {
    id = id === "" || id == null ? null : String(id);
    if (id !== null && !ID.test(id)) throw new Error(`invalid character id "${id}"`);
    let my = ++wearToken;
    say(id ? `Loading ${nameOf(id)}…` : "");
    try {
      await avatars.setAvatar(id);
    } catch (e) {
      if (my !== wearToken || (e && e.code === "AVATAR_SUPERSEDED")) return choice;
      say(`${nameOf(id)} could not be loaded: ${(e && e.message) || e}`, !0);
      throw e;
    }
    if (my !== wearToken) return choice;
    let prev = choice;
    choice = id;
    saveCharacterChoice(id);
    let d = id && avatars.getAvatar();
    d && names.set(id, d.name || id);
    say(id ? `${nameOf(id)} · Avatar ${d ? d.interface : ""}` : "Built-in operator.");
    (render(), open && showPreview(id));
    prev !== id && context.events.emit("character:change", { id, name: nameOf(id) });
    return id;
  }

  // ---- preview stage: the model stands in the harbor, the title camera is moved to it
  function placeStage() {
    let start = context.level && context.level.playerStart,
      p = (start && start.pos) || new Vector3(),
      yaw = (start && start.yaw) || 0,
      fx = -Math.sin(yaw),
      fz = -Math.cos(yaw),
      rx = Math.cos(yaw),
      rz = -Math.sin(yaw);
    stage.set(p.x + fx * PREVIEW.distance + rx * PREVIEW.side, 0, p.z + fz * PREVIEW.distance + rz * PREVIEW.side);
    try {
      stage.y = context.physics.groundHeight(stage.x, stage.z, p.y + 1);
    } catch {
      stage.y = p.y;
    }
    eye.set(p.x, stage.y + 1.35, p.z);
    look.set(stage.x, stage.y + 1.0, stage.z);
  }

  async function showPreview(id) {
    let my = ++previewToken;
    if (preview && preview.id === id) return;
    let entry;
    try {
      entry = await avatars.createInstance(id);
    } catch (e) {
      my === previewToken && say(`Preview failed: ${(e && e.message) || e}`, !0);
      return;
    }
    if (my !== previewToken || !open || disposed) return void avatars.releaseInstance(entry);
    dropPreview();
    preview = { entry, id };
    // entry.object3D: the World's height-normalized wrapper around the avatar's visual root
    let obj = entry.object3D;
    (obj.position.copy(stage), context.scene.add(obj));
    try {
      typeof entry.instance.setLocomotion == "function"
        ? entry.instance.setLocomotion(idleLocomotion(0))
        : entry.instance.setMotion("idle");
    } catch {}
  }

  function dropPreview() {
    preview && (avatars.releaseInstance(preview.entry), (preview = null));
  }

  function idleLocomotion(dt) {
    return {
      grounded: !0,
      speed: 0,
      velocity: { x: 0, y: 0, z: 0 },
      phase: "grounded",
      deltaSeconds: dt,
      mode: "duoworld:walk",
      gravity: PLAYER_MOVEMENT.gravity,
      stance: "standing",
      sprinting: !1,
    };
  }

  // The list card takes one part of the screen (the bottom in portrait, the left in landscape);
  // the model is framed in the rest: the picture is shifted by a view offset and the field of
  // view is sized so the whole body fits the free part.
  let viewKey = "",
    viewFov = PREVIEW.fov;
  function layoutView(cam) {
    let ui = document.getElementById("ui"),
      card = document.querySelector(".m-card.m-chars"),
      w = (ui && ui.clientWidth) || innerWidth,
      h = (ui && ui.clientHeight) || innerHeight;
    if (!card || !w || !h) return;
    let r = card.getBoundingClientRect(),
      portrait = h > w,
      x0 = 0,
      y0 = 0,
      fw = w,
      fh = h;
    if (portrait) fh = Math.max(h * 0.25, r.top - 6);
    else fw = Math.max(w * 0.3, w - r.right - 6), (x0 = w - fw);
    let key = [w, h, Math.round(x0), Math.round(fh), Math.round(fw)].join();
    if (key === viewKey && cam.view && cam.view.enabled) {
      !context.params.fov && Math.abs(cam.fov - viewFov) > 0.01 && ((cam.fov = viewFov), cam.updateProjectionMatrix());
      return;
    }
    viewKey = key;
    // content centre → centre of the free rectangle
    let cx = x0 + fw / 2,
      cy = y0 + fh / 2;
    cam.setViewOffset(w, h, w / 2 - cx, h / 2 - cy, w, h);
    // whole body (about 2 m with a margin) over 82% of the free height
    let visible = (2.0 / 0.82) * (h / fh);
    viewFov = Math.max(30, Math.min(72, (2 * Math.atan(visible / 2 / PREVIEW.distance) * 180) / Math.PI));
    if (!context.params.fov) {
      cam.fov = viewFov;
      cam.updateProjectionMatrix();
    }
  }
  function clearView() {
    viewKey = "";
    let cam = context.camera;
    cam && cam.view && cam.view.enabled && (cam.clearViewOffset(), cam.updateProjectionMatrix());
  }

  function frame(dt) {
    if (!open) return;
    let cam = context.camera,
      post = context.render && context.render.post;
    (cam.position.copy(eye), cam.lookAt(look), layoutView(cam), post && (post.fade = 0));
    if (!preview) return;
    turn += dt * PREVIEW.turnRate;
    let obj = preview.entry.object3D,
      // face the camera (avatars model +Z forward), with a slow turntable sway
      face = Math.atan2(eye.x - stage.x, eye.z - stage.z) + (AVATAR_COORDINATES.forward === "+Z" ? 0 : Math.PI);
    obj.rotation.y = face + Math.sin(turn) * 0.6;
    try {
      typeof preview.entry.instance.setLocomotion == "function" &&
        preview.entry.instance.setLocomotion(idleLocomotion(dt));
      preview.entry.instance.update(dt);
    } catch {}
  }

  offs.push(
    context.events.on("menu:screen", ({ screen }) => {
      let was = open;
      open = screen === "character";
      // the worn avatar may have been changed by the host (window.DuoWorld.setAvatar)
      avatars.pending || syncWorn();
      if (open && !was) {
        (placeStage(), render(), say(choice ? nameOf(choice) : "Built-in operator."), showPreview(choice), loadCatalog());
        setTimeout(() => {
          let sel = list && list.querySelector('[aria-selected="true"]');
          sel && sel.focus({ preventScroll: !0 });
        }, 40);
      } else if (!open && was) (previewToken++, dropPreview(), clearView());
      screen === "title" && render();
    }),
    context.events.on("menu:action", ({ act }) => {
      act === "character" && menus.show("character");
    }),
  );
  list &&
    offs.push(
      (() => {
        let h = (e) => {
          let b = e.target.closest(".ch-item");
          b && !b.disabled && select(b.dataset.character || null).catch(() => {});
        };
        list.addEventListener("click", h);
        return () => list.removeEventListener("click", h);
      })(),
    );
  context.frameHooks.push(frame);
  (render(), loadCatalog());

  return {
    get choice() {
      return choice;
    },
    get saved() {
      return saved;
    },
    get name() {
      return nameOf(choice);
    },
    get previewing() {
      return preview ? preview.id : void 0;
    },
    select,
    list: () => entries().map(({ id, name, supported }) => ({ id, name, supported })),
    // the avatar currently worn changed outside this screen (window.DuoWorld.setAvatar)
    sync() {
      let a = avatars.getAvatar();
      ((choice = a ? a.id : null), render());
    },
    dispose() {
      if (disposed) return;
      disposed = !0;
      (previewToken++, wearToken++, dropPreview());
      let i = context.frameHooks.indexOf(frame);
      (i >= 0 && context.frameHooks.splice(i, 1), offs.forEach((f) => f()));
    },
  };
}

export { createCharacterSelect, characterMenuConfig, loadCharacterChoice, saveCharacterChoice, CHARACTER_KEY };
