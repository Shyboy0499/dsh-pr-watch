import { describe, it, expect } from "vitest";
import { relativeAge, renderWatch, type WatchValue } from "../src/tools/watch";
import type { Delta, DeltaKind } from "../src/types";

/**
 * A fixed "now". Every test passes it explicitly, so no assertion depends on
 * when the suite runs -- the whole reason the current time is a parameter.
 */
const NOW = "2026-09-10T12:00:00Z";

const MS_PER_DAY = 86_400_000;

/** An ISO timestamp `days` before NOW. */
function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * MS_PER_DAY).toISOString();
}

/** A delta of the given kind. */
function delta(kind: DeltaKind, overrides: Partial<Delta> = {}): Delta {
  return {
    kind,
    key: "octo/repo#1",
    url: "https://github.com/octo/repo/pull/1",
    title: "A pull request",
    updatedAt: daysAgo(1),
    ...overrides,
  };
}

/** A complete report input, defaulted to "nothing to report". */
function value(overrides: Partial<WatchValue> = {}): WatchValue {
  return {
    checkedAt: NOW,
    trackedCount: 0,
    deltas: [],
    warning: null,
    open: [],
    ...overrides,
  };
}

describe("renderWatch — the README's documented example", () => {
  it("reproduces the published output exactly", () => {
    // The README's `Usage` block. It shows three of the five groups, which is
    // what a real report of this shape produces: `closed` and `unresolved` are
    // simply absent. Asserting the whole string is what makes this a check on
    // the documented format rather than on individual lines.
    const report = renderWatch(
      value({
        trackedCount: 4,
        deltas: [
          delta("merged", {
            key: "octo/repo#41",
            title: "Add Russian locale",
            updatedAt: daysAgo(1),
          }),
          delta("merged", {
            key: "octo/repo#38",
            title: "Fix broken link",
            updatedAt: daysAgo(3),
          }),
          delta("stale", {
            key: "octo/repo#29",
            title: "docs: clarify install steps",
            updatedAt: daysAgo(21),
          }),
          delta("new", {
            key: "octo/repo#44",
            title: "Add MCP server entry",
            updatedAt: daysAgo(0),
          }),
        ],
      }),
      false,
    );

    const expected = [
      "✅ Merged (2):",
      "  octo/repo#41 — Add Russian locale (last activity 1 day ago)",
      "  octo/repo#38 — Fix broken link (last activity 3 days ago)",
      "",
      "⏳ Became stale (1):",
      "  octo/repo#29 — docs: clarify install steps (last activity 21 days ago)",
      "",
      "🆕 Newly noticed (1):",
      "  octo/repo#44 — Add MCP server entry (last activity today)",
    ].join("\n");

    expect(report).toBe(expected);
  });

  it("uses an em dash and the documented emoji, not ASCII substitutes", () => {
    const report = renderWatch(
      value({
        trackedCount: 1,
        deltas: [delta("merged", { key: "octo/repo#1" })],
      }),
      false,
    );

    // U+2014 between key and title, and the group glyphs verbatim. Downgrading
    // these would put the output at odds with the README's own example.
    expect(report).toContain("\u2014");
    expect(report).toContain("\u2705");
    expect(report).not.toContain(" - ");
  });
});

describe("relativeAge — boundary definitions", () => {
  it("calls a just-now timestamp today", () => {
    expect(relativeAge(NOW, NOW)).toBe("today");
  });

  it("calls less than a full day today", () => {
    const almostADay = new Date(
      Date.parse(NOW) - (MS_PER_DAY - 1000),
    ).toISOString();

    expect(relativeAge(almostADay, NOW)).toBe("today");
  });

  it("calls exactly one day '1 day ago'", () => {
    // The boundary is inclusive of the whole day: 1.0 days reads as 1, not 0.
    expect(relativeAge(daysAgo(1), NOW)).toBe("1 day ago");
  });

  it("calls just under two days '1 day ago'", () => {
    const nearlyTwo = new Date(
      Date.parse(NOW) - (2 * MS_PER_DAY - 1000),
    ).toISOString();

    expect(relativeAge(nearlyTwo, NOW)).toBe("1 day ago");
  });

  it("calls two days '2 days ago'", () => {
    expect(relativeAge(daysAgo(2), NOW)).toBe("2 days ago");
  });

  it("uses days for large ages rather than switching units", () => {
    // The README's own example says "21 days ago", so a unit switch would
    // contradict the output this task is verified against.
    expect(relativeAge(daysAgo(21), NOW)).toBe("21 days ago");
    expect(relativeAge(daysAgo(365), NOW)).toBe("365 days ago");
    expect(relativeAge(daysAgo(3000), NOW)).toBe("3000 days ago");
  });

  it("never shows a negative age for a future timestamp", () => {
    // A backwards clock or a bad payload would otherwise print "-3 days ago",
    // which reads as a bug in the tool rather than as the anomaly it is.
    expect(relativeAge(daysAgo(-3), NOW)).toBe("today");
    expect(relativeAge(daysAgo(-400), NOW)).toBe("today");
  });

  it("says unknown for an unparsable timestamp instead of inventing a number", () => {
    expect(relativeAge("not a date", NOW)).toBe("unknown");
    expect(relativeAge("", NOW)).toBe("unknown");
  });

  it("says unknown when the reference time itself is unusable", () => {
    expect(relativeAge(daysAgo(1), "nonsense")).toBe("unknown");
  });

  it("does not overflow on an extreme age", () => {
    const older = relativeAge("1970-01-01T00:00:00Z", NOW);

    expect(older).not.toContain("NaN");
    expect(older).toMatch(/^\d+ days ago$/);
  });
});

describe("renderWatch — group order and the closed/merged distinction", () => {
  it("puts closed without merge in its own group, never inside Merged", () => {
    const report = renderWatch(
      value({
        trackedCount: 2,
        deltas: [
          delta("merged", { key: "octo/repo#1", title: "Landed" }),
          delta("closed", { key: "octo/repo#2", title: "Rejected" }),
        ],
      }),
      false,
    );

    // "Distinguished from a merge, not lumped in with it".
    expect(report).toContain("✅ Merged (1):");
    expect(report).toContain("⛔ Closed without merge (1):");
    expect(report).toContain("Rejected");
    expect(report).not.toContain("✅ Merged (2):");
  });

  it("orders groups as merged, closed, unresolved, stale, new", () => {
    const report = renderWatch(
      value({
        deltas: (
          ["new", "stale", "unresolved", "closed", "merged"] as DeltaKind[]
        ).map((kind) => delta(kind, { key: `octo/repo#${kind}` })),
      }),
      false,
    );

    const positions = [
      "Merged",
      "Closed without merge",
      "Could not resolve",
      "Became stale",
      "Newly noticed",
    ].map((heading) => report.indexOf(heading));

    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeGreaterThan(positions[index - 1]);
    }
  });

  it("omits groups that have no entries", () => {
    const report = renderWatch(
      value({ trackedCount: 1, deltas: [delta("merged")] }),
      false,
    );

    expect(report).toContain("Merged (1):");
    expect(report).not.toContain("Became stale");
    expect(report).not.toContain("Closed without merge");
  });

  it("shows a count of 1 for a single entry", () => {
    expect(renderWatch(value({ deltas: [delta("stale")] }), false)).toContain(
      "Became stale (1):",
    );
  });
});

describe("renderWatch — deterministic order", () => {
  it("renders identically twice for the same input", () => {
    const input = value({
      trackedCount: 3,
      deltas: [
        delta("merged", { key: "b/two#2" }),
        delta("stale", { key: "a/one#1" }),
        delta("merged", { key: "a/one#9" }),
      ],
    });

    expect(renderWatch(input, false)).toBe(renderWatch(input, false));
  });

  it("does not depend on the order the deltas arrive in", () => {
    const shuffled = [
      delta("stale", { key: "a/one#1" }),
      delta("merged", { key: "b/two#2" }),
      delta("merged", { key: "a/one#9" }),
    ];

    const forwards = renderWatch(value({ deltas: shuffled }), false);
    const backwards = renderWatch(
      value({ deltas: [...shuffled].reverse() }),
      false,
    );

    expect(backwards).toBe(forwards);
  });

  it("does not mutate the array it was given", () => {
    const deltas = [
      delta("new", { key: "z/last#1" }),
      delta("merged", { key: "a/first#1" }),
    ];
    const snapshot = deltas.map((entry) => entry.key);

    renderWatch(value({ deltas }), false);

    // Sorting in place would corrupt a caller's fixture, and a second render
    // would then see different input than the first.
    expect(deltas.map((entry) => entry.key)).toEqual(snapshot);
  });

  it("orders by most recent activity within a group, as the README example does", () => {
    const report = renderWatch(
      value({
        deltas: [
          delta("merged", {
            key: "octo/repo#41",
            title: "Newer",
            updatedAt: daysAgo(1),
          }),
          delta("merged", {
            key: "octo/repo#38",
            title: "Older",
            updatedAt: daysAgo(3),
          }),
        ],
      }),
      false,
    );

    // The README's Usage block puts #41 (1 day ago) above #38 (3 days ago), so
    // the order on display is recency, not number.
    expect(report.indexOf("octo/repo#41")).toBeLessThan(
      report.indexOf("octo/repo#38"),
    );
  });

  it("breaks a repeated timestamp by key so the order stays total", () => {
    const report = renderWatch(
      value({
        deltas: [
          delta("merged", { key: "z/repo#9", updatedAt: daysAgo(4) }),
          delta("merged", { key: "a/repo#1", updatedAt: daysAgo(4) }),
        ],
      }),
      false,
    );

    expect(report.indexOf("a/repo#1")).toBeLessThan(report.indexOf("z/repo#9"));
  });
});

describe("renderWatch — nothing to report", () => {
  it("says changes are absent but the check ran, when pull requests are tracked", () => {
    const report = renderWatch(value({ trackedCount: 3 }), false);

    expect(report).toContain("No changes since the last check.");
    expect(report).toContain("3 open pull requests tracked.");
  });

  it("uses the singular for one tracked pull request", () => {
    expect(renderWatch(value({ trackedCount: 1 }), false)).toContain(
      "1 open pull request tracked.",
    );
  });

  it("reads differently when nothing is tracked at all", () => {
    const report = renderWatch(value({ trackedCount: 0 }), false);

    // A first run with nothing found must not read like a successful quiet
    // check, or the user cannot tell "no changes" from "the tool is broken".
    expect(report).toContain("No pull requests are being tracked yet");
    expect(report).not.toContain("No changes since the last check");
  });

  it("contains no group heading when there is nothing to report", () => {
    const report = renderWatch(value({ trackedCount: 2 }), false);

    expect(report).not.toContain("Merged");
    expect(report).not.toContain("Became stale");
    expect(report).not.toContain("Newly noticed");
  });
});

describe("renderWatch — unresolved is shown and never reads as silence", () => {
  it("exposes unresolved entries under their own heading", () => {
    const report = renderWatch(
      value({
        trackedCount: 2,
        deltas: [
          delta("unresolved", { key: "octo/repo#3", title: "Needs a verdict" }),
        ],
      }),
      false,
    );

    expect(report).toContain("❓ Could not resolve (1):");
    expect(report).toContain("octo/repo#3");
    expect(report).toContain("Needs a verdict");
  });

  it("explains that the query failed rather than that nothing happened", () => {
    const report = renderWatch(value({ deltas: [delta("unresolved")] }), false);

    expect(report).toContain("could not be resolved");
    expect(report).toContain("query failure");
    expect(report).toContain("not a lack of activity");
    expect(report).toContain("next check will retry");
  });

  it("never presents unresolved as an absence of changes", () => {
    const report = renderWatch(value({ deltas: [delta("unresolved")] }), false);

    expect(report).not.toContain("No changes since the last check");
  });

  it("pluralises the note for several unresolved entries", () => {
    const report = renderWatch(
      value({
        deltas: [
          delta("unresolved", { key: "a/a#1" }),
          delta("unresolved", { key: "b/b#2" }),
        ],
      }),
      false,
    );

    expect(report).toContain("2 pull requests could not be resolved");
  });

  it("shows unresolved in all mode too, since they are not confirmed open", () => {
    const report = renderWatch(
      value({
        trackedCount: 1,
        open: [
          {
            key: "a/a#1",
            title: "Still open",
            updatedAt: daysAgo(2),
            url: "u",
          },
        ],
        deltas: [delta("unresolved", { key: "b/b#2" })],
      }),
      true,
    );

    expect(report).toContain("Open pull requests (1)");
    expect(report).toContain("could not be resolved");
  });
});

describe("renderWatch — the warning comes first", () => {
  it("leads with the quarantine notice", () => {
    const warning =
      "Snapshot was unreadable and has been moved to snapshot.json.corrupt-1.";
    const report = renderWatch(value({ trackedCount: 1, warning }), false);

    // The README requires the tool to say when a snapshot was quarantined, and
    // a notice buried under a list would be missed.
    expect(report.startsWith("⚠️")).toBe(true);
    expect(report).toContain(warning);
  });

  it("separates the warning from the report body", () => {
    const report = renderWatch(
      value({
        trackedCount: 1,
        warning: "Quarantined.",
        deltas: [delta("merged")],
      }),
      false,
    );

    expect(report.split("\n")[1]).toBe("");
  });

  it("shows the warning in all mode as well", () => {
    const report = renderWatch(
      value({ warning: "Quarantined.", open: [] }),
      true,
    );

    expect(report.startsWith("⚠️")).toBe(true);
  });

  it("adds no notice when there is no warning", () => {
    expect(renderWatch(value({ trackedCount: 1 }), false)).not.toContain("⚠️");
  });
});

describe("renderWatch — all mode lists every open pull request", () => {
  it("lists the open set rather than the changes", () => {
    const report = renderWatch(
      value({
        trackedCount: 2,
        deltas: [delta("merged", { key: "octo/repo#99", title: "Merged one" })],
        open: [
          {
            key: "octo/repo#1",
            title: "First",
            updatedAt: daysAgo(2),
            url: "u1",
          },
          {
            key: "octo/repo#2",
            title: "Second",
            updatedAt: daysAgo(5),
            url: "u2",
          },
        ],
      }),
      true,
    );

    expect(report).toContain(
      "Open pull requests (2), checked 2026-09-10T12:00:00Z:",
    );
    expect(report).toContain("octo/repo#1 — First (last activity 2 days ago)");
    expect(report).toContain("octo/repo#2 — Second (last activity 5 days ago)");
    // The delta list is not what `all` mode is for.
    expect(report).not.toContain("Merged one");
  });

  it("stays a full listing even when nothing changed", () => {
    const report = renderWatch(
      value({
        trackedCount: 1,
        deltas: [],
        open: [
          {
            key: "octo/repo#1",
            title: "First",
            updatedAt: daysAgo(1),
            url: "u",
          },
        ],
      }),
      true,
    );

    // `all` with an empty delta set must not collapse into the empty-reason
    // message; the user asked for the state, and there is state to show.
    expect(report).toContain("Open pull requests (1)");
    expect(report).not.toContain("No changes since the last check");
  });

  it("says (none) rather than nothing when the open set is empty", () => {
    const report = renderWatch(value({ trackedCount: 0, open: [] }), true);

    expect(report).toContain("(none)");
  });

  it("heads the listing with the number actually listed", () => {
    const report = renderWatch(
      value({
        // Deliberately inconsistent: the header must describe the entries shown,
        // not a count that contradicts them.
        trackedCount: 99,
        open: [
          {
            key: "octo/repo#1",
            title: "First",
            updatedAt: daysAgo(1),
            url: "u",
          },
        ],
      }),
      true,
    );

    expect(report).toContain("Open pull requests (1),");
  });

  it("reports the checked time so the listing is anchored", () => {
    expect(renderWatch(value({ open: [] }), true)).toContain(NOW);
  });
});

describe("renderWatch — awkward input does not break the layout", () => {
  it("collapses a newline in a title onto one line", () => {
    const report = renderWatch(
      value({ deltas: [delta("merged", { title: "first\nsecond" })] }),
      false,
    );

    // The line format carries the meaning; a raw newline would split one entry
    // into two and make the second look like a separate pull request.
    expect(report).toContain("— first second (last activity");
    expect(report.split("\n")).toHaveLength(2);
  });

  it("collapses tabs and repeated whitespace without dropping text", () => {
    const report = renderWatch(
      value({ deltas: [delta("merged", { title: "a\t\tb   c" })] }),
      false,
    );

    expect(report).toContain("— a b c (last activity");
  });

  it("preserves emoji, CJK, and quotes in a title", () => {
    const title = 'docs(zh): 添加俄语 🚀 "quoted" 引号';
    const report = renderWatch(
      value({ deltas: [delta("merged", { title })] }),
      false,
    );

    expect(report).toContain(title);
  });

  it("does not truncate a long title", () => {
    const title = "x".repeat(500);
    const report = renderWatch(
      value({ deltas: [delta("merged", { title })] }),
      false,
    );

    expect(report).toContain(title);
  });

  it("renders each key verbatim, including the owner segment", () => {
    const report = renderWatch(
      value({
        deltas: [delta("merged", { key: "owner-name/repo.name#12345" })],
      }),
      false,
    );

    expect(report).toContain("owner-name/repo.name#12345 —");
    expect(report).not.toContain("undefined");
  });

  it("produces a plain string with no BOM and no ANSI escape", () => {
    const report = renderWatch(
      value({ trackedCount: 1, deltas: [delta("merged")] }),
      false,
    );

    expect(report.charCodeAt(0)).not.toBe(0xfe_ff);
    // No colour: the README's example is plain text. The escape byte is built
    // rather than embedded, so this file carries no control characters.
    const escape = String.fromCharCode(27);
    expect(report.includes(`${escape}[`)).toBe(false);
  });

  it("does not end with a trailing blank line", () => {
    const report = renderWatch(
      value({ trackedCount: 1, deltas: [delta("merged")] }),
      false,
    );

    expect(report.endsWith("\n")).toBe(false);
    expect(report).toBe(report.trimEnd());
  });

  it("round-trips through UTF-8 unchanged", () => {
    const report = renderWatch(
      value({ deltas: [delta("merged", { title: "添加 🚀 — done" })] }),
      false,
    );

    expect(Buffer.from(report, "utf8").toString("utf8")).toBe(report);
  });
});
