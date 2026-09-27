import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PHASE_ONE_RESULT_LIMIT,
  mapPhaseOne,
  mapPhaseTwo,
  phaseOneArgs,
  phaseTwoArgs,
  runGh,
} from "../../src/gh-exec";
import { buildWatchValue } from "../../src/tools/pr-watch";
import { renderWatch } from "../../src/tools/watch";

/* -------------------------------------------------------------------------
 * Live checks. These run the real `gh` against GitHub and need it
 * authenticated; they are excluded from `pnpm test` and run by
 * `pnpm run verify:live`.
 *
 * They exist because every other test injects a payload, so a fixture written
 * with the same wrong assumption as the code cannot be caught there. That is
 * exactly how `gh pr view --json repository` shipped: `gh pr view` has no such
 * field, the real call exits 1, and every mocked test still passed while no
 * merge could ever be reported.
 *
 * The assertions are therefore about what `gh` actually accepts and returns,
 * not about a shape this repository chose.
 * ---------------------------------------------------------------------- */

/** A disposable snapshot directory, removed even when an assertion fails. */
async function withTempDirectory(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "dsh-pr-watch-live-"));
  try {
    await body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Fail with the classified reason rather than a confusing `undefined`. */
function unwrap<T extends { status: string }>(
  outcome: T,
  what: string,
): Extract<T, { status: "ok" }> {
  if (outcome.status !== "ok") {
    throw new Error(
      `${what} failed against the real gh: ${JSON.stringify(outcome)}. ` +
        "Is `gh` installed and authenticated (`gh auth status`)?",
    );
  }
  return outcome as Extract<T, { status: "ok" }>;
}

describe("live: the real gh answers both phases", () => {
  it("enumerates open pull requests through gh search prs", async () => {
    const call = unwrap(await runGh(phaseOneArgs(5)), "gh search prs");
    const mapped = unwrap(
      mapPhaseOne(call.stdout, PHASE_ONE_RESULT_LIMIT),
      "mapPhaseOne",
    );

    // Not asserting a count: an account may legitimately have none. What must
    // hold is that whatever came back was understood.
    for (const entry of mapped.records.records) {
      expect(entry.key).toMatch(/^[^/]+\/[^/]+#\d+$/);
      expect(entry.record.state).toBe("OPEN");
      expect(entry.record.url).toContain("/pull/");
    }

    console.log(
      `phase 1: ${mapped.records.records.length} open pull request(s) mapped`,
    );
  });

  it("resolves a real finished pull request through gh pr view", async () => {
    // Discovered rather than hardcoded, so the check does not rot when a
    // particular pull request is forgotten. `--state closed` returns both merged
    // and closed-unmerged, and either is a terminal state worth resolving.
    const search = unwrap(
      await runGh([
        "search",
        "prs",
        "--author",
        "@me",
        "--state",
        "closed",
        "--limit",
        "1",
        "--json",
        "url",
      ]),
      "gh search prs --state closed",
    );

    const rows = JSON.parse(search.stdout) as Array<{ url?: unknown }>;
    const url = rows[0]?.url;
    if (typeof url !== "string") {
      console.log(
        "phase 2: skipped, this account has no finished pull request",
      );
      return;
    }

    const detail = unwrap(await runGh(phaseTwoArgs(url)), "gh pr view");
    const resolved = unwrap(mapPhaseTwo(detail.stdout), "mapPhaseTwo");

    // The identity has to come from the URL, because `gh pr view` returns no
    // repository field -- asking for one is what broke this in the first place.
    expect(resolved.records.key).toBe(
      url.replace(/^.*github\.com\//, "").replace("/pull/", "#"),
    );
    expect(["MERGED", "CLOSED"]).toContain(resolved.records.terminal);

    console.log(
      `phase 2: ${resolved.records.key} resolved as ${resolved.records.terminal}`,
    );
  });
});

describe("live: the whole pipeline against real data", () => {
  it("reports, records, and then goes quiet on a second run", async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");

      const first = unwrap(
        await buildWatchValue({ path, now: new Date() }),
        "the first check",
      );

      // A fresh snapshot means every open pull request is newly noticed, so the
      // report and the tracked count describe the same set.
      expect(first.value.warning).toBeNull();
      expect(first.value.deltas.map((delta) => delta.kind)).toEqual(
        first.value.deltas.map(() => "new"),
      );
      expect(first.value.deltas).toHaveLength(first.value.trackedCount);

      const report = renderWatch(first.value, false);
      expect(report.length).toBeGreaterThan(0);
      console.log(
        `first check: ${first.value.trackedCount} tracked\n${report}`,
      );

      // The second run reads what the first wrote. Nothing may be announced as
      // newly noticed again: that is the persistence and the "reported once"
      // rule, checked against a real file rather than a fixture.
      const second = unwrap(
        await buildWatchValue({ path, now: new Date() }),
        "the second check",
      );
      expect(
        second.value.deltas.filter((delta) => delta.kind === "new"),
      ).toEqual([]);

      console.log(`second check: ${second.value.deltas.length} change(s)`);
    });
  });
});
