import type { UserConfig } from "tsdown";

const lib: UserConfig = {
  name: "dsh-pr-watch",
  entry: ["src/index.ts"],
  outDir: "lib",
  format: ["esm"],
  platform: "node",
  target: "es2022",
  fixedExtension: false,
  dts: false,
  // The whole `lib/` directory is published, so a file left behind by an older
  // build would ship as if it were current. Cleaning first makes the tarball a
  // function of this build rather than of this checkout's history.
  clean: true,
  deps: {
    neverBundle: ["@deepseek-ai/cordis", "@deepseek-ai/dsh-tools"],
  },
};

export default [lib];
