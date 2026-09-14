import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderWatch, type WatchValue } from "../src/tools/watch";

const MS_PER_DAY = 86_400_000;

/**
 * The README shows a worked example of the tool's output. That example is prose
 * in a file the renderer knows nothing about, so a change to the headings, the
 * ordering, or the age wording would quietly turn it into a lie. This pins the
 * two together: if the renderer moves, this fails and the README gets updated.
 */
describe("README example output", () => {
  it("matches what renderWatch actually produces", () => {
    const checkedAt = "2026-09-10T00:00:00Z";
    const at = (days: number) =>
      new Date(Date.parse(checkedAt) - days * MS_PER_DAY).toISOString();

    const value: WatchValue = {
      checkedAt,
      openCount: 12,
      warning: null,
      open: [],
      deltas: [
        {
          kind: "merged",
          key: "octo/repo#41",
          url: "https://github.com/octo/repo/pull/41",
          title: "Add Russian locale",
          updatedAt: at(1),
        },
        {
          kind: "merged",
          key: "octo/repo#38",
          url: "https://github.com/octo/repo/pull/38",
          title: "Fix broken link",
          updatedAt: at(3),
        },
        {
          kind: "stale",
          key: "octo/repo#29",
          url: "https://github.com/octo/repo/pull/29",
          title: "docs: clarify install steps",
          updatedAt: at(21),
        },
        {
          kind: "new",
          key: "octo/repo#44",
          url: "https://github.com/octo/repo/pull/44",
          title: "Add MCP server entry",
          updatedAt: at(0),
        },
      ],
    };

    const readme = readFileSync(
      new URL("../README.md", import.meta.url),
      "utf8",
    );

    expect(readme).toContain(renderWatch(value, false));
  });
});
