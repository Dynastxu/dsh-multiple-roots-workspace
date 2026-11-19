#!/usr/bin/env node
/**
 * Copy the two Vite outputs to the package root.
 *
 * The installed Host resolves the package entry as `<package>/index.js` and the
 * Client export as `<package>/client.js`; keeping those paths stable means a
 * rebuild is enough to reload the linked plugin.
 */
import { copyFileSync, rmSync } from "node:fs";

copyFileSync(".build/index.js", "index.js");
copyFileSync(".build/client.js", "client.js");
rmSync(".build", { recursive: true, force: true });
console.log("copied .build/index.js -> index.js and .build/client.js -> client.js");
