import { defineConfig } from "vitest/config";

/**
 * Environment-dependent test lane files (e.g., *.env.test.ts, *.smoke.test.ts).
 * These tests require host tools, live runtimes, or credentials and are excluded
 * from the deterministic test set and coverage gate.
 */
const ENV_TEST_PATTERN = ["src/**/*.env.test.ts", "src/**/*.smoke.test.ts"];

export default defineConfig({
  test: {
    include: [...ENV_TEST_PATTERN],
    exclude: [],
    environment: "node",
    testTimeout: 30_000,
    // With no matching env/smoke files, Vitest reports this opt-in lane as NOT RUN.
    passWithNoTests: true,
    coverage: { enabled: false },
  },
});
