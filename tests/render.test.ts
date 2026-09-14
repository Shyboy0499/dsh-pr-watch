import { describe, it, expect } from "vitest";
import { renderWatch, type WatchValue } from "../src/tools/watch";

function value(overrides: Partial<WatchValue> = {}): WatchValue {
  return {
    checkedAt: "2026-09-10T00:00:00Z",
    openCount: 0,
    deltas: [],
    warning: null,
    open: [],
    ...overrides,
  };
}

const merged = {
  kind: "merged" as const,
  key: "octo/repo#1",
  url: "https://github.com/octo/repo/pull/1",
  title: "Add a thing",
  updatedAt: "2026-09-09T00:00:00Z",
};

describe("renderWatch", () => {
  it("says so when nothing changed", () => {
    expect(renderWatch(value({ openCount: 3 }), false)).toContain(
      "No changes since the last check",
    );
  });

  it("groups deltas under a labelled heading", () => {
    const text = renderWatch(value({ deltas: [merged] }), false);
    expect(text).toContain("Merged (1):");
    expect(text).toContain("octo/repo#1 — Add a thing");
    expect(text).toContain("1 day ago");
  });

  it("orders groups merged, closed, stale, unresolved, new", () => {
    const deltas = [
      { ...merged, kind: "new" as const },
      { ...merged, kind: "stale" as const },
      { ...merged, kind: "merged" as const },
    ];
    const text = renderWatch(value({ deltas }), false);
    expect(text.indexOf("Merged (1):")).toBeLessThan(
      text.indexOf("Became stale (1):"),
    );
    expect(text.indexOf("Became stale (1):")).toBeLessThan(
      text.indexOf("Newly noticed (1):"),
    );
  });

  it("surfaces the warning ahead of the deltas", () => {
    // The warning is prefixed with a marker, so it is not literally at index 0.
    // What matters is that it precedes every group of findings.
    const text = renderWatch(
      value({ warning: "Snapshot was unreadable.", deltas: [merged] }),
      false,
    );
    expect(text).toContain("Snapshot was unreadable.");
    expect(text.indexOf("Snapshot was unreadable.")).toBeLessThan(
      text.indexOf("Merged (1):"),
    );
  });

  it("lists open pull requests in all mode", () => {
    const text = renderWatch(
      value({
        openCount: 1,
        open: [
          {
            key: "octo/repo#2",
            title: "Second",
            url: "https://github.com/octo/repo/pull/2",
            updatedAt: "2026-08-01T00:00:00Z",
          },
        ],
      }),
      true,
    );
    expect(text).toContain("Open pull requests (1)");
    expect(text).toContain("octo/repo#2 — Second");
    expect(text).toContain("40 days ago");
  });

  it("says none when all mode has no open pull requests", () => {
    expect(renderWatch(value(), true)).toContain("(none)");
  });
});
