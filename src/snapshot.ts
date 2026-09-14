import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SNAPSHOT_VERSION, emptySnapshot, type Snapshot } from "./types";

/** Where the snapshot lives: `$DSH_HOME/pr-watch/snapshot.json`, else `~/.dsh/...`. */
export function snapshotPath(override?: string): string {
  if (override !== undefined && override.trim() !== "") return override;
  const configured = process.env.DSH_HOME?.trim();
  const base =
    configured !== undefined && configured !== "" ? configured : join(homedir(), ".dsh");
  return join(base, "pr-watch", "snapshot.json");
}

export interface LoadResult {
  snapshot: Snapshot;
  /** Set when the previous snapshot was unusable and had to be quarantined. */
  warning: string | null;
}

/**
 * Read the snapshot, tolerating a missing file and quarantining a corrupt one.
 *
 * A corrupt snapshot is never silently discarded: it is moved aside and the
 * caller is told, because a silent reset would lose pending changes in a way
 * indistinguishable from "nothing happened".
 */
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
        version: typeof parsed.version === "number" ? parsed.version : SNAPSHOT_VERSION,
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

/**
 * Write the snapshot atomically: a temporary file in the same directory is
 * renamed over the target, so a crash mid-write can never leave a truncated
 * snapshot that reads as "every pull request vanished".
 */
export async function saveSnapshot(path: string, data: Snapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
