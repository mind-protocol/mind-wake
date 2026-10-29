import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "desktop/ui/**/*.test.ts"],
    environment: "node",
  },
});
