import { describe, it, expect } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { apply, inject, name, tools } from "../src/index";

/** A stand-in for the cordis context, recording what `apply` registers. */
function fakeContext() {
  const registered: ToolDefinition[] = [];
  const ctx = {
    tools: {
      register: (tool: ToolDefinition) => {
        registered.push(tool);
        return () => {};
      },
    },
  } as unknown as Context;
  return { ctx, registered };
}

describe("plugin entry", () => {
  it("exposes the bundle name", () => {
    expect(name).toBe("pr-watch");
  });

  it("declares the tools service as a dependency", () => {
    expect(inject).toEqual(["tools"]);
  });

  it("exposes apply as a function", () => {
    expect(apply).toBeTypeOf("function");
  });

  it("registers every tool it declares, and nothing else", () => {
    const { ctx, registered } = fakeContext();
    const probe = { name: "probe" } as unknown as ToolDefinition;

    // Exercised with a probe so the wiring is actually tested rather than
    // passing vacuously on an empty list. Removed again so the declared list
    // stays empty.
    tools.push(probe);
    try {
      apply(ctx);
    } finally {
      tools.splice(tools.indexOf(probe), 1);
    }

    expect(registered).toEqual([probe]);
    expect(tools).toEqual([]);
  });

  it("does not throw against a context when no tools are declared", () => {
    const { ctx, registered } = fakeContext();
    expect(() => apply(ctx)).not.toThrow();
    expect(registered).toEqual([]);
  });
});
