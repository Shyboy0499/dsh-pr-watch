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
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, sep, win32 } from "node:path";
import {
  FALLBACK_HOME_DIRECTORY_NAME,
  SNAPSHOT_FILE_NAME,
  SnapshotPathError,
  WATCH_DIRECTORY_NAME,
  loadSnapshot,
  resolveSnapshotPath,
  type SnapshotLoad,
} from "../src/snapshot";
import { SNAPSHOT_VERSION } from "../src/types";

/** The three path segments every resolved snapshot path must end with. */
const TAIL = [WATCH_DIRECTORY_NAME, SNAPSHOT_FILE_NAME];

/**
 * Expected results are built with the host's own `join`, because
 * `resolveSnapshotPath` joins with the host's rules too. Hard-coding POSIX
 * expectations made ten assertions fail on Windows for a reason that had nothing
 * to do with the behaviour under test.
 *
 * The paths fed in are therefore chosen to be absolute on every platform:
 * `homedir()` and `tmpdir()` always are, whatever the separator convention.
 */
const hostJoin = (...parts: string[]) => join(...parts);
const onWindows = sep === "\\";

describe("snapshot path constants", () => {
  it("exposes the documented directory and file names", () => {
    expect(WATCH_DIRECTORY_NAME).toBe("pr-watch");
    expect(SNAPSHOT_FILE_NAME).toBe("snapshot.json");
    expect(FALLBACK_HOME_DIRECTORY_NAME).toBe(".dsh");
  });
});

describe("resolveSnapshotPath — DSH_HOME set", () => {
  it("joins an absolute DSH_HOME with the watch directory", () => {
    const home = hostJoin(tmpdir(), "dsh-home");

    expect(resolveSnapshotPath(home, homedir())).toBe(hostJoin(home, ...TAIL));
  });

  it("ignores the home directory entirely when DSH_HOME is set", () => {
    const home = hostJoin(tmpdir(), "dsh-home");

    expect(resolveSnapshotPath(home, hostJoin(tmpdir(), "one"))).toBe(
      resolveSnapshotPath(home, hostJoin(tmpdir(), "two")),
    );
  });

  it("accepts a Windows-form path on Windows, and rejects it elsewhere", () => {
    // A home directory is only meaningful on the platform it belongs to. On
    // Windows this is a perfectly good path; on POSIX it is not absolute at all,
    // and accepting it would produce `C:\Users\me/pr-watch/snapshot.json` -- a
    // mixed path no platform can use. That is exactly what CI caught.
    const windowsPath = "C:\\Users\\me";

    if (onWindows) {
      expect(resolveSnapshotPath(windowsPath, homedir())).toBe(
        win32.join(windowsPath, ...TAIL),
      );
    } else {
      expect(() => resolveSnapshotPath(windowsPath, homedir())).toThrow(
        SnapshotPathError,
      );
    }
  });
});

describe("resolveSnapshotPath — DSH_HOME unset", () => {
  it("falls back to the home directory", () => {
    expect(resolveSnapshotPath(undefined, homedir())).toBe(
      hostJoin(homedir(), FALLBACK_HOME_DIRECTORY_NAME, ...TAIL),
    );
  });

  it("resolves the real home directory rather than a literal tilde", () => {
    const resolved = resolveSnapshotPath(undefined, homedir());

    expect(resolved).not.toContain("~");
    expect(resolved.startsWith(homedir())).toBe(true);
    expect(isAbsolute(resolved)).toBe(true);
  });

  it("falls back for an empty DSH_HOME", () => {
    expect(resolveSnapshotPath("", homedir())).toBe(
      resolveSnapshotPath(undefined, homedir()),
    );
  });

  it("falls back for a whitespace-only DSH_HOME", () => {
    // A DSH_HOME of "   " is a configuration accident, not a directory named
    // "   ". Treated as unset rather than as a relative path, so a blank value
    // can never resolve somewhere that depends on the working directory.
    expect(resolveSnapshotPath("   ", homedir())).toBe(
      resolveSnapshotPath(undefined, homedir()),
    );
    expect(resolveSnapshotPath("\t\n", homedir())).toBe(
      resolveSnapshotPath(undefined, homedir()),
    );
  });
});

describe("resolveSnapshotPath — trailing separators", () => {
  it("never produces a doubled separator", () => {
    const home = hostJoin(tmpdir(), "dsh-home");
    const resolved = resolveSnapshotPath(`${home}${sep}`, homedir());

    expect(resolved).toBe(hostJoin(home, ...TAIL));
    expect(resolved).not.toContain(`${sep}${sep}`);
  });

  it("tolerates several trailing separators", () => {
    const home = hostJoin(tmpdir(), "dsh-home");
    const resolved = resolveSnapshotPath(
      `${home}${sep}${sep}${sep}`,
      homedir(),
    );

    expect(resolved).toBe(hostJoin(home, ...TAIL));
    expect(resolved).not.toContain(`${sep}${sep}`);
  });

  it("normalises a path written with the foreign separator", () => {
    // A hand-typed value may use the wrong slash. On Windows both separators are
    // accepted by the platform, and the result must still come out in one
    // convention rather than preserving the mixture.
    const mixed = onWindows ? "C:/Users/me" : "/tmp/dsh-home";
    const resolved = resolveSnapshotPath(mixed, homedir());

    expect(resolved).not.toContain(`${sep}${sep}`);
    expect(resolved.endsWith(hostJoin(...TAIL))).toBe(true);
    if (onWindows) {
      expect(resolved).toBe(win32.join("C:\\Users\\me", ...TAIL));
    }
  });
});

describe("resolveSnapshotPath — the filesystem root", () => {
  it("handles the root without collapsing it away", () => {
    // `/` on POSIX, `C:\` on Windows. Both are absolute, neither may be treated
    // as blank.
    const root = onWindows ? "C:\\" : "/";
    const resolved = resolveSnapshotPath(root, homedir());

    expect(resolved).toBe(hostJoin(root, ...TAIL));
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved).not.toContain(`${sep}${sep}`);
  });
});

describe("resolveSnapshotPath — input handling", () => {
  it("preserves spaces and non-ASCII characters verbatim", () => {
    const home = hostJoin(tmpdir(), "妙妙 小工具");

    expect(resolveSnapshotPath(home, homedir())).toBe(hostJoin(home, ...TAIL));
    expect(resolveSnapshotPath(home, homedir())).toContain("妙妙 小工具");
  });

  it("preserves spaces in a Windows path on Windows", () => {
    if (!onWindows) return;

    const home = "C:\\Program Files\\dsh";

    expect(resolveSnapshotPath(home, homedir())).toBe(
      win32.join(home, ...TAIL),
    );
  });

  it("rejects a path padded with whitespace instead of silently trimming it", () => {
    // Trimming would read and write a different location than the one written
    // down. A padded value is nearly always a quoting mistake, so it is
    // surfaced rather than guessed at.
    const padded = `  ${hostJoin(tmpdir(), "dsh-home")}  `;

    expect(() => resolveSnapshotPath(padded, homedir())).toThrow(
      SnapshotPathError,
    );
    expect(() => resolveSnapshotPath(padded, homedir())).toThrow(/whitespace/i);
  });

  it("rejects a relative DSH_HOME rather than resolving it ambiguously", () => {
    // A relative home would read and write a different snapshot depending on
    // the process working directory, which silently loses the user's memory of
    // what it has already reported.
    for (const relative of ["relative/home", "./nested", "../up"]) {
      expect(() => resolveSnapshotPath(relative, homedir())).toThrow(
        SnapshotPathError,
      );
    }
    expect(() => resolveSnapshotPath("relative/home", homedir())).toThrow(
      /absolute/i,
    );
  });

  it("rejects a literal tilde rather than creating a directory named ~", () => {
    // `~` is the shell's job. Taking it literally would create a real directory
    // called "~" and quietly stop sharing state with the documented location.
    expect(() => resolveSnapshotPath("~/dsh", homedir())).toThrow(
      SnapshotPathError,
    );
  });

  it("names the offending value in the error", () => {
    expect(() => resolveSnapshotPath("relative/home", homedir())).toThrow(
      /relative\/home/,
    );
  });

  it("rejects an empty home directory instead of building a suspicious path", () => {
    expect(() => resolveSnapshotPath(undefined, "")).toThrow(SnapshotPathError);
    expect(() => resolveSnapshotPath(undefined, "")).toThrow(/home/i);
    expect(() => resolveSnapshotPath(undefined, "   ")).toThrow(
      SnapshotPathError,
    );
  });

  it("does not build a path from an undefined home", () => {
    let message = "";
    try {
      resolveSnapshotPath(undefined, "");
    } catch (error) {
      message = (error as Error).message;
    }

    // A clear failure, not a path containing the string "undefined".
    expect(message).not.toBe("");
    expect(message).not.toContain("undefined");
  });
});

describe("resolveSnapshotPath — purity", () => {
  it("returns an identical string for identical input", () => {
    const home = hostJoin(tmpdir(), "dsh-home");

    expect(resolveSnapshotPath(home, homedir())).toBe(
      resolveSnapshotPath(home, homedir()),
    );
  });

  it("does not consult the process environment", () => {
    const set = process.env.DSH_HOME;
    const home = hostJoin(tmpdir(), "explicit");
    process.env.DSH_HOME = hostJoin(tmpdir(), "from-the-environment");

    try {
      // The argument wins, and an absent argument falls back to the home
      // directory -- neither reads the variable that is now set. Asserting the
      // environment is unchanged afterwards would be asserting something about
      // every other module in the process, so it is deliberately not done here.
      expect(resolveSnapshotPath(home, homedir())).toBe(
        hostJoin(home, ...TAIL),
      );
      expect(resolveSnapshotPath(undefined, homedir())).toBe(
        hostJoin(homedir(), FALLBACK_HOME_DIRECTORY_NAME, ...TAIL),
      );
    } finally {
      if (set === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = set;
    }
  });

  it("is unaffected by state outside its arguments", () => {
    // Two calls with the same arguments are identical, which is the observable
    // consequence of there being no hidden input: no clock, no environment, no
    // working directory.
    const home = hostJoin(tmpdir(), "dsh-home");
    const first = resolveSnapshotPath(home, homedir());
    const second = resolveSnapshotPath(home, homedir());

    expect(second).toBe(first);
    expect(first).toBe(hostJoin(home, ...TAIL));
  });
});

describe("resolveSnapshotPath — the result is usable as a path", () => {
  it("returns something absolute, joined from the input", () => {
    const direct = hostJoin(tmpdir(), "dsh-home");
    const fromFallback = resolveSnapshotPath(undefined, homedir());

    expect(isAbsolute(resolveSnapshotPath(direct, homedir()))).toBe(true);
    expect(isAbsolute(fromFallback)).toBe(true);
    expect(fromFallback).toContain(FALLBACK_HOME_DIRECTORY_NAME);
    expect(fromFallback.endsWith(hostJoin(...TAIL))).toBe(true);
  });

  it("never carries a foreign separator in a host path", () => {
    const foreign = onWindows ? "/" : "\\";
    const resolved = resolveSnapshotPath(
      hostJoin(tmpdir(), "dsh-home"),
      homedir(),
    );

    expect(resolved).not.toContain(foreign);
  });
});

/* -------------------------------------------------------------------------
 * loadSnapshot — task 9.
 *
 * Every case runs against real files in a private temporary directory. The
 * filesystem is deliberately not mocked: these assertions are about what real
 * IO does on this platform, and a fake would only re-state the assumptions
 * being tested. Nothing here reads or writes a real user snapshot path.
 * ---------------------------------------------------------------------- */

/**
 * A disposable directory, removed even when the assertion inside it fails.
 *
 * The callback's result is awaited when it is a promise. Without that, the
 * `finally` below would delete the directory while an async test body was still
 * running and every read inside it would fail with ENOENT -- a failure in the
 * harness that looks exactly like a bug in the loader.
 */
async function withTempDirectory(
  run: (directory: string) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "dsh-pr-watch-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Minimal valid record; mirrors `PrRecord` exactly. */
const RECORD = {
  url: "https://github.com/octo/repo/pull/7",
  title: "Add a thing",
  state: "OPEN",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-02T00:00:00Z",
  staleReported: false,
  departedReported: false,
};

/** A valid snapshot document with one entry. */
const VALID = {
  version: SNAPSHOT_VERSION,
  lastCheck: "2026-09-09T00:00:00Z",
  pullRequests: { "octo/repo#7": RECORD },
};

/** A valid document whose single entry has `overrides` merged in. */
function validWith(overrides: Record<string, unknown>): unknown {
  return {
    ...VALID,
    pullRequests: { "octo/repo#7": { ...RECORD, ...overrides } },
  };
}

/** A valid record with one field removed entirely. */
function validWithout(field: string): unknown {
  const entry: Record<string, unknown> = { ...RECORD };
  delete entry[field];
  return { ...VALID, pullRequests: { "octo/repo#7": entry } };
}

interface Fingerprint {
  bytes: string;
  mtimeMs: number;
}

/** The bytes and mtime of a file, for proving a read did not disturb it. */
function fingerprint(path: string): Fingerprint {
  const stats = statSync(path);
  return { bytes: readFileSync(path, "utf8"), mtimeMs: stats.mtimeMs };
}

function expectUnchanged(path: string, before: Fingerprint): void {
  expect(fingerprint(path)).toEqual(before);
}

/**
 * Reading a directory is an error on every platform, but not the same error:
 * POSIX reports EISDIR, Windows commonly reports EACCES or EPERM instead. The
 * code is therefore not pinned here -- what matters is that it is classified as
 * an environment problem rather than as damaged content.
 */
const DIRECTORY_READ_CODES = ["EISDIR", "EACCES", "EPERM"];

describe("loadSnapshot — file does not exist", () => {
  it("reports missing without throwing, for the first-run path", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);

      const result = await loadSnapshot(path);

      expect(result).toEqual({ status: "missing", path });
    });
  });

  it("reports missing when only the parent directory is absent", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "pr-watch", SNAPSHOT_FILE_NAME);

      const result = await loadSnapshot(path);

      // A missing directory is still simply "no snapshot yet". Resolving the
      // path never creates it; directory creation belongs to the write side.
      expect(result.status).toBe("missing");
    });
  });

  it("satisfies the delta contract: missing yields an empty baseline", async () => {
    await withTempDirectory(async (directory) => {
      const result = await loadSnapshot(join(directory, SNAPSHOT_FILE_NAME));

      // The caller builds the empty snapshot from `missing`, which is what lets
      // delta report every open pull request as newly noticed on a first run.
      expect(result).not.toHaveProperty("snapshot");
      expect(result.status).toBe("missing");
    });
  });

  it("creates nothing on disk while reporting missing", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);

      await loadSnapshot(path);

      expect(() => statSync(path)).toThrow();
    });
  });
});

describe("loadSnapshot — valid snapshot", () => {
  it("returns the snapshot with status ok", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify(VALID));

      const result = await loadSnapshot(path);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.snapshot).toEqual(VALID);
      expect(result.path).toBe(path);
    });
  });

  it("preserves marker fields without loss", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      const document = validWith({
        staleReported: true,
        departedReported: true,
      });
      writeFileSync(path, JSON.stringify(document));

      const result = await loadSnapshot(path);

      if (result.status !== "ok") throw new Error("expected ok");
      const record = result.snapshot.pullRequests["octo/repo#7"];
      // These two flags are the whole reason a merge or a staleness event is
      // reported once rather than every check, so losing either is data loss.
      expect(record.staleReported).toBe(true);
      expect(record.departedReported).toBe(true);
    });
  });

  it("reads an empty snapshot document", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(
        path,
        JSON.stringify({
          version: SNAPSHOT_VERSION,
          lastCheck: "",
          pullRequests: {},
        }),
      );

      const result = await loadSnapshot(path);

      if (result.status !== "ok") throw new Error("expected ok");
      expect(result.snapshot.pullRequests).toEqual({});
      expect(result.snapshot.lastCheck).toBe("");
    });
  });

  it("accepts every terminal and open state", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(
        path,
        JSON.stringify({
          version: SNAPSHOT_VERSION,
          lastCheck: "2026-09-09T00:00:00Z",
          pullRequests: {
            "octo/a#1": { ...RECORD, state: "OPEN" },
            "octo/b#2": { ...RECORD, state: "MERGED" },
            "octo/c#3": { ...RECORD, state: "CLOSED" },
          },
        }),
      );

      const result = await loadSnapshot(path);

      if (result.status !== "ok") throw new Error("expected ok");
      expect(Object.keys(result.snapshot.pullRequests)).toEqual([
        "octo/a#1",
        "octo/b#2",
        "octo/c#3",
      ]);
    });
  });

  it("handles a large snapshot without crashing", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      const pullRequests: Record<string, unknown> = {};
      for (let index = 0; index < 5_000; index += 1) {
        pullRequests[`octo/repo#${index}`] = { ...RECORD };
      }
      writeFileSync(
        path,
        JSON.stringify({
          version: SNAPSHOT_VERSION,
          lastCheck: "2026-09-09T00:00:00Z",
          pullRequests,
        }),
      );

      const result = await loadSnapshot(path);

      if (result.status !== "ok") throw new Error("expected ok");
      expect(Object.keys(result.snapshot.pullRequests)).toHaveLength(5_000);
    });
  });

  it("returns deeply equal results for two consecutive loads", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify(VALID));
      const before = fingerprint(path);

      const first = await loadSnapshot(path);
      const second = await loadSnapshot(path);

      expect(second).toEqual(first);
      expectUnchanged(path, before);
    });
  });

  it("ignores unknown fields instead of calling the file damaged", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(
        path,
        JSON.stringify({
          ...VALID,
          // A field added by a newer minor version must not make this build
          // declare the user's state unreadable.
          futureTopLevel: { anything: true },
          pullRequests: {
            "octo/repo#7": { ...RECORD, futureEntryField: [1, 2, 3] },
          },
        }),
      );

      const result = await loadSnapshot(path);

      expect(result.status).toBe("ok");
    });
  });
});

describe("loadSnapshot — damaged content is corrupt", () => {
  it("classifies a zero-byte file as corrupt, not as an empty snapshot", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, "");
      const before = fingerprint(path);

      const result = await loadSnapshot(path);

      // The snapshot is written atomically, so a real one is never 0 bytes.
      // Treating this as "empty" would silently discard every tracked entry.
      expect(result.status).toBe("corrupt");
      if (result.status !== "corrupt") throw new Error("unreachable");
      expect(result.reason).toBe("empty");
      expectUnchanged(path, before);
    });
  });

  it("classifies a whitespace-only file as corrupt", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, "   \n\t\r\n  ");
      const before = fingerprint(path);

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
      if (result.status !== "corrupt") throw new Error("unreachable");
      expect(result.reason).toBe("blank");
      expectUnchanged(path, before);
    });
  });

  it("classifies truncated JSON as corrupt", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, '{"version":1,"lastCheck":"2026-09-09","pullRe');
      const before = fingerprint(path);

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
      if (result.status !== "corrupt") throw new Error("unreachable");
      expect(result.reason).toBe("invalid-json");
      expectUnchanged(path, before);
    });
  });

  it("classifies garbled bytes as corrupt", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]));

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
    });
  });

  it("rejects a JSON root that is an array", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify([VALID]));

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
      if (result.status !== "corrupt") throw new Error("unreachable");
      expect(result.reason).toBe("shape");
    });
  });

  it("rejects a JSON root that is null", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, "null");

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
    });
  });

  it("rejects a JSON root that is a number", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, "42");

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
    });
  });

  it("rejects a root that is a bare string", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify("snapshot.json"));

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
    });
  });

  it("rejects a missing version", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify({ lastCheck: "", pullRequests: {} }));

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
      if (result.status !== "corrupt") throw new Error("unreachable");
      expect(result.reason).toBe("shape");
      expect(result.detail).toContain("version");
    });
  });

  it("rejects a non-integer version", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify({ ...VALID, version: "1" }));

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
    });
  });

  it("rejects an unrecognised version rather than guessing at it", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify({ ...VALID, version: 99 }));

      const result = await loadSnapshot(path);

      // Reading a future schema as this one and writing it back would lose
      // whatever the newer version recorded.
      expect(result.status).toBe("corrupt");
      if (result.status !== "corrupt") throw new Error("unreachable");
      expect(result.reason).toBe("shape");
      expect(result.detail).toContain("99");
    });
  });

  it("rejects a missing lastCheck", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(
        path,
        JSON.stringify({ version: SNAPSHOT_VERSION, pullRequests: {} }),
      );

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
    });
  });

  it("rejects pullRequests that is not an object", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify({ ...VALID, pullRequests: null }));

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
    });
  });

  it("rejects pullRequests that is an array", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify({ ...VALID, pullRequests: [RECORD] }));

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
    });
  });

  it("rejects an entry that is not an object", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(
        path,
        JSON.stringify({ ...VALID, pullRequests: { "octo/repo#7": "OPEN" } }),
      );

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
    });
  });

  it("names the offending entry in the detail", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(
        path,
        JSON.stringify({ ...VALID, pullRequests: { "octo/repo#7": 5 } }),
      );

      const result = await loadSnapshot(path);

      if (result.status !== "corrupt") throw new Error("expected corrupt");
      expect(result.detail).toContain("octo/repo#7");
    });
  });

  it("rejects a field of the wrong type", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify(validWith({ title: 12 })));

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
    });
  });

  it("rejects an unknown state rather than coercing it", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify(validWith({ state: "DRAFT" })));

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
    });
  });

  it("rejects a boolean field that is not a boolean", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(
        path,
        JSON.stringify(validWith({ staleReported: "false" })),
      );

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
    });
  });

  it.each([
    "url",
    "title",
    "state",
    "createdAt",
    "updatedAt",
    "staleReported",
    "departedReported",
  ])("rejects an entry missing %s", async (field) => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify(validWithout(field)));

      const result = await loadSnapshot(path);

      expect(result.status).toBe("corrupt");
    });
  });

  it("never throws for any damaged input", async () => {
    const bodies = [
      "",
      "   ",
      "{",
      "[]",
      "null",
      "0",
      '"text"',
      JSON.stringify({ version: 99 }),
      JSON.stringify(validWith({ state: "NOPE" })),
    ];

    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);

      for (const body of bodies) {
        writeFileSync(path, body);
        const result: SnapshotLoad = await loadSnapshot(path);
        expect(["corrupt", "missing", "ok", "unreadable"]).toContain(
          result.status,
        );
        expect(result.status).toBe("corrupt");
      }
    });
  });
});

describe("loadSnapshot — unreadable is distinct from corrupt", () => {
  it("classifies a directory in the file's place as unreadable, never corrupt", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      mkdirSync(path);

      const result = await loadSnapshot(path);

      // A directory here is a configuration accident, not damaged content.
      // Reporting `corrupt` would have the quarantine step move a directory --
      // or, on the next run, the user's real data -- aside.
      expect(result.status).toBe("unreadable");
      if (result.status !== "unreadable") throw new Error("unreachable");
      expect(DIRECTORY_READ_CODES).toContain(result.code);
    });
  });

  it("leaves the directory in place when it reports unreadable", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      mkdirSync(path);

      await loadSnapshot(path);

      expect(statSync(path).isDirectory()).toBe(true);
    });
  });

  it("carries a non-empty explanation", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      mkdirSync(path);

      const result = await loadSnapshot(path);

      if (result.status !== "unreadable")
        throw new Error("expected unreadable");
      expect(result.code.length).toBeGreaterThan(0);
      expect(result.detail.length).toBeGreaterThan(0);
      // Diagnostics stay on one line so they can be interpolated safely.
      expect(result.detail).not.toContain("\n");
    });
  });
});

describe("loadSnapshot — encoding and path edge cases", () => {
  it("parses a file that begins with a UTF-8 BOM", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      // Windows editors add a BOM readily; it survives decoding as U+FEFF and
      // would otherwise make JSON.parse reject otherwise-valid content.
      writeFileSync(path, `\uFEFF${JSON.stringify(VALID)}`);

      const result = await loadSnapshot(path);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.snapshot.pullRequests["octo/repo#7"].title).toBe(
        "Add a thing",
      );
    });
  });

  it("parses a file written with CRLF line endings", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      const pretty = JSON.stringify(VALID, null, 2).replace(/\n/g, "\r\n");
      writeFileSync(path, pretty);

      const result = await loadSnapshot(path);

      expect(result.status).toBe("ok");
    });
  });

  it("reads a path containing spaces and non-ASCII characters", async () => {
    await withTempDirectory(async (directory) => {
      const nested = join(directory, "妙妙 小工具", "pr-watch");
      mkdirSync(nested, { recursive: true });
      const path = join(nested, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify(VALID));

      const result = await loadSnapshot(path);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.snapshot.pullRequests["octo/repo#7"]).toEqual(RECORD);
    });
  });

  it("preserves non-ASCII content", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(
        path,
        JSON.stringify(validWith({ title: "docs(zh): 添加俄语区域设置 🚀" })),
      );

      const result = await loadSnapshot(path);

      if (result.status !== "ok") throw new Error("expected ok");
      expect(result.snapshot.pullRequests["octo/repo#7"].title).toBe(
        "docs(zh): 添加俄语区域设置 🚀",
      );
    });
  });

  it("behaves deterministically when the filename case differs", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify(VALID));
      // Windows and macOS resolve this to the same file; Linux does not. The
      // loader must not throw or invent a third answer on either.
      const differentlyCased = join(directory, "Snapshot.json");

      const result = await loadSnapshot(differentlyCased);

      expect(["ok", "missing"]).toContain(result.status);
      expect(result.status).not.toBe("corrupt");
    });
  });

  it("returns an identical path to the one it was given", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, JSON.stringify(VALID));

      const result = await loadSnapshot(path);

      expect(result.path).toBe(path);
    });
  });
});

describe("loadSnapshot — read-only guarantees", () => {
  const bodies: [string, string | Buffer][] = [
    ["valid", JSON.stringify(VALID)],
    ["empty", ""],
    ["blank", "  \n "],
    ["truncated", '{"version":1,"pullRe'],
    ["array root", JSON.stringify([VALID])],
    ["future version", JSON.stringify({ ...VALID, version: 99 })],
    ["wrong field type", JSON.stringify(validWith({ title: 5 }))],
    ["bom", `\uFEFF${JSON.stringify(VALID)}`],
    ["binary", Buffer.from([0x00, 0x01, 0xff, 0xfe])],
  ];

  it.each(bodies)(
    "leaves bytes and mtime untouched for a %s file",
    async (_label, body) => {
      await withTempDirectory(async (directory) => {
        const path = join(directory, SNAPSHOT_FILE_NAME);
        writeFileSync(path, body);
        const before = fingerprint(path);

        await loadSnapshot(path);

        // The load side must never move, rewrite, or quarantine. Task 10 owns
        // every write, including the decision to set a damaged file aside.
        expectUnchanged(path, before);
      });
    },
  );

  it("does not create a sibling file, such as a quarantine copy", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, SNAPSHOT_FILE_NAME);
      writeFileSync(path, "{ not json");

      await loadSnapshot(path);

      const siblings = readdirSync(directory).sort();
      expect(siblings).toEqual([SNAPSHOT_FILE_NAME]);
    });
  });
});
