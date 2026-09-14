import {
  DEFAULT_PRUNE_DAYS,
  DEFAULT_STALE_DAYS,
  SNAPSHOT_VERSION,
  type Delta,
  type DeltaKind,
  type PrRecord,
  type Snapshot,
  type TerminalState,
} from "./types";

const MS_PER_DAY = 86_400_000;

export interface DiffOptions {
  staleDays?: number;
}

export interface DiffResult {
  deltas: Delta[];
  /** The snapshot that should replace `prev` after this check. */
  next: Snapshot;
}

/** Whole days between an ISO timestamp and `now`. Unparseable input counts as 0. */
function ageInDays(iso: string, now: Date): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return (now.getTime() - then) / MS_PER_DAY;
}

function toDelta(kind: DeltaKind, key: string, source: PrRecord): Delta {
  return {
    kind,
    key,
    url: source.url,
    title: source.title,
    updatedAt: source.updatedAt,
  };
}

/**
 * Compute the changes since the previous check, and the snapshot to store next.
 *
 * `open` is keyed the same way as `prev.pullRequests`. `resolved` carries the
 * terminal state of every snapshot entry that left the open set and could be
 * resolved; a departure missing from `resolved` stays OPEN and is reported as
 * `unresolved` so the next check retries it.
 *
 * Pure by construction: no filesystem, no network, and no clock of its own —
 * `now` is injected. Every rule below is therefore a fixture-driven unit test.
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
    if (previous.state !== "OPEN") {
      next[key] = previous;
      continue;
    }

    const fresh = stillOpen[key];
    if (fresh !== undefined) {
      delete stillOpen[key];
      const isStale = ageInDays(fresh.updatedAt, now) >= staleDays;
      // New activity restarts the staleness clock, so a nudge clears the flag.
      const staleReported =
        fresh.updatedAt === previous.updatedAt ? previous.staleReported : false;
      if (isStale && !staleReported) {
        deltas.push(toDelta("stale", key, fresh));
        next[key] = { ...fresh, staleReported: true };
      } else {
        next[key] = { ...fresh, staleReported };
      }
      continue;
    }

    const terminal = resolved.get(key);
    if (terminal === undefined) {
      deltas.push(toDelta("unresolved", key, previous));
      next[key] = previous;
      continue;
    }
    deltas.push(toDelta(terminal === "MERGED" ? "merged" : "closed", key, previous));
    next[key] = { ...previous, state: terminal };
  }

  for (const [key, fresh] of Object.entries(stillOpen)) {
    deltas.push(toDelta("new", key, fresh));
    // A first sighting already past the threshold is surfaced as `new`, not
    // double-reported as stale — but the flag is set so it never fires later.
    next[key] = { ...fresh, staleReported: ageInDays(fresh.updatedAt, now) >= staleDays };
  }

  return {
    deltas,
    next: { version: SNAPSHOT_VERSION, lastCheck: now.toISOString(), pullRequests: next },
  };
}

/**
 * Drop terminal entries whose last activity is older than `pruneDays`.
 *
 * GitHub advances `updatedAt` when a pull request merges or closes, so this is
 * effectively "terminal for more than `pruneDays`". Open entries are never
 * pruned regardless of age.
 */
export function pruneTerminal(
  snapshot: Snapshot,
  now: Date,
  pruneDays: number = DEFAULT_PRUNE_DAYS,
): Snapshot {
  const kept: Record<string, PrRecord> = {};
  for (const [key, item] of Object.entries(snapshot.pullRequests)) {
    if (item.state !== "OPEN" && ageInDays(item.updatedAt, now) > pruneDays) continue;
    kept[key] = item;
  }
  return { ...snapshot, pullRequests: kept };
}
