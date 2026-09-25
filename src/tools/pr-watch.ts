import { defineTool } from "@deepseek-ai/dsh-tools";
import { diff, pruneTerminal } from "../delta";
import {
  PHASE_ONE_RESULT_LIMIT,
  mapPhaseOne,
  mapPhaseTwo,
  phaseOneArgs,
  phaseTwoArgs,
  runGh,
  type GhExecutor,
} from "../gh-exec";
import {
  asQuarantinable,
  loadSnapshot,
  quarantineCorruptSnapshot,
  saveSnapshot,
  snapshotPath,
} from "../snapshot";
import {
  DEFAULT_PRUNE_DAYS,
  DEFAULT_STALE_DAYS,
  emptySnapshot,
  type PrRecord,
  type Snapshot,
  type TerminalState,
} from "../types";
import { renderWatch, type WatchOpenEntry, type WatchValue } from "./watch";

/* -------------------------------------------------------------------------
 * Task 14 — the pr_watch tool.
 *
 * The integration point. Every other module is either pure or IO with no
 * opinion; this is where the opinions live. It decides when to call `gh`, when
 * a round is trustworthy enough to record, and what the user is told.
 *
 * Two promises are kept here and nowhere else. "Reported once, then silent"
 * holds because the snapshot is the only memory and this is its only writer.
 * "A failed enumeration writes nothing" holds because a round whose one `gh
 * search` call did not succeed returns before the save, leaving the previous
 * snapshot byte for byte intact. A failure in the resolve phase is narrower than
 * that: the outcomes that *were* determined are still recorded, and the single
 * entry that could not be resolved is retried rather than marked as seen.
 * ---------------------------------------------------------------------- */

/** Largest accepted threshold, so a unit mix-up cannot silently disable alerts. */
const MAX_STALE_DAYS = 3650;

/** The decoded arguments, after defaults and validation. */
export interface WatchArgs {
  readonly staleDays: number;
  readonly all: boolean;
}

/**
 * Validate the model-supplied parameters.
 *
 * Arguments arrive from an agent, so they are untrusted input rather than a
 * typed call. A `staleDays` of `"14"` or `NaN` must not reach `delta.ts`: every
 * comparison there is numeric, and a coerced value would quietly produce
 * "nothing is ever stale" -- a plugin that appears to work and reports nothing,
 * which is the worst failure available here.
 *
 * `staleDays: 0` is refused rather than read as "everything is stale at once".
 * `delta.ts` documents that `0` legitimately means that, but the README offers
 * the parameter as "days without activity", where zero is far likelier to be a
 * mistake than an intent, and the report it produced would announce every open
 * pull request as stale simultaneously.
 */
export function validateArgs(raw: unknown): WatchArgs {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;

  let staleDays: number = DEFAULT_STALE_DAYS;
  const requested = input.staleDays;
  if (requested !== undefined) {
    if (typeof requested !== "number" || !Number.isFinite(requested)) {
      throw new Error(
        `staleDays must be a number, got ${JSON.stringify(requested)}. ` +
          `Leave it out to use the default of ${DEFAULT_STALE_DAYS}.`,
      );
    }
    if (!Number.isInteger(requested)) {
      throw new Error(
        `staleDays must be a whole number of days, got ${requested}. ` +
          `Leave it out to use the default of ${DEFAULT_STALE_DAYS}.`,
      );
    }
    if (requested < 1 || requested > MAX_STALE_DAYS) {
      throw new Error(
        `staleDays must be between 1 and ${MAX_STALE_DAYS}, got ${requested}. ` +
          "Zero would mark every open pull request stale immediately, so it is refused as a likely mistake.",
      );
    }
    staleDays = requested;
  }

  let all = false;
  const requestedAll = input.all;
  if (requestedAll !== undefined) {
    if (typeof requestedAll !== "boolean") {
      throw new Error(
        `all must be a boolean, got ${JSON.stringify(requestedAll)}. ` +
          "Leave it out to report only what changed.",
      );
    }
    all = requestedAll;
  }

  return { staleDays, all };
}

/** What one run needs, injectable so tests need no real clock, gh, or home dir. */
export interface BuildOptions {
  /** Injected `gh` executor. Defaults to the real spawner inside `runGh`. */
  readonly executor?: GhExecutor;
  /** Injected snapshot location, so tests never touch a real user directory. */
  readonly path?: string;
  /** Injected clock. The tool supplies the real one at its boundary. */
  readonly now?: Date;
  /** Staleness threshold, already validated. */
  readonly staleDays?: number;
}

/** The outcome of one run. A failure carries no value to render. */
export type WatchOutcome =
  | { readonly status: "ok"; readonly value: WatchValue }
  | { readonly status: "failed"; readonly message: string };

/**
 * Prefix a failure with a warning that is still true.
 *
 * A quarantine is an irreversible move to a new path. A round can fail for an
 * unrelated reason after it has already happened, and the warning is the only
 * record the user will get of where their state went -- the next run loads a
 * missing file rather than a damaged one, so it can never mention it again.
 */
function withWarning(warning: string | null, message: string): string {
  return warning === null ? message : `${warning} ${message}`;
}

/**
 * Run one check and produce the report contents.
 *
 * Order matters throughout. The snapshot is read first, so a corrupt file is
 * quarantined before anything depends on it. Phase 1 precedes phase 2, so the
 * second phase can be limited to entries that actually left the open set. And
 * the save happens last, once every call that could be made has been made.
 *
 * @returns the report value, or a message explaining why the round was abandoned.
 */
export async function buildWatchValue(
  options: BuildOptions = {},
): Promise<WatchOutcome> {
  const now = options.now ?? new Date();
  const path = options.path ?? snapshotPath();
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;

  // ---- 1. Load the previous snapshot. ------------------------------------
  const loaded = await loadSnapshot(path);
  let previous: Snapshot;
  let warning: string | null = null;

  if (loaded.status === "unreadable") {
    // Not corruption: the file may be perfectly intact and merely locked, or
    // behind a permission this process lacks. Neither moving it nor overwriting
    // it is safe, so the round ends here instead of risking the record.
    return {
      status: "failed",
      message:
        `Could not read the snapshot at ${path} (${loaded.code}): ${loaded.detail}. ` +
        "It has been left untouched; nothing was moved or overwritten.",
    };
  }

  if (loaded.status === "corrupt") {
    const quarantinable = asQuarantinable(loaded);
    if (quarantinable === null) {
      return {
        status: "failed",
        message: `The snapshot at ${path} could not be read.`,
      };
    }
    // Quarantined, never discarded. The round continues on an empty baseline so
    // the user still gets a report, and the message says where the old file
    // went -- resetting silently would lose pending changes with no way to tell
    // that apart from "nothing happened".
    const destination = await quarantineCorruptSnapshot(quarantinable);
    previous = emptySnapshot();
    warning =
      `The snapshot at ${path} was unreadable (${quarantinable.reason}) and has been moved to ` +
      `${destination}. Every open pull request will be reported as newly noticed.`;
  } else {
    previous = loaded.status === "ok" ? loaded.snapshot : emptySnapshot();
  }

  // ---- 2. Phase 1: enumerate every open pull request I authored. ----------
  const phaseOneCall = await runGh(phaseOneArgs(), {
    executor: options.executor,
  });
  if (phaseOneCall.status === "failed") {
    // "A failed enumeration writes nothing": return before the save, so the
    // previous snapshot keeps its bytes and its mtime and pending changes
    // survive to the next successful run.
    //
    // The quarantine notice is kept even though the round failed. The file was
    // already moved above, and that is irreversible; reporting only the `gh`
    // error would leave the user with a failure and no idea where their state
    // went, and the next run would find a missing file and could never say.
    return {
      status: "failed",
      message: withWarning(warning, phaseOneCall.message),
    };
  }

  const mapped = mapPhaseOne(phaseOneCall.stdout, PHASE_ONE_RESULT_LIMIT);
  if (mapped.status === "failed") {
    // An untrustworthy feed is treated exactly like a failed call. Recording a
    // partial enumeration would make the absent pull requests look like
    // departures and announce merges that never happened.
    return {
      status: "failed",
      message: withWarning(
        warning,
        `Could not read the open pull request list (${mapped.problem}): ${mapped.detail}`,
      ),
    };
  }

  const open: Record<string, PrRecord> = {};
  for (const entry of mapped.records.records) open[entry.key] = entry.record;

  if (mapped.records.atLimit) {
    // Never a silent truncation: the missing entries would read as departures.
    const note = `The open list reached the ${PHASE_ONE_RESULT_LIMIT}-result limit, so it may be incomplete.`;
    warning = warning === null ? note : `${warning} ${note}`;
  }

  // ---- 3/4. Phase 2: resolve every entry that left the open set. ---------
  // "Absent from the open set and not already terminal" is derived here rather
  // than read off `diff`'s `unresolved` deltas, because that delta is *suppressed*
  // once an entry has been reported as departed (`departedReported`) while the
  // resolve attempt has to keep happening until an outcome is known. Driving the
  // retry from the report would strand an entry the moment its first lookup
  // failed: nothing would ever ask GitHub about it again, and its eventual merge
  // would never be announced.
  const departures: string[] = [];
  for (const [key, record] of Object.entries(previous.pullRequests)) {
    if (record.state !== "OPEN") continue;
    if (open[key] !== undefined) continue;
    departures.push(key);
  }

  const resolved = new Map<string, TerminalState>();
  const completed = new Map<string, PrRecord>();
  const resolveFailures = new Map<string, string>();

  for (const key of departures) {
    const previousEntry = previous.pullRequests[key];
    const url = previousEntry.url;

    const detail = await runGh(phaseTwoArgs(url), {
      executor: options.executor,
    });
    if (detail.status === "failed") {
      resolveFailures.set(key, detail.message);
      continue;
    }

    const parsed = mapPhaseTwo(detail.stdout);
    if (parsed.status === "failed") {
      resolveFailures.set(key, `${parsed.problem} (${parsed.detail})`);
      continue;
    }

    resolved.set(key, parsed.records.terminal);
    // The mapping layer cannot know when the pull request was opened, because
    // `gh pr view` does not return `createdAt` for the fields requested. The
    // snapshot entry does, so the two are joined here rather than guessed at
    // there.
    completed.set(key, {
      ...parsed.records.record,
      createdAt: previousEntry.createdAt,
    });
  }

  // ---- 5/6. Final judgement and the report. ------------------------------
  const final = diff(previous, open, resolved, now, { staleDays });
  for (const [key, record] of completed) {
    if (final.next.pullRequests[key] !== undefined) {
      final.next.pullRequests[key] = record;
    }
  }

  // Say *why* a resolve failed, but only for the departures this round actually
  // announces. The report already tells the user a departure is unconfirmed;
  // without the cause the generic note cannot distinguish an expired login from
  // a rate limit from a pull request that no longer exists. A retry that `diff`
  // keeps silent because it has already been reported must stay silent here too,
  // or a permanently unresolvable entry would put a warning on every check --
  // and the count has to match the announcement, not every failed call, or the
  // message would name a departure the report does not mention.
  const announcedFailures = final.deltas
    .filter((delta) => delta.kind === "unresolved")
    .map((delta) => [delta.key, resolveFailures.get(delta.key)] as const)
    .filter((pair): pair is readonly [string, string] => pair[1] !== undefined);

  if (announcedFailures.length > 0) {
    const [key, reason] = announcedFailures[0];
    const noun =
      announcedFailures.length === 1
        ? "One departure could not be resolved"
        : `${announcedFailures.length} departures could not be resolved`;
    warning = withWarning(
      warning,
      `${noun}; the first failure was ${key}: ${reason}. ` +
        "They stay open and are retried on the next check.",
    );
  }

  const openEntries: WatchOpenEntry[] = Object.entries(final.next.pullRequests)
    .filter(([, record]) => record.state === "OPEN")
    .map(([key, record]) => ({
      key,
      title: record.title,
      updatedAt: record.updatedAt,
      url: record.url,
    }));

  const value: WatchValue = {
    checkedAt: now.toISOString(),
    trackedCount: openEntries.length,
    deltas: final.deltas,
    warning,
    open: openEntries,
  };

  // ---- 7. Record the round. ----------------------------------------------
  // Always, including a round that contains an unresolved departure. Not
  // recording it was the smaller-looking choice, but it is not: use of it would
  // freeze *every* other result at this baseline, so a merge or a staleness
  // determined in the same round would be re-reported on every later check until
  // the unresolved entry finally cleared -- and an entry that can never be
  // resolved (a deleted repository, a lost permission) would never clear at all.
  //
  // Recording is not the same as marking an unknown outcome as seen. The entry
  // that could not be resolved keeps `state: OPEN` and is picked up again by the
  // departure sweep above, so its outcome is still reported the first time it
  // becomes known.
  await saveSnapshot(path, pruneTerminal(final.next, now, DEFAULT_PRUNE_DAYS));

  return { status: "ok", value };
}

/**
 * The `pr_watch` tool.
 *
 * The real clock is read here, at the tool boundary, and passed down as a value.
 * That is what lets the entire pipeline below be driven against a fixed date.
 */
export const prWatchTool = defineTool({
  name: "pr_watch",
  description:
    "Report what changed in your authored GitHub pull requests since the last check: which merged, " +
    "which closed without merging, which went stale, and which are newly noticed. Covers pull " +
    "requests in every repository, including ones not cloned locally. Requires the gh CLI. " +
    "Merges and staleness are each reported once and then never again.",
  parameters: {
    staleDays: {
      type: "integer",
      description: `Days without activity before a pull request counts as stale. Defaults to ${DEFAULT_STALE_DAYS}.`,
    },
    all: {
      type: "boolean",
      description:
        "List every open pull request instead of only what changed since the last check. " +
        "Useful on a first run. Default false.",
    },
  },
  output: {
    schema: {
      type: "object",
      properties: {
        checkedAt: { type: "string" },
        trackedCount: { type: "integer" },
        warning: { oneOf: [{ type: "string" }, { type: "null" }] },
        deltas: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string" },
              key: { type: "string" },
              url: { type: "string" },
              title: { type: "string" },
              updatedAt: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        open: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              title: { type: "string" },
              updatedAt: { type: "string" },
              url: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    render: (args, value) => [
      {
        type: "text",
        text: renderWatch(value as unknown as WatchValue, args.all === true),
      },
    ],
  },
  async execute(args) {
    // The canonical value is copied into mutable arrays on the way out, because
    // the declared output schema describes mutable ones. `WatchValue` stays
    // `readonly`, which is the stronger statement for everything produced
    // internally, so the adaption belongs here at the boundary rather than
    // weakening the type the rest of the code is written against.
    //
    // `staleDays` is validated here as well as in the tests, so a bad value
    // fails before any `gh` call or disk write rather than midway through a
    // round. `validateArgs` checks `all` too, but the registry's parameter
    // schema already admits only a boolean, so that one is belt-and-braces
    // rather than reachable in production.
    const { staleDays } = validateArgs(args);

    const outcome = await buildWatchValue({ now: new Date(), staleDays });
    if (outcome.status === "failed") {
      // Thrown rather than returned: the output schema describes a report, and
      // a failure has no report to give it. The registry turns this into an
      // error result, which is what the caller needs to see.
      throw new Error(outcome.message);
    }

    return {
      checkedAt: outcome.value.checkedAt,
      trackedCount: outcome.value.trackedCount,
      warning: outcome.value.warning,
      deltas: outcome.value.deltas.map((delta) => ({ ...delta })),
      open: outcome.value.open.map((entry) => ({ ...entry })),
    };
  },
});
