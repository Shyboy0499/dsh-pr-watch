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
 * Run `gh` with an argument array — never a shell string, so tool parameters
 * cannot be injected into a command line. Returns stdout.
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

/** Anything that is not a terminal state is not a resolution. */
export function toTerminalState(raw: string): TerminalState | undefined {
  if (raw === "MERGED") return "MERGED";
  if (raw === "CLOSED") return "CLOSED";
  return undefined;
}
