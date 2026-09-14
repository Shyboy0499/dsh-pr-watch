import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadSnapshot, saveSnapshot, snapshotPath } from "../src/snapshot";
import { record, snapshot } from "./fixtures";

const originalDshHome = process.env.DSH_HOME;
afterEach(() => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalDshHome;
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "dsh-pr-watch-"));
}

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

  it("lets an explicit override win over the environment", () => {
    process.env.DSH_HOME = "/tmp/dsh-home";
    expect(snapshotPath("/tmp/custom.json")).toBe("/tmp/custom.json");
  });
});

describe("loadSnapshot", () => {
  it("starts empty when no snapshot exists", async () => {
    const dir = tempDir();
    try {
      const { snapshot: loaded, warning } = await loadSnapshot(
        join(dir, "snapshot.json"),
      );
      expect(loaded.pullRequests).toEqual({});
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
      const { snapshot: loaded, warning } = await loadSnapshot(path);
      expect(loaded).toEqual(stored);
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
      const { snapshot: loaded, warning } = await loadSnapshot(path);

      expect(loaded.pullRequests).toEqual({});
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
