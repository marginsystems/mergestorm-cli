import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { API_TIMEOUT_PREFIX } from "../api.js";
import { CommandError } from "../errors.js";
import {
  cmdReview,
  isTransientReviewPollError,
  isTransientReviewPollStatus,
  resolveReviewBase,
  withReviewJobRecovery,
} from "./review.js";

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
  responses: { status: number; body: unknown }[],
): { calls: () => number } {
  originalFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    const r = responses[Math.min(n, responses.length - 1)];
    n += 1;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls: () => n };
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
        err instanceof CommandError && /mergestorm status job_loop_500/.test(err.message),
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
