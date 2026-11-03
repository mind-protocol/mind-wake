// Run with --configLoader native: bundled config loading writes into node_modules.
// Transform caches stay in the isolated checkout, including junction setups.
import { defineConfig } from "vitest/config";
export default defineConfig({
  cacheDir: ".cache/vite",
  test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"], environment: "node" },
});
