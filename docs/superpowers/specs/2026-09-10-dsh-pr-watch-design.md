# dsh-pr-watch — Design

**Date:** 2026-09-10
**Status:** Approved, pending implementation plan
**Plugin name:** `dsh-pr-watch`
**Tool name:** `pr_watch`

---

## Problem

The author maintains a large number of open pull requests across many GitHub
repositories — mostly documentation and maintenance contributions to `awesome-*`
lists and `dsh-*` plugin projects. Keeping track of them is manual:

- Which ones actually merged?
- Which ones have gone quiet and need a nudge?
- Which ones closed without merge?

None of these are visible without opening GitHub. A session on 2026-09-10
involved re-checking five parked PRs and repeatedly re-confirming merges by hand.
The friction is not _seeing_ the PRs — it is _re-checking_ the same PRs over and
over and having to remember what the state was last time.

The dsh harness has no memory of a previous check. Anything the agent reports is
re-derived from scratch every session.

## Goals

1. Report **what changed since the last check**, not the full current state.
2. Cover PRs in repositories that are **not cloned locally** — most of the
   author's PRs are in repos absent from disk.
3. Work with the user's existing GitHub authentication. Store no credentials.
4. Be small, self-contained, and unit-testable without network access.

## Non-goals

- **Not** a background watcher. Everything is on-demand; there is no daemon,
  no polling loop, no scheduling.
- **Not** a review-notification tool. New comments and reviews are explicitly
  out of scope for v1 (see "Deferred").
- **Not** a CI status monitor. Check-run status is out of scope for v1.
- **Not** a PR authoring tool. It never opens, edits, comments on, or merges a PR.
- **Not** a general GitHub client.

---

## Design

### Architecture

The plugin mirrors `dsh-git-tools` in structure so it reads as a sibling rather
than a novel shape.

```
dsh-pr-watch/
  src/
    index.ts        name / inject / apply — registers the tool
    gh-exec.ts      thin `gh` runner (the git-exec.ts analogue)
    types.ts        PrRecord, Snapshot, Delta
    delta.ts        PURE diff function — the entire testable core
    snapshot.ts     load / atomic save / corruption recovery / prune
    tools/watch.ts  defineTool wrapper (schema + text render)
  tests/
    delta.test.ts
    snapshot.test.ts
    gh-exec.test.ts
  cordis.patch.yml  bundle insert
  package.json      peerDeps: @deepseek-ai/cordis, @deepseek-ai/dsh-tools
  README.md
  SECURITY.md
  LICENSE
```

The critical boundary is that **`delta.ts` is pure**. Its signature is:

```ts
diff(prev: Snapshot, open: PrRecord[], resolved: Map<string, ResolvedState>, now: Date): Delta[]
```

It performs no filesystem access, no network access, and reads no clock of its
own — `now` is injected. Every rule in "Delta semantics" below is therefore a
single fixture-driven unit test. `tools/watch.ts` is a thin adapter: fetch, call
`diff`, render, save. If the delta logic is wrong, a test says so, and nothing
else in the plugin needs to be trusted.

### Data model

The snapshot is a single JSON file.

**Location:** `$DSH_HOME/pr-watch/snapshot.json`, falling back to
`~/.dsh/pr-watch/snapshot.json` when `DSH_HOME` is unset. The harness already
exposes `DSH_HOME`, so the data lands wherever the user's dsh data actually
lives rather than at a hardcoded path. Overridable via config.

```json
{
  "version": 1,
  "lastCheck": "2026-09-10T12:00:00Z",
  "pullRequests": {
    "Dominic789654/awesome-deepseek-harness#281": {
      "url": "https://github.com/Dominic789654/awesome-deepseek-harness/pull/281",
      "title": "docs(zh): add Russian locale",
      "state": "OPEN",
      "createdAt": "2026-08-26T09:14:11Z",
      "updatedAt": "2026-08-27T10:02:44Z",
      "staleReported": false
    }
  }
}
```

Entries are keyed by `owner/repo#number`. The key is derived from the **GitHub**
identity, not from a local checkout path, so it is stable across repository
renames and works for repositories that have never been cloned.

`state` is one of `OPEN`, `MERGED`, `CLOSED`.

### Fetch strategy

A naive design fetches open PRs and diffs against the snapshot. **This breaks
the primary feature.** The instant a PR merges it _leaves_ the open list, so a
snapshot-versus-open diff cannot distinguish "merged" from "closed unmerged" —
and an empty result is indistinguishable from a failed `gh` invocation.

The watch therefore performs two phases:

1. **Enumerate the working set.**
   `gh search prs --author @me --state open --json ...`
   This is cheap: the author has on the order of 10–30 open PRs, not thousands.

2. **Resolve departures.**
   For each PR present in the snapshot as `OPEN` but absent from the open set,
   resolve its terminal state individually:
   `gh pr view <url> --json state,mergedAt`

Only PRs that actually changed incur a second call — typically zero or one per
check. This is what makes _merged_ versus _closed unmerged_ distinguishable, and
it keeps the request count bounded even though the author's lifetime PR count
exceeds one thousand.

### Delta semantics

| Transition                                                           | Reported as                   |
| -------------------------------------------------------------------- | ----------------------------- |
| snapshot `OPEN` → resolved `MERGED`                                  | **merged**                    |
| snapshot `OPEN` → resolved `CLOSED` (unmerged)                       | **closed without merge**      |
| `staleReported: false` → open and `updatedAt` older than `staleDays` | **became stale**              |
| present in GitHub's open set, absent from snapshot                   | **newly noticed**             |
| already `staleReported: true`                                        | _silence_ — never re-reported |
| already terminal (`MERGED` / `CLOSED`)                               | _silence_ — never re-reported |

The silence rows are the entire point of the plugin. Stale is reported once, on
transition, and then goes quiet. Merges are recorded once and never resurface.
The user sees only what is new since they last looked.

**Defaults:** `staleDays: 14`. Entries in a terminal state for more than 90 days
are pruned on write.

### Configuration

| Key            | Default                            | Purpose                                             |
| -------------- | ---------------------------------- | --------------------------------------------------- |
| `staleDays`    | `14`                               | Days without activity before a PR is reported stale |
| `snapshotPath` | `$DSH_HOME/pr-watch/snapshot.json` | Override the snapshot location                      |
| `ignoreRepos`  | `[]`                               | `owner/repo` entries to exclude from tracking       |
| `pruneDays`    | `90`                               | Drop terminal entries older than this               |

### Tool surface

A single tool, `pr_watch`.

| Parameter   | Type                 | Purpose                                                   |
| ----------- | -------------------- | --------------------------------------------------------- |
| `staleDays` | `number` (optional)  | Override the configured staleness threshold for this call |
| `all`       | `boolean` (optional) | Dump full current state instead of only deltas            |

The `all` flag exists because on first run every PR is "newly noticed" and a
delta-only view is pure noise. `all` gives the user a baseline.

Output is human-readable text grouped by delta kind (merged / closed / stale /
new), with a structured output schema alongside it so the result is scriptable.

### Error handling

| Failure                                    | Behavior                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `gh` not installed                         | Structured error naming the missing binary and pointing at cli.github.com                       |
| `gh` not authenticated                     | Structured error instructing `gh auth login`                                                    |
| Snapshot corrupt or unparseable            | Rename to `snapshot.corrupt-<n>.json`, start fresh, and **state this in the output**            |
| Fetch fails mid-run                        | **Do not write the snapshot** — pending deltas survive to the next successful run               |
| Terminal-state resolution fails for one PR | Leave the entry as `OPEN`, report it under a separate "could not resolve" heading, and continue |
| Rate limit hit                             | Report the limit and the reset time; do not write the snapshot                                  |

Two of these deserve emphasis. The corrupt-snapshot path must never silently
reset: a silent reset would discard pending deltas without the user knowing, and
the user would have no way to tell that from "nothing happened." The
fetch-failure path must never write: writing a partial snapshot would mark
deltas as seen that were never actually reported.

Writes are atomic — write to a temporary file in the same directory, then
`rename` over the target. A crash mid-write cannot leave a truncated snapshot
that reads as "every PR vanished."

### Testing

- `delta.test.ts` — one case per row of the delta-semantics table, plus explicit
  tests for both silence rules.
- `snapshot.test.ts` — round-trip serialization, corrupt-file recovery,
  pruning of old terminal entries.
- `gh-exec.test.ts` — argument construction and error mapping, with `exec` mocked.

**The test suite performs no network access**, matching how `dsh-git-tools` runs.

---

## Known limitations

**A PR opened and merged between two checks is invisible.** It is absent from the
open set (it already merged) and absent from the snapshot (it never existed when
the snapshot was taken), so neither query sees it. This is a direct consequence
of enumerating by _current_ open state rather than by _activity window_.

In practice this is unlikely: the author opens PRs deliberately and would know
about one that landed that fast. It becomes a real gap only if checks are spaced
far apart. The fix is a third query keyed on activity rather than state —
`gh search prs --author @me --state merged --merged-at ><lastCheck>` — which is
recorded as a v2 candidate below rather than built now.

**The snapshot is per-GitHub-identity.** Running under a second account would
share one snapshot and produce spurious "newly noticed" entries. See Deferred.

---

## Deferred (v2 candidates)

These were deliberately excluded and are recorded so the reasoning is not lost.

**New comments and reviews.** The author's single most consequential PR event on
2026-09-10 was a maintainer comment on PR #339 that contradicted a dead-link
verdict. Merged/closed is an _outcome_; a comment is the thing that changes what
the author does next. It is deferred because the author judged it visible the
moment a PR is opened, whereas merged and stale are not. Adding it requires a
second data source (review and comment timestamps) and a per-entry
`lastSeenCommentCount` cursor.

**CI status.** Check-run state would cover the dsh-desktop PR #793 case. Deferred
for the same reason, and because check runs require a separate API surface with
its own rate-limit profile.

**Activity-window enumeration.** A third query — `gh search prs --author @me
--state merged --merged-at ><lastCheck>` — would close the opened-and-merged-
between-checks gap described under Known limitations. Deferred because it adds a
query on every run to cover a case that is unlikely at the author's check cadence.

**Multiple simultaneous profiles.** The snapshot assumes one GitHub identity.
Supporting several would require keying entries by account as well.

---

## Decisions log

| Decision                  | Choice                 | Rationale                                                                          |
| ------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| Delivery model            | Delta on demand        | No daemon to manage; the delta is the only thing the harness cannot already derive |
| Scope                     | Authored PRs only      | Unambiguous definition of "mine"; review-requested sets are fuzzy                  |
| Storage                   | Self-contained JSON    | Avoids coupling to `dsh-note`, which is owned by a different maintainer            |
| Identity key              | `owner/repo#number`    | Stable across local rename; works for uncloned repositories                        |
| Staleness                 | 14 days, reported once | Matches the observed cadence of the author's parked PRs                            |
| Terminal-state resolution | Per-PR `gh pr view`    | Distinguishes merged from closed, at bounded cost                                  |
