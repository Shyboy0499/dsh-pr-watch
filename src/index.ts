import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { prWatchTool } from "./tools/pr-watch";

export const name = "pr-watch";
export const inject = ["tools"];

/**
 * Every tool this plugin contributes.
 *
 * Declaring the list here rather than registering inline keeps `apply`
 * exercisable by the test suite and makes adding a tool a single import plus
 * one entry. `pr_watch` is the whole surface: the plugin is deliberately one
 * tool, so there is nothing else to look for.
 */
export const tools: ToolDefinition[] = [prWatchTool];

export function apply(ctx: Context) {
  for (const tool of tools) ctx.tools.register(tool);
}
