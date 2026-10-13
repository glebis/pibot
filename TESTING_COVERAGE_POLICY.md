# Testing & Coverage Policy

This document defines the deterministic coverage gate for PiBot's production TypeScript code, as implemented in pibot-z95.1 and pibot-z95.5.

## Coverage Baseline

All production TypeScript under `src/` is included in coverage measurement, with only documented type-only or generated files excluded.

**Verified baseline (rounded stable values):**
- Statements: 58% (floor)
- Branches: 50% (floor)
- Functions: 56% (floor)
- Lines: 62% (floor)

**Coverage floors are enforced thresholds, not current measured values.**

## Coverage Scope

### Included (measured)
- `src/**/*.ts` files (excluding tests and generated files)
- `src/core/`, `src/plugins/`, `src/transports/`
- `src/web.ts`, `src/web-auth.ts`, `src/index.ts`, `src/transports/cli.ts`
- All runtime code paths, failure modes, and error handling

### Excluded (not measured)
- `src/**/*.test.ts` (test files)
- `src/**/types.ts` (pure type definitions)
- Generated TypeScript files (e.g., from protobuf or other build tools)
- Only when explicitly documented in coverage exclusion list

## Test Classification

### Deterministic Tests (count toward coverage gate)
Tests that:
- Require no network access
- Require no credentials, launchd, or macOS tools
- Use only local fakes/mocks
- Do not touch application runtime files, private data, or credentials
- Run in CI's Ubuntu runner (no local Whisper, ffmpeg, Telegram API, etc.)

**Purpose:** Measure real production code paths and ensure the core product functions without external dependencies.

### Environment-Dependent Checks (opt-in smoke lanes)
Environment-dependent tests use a clear naming convention: `*.env.test.ts` or `*.smoke.test.ts`.

These files:
- Use naming patterns `*.env.test.ts` or `*.smoke.test.ts`
- Are excluded from the deterministic test `include` pattern in `vitest.config.ts`
- Are excluded from coverage measurement (denominator)
- Check for host tools (Whisper, ffmpeg, macOS utilities)
- Check for live runtimes (Telegram API, model providers)
- Check for environment-specific behavior
- Explicitly report skipped/passed/failed/not-run states
- Do NOT count toward deterministic coverage gate

**Purpose:** Ensure optional capabilities work when configured, without breaking the deterministic baseline.

### Running the Environment Lane

The environment lane is opt-in and runs explicitly:

```bash
# Run only environment-dependent tests (no coverage, reports no-tests distinctly)
npm run test:env
```

This command runs the dedicated `vitest.env.config.ts` — it does NOT collect coverage.
If no environment tests match, the lane is explicitly **NOT RUN** and exits successfully.

## CI Coverage Enforcement

### Coverage Floor Job
The `.github/workflows/ci.yml` includes a separate `coverage` job that:
1. Runs deterministic tests with the configured floor thresholds from `vitest.config.ts` via `npm run test:coverage` (no command-line overrides)
2. **FAILS** if ANY threshold drops below the baseline
3. Provides the controlled executable proof that raising thresholds fails (see next section)

### The Controlled Failure Proof
The `coverage-gate-proves-failure` job sets thresholds well above the current ceiling (99% each) to **guarantee failure**, proving the gate works:
- Currently fails on: statements (59.64% vs 99%), branches (51.49% vs 99%), functions (57.77% vs 99%), lines (63.8% vs 99%)
- Exit code is non-zero, showing thresholds are enforced

## Raising Thresholds

Threshold increases follow a documented ratchet:
1. Submit a task with target thresholds (e.g., +2% on each dimension)
2. Explain coverage increase in terms of new test coverage for:
   - Previously uncovered code paths
   - Critical failure modes or error handling
   - Edge cases or input validation
   - API surface completeness
3. All child tasks (`pibot-z95.1`, `pibot-z95.2`, `pibot-z95.3`, `pibot-z95.4`) must be complete
4. CI runs the deterministic coverage gate with new thresholds
5. Exception only possible for denominator changes (e.g., including new file types)

## Policy Summary

1. **Deterministic lane only:** No network, no credentials, no launchd, no local models, no macOS tools
2. **Environment smoke lanes:** Explicitly opt-in, report distinct states, never count toward coverage
3. **Non-inflated baseline:** Measures actual runtime code, not inflated by tests or generated files
4. **Controlled enforcement:** Gate enforcement proven by negative test that fails when thresholds are too high
5. **Documented exclusions:** Only legitimate type-only or generated files excluded from denominator
6. **Ratchet process:** Thresholds only move upward, not downward

## Verification Commands

### Local verification
```bash
# Run deterministic tests with coverage gate (uses thresholds from vitest.config.ts)
npm run test:coverage

# Prove the gate fails when thresholds are too high (must fail)
npx vitest run --coverage --coverage.thresholds.statements=99 --coverage.thresholds.branches=99 --coverage.thresholds.functions=99 --coverage.thresholds.lines=99
# Vitest must exit non-zero with a coverage-threshold error.
```

### CI jobs
- `typecheck`: TypeScript type safety
- `test`: Deterministic functional tests (no coverage thresholds)
- `coverage`: Deterministic tests WITH floor thresholds (fails below baseline)
- `coverage-gate-proves-failure`: Demonstrates gate enforcement with negative test

## Current Status

All deterministic tests pass with coverage above floor.
The gate is enforced by both positive and negative tests in CI.
Environment-dependent checks are clearly separated and do not affect the baseline.
