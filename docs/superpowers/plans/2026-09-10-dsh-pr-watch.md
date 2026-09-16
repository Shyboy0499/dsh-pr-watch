# dsh-pr-watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `dsh-pr-watch`, a DeepSeek Harness plugin exposing one `pr_watch` tool that reports what changed in the user's authored GitHub pull requests since the last check.

**Architecture:** A pure `diff()` function owns all state-transition logic; everything else is IO around it. The tool fetches currently-open PRs with one `gh search`, then resolves each snapshot entry that _left_ the open set individually with `gh pr view`, so merged is distinguishable from closed-unmerged. State lives in one JSON snapshot keyed by `owner/repo#number`, written atomically.

**Tech Stack:** TypeScript (ESM, `strict`), `@deepseek-ai/dsh-tools` `defineTool`, `@deepseek-ai/cordis` plugin shape, `gh` CLI for data, Vitest, oxlint, Prettier, tsdown.

**Spec:** `docs/superpowers/specs/2026-09-10-dsh-pr-watch-design.md`

**Conventions source of truth:** the sibling plugin at `/Users/brocode/uni/github/dsh-git-tools`. When in doubt, match it.

---

## Three deliberate refinements to the spec

All are decisions discovered while planning or implementing; flagging rather than silently deviating.

1. **`diff()` returns `{ deltas, next }`, not just `Delta[]`.** Computing the next snapshot is state logic, so it belongs in the pure core. This keeps `snapshot.ts` purely about IO and makes the state transition directly testable.

2. **`pruneTerminal()` lives in `delta.ts`, not `snapshot.ts`.** Same reason — it is pure state logic. `snapshot.ts` calls it during save.

3. **The spec's `ignoreRepos` and `snapshotPath` configuration keys are deferred to v2; this plan is authoritative for the v1 surface.** The spec's Configuration table lists four keys, but only two of them — `staleDays` and `pruneDays` — ever became real, and neither is user-settable: `staleDays` is a tool parameter with a default, `pruneDays` is the `DEFAULT_PRUNE_DAYS` constant. Decided explicitly during implementation, so that the README stops advertising settings that have no entry point.

   Concretely:

   - **`ignoreRepos` is not implemented.** It is not merely a filter: an entry removed from the enumeration but left in the snapshot would never resolve, so `diff()` would report it as `unresolved` on every single check — a permanent false alarm. Doing it correctly requires a snapshot-eviction rule plus tests, which is why it is a v2 item rather than a small addition. Until then, every authored pull request is tracked.
   - **`snapshotPath` is not user-configurable.** `snapshotPath(override?)` keeps its optional argument — it is exercised by the `snapshot.test.ts` override case — but nothing in v1 reads a setting to populate it. The snapshot location is resolved from `DSH_HOME` only.
   - Neither key needs new code to stay honest: `src/types.ts` is unaffected, and no task in this plan reads a config file.

   Closing the gap requires a dsh settings loader that does not exist yet, so it is a deliberate v2 candidate rather than an omission.

## File structure

| File                 | Responsibility                                                                 |
| -------------------- | ------------------------------------------------------------------------------ |
| `src/types.ts`       | Type definitions + tunable constants. No logic beyond `prKey`/`emptySnapshot`. |
| `src/delta.ts`       | **Pure.** `diff()` and `pruneTerminal()`. No fs, no network, no clock.         |
| `src/snapshot.ts`    | IO only: path resolution, load, quarantine-on-corrupt, atomic save.            |
| `src/gh-exec.ts`     | `gh` invocation, argument builders, JSON→record mapping, error mapping.        |
| `src/tools/watch.ts` | `defineTool` wrapper + pure `renderWatch()`. Orchestration only.               |
| `src/index.ts`       | Plugin registration (`name`, `inject`, `apply`).                               |

Tests mirror the pure surface: `delta`, `snapshot`, `gh-exec`, `render`.

---

## Task 1: Project scaffolding

**Files:**

- Create: `package.json`, `tsconfig.json`, `tsdown.config.ts`, `cordis.patch.yml`, `LICENSE`, `SECURITY.md`, `src/index.ts`, `tests/smoke.test.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "dsh-pr-watch",
  "version": "0.1.0",
  "description": "DeepSeek Harness plugin: reports what changed in your authored pull requests since your last check — merged, closed, or gone stale.",
  "license": "MIT",
  "author": "Shyboy0499",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Shyboy0499/dsh-pr-watch.git"
  },
  "keywords": [
    "deepseek-harness",
    "dsh",
    "dsh-plugin",
    "pull-request",
    "agent-tools"
  ],
  "engines": { "node": ">=18" },
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "SECURITY.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "scripts": {
    "build": "tsdown",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "oxlint",
    "prepublishOnly": "pnpm run build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0"
  },
  "devDependencies": {
    "@types/node": "^22.20.0",
    "oxlint": "^1.80.0",
    "prettier": "^3.9.6",
    "tsdown": "0.22.2",
    "typescript": "~5.7.2",
    "vitest": "^2.1.9"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Write `tsdown.config.ts`**

```ts
import type { UserConfig } from "tsdown";

const lib: UserConfig = {
  name: "dsh-pr-watch",
  entry: ["src/index.ts"],
  outDir: "lib",
  format: ["esm"],
  platform: "node",
  target: "es2022",
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: ["@deepseek-ai/cordis", "@deepseek-ai/dsh-tools"],
  },
};

export default [lib];
```

- [ ] **Step 4: Write `cordis.patch.yml`**

```yaml
# dsh-pr-watch bundle registration.
- insert:
    - id: pr-watch
      name: dsh-pr-watch
```

- [ ] **Step 5: Write `src/index.ts`** (temporary — replaced in Task 14)

```ts
export const name = "pr-watch";
```

- [ ] **Step 6: Write `tests/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { name } from "../src/index";

describe("plugin entry", () => {
  it("exposes the bundle name", () => {
    expect(name).toBe("pr-watch");
  });
});
```

- [ ] **Step 7: Write `LICENSE`** (MIT, copyright `Shyboy0499`)

Standard MIT text, year 2026, holder `Shyboy0499`.

- [ ] **Step 8: Write `SECURITY.md`**

```markdown
# Security Policy

## Scope

`dsh-pr-watch` shells out to the GitHub CLI (`gh`) using your existing
authentication. Installing any dsh plugin executes third-party code in your
Harness environment — review the source before installing.

## Reporting a vulnerability

Do **not** open a public issue for security vulnerabilities.

Report privately via GitHub's private vulnerability reporting, or open an
advisory at:

https://github.com/Shyboy0499/dsh-pr-watch/security/advisories

## Security design

- `gh` is invoked with `child_process.execFile` using argument arrays — never a
  shell string — so command injection via tool parameters is not possible.
- The plugin never reads, stores, or transmits credentials. It relies entirely on
  the `gh` CLI's own keyring-backed authentication.
- The snapshot contains only public pull-request metadata (title, URL,
  timestamps) and is written under `$DSH_HOME` or `~/.dsh`.
- No network requests are made outside the `gh` invocations.
```

- [ ] **Step 9: Install dependencies and confirm peers resolve**

Run: `pnpm install`
Then: `ls node_modules/@deepseek-ai`
Expected: `cordis` and `dsh-tools` both present. If they are missing, add both to `devDependencies` at the same version ranges as `peerDependencies` and re-run `pnpm install`.

- [ ] **Step 10: Run the smoke test**

Run: `pnpm test`
Expected: PASS, 1 test.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold dsh-pr-watch plugin"
```

---

## Task 2: Types and constants

**Files:**

- Create: `src/types.ts`
- Test: `tests/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import {
  DEFAULT_PRUNE_DAYS,
  DEFAULT_STALE_DAYS,
  SNAPSHOT_VERSION,
  emptySnapshot,
  prKey,
} from "../src/types";

describe("types", () => {
  it("exposes the documented defaults", () => {
    expect(SNAPSHOT_VERSION).toBe(1);
    expect(DEFAULT_STALE_DAYS).toBe(14);
    expect(DEFAULT_PRUNE_DAYS).toBe(90);
  });

  it("keys a pull request as owner/repo#number", () => {
    expect(prKey({ nameWithOwner: "octo/repo", number: 42 })).toBe(
      "octo/repo#42",
    );
  });

  it("builds an empty snapshot", () => {
    expect(emptySnapshot()).toEqual({
      version: 1,
      lastCheck: "",
      pullRequests: {},
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/types.test.ts`
Expected: FAIL — cannot resolve `../src/types`.

- [ ] **Step 3: Write `src/types.ts`**

```ts
/** Lifecycle state of a pull request as we track it. */
export type PrState = "OPEN" | "MERGED" | "CLOSED";

/** States a pull request can reach that it never leaves. */
export type TerminalState = "MERGED" | "CLOSED";

/** One tracked pull request. */
export interface PrRecord {
  url: string;
  title: string;
  state: PrState;
  createdAt: string;
  updatedAt: string;
  /** True once staleness has been reported, so it is never reported twice. */
  staleReported: boolean;
}

/** The on-disk snapshot. */
export interface Snapshot {
  version: number;
  lastCheck: string;
  /** Keyed by `owner/repo#number` so uncloned repositories are addressable. */
  pullRequests: Record<string, PrRecord>;
}

export type DeltaKind = "merged" | "closed" | "stale" | "new" | "unresolved";

/** A single change worth reporting. */
export interface Delta {
  kind: DeltaKind;
  key: string;
  url: string;
  title: string;
  updatedAt: string;
}

export const SNAPSHOT_VERSION = 1;
export const DEFAULT_STALE_DAYS = 14;
export const DEFAULT_PRUNE_DAYS = 90;

/** Stable identity for a pull request, independent of any local checkout. */
export function prKey(ref: { nameWithOwner: string; number: number }): string {
  return `${ref.nameWithOwner}#${ref.number}`;
}

/** A fresh, empty snapshot. */
export function emptySnapshot(): Snapshot {
  return { version: SNAPSHOT_VERSION, lastCheck: "", pullRequests: {} };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/types.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat: add core types and defaults"
```

---

## Task 3: Pure test fixtures

**Files:**

- Create: `tests/fixtures.ts`

No test of its own — it exists to keep the delta tests readable.

- [ ] **Step 1: Write `tests/fixtures.ts`**

```ts
import type { PrRecord, Snapshot } from "../src/types";
import { SNAPSHOT_VERSION } from "../src/types";

/** A fixed clock. Every pure test uses this so results never depend on wall time. */
export const NOW = new Date("2026-09-10T00:00:00Z");

const MS_PER_DAY = 86_400_000;

/** An ISO timestamp `days` before NOW. */
export function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();
}

/** A pull request record with sensible defaults. */
export function record(overrides: Partial<PrRecord> = {}): PrRecord {
  return {
    url: "https://github.com/octo/repo/pull/1",
    title: "A pull request",
    state: "OPEN",
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
    staleReported: false,
    ...overrides,
  };
}

/** A snapshot containing the given records. */
export function snapshot(
  pullRequests: Record<string, PrRecord> = {},
): Snapshot {
  return { version: SNAPSHOT_VERSION, lastCheck: daysAgo(1), pullRequests };
}
```

- [ ] **Step 2: Typecheck it**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures.ts
git commit -m "test: add shared fixtures for pure tests"
```

---

## Task 4: `diff()` — merged and closed detection

The load-bearing behaviour: a PR that left the open set and resolved to a terminal
state must be reported exactly once.

**Files:**

- Create: `src/delta.ts`
- Test: `tests/delta.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { diff } from "../src/delta";
import { NOW, record, snapshot } from "./fixtures";

describe("diff — terminal transitions", () => {
  it("reports a merge and records the terminal state", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });
    const resolved = new Map([["octo/repo#1", "MERGED" as const]]);

    const { deltas, next } = diff(prev, {}, resolved, NOW);

    expect(deltas).toEqual([
      {
        kind: "merged",
        key: "octo/repo#1",
        url: "https://github.com/octo/repo/pull/1",
        title: "A pull request",
        updatedAt: record().updatedAt,
      },
    ]);
    expect(next.pullRequests["octo/repo#1"].state).toBe("MERGED");
  });

  it("reports a close without merge distinctly from a merge", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });
    const resolved = new Map([["octo/repo#1", "CLOSED" as const]]);

    const { deltas, next } = diff(prev, {}, resolved, NOW);

    expect(deltas).toHaveLength(1);
    expect(deltas[0].kind).toBe("closed");
    expect(next.pullRequests["octo/repo#1"].state).toBe("CLOSED");
  });

  it("never re-reports a pull request already in a terminal state", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "MERGED" }) });

    const { deltas, next } = diff(prev, {}, new Map(), NOW);

    expect(deltas).toEqual([]);
    expect(next.pullRequests["octo/repo#1"].state).toBe("MERGED");
  });

  it("records the check time on the next snapshot", () => {
    const { next } = diff(snapshot(), {}, new Map(), NOW);
    expect(next.lastCheck).toBe(NOW.toISOString());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/delta.test.ts`
Expected: FAIL — cannot resolve `../src/delta`.

- [ ] **Step 3: Write `src/delta.ts`**

```ts
import {
  DEFAULT_PRUNE_DAYS,
  DEFAULT_STALE_DAYS,
  SNAPSHOT_VERSION,
  type Delta,
  type DeltaKind,
  type PrRecord,
  type Snapshot,
  type TerminalState,
} from "./types";

const MS_PER_DAY = 86_400_000;

export interface DiffOptions {
  staleDays?: number;
}

export interface DiffResult {
  deltas: Delta[];
  /** The snapshot that should replace `prev` after this check. */
  next: Snapshot;
}

/** Whole days between an ISO timestamp and `now`. Unparseable input counts as 0. */
function ageInDays(iso: string, now: Date): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return (now.getTime() - then) / MS_PER_DAY;
}

function toDelta(kind: DeltaKind, key: string, source: PrRecord): Delta {
  return {
    kind,
    key,
    url: source.url,
    title: source.title,
    updatedAt: source.updatedAt,
  };
}

/**
 * Compute the changes since the previous check, and the snapshot to store next.
 *
 * `open` is keyed the same way as `prev.pullRequests`. `resolved` carries the
 * terminal state of every snapshot entry that left the open set and could be
 * resolved; a departure missing from `resolved` stays OPEN and is reported as
 * `unresolved` so the next check retries it.
 */
export function diff(
  prev: Snapshot,
  open: Record<string, PrRecord>,
  resolved: Map<string, TerminalState>,
  now: Date,
  options: DiffOptions = {},
): DiffResult {
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const deltas: Delta[] = [];
  const next: Record<string, PrRecord> = {};
  const stillOpen: Record<string, PrRecord> = { ...open };

  for (const [key, previous] of Object.entries(prev.pullRequests)) {
    if (previous.state !== "OPEN") {
      next[key] = previous;
      continue;
    }

    const fresh = stillOpen[key];
    if (fresh !== undefined) {
      delete stillOpen[key];
      const age = ageInDays(fresh.updatedAt, now);
      const isStale = age >= staleDays;
      const staleReported =
        fresh.updatedAt === previous.updatedAt ? previous.staleReported : false;
      if (isStale && !staleReported) {
        deltas.push(toDelta("stale", key, fresh));
        next[key] = { ...fresh, staleReported: true };
      } else {
        next[key] = { ...fresh, staleReported };
      }
      continue;
    }

    const terminal = resolved.get(key);
    if (terminal === undefined) {
      deltas.push(toDelta("unresolved", key, previous));
      next[key] = previous;
      continue;
    }
    deltas.push(
      toDelta(terminal === "MERGED" ? "merged" : "closed", key, previous),
    );
    next[key] = { ...previous, state: terminal };
  }

  return {
    deltas,
    next: {
      version: SNAPSHOT_VERSION,
      lastCheck: now.toISOString(),
      pullRequests: next,
    },
  };
}

/**
 * Drop terminal entries whose last activity is older than `pruneDays`.
 *
 * GitHub advances `updatedAt` when a pull request merges or closes, so this is
 * effectively "terminal for more than `pruneDays`". Open entries are never
 * pruned regardless of age.
 */
export function pruneTerminal(
  snapshot: Snapshot,
  now: Date,
  pruneDays: number = DEFAULT_PRUNE_DAYS,
): Snapshot {
  const kept: Record<string, PrRecord> = {};
  for (const [key, item] of Object.entries(snapshot.pullRequests)) {
    if (item.state !== "OPEN" && ageInDays(item.updatedAt, now) > pruneDays)
      continue;
    kept[key] = item;
  }
  return { ...snapshot, pullRequests: kept };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/delta.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/delta.ts tests/delta.test.ts
git commit -m "feat: detect merged and closed pull requests in diff"
```

---

## Task 5: `diff()` — staleness fires once, and resets on activity

**Files:**

- Modify: `src/delta.ts` (already written in Task 4 — no change needed)
- Modify: `tests/delta.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

```ts
describe("diff — staleness", () => {
  it("reports a pull request that just crossed the threshold", () => {
    const stale = record({ updatedAt: daysAgo(20) });
    const prev = snapshot({ "octo/repo#1": stale });

    const { deltas, next } = diff(
      prev,
      { "octo/repo#1": stale },
      new Map(),
      NOW,
    );

    expect(deltas).toEqual([
      { ...toDeltaShape("stale"), updatedAt: stale.updatedAt },
    ]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(true);
  });

  it("stays silent for a pull request already reported stale", () => {
    const stale = record({ updatedAt: daysAgo(20), staleReported: true });
    const prev = snapshot({ "octo/repo#1": stale });

    const { deltas } = diff(prev, { "octo/repo#1": stale }, new Map(), NOW);

    expect(deltas).toEqual([]);
  });

  it("stays silent below the threshold", () => {
    const fresh = record({ updatedAt: daysAgo(3) });
    const prev = snapshot({ "octo/repo#1": fresh });

    const { deltas } = diff(prev, { "octo/repo#1": fresh }, new Map(), NOW);

    expect(deltas).toEqual([]);
  });

  it("honours a staleDays override", () => {
    const fresh = record({ updatedAt: daysAgo(3) });
    const prev = snapshot({ "octo/repo#1": fresh });

    const { deltas } = diff(prev, { "octo/repo#1": fresh }, new Map(), NOW, {
      staleDays: 2,
    });

    expect(deltas).toHaveLength(1);
    expect(deltas[0].kind).toBe("stale");
  });

  it("resets the stale flag when the pull request saw new activity", () => {
    const previouslyStale = record({
      updatedAt: daysAgo(20),
      staleReported: true,
    });
    const nudge = record({ updatedAt: daysAgo(1) });
    const prev = snapshot({ "octo/repo#1": previouslyStale });

    const { deltas, next } = diff(
      prev,
      { "octo/repo#1": nudge },
      new Map(),
      NOW,
    );

    expect(deltas).toEqual([]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(false);
  });

  it("re-reports a nudged pull request that goes stale again", () => {
    const previouslyStale = record({
      updatedAt: daysAgo(40),
      staleReported: true,
    });
    const nudge = record({ updatedAt: daysAgo(20) });
    const prev = snapshot({ "octo/repo#1": previouslyStale });

    const { deltas, next } = diff(
      prev,
      { "octo/repo#1": nudge },
      new Map(),
      NOW,
    );

    expect(deltas).toHaveLength(1);
    expect(deltas[0].kind).toBe("stale");
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(true);
  });
});
```

Add this helper at the top of the file, beside the imports:

```ts
function toDeltaShape(kind: string) {
  return {
    kind,
    key: "octo/repo#1",
    url: "https://github.com/octo/repo/pull/1",
    title: "A pull request",
  };
}
```

Add `daysAgo` to the existing `./fixtures` import.

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm vitest run tests/delta.test.ts`
Expected: PASS, 10 tests.

The implementation from Task 4 already covers all six cases — this task is
verification, not new code. If any case fails, the bug is in the
`staleReported`/`staleReported` reset expression in `diff`, not in the test.

- [ ] **Step 3: Commit**

```bash
git add tests/delta.test.ts
git commit -m "test: cover staleness transition and reset on activity"
```

---

## Task 6: `diff()` — new, unresolved, and carry-forward

**Files:**

- Modify: `tests/delta.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

```ts
describe("diff — new and unresolved", () => {
  it("reports a newly noticed pull request", () => {
    const fresh = record({ updatedAt: daysAgo(2) });
    const { deltas, next } = diff(
      snapshot(),
      { "octo/repo#1": fresh },
      new Map(),
      NOW,
    );

    expect(deltas).toEqual([
      { ...toDeltaShape("new"), updatedAt: fresh.updatedAt },
    ]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(false);
  });

  it("does not double-report a newly noticed pull request that is already stale", () => {
    const old = record({ updatedAt: daysAgo(30) });
    const { deltas, next } = diff(
      snapshot(),
      { "octo/repo#1": old },
      new Map(),
      NOW,
    );

    expect(deltas.map((d) => d.kind)).toEqual(["new"]);
    expect(next.pullRequests["octo/repo#1"].staleReported).toBe(true);
  });

  it("reports an unresolvable departure and keeps it open for the next check", () => {
    const prev = snapshot({ "octo/repo#1": record({ state: "OPEN" }) });

    const { deltas, next } = diff(prev, {}, new Map(), NOW);

    expect(deltas.map((d) => d.kind)).toEqual(["unresolved"]);
    expect(next.pullRequests["octo/repo#1"].state).toBe("OPEN");
  });

  it("leaves an untouched open pull request untouched", () => {
    const same = record({ updatedAt: daysAgo(2) });
    const prev = snapshot({ "octo/repo#1": same });

    const { deltas, next } = diff(
      prev,
      { "octo/repo#1": same },
      new Map(),
      NOW,
    );

    expect(deltas).toEqual([]);
    expect(next.pullRequests["octo/repo#1"]).toEqual(same);
  });

  it("refreshes metadata for a still-open pull request", () => {
    const prev = snapshot({ "octo/repo#1": record({ title: "Old title" }) });
    const renamed = record({ title: "New title", updatedAt: daysAgo(2) });

    const { next } = diff(prev, { "octo/repo#1": renamed }, new Map(), NOW);

    expect(next.pullRequests["octo/repo#1"].title).toBe("New title");
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm vitest run tests/delta.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 3: Commit**

```bash
git add tests/delta.test.ts
git commit -m "test: cover newly noticed, unresolved, and carry-forward cases"
```

---

## Task 7: `pruneTerminal()`

**Files:**

- Modify: `tests/delta.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

```ts
describe("pruneTerminal", () => {
  it("drops a terminal entry older than the prune window", () => {
    const input = snapshot({
      "octo/repo#1": record({ state: "MERGED", updatedAt: daysAgo(120) }),
    });

    const result = pruneTerminal(input, NOW);

    expect(result.pullRequests).toEqual({});
  });

  it("keeps a recent terminal entry", () => {
    const input = snapshot({
      "octo/repo#1": record({ state: "MERGED", updatedAt: daysAgo(10) }),
    });

    const result = pruneTerminal(input, NOW);

    expect(Object.keys(result.pullRequests)).toEqual(["octo/repo#1"]);
  });

  it("never prunes an open entry however old", () => {
    const input = snapshot({
      "octo/repo#1": record({ state: "OPEN", updatedAt: daysAgo(500) }),
    });

    const result = pruneTerminal(input, NOW);

    expect(Object.keys(result.pullRequests)).toEqual(["octo/repo#1"]);
  });

  it("honours a pruneDays override", () => {
    const input = snapshot({
      "octo/repo#1": record({ state: "CLOSED", updatedAt: daysAgo(10) }),
    });

    expect(pruneTerminal(input, NOW, 5).pullRequests).toEqual({});
  });
});
```

Add `pruneTerminal` to the `../src/delta` import.

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm vitest run tests/delta.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 3: Commit**

```bash
git add tests/delta.test.ts
git commit -m "test: cover terminal pruning"
```

---

## Task 8: `snapshotPath()` resolution — ✅ done (merged as #16)

**Files:**

- Create: `src/snapshot.ts`
- Test: `tests/snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { snapshotPath } from "../src/snapshot";

const original = process.env.DSH_HOME;
afterEach(() => {
  if (original === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = original;
});

describe("snapshotPath", () => {
  it("prefers DSH_HOME when set", () => {
    process.env.DSH_HOME = "/tmp/dsh-home";
    expect(snapshotPath()).toBe(
      join("/tmp/dsh-home", "pr-watch", "snapshot.json"),
    );
  });

  it("falls back to ~/.dsh when DSH_HOME is unset", () => {
    delete process.env.DSH_HOME;
    expect(snapshotPath()).toBe(
      join(homedir(), ".dsh", "pr-watch", "snapshot.json"),
    );
  });

  it("falls back to ~/.dsh when DSH_HOME is blank", () => {
    process.env.DSH_HOME = "   ";
    expect(snapshotPath()).toBe(
      join(homedir(), ".dsh", "pr-watch", "snapshot.json"),
    );
  });

  it("rejects a relative DSH_HOME", () => {
    process.env.DSH_HOME = "relative/dir";
    expect(() => snapshotPath()).toThrow(/absolute/);
  });

  it("rejects whitespace padding before reporting the absolute-path problem", () => {
    // Padding is what makes an absolute path read as relative, so the diagnosis
    // must name the padding rather than the absoluteness.
    process.env.DSH_HOME = " /tmp/dsh-home";
    expect(() => snapshotPath()).toThrow(/whitespace/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/snapshot.test.ts`
Expected: FAIL — cannot resolve `../src/snapshot`.

- [ ] **Step 3: Write `src/snapshot.ts`**

```ts
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { SNAPSHOT_VERSION, emptySnapshot, type Snapshot } from "./types";

/**
 * Where the snapshot lives: `$DSH_HOME/pr-watch/snapshot.json`, else `~/.dsh/...`.
 *
 * Pure: both inputs are arguments, so every case is testable without touching the
 * real environment or the real home directory.
 *
 * Rejections, each stating its reason in the message:
 *
 * - leading or trailing whitespace -> throw. Almost always a quoting accident, and
 *   trimming would read and write a different location than the one written down.
 *   Checked BEFORE absoluteness, because padding is what makes an absolute path
 *   look relative -- the wrong error fires first otherwise.
 * - a relative path -> throw. It would resolve against the working directory, so
 *   the same configuration would select different snapshots depending on where the
 *   plugin was launched.
 * - an empty home directory with no `DSH_HOME` -> throw, rather than produce a path
 *   containing `undefined`.
 *
 * Carries no override argument: the README records the path as not settable in v1,
 * and a pure function with arguments gives tests the injection an override existed
 * for, without a parameter that exists only for them.
 */
export function resolveSnapshotPath(
  dshHome: string | undefined,
  homeDirectory: string,
): string {
  const segments = ["pr-watch", "snapshot.json"];

  if (dshHome === undefined || dshHome.trim() === "") {
    if (homeDirectory.trim() === "") {
      throw new Error(
        "Cannot resolve the snapshot path: the home directory is empty and DSH_HOME is not set.",
      );
    }
    return join(homeDirectory, ".dsh", ...segments);
  }

  if (dshHome.trim() !== dshHome) {
    throw new Error(
      `DSH_HOME has leading or trailing whitespace, which is almost always a quoting mistake: "${dshHome}".`,
    );
  }

  if (!isAbsolute(dshHome)) {
    throw new Error(
      `DSH_HOME must be an absolute path, got "${dshHome}". A relative path would select a different snapshot depending on the working directory.`,
    );
  }

  return join(dshHome, ...segments);
}

/** The only place the environment and the home directory are read. */
export function snapshotPath(): string {
  return resolveSnapshotPath(process.env.DSH_HOME, homedir());
}

export interface LoadResult {
  snapshot: Snapshot;
  /** Set when the previous snapshot was unusable and had to be quarantined. */
  warning: string | null;
}

/** Read the snapshot, tolerating a missing file and quarantining a corrupt one. */
export async function loadSnapshot(path: string): Promise<LoadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { snapshot: emptySnapshot(), warning: null };
    }
    throw err;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Snapshot> | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof parsed.pullRequests !== "object" ||
      parsed.pullRequests === null
    ) {
      throw new Error("snapshot shape is invalid");
    }
    return {
      snapshot: {
        version:
          typeof parsed.version === "number"
            ? parsed.version
            : SNAPSHOT_VERSION,
        lastCheck: typeof parsed.lastCheck === "string" ? parsed.lastCheck : "",
        pullRequests: parsed.pullRequests,
      },
      warning: null,
    };
  } catch {
    const quarantinePath = await quarantine(path);
    return {
      snapshot: emptySnapshot(),
      warning:
        `Snapshot at ${path} was unreadable and has been moved to ${quarantinePath}. ` +
        "Every open pull request will be reported as newly noticed.",
    };
  }
}

/** Move the bad snapshot aside, never destroying it, and return the new path. */
async function quarantine(path: string): Promise<string> {
  for (let n = 1; ; n += 1) {
    const target = `${path}.corrupt-${n}`;
    try {
      await access(target);
    } catch {
      await rename(path, target);
      return target;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/snapshot.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/snapshot.ts tests/snapshot.test.ts
git commit -m "feat: resolve snapshot path from DSH_HOME or ~/.dsh"
```

---

## Task 9: `loadSnapshot()` corruption recovery

**Files:**

- Modify: `tests/snapshot.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadSnapshot } from "../src/snapshot";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "dsh-pr-watch-"));
}

describe("loadSnapshot", () => {
  it("starts empty when no snapshot exists", async () => {
    const dir = tempDir();
    try {
      const { snapshot, warning } = await loadSnapshot(
        join(dir, "snapshot.json"),
      );
      expect(snapshot.pullRequests).toEqual({});
      expect(warning).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a valid snapshot", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, "snapshot.json");
      const stored = {
        version: 1,
        lastCheck: "2026-09-01T00:00:00Z",
        pullRequests: { "o/r#1": record() },
      };
      writeFileSync(path, JSON.stringify(stored));
      const { snapshot, warning } = await loadSnapshot(path);
      expect(snapshot).toEqual(stored);
      expect(warning).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("quarantines unparseable JSON and warns", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, "snapshot.json");
      writeFileSync(path, "{ this is not json");
      const { snapshot, warning } = await loadSnapshot(path);

      expect(snapshot.pullRequests).toEqual({});
      expect(warning).toContain("was unreadable");
      expect(warning).toContain("snapshot.json.corrupt-1");
      expect(readFileSync(`${path}.corrupt-1`, "utf8")).toBe(
        "{ this is not json",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("quarantines a structurally invalid snapshot", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, "snapshot.json");
      writeFileSync(path, JSON.stringify({ version: 1, pullRequests: null }));
      const { warning } = await loadSnapshot(path);
      expect(warning).toContain("was unreadable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("picks the next free quarantine name", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, "snapshot.json");
      writeFileSync(`${path}.corrupt-1`, "older");
      writeFileSync(path, "broken");
      const { warning } = await loadSnapshot(path);

      expect(warning).toContain("snapshot.json.corrupt-2");
      expect(readFileSync(`${path}.corrupt-1`, "utf8")).toBe("older");
      expect(readFileSync(`${path}.corrupt-2`, "utf8")).toBe("broken");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Add `import { record } from "./fixtures";` to the file's imports.

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm vitest run tests/snapshot.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 3: Commit**

```bash
git add tests/snapshot.test.ts
git commit -m "test: cover snapshot corruption quarantine"
```

---

## Task 10: `saveSnapshot()` atomic write

**Files:**

- Modify: `src/snapshot.ts` (append)
- Modify: `tests/snapshot.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

```ts
import { existsSync, readdirSync } from "node:fs";
import { saveSnapshot } from "../src/snapshot";

describe("saveSnapshot", () => {
  it("creates missing parent directories and writes the snapshot", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, "nested", "pr-watch", "snapshot.json");
      await saveSnapshot(path, snapshot({ "o/r#1": record() }));

      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(written.pullRequests["o/r#1"].title).toBe("A pull request");
      expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no temporary file behind", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, "snapshot.json");
      await saveSnapshot(path, snapshot());

      expect(existsSync(path)).toBe(true);
      expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overwrites an existing snapshot in place", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, "snapshot.json");
      await saveSnapshot(
        path,
        snapshot({ "o/r#1": record({ title: "First" }) }),
      );
      await saveSnapshot(
        path,
        snapshot({ "o/r#1": record({ title: "Second" }) }),
      );

      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(written.pullRequests["o/r#1"].title).toBe("Second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Add `snapshot` to the `./fixtures` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/snapshot.test.ts`
Expected: FAIL — `saveSnapshot` is not exported.

- [ ] **Step 3: Append to `src/snapshot.ts`**

```ts
/**
 * Write the snapshot atomically: a temporary file in the same directory is
 * renamed over the target, so a crash mid-write can never leave a truncated
 * snapshot that reads as "every pull request vanished".
 */
export async function saveSnapshot(
  path: string,
  data: Snapshot,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/snapshot.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/snapshot.ts tests/snapshot.test.ts
git commit -m "feat: write snapshot atomically"
```

---

## Task 11: `gh-exec.ts` — pure mapping and argument builders

**Files:**

- Create: `src/gh-exec.ts`
- Test: `tests/gh-exec.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import {
  friendlyGhMessage,
  ghSearchOpenArgs,
  ghViewArgs,
  toPrKey,
  toPrRecord,
  toTerminalState,
} from "../src/gh-exec";

describe("argument builders", () => {
  it("builds the open-pull-request search arguments", () => {
    expect(ghSearchOpenArgs()).toEqual([
      "search",
      "prs",
      "--author",
      "@me",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "url,title,state,createdAt,updatedAt,number,repository",
    ]);
  });

  it("builds the single-pull-request view arguments", () => {
    expect(ghViewArgs("https://github.com/octo/repo/pull/7")).toEqual([
      "pr",
      "view",
      "https://github.com/octo/repo/pull/7",
      "--json",
      "state,mergedAt",
    ]);
  });
});

describe("record mapping", () => {
  const raw = {
    url: "https://github.com/octo/repo/pull/7",
    title: "Add a thing",
    state: "OPEN",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    number: 7,
    repository: { nameWithOwner: "octo/repo" },
  };

  it("keys by owner/repo#number", () => {
    expect(toPrKey(raw)).toBe("octo/repo#7");
  });

  it("maps to an open record that has not reported staleness", () => {
    expect(toPrRecord(raw)).toEqual({
      url: raw.url,
      title: raw.title,
      state: "OPEN",
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      staleReported: false,
    });
  });

  it("maps resolved states, rejecting anything still open", () => {
    expect(toTerminalState("MERGED")).toBe("MERGED");
    expect(toTerminalState("CLOSED")).toBe("CLOSED");
    expect(toTerminalState("OPEN")).toBeUndefined();
  });
});

describe("friendlyGhMessage", () => {
  it("recognises an authentication failure", () => {
    expect(
      friendlyGhMessage(
        "gh: To get started with GitHub CLI, run gh auth login",
        "boom",
      ),
    ).toContain("gh auth login");
  });

  it("recognises a rate limit", () => {
    expect(
      friendlyGhMessage("API rate limit exceeded for user ID 1.", "boom"),
    ).toContain("rate limit");
  });

  it("falls back to the last lines of stderr", () => {
    expect(friendlyGhMessage("line one\nline two", "boom")).toBe(
      "line one\nline two",
    );
  });

  it("falls back to the provided message when stderr is empty", () => {
    expect(friendlyGhMessage("   ", "boom")).toBe("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/gh-exec.test.ts`
Expected: FAIL — cannot resolve `../src/gh-exec`.

- [ ] **Step 3: Write `src/gh-exec.ts`**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prKey, type PrRecord, type TerminalState } from "./types";

const execFileAsync = promisify(execFile);

export class GhError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, exitCode: number | null, stderr = "") {
    super(message);
    this.name = "GhError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface GhExecOptions {
  /** Overrides merged over the process environment. Used by tests. */
  env?: NodeJS.ProcessEnv;
}

/** Turn raw `gh` stderr into something worth showing a user. */
export function friendlyGhMessage(stderr: string, fallback: string): string {
  const text = stderr.trim();
  if (/gh auth login|not logged in|authentication|HTTP 401/i.test(text)) {
    return "GitHub CLI is not authenticated. Run `gh auth login` and retry.";
  }
  if (/rate limit/i.test(text)) {
    return `GitHub API rate limit reached. ${lastLines(text)}`;
  }
  return lastLines(text) || fallback;
}

function lastLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-3)
    .join("\n");
}

/**
 * Run `gh` with an argument array — never a shell string, so parameters cannot
 * be injected into a command line. Returns stdout.
 */
export async function ghExec(
  args: string[],
  signal?: AbortSignal,
  options: GhExecOptions = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        NO_COLOR: "1",
        ...options.env,
      },
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).name === "AbortError") throw err;
    const failure = err as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT") {
      throw new GhError(
        "The GitHub CLI (gh) was not found on PATH. Install it from https://cli.github.com and run `gh auth login`.",
        null,
      );
    }
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    throw new GhError(
      friendlyGhMessage(stderr, failure.message ?? String(err)),
      typeof failure.code === "number" ? failure.code : null,
      stderr,
    );
  }
}

/** Run `gh` and parse stdout as JSON. */
export async function ghJson<T>(
  args: string[],
  signal?: AbortSignal,
  options: GhExecOptions = {},
): Promise<T> {
  const stdout = await ghExec(args, signal, options);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new GhError(
      "GitHub CLI returned output that was not valid JSON.",
      null,
      stdout,
    );
  }
}

/** Arguments listing every open pull request authored by the current user. */
export function ghSearchOpenArgs(): string[] {
  return [
    "search",
    "prs",
    "--author",
    "@me",
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "url,title,state,createdAt,updatedAt,number,repository",
  ];
}

/** Arguments resolving the terminal state of one pull request. */
export function ghViewArgs(url: string): string[] {
  return ["pr", "view", url, "--json", "state,mergedAt"];
}

/** The subset of `gh search prs --json` output this plugin reads. */
export interface RawSearchPr {
  url: string;
  title: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  number: number;
  repository: { nameWithOwner: string };
}

/** Detail returned by `gh pr view --json state,mergedAt`. */
export interface RawPrDetail {
  state: string;
  mergedAt: string | null;
}

export function toPrKey(raw: {
  repository: { nameWithOwner: string };
  number: number;
}): string {
  return prKey({
    nameWithOwner: raw.repository.nameWithOwner,
    number: raw.number,
  });
}

export function toPrRecord(raw: RawSearchPr): PrRecord {
  return {
    url: raw.url,
    title: raw.title,
    state: "OPEN",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    staleReported: false,
  };
}

/** `gh` reports an unreachable state as something else; only terminals count. */
export function toTerminalState(raw: string): TerminalState | undefined {
  if (raw === "MERGED") return "MERGED";
  if (raw === "CLOSED") return "CLOSED";
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/gh-exec.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/gh-exec.ts tests/gh-exec.test.ts
git commit -m "feat: add gh invocation helpers and record mapping"
```

---

## Task 12: `ghExec` process behaviour

These tests exercise the real `gh` binary but **never the network** — `--version`
and an unknown subcommand both resolve locally. GitHub-hosted runners ship `gh`
preinstalled.

**Files:**

- Modify: `tests/gh-exec.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

```ts
import { GhError, ghExec, ghJson } from "../src/gh-exec";

describe("ghExec", () => {
  it("returns stdout for a local command", async () => {
    await expect(ghExec(["--version"])).resolves.toMatch(/^gh version /);
  });

  it("reports a missing binary with install instructions", async () => {
    await expect(
      ghExec(["--version"], undefined, { env: { PATH: "" } }),
    ).rejects.toMatchObject({
      name: "GhError",
      message: expect.stringContaining("https://cli.github.com"),
    });
  });

  it("carries the exit code and stderr on a failed command", async () => {
    try {
      await ghExec(["this-is-not-a-real-subcommand"]);
      expect.fail("ghExec should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GhError);
      expect((err as GhError).exitCode).toBeTypeOf("number");
      expect((err as GhError).stderr.length).toBeGreaterThan(0);
    }
  });

  it("rejects with AbortError, not GhError, when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      ghExec(["--version"], controller.signal),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("ghJson", () => {
  it("throws GhError when stdout is not JSON", async () => {
    try {
      await ghJson(["--version"]);
      expect.fail("ghJson should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GhError);
      expect((err as GhError).message).toContain("not valid JSON");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm vitest run tests/gh-exec.test.ts`
Expected: PASS, 16 tests.

If the `PATH: ""` case does not produce `ENOENT`, the cause is that `execFile`
resolved `gh` before consulting the override. In that case pass an explicit
non-existent binary through a new optional `bin` field on `GhExecOptions` and
have the test use it — do not weaken the assertion.

- [ ] **Step 3: Commit**

```bash
git add tests/gh-exec.test.ts
git commit -m "test: cover gh process behaviour and error mapping"
```

---

## Task 13: Pure rendering

**Files:**

- Create: `src/tools/watch.ts` (render half)
- Test: `tests/render.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { renderWatch, type WatchValue } from "../src/tools/watch";

function value(overrides: Partial<WatchValue> = {}): WatchValue {
  return {
    checkedAt: "2026-09-10T00:00:00Z",
    openCount: 0,
    deltas: [],
    warning: null,
    open: [],
    ...overrides,
  };
}

const merged = {
  kind: "merged" as const,
  key: "octo/repo#1",
  url: "https://github.com/octo/repo/pull/1",
  title: "Add a thing",
  updatedAt: "2026-09-09T00:00:00Z",
};

describe("renderWatch", () => {
  it("says so when nothing changed", () => {
    expect(renderWatch(value({ openCount: 3 }), false)).toContain(
      "No changes since the last check",
    );
  });

  it("groups deltas under a labelled heading", () => {
    const text = renderWatch(value({ deltas: [merged] }), false);
    expect(text).toContain("Merged (1):");
    expect(text).toContain("octo/repo#1 — Add a thing");
    expect(text).toContain("1 day ago");
  });

  it("groups adjacent deltas of the same kind, in the order it receives them", () => {
    // `diff` returns deltas already totally ordered, so the renderer walks that
    // order rather than imposing one. It groups runs: same-kind deltas must be
    // adjacent in the input, and the output follows the input order.
    const deltas = [
      { ...merged, kind: "merged" as const, key: "octo/repo#1" },
      { ...merged, kind: "merged" as const, key: "octo/repo#2" },
      { ...merged, kind: "unresolved" as const, key: "octo/repo#3" },
      { ...merged, kind: "new" as const, key: "octo/repo#4" },
    ];
    const text = renderWatch(value({ deltas }), false);

    expect(text).toContain("Merged (2):");
    expect(text.indexOf("Merged (2):")).toBeLessThan(
      text.indexOf("Could not resolve (1):"),
    );
    expect(text.indexOf("Could not resolve (1):")).toBeLessThan(
      text.indexOf("Newly noticed (1):"),
    );
  });

  it("surfaces the warning before anything else", () => {
    const text = renderWatch(
      value({ warning: "Snapshot was unreadable." }),
      false,
    );
    expect(text.indexOf("Snapshot was unreadable.")).toBe(0);
  });

  it("lists open pull requests in all mode", () => {
    const text = renderWatch(
      value({
        openCount: 1,
        open: [
          {
            key: "octo/repo#2",
            title: "Second",
            url: "https://github.com/octo/repo/pull/2",
            updatedAt: "2026-08-01T00:00:00Z",
          },
        ],
      }),
      true,
    );
    expect(text).toContain("Open pull requests (1)");
    expect(text).toContain("octo/repo#2 — Second");
    expect(text).toContain("40 days ago");
  });

  it("says none when all mode has no open pull requests", () => {
    expect(renderWatch(value(), true)).toContain("(none)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/render.test.ts`
Expected: FAIL — cannot resolve `../src/tools/watch`.

- [ ] **Step 3: Write `src/tools/watch.ts` with the render half only**

```ts
import type { Delta } from "../types";

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

  // `diff` already returns deltas in a total order: kind by severity, then key,
  // then most recent activity. The report is therefore built by walking that
  // order and grouping runs of the same kind.
  //
  // Declaring a display order here as well would be a second source of truth for
  // the same decision. The two could disagree -- as they briefly did, when this
  // step ordered `stale` above `unresolved` while `diff` ordered them the other
  // way -- and nothing would fail, because each is internally consistent. One
  // order, owned by the layer that computes the deltas.
  let index = 0;
  while (index < value.deltas.length) {
    const kind = value.deltas[index].kind;
    const group: Delta[] = [];
    while (index < value.deltas.length && value.deltas[index].kind === kind) {
      group.push(value.deltas[index]);
      index += 1;
    }
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/render.test.ts`
Expected: PASS. If the grouping case fails, the renderer is not grouping adjacent
runs — check that it walks `value.deltas` in order rather than filtering per kind.

- [ ] **Step 5: Commit**

```bash
git add src/tools/watch.ts tests/render.test.ts
git commit -m "feat: render watch results as grouped text"
```

---

## Task 14: The `pr_watch` tool

**Files:**

- Modify: `src/tools/watch.ts` (append the tool)
- Modify: `src/index.ts` (register)

- [ ] **Step 1: Append the tool to `src/tools/watch.ts`**

```ts
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
  type PrRecord,
  type TerminalState,
} from "../types";

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
```

Move the existing `import type { Delta } from "../types";` line so the file has a
single import block from `../types` — combine `Delta` into the block above.

- [ ] **Step 2: Replace `src/index.ts`**

```ts
import type { Context } from "@deepseek-ai/cordis";
import { prWatchTool } from "./tools/watch";

export const name = "pr-watch";
export const inject = ["tools"];

export function apply(ctx: Context) {
  ctx.tools.register(prWatchTool);
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS, all tests. No network calls.

- [ ] **Step 5: Commit**

```bash
git add src/tools/watch.ts src/index.ts
git commit -m "feat: add pr_watch tool"
```

---

## Task 15: Build, lint, document, and push

**Files:**

- Create: `README.md`
- Modify: any file flagged by lint or format

- [ ] **Step 1: Verify the build produces a loadable entry**

Run: `pnpm build && node -e "import('./lib/index.js').then(m => console.log('name:', m.name, '| inject:', JSON.stringify(m.inject), '| apply:', typeof m.apply))"`
Expected: `name: pr-watch | inject: ["tools"] | apply: function`

- [ ] **Step 2: Lint and format**

Run: `pnpm lint && pnpm format`
Expected: no lint errors. Fix anything reported; re-run until clean.

- [ ] **Step 3: Write `README.md`**

> **Note:** `README.md` and `LICENSE` were already committed before implementation
> began. Skip writing them; instead **verify** the existing README still satisfies
> the requirements below once the real output is known, and update any sample
> output that no longer matches `renderWatch()`.

Must contain, at minimum: what the tool does; the two-phase fetch explained in
one short paragraph; a usage example; the configuration table (`staleDays`
default 14, `pruneDays` default 90, snapshot at `$DSH_HOME/pr-watch/snapshot.json`);
the requirement that `gh` is installed and authenticated; the "reported once,
then silent" behaviour stated plainly; and the Known limitations section from the
spec, including that a PR opened and merged between two checks is invisible.

- [ ] **Step 4: Re-run everything**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: all clean.

- [ ] **Step 5: Commit and push**

```bash
git add -A
git commit -m "docs: add README and apply formatting

Co-authored-by: jingchangzhao-gif <252637410+jingchangzhao-gif@users.noreply.github.com>"
git push
```

---

## Self-review

**Spec coverage:**

| Spec section                                              | Task                                                    |
| --------------------------------------------------------- | ------------------------------------------------------- |
| Architecture / file layout                                | 1                                                       |
| Data model                                                | 2                                                       |
| Fetch strategy (two phases)                               | 14                                                      |
| Delta semantics — merged/closed                           | 4                                                       |
| Delta semantics — stale, once only                        | 5                                                       |
| Delta semantics — new / unresolved / silence              | 6                                                       |
| Pruning (90 days)                                         | 7                                                       |
| Snapshot location                                         | 8                                                       |
| Corruption quarantine + warning                           | 9                                                       |
| Atomic write                                              | 10                                                      |
| `gh` invocation, arg building, error mapping              | 11, 12                                                  |
| Tool surface (`staleDays`, `all`)                         | 13, 14                                                  |
| **Spec Configuration keys `ignoreRepos`, `snapshotPath`** | **Not implemented — deferred to v2. See refinement 3.** |
| Error handling — not installed / not authed / rate limit  | 11, 12                                                  |
| Error handling — fetch failure writes nothing             | 14                                                      |
| Error handling — unresolvable departure                   | 6, 14                                                   |
| Testing (no network)                                      | all test tasks                                          |

**Placeholder scan:** no TBD/TODO. Every code step carries the full code.

**Type consistency:** `diff(prev, open, resolved, now, options)` is identical in
Tasks 4–7 and its call site in Task 14. `PrRecord`, `Snapshot`, `Delta`,
`TerminalState`, `WatchValue` and `OpenEntry` each have exactly one definition.
`renderWatch(value, all)` matches between Task 13's definition and Task 14's
`render` call. `pruneTerminal(snapshot, now, pruneDays)` matches Tasks 7 and 14.

**Known gap:** Task 12 depends on `PATH: ""` forcing `ENOENT`; the fallback is
stated inline in that task rather than left implicit.
