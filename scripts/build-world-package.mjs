// Completes dist/world-package after `vite build --config vite.world.config.js`:
//   world.json      generated from src/duoworld/manifest.js (the same data the World reports)
//   assets/fonts/   the local font files referenced by the package stylesheet
// and checks that world.js has no absolute or dev-server URLs.
import { cp, readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createManifest } from "../src/duoworld/manifest.js";

const root = new URL("../", import.meta.url);
// SALTLINE_DIST=/some/dir: complete <dir>/world-package instead (pair with vite --outDir)
const out = process.env.SALTLINE_DIST
  ? pathToFileURL(resolve(process.env.SALTLINE_DIST, "world-package") + "/")
  : new URL("dist/world-package/", root);

const world = await readFile(new URL("world.js", out), "utf8");
for (const bad of [
  "localhost",
  "127.0.0.1",
  "/@vite",
  "/src/",
  "/node_modules/",
]) {
  if (world.includes(bad)) throw new Error(`world.js references "${bad}"`);
}
await cp(new URL("public/fonts/", root), new URL("assets/fonts/", out), {
  recursive: true,
});
const manifest = createManifest();
await writeFile(
  new URL("world.json", out),
  JSON.stringify(manifest, null, 2) + "\n",
);
const size = (await stat(new URL("world.js", out))).size;
console.log(
  `World Package: ${out.pathname} (world.json ${manifest.id}@${manifest.version}, world.js ${(size / 1024).toFixed(0)} KiB, assets/fonts)`,
);
