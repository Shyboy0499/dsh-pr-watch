import { defineConfig } from "vitest/config";

/**
 * The opt-in live checks, run by `pnpm run verify:live`.
 *
 * Separate from the default config so the two cannot be confused: everything
 * under `tests/live` spawns the real `gh`, needs it authenticated, and talks to
 * GitHub. A longer timeout because each check waits on the network rather than
 * on a fixture.
 */
export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.test.ts"],
    testTimeout: 60_000,
  },
});
