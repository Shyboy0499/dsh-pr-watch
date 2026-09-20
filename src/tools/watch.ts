import type { Delta, DeltaKind } from "../types";

/* -------------------------------------------------------------------------
 * Task 13 — renderWatch(), the report the user actually reads.
 *
 * Pure in the same way `delta.ts` is: every input arrives as an argument, so
 * there is no clock, no filesystem, and no `gh` anywhere in this file. The
 * current time is a parameter precisely because relative phrasing such as
 * "1 day ago" would otherwise be a function of when the suite happened to run,
 * and no fixture could pin it.
 *
 * This layer decides nothing. Which changes exist, which are stale, and whether
 * a snapshot was quarantined are all settled before the call; rendering only
 * chooses how to say so. If the inputs ever turn out to be insufficient to say
 * what the README promises, that is a question for the caller rather than
 * something to compute here.
 * ---------------------------------------------------------------------- */

/**
 * One open pull request, as listed in `all` mode.
 *
 * A projection of `PrRecord` rather than the record itself: rendering needs
 * these four fields and nothing else, so nothing else can leak into the text.
 */
export interface WatchOpenEntry {
  readonly key: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly url: string;
}

/** Everything the report needs, all of it already decided by the caller. */
export interface WatchValue {
  /** ISO timestamp of the check, used as "now" and shown in `all` mode. */
  readonly checkedAt: string;
  /** How many open pull requests are tracked, whether or not they changed. */
  readonly trackedCount: number; /** The changes to report. `diff()` returns these already ordered. */
  readonly deltas: readonly Delta[];
  /**
   * A problem worth surfacing before anything else: a corrupt snapshot that was
   * quarantined, or a departure whose resolve failed and left its outcome
   * unknown. Either way the README requires the tool to say so.
   */
  readonly warning: string | null;
  /**
   * Open pull requests, for `all` mode. Unused when `all` is false.
   *
   * The caller keeps this equal to the tracked open set, so `open.length` and
   * `trackedCount` agree. `all` mode prints the length of this list rather than
   * `trackedCount`, so a caller that got the two out of step cannot render a
   * header that contradicts the entries beneath it.
   */
  readonly open: readonly WatchOpenEntry[];
}

/**
 * Group headings, in report order.
 *
 * The order mirrors `delta.ts`'s declared severity rather than inventing a
 * second opinion: finished outcomes first, then whatever still needs attention,
 * then pure notices. The plan's earlier sketch put `stale` before `unresolved`;
 * task 6 settled the real order, and following it keeps the renderer and the
 * delta core from ever disagreeing about what to read first.
 */
const HEADINGS: Record<DeltaKind, string> = {
  merged: "✅ Merged",
  closed: "⛔ Closed without merge",
  unresolved: "❓ Could not resolve",
  stale: "⏳ Became stale",
  new: "🆕 Newly noticed",
};

/** Report order. Index doubles as the sort rank. */
const GROUP_ORDER: readonly DeltaKind[] = [
  "merged",
  "closed",
  "unresolved",
  "stale",
  "new",
];

const GROUP_RANK: Record<DeltaKind, number> = {
  merged: 0,
  closed: 1,
  unresolved: 2,
  stale: 3,
  new: 4,
};

const MS_PER_DAY = 86_400_000;

/**
 * Collapse a title to a single line.
 *
 * A title is interpolated into a line whose shape carries meaning, so an
 * embedded newline or tab would break the layout the format exists to provide.
 * Collapsing rather than stripping keeps every character's substance -- "a\nb"
 * reads as "a b" -- and, unlike truncation, it never hides part of a title.
 */
function inlineTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/**
 * Relative age of `iso` as of `nowIso`, in the README's phrasing.
 *
 * The unit is always days, never "months" or "years". The README's own example
 * writes "21 days ago", so switching units would contradict the output the
 * brief is verified against, and a reader comparing two entries is better
 * served by one scale. Hundreds of days is verbose but unambiguous.
 *
 * A timestamp in the future is reported as "today" rather than a negative age.
 * Future values arise from a backwards clock or a bad payload, and "-3 days
 * ago" reads as a bug in the tool instead of what it is; the same reasoning
 * makes `delta.ts` treat a future timestamp as never stale.
 *
 * An unparsable timestamp yields "unknown". `delta.ts` refuses to judge such an
 * entry stale, so this case should not normally reach the report at all; saying
 * "unknown" is honest where inventing a number would not be.
 */
export function relativeAge(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(then) || Number.isNaN(now)) return "unknown";

  const days = Math.floor((now - then) / MS_PER_DAY);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

/** One report line: `owner/repo#n — title (last activity …)`. */
function describeEntry(
  key: string,
  title: string,
  updatedAt: string,
  nowIso: string,
): string {
  return `  ${key} — ${inlineTitle(title)} (last activity ${relativeAge(updatedAt, nowIso)})`;
}

/**
 * A deterministic copy of `deltas` in report order.
 *
 * The input is normally already ordered by `diff()`, but relying on that would
 * make the output a property of the caller. Copying first matters as much as
 * sorting: sorting the caller's array in place would mutate a value this
 * function does not own, and a caller reusing one fixture across two renders
 * would see the first call change the second's input.
 *
 * Within a group, the most recent activity comes first. The README's `Usage`
 * example settles it: it shows `octo/repo#41` (1 day ago) above `octo/repo#38`
 * (3 days ago), so the ordering on display is by activity, not by number. That
 * also matches `delta.ts`, which documents the same choice for the array it
 * hands over -- "the pull request that moved most recently is the one worth
 * reading first". (The README's `Known limitations` section lists `#7` before
 * `#3`, which is the other order; the `Usage` block is the one the acceptance
 * criteria name as the model, and it agrees with the delta core.)
 *
 * `key` is compared only to make the order total. It cannot tie in practice,
 * since it is the snapshot's primary key, but leaving ties to the sort
 * implementation would make the output depend on the input's arrangement. Both
 * fields compare as strings, so no locale collation is involved.
 */
function inReportOrder(deltas: readonly Delta[]): Delta[] {
  return [...deltas].sort((left, right) => {
    const byGroup = GROUP_RANK[left.kind] - GROUP_RANK[right.kind];
    if (byGroup !== 0) return byGroup;

    // ISO 8601 in UTC sorts lexicographically, so no date parsing is needed.
    // A later timestamp sorts first.
    if (left.updatedAt !== right.updatedAt)
      return left.updatedAt < right.updatedAt ? 1 : -1;

    if (left.key !== right.key) return left.key < right.key ? -1 : 1;
    return 0;
  });
}

/**
 * The sentence shown when there is nothing to report.
 *
 * Two different situations reach this point and they must not read alike. With
 * nothing tracked, the plugin has no history to compare against, and a bare
 * "no changes" would look like a broken tool. With open pull requests tracked
 * and none of them changed, "no changes" is exactly right and the count proves
 * the check really ran.
 */
function emptyReport(value: WatchValue): string {
  if (value.trackedCount === 0) {
    return "No pull requests are being tracked yet. Nothing open was found under your account.";
  }
  const noun = value.trackedCount === 1 ? "pull request" : "pull requests";
  return `No changes since the last check. ${value.trackedCount} open ${noun} tracked.`;
}

/**
 * The note carried by an `unresolved` group.
 *
 * `unresolved` means the query did not produce a verdict, which is not the same
 * as "nothing changed". Saying so is the point: a user who reads silence as
 * "no news" would conclude a pull request is still open when in fact nobody
 * checked. The note also says the next run retries, so the omission is
 * evidently temporary rather than a hole.
 */
function unresolvedNote(count: number): string {
  const noun = count === 1 ? "pull request" : "pull requests";
  return `  ${count} ${noun} could not be resolved and are still unconfirmed. This is a query failure, not a lack of activity; the next check will retry them.`;
}

/**
 * Render the report.
 *
 * `all` mode lists every open pull request instead of the changes, which is
 * what makes a first run legible: on a first run everything is "newly noticed",
 * so a delta-only view is noise. The warning and the unresolved note still
 * appear, because neither stops being true just because the user asked for the
 * full state.
 *
 * The output is plain text, English, with no colour and no Markdown, matching
 * the README's example. The emoji and the em dash follow that example literally
 * rather than being downgraded to ASCII: `src/gh-exec.ts` already sets
 * `NO_COLOR` for its child, and the report is a plain string, so the only
 * encoding concern is a terminal that cannot print it. Silently swapping the
 * glyphs would put the output at odds with the documented example, which is a
 * worse failure than a box character.
 *
 * @param value - the decided report contents.
 * @param all - list every open pull request instead of only the changes.
 */
export function renderWatch(value: WatchValue, all: boolean): string {
  const lines: string[] = [];

  if (value.warning !== null) lines.push(`⚠️  ${value.warning}`, "");

  if (all) {
    // The count comes from the list being printed, not from `trackedCount`.
    // The caller keeps the two equal -- `open` is the tracked open set -- but
    // reading the header from the same value it is describing means a
    // miscounted caller cannot produce a report that contradicts itself.
    lines.push(
      `Open pull requests (${value.open.length}), checked ${value.checkedAt}:`,
    );
    if (value.open.length === 0) {
      lines.push("  (none)");
    } else {
      for (const entry of value.open) {
        lines.push(
          describeEntry(
            entry.key,
            entry.title,
            entry.updatedAt,
            value.checkedAt,
          ),
        );
      }
    }

    const unresolved = value.deltas.filter(
      (delta) => delta.kind === "unresolved",
    );
    if (unresolved.length > 0) {
      lines.push("", unresolvedNote(unresolved.length));
    }

    return lines.join("\n");
  }

  const ordered = inReportOrder(value.deltas);
  if (ordered.length === 0) {
    lines.push(emptyReport(value));
    return lines.join("\n");
  }

  for (const kind of GROUP_ORDER) {
    const group = ordered.filter((delta) => delta.kind === kind);
    if (group.length === 0) continue;

    lines.push(`${HEADINGS[kind]} (${group.length}):`);
    for (const delta of group) {
      lines.push(
        describeEntry(delta.key, delta.title, delta.updatedAt, value.checkedAt),
      );
    }
    if (kind === "unresolved") lines.push(unresolvedNote(group.length));
    lines.push("");
  }

  // Groups are separated by a blank line but the report does not end with one,
  // so a caller embedding the text does not have to trim it first.
  return lines.join("\n").trimEnd();
}
