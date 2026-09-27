import { configDefaults, defineConfig } from "vitest/config";

/**
 * The default suite.
 *
 * `tests/live` is excluded on purpose: those tests run the real `gh` binary
 * against GitHub, and the guarantee this repository makes about `pnpm test` is
 * that it makes no network requests and needs no credentials. They are run
 * deliberately with `pnpm run verify:live` instead.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/live/**"],
  },
});
