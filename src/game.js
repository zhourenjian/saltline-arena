// Standalone entry: the Saltline World driven by the local RuntimeBridge (which also exposes
// window.DuoWorld). The World Package entry is src/duoworld/world-entry.js; both share all
// scene code through src/duoworld/WorldAdapter.js.
import "./app/diagnostics.js";
import { showFatalError } from "./app/diagnostics.js";
import { createSaltlineWorld } from "./duoworld/WorldAdapter.js";
import { createRuntimeBridge } from "./duoworld/RuntimeBridge.js";

let params = Object.fromEntries(new URLSearchParams(location.search)),
  world = createSaltlineWorld({ avatarRoot: "./avatars/" }),
  bridge = createRuntimeBridge(world);

bridge.start({ params }).catch((i) => showFatalError((i && i.stack) || i));

export { world, bridge };
