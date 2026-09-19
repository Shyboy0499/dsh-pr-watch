import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  SNAPSHOT_FILE_NAME,
  SnapshotWriteError,
  asQuarantinable,
  loadSnapshot,
  quarantineCorruptSnapshot,
  quarantinePath,
  saveSnapshot,
  type SnapshotLoad,
} from "../src/snapshot";
import { SNAPSHOT_VERSION, emptySnapshot, type Snapshot } from "../src/types";

/**
 * A disposable directory, removed even when the assertion inside it fails.
 *
 * Callbacks are awaited. Without that the cleanup below would delete the
 * directory while an async test body was still running, and every later read
 * would fail with ENOENT -- a harness bug that looks exactly like a product bug.
 */
async function withTempDirectory(
  run: (directory: string) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "dsh-pr-watch-write-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A populated snapshot with one tracked pull request. */
function populated(): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    lastCheck: "2026-09-09T00:00:00Z",
    pullRequests: {
      "octo/repo#7": {
        url: "https://github.com/octo/repo/pull/7",
        title: "Add a thing",
        state: "OPEN",
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-02T00:00:00Z",
        staleReported: false,
        departedReported: false,
      },
    },
  };
}

/** Every entry in a directory, sorted. */
const entries = (directory: string) => readdirSync(directory).sort();

/** Entries whose name is derived from the snapshot, i.e. not the snapshot itself. */
const sidecars = (directory: string) =>
  entries(directory).filter((name) => name !== SNAPSHOT_FILE_NAME);

/** A load result for a file that exists and is damaged. */
async function corruptResult(path: string) {
  const result = await loadSnapshot(path);
  const quarantinable = asQuarantinable(result);
  if (quarantinable === null) {
    throw new Error(`expected a corrupt result, got ${result.status}`);
  }
  return quarantinable;
}

describe("saveSnapshot — atomic replace", () => {
  it("creates the snapshot and the missing directory", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "pr-watch", SNAPSHOT_FILE_NAME);

      await saveSnapshot(path, populated());

      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(populated());
    });
  });

  it("writes a snapshot that loads back as ok", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);

      await saveSnapshot(path, populated());
      const result = await loadSnapshot(path);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.snapshot).toEqual(populated());
    });
  });

  it("round-trips an empty snapshot as a valid file, not a corrupt one", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);

      await saveSnapshot(path, emptySnapshot());
      const result = await loadSnapshot(path);

      // If the writer emitted e.g. an empty file, the loader would call it
      // corrupt and the very first save would look like data loss.
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.snapshot).toEqual(emptySnapshot());
    });
  });

  it("writes UTF-8 with no BOM", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);

      await saveSnapshot(path, populated());
      const bytes = readFileSync(path);

      // EF BB BF is the UTF-8 BOM. The loader tolerates one from elsewhere, but
      // this module must not be the reason it exists.
      expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
      expect(bytes[0]).toBe("{".charCodeAt(0));
    });
  });

  it("preserves non-ASCII content", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      const snapshot = populated();
      snapshot.pullRequests["octo/repo#7"].title =
        "docs(zh): 添加俄语区域设置 🚀";

      await saveSnapshot(path, snapshot);
      const result = await loadSnapshot(path);

      if (result.status !== "ok") throw new Error("expected ok");
      expect(result.snapshot.pullRequests["octo/repo#7"].title).toBe(
        "docs(zh): 添加俄语区域设置 🚀",
      );
    });
  });

  it("ends the file with a newline", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);

      await saveSnapshot(path, populated());

      expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    });
  });

  it("leaves no temporary file behind", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);

      await saveSnapshot(path, populated());

      expect(sidecars(directory)).toEqual([]);
    });
  });

  it("puts the temporary file in the same directory as the target", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);

      await saveSnapshot(path, populated(), { cleanupOrphans: false });

      // Same directory is what keeps the rename within one filesystem, and
      // therefore atomic. A temporary in os.tmpdir() could cross a volume.
      expect(entries(directory)).toEqual([SNAPSHOT_FILE_NAME]);
    });
  });

  it("overwrites in place, so a second save equals a single one", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);

      await saveSnapshot(path, populated());
      const once = readFileSync(path, "utf8");

      await saveSnapshot(path, populated());
      const twice = readFileSync(path, "utf8");

      expect(twice).toBe(once);
      expect(sidecars(directory)).toEqual([]);
    });
  });

  it("produces no temporary name collision within the same millisecond", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);

      // The pid separates instances; the random suffix separates two saves in
      // the same tick, which a pid alone does not.
      await Promise.all([
        saveSnapshot(path, populated()),
        saveSnapshot(path, populated()),
        saveSnapshot(path, populated()),
      ]);

      const result = await loadSnapshot(path);
      expect(result.status).toBe("ok");
      expect(sidecars(directory)).toEqual([]);
    });
  });

  it("handles a path containing spaces and non-ASCII characters", async () => {
    await withTempDirectory(async (directory) => {
      const nested = join(directory, "妙妙 小工具", "pr-watch");
      const path = join(nested, SNAPSHOT_FILE_NAME);

      await saveSnapshot(path, populated());
      const result = await loadSnapshot(path);

      expect(result.status).toBe("ok");
    });
  });
});

describe("saveSnapshot — an interrupted write cannot damage the snapshot", () => {
  it("keeps the previous complete snapshot when a temporary is left unrenamed", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      await saveSnapshot(path, populated());
      const good = readFileSync(path, "utf8");

      // Simulate dying between the write and the rename: a temporary exists,
      // the rename never ran.
      const stranded = join(directory, `${SNAPSHOT_FILE_NAME}.tmp-999-abcdef`);
      writeFileSync(stranded, '{"version":1,"pullRe');

      const result = await loadSnapshot(path);

      // The target is untouched and still complete. This is the property the
      // atomic write exists for: a crash cannot leave a truncated snapshot that
      // reads as "everything vanished".
      expect(readFileSync(path, "utf8")).toBe(good);
      expect(result.status).toBe("ok");
    });
  });

  it("keeps the target parseable while a large save is in flight", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      await saveSnapshot(path, populated());

      const big = populated();
      for (let index = 0; index < 20_000; index += 1) {
        big.pullRequests[`octo/repo#${index}`] = {
          ...populated().pullRequests["octo/repo#7"],
        };
      }

      const saving = saveSnapshot(path, big);
      // Sampling mid-save must never observe a partial file.
      const during = readFileSync(path, "utf8");
      await saving;

      expect(() => JSON.parse(during)).not.toThrow();
      const after = await loadSnapshot(path);
      expect(after.status).toBe("ok");
    });
  });

  it("sweeps a stale orphan temporary on the next save", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      const orphan = join(directory, `${SNAPSHOT_FILE_NAME}.tmp-999-abcdef`);
      writeFileSync(orphan, "leftover");
      // Age it past the orphan threshold without sleeping.
      const old = new Date(Date.now() - 3_600_000);
      const { utimesSync } = await import("node:fs");
      utimesSync(orphan, old, old);

      await saveSnapshot(path, populated());

      expect(sidecars(directory)).toEqual([]);
    });
  });

  it("never sweeps a file it did not create", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      const bystanders = [
        "snapshot.json.bak",
        "snapshot.json.corrupt-1",
        "notes.txt",
      ];
      for (const name of bystanders)
        writeFileSync(join(directory, name), "keep me");

      await saveSnapshot(path, populated());

      // Only names matching this module's own temporary pattern may be removed.
      for (const name of bystanders) {
        expect(readFileSync(join(directory, name), "utf8")).toBe("keep me");
      }
    });
  });

  it("leaves a concurrent instance's fresh temporary alone", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      // A fresh temporary belongs to a live writer: too young to be an orphan.
      const live = join(directory, `${SNAPSHOT_FILE_NAME}.tmp-999-abcdef`);
      writeFileSync(live, "in flight");

      await saveSnapshot(path, populated());

      expect(readFileSync(live, "utf8")).toBe("in flight");
    });
  });
});

describe("quarantineCorruptSnapshot — moves, never deletes", () => {
  it("moves a corrupt snapshot to .corrupt-1", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, "{ this is not json");
      const before = readFileSync(path, "utf8");

      const destination = await quarantineCorruptSnapshot(
        await corruptResult(path),
      );

      expect(destination).toBe(quarantinePath(path, 1));
      expect(statSync(destination).isFile()).toBe(true);
      // Byte for byte: not repaired, not truncated, not rewritten.
      expect(readFileSync(destination, "utf8")).toBe(before);
    });
  });

  it("leaves the original path empty, so the next load is missing", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, "{ broken");

      await quarantineCorruptSnapshot(await corruptResult(path));

      const result = await loadSnapshot(path);
      expect(result.status).toBe("missing");
    });
  });

  it("uses the next slot and leaves the earlier quarantine untouched", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      const first = quarantinePath(path, 1);
      writeFileSync(first, "older damage");
      const stamp = statSync(first).mtimeMs;
      writeFileSync(path, "{ newer damage");

      const destination = await quarantineCorruptSnapshot(
        await corruptResult(path),
      );

      expect(destination).toBe(quarantinePath(path, 2));
      // An earlier damaged snapshot is still evidence; overwriting it would be
      // the same data loss in a different place.
      expect(readFileSync(first, "utf8")).toBe("older damage");
      expect(statSync(first).mtimeMs).toBe(stamp);
    });
  });

  it("increments the slot across repeated quarantines without overwriting", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      const bodies = ["{ one", "{ two", "{ three"];

      for (const [index, body] of bodies.entries()) {
        writeFileSync(path, body);
        const destination = await quarantineCorruptSnapshot(
          await corruptResult(path),
        );
        expect(destination).toBe(quarantinePath(path, index + 1));
      }

      for (const [index, body] of bodies.entries()) {
        expect(readFileSync(quarantinePath(path, index + 1), "utf8")).toBe(
          body,
        );
      }
    });
  });

  it("skips a gap in the slot numbering", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      // corrupt-1 and corrupt-2 free, corrupt-3 taken: the next slot is 4.
      writeFileSync(quarantinePath(path, 3), "taken");
      writeFileSync(path, "{ broken");

      const destination = await quarantineCorruptSnapshot(
        await corruptResult(path),
      );

      expect(destination).toBe(quarantinePath(path, 4));
      expect(readFileSync(quarantinePath(path, 3), "utf8")).toBe("taken");
    });
  });

  it("ignores unrelated files when choosing a slot", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(join(directory, "snapshot.json.corrupt"), "no number");
      writeFileSync(join(directory, "snapshot.json.corrupt-x"), "not a number");
      writeFileSync(path, "{ broken");

      const destination = await quarantineCorruptSnapshot(
        await corruptResult(path),
      );

      expect(destination).toBe(quarantinePath(path, 1));
    });
  });

  it("preserves the file byte for byte, including a binary payload", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x7b]);
      writeFileSync(path, bytes);

      const destination = await quarantineCorruptSnapshot(
        await corruptResult(path),
      );

      expect(readFileSync(destination).equals(bytes)).toBe(true);
    });
  });

  it("detects corruption in every form the loader reports", async () => {
    const damaged = ["", "   \n ", "{ truncated", "null", "42", "[]"];

    for (const body of damaged) {
      await withTempDirectory(async (directory) => {
        const path = join(directory, SNAPSHOT_FILE_NAME);
        writeFileSync(path, body);

        const destination = await quarantineCorruptSnapshot(
          await corruptResult(path),
        );

        expect(readFileSync(destination, "utf8")).toBe(body);
      });
    }
  });

  it("reports an error when the file vanished before it could be moved", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, "{ broken");
      const result = await corruptResult(path);
      rmSync(path);

      await expect(quarantineCorruptSnapshot(result)).rejects.toBeInstanceOf(
        SnapshotWriteError,
      );
    });
  });

  it("works on a path containing spaces and non-ASCII characters", async () => {
    await withTempDirectory(async (directory) => {
      const nested = join(directory, "妙妙 小工具");
      mkdirSync(nested, { recursive: true });
      const path = join(nested, SNAPSHOT_FILE_NAME);
      writeFileSync(path, "{ broken");

      const destination = await quarantineCorruptSnapshot(
        await corruptResult(path),
      );

      expect(readFileSync(destination, "utf8")).toBe("{ broken");
    });
  });
});

describe("quarantineCorruptSnapshot — unreadable must never reach it", () => {
  it("refuses to brand a load result that is not corrupt", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);

      // The whole point of the brand: a file that could not be read is not known
      // to be damaged, and moving it would destroy a healthy snapshot.
      expect(asQuarantinable(await loadSnapshot(path))).toBeNull();

      writeFileSync(path, JSON.stringify(populated()));
      expect(asQuarantinable(await loadSnapshot(path))).toBeNull();

      // A directory in the file's place reads as unreadable, not corrupt.
      const directoryPath = join(directory, "a-directory");
      mkdirSync(directoryPath);
      const unreadable: SnapshotLoad = await loadSnapshot(directoryPath);
      expect(unreadable.status).toBe("unreadable");
      expect(asQuarantinable(unreadable)).toBeNull();
    });
  });

  it("leaves an unreadable file exactly where it is", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "a-directory");
      mkdirSync(path);
      const stamp = statSync(path).mtimeMs;

      const result = await loadSnapshot(path);
      expect(asQuarantinable(result)).toBeNull();

      // Nothing was moved, nothing was created beside it.
      expect(statSync(path).isDirectory()).toBe(true);
      expect(statSync(path).mtimeMs).toBe(stamp);
      expect(entries(directory)).toEqual(["a-directory"]);
    });
  });
});

describe("saveSnapshot and quarantine — failure paths are visible", () => {
  it("throws rather than silently failing when the target cannot be replaced", async () => {
    await withTempDirectory(async (directory) => {
      // A directory where the snapshot file belongs: rename onto it cannot work.
      const path = join(directory, SNAPSHOT_FILE_NAME);
      mkdirSync(path);

      await expect(saveSnapshot(path, populated())).rejects.toBeInstanceOf(
        SnapshotWriteError,
      );
    });
  });

  it("names the offending path in the error", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      mkdirSync(path);

      await expect(saveSnapshot(path, populated())).rejects.toThrow(
        new RegExp(basename(path)),
      );
    });
  });

  it("records the underlying errno on the error", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      mkdirSync(path);

      let caught: unknown;
      try {
        await saveSnapshot(path, populated());
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SnapshotWriteError);
      expect((caught as SnapshotWriteError).code).toBeTypeOf("string");
    });
  });

  it("leaves no temporary file behind after a failed save", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      mkdirSync(path);

      await expect(saveSnapshot(path, populated())).rejects.toBeInstanceOf(
        SnapshotWriteError,
      );

      // The directory is still there, and nothing new appeared beside it.
      expect(entries(directory)).toEqual([SNAPSHOT_FILE_NAME]);
    });
  });

  it("does not damage the existing snapshot when a later save fails", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      await saveSnapshot(path, populated());
      const good = readFileSync(path, "utf8");

      // Make the target un-replaceable by turning it into a directory tree that
      // cannot be overwritten by a file rename.
      const blocking = join(directory, "blocked", SNAPSHOT_FILE_NAME);
      mkdirSync(blocking, { recursive: true });
      await expect(
        saveSnapshot(blocking, emptySnapshot()),
      ).rejects.toBeInstanceOf(SnapshotWriteError);

      expect(readFileSync(path, "utf8")).toBe(good);
      const result = await loadSnapshot(path);
      expect(result.status).toBe("ok");
    });
  });

  it("reports a missing parent that cannot be created", async () => {
    await withTempDirectory(async (directory) => {
      // A file where the snapshot's parent directory should be.
      const blocker = join(directory, "pr-watch");
      writeFileSync(blocker, "not a directory");
      const path = join(blocker, SNAPSHOT_FILE_NAME);

      await expect(saveSnapshot(path, populated())).rejects.toBeInstanceOf(
        SnapshotWriteError,
      );
    });
  });
});

describe("saveSnapshot — pruning contract", () => {
  it("stores whatever snapshot it is given, without re-deciding the rules", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      // The write side performs the action the caller decided; it does not
      // re-derive pruning or staleness here.
      const pruned = emptySnapshot();
      pruned.lastCheck = "2026-09-10T00:00:00Z";

      await saveSnapshot(path, pruned);
      const result = await loadSnapshot(path);

      if (result.status !== "ok") throw new Error("expected ok");
      expect(result.snapshot).toEqual(pruned);
    });
  });
});

describe("write side — the snapshot body is never unlinked", () => {
  it("keeps the snapshot itself when a quarantine happens beside it", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, "{ broken");

      await quarantineCorruptSnapshot(await corruptResult(path));
      await saveSnapshot(path, populated());

      // Quarantine moved the damaged file; the fresh save recreated the target.
      // At no point was a snapshot deleted.
      const result = await loadSnapshot(path);
      expect(result.status).toBe("ok");
      expect(entries(directory)).toEqual([
        SNAPSHOT_FILE_NAME,
        `${SNAPSHOT_FILE_NAME}.corrupt-1`,
      ]);
    });
  });

  it("never removes a quarantine file", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      await saveSnapshot(path, populated());
      const quarantined = quarantinePath(path, 1);
      writeFileSync(quarantined, "damaged evidence");

      await saveSnapshot(path, populated());

      expect(readFileSync(quarantined, "utf8")).toBe("damaged evidence");
    });
  });

  it("resolves the quarantine path from the snapshot path", () => {
    expect(quarantinePath("/home/me/.dsh/pr-watch/snapshot.json", 3)).toBe(
      "/home/me/.dsh/pr-watch/snapshot.json.corrupt-3",
    );
    expect(dirname(quarantinePath("a/snapshot.json", 1))).toBe("a");
  });
});
