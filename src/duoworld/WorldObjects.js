// World Interaction Adapter: describes Saltline's existing interactive objects as
// WorldObjectDescriptor records. It only reports what game/flow.js already does (cutting uplink
// relays by holding E, reaching the extraction boat); it adds no new gameplay.
import { WORLD_ID } from "./protocol/protocol.js";

var RELAY_TYPE = "saltline:uplink-relay";
var EXTRACTION_TYPE = "saltline:extraction";
var EXTRACTION_ID = "extraction";

function vec(v) {
  return v ? [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)] : null;
}

function createWorldObjects(context) {
  let listeners = new Set(),
    reached = !1;
  function relayState(id) {
    let run = context.game && context.game.run,
      r = run && run.relays && run.relays.find((x) => x.id === id);
    return r ? (r.cut ? "cut" : r.cutting ? "cutting" : "live") : "live";
  }
  function relays() {
    let objectives = (context.level && context.level.objectives) || [];
    return objectives.map((o, i) => {
      let id = o.id || "relay_" + i,
        state = relayState(id);
      return {
        id,
        type: RELAY_TYPE,
        // "saltline:cut": hold Interact (E) within range while facing it
        capabilities: state === "cut" ? [] : ["saltline:cut"],
        label: o.label || id,
        position: vec(o.pos),
        state,
      };
    });
  }
  function extraction() {
    let x = context.level && context.level.extraction;
    if (!x || !x.pos) return null;
    let run = context.game && context.game.run,
      open = !!(run && run.allCut);
    return {
      id: EXTRACTION_ID,
      type: EXTRACTION_TYPE,
      // "saltline:reach": enter the radius once every relay is cut
      capabilities: open && !reached ? ["saltline:reach"] : [],
      position: vec(x.pos),
      radius: x.radius || 2.5,
      state: reached ? "reached" : open ? "open" : "locked",
    };
  }
  function list() {
    let x = extraction();
    return x ? [...relays(), x] : relays();
  }
  function emit(id, cause) {
    if (!listeners.size) return;
    let descriptor = list().find((d) => d.id === id) || null;
    for (let fn of listeners)
      try {
        fn({ world: WORLD_ID, id, cause, descriptor });
      } catch (e) {
        console.error("[world-objects] listener threw", e);
      }
  }
  let last = new Map(),
    offs = [
      context.events.on("objective:progress", (e) => {
        let s = relayState(e.id);
        last.get(e.id) !== s &&
          (last.set(e.id, s), emit(e.id, "objective:progress"));
      }),
      context.events.on(
        "objective:done",
        (e) => (last.set(e.id, "cut"), emit(e.id, "objective:done")),
      ),
      context.events.on("objective:all", () =>
        emit(EXTRACTION_ID, "objective:all"),
      ),
      context.events.on(
        "extraction:reached",
        () => ((reached = !0), emit(EXTRACTION_ID, "extraction:reached")),
      ),
      context.events.on("game:state", (e) => {
        // a new run resets every relay
        e.state === "playing" &&
          (e.prev === "title" || e.prev === "dead" || e.prev === "complete") &&
          ((reached = !1),
          last.clear(),
          list().forEach((d) => emit(d.id, "reset")));
      }),
    ];
  return {
    list,
    get(id) {
      return list().find((d) => d.id === id) || null;
    },
    // fn({world, id, cause, descriptor}); returns an unsubscribe function
    on(fn) {
      return (listeners.add(fn), () => listeners.delete(fn));
    },
    dispose() {
      (offs.forEach((f) => f()), listeners.clear());
    },
  };
}

export { createWorldObjects, RELAY_TYPE, EXTRACTION_TYPE };
