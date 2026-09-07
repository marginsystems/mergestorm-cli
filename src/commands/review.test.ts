import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { API_TIMEOUT_PREFIX } from "../api.js";
import type { Config } from "../config.js";
import { CommandError, DetachedError, REVIEW_EXIT } from "../errors.js";
import {
  cmdReview,
  isTransientReviewPollError,
  isTransientReviewPollStatus,
  parseReviewArgs,
  resolveReviewBase,
  VORTEX_ROUTER_CAPS,
  VORTEX_SPECIALIST_IDS,
  withReviewJobRecovery,
} from "./review.js";
import {
  collectReviewInput,
  formatReviewSubmitError,
  loadReviewContext,
  MAX_CONTEXT_FILE_CHARS,
  MAX_CONTEXT_FILES,
  MAX_REVIEW_DIFF_BYTES,
  REVIEW_POLL_INTERVAL_MS,
  pollReview,
  stretchedPollIntervalMs,
  transientRetryWaitMs,
} from "./review-client.js";

const CONTEXT_DEFAULTS = {
  context: undefined,
  contextFiles: [] as string[],
  idempotencyKey: undefined,
  webhookUrl: undefined,
  thread: undefined,
};

async function repoWithTrunk(
  prefix: string,
  trunk: "main" | "master",
): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", trunk], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  return { root, repo };
}

test("parseReviewArgs reads router and specialists (#1078)", () => {
  assert.deepEqual(parseReviewArgs(["main", "--router", "max"]), {
    base: "main",
    head: undefined,
    router: "max",
    specialists: [],
    format: "pretty",
    wait: true,
    timeoutMs: 480_000,
    ...CONTEXT_DEFAULTS,
  });
  assert.deepEqual(parseReviewArgs(["--specialists", "security,frontend"]), {
    base: undefined,
    head: undefined,
    router: "manual",
    specialists: ["security", "frontend"],
    format: "pretty",
    wait: true,
    timeoutMs: 480_000,
    ...CONTEXT_DEFAULTS,
  });
  assert.deepEqual(parseReviewArgs(["--specialists", "security,security,frontend"]), {
    base: undefined,
    head: undefined,
    router: "manual",
    specialists: ["security", "frontend"],
    format: "pretty",
    wait: true,
    timeoutMs: 480_000,
    ...CONTEXT_DEFAULTS,
  });
  assert.throws(() => parseReviewArgs(["--router", "turbo"]), /--router/);
  assert.throws(() => parseReviewArgs(["--specialists", "nope"]), /Unknown specialist/);
  assert.throws(() => parseReviewArgs(["--specialists", "governance"]), /Unknown specialist/);
  assert.throws(() => parseReviewArgs(["--specialists", "seam"]), /Unknown specialist/);
  assert.throws(() => parseReviewArgs(["--specialists", ","]), /--specialists/);
  assert.throws(() => parseReviewArgs(["--router", "manual"]), /--router manual/);
  assert.throws(() => parseReviewArgs(["--router", "off", "--specialists", "security"]), /--router off/);
  assert.throws(
    () => parseReviewArgs(["--router", "manual", "--specialists", "security,performance,architecture,tests,data,api"]),
    /--router manual/,
  );
  assert.throws(
    () => parseReviewArgs(["--router", "manual", "--specialists", "security,performance,architecture,tests,data,api,frontend"]),
    /--router manual/,
  );
  assert.deepEqual(
    parseReviewArgs(["--router", "manual", "--specialists", "security,performance,architecture,tests,data"]),
    {
      base: undefined,
      head: undefined,
      router: "manual",
      specialists: ["security", "performance", "architecture", "tests", "data"],
      format: "pretty",
      wait: true,
      timeoutMs: 480_000,
      ...CONTEXT_DEFAULTS,
    },
  );
});

test("parseReviewArgs reads machine output, wait, and timeout flags (#1286)", () => {
  assert.deepEqual(
    parseReviewArgs(["main", "HEAD", "--json", "--no-wait", "--timeout", "12.5"]),
    {
      base: "main",
      head: "HEAD",
      router: undefined,
      specialists: [],
      format: "json",
      wait: false,
      timeoutMs: 12_500,
      ...CONTEXT_DEFAULTS,
    },
  );
  assert.throws(() => parseReviewArgs(["--wait", "--no-wait"]), /cannot be combined/);
  assert.throws(() => parseReviewArgs(["--timeout", "0"]), /positive number/);
  assert.throws(
    () => parseReviewArgs(["--timeout", "later"]),
    (err: unknown) => err instanceof CommandError && err.exitCode === 2,
  );
});

test("parseReviewArgs reads context, thread, idempotency, and webhook flags", () => {
  assert.deepEqual(
    parseReviewArgs([
      "main",
      "--context",
      "focus on auth",
      "--context-file",
      "docs/adr/007.md",
      "--context-file=notes.txt",
      "--thread",
      "local/feat-x",
      "--idempotency-key",
      "run-1",
      "--webhook-url",
      "https://hooks.example.test/review",
    ]),
    {
      base: "main",
      head: undefined,
      router: undefined,
      specialists: [],
      format: "pretty",
      wait: true,
      timeoutMs: 480_000,
      context: "focus on auth",
      contextFiles: ["docs/adr/007.md", "notes.txt"],
      idempotencyKey: "run-1",
      webhookUrl: "https://hooks.example.test/review",
      thread: "local/feat-x",
    },
  );
  assert.equal(parseReviewArgs(["--context", "-"]).context, "-");
  assert.throws(() => parseReviewArgs(["--thread", "/bad"]), /--thread must be/);
  assert.throws(() => parseReviewArgs(["--webhook-url", "http://hooks.example.test"]), /https URL/);
  assert.throws(() => parseReviewArgs(["--idempotency-key", "x".repeat(129)]), /128/);
  assert.throws(() => parseReviewArgs(["--context-file"]), /requires a value/);
  assert.throws(() => parseReviewArgs(["--context", "--json"]), /requires a value/);
  assert.throws(() => parseReviewArgs(["--context-file", "--router"]), /requires a value/);
  assert.throws(() => parseReviewArgs(["--idempotency-key="]), /requires a value/);
  assert.throws(() => parseReviewArgs(["--webhook-url="]), /https URL/);
  assert.throws(() => parseReviewArgs(["--thread="]), /--thread must be/);
});

test("loadReviewContext caps files and reads --context - from stdin", async () => {
  const fixture = await repoWithTrunk("mg-review-context-", "main");
  const root = fixture.repo;
  try {
    const adr = path.join(root, "adr.md");
    await writeFile(adr, "prefer fail-closed\n");
    const loaded = await loadReviewContext({
      context: "-",
      contextFiles: [adr],
      cwd: root,
      readStdin: async () => "  focus on auth  ",
    });
    assert.equal(loaded.context, "focus on auth");
    assert.equal(loaded.contextFiles?.[0]?.path, "adr.md");
    assert.equal(loaded.contextFiles?.[0]?.content, "prefer fail-closed\n");

    await assert.rejects(
      () => loadReviewContext({ context: "", contextFiles: [] }),
      /--context is empty/,
    );
    await assert.rejects(
      () =>
        loadReviewContext({
          contextFiles: Array.from({ length: MAX_CONTEXT_FILES + 1 }, (_, i) => `f${i}.md`),
        }),
      /at most 10/,
    );
    const huge = path.join(root, "huge.md");
    await writeFile(huge, "x".repeat(MAX_CONTEXT_FILE_CHARS + 1));
    await assert.rejects(
      () => loadReviewContext({ contextFiles: [huge], cwd: root }),
      /per file/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resolveReviewBase prefers explicit base over discovery", async () => {
  const f = await repoWithTrunk("mg-review-base-explicit-", "master");
  try {
    assert.equal(resolveReviewBase("develop", f.repo), "develop");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("resolveReviewBase discovers master when main is absent", async () => {
  const f = await repoWithTrunk("mg-review-base-master-", "master");
  try {
    assert.equal(resolveReviewBase(undefined, f.repo), "master");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("resolveReviewBase discovers main", async () => {
  const f = await repoWithTrunk("mg-review-base-main-", "main");
  try {
    assert.equal(resolveReviewBase(undefined, f.repo), "main");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("resolveReviewBase hints when trunk cannot be discovered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mg-review-base-empty-"));
  try {
    // Not a git repo — discoverTrunk fails.
    assert.throws(
      () => resolveReviewBase(undefined, root),
      (err: unknown) =>
        err instanceof CommandError &&
        /Pass an explicit base: mergestorm review/.test(err.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transientRetryWaitMs honors Retry-After over backoff", () => {
  assert.equal(
    transientRetryWaitMs({ retryAfterSeconds: 8, failureCount: 1, random: () => 0 }),
    8_000,
  );
  assert.equal(transientRetryWaitMs({ failureCount: 1, random: () => 0 }), 125);
  assert.equal(transientRetryWaitMs({ failureCount: 2, random: () => 0 }), 250);
});

test("stretchedPollIntervalMs ramps the default 2s cadence toward 5s after 60s", () => {
  assert.equal(stretchedPollIntervalMs(0, REVIEW_POLL_INTERVAL_MS), 2_000);
  assert.equal(stretchedPollIntervalMs(59_999, REVIEW_POLL_INTERVAL_MS), 2_000);
  assert.equal(stretchedPollIntervalMs(120_000, REVIEW_POLL_INTERVAL_MS), 5_000);
  assert.equal(stretchedPollIntervalMs(120_000, 1), 1);
});

test("isTransientReviewPollStatus retries 408/429/5xx only", () => {
  assert.equal(isTransientReviewPollStatus(408), true);
  assert.equal(isTransientReviewPollStatus(429), true);
  assert.equal(isTransientReviewPollStatus(500), true);
  assert.equal(isTransientReviewPollStatus(503), true);
  assert.equal(isTransientReviewPollStatus(200), false);
  assert.equal(isTransientReviewPollStatus(401), false);
  assert.equal(isTransientReviewPollStatus(402), false);
  assert.equal(isTransientReviewPollStatus(404), false);
});

test("isTransientReviewPollError retries network/timeout, not auth", () => {
  assert.equal(
    isTransientReviewPollError(
      new CommandError(
        `${API_TIMEOUT_PREFIX} 30s. Check network connectivity and API status.`,
        1,
        "api_timeout",
      ),
    ),
    true,
  );
  // Message alone (no code) must not be treated as a timeout — copy can change.
  assert.equal(
    isTransientReviewPollError(
      new CommandError(`${API_TIMEOUT_PREFIX} 30s. Check network connectivity and API status.`),
    ),
    false,
  );
  assert.equal(isTransientReviewPollError(new TypeError("fetch failed")), true);
  assert.equal(
    isTransientReviewPollError(new Error("connect ECONNRESET")),
    true,
  );
  assert.equal(
    isTransientReviewPollError(
      new CommandError("API key invalid or revoked. Run `mergestorm login`.", 1, "auth_invalid"),
    ),
    false,
  );
  const abort = Object.assign(new Error("Aborted"), { name: "AbortError" });
  assert.equal(isTransientReviewPollError(abort), false);
});

test("withReviewJobRecovery appends status hint once", () => {
  const jobId = "job_abc";
  const once = withReviewJobRecovery("Poll failed: boom", jobId);
  assert.match(once, /Poll failed: boom/);
  assert.match(once, /Check: mergestorm status job_abc/);
  assert.equal(withReviewJobRecovery(once, jobId), once);
});

let originalFetch: typeof globalThis.fetch | undefined;

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
});

/** Queue of responses; the last entry repeats so an unexpected extra poll is visible. */
function mockReviewFetch(
  responses: { status: number; body: unknown; headers?: Record<string, string> }[],
): { calls: () => number; posts: () => unknown[] } {
  originalFetch = globalThis.fetch;
  let n = 0;
  const posts: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST" && typeof init.body === "string") {
      posts.push(JSON.parse(init.body));
    }
    const r = responses[Math.min(n, responses.length - 1)];
    n += 1;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json", ...r.headers },
    });
  };
  return { calls: () => n, posts: () => posts };
}

/** Temp repo with a real main...HEAD diff so cmdReview has something to submit. */
async function repoWithReviewDiff(prefix: string): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(path.join(repo, "a.txt"), "one\n");
  execFileSync("git", ["add", "a.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
  await writeFile(path.join(repo, "a.txt"), "two\n");
  execFileSync("git", ["add", "a.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "change"], { cwd: repo });
  return { root, repo };
}

/** Run fn from the temp repo with a fake API key, restoring cwd/env afterwards. */
async function runReviewInRepo(
  f: { root: string; repo: string },
  fn: () => Promise<void>,
): Promise<void> {
  const prevCwd = process.cwd();
  const prevKey = process.env.MERGESTORM_API_KEY;
  const prevUrl = process.env.MERGESTORM_API_URL;
  process.chdir(f.repo);
  process.env.MERGESTORM_API_KEY = "msk_live_test_key";
  process.env.MERGESTORM_API_URL = "https://api.example.test";
  try {
    await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevKey === undefined) delete process.env.MERGESTORM_API_KEY;
    else process.env.MERGESTORM_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.MERGESTORM_API_URL;
    else process.env.MERGESTORM_API_URL = prevUrl;
    await rm(f.root, { recursive: true, force: true });
  }
}

test("cmdReview retries a transient 503 poll and keeps looping", async () => {
  const f = await repoWithReviewDiff("mg-review-loop-503-");
  await runReviewInRepo(f, async () => {
    const mock = mockReviewFetch([
      { status: 202, body: { job_id: "job_loop_503", status: "queued" } },
      { status: 503, body: { error: "busy" } },
      { status: 200, body: { status: "in_progress" } },
      { status: 200, body: { status: "completed", verdict: "LGTM", summary: "ok" } },
    ]);
    await cmdReview(["main"], {});
    assert.equal(mock.calls(), 4);
  });
});

test("cmdReview surfaces status <job_id> after permanent 500 poll failure", async () => {
  const f = await repoWithReviewDiff("mg-review-loop-500-");
  await runReviewInRepo(f, async () => {
    mockReviewFetch([
      { status: 202, body: { job_id: "job_loop_500", status: "queued" } },
      { status: 500, body: { error: "boom" } },
      { status: 500, body: { error: "boom" } },
      { status: 500, body: { error: "boom" } },
      { status: 500, body: { error: "boom" } },
    ]);
    await assert.rejects(
      () => cmdReview(["main"], {}),
      (err: unknown) =>
        err instanceof CommandError &&
        err.exitCode === 4 &&
        /mergestorm status job_loop_500/.test(err.message),
    );
  });
});

test("cmdReview does not spin on 401 poll responses", async () => {
  const f = await repoWithReviewDiff("mg-review-loop-401-");
  await runReviewInRepo(f, async () => {
    const mock = mockReviewFetch([
      { status: 202, body: { job_id: "job_loop_401", status: "queued" } },
      { status: 401, body: { error: "unauthorized" } },
    ]);
    await assert.rejects(
      () => cmdReview(["main"], {}),
      (err: unknown) =>
        err instanceof CommandError &&
        /invalid or revoked/.test(err.message) &&
        /mergestorm status job_loop_401/.test(err.message),
    );
    assert.equal(mock.calls(), 2);
  });
});

test("cmdReview exits 4 when thrown poll transport failures exhaust retries (#1286)", async () => {
  const f = await repoWithReviewDiff("mg-review-transport-");
  await runReviewInRepo(f, async () => {
    originalFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async () => {
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({ job_id: "job_transport", status: "queued" }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new TypeError("fetch failed");
    };
    await assert.rejects(
      () => cmdReview(["main", "--timeout", "5"], { pollIntervalMs: 1 }),
      (err: unknown) =>
        err instanceof CommandError &&
        err.exitCode === 4 &&
        /mergestorm status job_transport/.test(err.message),
    );
  });
});

test("cmdReview JSON exits 5 when poll requests keep timing out before the deadline (#1286)", async () => {
  const f = await repoWithReviewDiff("mg-review-hung-");
  await runReviewInRepo(f, async () => {
    originalFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async () => {
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({ job_id: "job_hung", status: "queued" }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new CommandError(
        `${API_TIMEOUT_PREFIX} 30s. Check network connectivity and API status.`,
        1,
        "api_timeout",
      );
    };
    const captured = await captureReviewOutput(() =>
      cmdReview(["main", "--json", "--timeout", "30"], { pollIntervalMs: 1 }),
    );
    assert.ok(captured.error instanceof CommandError);
    assert.equal(captured.error.exitCode, 5);
    assert.equal(captured.error.code, "review_timeout");
    assert.equal(captured.stdout.length, 1);
    const envelope = JSON.parse(captured.stdout[0]!);
    assert.equal(envelope.job_id, "job_hung");
    assert.equal(envelope.status, "queued");
    assert.match(envelope.error, /Timed out/);
  });
});

test("cmdReview interactive detaches on Ctrl+C mid-poll (#1286)", async () => {
  const f = await repoWithReviewDiff("mg-review-abort-");
  await runReviewInRepo(f, async () => {
    originalFetch = globalThis.fetch;
    let n = 0;
    const ac = new AbortController();
    globalThis.fetch = async () => {
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({ job_id: "job_abort", status: "queued" }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      }
      ac.abort();
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    };
    await assert.rejects(
      () =>
        cmdReview(["main", "--timeout", "30"], {
          interactive: true,
          signal: ac.signal,
          pollIntervalMs: 1,
        }),
      (err: unknown) => err instanceof DetachedError && err.jobId === "job_abort",
    );
    assert.equal(n, 2);
  });
});

test("cmdReview interactive detaches when poll requests time out (#1286)", async () => {
  const f = await repoWithReviewDiff("mg-review-detach-timeout-");
  await runReviewInRepo(f, async () => {
    originalFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async () => {
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({ job_id: "job_detach_timeout", status: "queued" }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new CommandError(
        `${API_TIMEOUT_PREFIX} 30s. Check network connectivity and API status.`,
        1,
        "api_timeout",
      );
    };
    await assert.rejects(
      () =>
        cmdReview(["main", "--timeout", "30"], {
          interactive: true,
          pollIntervalMs: 1,
        }),
      (err: unknown) =>
        err instanceof DetachedError && err.jobId === "job_detach_timeout",
    );
    assert.equal(n, 5);
  });
});

async function captureReviewOutput(
  fn: () => Promise<void>,
): Promise<{ stdout: string[]; stderr: string[]; error: unknown }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  try {
    await fn();
    return { stdout, stderr, error: null };
  } catch (error) {
    return { stdout, stderr, error };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("cmdReview --json prints one terminal envelope and progress only on stderr (#1286)", async () => {
  const f = await repoWithReviewDiff("mg-review-json-");
  await runReviewInRepo(f, async () => {
    const mock = mockReviewFetch([
      { status: 202, body: { job_id: "job_json", status: "queued" } },
      { status: 200, body: { status: "in_progress" } },
      {
        status: 200,
        body: {
          status: "completed",
          verdict: "comment",
          summary: "done",
          findings: { inline: [], off_diff: [], specialists_run: ["tests"] },
        },
      },
    ]);
    const captured = await captureReviewOutput(() =>
      cmdReview(["main", "--json", "--timeout", "1"], { pollIntervalMs: 1 }),
    );
    assert.equal(captured.error, null);
    assert.equal(mock.calls(), 3);
    assert.equal(captured.stdout.length, 1);
    const envelope = JSON.parse(captured.stdout[0]!);
    assert.equal(envelope.schema, "mergestorm.review_job/v1");
    assert.equal(envelope.job_id, "job_json");
    assert.equal(envelope.status, "completed");
    assert.deepEqual(envelope.specialists_run, ["tests"]);
    assert.match(captured.stderr.join("\n"), /Collecting diff/);
  });
});

test("cmdReview polls immediately so short timeouts do not skip the first poll (#1286)", async () => {
  const f = await repoWithReviewDiff("mg-review-first-poll-");
  await runReviewInRepo(f, async () => {
    const mock = mockReviewFetch([
      { status: 202, body: { job_id: "job_first_poll", status: "queued" } },
      {
        status: 200,
        body: {
          status: "completed",
          verdict: "comment",
          summary: "fast",
          findings: { inline: [], off_diff: [], specialists_run: [] },
        },
      },
    ]);
    const captured = await captureReviewOutput(() =>
      cmdReview(["main", "--json", "--timeout", "1"], {}),
    );
    assert.equal(captured.error, null);
    assert.equal(mock.calls(), 2);
    const envelope = JSON.parse(captured.stdout[0]!);
    assert.equal(envelope.job_id, "job_first_poll");
    assert.equal(envelope.status, "completed");
  });
});

test("cmdReview --json --no-wait submits once and returns queued envelope (#1286)", async () => {
  const f = await repoWithReviewDiff("mg-review-no-wait-");
  await runReviewInRepo(f, async () => {
    const mock = mockReviewFetch([
      { status: 202, body: { job_id: "job_detached", status: "queued" } },
    ]);
    const captured = await captureReviewOutput(() =>
      cmdReview(["main", "--json", "--no-wait"]),
    );
    assert.equal(captured.error, null);
    assert.equal(mock.calls(), 1);
    assert.equal(captured.stdout.length, 1);
    const envelope = JSON.parse(captured.stdout[0]!);
    assert.equal(envelope.job_id, "job_detached");
    assert.equal(envelope.status, "queued");
  });
});

test("cmdReview JSON timeout preserves job id and exits 5 (#1286)", async () => {
  const f = await repoWithReviewDiff("mg-review-timeout-");
  await runReviewInRepo(f, async () => {
    mockReviewFetch([
      { status: 202, body: { job_id: "job_timeout", status: "queued" } },
      { status: 200, body: { status: "in_progress" } },
    ]);
    const captured = await captureReviewOutput(() =>
      cmdReview(["main", "--json", "--timeout", "0.02"], { pollIntervalMs: 1 }),
    );
    assert.ok(captured.error instanceof CommandError);
    assert.equal(captured.error.exitCode, 5);
    assert.equal(captured.stdout.length, 1);
    const envelope = JSON.parse(captured.stdout[0]!);
    assert.equal(envelope.job_id, "job_timeout");
    assert.equal(envelope.status, "in_progress");
    assert.match(envelope.error, /Timed out/);
  });
});

test("cmdReview JSON maps submit 429 to exit 7 with a rate_limited envelope", async () => {
  const f = await repoWithReviewDiff("mg-review-429-");
  await runReviewInRepo(f, async () => {
    mockReviewFetch([
      {
        status: 429,
        body: {
          error: "too_many_in_flight_jobs",
          message: "You already have 5 reviews queued or running.",
          retry_after_seconds: 30,
        },
        headers: { "Retry-After": "30" },
      },
    ]);
    const captured = await captureReviewOutput(() => cmdReview(["main", "--json"]));
    assert.ok(captured.error instanceof CommandError);
    assert.equal(captured.error.exitCode, REVIEW_EXIT.rate_limited);
    assert.equal(captured.error.code, "rate_limited");
    assert.equal(captured.stdout.length, 1);
    const envelope = JSON.parse(captured.stdout[0]!);
    assert.equal(envelope.status, "rate_limited");
    assert.equal(envelope.retry_after_seconds, 30);
    assert.match(envelope.error, /Wait for a running review or mergestorm jobs/);
    assert.match(envelope.error, /Retry after 30s/);
  });
});

test("cmdReview JSON maps poll-phase 429 exhaustion to exit 7 with a rate_limited envelope", async () => {
  const f = await repoWithReviewDiff("mg-review-poll-429-");
  await runReviewInRepo(f, async () => {
    mockReviewFetch([
      { status: 202, body: { job_id: "job_poll_429", status: "queued" } },
      { status: 429, body: { error: "rate_limited", retry_after_seconds: 0.01 }, headers: { "Retry-After": "0.01" } },
      { status: 429, body: { error: "rate_limited", retry_after_seconds: 0.01 }, headers: { "Retry-After": "0.01" } },
      { status: 429, body: { error: "rate_limited", retry_after_seconds: 0.01 }, headers: { "Retry-After": "0.01" } },
      { status: 429, body: { error: "rate_limited", retry_after_seconds: 0.01 }, headers: { "Retry-After": "0.01" } },
    ]);
    const captured = await captureReviewOutput(() =>
      cmdReview(["main", "--json", "--timeout", "5"], { pollIntervalMs: 1 }),
    );
    assert.ok(captured.error instanceof CommandError);
    assert.equal(captured.error.exitCode, REVIEW_EXIT.rate_limited);
    assert.equal(captured.error.code, "rate_limited");
    assert.equal(captured.error.retryAfterSeconds, 0.01);
    assert.equal(captured.stdout.length, 1);
    const envelope = JSON.parse(captured.stdout[0]!);
    assert.equal(envelope.status, "rate_limited");
    assert.equal(envelope.retry_after_seconds, 0.01);
  });
});

test("cmdReview JSON maps quota, failed job, and auth to distinct exits (#1286)", async () => {
  const cases = [
    {
      prefix: "quota",
      responses: [{ status: 402, body: { error: "limit" } }],
      exitCode: 3,
      status: "quota_exceeded",
    },
    {
      prefix: "failed",
      responses: [
        { status: 202, body: { job_id: "job_failed", status: "queued" } },
        { status: 200, body: { status: "failed", error: "provider died" } },
      ],
      exitCode: 4,
      status: "failed",
    },
    {
      prefix: "auth",
      responses: [{ status: 401, body: { error: "unauthorized" } }],
      exitCode: 6,
      status: "failed",
    },
  ];

  for (const item of cases) {
    const f = await repoWithReviewDiff(`mg-review-${item.prefix}-`);
    await runReviewInRepo(f, async () => {
      mockReviewFetch(item.responses);
      const captured = await captureReviewOutput(() =>
        cmdReview(["main", "--json", "--timeout", "1"], { pollIntervalMs: 1 }),
      );
      assert.ok(captured.error instanceof CommandError);
      assert.equal(captured.error.exitCode, item.exitCode);
      assert.equal(captured.stdout.length, 1);
      assert.equal(JSON.parse(captured.stdout[0]!).status, item.status);
    });
  }
});

test("cmdReview maps submit-time api_timeout to exit 5 without a false failed envelope (#1286)", async () => {
  const f = await repoWithReviewDiff("mg-review-submit-timeout-");
  await runReviewInRepo(f, async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new CommandError(
        `${API_TIMEOUT_PREFIX} 30s. Check network connectivity and API status.`,
        1,
        "api_timeout",
      );
    };
    const captured = await captureReviewOutput(() => cmdReview(["main", "--json"]));
    assert.ok(captured.error instanceof CommandError);
    assert.equal(captured.error.exitCode, 5);
    assert.equal(captured.stdout.length, 1);
    const envelope = JSON.parse(captured.stdout[0]!);
    assert.equal(envelope.job_id, null);
    assert.equal(envelope.status, "in_progress");
    assert.match(envelope.error, /Request timed out/);
  });
});

test("cmdReview maps submit-time network failure to a documented exit (#1286)", async () => {
  const f = await repoWithReviewDiff("mg-review-submit-net-");
  await runReviewInRepo(f, async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const captured = await captureReviewOutput(() => cmdReview(["main", "--json"]));
    assert.ok(captured.error instanceof CommandError);
    assert.equal(captured.error.exitCode, 5);
    assert.equal(captured.stdout.length, 1);
    assert.equal(JSON.parse(captured.stdout[0]!).status, "in_progress");
  });
});

test("cmdReview shell Ctrl+C during --json poll detaches without a false failed envelope (#1286)", async () => {
  const f = await repoWithReviewDiff("mg-review-json-abort-");
  await runReviewInRepo(f, async () => {
    originalFetch = globalThis.fetch;
    let n = 0;
    const ac = new AbortController();
    globalThis.fetch = async () => {
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({ job_id: "job_json_abort", status: "queued" }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      }
      ac.abort();
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    };
    const captured = await captureReviewOutput(() =>
      cmdReview(["main", "--json", "--timeout", "30"], {
        interactive: true,
        signal: ac.signal,
        pollIntervalMs: 1,
      }),
    );
    assert.ok(captured.error instanceof DetachedError);
    assert.equal(captured.error.jobId, "job_json_abort");
    assert.equal(captured.stdout.length, 0);
  });
});

test("cmdReview --json sends context, thread, and webhook fields and keeps the secret in the envelope", async () => {
  const f = await repoWithReviewDiff("mg-review-context-payload-");
  const adr = path.join(f.repo, "adr.md");
  await writeFile(adr, "prefer fail-closed\n");
  await runReviewInRepo(f, async () => {
    const mock = mockReviewFetch([
      {
        status: 202,
        body: {
          job_id: "job_ctx",
          status: "queued",
          webhook_secret: "once-only-secret",
        },
      },
    ]);
    const captured = await captureReviewOutput(() =>
      cmdReview([
        "main",
        "--json",
        "--no-wait",
        "--context",
        "focus on auth",
        "--context-file",
        "adr.md",
        "--thread",
        "local/feat-x",
        "--idempotency-key",
        "run-1",
        "--webhook-url",
        "https://hooks.example.test/review",
      ]),
    );
    assert.equal(captured.error, null);
    assert.equal(mock.calls(), 1);
    const payload = mock.posts()[0] as Record<string, unknown>;
    assert.equal(payload.thread, "local/feat-x");
    assert.equal(payload.context, "focus on auth");
    assert.deepEqual(payload.context_files, [
      { path: "adr.md", content: "prefer fail-closed\n" },
    ]);
    assert.equal(payload.idempotency_key, "run-1");
    assert.equal(payload.webhook_url, "https://hooks.example.test/review");
    const envelope = JSON.parse(captured.stdout[0]!);
    assert.equal(envelope.webhook_secret, "once-only-secret");
    assert.equal(envelope.thread.slug, "local/feat-x");
  });
});

test("cmdReview --json wait keeps the one-time webhook_secret from the 202 row in the terminal envelope", async () => {
  const f = await repoWithReviewDiff("mg-review-json-wait-secret-");
  await runReviewInRepo(f, async () => {
    mockReviewFetch([
      {
        status: 202,
        body: {
          job_id: "job_wait_secret",
          status: "queued",
          webhook_secret: "once-only-secret",
        },
      },
      { status: 200, body: { status: "in_progress" } },
      {
        status: 200,
        body: {
          status: "completed",
          verdict: "comment",
          summary: "done",
          findings: { inline: [], off_diff: [], specialists_run: [] },
        },
      },
    ]);
    const captured = await captureReviewOutput(() =>
      cmdReview([
        "main",
        "--json",
        "--timeout",
        "1",
        "--webhook-url",
        "https://hooks.example.test/review",
      ], { pollIntervalMs: 1 }),
    );
    assert.equal(captured.error, null);
    assert.equal(captured.stdout.length, 1);
    const envelope = JSON.parse(captured.stdout[0]!);
    assert.equal(envelope.job_id, "job_wait_secret");
    assert.equal(envelope.status, "completed");
    assert.equal(envelope.webhook_secret, "once-only-secret");
  });
});

test("cmdReview --json wait poll-failure keeps the one-time webhook_secret from the 202 row", async () => {
  const f = await repoWithReviewDiff("mg-review-json-wait-fail-secret-");
  await runReviewInRepo(f, async () => {
    mockReviewFetch([
      {
        status: 202,
        body: {
          job_id: "job_wait_fail_secret",
          status: "queued",
          webhook_secret: "once-only-secret",
        },
      },
      { status: 404, body: { error: "gone" } },
    ]);
    const captured = await captureReviewOutput(() =>
      cmdReview([
        "main",
        "--json",
        "--timeout",
        "1",
        "--webhook-url",
        "https://hooks.example.test/review",
      ], { pollIntervalMs: 1 }),
    );
    assert.ok(captured.error instanceof CommandError);
    assert.equal(captured.error.exitCode, 4);
    assert.equal(captured.stdout.length, 1);
    const envelope = JSON.parse(captured.stdout[0]!);
    assert.equal(envelope.job_id, "job_wait_fail_secret");
    assert.equal(envelope.status, "failed");
    assert.equal(envelope.webhook_secret, "once-only-secret");
  });
});

test("cmdReview pretty mode never prints webhook_secret", async () => {
  const f = await repoWithReviewDiff("mg-review-pretty-secret-");
  await runReviewInRepo(f, async () => {
    mockReviewFetch([
      {
        status: 202,
        body: {
          job_id: "job_pretty_secret",
          status: "queued",
          webhook_secret: "once-only-secret",
        },
      },
    ]);
    const captured = await captureReviewOutput(() =>
      cmdReview([
        "main",
        "--no-wait",
        "--webhook-url",
        "https://hooks.example.test/review",
      ]),
    );
    assert.equal(captured.error, null);
    const text = `${captured.stdout.join("\n")}\n${captured.stderr.join("\n")}`;
    assert.match(text, /job_pretty_secret/);
    assert.doesNotMatch(text, /once-only-secret/);
  });
});

test("cmdReview shell Ctrl+C during --json submit prints no false failed envelope (#1286)", async () => {
  const f = await repoWithReviewDiff("mg-review-json-abort-submit-");
  await runReviewInRepo(f, async () => {
    originalFetch = globalThis.fetch;
    const ac = new AbortController();
    globalThis.fetch = async () => {
      ac.abort();
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    };
    const captured = await captureReviewOutput(() =>
      cmdReview(["main", "--json"], { interactive: true, signal: ac.signal }),
    );
    assert.ok(captured.error instanceof Error);
    assert.equal(captured.error.name, "AbortError");
    assert.equal(captured.stdout.length, 0);
  });
});

const pollCfg: Config = {
  apiKey: "msk_live_test_key",
  apiBase: "https://api.example.test",
};

test("pollReview sleeps Retry-After before retrying a 429", async () => {
  const sleeps: number[] = [];
  mockReviewFetch([
    {
      status: 429,
      body: { error: "rate_limited", retry_after_seconds: 8 },
      headers: { "Retry-After": "8" },
    },
    { status: 200, body: { job_id: "job_rl", status: "completed", verdict: "approve" } },
  ]);
  const row = await pollReview(pollCfg, "job_rl", {
    timeoutMs: 30_000,
    intervalMs: 1,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });
  assert.equal(row.status, "completed");
  assert.equal(sleeps[0], 8_000);
});

test("pollReview does not instant-retry a transient 503", async () => {
  const sleeps: number[] = [];
  mockReviewFetch([
    { status: 503, body: { error: "busy" } },
    { status: 200, body: { job_id: "job_503", status: "completed", verdict: "approve" } },
  ]);
  await pollReview(pollCfg, "job_503", {
    timeoutMs: 30_000,
    intervalMs: 1,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });
  assert.ok(sleeps[0]! > 0);
});

test("pollReview maps 429 exhaustion to exit 7 rate_limited with retry_after_seconds", async () => {
  mockReviewFetch([
    {
      status: 429,
      body: { error: "rate_limited", retry_after_seconds: 12 },
      headers: { "Retry-After": "12" },
    },
    {
      status: 429,
      body: { error: "rate_limited", retry_after_seconds: 12 },
      headers: { "Retry-After": "12" },
    },
    {
      status: 429,
      body: { error: "rate_limited", retry_after_seconds: 12 },
      headers: { "Retry-After": "12" },
    },
    {
      status: 429,
      body: { error: "rate_limited", retry_after_seconds: 12 },
      headers: { "Retry-After": "12" },
    },
  ]);
  await assert.rejects(
    () =>
      pollReview(pollCfg, "job_rl_exhaust", {
        timeoutMs: 30_000,
        intervalMs: 1,
        sleep: async () => {},
        random: () => 0,
      }),
    (err: unknown) =>
      err instanceof CommandError &&
      err.exitCode === REVIEW_EXIT.rate_limited &&
      err.code === "rate_limited" &&
      err.retryAfterSeconds === 12,
  );
});

test("pollReview stretches the default interval toward 5s after 60s", async () => {
  const sleeps: number[] = [];
  let nowMs = 0;
  mockReviewFetch([
    { status: 200, body: { job_id: "job_stretch", status: "in_progress" } },
    { status: 200, body: { job_id: "job_stretch", status: "in_progress" } },
    { status: 200, body: { job_id: "job_stretch", status: "completed", verdict: "approve" } },
  ]);
  await pollReview(pollCfg, "job_stretch", {
    timeoutMs: 480_000,
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs = 120_000;
    },
    random: () => 0,
  });
  assert.equal(sleeps[0], 2_000);
  assert.equal(sleeps[1], 5_000);
});

test("formatReviewSubmitError explains nginx 413 instead of Failed: {}", () => {
  const nginx = formatReviewSubmitError(413, {});
  assert.match(nginx, /HTTP 413/);
  assert.match(nginx, /no credits were charged/i);
  assert.equal(MAX_REVIEW_DIFF_BYTES, 1_000_000);
  assert.match(nginx, /1 MB \/ 1_000_000 bytes/);
  assert.doesNotMatch(nginx, /Failed: \{\}/);
  assert.doesNotMatch(nginx, /2 MB once that location is deployed/);
  const app = formatReviewSubmitError(413, {
    error: "diff_too_large",
    message: "Max diff size is 1000000 bytes (1 MB)",
  });
  assert.match(app, /Max diff size is 1000000 bytes \(1 MB\)/);
  assert.match(app, /no credits were charged/i);
  assert.equal(
    formatReviewSubmitError(500, { error: "boom" }),
    "Failed (HTTP 500): boom",
  );
  assert.match(formatReviewSubmitError(502, {}), /did not return a JSON error body/);
});

test("cmdReview maps submit 413 HTML to a charged-nothing message", async () => {
  const f = await repoWithReviewDiff("mg-review-413-");
  await runReviewInRepo(f, async () => {
    mockReviewFetch([{ status: 413, body: "<html>413 Request Entity Too Large</html>" }]);
    const captured = await captureReviewOutput(() => cmdReview(["main", "--json"]));
    assert.ok(captured.error instanceof CommandError);
    assert.equal(captured.error.exitCode, REVIEW_EXIT.failed);
    assert.match(captured.error.message, /HTTP 413/);
    assert.match(captured.error.message, /1 MB \/ 1_000_000 bytes/);
    assert.doesNotMatch(captured.error.message, /Failed: \{\}/);
    const envelope = JSON.parse(captured.stdout[0]!);
    assert.equal(envelope.status, "failed");
  });
});


test("cmdReview interactive attributes credits to this job despite concurrent account spend (#1994)", async () => {
  const f = await repoWithReviewDiff("mg-review-job-credits-");
  await runReviewInRepo(f, async () => {
    originalFetch = globalThis.fetch;
    let remaining = 10;
    let meCalls = 0;
    globalThis.fetch = async (input, init) => {
      let body: unknown;
      let status = 200;
      if (String(input).endsWith("/api/v1/me")) {
        meCalls += 1;
        body = { usage: { standard: { used: 10 - remaining, limit: 10, remaining } } };
      } else if (init?.method === "POST") {
        body = { job_id: "job_credits", status: "queued" };
        status = 202;
      } else {
        // This review spends 2 credits while another job spends 3.
        remaining -= 5;
        body = {
          status: "completed",
          verdict: "comment",
          credits: { standard: 2 },
        };
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };
    const captured = await captureReviewOutput(() =>
      cmdReview(["main"], { interactive: true, pollIntervalMs: 1 }),
    );
    assert.equal(captured.error, null);
    assert.equal(meCalls, 1);
    assert.equal(remaining, 5);
    const output = captured.stdout.join("\n");
    assert.match(output, /2 credits used · 5 remaining/);
    assert.doesNotMatch(output, /5 credits used/);
  });
});

test("collectReviewInput keeps symlink cwd pathspecs inside the canonical repository", async () => {
  const { root, repo } = await repoWithTrunk("review-symlink-", "main");
  try {
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
    await writeFile(path.join(repo, "file[1].ts"), "export const changed = true;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "change"], { cwd: repo });
    const logicalCwd = path.join(root, "logical");
    await symlink(repo, logicalCwd, "dir");
    const physicalCwd = await realpath(logicalCwd);
    assert.notEqual(logicalCwd, physicalCwd);
    const physical = await collectReviewInput("main", "HEAD", physicalCwd, physicalCwd);
    const logical = await collectReviewInput("main", "HEAD", logicalCwd, physicalCwd);
    assert.ok(logical);
    assert.deepEqual(logical, physical);
    assert.match(logical.diff, /diff --git a\/file\[1\]\.ts b\/file\[1\]\.ts/);
    assert.deepEqual(logical.files.map((file) => file.path), ["file[1].ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("collection does not execute external diff or textconv helpers", async () => {
  const { root, repo } = await repoWithTrunk("review-read-only-", "main");
  try {
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "changed fixture\n");
    execFileSync("git", ["commit", "-qam", "change"], { cwd: repo });
    const marker = path.join(repo, "helper-ran");
    const helper = path.join(repo, "helper.sh");
    await writeFile(helper, "#!/bin/sh\ntouch helper-ran\nprintf 'helper output\\n'\n", { mode: 0o755 });
    const configure = (key: string, value: string) =>
      execFileSync("git", ["config", key, value], { cwd: repo });
    for (const kind of ["external", "driver", "textconv"]) {
      if (kind === "external") configure("diff.external", helper);
      else {
        if (kind === "driver") {
          execFileSync("git", ["config", "--unset", "diff.external"], { cwd: repo });
          await writeFile(path.join(repo, ".gitattributes"), "README.md diff=fixture\n");
          configure("diff.fixture.command", helper);
        } else {
          execFileSync("git", ["config", "--unset", "diff.fixture.command"], { cwd: repo });
          configure("diff.fixture.textconv", helper);
        }
      }
      const input = await collectReviewInput("main", "HEAD", repo);
      assert.ok(input);
      assert.match(input.diff, /[+]changed fixture/);
      assert.deepEqual(input.files, [{ path: "README.md", content: "changed fixture\n" }]);
      await assert.rejects(access(marker), { code: "ENOENT" });
      // Prove the configured helper would run without the collection flags.
      execFileSync("git", ["diff", "main...HEAD"], { cwd: repo });
      await access(marker);
      await rm(marker);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadReviewContext bounds CLI paths to the canonical repo and preserves MCP bounds", async () => {
  const { root, repo } = await repoWithTrunk("review-context-bounds-", "main");
  try {
    const nested = path.join(repo, "nested");
    await mkdir(nested);
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside\n");
    await symlink(outside, path.join(repo, "escape.md"));
    const logical = path.join(root, "logical");
    await symlink(repo, logical, "dir");
    for (const cwd of [repo, logical]) {
      for (const contextPath of [outside, "../outside.md", "escape.md"]) {
        await assert.rejects(
          loadReviewContext({ cwd, contextFiles: [contextPath] }),
          /must be inside the repo root/,
        );
      }
      await assert.rejects(
        loadReviewContext({ cwd, contextFiles: ["missing.md"] }),
        /could not read --context-file missing\.md: ENOENT/,
      );
      const loaded = await loadReviewContext({
        cwd: path.join(cwd, "nested"), contextFiles: ["../README.md"],
      });
      assert.equal(loaded.contextFiles?.[0]?.content, "fixture\n");
    }
    await assert.rejects(
      loadReviewContext({ cwd: nested, sandboxCwd: nested, contextFiles: ["../README.md"] }),
      /must be inside the working directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
