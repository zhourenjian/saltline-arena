// Static HTTP server for the tests (no dependencies). Routes map URL prefixes to directories,
// so the World Package can be mounted under an arbitrary path next to the standalone build.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

// routes: [["/prefix/", "/abs/dir"], ...] (longest prefix first)
export function serve(routes, { log = null, misses = null } = {}) {
  routes = [...routes].sort((a, b) => b[0].length - a[0].length);
  const srv = http.createServer(async (req, res) => {
    try {
      const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const route = routes.find(([prefix]) => p.startsWith(prefix));
      if (!route) return void res.writeHead(404).end("no route");
      const root = path.resolve(route[1]);
      let f = path.join(root, p.slice(route[0].length));
      if (!f.startsWith(root)) return void res.writeHead(403).end();
      if ((await stat(f).catch(() => null))?.isDirectory())
        f = path.join(f, "index.html");
      const body = await readFile(f);
      log && log.push(p);
      res.writeHead(200, {
        "content-type": TYPES[path.extname(f)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      misses && misses.push(req.url);
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((r) =>
    srv.listen(0, "127.0.0.1", () =>
      r({
        url: `http://127.0.0.1:${srv.address().port}`,
        close: () => srv.close(),
      }),
    ),
  );
}
