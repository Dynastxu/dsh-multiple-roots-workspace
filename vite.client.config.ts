import { defineConfig } from "vite";

/**
 * Client half: one standalone ES file that calls the Web shell's module
 * loader. React and react-dom are requested through the loader's `require`,
 * so nothing is imported or externalized here. Emitted next to the Host entry
 * as `lib/client.js`, the package's Client export.
 */
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "lib",
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: "src/client/index.ts",
      formats: ["es"],
      fileName: () => "client.js",
    },
  },
});
