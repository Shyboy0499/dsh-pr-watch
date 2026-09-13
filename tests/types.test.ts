import { describe, it, expect } from "vitest";
import {
  DEFAULT_PRUNE_DAYS,
  DEFAULT_STALE_DAYS,
  SNAPSHOT_VERSION,
  emptySnapshot,
  prKey,
} from "../src/types";

describe("types", () => {
  it("exposes the documented defaults", () => {
    expect(SNAPSHOT_VERSION).toBe(1);
    expect(DEFAULT_STALE_DAYS).toBe(14);
    expect(DEFAULT_PRUNE_DAYS).toBe(90);
  });

  it("keys a pull request as owner/repo#number", () => {
    expect(prKey({ nameWithOwner: "octo/repo", number: 42 })).toBe(
      "octo/repo#42",
    );
  });

  it("builds an empty snapshot", () => {
    expect(emptySnapshot()).toEqual({
      version: 1,
      lastCheck: "",
      pullRequests: {},
    });
  });
});
