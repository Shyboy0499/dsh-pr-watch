import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { prKey, type PrRecord, type TerminalState } from "./types";

/* -------------------------------------------------------------------------
 * Task 11 — the `gh` invocation boundary.
 *
 * This is the only module in the plugin that starts an external process, and
 * therefore the only one whose behaviour depends on the machine it runs on:
 * whether `gh` is installed, whether it is authenticated, what the proxy does,
 * how slow the network is.
 *
 * Its first duty comes straight from the README's reason for existing. The
 * naive design "fetch open pull requests" fails because an empty result looks
 * identical to a failed `gh` call -- and a failed call must never be mistaken
 * for "nothing changed", because the caller would then write a snapshot that
 * marks pending changes as already reported. So success-with-no-output and
 * failure are separate members of one union, not `string | undefined`.
 * ---------------------------------------------------------------------- */

/** How long `gh` may run before it is killed, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Upper bound on captured output, per stream.
 *
 * Not the old `execFile` `maxBuffer` behaviour: reaching this limit does not
 * kill the process or lose the output already read. The stream keeps being
 * drained so the child cannot block on a full pipe, and the truncation is
 * reported in the outcome instead of being silent.
 */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Why a `gh` call failed, as a closed set.
 *
 * `kind` exists so callers can act differently per cause -- a missing binary
 * and an expired token need different advice -- without parsing prose. It
 * complements `snapshot.ts`'s `corrupt` / `unreadable` split, which draws the
 * same kind of line between "the content was wrong" and "the environment
 * would not let us look".
 */
export type GhFailureKind =
  /** No `gh` on PATH. */
  | "not-installed"
  /** `gh` found a wrapping script it cannot execute without a shell. */
  | "shim"
  /** `gh` ran but the credential is missing or expired. */
  | "unauthenticated"
  /** DNS, connection, proxy, or TLS trouble. */
  | "network"
  /** `gh` did not finish in time and was killed. */
  | "timeout"
  /** `gh` exited non-zero for a reason the categories above do not cover. */
  | "exit"
  /** `gh` was killed by a signal. */
  | "signal"
  /** The call could not be started or its result could not be read. */
  | "unknown";

/** A completed `gh` call. */
type GhOk = {
  readonly status: "ok";
  /**
   * stdout, with line endings normalised to `\n`.
   *
   * May be empty, and an empty string here is a *result*, not a failure: it is
   * how "you have no open pull requests" arrives.
   */
  readonly stdout: string;
  readonly stderr: string;
  /** True when stdout hit {@link MAX_OUTPUT_BYTES} and was cut short. */
  readonly stdoutTruncated: boolean;
  /** True when stdout contained bytes that are not valid UTF-8. */
  readonly stdoutLossy: boolean;
};

/** A failed `gh` call. */
type GhFailure = {
  readonly status: "failed";
  readonly kind: GhFailureKind;
  /** `gh`'s exit code, when it got far enough to have one. */
  readonly exitCode: number | null;
  /** Whatever stdout arrived before the failure. Never the basis of a result. */
  readonly stdout: string;
  /** Redacted and bounded; safe to show a user. */
  readonly stderr: string;
  /** Terminating signal, when a signal ended the process. */
  readonly signal: string | null;
  /** One line of actionable English, already redacted. */
  readonly message: string;
};

/**
 * The outcome of one `gh` call.
 *
 * A discriminated union rather than a nullable string precisely so that
 * "succeeded with no output" cannot be confused with "did not succeed".
 */
export type GhOutcome = GhOk | GhFailure;

/** What the injected executor observes about one finished process. */
export interface GhProcessResult {
  /** Exit code; `null` when a signal ended the process. */
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stdoutLossy: boolean;
  /** True when the deadline passed and the process was killed. */
  readonly timedOut: boolean;
}

/**
 * Why a process could not be observed at all.
 *
 * Separate from {@link GhProcessResult} because these are the cases where there
 * was never a process: a missing binary, a spawn-level refusal.
 */
export interface GhSpawnFailure {
  /** errno from the failed spawn, e.g. `ENOENT`. */
  readonly code: string | null;
  /** The raw Node error message, still unredacted. */
  readonly message: string;
}

export interface GhExecRequest {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  /** The program to run. Injectable so tests never touch a real `gh`. */
  readonly binary: string;
}

export type GhSpawnResult =
  | { readonly ok: true; readonly process: GhProcessResult }
  | { readonly ok: false; readonly failure: GhSpawnFailure };

/**
 * The seam that makes this module testable.
 *
 * Everything above it -- classification, redaction, line-ending handling -- is
 * a pure function of what an executor returns, so the whole error taxonomy is
 * tested without a real `gh`, without a network, and without depending on what
 * the machine happens to have installed.
 */
export type GhExecutor = (request: GhExecRequest) => Promise<GhSpawnResult>;

export interface RunGhOptions {
  /** Overrides the injected executor. Tests pass a fake. */
  readonly executor?: GhExecutor;
  /** Deadline in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Extra environment entries, merged over `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Program name or path. Defaults to `gh`. */
  readonly binary?: string;
}

/* -------------------------------------------------------------------------
 * Redaction.
 *
 * `gh` writes diagnostics that can carry credentials. Nothing here may reach a
 * user's screen unexamined, and the module that talks to the program is the
 * right place to draw that line: redacting later means the secret has already
 * travelled through the program.
 * ---------------------------------------------------------------------- */

/** Replaces anything withheld. */
const MASK = "[redacted]";

/** Longest stretch of free text kept, so a diagnostic stays readable. */
const MAX_MESSAGE_CHARS = 600;

/**
 * Credential shapes, redacted before anything else looks at the text.
 *
 * Ordered longest-prefix first so `github_pat_` cannot be half-matched by a
 * shorter rule and leave a fragment behind.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bghs_\d+\.[A-Za-z0-9]{20,}/g,
  /\bxox[abpsr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // `Authorization: token …` / `Bearer …`, with or without a header name.
  /\b(authorization|proxy-authorization)\s*:\s*\S+(\s+\S+)?/gi,
  /\b(bearer|token)\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  // `https://user:secret@host` -- the credential is in the userinfo segment.
  /(?<=\/\/)[^\s/:@]+:[^\s/@]+@/g,
  // `X-Api-Key: …` and friends. `access_token` is deliberately NOT listed here:
  // a query parameter carries it, and `\S+` would run past the `&` into the
  // following parameters. SECRET_QUERY below handles it and stops at the `&`,
  // which keeps the rest of the URL readable.
  /\b(api[-_]?key|client[-_]?secret|password|passwd|secret)\s*[:=]\s*\S+/gi,
  // Anything that looks like a shell assignment of a secret-ish variable.
  /\b[A-Z_]*(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)[A-Z_]*=\S+/g,
];

/**
 * Query parameters that carry credentials, redacted value-only so the URL stays
 * diagnostic.
 */
const SECRET_QUERY =
  /([?&](?:access_token|token|api_key|apikey|key|signature|sig)=)[^&\s]+/gi;

/** Remove secret-shaped substrings, then bound the length. */
export function redact(text: string): string {
  let output = text;

  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, MASK);

  // Deliberately after the named patterns and before the catch-all below, so
  // the parameter name survives and the message stays diagnostic. Run later,
  // the long-run rule would swallow the whole URL into one withheld blob.
  output = output.replace(SECRET_QUERY, `$1${MASK}`);

  // A very long unbroken run is either a token this list does not know or a
  // base64 blob; both are safer summarised than echoed. The marker says how
  // much was dropped so the reader knows something was there.
  output = output.replace(/[A-Za-z0-9._~+/=-]{60,}/g, (run) => {
    return `${run.slice(0, 12)}…[${run.length - 12} chars withheld]`;
  });

  return output.length > MAX_MESSAGE_CHARS
    ? `${output.slice(0, MAX_MESSAGE_CHARS)}…[truncated]`
    : output;
}

/** Collapse to a single line, for a message that will be interpolated. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The last few non-empty lines of stderr, redacted and bounded. */
export function summariseStderr(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-3);
  return redact(lines.join("\n"));
}

/* -------------------------------------------------------------------------
 * Classification.
 * ---------------------------------------------------------------------- */

/** Does this stderr say the credential is missing or expired? */
function looksUnauthenticated(stderr: string): boolean {
  return /not logged into any github hosts|gh auth login|authentication failed|bad credentials|http 401|requires authentication|token.*(expired|invalid)/i.test(
    stderr,
  );
}

/** Does this stderr describe the network rather than the request? */
function looksNetwork(stderr: string): boolean {
  return /dial tcp|no such host|connection refused|connection reset|i\/o timeout|tls handshake|proxyconnect|unexpected eof|network is unreachable|temporary failure in name resolution|could not resolve host|etimedout|econnrefused|enotfound|econnreset/i.test(
    stderr,
  );
}

/**
 * Was `gh` found, but unusable because it is a `.cmd` / `.bat` wrapper?
 *
 * Node refuses to spawn a batch file without a shell, so on Windows a
 * npm-installed `gh` shim fails with an errno rather than a gh diagnostic. This
 * module must not set `shell: true` to work around it -- that would reintroduce
 * the command-injection surface the array-argument design exists to remove --
 * so the situation is named and reported instead.
 */
function looksLikeShim(message: string): boolean {
  return /\.(cmd|bat)\b/i.test(message) && /eINVAL|einval|spawn/i.test(message);
}

/**
 * Turn a finished process into an outcome.
 *
 * `status: "ok"` is decided by `code === 0` and nothing else. In particular an
 * empty `stdout` is not a failure: the caller must be able to tell "there is
 * nothing to report" from "the call did not work", and this is where that line
 * is drawn.
 */
export function classify(result: GhProcessResult): GhOutcome {
  const stderr = summariseStderr(result.stderr);
  // Normalised here rather than only in `spawnGh`, so the guarantee holds for
  // any executor -- an injected one must not be able to hand back CRLF that
  // goes on to defeat JSON parsing downstream.
  const stdout = normaliseNewlines(result.stdout);

  // Messages are collapsed to one line where stderr joins them: `stderr`
  // itself keeps its lines for a caller that wants to show them, but a message
  // that will be interpolated elsewhere must not smuggle in newlines.
  if (result.timedOut) {
    return {
      status: "failed",
      kind: "timeout",
      exitCode: null,
      stdout,
      stderr,
      signal: result.signal,
      message: oneLine(`gh did not finish in time and was killed. ${stderr}`),
    };
  }

  if (result.code === 0) {
    return {
      status: "ok",
      stdout,
      stderr,
      stdoutTruncated: result.stdoutTruncated,
      stdoutLossy: result.stdoutLossy,
    };
  }

  if (result.code === null) {
    const signal = result.signal ?? "unknown";
    return {
      status: "failed",
      kind: "signal",
      exitCode: null,
      stdout,
      stderr,
      signal: result.signal,
      message: oneLine(`gh was killed by ${signal}. ${stderr}`),
    };
  }

  if (looksUnauthenticated(result.stderr)) {
    return {
      status: "failed",
      kind: "unauthenticated",
      exitCode: result.code,
      stdout,
      stderr,
      signal: null,
      message:
        "GitHub CLI is not authenticated. Run `gh auth login` and try again." +
        (stderr === "" ? "" : ` ${oneLine(stderr)}`),
    };
  }

  if (looksNetwork(result.stderr)) {
    return {
      status: "failed",
      kind: "network",
      exitCode: result.code,
      stdout,
      stderr,
      signal: null,
      message: oneLine(
        `Could not reach GitHub (exit ${result.code}). ${stderr}`,
      ),
    };
  }

  return {
    status: "failed",
    kind: "exit",
    exitCode: result.code,
    stdout,
    stderr,
    signal: null,
    message: oneLine(`gh exited with code ${result.code}. ${stderr}`),
  };
}

/** Turn a spawn-level failure into an outcome. */
export function classifySpawnFailure(failure: GhSpawnFailure): GhFailure {
  if (failure.code === "ENOENT") {
    return {
      status: "failed",
      kind: "not-installed",
      exitCode: null,
      stdout: "",
      stderr: "",
      signal: null,
      message:
        "The GitHub CLI (gh) was not found on PATH. Install it from " +
        "https://cli.github.com and run `gh auth login`. On Windows, confirm the " +
        "install with `where gh`.",
    };
  }

  if (looksLikeShim(failure.message)) {
    return {
      status: "failed",
      kind: "shim",
      exitCode: null,
      stdout: "",
      stderr: "",
      signal: null,
      message:
        "The `gh` found is a .cmd/.bat wrapper, which cannot be run without a shell. " +
        "Install the real binary from https://cli.github.com instead of a wrapper script.",
    };
  }

  const label = failure.code === null ? "" : `${failure.code}: `;
  return {
    status: "failed",
    kind: "unknown",
    exitCode: null,
    stdout: "",
    stderr: "",
    signal: null,
    message: `Could not start gh: ${label}${redact(oneLine(failure.message))}`,
  };
}

/* -------------------------------------------------------------------------
 * The real executor.
 * ---------------------------------------------------------------------- */

/** Longest path that can still be used in a Windows error message. */
const NON_UTF8_MARKER = "\uFFFD";

/**
 * Run `gh` for real.
 *
 * stdout and stderr are read as streams rather than collected by `execFile`,
 * for two reasons the acceptance criteria call out: `execFile` kills the child
 * when output exceeds `maxBuffer`, and a child that fills a pipe nobody is
 * draining will block forever. Reading with `data` handlers avoids both, and
 * lets the byte budget be enforced without deadlocking.
 *
 * Bytes are decoded with a `StringDecoder`, which holds a partial multi-byte
 * sequence across chunk boundaries instead of decoding it into replacement
 * characters. Without it a UTF-8 character split across two chunks -- likely
 * with Chinese or emoji in a title, and Windows chunks at 64 KiB -- would be
 * corrupted in the middle of otherwise valid output.
 *
 * `shell` is never set. Arguments go to the process as an array, so nothing a
 * caller passes can be reinterpreted by a shell.
 */
export const spawnGh: GhExecutor = async (request) => {
  return new Promise<GhSpawnResult>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(request.binary, [...request.args], {
        env: request.env,
        // Never a shell: array arguments are the whole injection defence.
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, failure: toSpawnFailure(error) });
      return;
    }

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let stdoutLossy = false;
    let timedOut = false;
    let settled = false;

    /**
     * Decode one chunk, honouring the byte budget.
     *
     * Always consumes the chunk, even past the budget: a stream nobody drains
     * fills its pipe and blocks the child forever. Past the limit the bytes are
     * dropped and the truncation is remembered, rather than the process being
     * killed the way `execFile` would.
     */
    const drain = (
      chunk: Buffer,
      decoder: StringDecoder,
      budget: { bytes: number; truncated: boolean },
    ): string => {
      if (budget.truncated) return "";
      const remaining = MAX_OUTPUT_BYTES - budget.bytes;

      if (chunk.length > remaining) {
        budget.bytes = MAX_OUTPUT_BYTES;
        budget.truncated = true;
        return decoder.write(chunk.subarray(0, Math.max(remaining, 0)));
      }

      budget.bytes += chunk.length;
      return decoder.write(chunk);
    };

    const stdoutBudget = { bytes: 0, truncated: false };
    const stderrBudget = { bytes: 0, truncated: false };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = drain(chunk, stdoutDecoder, stdoutBudget);
      stdout += text;
      if (text.includes(NON_UTF8_MARKER)) stdoutLossy = true;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += drain(chunk, stderrDecoder, stderrBudget);
    });

    let timer: NodeJS.Timeout | undefined;
    if (request.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        // `kill` reaches the process on POSIX; Node routes the same call
        // through taskkill on Windows, so a timed-out child does not survive
        // as an orphan.
        child.kill("SIGKILL");
      }, request.timeoutMs);
    }

    const settle = (result: GhProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // Flush the decoders so a trailing partial sequence is not lost. A
      // replacement character can only appear here if the stream ended mid
      // sequence, which is the same loss the data handler flags.
      const flushedStdout = stdoutDecoder.end();
      if (flushedStdout.includes(NON_UTF8_MARKER)) stdoutLossy = true;
      stdout += flushedStdout;
      stderr += stderrDecoder.end();
      resolve({
        ok: true,
        process: {
          ...result,
          stdout: normaliseNewlines(stdout),
          stderr,
          stdoutTruncated: stdoutBudget.truncated,
          stdoutLossy,
        },
      });
    };

    child.on("error", (error) => {
      // A spawn that fails after the handle exists -- EACCES, ENOENT from a
      // bad PATH entry -- arrives here rather than as a throw.
      if (timedOut) {
        settle({
          code: null,
          signal: "SIGKILL",
          stdout,
          stderr,
          stdoutTruncated: stdoutBudget.truncated,
          stdoutLossy,
          timedOut: true,
        });
        return;
      }
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ ok: false, failure: toSpawnFailure(error) });
    });

    child.on("close", (code, signal) => {
      settle({
        code,
        signal,
        stdout,
        stderr,
        stdoutTruncated: stdoutBudget.truncated,
        stdoutLossy,
        timedOut,
      });
    });
  });
};

/** Normalise CRLF to LF so downstream JSON parsing is not defeated by Windows. */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function toSpawnFailure(error: unknown): GhSpawnFailure {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return {
    code: typeof code === "string" ? code : null,
    message: (error as Error)?.message ?? String(error),
  };
}

/* -------------------------------------------------------------------------
 * Public entry point.
 * ---------------------------------------------------------------------- */

/**
 * Run `gh` with read-only arguments and classify what happened.
 *
 * There is deliberately **no automatic retry**. The two-phase fetch is cheap
 * and the caller decides what a failure means -- most importantly that a
 * failure must not write a snapshot, since doing so would mark unreported
 * changes as already reported. Retrying inside this layer would hide the
 * failure the caller needs to see, so the policy belongs upstream.
 *
 * `timeoutMs` of zero or less means "no deadline", which is explicit rather
 * than accidental: a hung `gh` then waits forever, and only a caller that has
 * its own cancellation should ask for that.
 *
 * @param args - arguments passed to `gh` as an array; never a shell string.
 * @param options - executor injection, deadline, environment, binary override.
 */
export async function runGh(
  args: readonly string[],
  options: RunGhOptions = {},
): Promise<GhOutcome> {
  const executor = options.executor ?? spawnGh;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const request: GhExecRequest = {
    args,
    timeoutMs,
    // A non-interactive environment: `gh` must never block waiting for a
    // prompt, and colour codes would only pollute a message we redact anyway.
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
      ...options.env,
    },
    binary: options.binary ?? "gh",
  };

  let outcome: GhSpawnResult;
  try {
    outcome = await executor(request);
  } catch (error) {
    return classifySpawnFailure(toSpawnFailure(error));
  }

  return outcome.ok
    ? classify(outcome.process)
    : classifySpawnFailure(outcome.failure);
}

/** Read-only `gh` verbs this plugin is allowed to build arguments for. */
const READ_ONLY_VERBS: readonly string[][] = [
  ["search", "prs"],
  ["pr", "view"],
  ["pr", "list"],
  ["pr", "status"],
  ["api"],
];

/**
 * Whether `args` are a `gh` invocation this plugin permits itself.
 *
 * The plugin only ever needs to look, never to change anything, so the
 * permitted surface is a small allow-list rather than a list of forbidden
 * subcommands -- a deny-list would silently permit every write verb added to
 * `gh` in future. `api` is admitted only for GET requests, since
 * `gh api -X POST` is a write with the same name as a read.
 *
 * `gh` accepts every short flag in an attached spelling as well as a separated
 * one (`-XPOST` and `-X POST`, `--field=a=b` and `--field a=b`), and both mean
 * the same thing to it. A guard that reads only the separated forms would admit
 * `["api", "-XPOST", "/repos/o/r/issues"]` as a read, so both spellings are
 * checked here. The plugin issues no `api` calls today; this is the rule that
 * has to hold if one is ever added.
 *
 * Exported because task 13/14 build the real argument lists and this is the
 * check that keeps them honest.
 */
export function isReadOnlyInvocation(args: readonly string[]): boolean {
  const permitted = READ_ONLY_VERBS.some((verb) =>
    verb.every((part, index) => args[index] === part),
  );
  if (!permitted) return false;

  if (args[0] === "api") {
    for (let index = 1; index < args.length; index += 1) {
      const token = args[index];

      if (token === "-X" || token === "--method") {
        // A flag with no value is not a GET, so it is refused rather than
        // skipped: `gh` would reject it too, and admitting it serves nothing.
        const value = args[index + 1];
        if (value === undefined || value.toUpperCase() !== "GET") return false;
        index += 1;
        continue;
      }

      if (token.startsWith("-X") && token.length > 2) {
        if (token.slice(2).toUpperCase() !== "GET") return false;
        continue;
      }

      if (token.startsWith("--method=")) {
        if (token.slice("--method=".length).toUpperCase() !== "GET")
          return false;
        continue;
      }

      if (
        token === "-f" ||
        token === "--field" ||
        token === "-F" ||
        token === "--raw-field" ||
        token === "--input" ||
        token.startsWith("--field=") ||
        token.startsWith("--raw-field=") ||
        token.startsWith("--input=") ||
        (token.length > 2 && (token.startsWith("-f") || token.startsWith("-F")))
      ) {
        // Implies a request body, which turns a GET-shaped call into a write.
        // `--input` is the least obvious of these: it names a file, and `gh`
        // still defaults the method to POST when a body is supplied without an
        // explicit `-X`.
        return false;
      }
    }
  }

  return true;
}

/* -------------------------------------------------------------------------
 * Task 12 — record mapping.
 *
 * Turns the JSON text task 11 brought back into the `PrRecord` the delta core
 * consumes. Nothing here runs `gh`, reads a clock, or makes a business
 * judgement: staleness, newly-noticed, and the snapshot comparison all belong
 * to `delta.ts`. This module decides only whether the bytes it was handed are a
 * trustworthy description of some pull requests.
 *
 * It is the sole source of the data every later decision rests on, and a
 * misparse is worse than an error: a record that quietly vanishes looks to
 * `diff()` like a pull request that left the open set, which is then reported
 * as merged or closed. A false "merged" is user-visible and irreversible, so
 * this module fails whole batches rather than dropping single records.
 * ---------------------------------------------------------------------- */

/**
 * The most results phase 1 asks for.
 *
 * GitHub's search API returns at most 1000, but this plugin's design is
 * premised on the user having on the order of 10-30 open pull requests. 200 is
 * far above that and far below the API ceiling, so reaching it means something
 * unexpected is happening and the enumeration may be incomplete. Reaching it is
 * reported, never silently accepted: a truncated enumeration would make the
 * missing pull requests look like departures, and `diff()` would announce them
 * as merged.
 */
export const PHASE_ONE_RESULT_LIMIT = 200;

/** Fields phase 1 requests from `gh search prs`. */
export const PHASE_ONE_JSON_FIELDS = [
  "url",
  "title",
  "state",
  "createdAt",
  "updatedAt",
  "number",
  "repository",
] as const;

/**
 * Fields phase 2 requests from `gh pr view`.
 *
 * `updatedAt` and `title` are here beyond the state the plan originally listed,
 * because `delta.ts` reads an entry's terminal time from `PrRecord.updatedAt`
 * (`pruneTerminal` ages terminal entries by it) and renders `title`. Without
 * them the resolved record would keep the snapshot's stale timestamp and the
 * merge would be pruned against the wrong date.
 */
export const PHASE_TWO_JSON_FIELDS = [
  "state",
  "mergedAt",
  "updatedAt",
  "title",
  "url",
  "number",
  "repository",
] as const;

/**
 * Arguments enumerating every open pull request authored by the current user,
 * across all repositories.
 *
 * `gh search prs` rather than `gh pr list`, because `pr list` is single-repo
 * and requires either a checkout or `--repo`, while the README's promise is
 * coverage of "repositories you have never cloned". `--author @me` is what
 * makes the set "mine".
 *
 * Note what `state` can be here: GitHub's search API reports only `OPEN` or
 * `CLOSED`, and never distinguishes a merge. That is precisely why the second
 * phase exists -- only `gh pr view` reveals `MERGED`.
 */
export function phaseOneArgs(
  limit: number = PHASE_ONE_RESULT_LIMIT,
): readonly string[] {
  return [
    "search",
    "prs",
    "--author",
    "@me",
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    PHASE_ONE_JSON_FIELDS.join(","),
  ];
}

/**
 * Arguments resolving one pull request's terminal state.
 *
 * Takes the canonical URL rather than `--repo owner/repo` plus a number: the
 * URL is already the snapshot's `url` field, so it needs no reconstruction and
 * cannot be assembled wrong. `gh pr view` accepts a URL for exactly this reason.
 */
export function phaseTwoArgs(url: string): readonly string[] {
  return ["pr", "view", url, "--json", PHASE_TWO_JSON_FIELDS.join(",")];
}

/** Why a batch of JSON could not be trusted. */
export type MappingProblem =
  /** The text is not JSON at all. */
  | "invalid-json"
  /** The JSON root has the wrong shape for this phase. */
  | "wrong-root"
  /** A record is missing a required field, or has one of the wrong type. */
  | "bad-record"
  /** A record's `state` is not one this build knows. */
  | "unknown-state"
  /** A record carries a timestamp that cannot be parsed. */
  | "bad-timestamp"
  /** A record's identity cannot be expressed as `owner/repo#number`. */
  | "bad-identity";

/** The mapping of one batch, as a discriminated union. */
export type MappingOutcome<T> =
  | { readonly status: "ok"; readonly records: T }
  | {
      readonly status: "failed";
      readonly problem: MappingProblem;
      /** Where the problem is, and what about it, in one line. */
      readonly detail: string;
    };

/**
 * Parse a GitHub timestamp, returning the epoch milliseconds or `null`.
 *
 * GitHub emits UTC datetimes such as `2026-08-27T10:02:44Z`, and `Date.parse`
 * handles those directly, including `+08:00` offsets. Two checks run first,
 * because `Date.parse` is lenient in ways that would hide a broken feed:
 *
 * 1. A shape check. Without it `"2026"` parses as a year, which would make a
 *    pull request look thousands of days stale -- and staleness is reported.
 * 2. A field-range check on the leading date. `Date.parse` does not reject
 *    `2026-02-30`; it rolls it forward to March 2 and returns a value. A feed
 *    emitting impossible dates is broken, and silently repairing it here would
 *    attribute activity to the wrong day.
 *
 * No clock is read here. A parser that called `Date.now()` could not be tested
 * against a fixture, and the staleness comparison is `delta.ts`'s job anyway.
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;

  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      value,
    );
  if (match === null) return null;

  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(Number(match[1]), month)) return null;

  if (match[4] !== undefined) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59) return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Days in a calendar month, counting leap years. */
function daysInMonth(year: number, month: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month !== 2) return lengths[month - 1];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return leap ? 29 : 28;
}

/** Whether `value` is a JSON object we can read fields from. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The characters GitHub permits in an owner or repository name.
 *
 * Validated rather than trusted, because the key is an identity: a name with a
 * space or a stray character in it would produce a key that never matches the
 * snapshot entry for the same pull request, and that entry would then look like
 * a departure and be reported as merged.
 */
const NAME_PART = /^[A-Za-z0-9._-]+$/;

/**
 * `owner/repo#number`, from a record's `repository.nameWithOwner` and `number`.
 */
function identityOf(
  raw: Record<string, unknown>,
): { key: string; number: number } | null {
  const repository = raw.repository;
  if (!isObject(repository)) return null;

  const nameWithOwner = repository.nameWithOwner;
  if (
    typeof nameWithOwner !== "string" ||
    nameWithOwner !== nameWithOwner.trim()
  )
    return null;

  // Exactly one slash, with a non-empty owner and repository on either side.
  const parts = nameWithOwner.split("/");
  if (parts.length !== 2) return null;
  if (!NAME_PART.test(parts[0]) || !NAME_PART.test(parts[1])) return null;

  const number = raw.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1)
    return null;

  return { key: prKey({ nameWithOwner, number }), number };
}

/** Why one raw record could not be read. */
type RecordProblem = { problem: MappingProblem; detail: string };

/** The parts of a record both phases share. */
interface CommonRecord {
  key: string;
  url: string;
  title: string;
  updatedAt: string;
  state: string;
}

/**
 * Validate the fields both phases provide, and build the identity.
 *
 * `repository.nameWithOwner` plus `number` is required here because it is the
 * snapshot's primary key: a malformed one would create a second entry for a
 * pull request already tracked, leaving the real entry to look like a departure
 * and be reported as merged.
 */
function readCommonRecord(
  raw: Record<string, unknown>,
  where: string,
): { ok: true; value: CommonRecord } | { ok: false; reason: RecordProblem } {
  for (const field of ["url", "title", "updatedAt"] as const) {
    if (typeof raw[field] !== "string") {
      return {
        ok: false,
        reason: {
          problem: "bad-record",
          detail: `${where}.${field} must be a string, got ${describeValue(raw[field])}`,
        },
      };
    }
  }

  if (typeof raw.state !== "string") {
    return {
      ok: false,
      reason: {
        problem: "bad-record",
        detail: `${where}.state must be a string, got ${describeValue(raw.state)}`,
      },
    };
  }

  if (parseTimestamp(raw.updatedAt) === null) {
    return {
      ok: false,
      reason: {
        problem: "bad-timestamp",
        detail: `${where}.updatedAt is not a parsable timestamp: ${JSON.stringify(raw.updatedAt)}`,
      },
    };
  }

  const identity = identityOf(raw);
  if (identity === null) {
    return {
      ok: false,
      reason: {
        problem: "bad-identity",
        detail: `${where} has no usable repository.nameWithOwner/number pair`,
      },
    };
  }

  return {
    ok: true,
    value: {
      key: identity.key,
      url: raw.url as string,
      title: raw.title as string,
      updatedAt: raw.updatedAt as string,
      state: raw.state,
    },
  };
}

/**
 * Validate one phase 1 record and turn it into a `PrRecord`.
 *
 * Unknown extra fields are ignored, so a record written by a newer `gh` stays
 * readable. Known fields are checked strictly: a coerced record is worse than a
 * refused one, because it flows into the delta core and is then written back
 * over the user's snapshot.
 */
function toSearchRecord(
  raw: unknown,
  index: number,
):
  | { ok: true; key: string; record: PrRecord; state: string }
  | { ok: false; reason: RecordProblem } {
  const where = `pullRequests[${index}]`;
  if (!isObject(raw)) {
    return {
      ok: false,
      reason: { problem: "bad-record", detail: `${where} is not an object` },
    };
  }

  // Search results do carry createdAt, and a new entry needs it.
  if (typeof raw.createdAt !== "string") {
    return {
      ok: false,
      reason: {
        problem: "bad-record",
        detail: `${where}.createdAt must be a string, got ${describeValue(raw.createdAt)}`,
      },
    };
  }
  if (parseTimestamp(raw.createdAt) === null) {
    return {
      ok: false,
      reason: {
        problem: "bad-timestamp",
        detail: `${where}.createdAt is not a parsable timestamp: ${JSON.stringify(raw.createdAt)}`,
      },
    };
  }

  const common = readCommonRecord(raw, where);
  if (!common.ok) return { ok: false, reason: common.reason };

  return {
    ok: true,
    key: common.value.key,
    state: common.value.state,
    record: {
      url: common.value.url,
      title: common.value.title,
      state: "OPEN",
      createdAt: raw.createdAt,
      updatedAt: common.value.updatedAt,
      staleReported: false,
      departedReported: false,
    },
  };
}

/**
 * Validate one phase 2 record.
 *
 * `createdAt` is **not** required here, because `gh pr view` asked for
 * `state,mergedAt,updatedAt,title,url,number,repository` does not return it.
 * The field is still part of `PrRecord`, so it is filled with the empty string
 * and the caller merges the phase 2 result onto the record it already holds --
 * the entry being resolved came from the snapshot, which has a real
 * `createdAt`. Nothing downstream breaks: staleness reads `updatedAt`, and
 * `pruneTerminal` ages terminal entries by `updatedAt` too.
 */
function toViewRecord(
  raw: Record<string, unknown>,
  where: string,
): { ok: true; value: CommonRecord } | { ok: false; reason: RecordProblem } {
  if (raw.createdAt !== undefined && typeof raw.createdAt !== "string") {
    return {
      ok: false,
      reason: {
        problem: "bad-record",
        detail: `${where}.createdAt must be a string when present, got ${describeValue(raw.createdAt)}`,
      },
    };
  }
  if (
    typeof raw.createdAt === "string" &&
    parseTimestamp(raw.createdAt) === null
  ) {
    return {
      ok: false,
      reason: {
        problem: "bad-timestamp",
        detail: `${where}.createdAt is not a parsable timestamp: ${JSON.stringify(raw.createdAt)}`,
      },
    };
  }

  return readCommonRecord(raw, where);
}

/** A short description of a JSON value, for diagnostics. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/** Parse JSON text, mapping a syntax error to a failure rather than a throw. */
function parseJsonText(
  text: string,
): { ok: true; value: unknown } | { ok: false; detail: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      detail: oneLine((error as Error).message ?? String(error)),
    };
  }
}

/** One mapped record together with the state `gh` reported for it. */
export interface MappedRecord {
  readonly key: string;
  readonly record: PrRecord;
  /** The raw `state` string, preserved so phase 2 can resolve a terminal state. */
  readonly rawState: string;
}

/** The result of mapping one phase 1 batch. */
export interface PhaseOneResult {
  readonly records: readonly MappedRecord[];
  /**
   * True when the batch returned exactly the number asked for.
   *
   * GitHub caps search results, so a full page may mean more exist. This is
   * surfaced rather than swallowed: treating a truncated enumeration as
   * complete would make the missing pull requests look like departures.
   */
  readonly atLimit: boolean;
}

/**
 * Map phase 1 output: a JSON array of search results to mapped records.
 *
 * An **empty array is a success**, not a failure. It is how "you have no open
 * pull requests" arrives, and the README's premise is that this must never be
 * confused with a `gh` call that did not work -- which is why the caller
 * receives this only after task 11 has already reported success.
 *
 * All-or-nothing: one bad record fails the batch. Skipping it would remove that
 * pull request from the working set, and `diff()` would read the absence as a
 * departure and report a merge that never happened.
 *
 * @param text - stdout from {@link phaseOneArgs}.
 * @param limit - the limit the call was made with, used for limit detection.
 */
export function mapPhaseOne(
  text: string,
  limit: number = PHASE_ONE_RESULT_LIMIT,
): MappingOutcome<PhaseOneResult> {
  const parsed = parseJsonText(text);
  if (!parsed.ok) {
    return { status: "failed", problem: "invalid-json", detail: parsed.detail };
  }

  if (!Array.isArray(parsed.value)) {
    return {
      status: "failed",
      problem: "wrong-root",
      detail: `expected a JSON array from gh search prs, got ${describeValue(parsed.value)}`,
    };
  }

  const records: MappedRecord[] = [];
  for (const [index, raw] of parsed.value.entries()) {
    const mapped = toSearchRecord(raw, index);
    if (!mapped.ok) {
      return {
        status: "failed",
        problem: mapped.reason.problem,
        detail: mapped.reason.detail,
      };
    }
    records.push({
      key: mapped.key,
      record: mapped.record,
      rawState: mapped.state,
    });
  }

  return {
    status: "ok",
    records: { records, atLimit: limit > 0 && records.length >= limit },
  };
}

/** A resolved terminal record. */
export interface ResolvedRecord {
  readonly key: string;
  readonly record: PrRecord;
  /** `MERGED` or `CLOSED`; the two are never collapsed into one value. */
  readonly terminal: TerminalState;
}

/**
 * Map phase 2 output: one `gh pr view` object to a resolved terminal record.
 *
 * Only `MERGED` and `CLOSED` are accepted. Anything else is refused rather than
 * defaulted: mapping an unrecognised state onto `CLOSED` would announce an
 * active pull request as closed, and mapping it onto `MERGED` would claim a
 * merge that did not happen. Either way the false report is user-visible and
 * cannot be un-reported, since `diff()` records the outcome and stays silent
 * about it forever after.
 *
 * The returned record keeps the state `gh` reported, so `diff()` carries it
 * forward as terminal history, and takes `updatedAt` from this response so
 * pruning ages the entry by when it actually ended.
 */
export function mapPhaseTwo(text: string): MappingOutcome<ResolvedRecord> {
  const parsed = parseJsonText(text);
  if (!parsed.ok) {
    return { status: "failed", problem: "invalid-json", detail: parsed.detail };
  }

  if (!isObject(parsed.value)) {
    return {
      status: "failed",
      problem: "wrong-root",
      detail: `expected a JSON object from gh pr view, got ${describeValue(parsed.value)}`,
    };
  }

  const mapped = toViewRecord(parsed.value, "pullRequests[0]");
  if (!mapped.ok) {
    return {
      status: "failed",
      problem: mapped.reason.problem,
      detail: mapped.reason.detail,
    };
  }

  const terminal = toTerminalState(mapped.value.state);
  if (terminal === undefined) {
    return {
      status: "failed",
      problem: "unknown-state",
      detail:
        `gh reported state ${JSON.stringify(mapped.value.state)}, which is neither MERGED nor CLOSED. ` +
        "It is not guessed at: an active pull request must not be reported as finished.",
    };
  }

  return {
    status: "ok",
    records: {
      key: mapped.value.key,
      record: {
        url: mapped.value.url,
        title: mapped.value.title,
        state: terminal,
        // Absent from `gh pr view`; the caller merges this onto the snapshot
        // entry, which already carries the real creation time.
        createdAt:
          typeof parsed.value.createdAt === "string"
            ? parsed.value.createdAt
            : "",
        updatedAt: mapped.value.updatedAt,
        staleReported: false,
        departedReported: false,
      },
      terminal,
    },
  };
}

/**
 * The terminal state a `gh` state string denotes, or `undefined`.
 *
 * `gh search prs` never returns `MERGED` -- its API reports a merged pull
 * request as `CLOSED` -- so only `gh pr view` can distinguish the two. That
 * asymmetry is why the fetch has two phases at all, and why a resolved state is
 * read from phase 2 alone.
 */
export function toTerminalState(raw: string): TerminalState | undefined {
  if (raw === "MERGED") return "MERGED";
  if (raw === "CLOSED") return "CLOSED";
  return undefined;
}

/**
 * `owner/repo#number` for one raw search result.
 *
 * Kept as a thin export so a caller that already has phase 1 JSON can key a
 * record without mapping it; returns `undefined` rather than throwing so the
 * malformed case stays on the mapping path.
 */
export function toPrKey(raw: unknown): string | undefined {
  if (!isObject(raw)) return undefined;
  return identityOf(raw)?.key;
}
