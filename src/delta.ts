import {
  DEFAULT_PRUNE_DAYS,
  DEFAULT_STALE_DAYS,
  SNAPSHOT_VERSION,
  type Delta,
  type PrRecord,
  type Snapshot,
  type TerminalState,
} from "./types";

const MS_PER_DAY = 86_400_000;

export interface DiffOptions {
  staleDays?: number;
}

export interface DiffResult {
  /** Everything worth telling the user about, in classification order. */
  deltas: Delta[];
  /** The snapshot that should replace `prev` after this check. */
  next: Snapshot;
}

/**
 * Whole days between an ISO timestamp and `now`, or `null` when the timestamp
 * cannot be parsed.
 *
 * `null` means "age unknown", and every caller must treat that as a reason to
 * do nothing. An unparseable timestamp is a data defect, not evidence that a
 * pull request went quiet: judging it stale invents a false alarm, and let
 * alone pruning it would silently discard a change the user has not been told
 * about yet.
 */
function ageInDays(iso: string, now: Date): number | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return (now.getTime() - then) / MS_PER_DAY;
}

/**
 * Whether `iso` is at least `days` old. Unknown ages are never old enough.
 *
 * The comparison is INCLUSIVE (`>=`), so an entry whose age has reached exactly
 * `days` counts. "No activity for 14 days" already describes the day it reaches
 * fourteen, and the alternative would make the rule depend on which side of a
 * millisecond the check happened to land -- the same pull request reported stale
 * or not depending on when the user asked. With `staleDays: 0` this makes every
 * entry with a non-future timestamp stale, which is the intended meaning of a
 * zero-day threshold rather than an accident.
 *
 * A future timestamp yields a negative age and is therefore never stale. That
 * matters because a backwards clock or a bad API payload would otherwise read as
 * "long inactive" and announce a staleness that never happened.
 */
function isAtLeastDaysOld(iso: string, now: Date, days: number): boolean {
  const age = ageInDays(iso, now);
  return age !== null && age >= days;
}

/** Project one record onto the four fields a delta carries. */
function toDelta(kind: Delta["kind"], key: string, source: PrRecord): Delta {
  return {
    kind,
    key,
    url: source.url,
    title: source.title,
    updatedAt: source.updatedAt,
  };
}

/**
 * Classify what changed since `prev`, and compute the snapshot to store next.
 *
 * Pure: no filesystem, no network, and no clock of its own -- `now` is injected.
 * Every rule below is therefore a fixture-driven unit test.
 *
 * Neither this function nor its callers may infer a terminal state. A pull
 * request that has left the open set is reported as `unresolved` unless the
 * caller resolved it out of band, because "gone from the open list" is equally
 * consistent with merged and with closed-unmerged.
 *
 * Classification precedence, highest first:
 *
 * 1. `prev` state is already terminal -> carried forward verbatim. Never
 *    reported, never re-evaluated.
 * 2. Present in `prev`, absent from `open` -> `MERGED`/`CLOSED` when `resolved`
 *    supplies a terminal state, otherwise `unresolved`, and the entry stays
 *    `OPEN` so the next check retries it.
 * 3. Present in `open` but absent from `prev` -> `new`. This outranks staleness:
 *    an entry is announced once, and if it is already past the threshold the
 *    next snapshot records that so the following check stays quiet.
 * 4. Present in both -> `stale` on the first crossing of `staleDays`, then
 *    silence until new activity resets the flag.
 *
 * Staleness is a transition, not a state, which is what makes `staleReported`
 * necessary: testing only "is it currently past the threshold" would re-report
 * the same pull request on every single check. The distinction the snapshot must
 * carry is therefore "crossed and already reported" versus "just crossed".
 *
 * The flag travels with the value this function returns, not with any store it
 * touches. `diff` never writes anything: it records the flag it believes should
 * be persisted on the `next` record, and deciding to save that snapshot is the
 * caller's business. That keeps the module pure and makes every transition above
 * a fixture-driven test rather than an assertion about disk.
 *
 * The flag is set when a `stale` delta is emitted, and also when an entry is
 * first announced as `new` while already past the threshold -- otherwise the
 * following check would immediately announce the same entry again as stale.
 * It is cleared when an entry's `updatedAt` moves, since activity restarts the
 * clock; a cleared flag lets a later crossing be reported again.
 */
export function diff(
  prev: Snapshot,
  open: Record<string, PrRecord>,
  resolved: Map<string, TerminalState>,
  now: Date,
  options: DiffOptions = {},
): DiffResult {
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const deltas: Delta[] = [];
  const next: Record<string, PrRecord> = {};
  const stillOpen: Record<string, PrRecord> = { ...open };

  for (const [key, previous] of Object.entries(prev.pullRequests)) {
    // 1. Terminal entries are history. Carry them through untouched, and drop
    //    them from the open sweep so a stray enumeration cannot re-announce
    //    them as new.
    if (previous.state !== "OPEN") {
      delete stillOpen[key];
      next[key] = previous;
      continue;
    }

    const fresh = stillOpen[key];

    // 2/3. Absent from the open set.
    if (fresh === undefined) {
      const terminal = resolved.get(key);
      if (terminal === undefined) {
        deltas.push(toDelta("unresolved", key, previous));
        next[key] = previous; // stays OPEN: the next check retries it
        continue;
      }
      deltas.push(
        toDelta(terminal === "MERGED" ? "merged" : "closed", key, previous),
      );
      next[key] = { ...previous, state: terminal };
      continue;
    }

    delete stillOpen[key];

    // The inclusive threshold decides staleness; the flag decides whether this
    // check is the one that reports it.
    const isStale = isAtLeastDaysOld(fresh.updatedAt, now, staleDays);

    // Activity moved the clock, so any previous staleness report is spent.
    const staleReported =
      fresh.updatedAt === previous.updatedAt ? previous.staleReported : false;

    // 4. Still open: silent unless this is the first crossing.
    if (isStale && !staleReported) {
      deltas.push(toDelta("stale", key, fresh));
      next[key] = { ...fresh, staleReported: true };
    } else {
      // Either not stale yet, or already reported. Recording `staleReported`
      // as-is is what keeps a long-stale entry quiet on every later check.
      next[key] = { ...fresh, staleReported };
    }
  }

  // 3. Announced exactly once, and never also reported as stale in the same
  //    pass. An entry that is already past the threshold records the flag now,
  //    so the next check is silent rather than announcing the same staleness
  //    right after announcing the entry itself.
  for (const [key, fresh] of Object.entries(stillOpen)) {
    deltas.push(toDelta("new", key, fresh));
    next[key] = {
      ...fresh,
      staleReported: isAtLeastDaysOld(fresh.updatedAt, now, staleDays),
    };
  }

  return {
    deltas,
    next: {
      version: SNAPSHOT_VERSION,
      lastCheck: now.toISOString(),
      pullRequests: next,
    },
  };
}

/**
 * Drop terminal entries whose last activity is older than `pruneDays`.
 *
 * GitHub advances `updatedAt` when a pull request merges or closes, so this is
 * effectively "terminal for more than `pruneDays`". Open entries are never
 * pruned regardless of age -- going quiet is not the same as being finished.
 *
 * This is a pure decision only. Nothing here removes anything from disk.
 *
 * An entry whose `updatedAt` cannot be parsed is kept: its age is unknown, so
 * it cannot be shown to be past the window, and dropping it would discard a
 * recorded outcome silently.
 */
export function pruneTerminal(
  snapshot: Snapshot,
  now: Date,
  pruneDays: number = DEFAULT_PRUNE_DAYS,
): Snapshot {
  const kept: Record<string, PrRecord> = {};
  for (const [key, item] of Object.entries(snapshot.pullRequests)) {
    const isTerminal = item.state !== "OPEN";
    const age = ageInDays(item.updatedAt, now);
    if (isTerminal && age !== null && age > pruneDays) continue;
    kept[key] = item;
  }
  return { ...snapshot, pullRequests: kept };
}
