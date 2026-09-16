import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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
