import { describe, it, expect } from "vitest";
import { name } from "../src/index";

describe("plugin entry", () => {
  it("exposes the bundle name", () => {
    expect(name).toBe("pr-watch");
  });
});
