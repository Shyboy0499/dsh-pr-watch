import { describe, it, expect } from "vitest";
import {
  GhError,
  friendlyGhMessage,
  ghExec,
  ghJson,
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

// These exercise the real `gh` binary but never the network: `--version` and an
// unknown subcommand both resolve locally. GitHub-hosted runners ship gh.
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
