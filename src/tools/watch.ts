import { defineTool } from "@deepseek-ai/dsh-tools";
import { diff, pruneTerminal } from "../delta";
import {
  ghJson,
  ghSearchOpenArgs,
  ghViewArgs,
  toPrKey,
  toPrRecord,
  toTerminalState,
  type RawPrDetail,
  type RawSearchPr,
} from "../gh-exec";
import { loadSnapshot, saveSnapshot, snapshotPath } from "../snapshot";
import {
  DEFAULT_PRUNE_DAYS,
  DEFAULT_STALE_DAYS,
  type Delta,
  type PrRecord,
  type TerminalState,
} from "../types";

/** One open pull request, as shown in `all` mode. */
export interface OpenEntry {
  key: string;
  title: string;
  url: string;
  updatedAt: string;
}

/** Everything the tool returns. */
export interface WatchValue {
  checkedAt: string;
  openCount: number;
  deltas: Delta[];
  warning: string | null;
  open: OpenEntry[];
}

const HEADINGS: Record<Delta["kind"], string> = {
  merged: "✅ Merged",
  closed: "⛔ Closed without merge",
  stale: "⏳ Became stale",
  unresolved: "❓ Could not resolve",
  new: "🆕 Newly noticed",
};

/** Stable display order; most consequential first. */
const ORDER: Delta["kind"][] = [
  "merged",
  "closed",
  "stale",
  "unresolved",
  "new",
];

const MS_PER_DAY = 86_400_000;

/** Human-readable age of a timestamp relative to the check time. */
function relative(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(then) || Number.isNaN(now)) return "unknown";
  const days = Math.floor((now - then) / MS_PER_DAY);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function describe(
  key: string,
  title: string,
  updatedAt: string,
  nowIso: string,
): string {
  return `  ${key} — ${title} (last activity ${relative(updatedAt, nowIso)})`;
}

/** Render the tool result as text. Pure, so it is unit-tested without any IO. */
export function renderWatch(value: WatchValue, all: boolean): string {
  const lines: string[] = [];
  if (value.warning !== null) lines.push(`⚠️  ${value.warning}`, "");

  if (all) {
    lines.push(
      `Open pull requests (${value.openCount}), checked ${value.checkedAt}:`,
    );
    if (value.open.length === 0) lines.push("  (none)");
    for (const pr of value.open) {
      lines.push(describe(pr.key, pr.title, pr.updatedAt, value.checkedAt));
    }
    return lines.join("\n");
  }

  if (value.deltas.length === 0) {
    lines.push(
      `No changes since the last check. ${value.openCount} open pull request(s) tracked.`,
    );
    return lines.join("\n");
  }

  for (const kind of ORDER) {
    const group = value.deltas.filter((delta) => delta.kind === kind);
    if (group.length === 0) continue;
    lines.push(`${HEADINGS[kind]} (${group.length}):`);
    for (const delta of group) {
      lines.push(
        describe(delta.key, delta.title, delta.updatedAt, value.checkedAt),
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export const prWatchTool = defineTool({
  name: "pr_watch",
  description:
    "Report what changed in your authored GitHub pull requests since the last check: which merged, which closed without merging, which went stale, and which are newly noticed. Covers pull requests in every repository, including ones not cloned locally. Requires the gh CLI. Merges and staleness are each reported once and then never again.",
  parameters: {
    staleDays: {
      type: "number",
      description: `Days without activity before a pull request counts as stale. Defaults to ${DEFAULT_STALE_DAYS}.`,
    },
    all: {
      type: "boolean",
      description:
        "List every open pull request instead of only what changed since the last check. Default false.",
    },
  },
  output: {
    schema: {
      type: "object",
      properties: {
        checkedAt: { type: "string" },
        openCount: { type: "number" },
        warning: { oneOf: [{ type: "string" }, { type: "null" }] },
        deltas: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string" },
              key: { type: "string" },
              url: { type: "string" },
              title: { type: "string" },
              updatedAt: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        open: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              title: { type: "string" },
              url: { type: "string" },
              updatedAt: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    render: (args, value) => [
      {
        type: "text",
        text: renderWatch(value as WatchValue, args.all === true),
      },
    ],
  },
  async execute(args, exec): Promise<WatchValue> {
    const now = new Date();
    const path = snapshotPath();
    const { snapshot: previous, warning } = await loadSnapshot(path);

    // A failure here propagates before any write, so pending deltas survive to
    // the next successful run rather than being marked as seen.
    const rawOpen = await ghJson<RawSearchPr[]>(
      ghSearchOpenArgs(),
      exec.signal,
    );
    const open: Record<string, PrRecord> = {};
    for (const raw of rawOpen) open[toPrKey(raw)] = toPrRecord(raw);

    // Every snapshot entry that left the open set needs its terminal state
    // resolved individually, or merged is indistinguishable from closed.
    const resolved = new Map<string, TerminalState>();
    for (const [key, entry] of Object.entries(previous.pullRequests)) {
      if (entry.state !== "OPEN") continue;
      if (key in open) continue;
      try {
        const detail = await ghJson<RawPrDetail>(
          ghViewArgs(entry.url),
          exec.signal,
        );
        const terminal = toTerminalState(detail.state);
        if (terminal !== undefined) resolved.set(key, terminal);
      } catch {
        // Left unresolved on purpose: diff reports it as `unresolved` and the
        // entry stays OPEN so the next check retries it.
      }
    }

    const staleDays =
      args.staleDays !== undefined && args.staleDays > 0
        ? args.staleDays
        : DEFAULT_STALE_DAYS;
    const { deltas, next } = diff(previous, open, resolved, now, { staleDays });
    await saveSnapshot(path, pruneTerminal(next, now, DEFAULT_PRUNE_DAYS));

    const openEntries: OpenEntry[] = Object.entries(next.pullRequests)
      .filter(([, entry]) => entry.state === "OPEN")
      .map(([key, entry]) => ({
        key,
        title: entry.title,
        url: entry.url,
        updatedAt: entry.updatedAt,
      }));

    return {
      checkedAt: now.toISOString(),
      openCount: openEntries.length,
      deltas,
      warning,
      open: openEntries,
    };
  },
});
