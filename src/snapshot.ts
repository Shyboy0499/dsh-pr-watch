import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  SNAPSHOT_VERSION,
  type PrRecord,
  type PrState,
  type Snapshot,
} from "./types";

/** Directory the plugin keeps its state in, under the dsh data directory. */
export const WATCH_DIRECTORY_NAME = "pr-watch";

/** The snapshot file itself. */
export const SNAPSHOT_FILE_NAME = "snapshot.json";

/** Directory the fallback path hangs off, used when `DSH_HOME` is not set. */
export const FALLBACK_HOME_DIRECTORY_NAME = ".dsh";

/** Thurown when the environment cannot yield a usable snapshot path. */
export class SnapshotPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotPathError";
  }
}

/**
 * Whether `value` is absent or carries nothing but whitespace.
 *
 * A type predicate rather than a plain boolean so that a `false` result narrows
 * `dshHome` to `string` for the callers below.
 */
function isBlank(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === "";
}

/**
 * The snapshot file's absolute path, from explicit environment input.
 *
 * Pure: every input arrives as an argument, so it reads no environment variable,
 * touches no disk, and depends on no clock. Task 9 and 10 build on this, and
 * their tests can therefore drive it without a real `DSH_HOME` or a real home
 * directory.
 *
 * Resolution, in order:
 *
 * 1. A `DSH_HOME` that is set to something other than whitespace wins, and is
 *    returned with `pr-watch/snapshot.json` appended.
 * 2. A `DSH_HOME` that is unset, empty, or only whitespace falls back to
 *    `<homeDirectory>/.dsh/pr-watch/snapshot.json`. A blank value is treated as
 *    unset rather than as a directory named "   ", so a configuration accident
 *    degrades to the documented default instead of producing a path that
 *    depends on the working directory.
 *
 * `homeDirectory` is a parameter rather than a call to `os.homedir()` for the
 * same reason, and it is never interpolated as a literal `~`: the fallback only
 * works if the real directory is substituted, which is the caller's job.
 *
 * A relative `DSH_HOME` is rejected. It would resolve against the process working
 * directory, so the same configuration would read and write different snapshot
 * files depending on where the plugin was launched -- silently losing the record
 * of what has already been reported. Failing loudly is the only safe answer.
 *
 * A `DSH_HOME` padded with whitespace is rejected too. Trimming it would mean
 * reading and writing a different location than the one written down, which is
 * exactly the class of silent divergence the relative-path rule exists to
 * prevent; a padded value is nearly always a quoting mistake worth surfacing.
 *
 * @param dshHome - the `DSH_HOME` value, or `undefined` when it is not set.
 * @param homeDirectory - the user's home directory, already resolved.
 * @throws {SnapshotPathError} when the inputs cannot produce an absolute path.
 */
export function resolveSnapshotPath(
  dshHome: string | undefined,
  homeDirectory: string,
): string {
  const segments = [WATCH_DIRECTORY_NAME, SNAPSHOT_FILE_NAME];

  if (isBlank(dshHome)) {
    if (typeof homeDirectory !== "string" || homeDirectory.trim() === "") {
      throw new SnapshotPathError(
        "Cannot resolve the snapshot path: the home directory is empty and DSH_HOME is not set. " +
          `Set DSH_HOME to an absolute directory, or make sure ${FALLBACK_HOME_DIRECTORY_NAME} can be located.`,
      );
    }
    return join(homeDirectory, FALLBACK_HOME_DIRECTORY_NAME, ...segments);
  }

  const home = dshHome;

  if (home.trim() !== home) {
    // Surrounding whitespace is almost always a quoting accident in a shell
    // profile, and it can also make an otherwise absolute path look relative.
    // Trimming would silently read and write a different location than the one
    // written down, so say so instead of guessing which was meant. Checked
    // before the absolute-path test so the diagnosis names the real problem.
    throw new SnapshotPathError(
      `DSH_HOME has leading or trailing whitespace, which is almost always a quoting mistake: "${dshHome}". ` +
        "Remove it, or quote the value so the spaces are intentional.",
    );
  }

  if (!isAbsolute(home)) {
    throw new SnapshotPathError(
      `DSH_HOME must be an absolute path, got "${dshHome}". A relative path would select a ` +
        "different snapshot depending on the working directory, so it is rejected rather than guessed.",
    );
  }

  // `join` follows this platform's rules, which is the only useful answer: a home
  // directory is meaningful on the platform it belongs to. A Windows-form path
  // is not absolute on POSIX and a POSIX-form path is not absolute on Windows, so
  // each is rejected by the check above on the platform where it means nothing,
  // rather than being accepted and then joined into a mixed path no platform can
  // use. `join` also normalises separators and collapses trailing ones, so a
  // DSH_HOME ending in "/" or "\\" cannot produce a doubled separator.
  return join(home, ...segments);
}

/**
 * The snapshot path for the running process.
 *
 * The only place the environment is read, kept separate from
 * {@link resolveSnapshotPath} so that everything above can be tested without
 * touching a real environment or a real home directory.
 *
 * v1 derives this from the environment alone and offers no override: the README
 * records a snapshot path that is "derived from the environment", and making it
 * settable belongs to the v2 settings loader rather than to this module.
 */
export function snapshotPath(): string {
  return resolveSnapshotPath(process.env.DSH_HOME, homedir());
}

/**
 * Why a snapshot's *content* was rejected.
 *
 * A closed set rather than a prose string so that callers can branch on the
 * cause and word their own message: task 10's quarantine step reports the
 * reason, and the tool's output is written for the user, not for this module.
 */
export type SnapshotCorruptReason =
  /** Zero bytes. */
  | "empty"
  /** Parses as nothing but whitespace. */
  | "blank"
  /** Not valid JSON: truncated, garbled, or otherwise unparseable text. */
  | "invalid-json"
  /** Valid JSON, but not a snapshot this version can read. */
  | "shape";

/** The four outcomes of loading a snapshot. Discriminated by `status`. */
export type SnapshotLoad =
  /** No file at `path`. The first-run path, and not an error. */
  | { readonly status: "missing"; readonly path: string }
  /** Read and validated. `snapshot` is ready for the delta core. */
  | {
      readonly status: "ok";
      readonly path: string;
      readonly snapshot: Snapshot;
    }
  /** The bytes were read, and they are not a usable snapshot. */
  | {
      readonly status: "corrupt";
      readonly path: string;
      readonly reason: SnapshotCorruptReason;
      readonly detail: string;
    }
  /**
   * The file could not be read at all, so nothing is known about its contents.
   *
   * Deliberately distinct from `corrupt`: the file on disk may be perfectly
   * intact and merely unreachable right now. Treating this as corruption would
   * have task 10 move a healthy file aside and lose the user's state.
   */
  | {
      readonly status: "unreadable";
      readonly path: string;
      readonly code: string;
      readonly detail: string;
    };

/** The valid `PrState` values, for narrowing parsed JSON. */
const PR_STATES: ReadonlySet<string> = new Set<PrState>([
  "OPEN",
  "MERGED",
  "CLOSED",
]);

/** A `detail` string that is short, single-line, and safe to interpolate. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` is a well-formed `PrRecord`.
 *
 * Unknown *extra* keys are ignored rather than rejected, so a snapshot written
 * by a newer minor version stays readable here instead of being reported as
 * damaged. Known keys are checked strictly: a wrong type means the entry cannot
 * be trusted, and a silently coerced record would be worse than a loud
 * rejection, because it would flow into the delta core and be written back.
 */
function isPrRecord(value: unknown): value is PrRecord {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.url === "string" &&
    typeof value.title === "string" &&
    typeof value.state === "string" &&
    PR_STATES.has(value.state) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.staleReported === "boolean" &&
    typeof value.departedReported === "boolean"
  );
}

/**
 * Validate parsed JSON as a `Snapshot`, returning either the value or the
 * reason it is not one.
 *
 * `version` is required and must equal {@link SNAPSHOT_VERSION}. A missing or
 * unrecognised version is rejected rather than defaulted: guessing would mean
 * interpreting another schema's fields as this one's and then writing the
 * result back over the user's file.
 */
function toSnapshot(
  parsed: unknown,
): { ok: true; snapshot: Snapshot } | { ok: false; detail: string } {
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      detail: `expected a JSON object, got ${describe(parsed)}`,
    };
  }

  if (typeof parsed.version !== "number" || !Number.isInteger(parsed.version)) {
    return {
      ok: false,
      detail: `"version" must be an integer, got ${describe(parsed.version)}`,
    };
  }

  if (parsed.version !== SNAPSHOT_VERSION) {
    return {
      ok: false,
      detail: `unsupported snapshot version ${parsed.version}; this build reads version ${SNAPSHOT_VERSION}`,
    };
  }

  if (typeof parsed.lastCheck !== "string") {
    return {
      ok: false,
      detail: `"lastCheck" must be a string, got ${describe(parsed.lastCheck)}`,
    };
  }

  if (!isPlainObject(parsed.pullRequests)) {
    return {
      ok: false,
      detail: `"pullRequests" must be an object, got ${describe(parsed.pullRequests)}`,
    };
  }

  const pullRequests: Record<string, PrRecord> = {};
  for (const [key, entry] of Object.entries(parsed.pullRequests)) {
    if (!isPrRecord(entry)) {
      return {
        ok: false,
        detail: `"pullRequests.${key}" is not a valid record (${describe(entry)})`,
      };
    }
    pullRequests[key] = entry;
  }

  return {
    ok: true,
    snapshot: {
      version: parsed.version,
      lastCheck: parsed.lastCheck,
      pullRequests,
    },
  };
}

/** A short description of a JSON value, for diagnostics. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * Read and validate the snapshot at `path`.
 *
 * Never throws for any of the four outcomes, and never touches the disk: this
 * slice only reads. Quarantining a corrupt file and writing the next snapshot
 * are both deliberately absent and belong to task 10, so that a decision to
 * move a file aside can be made once, by the caller, with full knowledge of
 * what was found.
 *
 * The classification line is drawn at *whether the read succeeded*, not at how
 * plausible the contents look:
 *
 * - `ENOENT` is `missing`, the ordinary first run.
 * - Every other read failure -- permissions, sharing violation, I/O error, or a
 *   directory in the file's place -- is `unreadable`. Nothing was learned about
 *   the contents, so nothing may be concluded about them.
 * - A successful read whose bytes are not a usable snapshot is `corrupt`.
 *
 * Keeping `unreadable` distinct from `corrupt` is the point of the distinction:
 * the README's "quarantined, never discarded" rule is about damaged *content*,
 * and applying it to a file that is merely unreachable would move a healthy
 * file aside and destroy the record of what has already been reported.
 *
 * @param path - absolute path to the snapshot file.
 * @returns the outcome; `ok` carries the snapshot, the others explain themselves.
 */
export async function loadSnapshot(path: string): Promise<SnapshotLoad> {
  let text: string;

  try {
    // The encoding is pinned so the BOM handling below is a real decision rather
    // than a dependency on Node's default.
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") return { status: "missing", path };

    return {
      status: "unreadable",
      path,
      code: typeof code === "string" ? code : "UNKNOWN",
      detail: oneLine((error as Error).message ?? String(error)),
    };
  }

  // A BOM survives decoding as U+FEFF and makes `JSON.parse` reject otherwise
  // valid JSON. Editors on Windows add one readily, so it is stripped rather
  // than reported as damage.
  const body = text.charCodeAt(0) === 0xfe_ff ? text.slice(1) : text;

  if (body.trim() === "") {
    // Whitelisting empty here would be indistinguishable from "nothing has ever
    // been tracked" and would silently drop every entry. The snapshot is written
    // atomically, so a legitimate one is never zero bytes or blank; either state
    // means something outside this plugin damaged the file.
    return {
      status: "corrupt",
      path,
      reason: body.length === 0 ? "empty" : "blank",
      detail:
        body.length === 0
          ? "the file is empty (0 bytes)"
          : "the file contains only whitespace",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return {
      status: "corrupt",
      path,
      reason: "invalid-json",
      detail: oneLine((error as Error).message ?? String(error)),
    };
  }

  const validated = toSnapshot(parsed);
  if (!validated.ok) {
    return {
      status: "corrupt",
      path,
      reason: "shape",
      detail: validated.detail,
    };
  }

  return { status: "ok", path, snapshot: validated.snapshot };
}
