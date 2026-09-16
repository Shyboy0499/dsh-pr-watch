import { describe, it, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, sep, win32 } from "node:path";
import {
  FALLBACK_HOME_DIRECTORY_NAME,
  SNAPSHOT_FILE_NAME,
  SnapshotPathError,
  WATCH_DIRECTORY_NAME,
  resolveSnapshotPath,
} from "../src/snapshot";

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
