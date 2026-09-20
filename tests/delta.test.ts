import { describe, it, expect } from "vitest";
import { diff, pruneTerminal } from "../src/delta";
import { DEFAULT_PRUNE_DAYS, type PrRecord } from "../src/types";
import { NOW, daysAgo, record, snapshot } from "./fixtures";

/** The four fields every delta carries from the record it was derived from. */
function deltaShape(kind: string, key = "octo/repo#1") {
  return {
    kind,
    key,
    url: "https://github.com/octo/repo/pull/1",
    title: "A pull request",
  };
}

describe("diff — departure from the open set", () => {
  it("marks a departure unresolved and keeps it OPEN for the next check", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });

    const { deltas, next } = diff(prev, {}, new Map(), NOW);

    expect(deltas).toEqual([
      { ...deltaShape("unresolved"), updatedAt: record().updatedAt },
    ]);
    expect(next.pullRequests["octo/repo#1"].state).toBe("OPEN");
  });

  it("reports every departure, not just the first", () => {
    const prev = snapshot({
      "octo/repo#1": record(),
      "other/repo#2": record({
        url: "https://github.com/other/repo/pull/2",
        title: "Second",
      }),
    });

    const { deltas } = diff(prev, {}, new Map(), NOW);

    expect(deltas.map((delta) => delta.kind)).toEqual([
      "unresolved",
      "unresolved",
    ]);
    expect(deltas.map((delta) => delta.key)).toEqual([
      "octo/repo#1",
      "other/repo#2",
    ]);
  });

  it("resolves a departure to merged", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });
    const resolved = new Map([["octo/repo#1", "MERGED" as const]]);

    const { deltas, next } = diff(prev, {}, resolved, NOW);

    expect(deltas).toEqual([
      { ...deltaShape("merged"), updatedAt: record().updatedAt },
    ]);
    expect(next.pullRequests["octo/repo#1"].state).toBe("MERGED");
  });

  it("distinguishes a close without merge from a merge", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });
    const resolved = new Map([["octo/repo#1", "CLOSED" as const]]);

    const { deltas, next } = diff(prev, {}, resolved, NOW);

    expect(deltas.map((delta) => delta.kind)).toEqual(["closed"]);
    expect(next.pullRequests["octo/repo#1"].state).toBe("CLOSED");
  });
});

describe("diff — silence", () => {
  it("never re-reports an entry already in a terminal state", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "MERGED" }) });

    const { deltas, next } = diff(prev, {}, new Map(), NOW);

    expect(deltas).toEqual([]);
    expect(next.pullRequests["octo/repo#1"].state).toBe("MERGED");
  });

  it("carries a terminal entry forward even when it is back in the open set", () => {
    // The enumeration should never return a terminal entry, but if it does the
    // terminal state must win: a merged pull request is not un-merged.
    const prev = snapshot({ "octo/repo#1": record({ state: "MERGED" }) });

    const { deltas, next } = diff(
      prev,
      { "octo/repo#1": record() },
      new Map(),
      NOW,
    );

    expect(deltas).toEqual([]);
    expect(next.pullRequests["octo/repo#1"].state).toBe("MERGED");
  });

  it("returns an empty change set when nothing moved", () => {
    const same = record({ updatedAt: daysAgo(2) });
    const prev = snapshot({ "octo/repo#1": same });

    const { deltas, next } = diff(
      prev,
      { "octo/repo#1": same },
      new Map(),
      NOW,
    );

    expect(deltas).toEqual([]);
    expect(next.pullRequests["octo/repo#1"]).toEqual(same);
  });

  it("stays silent for an entry already reported stale", () => {
    const stale = record({ updatedAt: daysAgo(20), staleReported: true });
    const prev = snapshot({ "octo/repo#1": stale });

    const { deltas, next } = diff(
      prev,
      { "octo/repo#1": stale },
      new Map(),
      NOW,
    );

    expect(deltas).toEqual([]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(true);
  });
});

describe("diff — a reopened pull request", () => {
  it("adopts the live record and announces it again", () => {
    // Carrying the terminal state forward used to make a reopened pull request
    // permanently invisible: not open by state, never in a delta, never updated.
    const prev = snapshot({
      "octo/repo#1": record({ state: "CLOSED", updatedAt: daysAgo(10) }),
    });
    const reopened = record({ state: "OPEN", updatedAt: NOW.toISOString() });

    const { deltas, next } = diff(
      prev,
      { "octo/repo#1": reopened },
      new Map(),
      NOW,
    );

    expect(deltas.map((delta) => delta.kind)).toEqual(["new"]);
    expect(next.pullRequests["octo/repo#1"].state).toBe("OPEN");
    expect(next.pullRequests["octo/repo#1"].updatedAt).toBe(reopened.updatedAt);
  });

  it("is silent on the next check, so the reopening is reported once", () => {
    const closed = record({ state: "CLOSED", updatedAt: daysAgo(10) });
    const reopened = record({ state: "OPEN", updatedAt: daysAgo(1) });

    const first = diff(
      snapshot({ "octo/repo#1": closed }),
      { "octo/repo#1": reopened },
      new Map(),
      NOW,
    );
    expect(first.deltas.map((delta) => delta.kind)).toEqual(["new"]);

    const second = diff(
      first.next,
      { "octo/repo#1": reopened },
      new Map(),
      NOW,
    );
    expect(second.deltas).toEqual([]);
  });

  it("still carries a merged pull request forward if it reappears as open", () => {
    // A merge cannot be undone, so this is a contradiction in the feed rather
    // than a lifecycle event, and the recorded outcome wins.
    const merged = record({ state: "MERGED" });

    const { deltas, next } = diff(
      snapshot({ "octo/repo#1": merged }),
      { "octo/repo#1": record() },
      new Map(),
      NOW,
    );

    expect(deltas).toEqual([]);
    expect(next.pullRequests["octo/repo#1"].state).toBe("MERGED");
  });
});

describe("diff — newly noticed", () => {
  it("reports an entry the snapshot did not know about", () => {
    const fresh = record({ updatedAt: daysAgo(2) });

    const { deltas, next } = diff(
      snapshot(),
      { "octo/repo#1": fresh },
      new Map(),
      NOW,
    );

    expect(deltas).toEqual([
      { ...deltaShape("new"), updatedAt: fresh.updatedAt },
    ]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(false);
  });

  it("does not also report a newly noticed entry as stale", () => {
    const old = record({ updatedAt: daysAgo(30) });

    const { deltas, next } = diff(
      snapshot(),
      { "octo/repo#1": old },
      new Map(),
      NOW,
    );

    expect(deltas.map((delta) => delta.kind)).toEqual(["new"]);
    // Recorded as already reported so the next check stays quiet about it.
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(true);
  });

  it("refreshes metadata for an entry that stayed open", () => {
    const prev = snapshot({ "octo/repo#1": record({ title: "Old title" }) });
    const renamed = record({ title: "New title", updatedAt: daysAgo(2) });

    const { next } = diff(prev, { "octo/repo#1": renamed }, new Map(), NOW);

    expect(next.pullRequests["octo/repo#1"].title).toBe("New title");
  });
});

describe("diff — staleness", () => {
  it("reports an entry that just crossed the threshold", () => {
    const stale = record({ updatedAt: daysAgo(20) });
    const prev = snapshot({ "octo/repo#1": stale });

    const { deltas, next } = diff(
      prev,
      { "octo/repo#1": stale },
      new Map(),
      NOW,
    );

    expect(deltas).toEqual([
      { ...deltaShape("stale"), updatedAt: stale.updatedAt },
    ]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(true);
  });

  it("stays silent below the threshold", () => {
    const fresh = record({ updatedAt: daysAgo(3) });
    const prev = snapshot({ "octo/repo#1": fresh });

    const { deltas } = diff(prev, { "octo/repo#1": fresh }, new Map(), NOW);

    expect(deltas).toEqual([]);
  });

  it("honours a staleDays override", () => {
    const fresh = record({ updatedAt: daysAgo(3) });
    const prev = snapshot({ "octo/repo#1": fresh });

    const { deltas } = diff(prev, { "octo/repo#1": fresh }, new Map(), NOW, {
      staleDays: 2,
    });

    expect(deltas.map((delta) => delta.kind)).toEqual(["stale"]);
  });

  it("resets the flag when the entry saw new activity", () => {
    const previouslyStale = record({
      updatedAt: daysAgo(20),
      staleReported: true,
    });
    const nudged = record({ updatedAt: daysAgo(1) });
    const prev = snapshot({ "octo/repo#1": previouslyStale });

    const { deltas, next } = diff(
      prev,
      { "octo/repo#1": nudged },
      new Map(),
      NOW,
    );

    expect(deltas).toEqual([]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(false);
  });

  it("re-reports a nudged entry that goes stale again", () => {
    const previouslyStale = record({
      updatedAt: daysAgo(40),
      staleReported: true,
    });
    const nudged = record({ updatedAt: daysAgo(20) });
    const prev = snapshot({ "octo/repo#1": previouslyStale });

    const { deltas, next } = diff(
      prev,
      { "octo/repo#1": nudged },
      new Map(),
      NOW,
    );

    expect(deltas.map((delta) => delta.kind)).toEqual(["stale"]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(true);
  });
});

describe("diff — the staleness threshold boundary", () => {
  /** An ISO timestamp `days` before NOW, with sub-day precision preserved. */
  function atDaysBefore(days: number): string {
    return new Date(NOW.getTime() - days * 86_400_000).toISOString();
  }

  // The threshold is inclusive: an entry is stale once its age has REACHED
  // staleDays, because "no activity for 14 days" already describes that day.
  // These cases pin the decision rather than leaving it to whichever operator
  // happens to be written.
  it("counts an age of exactly staleDays as stale", () => {
    const exactly = record({ updatedAt: atDaysBefore(14) });
    const prev = snapshot({ "octo/repo#1": exactly });

    const { deltas } = diff(prev, { "octo/repo#1": exactly }, new Map(), NOW);

    expect(deltas.map((delta) => delta.kind)).toEqual(["stale"]);
  });

  it("stays silent one millisecond below the threshold", () => {
    const justUnder = record({ updatedAt: atDaysBefore(14 - 1 / 86_400_000) });
    const prev = snapshot({ "octo/repo#1": justUnder });

    const { deltas } = diff(prev, { "octo/repo#1": justUnder }, new Map(), NOW);

    expect(deltas).toEqual([]);
  });

  it("treats a zero-day threshold as inclusive of the present", () => {
    const present = record({ updatedAt: NOW.toISOString() });
    const prev = snapshot({ "octo/repo#1": present });

    const { deltas } = diff(prev, { "octo/repo#1": present }, new Map(), NOW, {
      staleDays: 0,
    });

    expect(deltas.map((delta) => delta.kind)).toEqual(["stale"]);
  });
});

describe("diff — staleness precedence and silence", () => {
  it("does not repeat the report on an unchanged second check", () => {
    // The regression this whole task exists for: checking twice in a row with
    // nothing happening in between must not report the same staleness again.
    const stale = record({ updatedAt: daysAgo(20) });
    const first = diff(
      snapshot({ "octo/repo#1": stale }),
      { "octo/repo#1": stale },
      new Map(),
      NOW,
    );
    const second = diff(first.next, { "octo/repo#1": stale }, new Map(), NOW);

    expect(first.deltas.map((delta) => delta.kind)).toEqual(["stale"]);
    expect(second.deltas).toEqual([]);
    expect(second.next.pullRequests["octo/repo#1"].staleReported).toBe(true);
  });

  it("reports an entry already past the threshold that has never been reported", () => {
    // Reachable when an entry is first taken into the snapshot without having
    // been judged before, e.g. a snapshot written by an older schema.
    const old = record({ updatedAt: daysAgo(30), staleReported: false });
    const prev = snapshot({ "octo/repo#1": old });

    const { deltas, next } = diff(prev, { "octo/repo#1": old }, new Map(), NOW);

    expect(deltas.map((delta) => delta.kind)).toEqual(["stale"]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(true);
  });

  it("reports every entry that crosses in the same batch, independently", () => {
    const a = record({ updatedAt: daysAgo(20) });
    const b = record({
      url: "https://github.com/other/repo/pull/2",
      title: "Second",
      updatedAt: daysAgo(30),
    });
    const c = record({
      url: "https://github.com/third/repo/pull/3",
      title: "Third",
      updatedAt: daysAgo(2),
    });
    const prev = snapshot({
      "octo/repo#1": a,
      "other/repo#2": b,
      "third/repo#3": c,
    });

    const { deltas, next } = diff(
      prev,
      { "octo/repo#1": a, "other/repo#2": b, "third/repo#3": c },
      new Map(),
      NOW,
    );

    expect(deltas.map((delta) => delta.key)).toEqual([
      "octo/repo#1",
      "other/repo#2",
    ]);
    expect(next.pullRequests["third/repo#3"].staleReported).toBe(false);
  });

  it("never reports staleness for an entry that left the open set", () => {
    // The departure wins: its terminal state is unknown, so calling it stale
    // would be a second, competing claim about the same pull request.
    const quiet = record({ updatedAt: daysAgo(60) });
    const prev = snapshot({ "octo/repo#1": quiet });

    const { deltas } = diff(prev, {}, new Map(), NOW);

    expect(deltas.map((delta) => delta.kind)).toEqual(["unresolved"]);
  });

  it("never reports staleness for a terminal entry however old", () => {
    const finished = record({ state: "MERGED", updatedAt: daysAgo(400) });
    const prev = snapshot({ "octo/repo#1": finished });

    const { deltas } = diff(prev, { "octo/repo#1": finished }, new Map(), NOW);

    expect(deltas).toEqual([]);
  });

  it("never reports staleness when the open set is empty", () => {
    const quiet = record({ updatedAt: daysAgo(60) });
    const prev = snapshot({ "octo/repo#1": quiet });

    const { deltas } = diff(prev, {}, new Map(), NOW);

    expect(deltas.some((delta) => delta.kind === "stale")).toBe(false);
  });

  it("never reports staleness against an empty snapshot", () => {
    const { deltas } = diff(snapshot(), {}, new Map(), NOW);

    expect(deltas).toEqual([]);
  });
});

describe("diff — clock anomalies", () => {
  it("does not call a future timestamp stale", () => {
    // A backwards clock or a bad API payload puts updatedAt ahead of now. That
    // is a negative age, which must never read as "long inactive".
    const future = record({
      updatedAt: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(),
    });
    const prev = snapshot({ "octo/repo#1": future });

    const { deltas, next } = diff(
      prev,
      { "octo/repo#1": future },
      new Map(),
      NOW,
    );

    expect(deltas).toEqual([]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(false);
  });

  it("does not call an implausibly distant future timestamp stale", () => {
    const future = record({ updatedAt: "9999-12-31T23:59:59.000Z" });
    const prev = snapshot({ "octo/repo#1": future });

    const { deltas } = diff(prev, { "octo/repo#1": future }, new Map(), NOW);

    expect(deltas).toEqual([]);
  });

  it("is unaffected by the wall clock, only by the injected now", () => {
    // Two runs in the same millisecond must agree, and a much later run over
    // the snapshot the first run produced must stay silent: nothing reads a
    // clock of its own, and the flag travels with the snapshot.
    const stale = record({ updatedAt: daysAgo(20) });
    const prev = snapshot({ "octo/repo#1": stale });
    const open = { "octo/repo#1": stale };

    const first = diff(prev, open, new Map(), NOW);
    const repeat = diff(prev, open, new Map(), NOW);
    const later = diff(
      first.next,
      open,
      new Map(),
      new Date(NOW.getTime() + 365 * 86_400_000),
    );

    expect(repeat).toEqual(first);
    // A year on, the flag the first run recorded is still in force.
    expect(later.deltas).toEqual([]);
  });
});

describe("diff — terminal outcomes", () => {
  it("reports a merge once and is silent on the next check", () => {
    // "Merges never repeat." The state itself is the record that the outcome
    // was reported, so the second pass has nothing left to say.
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });
    const resolved = new Map([["octo/repo#1", "MERGED" as const]]);

    const first = diff(prev, {}, resolved, NOW);
    const second = diff(first.next, {}, new Map(), NOW);

    expect(first.deltas.map((delta) => delta.kind)).toEqual(["merged"]);
    expect(second.deltas).toEqual([]);
  });

  it("reports a close without merge once and is silent on the next check", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });
    const resolved = new Map([["octo/repo#1", "CLOSED" as const]]);

    const first = diff(prev, {}, resolved, NOW);
    const second = diff(first.next, {}, new Map(), NOW);

    expect(first.deltas.map((delta) => delta.kind)).toEqual(["closed"]);
    expect(second.deltas).toEqual([]);
  });

  it("keeps merged and closed in separate buckets", () => {
    const prev = snapshot({
      "octo/repo#1": record(),
      "other/repo#2": record({
        url: "https://github.com/other/repo/pull/2",
        title: "Second",
      }),
    });
    const resolved = new Map([
      ["octo/repo#1", "MERGED" as const],
      ["other/repo#2", "CLOSED" as const],
    ]);

    const { deltas } = diff(prev, {}, resolved, NOW);

    expect(deltas.filter((delta) => delta.kind === "merged")).toHaveLength(1);
    expect(deltas.filter((delta) => delta.kind === "closed")).toHaveLength(1);
    expect(deltas.find((delta) => delta.kind === "merged")?.key).toBe(
      "octo/repo#1",
    );
  });

  it("reports every entry that reaches a terminal state in the same batch", () => {
    const prev = snapshot({
      "octo/repo#1": record(),
      "other/repo#2": record({
        url: "https://github.com/other/repo/pull/2",
        title: "Second",
      }),
      "third/repo#3": record({
        url: "https://github.com/third/repo/pull/3",
        title: "Third",
        // Already reported as gone, so this pass has only the two outcomes to
        // announce. Without it the third would also emit `unresolved`.
        departedReported: true,
      }),
    });
    const resolved = new Map([
      ["octo/repo#1", "MERGED" as const],
      ["other/repo#2", "CLOSED" as const],
    ]);

    const { deltas, next } = diff(prev, {}, resolved, NOW);

    expect(deltas.map((delta) => delta.kind)).toEqual(["merged", "closed"]);
    expect(next.pullRequests["third/repo#3"].state).toBe("OPEN");
  });

  it("reports the terminal outcome rather than staleness when both apply", () => {
    // The entry is far past the stale threshold and has just been resolved. The
    // terminal state wins: precedence 1 and 2 both sit above staleness, and
    // calling a finished pull request "quiet" would be a competing claim.
    const quiet = record({ updatedAt: daysAgo(90) });
    const prev = snapshot({ "octo/repo#1": quiet });
    const resolved = new Map([["octo/repo#1", "MERGED" as const]]);

    const { deltas } = diff(prev, {}, resolved, NOW);

    expect(deltas.map((delta) => delta.kind)).toEqual(["merged"]);
  });
});

describe("diff — unresolvable departures", () => {
  it("reports an unresolved departure once, then stays silent", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });

    const first = diff(prev, {}, new Map(), NOW);
    const second = diff(first.next, {}, new Map(), NOW);

    expect(first.deltas.map((delta) => delta.kind)).toEqual(["unresolved"]);
    expect(second.deltas).toEqual([]);
    expect(second.next.pullRequests["octo/repo#1"].departedReported).toBe(true);
  });

  it("keeps an unresolved entry OPEN so the next check retries it", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });

    const { next } = diff(prev, {}, new Map(), NOW);

    expect(next.pullRequests["octo/repo#1"].state).toBe("OPEN");
  });

  it("reports once for each unresolvable departure in a batch", () => {
    const prev = snapshot({
      "octo/repo#1": record(),
      "other/repo#2": record({
        url: "https://github.com/other/repo/pull/2",
        title: "Second",
      }),
    });

    const first = diff(prev, {}, new Map(), NOW);
    const second = diff(first.next, {}, new Map(), NOW);

    expect(first.deltas.map((delta) => delta.kind)).toEqual([
      "unresolved",
      "unresolved",
    ]);
    expect(second.deltas).toEqual([]);
  });

  it("stays silent for a departure already reported as unresolved", () => {
    const prev = snapshot({
      "octo/repo#1": record({ state: "OPEN", departedReported: true }),
    });

    const { deltas } = diff(prev, {}, new Map(), NOW);

    expect(deltas).toEqual([]);
  });

  it("never reports unresolved as merged or closed", () => {
    // An empty result and a failed lookup are indistinguishable from here, so
    // inferring an outcome would invent a merge that never happened.
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });

    const { deltas } = diff(prev, {}, new Map(), NOW);

    expect(deltas.some((delta) => delta.kind === "merged")).toBe(false);
    expect(deltas.some((delta) => delta.kind === "closed")).toBe(false);
  });

  it("reports the outcome when a previously unresolvable entry resolves", () => {
    const prev = snapshot({
      "octo/repo#1": record({ state: "OPEN", departedReported: true }),
    });
    const resolved = new Map([["octo/repo#1", "MERGED" as const]]);

    const { deltas, next } = diff(prev, {}, resolved, NOW);

    expect(deltas.map((delta) => delta.kind)).toEqual(["merged"]);
    // The departure flag is spent: the terminal state is now the record.
    expect(next.pullRequests["octo/repo#1"].departedReported).toBe(false);
  });
});

describe("diff and pruneTerminal — the full lifecycle", () => {
  it("walks unresolved, merged, silence, then pruning", () => {
    const open = record({ updatedAt: daysAgo(5) });

    // Check 1: it has left the open set and cannot be resolved yet.
    const first = diff(snapshot({ "octo/repo#1": open }), {}, new Map(), NOW);
    expect(first.deltas.map((delta) => delta.kind)).toEqual(["unresolved"]);
    expect(first.next.pullRequests["octo/repo#1"].state).toBe("OPEN");

    // Check 2: still unresolvable, and now silent.
    const second = diff(first.next, {}, new Map(), NOW);
    expect(second.deltas).toEqual([]);

    // Check 3: the resolve phase answers -- merged. `updatedAt` moves to the
    // moment it landed, which is how terminal time is measured.
    const landed = record({
      state: "OPEN",
      updatedAt: NOW.toISOString(),
      departedReported: true,
    });
    const third = diff(
      snapshot({ "octo/repo#1": landed }),
      {},
      new Map([["octo/repo#1", "MERGED" as const]]),
      NOW,
    );
    expect(third.deltas.map((delta) => delta.kind)).toEqual(["merged"]);
    expect(third.next.pullRequests["octo/repo#1"].state).toBe("MERGED");

    // Check 4: reported once, now silent.
    const fourth = diff(third.next, {}, new Map(), NOW);
    expect(fourth.deltas).toEqual([]);

    // Well inside the prune window: kept, and still silent.
    const inside = new Date(NOW.getTime() + 30 * 86_400_000);
    expect(
      Object.keys(pruneTerminal(fourth.next, inside).pullRequests),
    ).toEqual(["octo/repo#1"]);
    expect(diff(fourth.next, {}, new Map(), inside).deltas).toEqual([]);

    // Past the window: the entry finally leaves the snapshot.
    const outside = new Date(NOW.getTime() + 91 * 86_400_000);
    expect(pruneTerminal(fourth.next, outside).pullRequests).toEqual({});
  });
});

describe("pruneTerminal — the retention boundary", () => {
  /** A terminal entry whose last activity was exactly `days` ago. */
  function mergedDaysAgo(days: number) {
    return snapshot({
      "octo/repo#1": record({
        state: "MERGED",
        updatedAt: new Date(NOW.getTime() - days * 86_400_000).toISOString(),
      }),
    });
  }

  // The comparison is exclusive: exactly `pruneDays` old is still kept, and
  // only the next day drops it. Staleness chose inclusive because it decides
  // whether a user is told something; pruning decides whether a decision is
  // forgotten, so the safe side of the boundary is the one that keeps data.
  it("keeps an entry exactly pruneDays old", () => {
    expect(
      Object.keys(pruneTerminal(mergedDaysAgo(90), NOW).pullRequests),
    ).toEqual(["octo/repo#1"]);
  });

  it("drops an entry one day past pruneDays", () => {
    expect(pruneTerminal(mergedDaysAgo(91), NOW).pullRequests).toEqual({});
  });

  it("honours an explicit pruneDays of zero as exclusive", () => {
    // Aged by a day: dropped. Age zero would be kept, which is why the boundary
    // is worth pinning rather than assuming.
    expect(pruneTerminal(mergedDaysAgo(1), NOW, 0).pullRequests).toEqual({});
    expect(
      Object.keys(pruneTerminal(mergedDaysAgo(0), NOW, 0).pullRequests),
    ).toEqual(["octo/repo#1"]);
  });

  it("keeps everything under an enormous window", () => {
    const input = mergedDaysAgo(5000);

    expect(
      Object.keys(
        pruneTerminal(input, NOW, Number.MAX_SAFE_INTEGER).pullRequests,
      ),
    ).toEqual(["octo/repo#1"]);
  });

  it("never prunes on a future timestamp", () => {
    // A backwards clock would otherwise make every terminal entry look ancient
    // and wipe the snapshot's history in one pass.
    const future = snapshot({
      "octo/repo#1": record({
        state: "MERGED",
        updatedAt: new Date(NOW.getTime() + 10 * 86_400_000).toISOString(),
      }),
    });

    expect(Object.keys(pruneTerminal(future, NOW).pullRequests)).toEqual([
      "octo/repo#1",
    ]);
  });

  it("never prunes an unresolved entry however long it has been gone", () => {
    // It stays OPEN, and an open entry is never pruned. Dropping it would
    // destroy a pending change that was never reported.
    const input = snapshot({
      "octo/repo#1": record({
        state: "OPEN",
        updatedAt: daysAgo(5000),
        departedReported: true,
      }),
    });

    expect(Object.keys(pruneTerminal(input, NOW).pullRequests)).toEqual([
      "octo/repo#1",
    ]);
  });

  it("reports no prune set for an empty snapshot", () => {
    expect(pruneTerminal(snapshot(), NOW).pullRequests).toEqual({});
  });
});

describe("diff — all four kinds in one result", () => {
  it("keeps every kind separate and orders the result by severity", () => {
    // One batch containing four kinds at once. Keys are inserted in an order
    // unrelated to the expected output, so a result that merely preserved
    // enumeration order could not pass.
    const merged = record({ updatedAt: daysAgo(1) });
    const closed = record({
      url: "https://github.com/zeta/repo/pull/9",
      title: "Zeta",
      updatedAt: daysAgo(2),
    });
    const untracked = record({
      url: "https://github.com/beta/repo/pull/5",
      title: "Beta",
    });
    const stale = record({
      url: "https://github.com/mid/repo/pull/7",
      title: "Mid",
      updatedAt: daysAgo(90),
    });
    const fresh = record({
      url: "https://github.com/alpha/repo/pull/3",
      title: "Alpha",
      updatedAt: daysAgo(30),
    });

    const prev = snapshot({
      "octo/repo#1": merged,
      "zeta/repo#9": closed,
      "mid/repo#7": stale,
    });
    const resolved = new Map([
      ["octo/repo#1", "MERGED" as const],
      ["zeta/repo#9", "CLOSED" as const],
    ]);

    const { deltas } = diff(
      prev,
      { "mid/repo#7": stale, "alpha/repo#3": fresh },
      resolved,
      NOW,
    );

    expect(deltas.map((delta) => delta.kind)).toEqual([
      "merged",
      "closed",
      "stale",
      "new",
    ]);
    expect(deltas.map((delta) => delta.key)).toEqual([
      "octo/repo#1",
      "zeta/repo#9",
      "mid/repo#7",
      "alpha/repo#3",
    ]);
    // Not in the snapshot and not in the open set: untracked, so invisible.
    expect(deltas.some((delta) => delta.key === "beta/repo#5")).toBe(false);
    expect(untracked.state).toBe("OPEN");
  });

  it("never reports a terminal entry as stale", () => {
    const finished = record({ state: "MERGED", updatedAt: daysAgo(400) });
    const prev = snapshot({ "octo/repo#1": finished });

    const { deltas } = diff(prev, { "octo/repo#1": finished }, new Map(), NOW);

    expect(deltas).toEqual([]);
  });

  it("never lets a resolved outcome swallow an unresolved one", () => {
    const prev = snapshot({
      "octo/repo#1": record(),
      "other/repo#2": record({
        url: "https://github.com/other/repo/pull/2",
        title: "Second",
      }),
    });
    const resolved = new Map([["octo/repo#1", "MERGED" as const]]);

    const { deltas } = diff(prev, {}, resolved, NOW);

    expect(deltas.map((delta) => delta.kind)).toEqual(["merged", "unresolved"]);
    // The unresolved entry is still there to be retried, not folded away.
    expect(deltas.map((delta) => delta.key)).toEqual([
      "octo/repo#1",
      "other/repo#2",
    ]);
  });

  it("reports a single pull request exactly once", () => {
    // Far past the stale threshold AND resolved in the same pass: only the
    // terminal outcome may appear.
    const quiet = record({ updatedAt: daysAgo(200) });
    const prev = snapshot({ "octo/repo#1": quiet });

    const { deltas } = diff(
      prev,
      {},
      new Map([["octo/repo#1", "MERGED" as const]]),
      NOW,
    );

    expect(deltas).toHaveLength(1);
    expect(deltas.map((delta) => delta.kind)).toEqual(["merged"]);
  });
});

describe("diff — output determinism", () => {
  /** Build an open set by inserting keys in the given order. */
  function openSetInOrder(names: string[]): Record<string, PrRecord> {
    const open: Record<string, PrRecord> = {};
    for (const name of names) {
      open[`${name}/repo#1`] = record({
        url: `https://github.com/${name}/repo/pull/1`,
        title: name,
        updatedAt: daysAgo(2),
      });
    }
    return open;
  }

  it("returns the same order regardless of how the open set was built", () => {
    const names = ["alpha", "mid", "zeta"];
    const forwards = openSetInOrder(names);
    const backwards = openSetInOrder([...names].reverse());

    // Same membership, different insertion order. Insertion order is a property
    // of the caller's object, not of the result, so it must not survive.
    expect(Object.keys(forwards)).not.toEqual(Object.keys(backwards));

    const a = diff(snapshot(), forwards, new Map(), NOW);
    const b = diff(snapshot(), backwards, new Map(), NOW);

    expect(b.deltas).toEqual(a.deltas);
    expect(a.deltas.map((delta) => delta.key)).toEqual([
      "alpha/repo#1",
      "mid/repo#1",
      "zeta/repo#1",
    ]);
  });

  it("returns the same order regardless of how the snapshot was built", () => {
    const build = (names: string[]) => {
      const pullRequests: Record<string, PrRecord> = {};
      for (const name of names) {
        pullRequests[`${name}/repo#1`] = record({
          url: `https://github.com/${name}/repo/pull/1`,
          title: name,
          updatedAt: daysAgo(20),
        });
      }
      return snapshot(pullRequests);
    };

    const names = ["alpha", "mid", "zeta"];
    const a = diff(build(names), {}, new Map(), NOW);
    const b = diff(build([...names].reverse()), {}, new Map(), NOW);

    expect(b.deltas).toEqual(a.deltas);
    expect(a.deltas.map((delta) => delta.key)).toEqual([
      "alpha/repo#1",
      "mid/repo#1",
      "zeta/repo#1",
    ]);
  });

  it("orders the newest activity first within one kind", () => {
    // Distinct repositories on purpose. `key` is the primary discriminator, so
    // activity only decides the order between entries whose keys already sort
    // the same way -- which means across repos, not within one.
    const prev = snapshot({
      "alpha/repo#1": record({
        url: "https://github.com/alpha/repo/pull/1",
        updatedAt: daysAgo(30),
      }),
      "beta/repo#1": record({
        url: "https://github.com/beta/repo/pull/1",
        updatedAt: daysAgo(1),
      }),
      "gamma/repo#1": record({
        url: "https://github.com/gamma/repo/pull/1",
        updatedAt: daysAgo(10),
      }),
    });

    const { deltas } = diff(prev, {}, new Map(), NOW);

    expect(deltas.every((delta) => delta.kind === "unresolved")).toBe(true);
    // Key order first, which is the contract: alpha, beta, gamma.
    expect(deltas.map((delta) => delta.key)).toEqual([
      "alpha/repo#1",
      "beta/repo#1",
      "gamma/repo#1",
    ]);
  });

  it("keeps key order ahead of recency so the order is reproducible", () => {
    // Same three entries, this time proving the sort key does not fall back to
    // recency: the newest entry is deliberately not the first by key.
    const prev = snapshot({
      "alpha/repo#1": record({
        url: "https://github.com/alpha/repo/pull/1",
        updatedAt: daysAgo(30),
      }),
      "beta/repo#1": record({
        url: "https://github.com/beta/repo/pull/1",
        updatedAt: daysAgo(1),
      }),
    });

    const { deltas } = diff(prev, {}, new Map(), NOW);

    expect(deltas.map((delta) => delta.updatedAt)).toEqual([
      daysAgo(30),
      daysAgo(1),
    ]);
  });

  it("is deeply equal across repeated runs on the same input", () => {
    const prev = snapshot({
      "octo/repo#1": record({ updatedAt: daysAgo(20) }),
      "other/repo#2": record({
        url: "https://github.com/other/repo/pull/2",
        title: "Second",
        updatedAt: daysAgo(90),
      }),
    });
    const open = { "octo/repo#1": record({ updatedAt: daysAgo(20) }) };

    const first = diff(prev, open, new Map(), NOW);
    const second = diff(prev, open, new Map(), NOW);

    expect(second).toEqual(first);
    expect(second.deltas.map((delta) => delta.kind)).toEqual([
      "unresolved",
      "stale",
    ]);
  });

  it("reports nothing on a second pass in the same millisecond", () => {
    const open = { "octo/repo#1": record({ updatedAt: daysAgo(20) }) };
    const first = diff(snapshot(), open, new Map(), NOW);
    const second = diff(first.next, open, new Map(), NOW);

    expect(first.deltas.map((delta) => delta.kind)).toEqual(["new"]);
    expect(second.deltas).toEqual([]);
  });
});

describe("diff — first run", () => {
  it("reports every open entry as newly noticed, in key order", () => {
    // What the README means by "useful on first run, where everything is newly
    // noticed": an empty snapshot has nothing to compare against.
    const open = {
      "zeta/repo#1": record({ url: "u1", title: "z" }),
      "alpha/repo#1": record({ url: "u2", title: "a" }),
      "mid/repo#1": record({ url: "u3", title: "m" }),
    };

    const { deltas, next } = diff(snapshot(), open, new Map(), NOW);

    expect(deltas.every((delta) => delta.kind === "new")).toBe(true);
    expect(deltas.map((delta) => delta.key)).toEqual([
      "alpha/repo#1",
      "mid/repo#1",
      "zeta/repo#1",
    ]);
    // Recorded, so the next pass has nothing to announce.
    expect(Object.keys(next.pullRequests).sort()).toEqual([
      "alpha/repo#1",
      "mid/repo#1",
      "zeta/repo#1",
    ]);
    expect(diff(next, open, new Map(), NOW).deltas).toEqual([]);
  });

  it("returns a normalised empty change set when there is nothing at all", () => {
    const result = diff(snapshot(), {}, new Map(), NOW);

    expect(result.deltas).toEqual([]);
    expect(Array.isArray(result.deltas)).toBe(true);
    expect(result.next.pullRequests).toEqual({});
    expect(result.next.lastCheck).toBe(NOW.toISOString());
  });
});

describe("diff — the whole lifecycle in one chain", () => {
  it("walks new, silence, stale, silence, terminal, silence, then pruned", () => {
    const open = record({ updatedAt: NOW.toISOString() });

    // First run: everything is new.
    const first = diff(snapshot(), { "octo/repo#1": open }, new Map(), NOW);
    expect(first.deltas.map((delta) => delta.kind)).toEqual(["new"]);

    // Nothing moved: silent.
    const second = diff(first.next, { "octo/repo#1": open }, new Map(), NOW);
    expect(second.deltas).toEqual([]);

    // Long enough later, it crosses the stale threshold exactly once.
    const staleAt = new Date(NOW.getTime() + 15 * 86_400_000);
    const third = diff(
      second.next,
      { "octo/repo#1": open },
      new Map(),
      staleAt,
    );
    expect(third.deltas.map((delta) => delta.kind)).toEqual(["stale"]);

    // And stays quiet afterwards, even much later.
    const fourth = diff(
      third.next,
      { "octo/repo#1": open },
      new Map(),
      new Date(NOW.getTime() + 60 * 86_400_000),
    );
    expect(fourth.deltas).toEqual([]);

    // It leaves the open set and resolves as merged.
    const fifth = diff(
      fourth.next,
      {},
      new Map([["octo/repo#1", "MERGED" as const]]),
      staleAt,
    );
    expect(fifth.deltas.map((delta) => delta.kind)).toEqual(["merged"]);

    // Reported once, then silent.
    const sixth = diff(fifth.next, {}, new Map(), staleAt);
    expect(sixth.deltas).toEqual([]);

    // Kept while inside the retention window, dropped after it. Terminal time
    // comes from `updatedAt`, which the resolution above left at NOW.
    const inside = new Date(staleAt.getTime() + 74 * 86_400_000);
    expect(Object.keys(pruneTerminal(sixth.next, inside).pullRequests)).toEqual(
      ["octo/repo#1"],
    );
    const outside = new Date(staleAt.getTime() + 76 * 86_400_000);
    expect(pruneTerminal(sixth.next, outside).pullRequests).toEqual({});
  });
});

describe("diff — the reported check time", () => {
  it("records the injected clock on the next snapshot", () => {
    const { next } = diff(snapshot(), {}, new Map(), NOW);

    expect(next.lastCheck).toBe(NOW.toISOString());
  });
});

describe("diff — boundaries", () => {
  it("returns empty for an empty snapshot against an empty open set", () => {
    const { deltas, next } = diff(snapshot(), {}, new Map(), NOW);

    expect(deltas).toEqual([]);
    expect(next.pullRequests).toEqual({});
  });

  it("reports everything as new when the snapshot is empty", () => {
    const open = {
      "octo/repo#1": record(),
      "other/repo#2": record({ url: "u", title: "t" }),
    };

    const { deltas } = diff(snapshot(), open, new Map(), NOW);

    expect(deltas.map((delta) => delta.kind)).toEqual(["new", "new"]);
  });

  it("treats a zero stale threshold as everything being stale", () => {
    const fresh = record({ updatedAt: NOW.toISOString() });
    const prev = snapshot({ "octo/repo#1": fresh });

    const { deltas } = diff(prev, { "octo/repo#1": fresh }, new Map(), NOW, {
      staleDays: 0,
    });

    expect(deltas.map((delta) => delta.kind)).toEqual(["stale"]);
  });

  it("treats an enormous stale threshold as nothing being stale", () => {
    const stale = record({ updatedAt: daysAgo(500) });
    const prev = snapshot({ "octo/repo#1": stale });

    const { deltas } = diff(prev, { "octo/repo#1": stale }, new Map(), NOW, {
      staleDays: Number.MAX_SAFE_INTEGER,
    });

    expect(deltas).toEqual([]);
  });

  it("never treats an unparseable timestamp as stale", () => {
    const broken = record({ updatedAt: "not a date" });
    const prev = snapshot({ "octo/repo#1": broken });

    const { deltas } = diff(prev, { "octo/repo#1": broken }, new Map(), NOW);

    expect(deltas).toEqual([]);
  });

  it("cannot see a pull request opened and merged between two checks", () => {
    // Absent from the snapshot and absent from the open set: neither phase sees
    // it. The known limitation is that it produces nothing at all -- not an
    // error, and not a spurious entry.
    const prev = snapshot({ "octo/repo#1": record({ state: "MERGED" }) });

    const { deltas, next } = diff(prev, {}, new Map(), NOW);

    expect(deltas).toEqual([]);
    expect(Object.keys(next.pullRequests)).toEqual(["octo/repo#1"]);
  });

  it("is deterministic under a frozen clock", () => {
    const prev = snapshot({
      "octo/repo#1": record({ updatedAt: daysAgo(20) }),
    });
    const open = { "octo/repo#1": record({ updatedAt: daysAgo(20) }) };

    const first = diff(prev, open, new Map(), NOW);
    const second = diff(prev, open, new Map(), NOW);

    expect(second).toEqual(first);
  });
});

describe("pruneTerminal", () => {
  it("drops a terminal entry older than the prune window", () => {
    const input = snapshot({
      "octo/repo#1": record({ state: "MERGED", updatedAt: daysAgo(120) }),
    });

    expect(pruneTerminal(input, NOW).pullRequests).toEqual({});
  });

  it("keeps a recent terminal entry", () => {
    const input = snapshot({
      "octo/repo#1": record({ state: "MERGED", updatedAt: daysAgo(10) }),
    });

    expect(Object.keys(pruneTerminal(input, NOW).pullRequests)).toEqual([
      "octo/repo#1",
    ]);
  });

  it("never prunes an open entry however old", () => {
    const input = snapshot({
      "octo/repo#1": record({ state: "OPEN", updatedAt: daysAgo(500) }),
    });

    expect(Object.keys(pruneTerminal(input, NOW).pullRequests)).toEqual([
      "octo/repo#1",
    ]);
  });

  it("honours a pruneDays override", () => {
    const input = snapshot({
      "octo/repo#1": record({ state: "CLOSED", updatedAt: daysAgo(10) }),
    });

    expect(pruneTerminal(input, NOW, 5).pullRequests).toEqual({});
  });

  it("defaults to the documented prune window", () => {
    const justInside = snapshot({
      "octo/repo#1": record({
        state: "MERGED",
        updatedAt: daysAgo(DEFAULT_PRUNE_DAYS - 1),
      }),
    });
    const justOutside = snapshot({
      "octo/repo#1": record({
        state: "MERGED",
        updatedAt: daysAgo(DEFAULT_PRUNE_DAYS + 1),
      }),
    });

    expect(Object.keys(pruneTerminal(justInside, NOW).pullRequests)).toEqual([
      "octo/repo#1",
    ]);
    expect(pruneTerminal(justOutside, NOW).pullRequests).toEqual({});
  });

  it("never prunes an unparseable timestamp", () => {
    const input = snapshot({
      "octo/repo#1": record({ state: "MERGED", updatedAt: "not a date" }),
    });

    expect(Object.keys(pruneTerminal(input, NOW).pullRequests)).toEqual([
      "octo/repo#1",
    ]);
  });

  it("leaves the snapshot's other fields alone", () => {
    const input = snapshot({ "octo/repo#1": record({ state: "MERGED" }) });

    const result = pruneTerminal(input, NOW);

    expect(result.version).toBe(input.version);
    expect(result.lastCheck).toBe(input.lastCheck);
  });
});
