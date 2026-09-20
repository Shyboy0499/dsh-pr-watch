# dsh-pr-watch

![Status](https://img.shields.io/badge/status-pre--release-orange)
![License](https://img.shields.io/github/license/Shyboy0499/dsh-pr-watch)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)

> Reports what changed in your authored pull requests since your last check — merged, closed, or gone stale.

`dsh-pr-watch` is a dependency-free [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that exposes one agent tool, **`pr_watch`**. It tracks every pull request you authored, **across all repositories — including ones you have never cloned** — and tells you only what changed since you last looked.

> **Status: pre-release.** The implementation is complete: the plugin registers
> exactly one tool, `pr_watch`, and the whole pipeline is covered by the test
> suite. **Nothing is published to npm yet, so the install command below does not
> work today.** It is included so the intended path is clear, not because it is
> ready.
>
> - Design: [`docs/superpowers/specs/2026-09-10-dsh-pr-watch-design.md`](docs/superpowers/specs/2026-09-10-dsh-pr-watch-design.md)
> - Plan: [`docs/superpowers/plans/2026-09-10-dsh-pr-watch.md`](docs/superpowers/plans/2026-09-10-dsh-pr-watch.md)
> - What is left: [Roadmap](#roadmap)

## What works today

| Piece                                                       | State                                           |
| ----------------------------------------------------------- | ----------------------------------------------- |
| `package.json`, `tsconfig.json`, `tsdown.config.ts`, bundle | ✅ In place                                     |
| `src/types.ts` — `PrRecord`, `Snapshot`, `Delta`, constants | ✅ In place                                     |
| `src/delta.ts` — the pure diff core                         | ✅ In place                                     |
| `src/snapshot.ts` — load, quarantine, atomic save           | ✅ In place                                     |
| `src/gh-exec.ts` — `gh` invocation and record mapping       | ✅ In place                                     |
| `src/tools/watch.ts` — the report renderer                  | ✅ In place                                     |
| `src/tools/pr-watch.ts` — the `pr_watch` tool               | ✅ In place                                     |
| `src/index.ts` — plugin entry (`name`, `inject`, `apply`)   | ✅ In place, registers **one** tool: `pr_watch` |
| CI — typecheck, lint, format, test, build                   | ✅ Green on every pull request                  |
| Published to npm                                            | ⛔ Not yet — the install command does not work  |

Installing this plugin today registers `pr_watch`. What is still missing is the
release itself, not the tool.

Test counts are deliberately not listed here. They went stale within one pull request, and CI already reports them per commit — a number in prose is a claim nobody re-checks.

## Why

An agent has no memory of your last check, so every status question gets re-derived from scratch. That is fine for one pull request and useless for thirty. The friction is not _seeing_ your pull requests — it is _re-checking_ the same ones over and over and having to remember what the state was last time.

`pr_watch` closes that gap by storing a snapshot and reporting **deltas**.

## Features

> **Implemented, pending release.** Everything below is built and covered by the
> test suite. It is not on npm yet, so there is no way to install it other than
> from a checkout — see [Installation](#installation) and
> [What works today](#what-works-today).

| Behaviour                      | Detail                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Merged**                     | A pull request you authored was merged                                                                        |
| **Closed without merge**       | Distinguished from a merge, not lumped in with it                                                             |
| **Became stale**               | No activity for 14 days (configurable)                                                                        |
| **Newly noticed**              | A pull request is open that the snapshot did not know about — including one that was closed and then reopened |
| **Uncloned repositories**      | Tracked by `owner/repo#number`, so a local checkout is never required                                         |
| **Reported once, then silent** | Merges and staleness never repeat on later checks                                                             |

## How it works

The naive approach — fetch open pull requests, diff against the snapshot — **cannot work**. The moment a pull request merges it _leaves_ the open list, so a bare diff cannot tell "merged" from "closed unmerged", and an empty result looks identical to a failed `gh` call.

So `pr_watch` fetches in two phases:

1. **Enumerate** every open pull request you authored, in one call.
2. **Resolve** each snapshot entry that _left_ that set, individually, to learn its terminal state.

Only pull requests that actually changed incur a second call — normally zero or one per check.

## Installation

```sh
dsh plugin --profile PROFILE add dsh-pr-watch
```

Replace `PROFILE` with the dsh profile you actually run — the tool only appears
in that one. The Desktop app manages a profile of its own, so from its terminal
omit the flag entirely and let it target the active profile:

```sh
dsh plugin add dsh-pr-watch
```

> **Not yet published, so neither command works today.** They are the intended
> path once the package is released.

Until then, install from a checkout. `dsh plugin` forwards its arguments to
`pnpm` in the profile directory and anchors a relative path spec to the
directory you ran it from, so a local link works on every platform:

```sh
pnpm install && pnpm run build
dsh plugin --profile PROFILE add link:.
```

Run that from the repository root, and use the same profile you would have used
above.

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

| Parameter   | Type      | Description                                                                                                                                              |
| ----------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staleDays` | `integer` | Whole days without activity before a pull request counts as stale. Defaults to `14`. Must be between `1` and `3650`; `0` is refused as a likely mistake. |
| `all`       | `boolean` | List every open pull request instead of only what changed. Useful on first run, where everything is "newly noticed". Defaults to `false`.                |

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
- **A failed enumeration writes nothing.** If the one `gh search` call fails, or its output cannot be read, the snapshot is left untouched so pending changes are not silently marked as seen. A failure in the resolve phase is narrower: every outcome that _was_ determined is still recorded, and the entry that could not be resolved stays `OPEN` and is retried on the next check — without being announced again in the meantime.
- **A reopened pull request is announced again.** Closing is not final: if a closed pull request is open again at the next check, it is reported as newly noticed and resumes normal tracking. A merge is treated as final, since it cannot be undone.
- **The snapshot is written atomically** (temporary file, then rename), so an interrupted write can never leave a truncated file that reads as "everything vanished".
- **A corrupt snapshot is quarantined, never discarded.** It is moved to `snapshot.json.corrupt-<n>` and the tool says so in its output, including when the check fails afterwards — the move is irreversible, so that message is the only chance to report it.

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
| ✅    | 8–10 — `snapshot.ts`: path resolution, load, quarantine, atomic save |
| ✅    | 11–12 — `gh-exec.ts`: invocation, record mapping, error handling     |
| ✅    | 13–14 — `renderWatch()` and the `pr_watch` tool, then registration   |
| ✅    | 15 — build wiring, README, artifact checks                           |

The remaining work is a release, not a feature: the package has not been
published, so `dsh plugin --profile web add dsh-pr-watch` cannot resolve yet.

## Development

```sh
pnpm install
pnpm run build        # tsdown → lib/
pnpm test             # vitest — no network access
pnpm run lint         # oxlint
pnpm run typecheck    # tsc --noEmit
pnpm run format       # prettier --write .
```

The test suite makes **no network requests** and never runs `gh`. `delta.ts` and
`tools/watch.ts` are pure — no filesystem, no network, no clock — and every IO
module takes its dependencies as arguments, so the whole pipeline is driven by
fixtures and injected executors rather than mocks.

To check the built artifact rather than the sources, run `pnpm run build` and
then load `lib/index.js`: it must export `name`, `inject`, `apply`, and a `tools`
array of exactly one entry. `pnpm pack` should produce a tarball containing only
`lib/index.js`, `cordis.patch.yml`, `package.json`, `README.md`, `LICENSE`, and
`SECURITY.md`.

On Windows, `pnpm` organises `node_modules` with symlinks, which needs Developer
Mode or an elevated shell; without it, installs fail with `EPERM`. The npm cache
and store are redirected inside the repository by `.npmrc`, so nothing is written
outside the checkout.

## License

[MIT](LICENSE)
