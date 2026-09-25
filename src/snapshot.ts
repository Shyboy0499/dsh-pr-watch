import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
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
 * Whether `value` is absolute in a way that cannot depend on where the process
 * happens to be running.
 *
 * The platform's own `isAbsolute` is not enough on Windows: it accepts
 * `/tmp/dsh`, a "rooted" path with no drive letter, and `join` then resolves it
 * against whichever drive the process happens to be on. That is the same silent
 * divergence the relative-path rejection exists to prevent, so a drive-relative
 * form is refused here. A UNC path (`\\server\share` or `//server/share`) is
 * accepted, because it names its own location. On POSIX the platform rule is
 * already unambiguous.
 */
function isUnambiguousAbsolute(
  value: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") return posix.isAbsolute(value);
  // Either slash may start a UNC path: `//server/share` is fully qualified, and
  // `win32.join` normalises it to `\\server\share\...`. Accepting only the
  // backslash spelling rejected a legitimate Windows path.
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value);
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
 * @param platform - the platform whose path rules apply. Injectable so the
 *   Windows-only rejection below can be driven from a POSIX test run.
 * @throws {SnapshotPathError} when the inputs cannot produce an absolute path.
 */
export function resolveSnapshotPath(
  dshHome: string | undefined,
  homeDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const segments = [WATCH_DIRECTORY_NAME, SNAPSHOT_FILE_NAME];
  const joinFor = platform === "win32" ? win32.join : posix.join;

  if (isBlank(dshHome)) {
    if (typeof homeDirectory !== "string" || homeDirectory.trim() === "") {
      throw new SnapshotPathError(
        "Cannot resolve the snapshot path: the home directory is empty and DSH_HOME is not set. " +
          `Set DSH_HOME to an absolute directory, or make sure ${FALLBACK_HOME_DIRECTORY_NAME} can be located.`,
      );
    }
    return joinFor(homeDirectory, FALLBACK_HOME_DIRECTORY_NAME, ...segments);
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

  if (!isUnambiguousAbsolute(home, platform)) {
    throw new SnapshotPathError(
      platform === "win32"
        ? `DSH_HOME must be a fully qualified Windows path, got "${dshHome}". A path with no drive ` +
            "letter or UNC prefix resolves against whichever drive the process happens to be on, so it " +
            "is rejected rather than guessed."
        : `DSH_HOME must be an absolute path, got "${dshHome}". A relative path would select a ` +
            "different snapshot depending on the working directory, so it is rejected rather than guessed.",
    );
  }

  // `joinFor` follows the platform's own rules, which is the only useful answer:
  // a home directory is meaningful on the platform it belongs to. A Windows-form
  // path has no meaning on POSIX and a drive-relative POSIX-form path has none on
  // Windows, so each is rejected above on the platform where it means nothing,
  // rather than being accepted and joined into a mixed path no platform can use.
  // `join` also normalises separators and collapses trailing ones, so a DSH_HOME
  // ending in "/" or "\\" cannot produce a doubled separator.
  return joinFor(home, ...segments);
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
    // `__proto__` is the one key whose assignment defines nothing: it reaches
    // `Object.prototype`'s setter, so the record would vanish while the load
    // still reported success -- silent loss, where this module's policy is loud
    // rejection. Every real key is `owner/repo#number`, so nothing legitimate is
    // refused. (`JSON.parse` does create it as an own property, which is why
    // `Object.entries` sees it here at all.)
    if (key === "__proto__") {
      return {
        ok: false,
        detail:
          '"pullRequests.__proto__" is not a usable key; snapshot keys are "owner/repo#number"',
      };
    }

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

/* -------------------------------------------------------------------------
 * Write side — task 10.
 *
 * This is the only code in the plugin that modifies the disk, and therefore the
 * only code that can destroy a user's state. Two rules govern all of it:
 *
 *   1. The snapshot body is never deleted. Quarantine *moves* it; the atomic
 *      save replaces it by rename. The only files ever removed are temporary
 *      files this module itself created, matched by an exact name pattern.
 *   2. Nothing fails silently. Every write failure leaves the previous snapshot
 *      intact and throws.
 * ---------------------------------------------------------------------- */

/** A write-side failure: the previous snapshot is untouched and the caller must know. */
export class SnapshotWriteError extends Error {
  /** The errno from the underlying failure, when there was one. */
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "SnapshotWriteError";
    this.code = code;
  }
}

/**
 * A load result proven to be corruption, and therefore safe to quarantine.
 *
 * The brand is what enforces the single most important rule on this side: an
 * `unreadable` file has *not* been shown to be damaged -- it may be perfectly
 * intact and merely locked, or behind a permission the process lacks. Moving it
 * aside would destroy pending changes exactly the way the README warns a silent
 * reset would. Because only `loadSnapshot` can mint the brand, an unreadable
 * result cannot be passed to {@link quarantineCorruptSnapshot} at all: it is a
 * type error, not a runtime check that someone has to remember to write.
 */
declare const quarantineToken: unique symbol;

export type QuarantinableSnapshot = Extract<
  SnapshotLoad,
  { status: "corrupt" }
> & {
  readonly [quarantineToken]: true;
};

/**
 * Narrow a load result to the quarantine-eligible case.
 *
 * The single place the brand above is minted. Returns `null` for `missing`,
 * `ok`, and -- critically -- `unreadable`.
 */
export function asQuarantinable(
  result: SnapshotLoad,
): QuarantinableSnapshot | null {
  if (result.status !== "corrupt") return null;
  return result as QuarantinableSnapshot;
}

/**
 * Rename onto an existing file can fail on Windows while a virus scanner, an
 * editor, or another instance holds the target open. These are the errnos that
 * mean "try again", as opposed to a real problem that retrying cannot fix.
 */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
]);

/** How many times a rename is attempted before the failure is surfaced. */
const RENAME_ATTEMPTS = 5;

/** Baseline backoff between rename attempts, doubled after each failure. */
const RENAME_BACKOFF_MS = 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The errno carried by a failed filesystem call, if any. */
function errorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * `rename`, retried while the failure looks transient.
 *
 * On POSIX the rename itself is atomic, so this normally succeeds first try. On
 * Windows the same call can fail with `EPERM`/`EACCES`/`EBUSY` purely because
 * something else has the destination open. Silently giving up there would lose
 * the save, so it is retried with a short exponential backoff and then reported.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = RENAME_BACKOFF_MS;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (
        attempt >= RENAME_ATTEMPTS ||
        code === null ||
        !TRANSIENT_RENAME_CODES.has(code)
      ) {
        throw error;
      }
      await sleep(delay);
      delay *= 2;
    }
  }
}

/**
 * Name of the temporary file a save writes before renaming it into place.
 *
 * The pid separates concurrent instances and the random suffix separates two
 * saves inside the same millisecond, which a pid alone does not. Both are
 * needed: a collision would have two writers renaming over each other.
 */
function temporaryName(target: string): string {
  return `${basename(target)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/** Whether `name` is a temporary file this module created for `target`. */
function isTemporaryFor(name: string, target: string): boolean {
  const prefix = `${basename(target)}.tmp-`;
  if (!name.startsWith(prefix)) return false;
  return /^\d+-[0-9a-f]+$/.test(name.slice(prefix.length));
}

/** Orphaned temporaries older than this are leftovers from a crashed run. */
const ORPHAN_AGE_MS = 60_000;

/**
 * Remove temporary files this module left behind, from runs that died between
 * writing and renaming.
 *
 * Two deliberate limits. Only names matching {@link isTemporaryFor} are
 * considered, so a user's own `snapshot.json.bak` is never touched and the
 * directory is never cleared wholesale. And only files older than
 * {@link ORPHAN_AGE_MS} are removed, so a *concurrent* instance's in-flight
 * temporary -- which is younger by definition -- cannot be deleted out from
 * under it.
 *
 * Best effort by design: this is housekeeping, so a failure here must not fail a
 * save that otherwise succeeded.
 */
async function removeOrphanedTemporaries(
  target: string,
  now: number,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dirname(target));
  } catch {
    return;
  }

  for (const name of names) {
    if (!isTemporaryFor(name, target)) continue;

    const candidate = join(dirname(target), name);
    try {
      const stats = await stat(candidate);
      if (now - stats.mtimeMs < ORPHAN_AGE_MS) continue;
      await rm(candidate, { force: true });
    } catch {
      // Another instance may have cleaned it first, or it may be locked. Either
      // way this is not the save's problem.
    }
  }
}

export interface SaveSnapshotOptions {
  /**
   * Remove leftover temporary files from crashed runs before writing.
   *
   * On by default. Tests turn it off to assert what a save does on its own.
   */
  cleanupOrphans?: boolean;
}

/**
 * Write `snapshot` to `path` atomically.
 *
 * The body is written to a temporary file *in the same directory* and then
 * renamed over the target. Same directory is not an optimisation: it keeps the
 * rename within one filesystem, which is what makes it atomic. A temporary in
 * `os.tmpdir()` could land on another volume, where the rename fails with
 * `EXDEV` and is not atomic even when it succeeds.
 *
 * The consequence is the property the README promises: a crash mid-write can
 * never leave a truncated snapshot that reads as "everything vanished". The
 * target holds either the complete previous snapshot or the complete new one,
 * never a partial write.
 *
 * The parent directory is created when missing -- the snapshot directory is
 * this module's own, so it is this module's to create. If that fails, or if the
 * write or rename fails, the previous snapshot is left untouched and a
 * {@link SnapshotWriteError} is thrown.
 *
 * The body is UTF-8 with no BOM, `JSON.stringify(…, 2)`, and a trailing
 * newline. Field order follows the object's declaration order, which is stable
 * for a given shape but not semantically meaningful: the loader reads by key,
 * so a reordering is not a format change.
 *
 * @param path - absolute path to the snapshot file.
 * @param snapshot - the complete snapshot to store.
 * @throws {SnapshotWriteError} when the snapshot could not be replaced.
 */
export async function saveSnapshot(
  path: string,
  snapshot: Snapshot,
  options: SaveSnapshotOptions = {},
): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, temporaryName(path));

  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    throw new SnapshotWriteError(
      `Could not create the snapshot directory ${directory}: ${oneLine((error as Error).message)}`,
      errorCode(error),
    );
  }

  // Written without a BOM on purpose. The loader strips one to tolerate files
  // from elsewhere, but this module should not be the reason one appears.
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;

  try {
    await writeFile(temporary, body, "utf8");
  } catch (error) {
    await discard(temporary);
    throw new SnapshotWriteError(
      `Could not write the temporary snapshot ${temporary}: ${oneLine((error as Error).message)}`,
      errorCode(error),
    );
  }

  try {
    await renameWithRetry(temporary, path);
  } catch (error) {
    // The target still holds the previous snapshot, which is the safe outcome.
    // The temporary is removed so the failure leaves nothing behind.
    await discard(temporary);
    throw new SnapshotWriteError(
      `Could not replace the snapshot at ${path}: ${oneLine((error as Error).message)}. ` +
        "The previous snapshot is unchanged.",
      errorCode(error),
    );
  }

  if (options.cleanupOrphans !== false) {
    await removeOrphanedTemporaries(path, Date.now());
  }
}

/** Remove a temporary file, ignoring failures: there is nothing useful to say. */
async function discard(temporary: string): Promise<void> {
  try {
    await rm(temporary, { force: true });
  } catch {
    // Best effort. A leftover temporary is harmless and is swept on a later save.
  }
}

/**
 * The name a quarantined snapshot is moved to, given the slot number.
 *
 * Exported because the suffix is part of the user-visible contract: the README
 * documents `snapshot.json.corrupt-<n>`, and task 13's output repeats it.
 */
export function quarantinePath(path: string, slot: number): string {
  return `${path}.corrupt-${slot}`;
}

/** Highest slot already taken, or 0 when none is. */
async function highestOccupiedSlot(path: string): Promise<number> {
  const prefix = `${basename(path)}.corrupt-`;
  let highest = 0;

  let names: string[];
  try {
    names = await readdir(dirname(path));
  } catch {
    return 0;
  }

  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const slot = Number.parseInt(name.slice(prefix.length), 10);
    if (Number.isInteger(slot) && slot > highest) highest = slot;
  }

  return highest;
}

/** Slots are tried from 1 upwards; this bounds a directory that is somehow full. */
const QUARANTINE_SLOT_LIMIT = 10_000;

/**
 * How many slots one call may lose to concurrent writers before giving up.
 *
 * Losing a slot means another instance took the name between the scan and the
 * rename. A handful of losses is plausible; hundreds would mean something is
 * actively racing, and stopping is safer than spinning.
 */
const QUARANTINE_MAX_ATTEMPTS = 50;

/**
 * Claim `destination` exclusively, or fail because someone else has it.
 *
 * A bare `rename` cannot express "do not overwrite": POSIX `rename(2)` replaces
 * an existing destination silently, and Node's Windows rename passes
 * `MOVEFILE_REPLACE_EXISTING`, so the "destination already exists" branch this
 * guards was unreachable on both platforms. The empty file it creates is
 * overwritten by the rename that follows, so it is a reservation rather than a
 * placeholder with content, and `readdir` makes it visible to another instance's
 * slot scan immediately.
 *
 * A crash between reserving and moving leaves an empty `.corrupt-<n>` behind.
 * POSIX has no "rename only if absent", so an exclusive claim is the price of
 * never overwriting an earlier quarantine, and the litter is not loss: the
 * damaged file is still at `path`, and the next attempt steps past the empty
 * slot. It cannot be swept by size, because a snapshot that was legitimately
 * zero bytes quarantines to a zero-byte file too.
 */
async function reserveExclusively(destination: string): Promise<void> {
  const handle = await open(destination, "wx");
  await handle.close();
}

/**
 * Move a corrupt snapshot aside so a fresh one can be written, never deleting it.
 *
 * Implements the README's "quarantined, never discarded": the file is moved to
 * `snapshot.json.corrupt-<n>`, byte for byte, and the caller is told where it
 * went so the user can be told too. The alternative -- resetting silently --
 * would lose pending changes with no way to distinguish that from "nothing
 * happened".
 *
 * A slot is claimed by creating it exclusively before the move, so an existing
 * quarantine can never be overwritten -- losing an earlier damaged snapshot to a
 * later one would be the same data loss in a different place. The scan for the
 * highest slot is only an optimisation: if it is stale, or another instance
 * claims the same slot first, the exclusive create fails with `EEXIST` and the
 * next slot is tried.
 *
 * Takes a branded {@link QuarantinableSnapshot} rather than a `SnapshotLoad`, so
 * an `unreadable` result cannot reach here: a file that could not be read is not
 * known to be damaged, and moving it would destroy a healthy snapshot.
 *
 * @param result - a load result produced by {@link asQuarantinable}.
 * @returns the path the file now occupies.
 * @throws {SnapshotWriteError} when the file could not be moved.
 */
export async function quarantineCorruptSnapshot(
  result: QuarantinableSnapshot,
): Promise<string> {
  const { path } = result;
  const firstSlot = (await highestOccupiedSlot(path)) + 1;

  if (firstSlot > QUARANTINE_SLOT_LIMIT)
    throw exhausted(path, QUARANTINE_SLOT_LIMIT);

  let destination = quarantinePath(path, firstSlot);

  for (let attempt = 0; attempt < QUARANTINE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await reserveExclusively(destination);
    } catch (error) {
      const code = errorCode(error);

      // The slot is taken -- by an earlier quarantine, by another instance, or
      // by something else entirely. Overwriting it would destroy an earlier
      // damaged snapshot, which is the same data loss in a different place, so
      // step to the next slot instead.
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR") {
        const next = nextFreeSlot(destination, path);
        if (next === null) throw exhausted(path, QUARANTINE_SLOT_LIMIT);
        destination = next;
        continue;
      }

      throw new SnapshotWriteError(
        `Could not quarantine ${path}: could not reserve ${destination}: ${oneLine((error as Error).message)}. ` +
          "The file has been left where it is.",
        code,
      );
    }

    try {
      // Replaces only the reservation just created above, so nothing that
      // already existed can be lost even if the scan was stale.
      await renameWithRetry(path, destination);
      return destination;
    } catch (error) {
      // Release the reservation: leaving a zero-byte `.corrupt-<n>` beside the
      // real file would look like a recoverable copy that holds nothing.
      await discard(destination);

      const code = errorCode(error);

      if (code === "ENOENT") {
        throw new SnapshotWriteError(
          `Could not quarantine ${path}: it no longer exists. The reserved slot was released and nothing was moved.`,
          code,
        );
      }

      throw new SnapshotWriteError(
        `Could not quarantine ${path} to ${destination}: ${oneLine((error as Error).message)}. ` +
          "The file has been left where it is.",
        code,
      );
    }
  }

  // Every attempt lost its slot to another writer. Giving up is correct: the
  // file stays where it is, and nothing that already exists was overwritten.
  throw new SnapshotWriteError(
    `Could not quarantine ${path} after ${QUARANTINE_MAX_ATTEMPTS} attempts, because other ` +
      "writers kept claiming the next slot. The file has been left where it is and no " +
      "existing quarantine file was overwritten.",
    null,
  );
}

/** The next unused `.corrupt-<n>` path after `from`, or `null` past the limit. */
function nextFreeSlot(from: string, path: string): string | null {
  const prefix = `${basename(path)}.corrupt-`;
  const current = Number.parseInt(basename(from).slice(prefix.length), 10);
  const next = (Number.isInteger(current) ? current : 0) + 1;
  return next > QUARANTINE_SLOT_LIMIT ? null : quarantinePath(path, next);
}

/** The error raised when the slot space is used up. */
function exhausted(path: string, limit: number): SnapshotWriteError {
  return new SnapshotWriteError(
    `Could not quarantine ${path}: no free .corrupt-<n> slot in the first ${limit}. ` +
      "No existing quarantine file was overwritten.",
    null,
  );
}
