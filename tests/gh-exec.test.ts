import { describe, it, expect } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  classify,
  classifySpawnFailure,
  isReadOnlyInvocation,
  normaliseNewlines,
  phaseOneArgs,
  phaseTwoArgs,
  redact,
  runGh,
  summariseStderr,
  type GhExecRequest,
  type GhExecutor,
  type GhOutcome,
  type GhProcessResult,
} from "../src/gh-exec";

/**
 * A completed process, defaulted to a clean success.
 *
 * Every test drives `runGh` through a fake executor built from this, so no test
 * runs a real `gh`, touches the network, or depends on what this machine has
 * installed. That is the point of the executor seam: the whole error taxonomy
 * is a pure function of what the executor reports.
 */
function processResult(
  overrides: Partial<GhProcessResult> = {},
): GhProcessResult {
  return {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stdoutLossy: false,
    timedOut: false,
    ...overrides,
  };
}

/** An executor that always reports one finished process. */
function executorOf(result: GhProcessResult): GhExecutor {
  return async () => ({ ok: true, process: result });
}

/** An executor that reports a failure to start at all. */
function spawnFailureOf(code: string | null, message = "boom"): GhExecutor {
  return async () => ({ ok: false, failure: { code, message } });
}

/** Collect the request a fake executor was called with. */
function recordingExecutor(result: GhProcessResult): {
  executor: GhExecutor;
  calls: GhExecRequest[];
} {
  const calls: GhExecRequest[] = [];
  return {
    calls,
    executor: async (request) => {
      calls.push(request);
      return { ok: true, process: result };
    },
  };
}

/** Narrow to a failure, failing the test if the call unexpectedly succeeded. */
function expectFailure(outcome: GhOutcome) {
  expect(outcome.status).toBe("failed");
  if (outcome.status !== "failed") throw new Error("expected a failure");
  return outcome;
}

describe("runGh — success is decided by the exit code alone", () => {
  it("returns stdout verbatim on a clean exit", async () => {
    const outcome = await runGh(["pr", "view", "1"], {
      executor: executorOf(processResult({ stdout: '{"state":"OPEN"}' })),
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.stdout).toBe('{"state":"OPEN"}');
  });

  it("reports an EMPTY result as success, not failure", async () => {
    const outcome = await runGh(["search", "prs"], {
      executor: executorOf(processResult({ stdout: "", code: 0 })),
    });

    // The README's whole reason for this module: "an empty result looks
    // identical to a failed gh call". An empty success and a failure must be
    // distinguishable, and this is the assertion that pins it.
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.stdout).toBe("");
  });

  it("keeps whitespace-only output as a success", async () => {
    const outcome = await runGh(["pr", "list"], {
      executor: executorOf(processResult({ stdout: "\n", code: 0 })),
    });

    expect(outcome.status).toBe("ok");
  });

  it("distinguishes empty success from failure in the type, not by convention", async () => {
    const empty = await runGh([], {
      executor: executorOf(processResult({ stdout: "" })),
    });
    const failed = await runGh([], {
      executor: executorOf(processResult({ code: 1, stderr: "boom" })),
    });

    // Both carry an empty stdout, and they are still told apart.
    expect(empty.status).toBe("ok");
    expect(failed.status).toBe("failed");
  });

  it("preserves multi-byte content exactly", async () => {
    const title = "docs(zh): 添加俄语区域设置 🚀 \u00e9\u00e8";
    const outcome = await runGh(["pr", "view"], {
      executor: executorOf(processResult({ stdout: title })),
    });

    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.stdout).toBe(title);
  });

  it("normalises CRLF so downstream JSON parsing is not defeated", async () => {
    const outcome = await runGh(["pr", "view"], {
      executor: executorOf(processResult({ stdout: '{\r\n  "a": 1\r\n}\r\n' })),
    });

    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.stdout).toBe('{\n  "a": 1\n}\n');
    expect(outcome.stdout).not.toContain("\r");
  });

  it("surfaces truncation rather than hiding it", async () => {
    const outcome = await runGh([], {
      executor: executorOf(
        processResult({ stdout: "partial", stdoutTruncated: true }),
      ),
    });

    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.stdoutTruncated).toBe(true);
  });

  it("flags lossy UTF-8 decoding instead of crashing", async () => {
    const outcome = await runGh([], {
      executor: executorOf(
        processResult({ stdout: "bad \uFFFD byte", stdoutLossy: true }),
      ),
    });

    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.stdoutLossy).toBe(true);
  });

  it("passes the arguments through as an array, never a shell string", async () => {
    const { executor, calls } = recordingExecutor(processResult());
    const args = [
      "pr",
      "view",
      "https://github.com/octo/repo/pull/7",
      "--json",
      "state",
    ];

    await runGh(args, { executor });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(args);
    expect(Array.isArray(calls[0].args)).toBe(true);
  });

  it("defaults the deadline and lets it be overridden", async () => {
    const { executor, calls } = recordingExecutor(processResult());

    await runGh([], { executor });
    await runGh([], { executor, timeoutMs: 1234 });

    expect(calls[0].timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(calls[1].timeoutMs).toBe(1234);
  });

  it("disables prompts and colour in the child environment", async () => {
    const { executor, calls } = recordingExecutor(processResult());

    await runGh([], { executor });

    // A prompt would hang until the timeout, and colour codes would pollute a
    // message that gets redacted and shown to a user.
    expect(calls[0].env.GH_PROMPT_DISABLED).toBe("1");
    expect(calls[0].env.NO_COLOR).toBe("1");
  });

  it("lets a caller override the binary without recompiling the module", async () => {
    const { executor, calls } = recordingExecutor(processResult());

    await runGh([], { executor, binary: "/opt/gh" });

    expect(calls[0].binary).toBe("/opt/gh");
  });

  it("defaults the binary to gh", async () => {
    const { executor, calls } = recordingExecutor(processResult());

    await runGh([], { executor });

    expect(calls[0].binary).toBe("gh");
  });
});

describe("runGh — gh is not installed", () => {
  it("classifies ENOENT as not-installed", async () => {
    const outcome = expectFailure(
      await runGh([], { executor: spawnFailureOf("ENOENT") }),
    );

    expect(outcome.kind).toBe("not-installed");
  });

  it("gives install instructions and a Windows diagnostic", async () => {
    const outcome = expectFailure(
      await runGh([], { executor: spawnFailureOf("ENOENT") }),
    );

    expect(outcome.message).toContain("https://cli.github.com");
    expect(outcome.message).toContain("PATH");
    // Actionable on Windows, where `which gh` is not the right command.
    expect(outcome.message).toContain("where gh");
  });

  it("is not confused with an unauthenticated result", async () => {
    const missing = expectFailure(
      await runGh([], { executor: spawnFailureOf("ENOENT") }),
    );
    const unauthenticated = expectFailure(
      await runGh([], {
        executor: executorOf(
          processResult({
            code: 4,
            stderr: "not logged into any GitHub hosts",
          }),
        ),
      }),
    );

    expect(missing.kind).not.toBe(unauthenticated.kind);
  });

  it("classifies an executor that throws as a failure, not a crash", async () => {
    const throwing: GhExecutor = async () => {
      throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
    };

    const outcome = expectFailure(await runGh([], { executor: throwing }));

    expect(outcome.status).toBe("failed");
  });

  it("names the .cmd shim problem when Node refuses a wrapper script", async () => {
    const outcome = expectFailure(
      await runGh([], {
        executor: spawnFailureOf(
          "EINVAL",
          "spawn EINVAL: cannot run C:\\Users\\me\\npm\\gh.cmd without a shell",
        ),
      }),
    );

    // Setting shell:true to work around this would reintroduce the injection
    // surface the array-argument design removes, so it is reported instead.
    expect(outcome.kind).toBe("shim");
    expect(outcome.message).toContain("cli.github.com");
  });
});

describe("runGh — classification of a non-zero exit", () => {
  it("keeps the exit code and the stderr", async () => {
    const outcome = expectFailure(
      await runGh([], {
        executor: executorOf(
          processResult({ code: 2, stderr: "something went wrong" }),
        ),
      }),
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("something went wrong");
    expect(outcome.kind).toBe("exit");
  });

  it("classifies a missing credential as unauthenticated", async () => {
    const outcome = expectFailure(
      await runGh([], {
        executor: executorOf(
          processResult({
            code: 4,
            stderr:
              "You are not logged into any GitHub hosts. Run gh auth login",
          }),
        ),
      }),
    );

    expect(outcome.kind).toBe("unauthenticated");
    expect(outcome.message).toContain("gh auth login");
  });

  it("classifies expired credentials as unauthenticated too", async () => {
    const outcome = expectFailure(
      await runGh([], {
        executor: executorOf(
          processResult({ code: 1, stderr: "HTTP 401: Bad credentials" }),
        ),
      }),
    );

    expect(outcome.kind).toBe("unauthenticated");
  });

  it.each([
    ["dial tcp 140.82.121.3:443: connect: connection refused"],
    ["lookup api.github.com: no such host"],
    ["net/http: TLS handshake timeout"],
    ["proxyconnect tcp: dial tcp: i/o timeout"],
  ])("classifies %s as a network failure", async (stderr) => {
    const outcome = expectFailure(
      await runGh([], {
        executor: executorOf(processResult({ code: 1, stderr })),
      }),
    );

    expect(outcome.kind).toBe("network");
  });

  it("keeps the three failure kinds mutually distinct", async () => {
    const kinds = await Promise.all(
      [
        processResult({ code: 1, stderr: "not logged into any GitHub hosts" }),
        processResult({ code: 1, stderr: "dial tcp: connection refused" }),
        processResult({ code: 1, stderr: "unknown flag: --nope" }),
      ].map(
        async (result) =>
          expectFailure(await runGh([], { executor: executorOf(result) })).kind,
      ),
    );

    expect(new Set(kinds).size).toBe(3);
    expect(kinds).toEqual(["unauthenticated", "network", "exit"]);
  });

  it("says so when gh was killed by a signal", async () => {
    const outcome = expectFailure(
      await runGh([], {
        executor: executorOf(processResult({ code: null, signal: "SIGKILL" })),
      }),
    );

    expect(outcome.kind).toBe("signal");
    expect(outcome.signal).toBe("SIGKILL");
    expect(outcome.message).toContain("SIGKILL");
  });

  it("treats a timeout as its own kind, not as an exit failure", async () => {
    const outcome = expectFailure(
      await runGh([], {
        executor: executorOf(processResult({ code: null, timedOut: true })),
      }),
    );

    expect(outcome.kind).toBe("timeout");
    expect(outcome.message).toContain("did not finish");
  });

  it("does not mistake a partial result for an empty success", async () => {
    // Wrote some output, then died by signal. The stdout is present but this is
    // a failure, and specifically a signal death rather than an exit code.
    const outcome = expectFailure(
      await runGh([], {
        executor: executorOf(
          processResult({
            code: null,
            signal: "SIGKILL",
            stdout: '[{"url":',
            stderr: "killed",
          }),
        ),
      }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.kind).toBe("signal");
    expect(outcome.stdout).toBe('[{"url":');
  });
});

describe("redact — credentials never survive", () => {
  it.each([
    ["token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "ghp_"],
    ["token gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "gho_"],
    ["token github_pat_11ABCDEFG0abcdefghijklmnop", "github_pat_"],
    ["token ghs_1234567890abcdefghijklmnopqrstuvwxyz", "ghs_"],
    ["token ghr_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "ghr_"],
  ])("masks %s", async (text, secretPrefix) => {
    const output = redact(text);

    expect(output).not.toContain(secretPrefix);
    expect(output).toContain("[redacted]");
  });

  it("masks an Authorization header", async () => {
    const output = redact(
      "Authorization: token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );

    expect(output).not.toContain("ghp_");
  });

  it("masks a Bearer token", async () => {
    const output = redact(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    );

    expect(output).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("masks credentials embedded in a URL", async () => {
    const output = redact(
      "fatal: could not read https://octocat:hunter2@github.com/x.git",
    );

    expect(output).not.toContain("hunter2");
    // The host survives, so the message is still diagnostic.
    expect(output).toContain("github.com");
  });

  it("masks a secret query parameter but keeps the parameter name", async () => {
    const output = redact(
      "GET https://api.github.com/x?access_token=abc123def456&page=2",
    );

    expect(output).not.toContain("abc123def456");
    expect(output).toContain("access_token=");
    expect(output).toContain("page=2");
  });

  it("masks a secret-shaped environment assignment", async () => {
    const output = redact("GITHUB_TOKEN=ghp_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ");

    expect(output).not.toContain("ghp_");
  });

  it("truncates a long opaque run rather than echoing it", async () => {
    const blob = "A".repeat(200);
    const output = redact(`unrecognised value: ${blob}`);

    expect(output).not.toContain(blob);
    expect(output).toContain("chars withheld");
  });

  it("bounds the total length", async () => {
    const output = redact("line of text\n".repeat(500));

    expect(output.length).toBeLessThan(700);
    expect(output).toContain("[truncated]");
  });

  it("stays useful: the diagnosis is preserved", async () => {
    const output = redact(
      "gh: Not Found (HTTP 404) for token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );

    expect(output).toContain("Not Found");
    expect(output).toContain("404");
    expect(output).not.toContain("ghp_");
  });

  it.each([
    "password=hunter2",
    "api_key: abcdef123456",
    "client_secret=shhhh",
    "AWS_SECRET_ACCESS_KEY=abcd1234",
  ])("masks %s", async (text) => {
    const output = redact(text);

    expect(output).toContain("[redacted]");
  });

  it("leaves ordinary text alone", () => {
    const text =
      "gh: Could not resolve to a PullRequest with the number of 41.";

    expect(redact(text)).toBe(text);
  });

  it("keeps the last lines of stderr and redacts them", () => {
    const output = summariseStderr(
      [
        "line one",
        "line two",
        "line three",
        "token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ].join("\n"),
    );

    expect(output).not.toContain("ghp_");
    expect(output).toContain("line three");
  });
});

describe("classify — pure classification of a process result", () => {
  it("calls an empty success ok", () => {
    expect(classify(processResult()).status).toBe("ok");
  });

  it("redacts before the message is built", () => {
    const outcome = classify(
      processResult({
        code: 1,
        stderr: "auth failed for ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    // The module boundary is where redaction happens: a secret that travelled
    // further would already have escaped.
    expect(outcome.message).not.toContain("ghp_");
    expect(outcome.stderr).not.toContain("ghp_");
  });

  it("keeps messages on one line so they interpolate safely", () => {
    const outcome = classify(
      processResult({ code: 1, stderr: "first\nsecond\nthird" }),
    );

    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.message).not.toContain("\n");
  });
});

describe("classifySpawnFailure — pure spawn classification", () => {
  it("maps ENOENT to not-installed with actionable advice", () => {
    const outcome = classifySpawnFailure({
      code: "ENOENT",
      message: "spawn gh ENOENT",
    });

    expect(outcome.kind).toBe("not-installed");
    expect(outcome.message).toContain("cli.github.com");
  });

  it("maps an unknown errno to unknown", () => {
    const outcome = classifySpawnFailure({
      code: "EMFILE",
      message: "too many open files",
    });

    expect(outcome.kind).toBe("unknown");
    expect(outcome.message).toContain("EMFILE");
  });

  it("handles a missing errno without crashing", () => {
    const outcome = classifySpawnFailure({
      code: null,
      message: "something odd",
    });

    expect(outcome.status).toBe("failed");
  });

  it("redacts the raw message it reports", () => {
    const outcome = classifySpawnFailure({
      code: null,
      message: "failed with ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });

    expect(outcome.message).not.toContain("ghp_");
  });
});

describe("normaliseNewlines", () => {
  it("converts CRLF to LF", () => {
    expect(normaliseNewlines("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("leaves lone LF alone", () => {
    expect(normaliseNewlines("a\nb")).toBe("a\nb");
  });

  it("leaves a lone CR alone, since it is not a line separator here", () => {
    expect(normaliseNewlines("a\rb")).toBe("a\rb");
  });
});

describe("isReadOnlyInvocation — the plugin only ever looks", () => {
  it.each([
    [["search", "prs", "--author", "@me"]],
    [["pr", "view", "https://github.com/o/r/pull/1", "--json", "state"]],
    [["pr", "list", "--author", "@me"]],
    [["pr", "status"]],
  ])("permits %j", (args) => {
    expect(isReadOnlyInvocation(args)).toBe(true);
  });

  it("permits api when no method or body is implied", () => {
    expect(isReadOnlyInvocation(["api", "/user"])).toBe(true);
    expect(isReadOnlyInvocation(["api", "graphql"])).toBe(true);
  });

  it.each([
    [["pr", "comment", "1", "--body", "hi"]],
    [["pr", "close", "1"]],
    [["pr", "merge", "1"]],
    [["pr", "create"]],
    [["pr", "edit", "1"]],
    [["repo", "delete"]],
    [["issue", "close", "1"]],
    [["auth", "login"]],
    [["api", "--method", "POST", "/repos/o/r/issues"]],
    [["api", "-X", "PATCH", "/repos/o/r"]],
    [["api", "-X", "DELETE", "/repos/o/r"]],
    [["api", "--method=POST", "/x"]],
    [["api", "-f", "body=hi", "/repos/o/r/issues"]],
    [["api", "--raw-field", "body=hi", "/x"]],
    // `gh` reads these attached spellings as the same flags, so the guard has
    // to as well -- otherwise `-XPOST` is admitted as a read.
    [["api", "-XPOST", "/repos/o/r/issues"]],
    [["api", "-X", "/repos/o/r"]],
    [["api", "-fbody=hi", "/repos/o/r/issues"]],
    [["api", "-Fbody=hi", "/repos/o/r/issues"]],
    [["api", "--field=body=hi", "/x"]],
    [["api", "--raw-field=body=hi", "/x"]],
    // `--input` supplies a body from a file, and gh still defaults the method
    // to POST, so it is a write even though the flag names a file.
    [["api", "--input", "body.json", "/repos/o/r/rulesets"]],
    [["api", "--input=body.json", "/repos/o/r/rulesets"]],
    [[]],
  ])("refuses %j", (args) => {
    expect(isReadOnlyInvocation(args)).toBe(false);
  });

  it("permits an explicit GET on api", () => {
    expect(isReadOnlyInvocation(["api", "-X", "GET", "/user"])).toBe(true);
    expect(isReadOnlyInvocation(["api", "--method=GET", "/user"])).toBe(true);
    expect(isReadOnlyInvocation(["api", "-XGET", "/user"])).toBe(true);
    expect(isReadOnlyInvocation(["api", "--method=get", "/user"])).toBe(true);
  });

  it("admits the argument lists the plugin actually builds", () => {
    // These are the only argument lists in `src/`, and this is the check the
    // allow-list exists for. Without it the guard would be decorative.
    expect(isReadOnlyInvocation(phaseOneArgs())).toBe(true);
    expect(
      isReadOnlyInvocation(phaseTwoArgs("https://github.com/o/r/pull/1")),
    ).toBe(true);
  });

  it("is an allow-list, so an unknown future write verb is refused by default", () => {
    expect(isReadOnlyInvocation(["pr", "some-future-write-verb"])).toBe(false);
    expect(isReadOnlyInvocation(["release", "delete", "v1"])).toBe(false);
  });
});

describe("spawnGh — the real executor, driven against node instead of gh", () => {
  // These run a real child process, but never `gh` and never the network: the
  // node binary is used as a stand-in so the stream handling, decoding, byte
  // budget, and kill path are exercised for real rather than described.
  const node = process.execPath;
  const run = (args: string[], timeoutMs = 10_000) =>
    runGh(args, { binary: node, timeoutMs });

  it("captures stdout from a real process", async () => {
    const outcome = await run(["-e", "process.stdout.write('hello')"]);

    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.stdout).toBe("hello");
  });

  it("reports an empty success for a silent process", async () => {
    const outcome = await run(["-e", ""]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.stdout).toBe("");
  });

  it("reads output far larger than the old execFile maxBuffer without truncating", async () => {
    // 2 MB: well past Node's historical 1 MB maxBuffer, and enough to prove the
    // pipe is drained rather than deadlocked.
    const outcome = await run([
      "-e",
      "const c='x'.repeat(1024); for (let i=0;i<2048;i++) process.stdout.write(c);",
    ]);

    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.stdoutTruncated).toBe(false);
    expect(outcome.stdout.length).toBe(2 * 1024 * 1024);
  });

  it("does not call output truncated when it exactly fills the budget", async () => {
    // The boundary used to compare with `>=`, which reported a full budget as
    // truncated even though not a byte had been dropped.
    const chunk = 65_536;
    const outcome = await run(
      [
        "-e",
        `const c='x'.repeat(${chunk}); for (let i=0;i<${MAX_OUTPUT_BYTES / chunk};i++) process.stdout.write(c);`,
      ],
      30_000,
    );

    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.stdout.length).toBe(MAX_OUTPUT_BYTES);
    expect(outcome.stdoutTruncated).toBe(false);
  });

  it("flags a partial sequence left at the end of the stream", async () => {
    // Two bytes of a three-byte character, then exit: `end()` can only emit a
    // replacement character, and that loss has to be reported like any other.
    const outcome = await run([
      "-e",
      "process.stdout.write(Buffer.from([0xe4,0xb8]))",
    ]);

    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.stdoutLossy).toBe(true);
  });

  it("decodes UTF-8 split across chunk boundaries", async () => {
    // Written in small pieces so a multi-byte character straddles a chunk.
    const outcome = await run([
      "-e",
      "const b=Buffer.from('添加俄语🚀','utf8'); for(const x of b) process.stdout.write(Buffer.from([x]));",
    ]);

    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.stdout).toBe("添加俄语🚀");
    expect(outcome.stdoutLossy).toBe(false);
  });

  it("normalises CRLF from a real process", async () => {
    const outcome = await run(["-e", "process.stdout.write('a\\r\\nb\\r\\n')"]);

    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.stdout).toBe("a\nb\n");
  });

  it("does not crash on invalid UTF-8, and flags it", async () => {
    const outcome = await run([
      "-e",
      "process.stdout.write(Buffer.from([0xff,0xfe,0x41,0x42]))",
    ]);

    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.stdoutLossy).toBe(true);
    expect(outcome.stdout).toContain("AB");
  });

  it("carries a non-zero exit code and stderr", async () => {
    const outcome = await run([
      "-e",
      "process.stderr.write('nope'); process.exit(3)",
    ]);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.exitCode).toBe(3);
    expect(outcome.stderr).toContain("nope");
  });

  it("kills a hung process at the deadline and reports a timeout", async () => {
    const started = Date.now();
    const outcome = await run(["-e", "setTimeout(() => {}, 60_000)"], 250);
    const elapsed = Date.now() - started;

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.kind).toBe("timeout");
    // It returned near the deadline rather than waiting for the child.
    expect(elapsed).toBeLessThan(10_000);
  });

  it("leaves no orphan process behind after a timeout", async () => {
    // The child announces its own pid, so after the kill we can ask the OS
    // whether that process still exists rather than trusting the API.
    const outcome = await run(
      [
        "-e",
        "process.stdout.write(String(process.pid)); setTimeout(() => {}, 60_000)",
      ],
      400,
    );

    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.kind).toBe("timeout");

    const pid = Number.parseInt(outcome.stdout, 10);
    expect(Number.isInteger(pid)).toBe(true);

    // Allow the kill to be reaped, then look for the process.
    await new Promise((resolve) => setTimeout(resolve, 500));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("reports a binary that does not exist as not-installed", async () => {
    const outcome = await runGh(["--version"], {
      binary: "definitely-not-a-real-binary-xyz",
      timeoutMs: 5_000,
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.kind).toBe("not-installed");
  });

  it("treats a zero timeout as no deadline rather than an instant failure", async () => {
    const outcome = await runGh(["-e", "process.stdout.write('done')"], {
      binary: node,
      timeoutMs: 0,
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.stdout).toBe("done");
  });

  it("treats a negative timeout as no deadline too", async () => {
    const outcome = await runGh(["-e", "process.stdout.write('done')"], {
      binary: node,
      timeoutMs: -5,
    });

    expect(outcome.status).toBe("ok");
  });

  it("keeps concurrent calls independent", async () => {
    const [first, second, third] = await Promise.all([
      run(["-e", "process.stdout.write('one')"]),
      run(["-e", "process.stdout.write('two')"]),
      run(["-e", "process.stderr.write('x'); process.exit(1)"]),
    ]);

    if (first.status !== "ok" || second.status !== "ok") {
      throw new Error("expected two successes");
    }
    expect(first.stdout).toBe("one");
    expect(second.stdout).toBe("two");
    expect(third.status).toBe("failed");
  });

  it("reports max output bytes as a positive budget", () => {
    expect(MAX_OUTPUT_BYTES).toBeGreaterThan(1024 * 1024);
  });
});
