import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* -------------------------------------------------------------------------
 * The quarantine slot scan is only an optimisation.
 *
 * A concurrent instance can claim the slot between this instance's `readdir` and
 * its move, and `rename` cannot express "do not overwrite": POSIX replaces the
 * destination silently, and Node's Windows rename passes
 * MOVEFILE_REPLACE_EXISTING. The move therefore has to claim the slot first.
 *
 * `readdir` is mocked to report an empty directory, which is exactly what a
 * concurrent writer makes the scan look like, so the collision is deterministic
 * rather than timing-dependent.
 * ---------------------------------------------------------------------- */

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

import { readdir } from "node:fs/promises";
import {
  asQuarantinable,
  loadSnapshot,
  quarantineCorruptSnapshot,
} from "../src/snapshot";

const mockedReaddir = vi.mocked(readdir);

afterEach(() => {
  mockedReaddir.mockClear();
});

describe("quarantineCorruptSnapshot — a stale slot scan", () => {
  it("never overwrites an existing quarantine, and takes the next slot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dsh-pr-watch-race-"));
    try {
      const path = join(directory, "snapshot.json");
      const earlier = `${path}.corrupt-1`;
      writeFileSync(path, "{ damaged");
      writeFileSync(earlier, "EARLIER EVIDENCE");

      // The scan sees an empty directory, so slot 1 is chosen again even though
      // that file exists.
      mockedReaddir.mockResolvedValueOnce([]);

      const loaded = await loadSnapshot(path);
      if (loaded.status !== "corrupt") throw new Error("expected corrupt");
      const quarantinable = asQuarantinable(loaded);
      if (quarantinable === null) throw new Error("expected quarantinable");

      const destination = await quarantineCorruptSnapshot(quarantinable);

      // The earlier evidence survived byte for byte, and the damaged file took
      // the next slot rather than replacing it.
      expect(readFileSync(earlier, "utf8")).toBe("EARLIER EVIDENCE");
      expect(destination).toBe(`${path}.corrupt-2`);
      expect(readFileSync(destination, "utf8")).toBe("{ damaged");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
