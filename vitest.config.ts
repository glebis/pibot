import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    coverage: {
      reporter: ["text", "json-summary"],
      include: ["src/core/**", "src/plugins/**", "src/config.ts"],
      exclude: ["src/**/*.test.ts", "src/**/types.ts"],
    },
  },
});