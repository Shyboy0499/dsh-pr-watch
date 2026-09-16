import { describe, it, expect } from "vitest";
import { diff, pruneTerminal } from "../src/delta";
import { DEFAULT_PRUNE_DAYS } from "../src/types";
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
