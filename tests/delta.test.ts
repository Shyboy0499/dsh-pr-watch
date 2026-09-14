import { describe, it, expect } from "vitest";
import { diff, pruneTerminal } from "../src/delta";
import { NOW, daysAgo, record, snapshot } from "./fixtures";

/** The fields every delta for the default fixture shares. */
function toDeltaShape(kind: string) {
  return {
    kind,
    key: "octo/repo#1",
    url: "https://github.com/octo/repo/pull/1",
    title: "A pull request",
  };
}

describe("diff — terminal transitions", () => {
  it("reports a merge and records the terminal state", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });
    const resolved = new Map([["octo/repo#1", "MERGED" as const]]);

    const { deltas, next } = diff(prev, {}, resolved, NOW);

    expect(deltas).toEqual([
      { ...toDeltaShape("merged"), updatedAt: record().updatedAt },
    ]);
    expect(next.pullRequests["octo/repo#1"].state).toBe("MERGED");
  });

  it("reports a close without merge distinctly from a merge", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });
    const resolved = new Map([["octo/repo#1", "CLOSED" as const]]);

    const { deltas, next } = diff(prev, {}, resolved, NOW);

    expect(deltas).toHaveLength(1);
    expect(deltas[0].kind).toBe("closed");
    expect(next.pullRequests["octo/repo#1"].state).toBe("CLOSED");
  });

  it("never re-reports a pull request already in a terminal state", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "MERGED" }) });

    const { deltas, next } = diff(prev, {}, new Map(), NOW);

    expect(deltas).toEqual([]);
    expect(next.pullRequests["octo/repo#1"].state).toBe("MERGED");
  });

  it("records the check time on the next snapshot", () => {
    const { next } = diff(snapshot(), {}, new Map(), NOW);
    expect(next.lastCheck).toBe(NOW.toISOString());
  });
});

describe("diff — staleness", () => {
  it("reports a pull request that just crossed the threshold", () => {
    const stale = record({ updatedAt: daysAgo(20) });
    const prev = snapshot({ "octo/repo#1": stale });

    const { deltas, next } = diff(prev, { "octo/repo#1": stale }, new Map(), NOW);

    expect(deltas).toEqual([{ ...toDeltaShape("stale"), updatedAt: stale.updatedAt }]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(true);
  });

  it("stays silent for a pull request already reported stale", () => {
    const stale = record({ updatedAt: daysAgo(20), staleReported: true });
    const prev = snapshot({ "octo/repo#1": stale });

    const { deltas } = diff(prev, { "octo/repo#1": stale }, new Map(), NOW);

    expect(deltas).toEqual([]);
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

    const { deltas } = diff(prev, { "octo/repo#1": fresh }, new Map(), NOW, { staleDays: 2 });

    expect(deltas).toHaveLength(1);
    expect(deltas[0].kind).toBe("stale");
  });

  it("resets the stale flag when the pull request saw new activity", () => {
    const previouslyStale = record({ updatedAt: daysAgo(20), staleReported: true });
    const nudge = record({ updatedAt: daysAgo(1) });
    const prev = snapshot({ "octo/repo#1": previouslyStale });

    const { deltas, next } = diff(prev, { "octo/repo#1": nudge }, new Map(), NOW);

    expect(deltas).toEqual([]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(false);
  });

  it("re-reports a nudged pull request that goes stale again", () => {
    const previouslyStale = record({ updatedAt: daysAgo(40), staleReported: true });
    const nudge = record({ updatedAt: daysAgo(20) });
    const prev = snapshot({ "octo/repo#1": previouslyStale });

    const { deltas, next } = diff(prev, { "octo/repo#1": nudge }, new Map(), NOW);

    expect(deltas).toHaveLength(1);
    expect(deltas[0].kind).toBe("stale");
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(true);
  });
});

describe("diff — new and unresolved", () => {
  it("reports a newly noticed pull request", () => {
    const fresh = record({ updatedAt: daysAgo(2) });
    const { deltas, next } = diff(snapshot(), { "octo/repo#1": fresh }, new Map(), NOW);

    expect(deltas).toEqual([{ ...toDeltaShape("new"), updatedAt: fresh.updatedAt }]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(false);
  });

  it("does not double-report a newly noticed pull request that is already stale", () => {
    const old = record({ updatedAt: daysAgo(30) });
    const { deltas, next } = diff(snapshot(), { "octo/repo#1": old }, new Map(), NOW);

    expect(deltas.map((d) => d.kind)).toEqual(["new"]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(true);
  });

  it("reports an unresolvable departure and keeps it open for the next check", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });

    const { deltas, next } = diff(prev, {}, new Map(), NOW);

    expect(deltas.map((d) => d.kind)).toEqual(["unresolved"]);
    expect(next.pullRequests["octo/repo#1"].state).toBe("OPEN");
  });

  it("leaves an untouched open pull request untouched", () => {
    const same = record({ updatedAt: daysAgo(2) });
    const prev = snapshot({ "octo/repo#1": same });

    const { deltas, next } = diff(prev, { "octo/repo#1": same }, new Map(), NOW);

    expect(deltas).toEqual([]);
    expect(next.pullRequests["octo/repo#1"]).toEqual(same);
  });

  it("refreshes metadata for a still-open pull request", () => {
    const prev = snapshot({ "octo/repo#1": record({ title: "Old title" }) });
    const renamed = record({ title: "New title", updatedAt: daysAgo(2) });

    const { next } = diff(prev, { "octo/repo#1": renamed }, new Map(), NOW);

    expect(next.pullRequests["octo/repo#1"].title).toBe("New title");
  });
});

describe("pruneTerminal", () => {
  it("drops a terminal entry older than the prune window", () => {
    const input = snapshot({ "octo/repo#1": record({ state: "MERGED", updatedAt: daysAgo(120) }) });

    const result = pruneTerminal(input, NOW);

    expect(result.pullRequests).toEqual({});
  });

  it("keeps a recent terminal entry", () => {
    const input = snapshot({ "octo/repo#1": record({ state: "MERGED", updatedAt: daysAgo(10) }) });

    const result = pruneTerminal(input, NOW);

    expect(Object.keys(result.pullRequests)).toEqual(["octo/repo#1"]);
  });

  it("never prunes an open entry however old", () => {
    const input = snapshot({ "octo/repo#1": record({ state: "OPEN", updatedAt: daysAgo(500) }) });

    const result = pruneTerminal(input, NOW);

    expect(Object.keys(result.pullRequests)).toEqual(["octo/repo#1"]);
  });

  it("honours a pruneDays override", () => {
    const input = snapshot({ "octo/repo#1": record({ state: "CLOSED", updatedAt: daysAgo(10) }) });

    expect(pruneTerminal(input, NOW, 5).pullRequests).toEqual({});
  });
});
