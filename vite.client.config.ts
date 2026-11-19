import { defineConfig } from "vite";

/**
 * Client half: one standalone ES file that calls the Web shell's module
 * loader. React and react-dom are requested through the loader's `require`,
 * so nothing is imported or externalized here. `scripts/copy-build.mjs` moves
 * the emitted file to the package root alongside the Host entry.
 */
export default defineConfig({
  build: {
    target: "es2022",
    outDir: ".build",
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: "src/client/index.ts",
      formats: ["es"],
      fileName: () => "client.js",
    },
  },
});
