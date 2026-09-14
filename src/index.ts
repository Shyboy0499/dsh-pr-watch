import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

export const name = "pr-watch";
export const inject = ["tools"];

/**
 * Every tool this plugin contributes.
 *
 * Empty until the tool modules land. Declaring the list here rather than
 * registering inline keeps `apply` exercised by the test suite even while the
 * list is empty, and makes adding a tool a single import plus one entry.
 */
export const tools: ToolDefinition[] = [];

export function apply(ctx: Context) {
  for (const tool of tools) ctx.tools.register(tool);
}
