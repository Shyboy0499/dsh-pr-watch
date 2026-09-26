/** Lifecycle state of a pull request as we track it. */
export type PrState = "OPEN" | "MERGED" | "CLOSED";

/** States a pull request can reach that it never leaves. */
export type TerminalState = "MERGED" | "CLOSED";

/** One tracked pull request. */
export interface PrRecord {
  url: string;
  title: string;
  state: PrState;
  createdAt: string;
  updatedAt: string;
  /** True once staleness has been reported, so it is never reported twice. */
  staleReported: boolean;
  /**
   * True once a departure has been reported, so it is never reported twice.
   *
   * A pull request that left the open set cannot be told apart from one that
   * left on an earlier check by its `state` alone: it stays `OPEN` on purpose,
   * so the resolve phase retries it. This flag is what makes the departure
   * reportable once and then silent, the same way `staleReported` does for
   * staleness. It is cleared whenever the entry is resolvable again, because
   * reaching a terminal state is a different report entirely.
   */
  departedReported: boolean;
}

/**
 * The memory of a terminal outcome whose record has been pruned.
 *
 * Pruning keeps the snapshot bounded, but it also removes the only record that
 * an outcome was already reported. This is the least that restores that
 * guarantee: the state, plus the activity time so the memory can itself age out.
 * It is deliberately not a `PrRecord` -- storing the title, URL and timestamps
 * again would give back most of what pruning just saved.
 */
export interface ForgottenOutcome {
  readonly state: TerminalState;
  /**
   * When the record was pruned, which is what ages the memory out.
   *
   * Measured from the pruning rather than from the outcome: a record that is
   * only pruned long after it finished -- the tool simply was not run for a
   * while -- would otherwise create a memory that is already past its window.
   */
  readonly since: string;
}

/** The on-disk snapshot. */
export interface Snapshot {
  version: number;
  lastCheck: string;
  /** Keyed by `owner/repo#number` so uncloned repositories are addressable. */
  pullRequests: Record<string, PrRecord>;
  /**
   * Outcomes remembered after their record was pruned, keyed like
   * `pullRequests`.
   *
   * Optional, and absent rather than empty when there is nothing to remember: a
   * snapshot written before this existed then still loads, and an absent map
   * means exactly what it says -- nothing has been forgotten yet.
   */
  forgotten?: Record<string, ForgottenOutcome>;
}

export type DeltaKind = "merged" | "closed" | "stale" | "new" | "unresolved";

/** A single change worth reporting. */
export interface Delta {
  kind: DeltaKind;
  key: string;
  url: string;
  title: string;
  updatedAt: string;
}

export const SNAPSHOT_VERSION = 1;
export const DEFAULT_STALE_DAYS = 14;
export const DEFAULT_PRUNE_DAYS = 90;

/**
 * How long a pruned outcome is remembered, measured from the pruning.
 *
 * Longer than the prune window on purpose: the record is dropped 90 days after
 * it reached a terminal state, and the memory of that state then has to outlive
 * the record it replaced. Nothing else depends on the value, so it can be
 * changed without touching the snapshot schema.
 */
export const DEFAULT_FORGOTTEN_DAYS = 180;

/** Stable identity for a pull request, independent of any local checkout. */
export function prKey(ref: { nameWithOwner: string; number: number }): string {
  return `${ref.nameWithOwner}#${ref.number}`;
}

/** A fresh, empty snapshot. */
export function emptySnapshot(): Snapshot {
  return { version: SNAPSHOT_VERSION, lastCheck: "", pullRequests: {} };
}
