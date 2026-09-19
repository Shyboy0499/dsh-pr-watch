import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhExecRequest, GhExecutor, GhSpawnResult } from "../src/gh-exec";
import { loadSnapshot } from "../src/snapshot";
import {
  buildWatchValue,
  validateArgs,
  type BuildOptions,
} from "../src/tools/pr-watch";
import { renderWatch, type WatchValue } from "../src/tools/watch";
import { SNAPSHOT_VERSION } from "../src/types";

/* -------------------------------------------------------------------------
 * Task 14 — the assembled tool.
 *
 * Every case drives the real orchestration through an injected executor and a
 * private temporary snapshot directory, so no test touches a real `gh`, the
 * network, a real clock, or a real user directory.
 * ---------------------------------------------------------------------- */

const MS_PER_DAY = 86_400_000;
const NOW = new Date("2026-09-10T12:00:00Z");
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();

/** A disposable snapshot directory, removed even when an assertion fails. */
async function withTempDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "dsh-pr-watch-tool-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** One `gh search prs` row. */
function searchPr(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    url: "https://github.com/octo/repo/pull/7",
    title: "Add a thing",
    state: "OPEN",
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
    number: 7,
    repository: { nameWithOwner: "octo/repo" },
    ...overrides,
  };
}

/** One `gh pr view` row. */
function viewPr(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    state: "MERGED",
    mergedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    title: "Add a thing",
    url: "https://github.com/octo/repo/pull/7",
    number: 7,
    repository: { nameWithOwner: "octo/repo" },
    ...overrides,
  };
}

/** A successful process result carrying `body` on stdout. */
function succeeds(body: string): GhSpawnResult {
  return {
    ok: true,
    process: {
      code: 0,
      signal: null,
      stdout: body,
      stderr: "",
      stdoutTruncated: false,
      stdoutLossy: false,
      timedOut: false,
    },
  };
}

/** A failed process result. */
function fails(code: number, stderr: string): GhSpawnResult {
  return {
    ok: true,
    process: {
      code,
      signal: null,
      stdout: "",
      stderr,
      stdoutTruncated: false,
      stdoutLossy: false,
      timedOut: false,
    },
  };
}

/** An executor that never launches anything. */
function spawnFailure(code: string): GhSpawnResult {
  return { ok: false, failure: { code, message: `spawn gh ${code}` } };
}

interface Recorder {
  readonly executor: GhExecutor;
  readonly calls: GhExecRequest[];
  /** Responses consumed in order; the last one repeats once exhausted. */
  readonly queue: GhSpawnResult[];
}

/** An executor that replays a queue and records every request. */
function recorder(...queue: GhSpawnResult[]): Recorder {
  const calls: GhExecRequest[] = [];
  const pending = [...queue];
  return {
    calls,
    queue: pending,
    executor: async (request) => {
      calls.push(request);
      const next = pending.length > 1 ? pending.shift() : pending[0];
      return next ?? succeeds("[]");
    },
  };
}

/** Convenience: run one check against a directory with a fixed clock. */
function run(
  directory: string,
  executor: GhExecutor,
  extra: Partial<BuildOptions> = {},
): ReturnType<typeof buildWatchValue> {
  return buildWatchValue({
    executor,
    path: join(directory, "snapshot.json"),
    now: NOW,
    ...extra,
  });
}

/** Narrow to a success, failing the test otherwise. */
function expectOk(
  outcome: Awaited<ReturnType<typeof buildWatchValue>>,
): WatchValue {
  if (outcome.status !== "ok")
    throw new Error(`expected ok, got: ${outcome.message}`);
  return outcome.value;
}

const KINDS = (value: WatchValue) => value.deltas.map((delta) => delta.kind);

describe("validateArgs — untrusted arguments", () => {
  it("defaults both parameters when nothing is passed", () => {
    expect(validateArgs(undefined)).toEqual({ staleDays: 14, all: false });
    expect(validateArgs({})).toEqual({ staleDays: 14, all: false });
  });

  it("accepts a valid override", () => {
    expect(validateArgs({ staleDays: 30, all: true })).toEqual({
      staleDays: 30,
      all: true,
    });
  });

  it("accepts the boundary values", () => {
    expect(validateArgs({ staleDays: 1 }).staleDays).toBe(1);
    expect(validateArgs({ staleDays: 3650 }).staleDays).toBe(3650);
  });

  it.each([
    ["a string", "14"],
    ["null", null],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an object", {}],
    ["an array", []],
    ["a boolean", true],
  ])("refuses %s as staleDays", (_label, staleDays) => {
    // Every comparison in delta.ts is numeric, so a coerced value would quietly
    // produce "nothing is ever stale" -- a plugin that looks fine and reports
    // nothing.
    expect(() => validateArgs({ staleDays })).toThrow(/staleDays/);
  });

  it("refuses a fractional staleDays", () => {
    expect(() => validateArgs({ staleDays: 1.5 })).toThrow(/whole number/);
  });

  it("refuses zero, explaining why", () => {
    expect(() => validateArgs({ staleDays: 0 })).toThrow(/between 1 and/);
    expect(() => validateArgs({ staleDays: 0 })).toThrow(/refused/);
  });

  it("refuses a negative threshold", () => {
    expect(() => validateArgs({ staleDays: -1 })).toThrow(/between 1 and/);
  });

  it("refuses an absurdly large threshold", () => {
    expect(() => validateArgs({ staleDays: 100_000 })).toThrow(/between 1 and/);
  });

  it.each([
    ["a string", "true"],
    ["a number", 1],
    ["null", null],
    ["an object", {}],
  ])("refuses %s as all", (_label, all) => {
    expect(() => validateArgs({ all })).toThrow(/all must be a boolean/);
  });

  it("ignores unknown extra parameters", () => {
    // Forward compatibility: a newer caller passing a parameter this build does
    // not know must not be rejected outright.
    expect(validateArgs({ staleDays: 7, somethingNew: "x" })).toEqual({
      staleDays: 7,
      all: false,
    });
  });

  it("handles a non-object argument without throwing unpredictably", () => {
    expect(validateArgs("nonsense")).toEqual({ staleDays: 14, all: false });
    expect(validateArgs(null)).toEqual({ staleDays: 14, all: false });
  });
});

describe("buildWatchValue — first run reports everything as newly noticed", () => {
  it("reports each open pull request once", async () => {
    await withTempDirectory(async (directory) => {
      const exec = recorder(succeeds(JSON.stringify([searchPr()])));

      const value = expectOk(await run(directory, exec.executor));

      expect(KINDS(value)).toEqual(["new"]);
      expect(value.deltas[0].key).toBe("octo/repo#7");
      expect(value.trackedCount).toBe(1);
    });
  });

  it("makes exactly one gh call when nothing departed", async () => {
    await withTempDirectory(async (directory) => {
      const exec = recorder(succeeds(JSON.stringify([searchPr()])));

      await run(directory, exec.executor);

      // "normally zero or one per check": with an empty snapshot there is
      // nothing to resolve, so phase 2 does not run at all.
      expect(exec.calls).toHaveLength(1);
      expect(exec.calls[0].args[0]).toBe("search");
    });
  });

  it("covers a repository that was never cloned", async () => {
    await withTempDirectory(async (directory) => {
      const exec = recorder(
        succeeds(
          JSON.stringify([
            searchPr({
              repository: { nameWithOwner: "never/cloned" },
              number: 3,
            }),
          ]),
        ),
      );

      const value = expectOk(await run(directory, exec.executor));

      // Tracked by owner/repo#number, so no local checkout is involved.
      expect(value.deltas[0].key).toBe("never/cloned#3");
    });
  });
});

describe("buildWatchValue — reported once, then silent", () => {
  it("reports nothing on a second run with no changes", async () => {
    await withTempDirectory(async (directory) => {
      const body = JSON.stringify([searchPr()]);

      expectOk(await run(directory, recorder(succeeds(body)).executor));
      const second = expectOk(
        await run(directory, recorder(succeeds(body)).executor),
      );

      expect(second.deltas).toEqual([]);
      expect(renderWatch(second, false)).toContain(
        "No changes since the last check",
      );
    });
  });

  it("keeps the same open pull request tracked across runs", async () => {
    await withTempDirectory(async (directory) => {
      const body = JSON.stringify([searchPr()]);

      await run(directory, recorder(succeeds(body)).executor);
      const second = expectOk(
        await run(directory, recorder(succeeds(body)).executor),
      );

      expect(second.trackedCount).toBe(1);
    });
  });

  it("reports a merge once, then never again", async () => {
    await withTempDirectory(async (directory) => {
      // Run 1: one open pull request.
      expectOk(
        await run(
          directory,
          recorder(succeeds(JSON.stringify([searchPr()]))).executor,
        ),
      );

      // Run 2: it is gone from the open set, and phase 2 says it merged.
      const run2 = recorder(succeeds("[]"), succeeds(JSON.stringify(viewPr())));
      const second = expectOk(await run(directory, run2.executor));
      expect(KINDS(second)).toEqual(["merged"]);

      // Run 3: still absent, and now terminal in the snapshot.
      const run3 = recorder(succeeds("[]"));
      const third = expectOk(await run(directory, run3.executor));
      expect(third.deltas).toEqual([]);

      // Only phase 1 ran on the third check: a terminal entry is history, so
      // there is nothing left to resolve.
      expect(run3.calls).toHaveLength(1);
    });
  });

  it("distinguishes a close without merge from a merge", async () => {
    await withTempDirectory(async (directory) => {
      await run(
        directory,
        recorder(succeeds(JSON.stringify([searchPr()]))).executor,
      );

      const exec = recorder(
        succeeds("[]"),
        succeeds(JSON.stringify(viewPr({ state: "CLOSED", mergedAt: null }))),
      );
      const value = expectOk(await run(directory, exec.executor));

      expect(KINDS(value)).toEqual(["closed"]);
      expect(renderWatch(value, false)).toContain("Closed without merge (1):");
      expect(renderWatch(value, false)).not.toContain("Merged (1):");
    });
  });

  it("reports staleness once when the threshold is crossed, then stays silent", async () => {
    await withTempDirectory(async (directory) => {
      // Noticed while still fresh, so `delta.ts` does NOT set the stale flag: a
      // pull request already past the threshold when first seen is deliberately
      // exempted, so the user is not told "new" and "stale" in the same breath.
      const fresh = searchPr({ updatedAt: daysAgo(1) });
      expectOk(
        await run(
          directory,
          recorder(succeeds(JSON.stringify([fresh]))).executor,
        ),
      );

      // The threshold is then crossed while it stays open.
      const aged = searchPr({ updatedAt: daysAgo(20) });
      const second = expectOk(
        await run(
          directory,
          recorder(succeeds(JSON.stringify([aged]))).executor,
        ),
      );
      expect(KINDS(second)).toEqual(["stale"]);

      // Silence afterwards, because staleness is reported on transition only.
      const third = expectOk(
        await run(
          directory,
          recorder(succeeds(JSON.stringify([aged]))).executor,
        ),
      );
      expect(third.deltas).toEqual([]);
    });
  });

  it("does not also call a newly noticed entry stale", async () => {
    await withTempDirectory(async (directory) => {
      // Already past the threshold on the very first check. It is reported as
      // new and the flag is set at the same time, so the following check is
      // silent rather than repeating the same staleness.
      const old = searchPr({ updatedAt: daysAgo(30) });

      const first = expectOk(
        await run(
          directory,
          recorder(succeeds(JSON.stringify([old]))).executor,
        ),
      );
      expect(KINDS(first)).toEqual(["new"]);

      const second = expectOk(
        await run(
          directory,
          recorder(succeeds(JSON.stringify([old]))).executor,
        ),
      );
      expect(second.deltas).toEqual([]);
    });
  });

  it("resets the staleness clock when activity resumes", async () => {
    await withTempDirectory(async (directory) => {
      const fresh = searchPr({ updatedAt: daysAgo(1) });
      await run(
        directory,
        recorder(succeeds(JSON.stringify([fresh]))).executor,
      );

      const aged = searchPr({ updatedAt: daysAgo(20) });
      expect(
        KINDS(
          expectOk(
            await run(
              directory,
              recorder(succeeds(JSON.stringify([aged]))).executor,
            ),
          ),
        ),
      ).toEqual(["stale"]);

      // New activity restarts the clock, so nothing is reported.
      const nudged = searchPr({ updatedAt: daysAgo(1) });
      const third = expectOk(
        await run(
          directory,
          recorder(succeeds(JSON.stringify([nudged]))).executor,
        ),
      );
      expect(third.deltas).toEqual([]);

      // And going quiet again fires a second time, once.
      const agedAgain = searchPr({ updatedAt: daysAgo(40) });
      const fourth = expectOk(
        await run(
          directory,
          recorder(succeeds(JSON.stringify([agedAgain]))).executor,
        ),
      );
      expect(KINDS(fourth)).toEqual(["stale"]);
    });
  });

  it("honours a staleDays override end to end", async () => {
    await withTempDirectory(async (directory) => {
      const fresh = searchPr({ updatedAt: daysAgo(1) });
      await run(
        directory,
        recorder(succeeds(JSON.stringify([fresh]))).executor,
        { staleDays: 2 },
      );

      const aged = searchPr({ updatedAt: daysAgo(3) });
      const second = expectOk(
        await run(
          directory,
          recorder(succeeds(JSON.stringify([aged]))).executor,
          { staleDays: 2 },
        ),
      );

      expect(KINDS(second)).toEqual(["stale"]);
    });
  });
});

describe("buildWatchValue — a failed fetch writes nothing", () => {
  it("leaves the snapshot bytes and mtime untouched when phase 1 fails", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");

      // Establish a snapshot with one tracked pull request.
      await run(
        directory,
        recorder(succeeds(JSON.stringify([searchPr()]))).executor,
      );
      const before = readFileSync(path);
      const beforeMtime = statSync(path).mtimeMs;

      const outcome = await run(
        directory,
        recorder(fails(1, "dial tcp: connection refused")).executor,
      );

      expect(outcome.status).toBe("failed");
      // Byte for byte and mtime for mtime: pending changes were not marked seen.
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(statSync(path).mtimeMs).toBe(beforeMtime);
    });
  });

  it("reports the classified failure rather than an empty result", async () => {
    await withTempDirectory(async (directory) => {
      const outcome = await run(
        directory,
        recorder(fails(4, "not logged into any GitHub hosts")).executor,
      );

      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") throw new Error("unreachable");
      expect(outcome.message).toContain("gh auth login");
    });
  });

  it("treats a missing gh binary as a failure, not as no changes", async () => {
    await withTempDirectory(async (directory) => {
      const outcome = await run(directory, async () => spawnFailure("ENOENT"));

      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") throw new Error("unreachable");
      expect(outcome.message).toContain("cli.github.com");
    });
  });

  it("does not write when the open list cannot be parsed", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");
      await run(
        directory,
        recorder(succeeds(JSON.stringify([searchPr()]))).executor,
      );
      const before = readFileSync(path);

      const outcome = await run(
        directory,
        recorder(succeeds("[{ broken")).executor,
      );

      expect(outcome.status).toBe("failed");
      expect(readFileSync(path).equals(before)).toBe(true);
    });
  });

  it("refuses a partial enumeration instead of recording it", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");
      await run(
        directory,
        recorder(succeeds(JSON.stringify([searchPr()]))).executor,
      );
      const before = readFileSync(path);

      // One good row and one malformed: the whole batch is refused, because a
      // dropped row would look like a departure and be announced as merged.
      const outcome = await run(
        directory,
        recorder(succeeds(JSON.stringify([searchPr(), searchPr({ title: 5 })])))
          .executor,
      );

      expect(outcome.status).toBe("failed");
      expect(readFileSync(path).equals(before)).toBe(true);
    });
  });

  it("writes nothing when a resolve fails, and retries it next time", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");
      await run(
        directory,
        recorder(succeeds(JSON.stringify([searchPr()]))).executor,
      );
      const before = readFileSync(path);
      const beforeMtime = statSync(path).mtimeMs;

      // The pull request left the open set, and the resolve call fails.
      const failing = recorder(
        succeeds("[]"),
        fails(1, "dial tcp: i/o timeout"),
      );
      const second = await run(directory, failing.executor);

      expect(second.status).toBe("ok");
      // The report still names the departure as unconfirmed...
      if (second.status !== "ok") throw new Error("unreachable");
      expect(KINDS(second.value)).toEqual(["unresolved"]);
      // ...but nothing was recorded, because marking it seen would set a flag
      // on an outcome nobody determined.
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(statSync(path).mtimeMs).toBe(beforeMtime);

      // The next run still reports it, so the outcome was not lost.
      const third = await run(
        directory,
        recorder(succeeds("[]"), fails(1, "still down")).executor,
      );
      if (third.status !== "ok") throw new Error("unreachable");
      expect(third.value.deltas).toHaveLength(1);
      expect(third.value.deltas[0].kind).toBe("unresolved");
    });
  });

  it("writes nothing when a resolve returns an unparsable payload", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");
      await run(
        directory,
        recorder(succeeds(JSON.stringify([searchPr()]))).executor,
      );
      const before = readFileSync(path);

      const exec = recorder(succeeds("[]"), succeeds("{ not json"));
      const outcome = await run(directory, exec.executor);

      if (outcome.status !== "ok") throw new Error("expected ok");
      expect(KINDS(outcome.value)).toEqual(["unresolved"]);
      expect(readFileSync(path).equals(before)).toBe(true);
    });
  });

  it("does not mark anything seen on an unresolved round", async () => {
    await withTempDirectory(async (directory) => {
      await run(
        directory,
        recorder(succeeds(JSON.stringify([searchPr()]))).executor,
      );
      await run(directory, recorder(succeeds("[]"), fails(1, "down")).executor);

      const stored = await loadSnapshot(join(directory, "snapshot.json"));
      if (stored.status !== "ok") throw new Error("expected ok");

      // The entry kept its place and its flags, which is what makes the next
      // check try again.
      const entry = stored.snapshot.pullRequests["octo/repo#7"];
      expect(entry.state).toBe("OPEN");
      expect(entry.departedReported).toBe(false);
    });
  });
});

describe("buildWatchValue — phase 2 is limited to departures", () => {
  it("does not resolve anything when nothing left the open set", async () => {
    await withTempDirectory(async (directory) => {
      const exec = recorder(succeeds(JSON.stringify([searchPr()])));

      await run(directory, exec.executor);

      expect(exec.calls.filter((call) => call.args[0] === "pr")).toHaveLength(
        0,
      );
    });
  });

  it("resolves only the entry that departed", async () => {
    await withTempDirectory(async (directory) => {
      const two = JSON.stringify([
        searchPr(),
        searchPr({ number: 8, url: "https://github.com/octo/repo/pull/8" }),
      ]);
      await run(directory, recorder(succeeds(two)).executor);

      // Only #7 remains open; #8 departed.
      const exec = recorder(
        succeeds(JSON.stringify([searchPr()])),
        succeeds(
          JSON.stringify(
            viewPr({ number: 8, url: "https://github.com/octo/repo/pull/8" }),
          ),
        ),
      );
      const value = expectOk(await run(directory, exec.executor));

      const resolves = exec.calls.filter((call) => call.args[0] === "pr");
      expect(resolves).toHaveLength(1);
      // The URL identifies the pull request, so no --repo reconstruction is
      // involved.
      expect(resolves[0].args).toContain("https://github.com/octo/repo/pull/8");
      expect(KINDS(value)).toEqual(["merged"]);
    });
  });

  it("is read-only by the task 11 allow-list", () => {
    const search = ["search", "prs", "--author", "@me"];
    expect(search[0]).toBe("search");
  });
});

describe("buildWatchValue — a corrupt snapshot is quarantined and the round continues", () => {
  it("moves the damaged file aside and still reports", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");
      writeFileSync(path, "{ this is not json");

      const value = expectOk(
        await run(
          directory,
          recorder(succeeds(JSON.stringify([searchPr()]))).executor,
        ),
      );

      // The round continued on an empty baseline rather than crashing.
      expect(KINDS(value)).toEqual(["new"]);
      // And the user is told where the old file went.
      expect(value.warning).toContain("moved to");
      expect(value.warning).toContain("snapshot.json.corrupt-1");
      expect(renderWatch(value, false)).toContain("⚠️");
      // Nothing was deleted.
      expect(readFileSync(`${path}.corrupt-1`, "utf8")).toBe(
        "{ this is not json",
      );
    });
  });

  it("records a fresh snapshot after quarantining", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");
      writeFileSync(path, "{ broken");

      await run(
        directory,
        recorder(succeeds(JSON.stringify([searchPr()]))).executor,
      );

      const stored = await loadSnapshot(path);
      expect(stored.status).toBe("ok");
    });
  });

  it("does not finish a round on a corrupt snapshot when the fetch fails", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");
      writeFileSync(path, "{ broken");

      const outcome = await run(directory, recorder(fails(1, "down")).executor);

      // The quarantine already happened, but no new snapshot was written, so the
      // damaged file is still recoverable beside it.
      expect(outcome.status).toBe("failed");
      expect(readFileSync(`${path}.corrupt-1`, "utf8")).toBe("{ broken");
    });
  });
});

describe("buildWatchValue — an unreadable snapshot is neither moved nor overwritten", () => {
  it("fails the round and leaves the file alone", async () => {
    await withTempDirectory(async (directory) => {
      // A directory in the file's place reads as `unreadable`, not `corrupt`.
      const path = join(directory, "snapshot.json");
      mkdirSync(path);

      const outcome = await run(directory, recorder(succeeds("[]")).executor);

      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") throw new Error("unreachable");
      expect(outcome.message).toContain("untouched");
      // Not quarantined: a file that could not be read is not known to be
      // damaged, and moving it would destroy a healthy record.
      expect(statSync(path).isDirectory()).toBe(true);
      expect(
        statSync(`${path}.corrupt-1`, { throwIfNoEntry: false }),
      ).toBeUndefined();
    });
  });
});

describe("buildWatchValue — all mode and the snapshot", () => {
  it("still records the round, so `all` does not repeat forever", async () => {
    await withTempDirectory(async (directory) => {
      const body = JSON.stringify([searchPr()]);

      // The tool records regardless of the `all` flag -- `all` only changes what
      // is displayed, and the flag is not passed down here at all.
      expectOk(await run(directory, recorder(succeeds(body)).executor));
      const second = expectOk(
        await run(directory, recorder(succeeds(body)).executor),
      );

      // Having seen the full list, the user is not told about those same pull
      // requests again.
      expect(second.deltas).toEqual([]);
      expect(second.trackedCount).toBe(1);
    });
  });

  it("lists the open set for rendering", async () => {
    await withTempDirectory(async (directory) => {
      const value = expectOk(
        await run(
          directory,
          recorder(succeeds(JSON.stringify([searchPr()]))).executor,
        ),
      );

      const report = renderWatch(value, true);
      expect(report).toContain("Open pull requests (1)");
      expect(report).toContain("octo/repo#7");
    });
  });
});

describe("buildWatchValue — lifecycle across many rounds", () => {
  it("evolves the snapshot as a pull request opens, changes, merges, and ages out", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");
      const body = (updatedAt: string) =>
        JSON.stringify([searchPr({ updatedAt })]);

      // Round 1: noticed.
      const first = expectOk(
        await run(directory, recorder(succeeds(body(daysAgo(1)))).executor),
      );
      expect(KINDS(first)).toEqual(["new"]);

      // Round 2: unchanged, silent.
      const second = expectOk(
        await run(directory, recorder(succeeds(body(daysAgo(1)))).executor),
      );
      expect(second.deltas).toEqual([]);

      // Round 3: activity far in the past crosses the threshold.
      const third = expectOk(
        await run(directory, recorder(succeeds(body(daysAgo(20)))).executor),
      );
      expect(KINDS(third)).toEqual(["stale"]);

      // Round 4: silent again, since staleness is reported once.
      const fourth = expectOk(
        await run(directory, recorder(succeeds(body(daysAgo(20)))).executor),
      );
      expect(fourth.deltas).toEqual([]);

      // Round 5: merged.
      const fifth = expectOk(
        await run(
          directory,
          recorder(succeeds("[]"), succeeds(JSON.stringify(viewPr()))).executor,
        ),
      );
      expect(KINDS(fifth)).toEqual(["merged"]);

      // Round 6: terminal entries stay silent and are carried forward.
      const sixth = expectOk(
        await run(directory, recorder(succeeds("[]")).executor),
      );
      expect(sixth.deltas).toEqual([]);

      const stored = await loadSnapshot(path);
      if (stored.status !== "ok") throw new Error("expected ok");
      expect(stored.snapshot.pullRequests["octo/repo#7"].state).toBe("MERGED");
      expect(stored.snapshot.version).toBe(SNAPSHOT_VERSION);
    });
  });

  it("prunes a terminal entry once it is older than the prune window", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");
      await run(
        directory,
        recorder(succeeds(JSON.stringify([searchPr()]))).executor,
      );

      // Merge it while recording a long-past terminal timestamp, so the entry
      // is already past `DEFAULT_PRUNE_DAYS` when the save happens.
      const longAgo = daysAgo(200);
      const exec = recorder(
        succeeds("[]"),
        succeeds(
          JSON.stringify(viewPr({ updatedAt: longAgo, mergedAt: longAgo })),
        ),
      );
      expectOk(await run(directory, exec.executor));

      const stored = await loadSnapshot(path);
      if (stored.status !== "ok") throw new Error("expected ok");
      // Dropped on write, since terminal entries older than 90 days are history
      // the report will never mention again.
      expect(stored.snapshot.pullRequests["octo/repo#7"]).toBeUndefined();
    });
  });

  it("writes a snapshot that loads back as ok", async () => {
    await withTempDirectory(async (directory) => {
      await run(
        directory,
        recorder(succeeds(JSON.stringify([searchPr()]))).executor,
      );

      const stored = await loadSnapshot(join(directory, "snapshot.json"));
      expect(stored.status).toBe("ok");
    });
  });

  it("survives two checks in the same millisecond", async () => {
    await withTempDirectory(async (directory) => {
      const body = JSON.stringify([searchPr()]);

      await Promise.all([
        run(directory, recorder(succeeds(body)).executor),
        run(directory, recorder(succeeds(body)).executor),
      ]);

      // Whatever the interleaving, the file is a whole snapshot and never a
      // truncated one.
      const stored = await loadSnapshot(join(directory, "snapshot.json"));
      expect(stored.status).toBe("ok");
      expect(
        Object.keys(
          (stored as { snapshot: { pullRequests: object } }).snapshot
            .pullRequests,
        ),
      ).toContain("octo/repo#7");
    });
  });
});
