import type { PrRecord, Snapshot } from "../src/types";
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

/** A snapshot containing the given records. */
export function snapshot(
  pullRequests: Record<string, PrRecord> = {},
): Snapshot {
  return { version: SNAPSHOT_VERSION, lastCheck: daysAgo(1), pullRequests };
}
