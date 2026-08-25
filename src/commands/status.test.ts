import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { CommandError, DetachedError, REVIEW_EXIT } from "../errors.js";
import {
  REVIEW_JOB_ENVELOPE_SCHEMA,
  toReviewJobEnvelope,
  type ReviewJobRow,
} from "../ui/job-envelope.js";
import { cmdStatus, parseStatusArgs } from "./status.js";

const cfgKey = "msk_live_test_status_key";
const completedRow: ReviewJobRow = {
  job_id: "job_done",
  status: "completed",
  verdict: "request_changes",
  summary: "nits",
  thread_slug: "local/feat",
  thread_job_number: 2,
  router_mode: "standard",
  specialists_requested: ["security"],
  specialists_run: ["security", "tests"],
  credits: { standard: 1 },
  findings: { inline: [], off_diff: [], specialists_run: ["security", "tests"] },
};

let originalFetch: typeof globalThis.fetch | undefined;
let originalApiKey: string | undefined;

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
  if (originalApiKey === undefined) delete process.env.MERGESTORM_API_KEY;
  else process.env.MERGESTORM_API_KEY = originalApiKey;
  originalApiKey = undefined;
});

function mockStatusFetch(
  responses: { status: number; body: unknown; headers?: Record<string, string> }[],
): { calls: () => number } {
  originalFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    const r = responses[Math.min(n, responses.length - 1)]!;
    n += 1;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json", ...r.headers },
    });
  };
  return { calls: () => n };
}

function withApiKey(): void {
  originalApiKey = process.env.MERGESTORM_API_KEY;
  process.env.MERGESTORM_API_KEY = cfgKey;
  process.env.MERGESTORM_API_URL = "https://api.example.test";
}

async function captureStatusOutput(
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

describe("status", { concurrency: false }, () => {
test("parseStatusArgs reads json, wait, and timeout", () => {
  assert.deepEqual(parseStatusArgs(["job_1"]), {
    jobId: "job_1",
    format: "json",
    wait: false,
    timeoutMs: 480_000,
  });
  assert.deepEqual(parseStatusArgs(["job_1", "--json", "--wait", "--timeout", "12.5"]), {
    jobId: "job_1",
    format: "json",
    wait: true,
    timeoutMs: 12_500,
  });
  assert.equal(parseStatusArgs(["--pretty", "job_1"], { format: "json" }).format, "pretty");
  assert.equal(parseStatusArgs(["job_1", "--timeout", "3"]).wait, true);
  assert.throws(() => parseStatusArgs([]), /usage: mergestorm status/);
  assert.throws(() => parseStatusArgs(["job_1", "--timeout", "0"]), /positive number/);
  assert.throws(
    () => parseStatusArgs(["job_1", "--turbo"]),
    (err: unknown) => err instanceof CommandError && err.exitCode === 2,
  );
});

test("cmdStatus --json prints the same envelope as review --json", async () => {
  withApiKey();
  mockStatusFetch([{ status: 200, body: completedRow }]);
  const captured = await captureStatusOutput(() =>
    cmdStatus(["job_done", "--json"]),
  );
  assert.equal(captured.error, null);
  assert.equal(captured.stdout.length, 1);
  const envelope = JSON.parse(captured.stdout[0]!);
  assert.deepEqual(envelope, toReviewJobEnvelope(completedRow));
  assert.equal(envelope.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
  assert.deepEqual(envelope.thread, { slug: "local/feat", job_number: 2 });
});

test("cmdStatus pretty prints requested vs run specialists and credits", async () => {
  withApiKey();
  mockStatusFetch([{ status: 200, body: completedRow }]);
  const captured = await captureStatusOutput(() =>
    cmdStatus(["job_done", "--pretty"]),
  );
  assert.equal(captured.error, null);
  const text = captured.stdout.join("\n");
  assert.match(text, /Status:\s+completed/);
  assert.match(text, /Requested:\s+security/);
  assert.match(text, /Run:\s+security, tests/);
  assert.match(text, /Credits:\s+1 standard/);
  assert.doesNotMatch(text, /mergestorm\.review_job\/v1/);
});

test("cmdStatus --json --wait polls queued then completed", async () => {
  withApiKey();
  const mock = mockStatusFetch([
    { status: 200, body: { job_id: "job_wait", status: "queued" } },
    { status: 200, body: { job_id: "job_wait", status: "in_progress" } },
    {
      status: 200,
      body: {
        job_id: "job_wait",
        status: "completed",
        verdict: "approve",
        summary: "ok",
      },
    },
  ]);
  const captured = await captureStatusOutput(() =>
    cmdStatus(["job_wait", "--json", "--wait", "--timeout", "2"], {
      pollIntervalMs: 1,
    }),
  );
  assert.equal(captured.error, null);
  assert.equal(mock.calls(), 3);
  assert.equal(captured.stdout.length, 1);
  const envelope = JSON.parse(captured.stdout[0]!);
  assert.equal(envelope.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
  assert.equal(envelope.job_id, "job_wait");
  assert.equal(envelope.status, "completed");
  assert.equal(envelope.verdict, "approve");
  assert.ok(captured.stderr.some((line) => line.includes(".")));
});

test("cmdStatus --json --wait timeout keeps job_id and exits 5", async () => {
  withApiKey();
  mockStatusFetch([
    { status: 200, body: { job_id: "job_slow", status: "in_progress" } },
  ]);
  const captured = await captureStatusOutput(() =>
    cmdStatus(["job_slow", "--json", "--wait", "--timeout", "0.05"], {
      pollIntervalMs: 1,
    }),
  );
  assert.ok(captured.error instanceof CommandError);
  assert.equal(captured.error.exitCode, REVIEW_EXIT.timeout);
  assert.equal(captured.error.code, "review_timeout");
  const envelope = JSON.parse(captured.stdout[0]!);
  assert.equal(envelope.job_id, "job_slow");
  assert.equal(envelope.status, "in_progress");
  assert.match(envelope.error, /Timed out/);
});

test("cmdStatus --json --wait maps a failed job to exit 4", async () => {
  withApiKey();
  mockStatusFetch([
    { status: 200, body: { job_id: "job_dead", status: "failed", error: "provider died" } },
  ]);
  const captured = await captureStatusOutput(() =>
    cmdStatus(["job_dead", "--json", "--wait", "--timeout", "2"], {
      pollIntervalMs: 1,
    }),
  );
  assert.ok(captured.error instanceof CommandError);
  assert.equal(captured.error.exitCode, REVIEW_EXIT.failed);
  const envelope = JSON.parse(captured.stdout[0]!);
  assert.equal(envelope.status, "failed");
  assert.equal(envelope.error, "provider died");
});

test("cmdStatus --json maps a failed job to exit 4 without --wait", async () => {
  withApiKey();
  mockStatusFetch([
    { status: 200, body: { job_id: "job_dead", status: "failed", error: "provider died" } },
  ]);
  const captured = await captureStatusOutput(() => cmdStatus(["job_dead", "--json"]));
  assert.ok(captured.error instanceof CommandError);
  assert.equal(captured.error.exitCode, REVIEW_EXIT.failed);
  const envelope = JSON.parse(captured.stdout[0]!);
  assert.equal(envelope.status, "failed");
  assert.equal(envelope.error, "provider died");
});

test("cmdStatus --json maps a quota job to exit 3 without --wait", async () => {
  withApiKey();
  mockStatusFetch([
    { status: 200, body: { job_id: "job_q", status: "quota_exceeded", error: "limit hit" } },
  ]);
  const captured = await captureStatusOutput(() => cmdStatus(["job_q", "--json"]));
  assert.ok(captured.error instanceof CommandError);
  assert.equal(captured.error.exitCode, REVIEW_EXIT.quota);
  const envelope = JSON.parse(captured.stdout[0]!);
  assert.equal(envelope.status, "quota_exceeded");
});

test("cmdStatus --json maps a missing job (404) to exit 4 like --wait", async () => {
  withApiKey();
  mockStatusFetch([{ status: 404, body: { error: "not_found" } }]);
  const captured = await captureStatusOutput(() =>
    cmdStatus(["job_gone", "--json"]),
  );
  assert.ok(captured.error instanceof CommandError);
  assert.equal(captured.error.exitCode, REVIEW_EXIT.failed);
  assert.equal(captured.error.code, "review_failed");
  const envelope = JSON.parse(captured.stdout[0]!);
  assert.equal(envelope.status, "failed");
  assert.match(envelope.error, /Review not found: job_gone/);
});

test("cmdStatus --json maps a non-200 API error to exit 4 like --wait", async () => {
  withApiKey();
  mockStatusFetch([{ status: 500, body: { error: "boom" } }]);
  const captured = await captureStatusOutput(() => cmdStatus(["job_x", "--json"]));
  assert.ok(captured.error instanceof CommandError);
  assert.equal(captured.error.exitCode, REVIEW_EXIT.failed);
  const envelope = JSON.parse(captured.stdout[0]!);
  assert.equal(envelope.status, "failed");
  assert.match(envelope.error, /HTTP 500/);
});

test("cmdStatus --json maps a hung API (api_timeout) to exit 5 without --wait", async () => {
  withApiKey();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
  };
  const captured = await captureStatusOutput(() => cmdStatus(["job_hung", "--json"]));
  assert.ok(captured.error instanceof CommandError);
  assert.equal(captured.error.exitCode, REVIEW_EXIT.timeout);
  assert.equal(captured.error.code, "review_timeout");
  const envelope = JSON.parse(captured.stdout[0]!);
  assert.equal(envelope.job_id, "job_hung");
  assert.equal(envelope.status, "in_progress");
  assert.match(envelope.error, /Request timed out/);
});

test("cmdStatus --json maps HTTP 429 to exit 7 with retry_after_seconds", async () => {
  withApiKey();
  mockStatusFetch([
    {
      status: 429,
      body: { error: "rate_limited", retry_after_seconds: 12 },
      headers: { "Retry-After": "12" },
    },
  ]);
  const captured = await captureStatusOutput(() => cmdStatus(["job_x", "--json"]));
  assert.ok(captured.error instanceof CommandError);
  assert.equal(captured.error.exitCode, REVIEW_EXIT.rate_limited);
  assert.equal(captured.error.code, "rate_limited");
  const envelope = JSON.parse(captured.stdout[0]!);
  assert.equal(envelope.status, "rate_limited");
  assert.equal(envelope.retry_after_seconds, 12);
  assert.match(envelope.error, /Wait for a running review or mergestorm jobs/);
});

test("cmdStatus --json --wait maps poll-phase 429 exhaustion to exit 7 rate_limited", async () => {
  withApiKey();
  mockStatusFetch([
    { status: 429, body: { error: "rate_limited", retry_after_seconds: 0.01 }, headers: { "Retry-After": "0.01" } },
    { status: 429, body: { error: "rate_limited", retry_after_seconds: 0.01 }, headers: { "Retry-After": "0.01" } },
    { status: 429, body: { error: "rate_limited", retry_after_seconds: 0.01 }, headers: { "Retry-After": "0.01" } },
    { status: 429, body: { error: "rate_limited", retry_after_seconds: 0.01 }, headers: { "Retry-After": "0.01" } },
  ]);
  const captured = await captureStatusOutput(() =>
    cmdStatus(["job_x", "--json", "--wait", "--timeout", "10"], { pollIntervalMs: 1 }),
  );
  assert.ok(captured.error instanceof CommandError);
  assert.equal(captured.error.exitCode, REVIEW_EXIT.rate_limited);
  assert.equal(captured.error.code, "rate_limited");
  assert.equal(captured.error.retryAfterSeconds, 0.01);
  const envelope = JSON.parse(captured.stdout[0]!);
  assert.equal(envelope.status, "rate_limited");
  assert.equal(envelope.retry_after_seconds, 0.01);
});

test("cmdStatus --json maps 401 to exit 6", async () => {
  withApiKey();
  mockStatusFetch([{ status: 401, body: { error: "unauthorized" } }]);
  const captured = await captureStatusOutput(() => cmdStatus(["job_x", "--json"]));
  assert.ok(captured.error instanceof CommandError);
  assert.equal(captured.error.exitCode, REVIEW_EXIT.auth);
  const envelope = JSON.parse(captured.stdout[0]!);
  assert.equal(envelope.status, "failed");
});

test("cmdStatus one-shot aborts the fetch on signal (Ctrl+C)", async () => {
  withApiKey();
  const ac = new AbortController();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const signal = init?.signal;
    return new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
        { once: true },
      );
    });
  };
  const pending = cmdStatus(["job_sig", "--json"], { signal: ac.signal });
  ac.abort();
  await assert.rejects(
    () => pending,
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
});

test("cmdStatus interactive --wait detaches on Ctrl+C", async () => {
  withApiKey();
  const ac = new AbortController();
  originalFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) {
      return new Response(JSON.stringify({ job_id: "job_ab", status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    ac.abort();
    throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  };
  await assert.rejects(
    () =>
      cmdStatus(["job_ab", "--wait", "--timeout", "30"], {
        defaultFormat: "pretty",
        interactive: true,
        signal: ac.signal,
        pollIntervalMs: 1,
      }),
    (err: unknown) => err instanceof DetachedError && err.jobId === "job_ab",
  );
});
});
