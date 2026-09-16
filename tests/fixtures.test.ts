import { describe, it, expect } from "vitest";
import { NOW, daysAgo, record, snapshot } from "./fixtures";

describe("fixtures", () => {
  it("pins a fixed clock so tests never depend on wall time", () => {
    expect(NOW.toISOString()).toBe("2026-09-10T00:00:00.000Z");
  });

  it("derives ISO timestamps relative to NOW", () => {
    expect(daysAgo(30)).toBe("2026-08-11T00:00:00.000Z");
    expect(daysAgo(1)).toBe("2026-09-09T00:00:00.000Z");
    expect(daysAgo(0)).toBe(NOW.toISOString());
  });

  it("defaults a record to an open pull request of the right age", () => {
    expect(record()).toEqual({
      url: "https://github.com/octo/repo/pull/1",
      title: "A pull request",
      state: "OPEN",
      createdAt: daysAgo(30),
      updatedAt: daysAgo(1),
      staleReported: false,
      departedReported: false,
    });
  });

  it("applies overrides without disturbing other fields", () => {
    const merged = record({ state: "MERGED", staleReported: true });
    expect(merged.state).toBe("MERGED");
    expect(merged.staleReported).toBe(true);
    expect(merged.title).toBe("A pull request");
  });

  it("builds a snapshot at the current schema version", () => {
    const populated = snapshot({ "octo/repo#1": record() });
    expect(populated.version).toBe(1);
    expect(populated.lastCheck).toBe(daysAgo(1));
    expect(Object.keys(populated.pullRequests)).toEqual(["octo/repo#1"]);
  });
});
