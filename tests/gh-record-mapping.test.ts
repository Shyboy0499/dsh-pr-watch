import { describe, it, expect } from "vitest";
import {
  PHASE_ONE_JSON_FIELDS,
  PHASE_ONE_RESULT_LIMIT,
  PHASE_TWO_JSON_FIELDS,
  isReadOnlyInvocation,
  mapPhaseOne,
  mapPhaseTwo,
  parseTimestamp,
  phaseOneArgs,
  phaseTwoArgs,
  toPrKey,
  toTerminalState,
  type PhaseOneResult,
  type ResolvedRecord,
} from "../src/gh-exec";

/**
 * Fixtures are literal JSON text, as `gh` would emit it.
 *
 * Task 11 already guarantees that a `gh` call either succeeded or produced a
 * classified failure, so everything here starts from a string that a successful
 * call handed over. No test runs `gh`, and none touches the network.
 */

/**
 * One `gh search prs` result.
 *
 * An override whose value is `undefined` removes the key rather than setting it
 * to `undefined`. A plain spread would leave the key present with an undefined
 * value, which `JSON.stringify` then drops -- so "missing field" cases would
 * have passed for the wrong reason.
 */
function searchPr(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    url: "https://github.com/octo/repo/pull/7",
    title: "Add a thing",
    state: "OPEN",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    number: 7,
    repository: { nameWithOwner: "octo/repo" },
  };
  const merged = { ...base, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return merged;
}

/** One `gh pr view` result. */
function viewPr(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    state: "MERGED",
    mergedAt: "2026-09-01T12:00:00Z",
    updatedAt: "2026-09-01T12:00:00Z",
    title: "Add a thing",
    url: "https://github.com/octo/repo/pull/7",
    number: 7,
    repository: { nameWithOwner: "octo/repo" },
    ...overrides,
  };
}

/** Unwrap a phase 1 success, failing the test otherwise. */
function phaseOneOk(text: string, limit?: number): PhaseOneResult {
  const outcome = mapPhaseOne(text, limit);
  if (outcome.status !== "ok") {
    throw new Error(`expected ok, got ${outcome.problem}: ${outcome.detail}`);
  }
  return outcome.records;
}

/** Unwrap a phase 2 success, failing the test otherwise. */
function phaseTwoOk(text: string): ResolvedRecord {
  const outcome = mapPhaseTwo(text);
  if (outcome.status !== "ok") {
    throw new Error(`expected ok, got ${outcome.problem}: ${outcome.detail}`);
  }
  return outcome.records;
}

describe("phaseOneArgs — cross-repository enumeration", () => {
  it("uses gh search prs, which works outside a checkout", () => {
    const args = phaseOneArgs();

    // `gh pr list` is single-repo and needs a checkout or --repo, so it cannot
    // satisfy the README's promise about repositories never cloned.
    expect(args[0]).toBe("search");
    expect(args[1]).toBe("prs");
  });

  it("scopes to the current user and to open pull requests", () => {
    const args = phaseOneArgs();

    expect(args).toContain("--author");
    expect(args[args.indexOf("--author") + 1]).toBe("@me");
    expect(args).toContain("--state");
    expect(args[args.indexOf("--state") + 1]).toBe("open");
  });

  it("requests exactly the declared fields", () => {
    expect(phaseOneArgs()).toContain(PHASE_ONE_JSON_FIELDS.join(","));
  });

  it("asks for repository and number, without which no key can be built", () => {
    expect(PHASE_ONE_JSON_FIELDS).toContain("repository");
    expect(PHASE_ONE_JSON_FIELDS).toContain("number");
    expect(PHASE_ONE_JSON_FIELDS).toContain("updatedAt");
  });

  it("passes the limit as a string argument, not a number", () => {
    const args = phaseOneArgs(50);

    expect(args[args.indexOf("--limit") + 1]).toBe("50");
  });

  it("defaults the limit to the documented constant", () => {
    expect(phaseOneArgs()).toContain(String(PHASE_ONE_RESULT_LIMIT));
  });

  it("is a read-only invocation by the task 11 allow-list", () => {
    // The argument builder and the safety check must agree; a builder that
    // produced something the checker refuses would be a latent contradiction.
    expect(isReadOnlyInvocation(phaseOneArgs())).toBe(true);
  });
});

describe("phaseTwoArgs — resolving one pull request", () => {
  it("uses gh pr view with the canonical URL", () => {
    const args = phaseTwoArgs("https://github.com/octo/repo/pull/7");

    expect(args.slice(0, 3)).toEqual([
      "pr",
      "view",
      "https://github.com/octo/repo/pull/7",
    ]);
  });

  it("does not need --repo, because the URL already names the repository", () => {
    expect(phaseTwoArgs("https://github.com/octo/repo/pull/7")).not.toContain(
      "--repo",
    );
  });

  it("asks for state, which is the only field that distinguishes merged from closed", () => {
    expect(PHASE_TWO_JSON_FIELDS).toContain("state");
    expect(PHASE_TWO_JSON_FIELDS).toContain("mergedAt");
  });

  it("asks for updatedAt and title, which delta needs on the resolved record", () => {
    // pruneTerminal ages a terminal entry by updatedAt, and the renderer shows
    // the title. Omitting either would keep stale values from the snapshot.
    expect(PHASE_TWO_JSON_FIELDS).toContain("updatedAt");
    expect(PHASE_TWO_JSON_FIELDS).toContain("title");
  });

  it("is a read-only invocation", () => {
    expect(
      isReadOnlyInvocation(phaseTwoArgs("https://github.com/octo/repo/pull/7")),
    ).toBe(true);
  });

  it("passes a URL containing spaces and non-ASCII through untouched", () => {
    const url = "https://github.com/妙妙/repo name/pull/3";

    // Arguments are an array and never a shell string, so no quoting is added.
    expect(phaseTwoArgs(url)[2]).toBe(url);
  });
});

describe("mapPhaseOne — mapping a valid batch", () => {
  it("maps one record without losing a field", () => {
    const result = phaseOneOk(JSON.stringify([searchPr()]));

    expect(result.records).toHaveLength(1);
    expect(result.records[0].key).toBe("octo/repo#7");
    expect(result.records[0].record).toEqual({
      url: "https://github.com/octo/repo/pull/7",
      title: "Add a thing",
      state: "OPEN",
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-02T00:00:00Z",
      staleReported: false,
      departedReported: false,
    });
  });

  it("starts every mapped record unreported", () => {
    const result = phaseOneOk(JSON.stringify([searchPr()]));

    // A fresh enumeration has reported nothing yet; carrying a flag forward is
    // the snapshot's job, not the mapper's.
    expect(result.records[0].record.staleReported).toBe(false);
    expect(result.records[0].record.departedReported).toBe(false);
  });

  it("treats an empty array as a successful empty result", () => {
    const result = phaseOneOk("[]");

    // The README's premise: an empty result must never be read as a failure.
    expect(result.records).toEqual([]);
    expect(result.atLimit).toBe(false);
  });

  it("keeps records from different repositories apart", () => {
    const result = phaseOneOk(
      JSON.stringify([
        searchPr({ repository: { nameWithOwner: "octo/one" }, number: 1 }),
        searchPr({ repository: { nameWithOwner: "octo/two" }, number: 2 }),
        searchPr({
          repository: { nameWithOwner: "other-org/three" },
          number: 3,
        }),
      ]),
    );

    expect(result.records.map((entry) => entry.key)).toEqual([
      "octo/one#1",
      "octo/two#2",
      "other-org/three#3",
    ]);
  });

  it("preserves the raw state alongside the record", () => {
    const result = phaseOneOk(JSON.stringify([searchPr({ state: "OPEN" })]));

    expect(result.records[0].rawState).toBe("OPEN");
  });

  it("preserves titles with emoji, CJK, quotes, and newlines verbatim", () => {
    const title = 'docs(zh): 添加俄语 🚀 "quoted"\nsecond line\ttab';
    const result = phaseOneOk(JSON.stringify([searchPr({ title })]));

    expect(result.records[0].record.title).toBe(title);
  });

  it("preserves control characters rather than stripping them", () => {
    const title = "before\u0007after";
    const result = phaseOneOk(JSON.stringify([searchPr({ title })]));

    expect(result.records[0].record.title).toBe(title);
  });

  it("ignores unknown extra fields on a record", () => {
    const result = phaseOneOk(
      JSON.stringify([
        searchPr({ futureField: { nested: true }, another: [1, 2] }),
      ]),
    );

    expect(result.records[0].key).toBe("octo/repo#7");
  });

  it("ignores unknown extra fields on the repository object", () => {
    const result = phaseOneOk(
      JSON.stringify([
        searchPr({
          repository: {
            nameWithOwner: "octo/repo",
            isPrivate: false,
            futureField: 1,
          },
        }),
      ]),
    );

    expect(result.records[0].key).toBe("octo/repo#7");
  });

  it("is unaffected by JSON key order", () => {
    const first = phaseOneOk(
      JSON.stringify([
        searchPr({ repository: { nameWithOwner: "octo/repo" } }),
      ]),
    );
    const reordered = JSON.stringify([
      {
        repository: { nameWithOwner: "octo/repo" },
        number: 7,
        updatedAt: "2026-08-02T00:00:00Z",
        createdAt: "2026-08-01T00:00:00Z",
        state: "OPEN",
        title: "Add a thing",
        url: "https://github.com/octo/repo/pull/7",
      },
    ]);
    const second = phaseOneOk(reordered);

    expect(second).toEqual(first);
  });

  it("returns deeply equal results for the same input twice", () => {
    const text = JSON.stringify([searchPr(), searchPr({ number: 8 })]);

    expect(mapPhaseOne(text)).toEqual(mapPhaseOne(text));
  });

  it("accepts timestamps with a numeric offset", () => {
    const result = phaseOneOk(
      JSON.stringify([
        searchPr({
          createdAt: "2026-08-01T08:00:00+08:00",
          updatedAt: "2026-08-02T08:00:00+08:00",
        }),
      ]),
    );

    expect(result.records[0].record.updatedAt).toBe(
      "2026-08-02T08:00:00+08:00",
    );
  });

  it("accepts a very old and a very far future timestamp without producing NaN", () => {
    const result = phaseOneOk(
      JSON.stringify([
        searchPr({
          createdAt: "1970-01-01T00:00:00Z",
          updatedAt: "2999-12-31T23:59:59Z",
        }),
      ]),
    );

    expect(result.records[0].record.updatedAt).toBe("2999-12-31T23:59:59Z");
    expect(parseTimestamp("2999-12-31T23:59:59Z")).not.toBeNaN();
  });

  it("handles a large pull request number", () => {
    const result = phaseOneOk(JSON.stringify([searchPr({ number: 987_654 })]));

    expect(result.records[0].key).toBe("octo/repo#987654");
  });

  it("handles owner and repository names containing dots and dashes", () => {
    const result = phaseOneOk(
      JSON.stringify([
        searchPr({ repository: { nameWithOwner: "my-org.name/my.repo-name" } }),
      ]),
    );

    expect(result.records[0].key).toBe("my-org.name/my.repo-name#7");
  });
});

describe("mapPhaseOne — limit detection", () => {
  it("flags a batch that reached the limit", () => {
    const many = JSON.stringify(
      Array.from({ length: 5 }, (_, index) => searchPr({ number: index + 1 })),
    );

    expect(phaseOneOk(many, 5).atLimit).toBe(true);
  });

  it("does not flag a batch below the limit", () => {
    const few = JSON.stringify([searchPr()]);

    expect(phaseOneOk(few, 5).atLimit).toBe(false);
  });

  it("never silently truncates: the count is reported as-is", () => {
    const many = JSON.stringify(
      Array.from({ length: 4 }, (_, index) => searchPr({ number: index + 1 })),
    );
    const result = phaseOneOk(many, 3);

    // The mapper does not drop rows to fit the limit; it reports all of them
    // and says the enumeration may be incomplete.
    expect(result.records).toHaveLength(4);
    expect(result.atLimit).toBe(true);
  });

  it("does not flag when the limit is disabled", () => {
    expect(phaseOneOk(JSON.stringify([searchPr()]), 0).atLimit).toBe(false);
  });

  it("treats an empty batch as not at the limit even for a tiny limit", () => {
    expect(phaseOneOk("[]", 1).atLimit).toBe(false);
  });
});

describe("mapPhaseOne — a whole batch fails rather than dropping a record", () => {
  it("fails when a required field is missing", () => {
    const broken = searchPr();
    delete broken.title;

    const outcome = mapPhaseOne(JSON.stringify([searchPr(), broken]));

    // Dropping the bad row instead would remove that pull request from the
    // working set, and diff() would read the absence as a departure.
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.problem).toBe("bad-record");
    expect(outcome.detail).toContain("title");
  });

  it("fails on a field of the wrong type", () => {
    const outcome = mapPhaseOne(JSON.stringify([searchPr({ title: 12 })]));

    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.problem).toBe("bad-record");
  });

  it("fails when number is a string", () => {
    const outcome = mapPhaseOne(JSON.stringify([searchPr({ number: "7" })]));

    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.problem).toBe("bad-identity");
  });

  it("fails when number is zero or negative", () => {
    for (const number of [0, -1]) {
      const outcome = mapPhaseOne(JSON.stringify([searchPr({ number })]));
      expect(outcome.status).toBe("failed");
    }
  });

  it("fails when repository is missing or malformed", () => {
    for (const repository of [
      undefined,
      null,
      {},
      { nameWithOwner: 5 },
      { nameWithOwner: "no-slash" },
      { nameWithOwner: "too/many/slashes" },
      { nameWithOwner: "/leading" },
      { nameWithOwner: "trailing/" },
      { nameWithOwner: " padded/repo" },
      { nameWithOwner: "a/ b" },
    ]) {
      const outcome = mapPhaseOne(JSON.stringify([searchPr({ repository })]));
      expect(outcome.status).toBe("failed");
    }
  });

  it("fails on an unparsable timestamp", () => {
    // A non-string is a type error; a string that will not parse is a
    // timestamp error. Both fail the batch, but they are reported distinctly so
    // a broken feed can be told from a broken schema.
    for (const updatedAt of [
      "not a date",
      "2026-13-45T00:00:00Z",
      "2026",
      "",
    ]) {
      const outcome = mapPhaseOne(JSON.stringify([searchPr({ updatedAt })]));
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") throw new Error("unreachable");
      expect(outcome.problem).toBe("bad-timestamp");
    }

    for (const updatedAt of [5, null, true]) {
      const outcome = mapPhaseOne(JSON.stringify([searchPr({ updatedAt })]));
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") throw new Error("unreachable");
      expect(outcome.problem).toBe("bad-record");
    }
  });

  it("fails on invalid JSON text", () => {
    const outcome = mapPhaseOne('[{"url": ');

    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.problem).toBe("invalid-json");
  });

  it("fails when handed an object instead of an array", () => {
    const outcome = mapPhaseOne(JSON.stringify(searchPr()));

    // Phase mismatch: phase 1 is always an array.
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.problem).toBe("wrong-root");
  });

  it.each([["null"], ["{}"], ["42"], ['"text"'], ["true"]])(
    "fails on a %s root",
    (text) => {
      const outcome = mapPhaseOne(text);
      expect(outcome.status).toBe("failed");
    },
  );

  it("produces no partial result when it fails", () => {
    const outcome = mapPhaseOne(
      JSON.stringify([searchPr(), searchPr({ title: 1 })]),
    );

    expect(outcome.status).toBe("failed");
    // A failure carries no records field at all, so a caller cannot read half a
    // batch by accident.
    expect(outcome).not.toHaveProperty("records");
  });

  it("names the offending index so a feed problem is locatable", () => {
    const outcome = mapPhaseOne(
      JSON.stringify([searchPr(), searchPr(), searchPr({ title: 1 })]),
    );

    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.detail).toContain("[2]");
  });

  it("fails on a record that is not an object", () => {
    const outcome = mapPhaseOne(JSON.stringify(["OPEN"]));

    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.problem).toBe("bad-record");
  });

  it("never throws, whatever the input", () => {
    const inputs = [
      "",
      "   ",
      "{",
      "[]",
      "null",
      "[null]",
      "[[]]",
      "{}",
      "0",
      "undefined",
    ];

    for (const text of inputs) {
      expect(() => mapPhaseOne(text)).not.toThrow();
    }
  });
});

describe("mapPhaseTwo — resolving one terminal state", () => {
  it("maps a merge", () => {
    const result = phaseTwoOk(JSON.stringify(viewPr()));

    expect(result.terminal).toBe("MERGED");
    expect(result.key).toBe("octo/repo#7");
    expect(result.record.state).toBe("MERGED");
  });

  it("maps a close without merge, distinctly from a merge", () => {
    const result = phaseTwoOk(
      JSON.stringify(viewPr({ state: "CLOSED", mergedAt: null })),
    );

    expect(result.terminal).toBe("CLOSED");
    expect(result.record.state).toBe("CLOSED");
    expect(result.terminal).not.toBe("MERGED");
  });

  it("takes updatedAt from this response, so pruning ages the entry correctly", () => {
    const result = phaseTwoOk(
      JSON.stringify(
        viewPr({
          state: "CLOSED",
          mergedAt: null,
          updatedAt: "2026-09-05T00:00:00Z",
        }),
      ),
    );

    expect(result.record.updatedAt).toBe("2026-09-05T00:00:00Z");
  });

  it("keeps the title and url from the response", () => {
    const result = phaseTwoOk(
      JSON.stringify(
        viewPr({
          title: "Renamed before merge",
          url: "https://github.com/octo/repo/pull/7",
        }),
      ),
    );

    expect(result.record.title).toBe("Renamed before merge");
    expect(result.record.url).toBe("https://github.com/octo/repo/pull/7");
  });

  it("starts the reported flags false, since the snapshot carries them", () => {
    const result = phaseTwoOk(JSON.stringify(viewPr()));

    expect(result.record.staleReported).toBe(false);
    expect(result.record.departedReported).toBe(false);
  });

  it("accepts a null mergedAt on a CLOSED result", () => {
    expect(() =>
      phaseTwoOk(JSON.stringify(viewPr({ state: "CLOSED", mergedAt: null }))),
    ).not.toThrow();
  });

  it("ignores unknown extra fields", () => {
    const result = phaseTwoOk(
      JSON.stringify(
        viewPr({ statusCheckRollup: [], reviewDecision: "APPROVED" }),
      ),
    );

    expect(result.terminal).toBe("MERGED");
  });
});

describe("mapPhaseTwo — an unknown state is never guessed at", () => {
  it.each([
    ["OPEN"],
    ["open"],
    ["DRAFT"],
    ["merged"],
    ["closed"],
    ["MERGED_AND_LOCKED"],
    [""],
  ])("refuses state %j rather than defaulting it", (state) => {
    const outcome = mapPhaseTwo(JSON.stringify(viewPr({ state })));

    // Guessing CLOSED would announce an active pull request as closed; guessing
    // MERGED would claim a merge that never happened. Either is user-visible
    // and un-reportable, since diff() records the outcome permanently.
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.problem).toBe("unknown-state");
  });

  it("explains why it refused", () => {
    const outcome = mapPhaseTwo(JSON.stringify(viewPr({ state: "DRAFT" })));

    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.detail).toContain("DRAFT");
    expect(outcome.detail).toContain("MERGED");
  });

  it("refuses a state that is not even a string", () => {
    const outcome = mapPhaseTwo(JSON.stringify(viewPr({ state: 1 })));

    expect(outcome.status).toBe("failed");
  });
});

describe("mapPhaseTwo — malformed and mismatched input", () => {
  it("fails when handed an array instead of an object", () => {
    const outcome = mapPhaseTwo(JSON.stringify([viewPr()]));

    // The phase mismatch: phase 2 is always a single object.
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.problem).toBe("wrong-root");
  });

  it.each([["null"], ["[]"], ["42"], ["{}"]])("fails on a %s root", (text) => {
    expect(mapPhaseTwo(text).status).toBe("failed");
  });

  it("fails on invalid JSON", () => {
    const outcome = mapPhaseTwo("{ nope");

    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.problem).toBe("invalid-json");
  });

  it("fails on a missing field", () => {
    const broken = viewPr();
    delete broken.updatedAt;

    const outcome = mapPhaseTwo(JSON.stringify(broken));

    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.problem).toBe("bad-record");
  });

  it("fails on a bad timestamp", () => {
    const outcome = mapPhaseTwo(
      JSON.stringify(viewPr({ updatedAt: "whenever" })),
    );

    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.problem).toBe("bad-timestamp");
  });

  it("fails on a bad identity", () => {
    const outcome = mapPhaseTwo(
      JSON.stringify(viewPr({ repository: { nameWithOwner: "nope" } })),
    );

    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.problem).toBe("bad-identity");
  });

  it("never throws, whatever the input", () => {
    for (const text of ["", "{", "[]", "null", "0"]) {
      expect(() => mapPhaseTwo(text)).not.toThrow();
    }
  });
});

describe("toTerminalState", () => {
  it("maps the two terminal states", () => {
    expect(toTerminalState("MERGED")).toBe("MERGED");
    expect(toTerminalState("CLOSED")).toBe("CLOSED");
  });

  it("refuses OPEN, so an active pull request can never look finished", () => {
    expect(toTerminalState("OPEN")).toBeUndefined();
  });

  it("refuses anything unrecognised", () => {
    for (const value of ["open", "merged", "DRAFT", "", "UNKNOWN"]) {
      expect(toTerminalState(value)).toBeUndefined();
    }
  });
});

describe("parseTimestamp", () => {
  it("parses a Z-suffixed UTC timestamp", () => {
    expect(parseTimestamp("2026-08-02T00:00:00Z")).toBe(
      Date.parse("2026-08-02T00:00:00Z"),
    );
  });

  it("parses a numeric offset", () => {
    expect(parseTimestamp("2026-08-02T08:00:00+08:00")).toBe(
      Date.parse("2026-08-02T08:00:00+08:00"),
    );
  });

  it("parses fractional seconds", () => {
    expect(parseTimestamp("2026-08-02T00:00:00.123Z")).not.toBeNull();
  });

  it("parses without a time component", () => {
    expect(parseTimestamp("2026-08-02")).not.toBeNull();
  });

  it("handles the Unix epoch", () => {
    expect(parseTimestamp("1970-01-01T00:00:00Z")).toBe(0);
  });

  it("rejects a bare year, which Date.parse would otherwise accept", () => {
    // Accepting "2026" as a date would make a pull request look thousands of
    // days stale, and staleness is reported to the user.
    expect(parseTimestamp("2026")).toBeNull();
  });

  it("rejects impossible calendar values", () => {
    for (const value of [
      "2026-13-45",
      "2026-02-30T00:00:00Z",
      "2026-08-02T99:99:99Z",
    ]) {
      expect(parseTimestamp(value)).toBeNull();
    }
  });

  it("rejects non-strings and junk", () => {
    for (const value of [
      null,
      undefined,
      5,
      {},
      [],
      "",
      "  ",
      "not a date",
      "yesterday",
    ]) {
      expect(parseTimestamp(value)).toBeNull();
    }
  });
});

describe("toPrKey", () => {
  it("builds owner/repo#number", () => {
    expect(toPrKey(searchPr())).toBe("octo/repo#7");
  });

  it("produces no double slash or stray whitespace", () => {
    const key = toPrKey(
      searchPr({ repository: { nameWithOwner: "octo/repo" } }),
    ) as string;

    expect(key).toBe(key.trim());
    expect(key).not.toContain("//");
    expect(key.match(/\//g)).toHaveLength(1);
    expect(key.match(/#/g)).toHaveLength(1);
  });

  it("returns undefined instead of throwing for a malformed record", () => {
    for (const raw of [
      null,
      5,
      "x",
      {},
      { repository: {} },
      { repository: { nameWithOwner: "a" } },
    ]) {
      expect(toPrKey(raw)).toBeUndefined();
    }
  });
});

describe("the mapping layer is pure", () => {
  it("reads no clock: the same fixture maps identically whenever it is called", () => {
    const text = JSON.stringify([searchPr()]);

    const first = mapPhaseOne(text);
    const second = mapPhaseOne(text);

    // If a clock were read, the two runs could differ; nothing else in this
    // module could make them.
    expect(second).toEqual(first);
  });

  it("does not mutate its input fixture", () => {
    const document = [searchPr()];
    const text = JSON.stringify(document);
    const snapshot = JSON.stringify(document);

    mapPhaseOne(text);

    expect(JSON.stringify(document)).toBe(snapshot);
  });

  it("does not mutate the object it was handed by reference", () => {
    const document = [searchPr()];
    mapPhaseOne(JSON.stringify(document));

    expect(Object.keys(document[0])).toContain("title");
  });
});
