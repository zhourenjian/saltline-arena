import { defineConfig } from "vite";

// World Package: one self-contained ES module (game + Three.js r180 + CSS) at
// dist/world-package/world.js. scripts/build-world-package.mjs adds world.json and assets/.
export default defineConfig({
  base: "./",
  publicDir: false,
  build: {
    outDir: "dist/world-package",
    emptyOutDir: true,
    sourcemap: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
    lib: {
      entry: "src/duoworld/world-entry.js",
      formats: ["es"],
      fileName: () => "world.js",
    },
    rolldownOptions: {
      output: { codeSplitting: false },
    },
  },
});
