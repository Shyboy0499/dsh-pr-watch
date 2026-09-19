import { describe, it, expect } from "vitest";
import type { QuarantinableSnapshot, SnapshotLoad } from "../src/snapshot";
import { asQuarantinable } from "../src/snapshot";

/**
 * The brand on `QuarantinableSnapshot` is a compile-time guarantee, so the
 * assertions that matter here are the `@ts-expect-error` lines below. Each one
 * FAILS THE BUILD if the line under it stops being a type error, which is what
 * happens if the brand is ever weakened to a structural check.
 */
describe("QuarantinableSnapshot — the brand is nominal, not structural", () => {
  it("rejects a structurally perfect corrupt result built by hand", () => {
    const forged = {
      status: "corrupt",
      path: "/tmp/snapshot.json",
      reason: "empty",
      detail: "the file is empty (0 bytes)",
    } as const;

    // @ts-expect-error a corrupt result is not quarantinable without the brand
    const branded: QuarantinableSnapshot = forged;

    // Reaching the runtime assertion at all proves the line above was rejected
    // by the compiler rather than silently accepted.
    expect(branded).toBeDefined();
  });

  it("rejects an unreadable result outright", () => {
    const unreadable = {
      status: "unreadable",
      path: "/tmp/snapshot.json",
      code: "EACCES",
      detail: "permission denied",
    } as const;

    // @ts-expect-error an unreadable file is not known to be damaged
    const branded: QuarantinableSnapshot = unreadable;

    expect(branded).toBeDefined();
  });

  it("rejects a load result that was not narrowed", () => {
    const loaded = {
      status: "missing",
      path: "/tmp/snapshot.json",
    } as SnapshotLoad;

    expect(asQuarantinable(loaded)).toBeNull();
  });
});
