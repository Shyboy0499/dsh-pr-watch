# dsh-pr-watch

![Status](https://img.shields.io/badge/status-scaffolding%20only-orange)
![License](https://img.shields.io/github/license/Shyboy0499/dsh-pr-watch)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)

> Reports what changed in your authored pull requests since your last check — merged, closed, or gone stale.

`dsh-pr-watch` is a dependency-free [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that exposes one agent tool, **`pr_watch`**. It tracks every pull request you authored, **across all repositories — including ones you have never cloned** — and tells you only what changed since you last looked.

> **Status: scaffolding only.** The plugin skeleton, its types, and their tests are in place and CI is green. **The `pr_watch` tool itself is not implemented yet** — everything below describes the behaviour it is being built to, not behaviour you can use today. Nothing is published to npm, so the install command does not work either.
>
> - Design: [`docs/superpowers/specs/2026-09-10-dsh-pr-watch-design.md`](docs/superpowers/specs/2026-09-10-dsh-pr-watch-design.md)
> - Plan: [`docs/superpowers/plans/2026-09-10-dsh-pr-watch.md`](docs/superpowers/plans/2026-09-10-dsh-pr-watch.md)
> - What is left: [Roadmap](#roadmap)

## What works today

| Piece                                                       | State                                 |
| ----------------------------------------------------------- | ------------------------------------- |
| `package.json`, `tsconfig.json`, `tsdown.config.ts`, bundle | ✅ In place                           |
| `src/types.ts` — `PrRecord`, `Snapshot`, `Delta`, constants | ✅ In place                           |
| `src/delta.ts` — the pure diff core                         | ✅ In place, 31 tests                 |
| `src/index.ts` — plugin entry (`name`, `inject`, `apply`)   | ✅ In place, registers **zero** tools |
| CI — typecheck, lint, format, test, build                   | ✅ Green on every pull request        |
| `src/snapshot.ts` — load, quarantine, atomic save           | ⛔ Not implemented                    |
| `src/gh-exec.ts` — `gh` invocation and mapping              | ⛔ Not implemented                    |
| `src/tools/watch.ts` — the `pr_watch` tool                  | ⛔ Not implemented                    |

Forty-four tests pass. The diff core is complete and tested, but nothing calls it yet and the plugin's tool list is empty, so **installing this plugin today registers nothing.**

## Why

An agent has no memory of your last check, so every status question gets re-derived from scratch. That is fine for one pull request and useless for thirty. The friction is not _seeing_ your pull requests — it is _re-checking_ the same ones over and over and having to remember what the state was last time.

`pr_watch` closes that gap by storing a snapshot and reporting **deltas**.

## Features

> ⚠️ **Designed, not built.** Everything from here down to [Known limitations](#known-limitations) describes the intended behaviour. None of it is implemented yet — see [What works today](#what-works-today) for the honest state.

| Behaviour                      | Detail                                                                |
| ------------------------------ | --------------------------------------------------------------------- |
| **Merged**                     | A pull request you authored was merged                                |
| **Closed without merge**       | Distinguished from a merge, not lumped in with it                     |
| **Became stale**               | No activity for 14 days (configurable)                                |
| **Newly noticed**              | A pull request appeared that the snapshot did not know about          |
| **Uncloned repositories**      | Tracked by `owner/repo#number`, so a local checkout is never required |
| **Reported once, then silent** | Merges and staleness never repeat on later checks                     |

## How it works

The naive approach — fetch open pull requests, diff against the snapshot — **cannot work**. The moment a pull request merges it _leaves_ the open list, so a bare diff cannot tell "merged" from "closed unmerged", and an empty result looks identical to a failed `gh` call.

So `pr_watch` fetches in two phases:

1. **Enumerate** every open pull request you authored, in one call.
2. **Resolve** each snapshot entry that _left_ that set, individually, to learn its terminal state.

Only pull requests that actually changed incur a second call — normally zero or one per check.

## Installation

```sh
dsh plugin --profile web add dsh-pr-watch
```

> Not yet published — see the status note above.

Requires the [GitHub CLI](https://cli.github.com) (`gh`) on your `PATH`, authenticated:

```sh
gh auth login
```

`dsh-pr-watch` stores no credentials of its own. It relies entirely on `gh`'s own keyring-backed authentication.

## Usage

Ask the agent to check your pull requests, or call the tool directly.

```json
{
  "staleDays": 14,
  "all": false
}
```

Typical output:

```
✅ Merged (2):
  octo/repo#41 — Add Russian locale (last activity 1 day ago)
  octo/repo#38 — Fix broken link (last activity 3 days ago)

⏳ Became stale (1):
  octo/repo#29 — docs: clarify install steps (last activity 21 days ago)

🆕 Newly noticed (1):
  octo/repo#44 — Add MCP server entry (last activity today)
```

Run it a second time and only genuine changes appear. A merge reported today is never reported again.

### Parameters

| Parameter   | Type      | Description                                                                                                                               |
| ----------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `staleDays` | `number`  | Days without activity before a pull request counts as stale. Defaults to `14`.                                                            |
| `all`       | `boolean` | List every open pull request instead of only what changed. Useful on first run, where everything is "newly noticed". Defaults to `false`. |

### Configuration

v1 exposes everything through the tool's two parameters above. It reads no
settings file, so there is nothing else to configure yet.

| Setting       | Default                            | Settable in v1                    | Purpose                                                                |
| ------------- | ---------------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| `staleDays`   | `14`                               | Yes — tool parameter              | Days without activity before a pull request is reported stale          |
| `pruneDays`   | `90`                               | No — compile-time constant        | Drop entries that reached a terminal state this long ago               |
| Snapshot path | `$DSH_HOME/pr-watch/snapshot.json` | No — derived from the environment | Falls back to `~/.dsh/pr-watch/snapshot.json` when `DSH_HOME` is unset |

Two further keys appear in the [design doc](docs/superpowers/specs/2026-09-10-dsh-pr-watch-design.md) —
`ignoreRepos` and a user-settable `snapshotPath` — but they are **deferred to v2
and not implemented**. Honouring them needs a settings loader that does not exist
yet, and `ignoreRepos` additionally needs a rule to evict ignored entries from
the snapshot: an entry dropped from enumeration but kept in the snapshot would
never resolve, so every check would report it as `unresolved` forever. See the
plan's refinements section for the full reasoning.

## Behaviour notes

- **Staleness fires on transition, and only once.** A pull request that has been stale for weeks is reported the first time it crosses the threshold, then stays quiet. If it sees new activity, the staleness clock resets and it can be reported again later.
- **A failed fetch writes nothing.** If `gh` fails partway through, the snapshot is left untouched so pending changes are not silently marked as seen.
- **The snapshot is written atomically** (temporary file, then rename), so an interrupted write can never leave a truncated file that reads as "everything vanished".
- **A corrupt snapshot is quarantined, never discarded.** It is moved to `snapshot.json.corrupt-<n>` and the tool says so in its output. The alternative — silently resetting — would lose pending changes with no way to tell that from "nothing happened".

## Known limitations

**A pull request opened _and_ merged between two checks is invisible.** It is absent from the open set (it already merged) and absent from the snapshot (it did not exist when the snapshot was taken), so neither phase sees it. This is a direct consequence of enumerating by current state rather than by activity window, and it only becomes likely if you check infrequently. The fix — an activity-window query — is recorded in the design doc as a v2 candidate.

**New comments and reviews are not reported.** An outcome like "merged" is not the same as "a maintainer replied asking for changes", and the latter is often what should change your next action. It is deferred rather than overlooked: it needs a separate data source and a per-entry comment cursor.

**CI status is not reported.**

**One snapshot per GitHub identity.** Running under a second account would share a snapshot and produce spurious "newly noticed" entries.

## Roadmap

The design is complete and the work is broken into fifteen tasks in the
[implementation plan](docs/superpowers/plans/2026-09-10-dsh-pr-watch.md).

| State | Tasks                                                                |
| ----- | -------------------------------------------------------------------- |
| ✅    | 1–3 — scaffolding, types, test fixtures                              |
| ✅    | 4–7 — the pure `delta.ts` core                                       |
| ⛔    | 8–10 — `snapshot.ts`: path resolution, load, quarantine, atomic save |
| ⛔    | 11–12 — `gh-exec.ts`: invocation, record mapping, error handling     |
| ⛔    | 13–14 — `renderWatch()` and the `pr_watch` tool, then registration   |
| ⛔    | 15 — build wiring, README, publish preparation                       |

## Development

```sh
pnpm install
pnpm run build        # tsdown → lib/
pnpm test             # vitest — no network access
pnpm run lint         # oxlint
pnpm run typecheck    # tsc --noEmit
pnpm run format       # prettier --write .
```

The test suite makes **no network requests**. `delta.ts` is pure — no filesystem, no network, no clock — so every state-transition rule is a fixture-driven unit test with no mocking.

## License

[MIT](LICENSE)
