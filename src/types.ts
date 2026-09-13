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
}

/** The on-disk snapshot. */
export interface Snapshot {
  version: number;
  lastCheck: string;
  /** Keyed by `owner/repo#number` so uncloned repositories are addressable. */
  pullRequests: Record<string, PrRecord>;
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

/** Stable identity for a pull request, independent of any local checkout. */
export function prKey(ref: { nameWithOwner: string; number: number }): string {
  return `${ref.nameWithOwner}#${ref.number}`;
}

/** A fresh, empty snapshot. */
export function emptySnapshot(): Snapshot {
  return { version: SNAPSHOT_VERSION, lastCheck: "", pullRequests: {} };
}
