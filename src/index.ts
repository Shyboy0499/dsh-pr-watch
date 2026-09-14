import type { Context } from "@deepseek-ai/cordis";
import { prWatchTool } from "./tools/watch";

export const name = "pr-watch";
export const inject = ["tools"];

export function apply(ctx: Context) {
  ctx.tools.register(prWatchTool);
}
