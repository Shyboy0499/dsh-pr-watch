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

    // Exercised with a probe so the wiring is tested rather than resting on
    // whatever the real list happens to contain. Removed again afterwards.
    tools.push(probe);
    try {
      apply(ctx);
    } finally {
      tools.splice(tools.indexOf(probe), 1);
    }

    expect(registered).toEqual([...tools, probe]);
    expect(registered).toContain(probe);
  });

  it("declares pr_watch, and only pr_watch", () => {
    // Task 14 turned the plugin from registering nothing into registering one
    // tool. This is the assertion that the count really is one, so a second tool
    // appearing later is a deliberate change rather than a silent one.
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("pr_watch");
  });

  it("does not throw against a context when no tools are declared", () => {
    const { ctx, registered } = fakeContext();
    const declared = tools.splice(0, tools.length);

    try {
      expect(() => apply(ctx)).not.toThrow();
      expect(registered).toEqual([]);
    } finally {
      tools.push(...declared);
    }
  });
});
