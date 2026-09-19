import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/* -------------------------------------------------------------------------
 * Task 11 —the `gh` invocation boundary.
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

      if (chunk.length >= remaining) {
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
      // Flush the decoders so a trailing partial sequence is not lost.
      stdout += stdoutDecoder.end();
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
 * Exported because task 13 builds the real argument lists and this is the check
 * that keeps them honest.
 */
export function isReadOnlyInvocation(args: readonly string[]): boolean {
  const permitted = READ_ONLY_VERBS.some((verb) =>
    verb.every((part, index) => args[index] === part),
  );
  if (!permitted) return false;

  if (args[0] === "api") {
    for (let index = 1; index < args.length; index += 1) {
      const token = args[index];
      const isMethodFlag = token === "-X" || token === "--method";
      const isInlineMethod = token.startsWith("--method=");
      if (isMethodFlag && args[index + 1] !== undefined) {
        if (args[index + 1].toUpperCase() !== "GET") return false;
        index += 1;
      } else if (isInlineMethod) {
        if (token.slice("--method=".length).toUpperCase() !== "GET")
          return false;
      } else if (
        token === "-f" ||
        token === "--field" ||
        token === "-F" ||
        token === "--raw-field"
      ) {
        // Implies a request body, which turns a GET-shaped call into a write.
        return false;
      }
    }
  }

  return true;
}
