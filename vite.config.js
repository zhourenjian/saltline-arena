import { defineConfig } from "vite";
import { readFileSync, readdirSync, existsSync } from "node:fs";

// The avatar registry is a classic script (Avatar Packages call window.DuoWorldAvatars.register
// from plain <script> tags that run before any module). Its single source is
// src/duoworld/compatibility/avatar-registry.js; this serves it in dev and emits it on build.
const REGISTRY_URL = "duoworld/avatar-registry.js";
const registrySource = () =>
  readFileSync(
    new URL("./src/duoworld/compatibility/avatar-registry.js", import.meta.url),
    "utf8",
  );

function avatarRegistryScript() {
  return {
    name: "saltline:avatar-registry",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || req.url.split("?")[0] !== "/" + REGISTRY_URL)
          return next();
        res.setHeader("Content-Type", "text/javascript");
        res.end(registrySource());
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: REGISTRY_URL,
        source: registrySource(),
      });
    },
  };
}

// avatars/catalog.json: the installed Avatar Package ids (public/avatars/<id>/avatar.js), so
// the character select can offer packages that index.html does not preload. Regenerated on
// every request in dev, so dropping a package into public/avatars/ needs no restart.
const AVATARS_DIR = new URL("./public/avatars/", import.meta.url);
const CATALOG_URL = "avatars/catalog.json";
const ID = /^[a-z0-9][a-z0-9._-]*$/;
function avatarCatalogSource() {
  const avatars = existsSync(AVATARS_DIR)
    ? readdirSync(AVATARS_DIR, { withFileTypes: true })
        .filter(
          (d) =>
            d.isDirectory() &&
            ID.test(d.name) &&
            existsSync(new URL(`${d.name}/avatar.js`, AVATARS_DIR)),
        )
        .map((d) => d.name)
        .sort()
    : [];
  return JSON.stringify({ format: "saltline.avatar-catalog@1", avatars }, null, 2) + "\n";
}
function avatarCatalog() {
  return {
    name: "saltline:avatar-catalog",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || req.url.split("?")[0] !== "/" + CATALOG_URL) return next();
        res.setHeader("Content-Type", "application/json");
        res.end(avatarCatalogSource());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: CATALOG_URL, source: avatarCatalogSource() });
    },
  };
}

// Standalone web app → dist/standalone (relative base, works under any path / GitHub Pages).
// The World Package is built by vite.world.config.js → dist/world-package.
export default defineConfig({
  base: "./",
  plugins: [avatarRegistryScript(), avatarCatalog()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  preview: {
    //host: "127.0.0.1",
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: "dist/standalone",
    emptyOutDir: true,
    sourcemap: true,
  },
});
