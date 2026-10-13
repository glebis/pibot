import { defineConfig } from "vitest/config";

/**
 * Coverage floor: stable rounded all-src baseline
 * These thresholds match the verified audit from pibot-z95.1 acceptance criteria.
 */
const COVERAGE_FLOOR = {
  statements: 58,
  branches: 50,
  functions: 56,
  lines: 62,
} as const;

/**
 * Environment-dependent test lane files (e.g., *.env.test.ts, *.smoke.test.ts).
 * These tests require host tools, live runtimes, or credentials and are excluded
 * from the deterministic test set and coverage gate.
 */
const ENV_TEST_PATTERN = ["src/**/*.env.test.ts", "src/**/*.smoke.test.ts"];

export default defineConfig({
  test: {
    // Deterministic test include: run all src tests, excluding the environment lane
    include: ["src/**/*.test.ts"],
    exclude: [...ENV_TEST_PATTERN],
    environment: "node",
    testTimeout: 15_000,
    coverage: {
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/types.ts",
        "src/**/*.generated.ts",
        "src/**/__generated__/**",
        ...ENV_TEST_PATTERN,
      ],
      thresholds: {
        ...COVERAGE_FLOOR,
      },
    },
  },
});
