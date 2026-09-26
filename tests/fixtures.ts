import type { ForgottenOutcome, PrRecord, Snapshot } from "../src/types";
import { SNAPSHOT_VERSION } from "../src/types";

/** A fixed clock. Every pure test uses this so results never depend on wall time. */
export const NOW = new Date("2026-09-10T00:00:00Z");

const MS_PER_DAY = 86_400_000;

/** An ISO timestamp `days` before NOW. */
export function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();
}

/** A pull request record with sensible defaults. */
export function record(overrides: Partial<PrRecord> = {}): PrRecord {
  return {
    url: "https://github.com/octo/repo/pull/1",
    title: "A pull request",
    state: "OPEN",
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
    staleReported: false,
    departedReported: false,
    ...overrides,
  };
}

/** A snapshot containing the given records, and any remembered outcomes. */
export function snapshot(
  pullRequests: Record<string, PrRecord> = {},
  forgotten?: Record<string, ForgottenOutcome>,
): Snapshot {
  const value: Snapshot = {
    version: SNAPSHOT_VERSION,
    lastCheck: daysAgo(1),
    pullRequests,
  };
  // Left absent rather than empty when there is nothing to remember, matching
  // what the loader and `diff` produce.
  if (forgotten !== undefined) value.forgotten = forgotten;
  return value;
}
