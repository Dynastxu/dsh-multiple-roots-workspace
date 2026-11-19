import { defineConfig } from "vite";

/**
 * Host half: one ESM entry for Node. Node builtins stay external; everything
 * the plugin owns is bundled into the single file. `scripts/copy-build.mjs`
 * moves the emitted file to the package root, where the installed Loader
 * resolves the entry.
 */
export default defineConfig({
  build: {
    target: "node22",
    outDir: ".build",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: [/^node:/u],
    },
  },
});
