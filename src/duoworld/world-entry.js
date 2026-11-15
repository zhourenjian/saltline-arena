// World Package entry (dist/world-package/world.js). A self-contained ES module: it carries the
// whole game, its own Three.js r180 and its stylesheets, and resolves fonts relative to its own
// URL, so the package can be mounted under any HTTP path without a dev server.
//
//   import createWorld, { manifest } from "./world.js";
//   const world = createWorld({ container, avatarRoot: "/avatars/" });
//   await world.load(); await world.enter({ avatar: "girl-purple" });
//   hostLoop((dt) => world.update(dt)); ... world.leave(); world.dispose();
import fontsCss from "../fonts.css?inline";
import uiCss from "../ui.css?inline";
import { createSaltlineWorld } from "./WorldAdapter.js";
import { createManifest } from "./manifest.js";

var manifest = createManifest();

// kept in a variable so the bundler leaves it alone: resolved at run time against world.js
var FONT_DIR = "./assets/fonts/";

function packageStyles() {
  let fonts = new URL(FONT_DIR, import.meta.url).href,
    rebase = (css) =>
      css.replace(
        /url\((["']?)[^)"']*?fonts\/([^)"'/]+\.woff2)\1\)/g,
        (_, q, file) => `url("${fonts}${file}")`,
      );
  return [rebase(fontsCss), uiCss];
}

function createWorld(options = {}) {
  return createSaltlineWorld({
    container: options.container,
    params: options.params || {},
    avatarRoot: options.avatarRoot || "./avatars/",
    styles: options.styles === !1 ? [] : packageStyles(),
  });
}

export { createWorld, manifest };
export default createWorld;
