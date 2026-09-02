import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { CommandError, REVIEW_EXIT } from "../errors.js";
import { cmdPr, parsePrArgs } from "./pr.js";

type MockResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

let originalFetch: typeof globalThis.fetch | undefined;
let originalApiKey: string | undefined;
let originalApiUrl: string | undefined;

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = undefined;
  if (originalApiKey === undefined) delete process.env.MERGESTORM_API_KEY;
  else process.env.MERGESTORM_API_KEY = originalApiKey;
  if (originalApiUrl === undefined) delete process.env.MERGESTORM_API_URL;
  else process.env.MERGESTORM_API_URL = originalApiUrl;
  originalApiKey = undefined;
  originalApiUrl = undefined;
});

function withApiKey(): void {
  originalApiKey = process.env.MERGESTORM_API_KEY;
  originalApiUrl = process.env.MERGESTORM_API_URL;
  process.env.MERGESTORM_API_KEY = "msk_live_pr_test";
  process.env.MERGESTORM_API_URL = "https://api.example.test";
}

function review(status: string, headSha = "abc123def456", extra: object = {}): object {
  return {
    schema: "mergestorm.pr_review/v1",
    id: "review-1",
    owner: "acme",
    repo: "widgets",
    pr_number: 12,
    status,
    raw_status: status,
    phase: null,
    verdict: "approve",
    head_sha: headSha,
    review_count: 1,
    skip_reason: null,
    reviewed_at: "2026-09-01T00:00:00Z",
    finding_count: 0,
    findings: { inline: [], offDiff: [] },
    patch_policy: null,
    ...extra,
  };
}

function mockPrFetch(responses: MockResponse[]): {
  calls: () => string[];
} {
  originalFetch = globalThis.fetch;
  const urls: string[] = [];
  let index = 0;
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json", ...response.headers },
    });
  };
  return { calls: () => urls };
}

async function captureOutput(
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

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

describe("pr", { concurrency: false }, () => {
  test("parses both target forms and rejects invalid PR numbers", () => {
    assert.deepEqual(parsePrArgs(["acme/widgets#12"]), {
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
      format: "json",
      wait: false,
      afterSha: undefined,
      timeoutMs: 480_000,
    });
    assert.equal(parsePrArgs(["acme/widgets", "12"]).prNumber, 12);
    assert.throws(() => parsePrArgs(["acme/widgets#0"]), /usage: mergestorm pr/);
    assert.throws(() => parsePrArgs(["acme/widgets"]), /usage: mergestorm pr/);
    assert.throws(() => parsePrArgs(["junk", "12"]), /usage: mergestorm pr/);
  });

  test("one-shot JSON uses only the PR review endpoint", async () => {
    withApiKey();
    const mock = mockPrFetch([{ status: 200, body: review("completed") }]);
    const captured = await captureOutput(() => cmdPr(["acme/widgets#12", "--json"]));
    assert.equal(captured.error, null);
    const envelope = JSON.parse(captured.stdout[0]!);
    assert.equal(envelope.schema, "mergestorm.pr_review/v1");
    assert.equal(mock.calls().length, 1);
    assert.equal(
      mock.calls()[0],
      "https://api.example.test/api/v1/stacks/pr-review?owner=acme&repo=widgets&pr_number=12",
    );
    assert.equal(mock.calls()[0]!.includes("/stacks/enrich"), false);
    assert.equal(mock.calls()[0]!.includes("/api/v1/reviews"), false);
  });

  test("pretty output renders inline finding bodies", async () => {
    withApiKey();
    mockPrFetch([
      {
        status: 200,
        body: review("completed", "abc123", {
          verdict: "request_changes",
          finding_count: 1,
          skip_reason: "nothing_new",
          findings: {
            inline: [
              {
                path: "src/a.ts",
                line: 4,
                severity: "high",
                body: "Guard this input.",
              },
            ],
            offDiff: [],
          },
        }),
      },
    ]);
    const captured = await captureOutput(() =>
      cmdPr(["acme/widgets#12", "--pretty"]),
    );
    assert.equal(captured.error, null);
    const text = captured.stdout.join("\n");
    assert.match(text, /Status:\s+completed/);
    assert.match(text, /Head:\s+abc123/);
    assert.match(text, /Finding count:\s+1/);
    assert.match(text, /Skip reason:\s+nothing_new/);
    assert.match(text, /Guard this input\./);
  });

  test("wait stops when an in-progress pass completes", async () => {
    withApiKey();
    const mock = mockPrFetch([
      { status: 200, body: review("in_progress") },
      { status: 200, body: review("completed") },
    ]);
    const clock = fakeClock();
    const captured = await captureOutput(() =>
      cmdPr(["acme/widgets#12", "--json", "--wait"], { poll: clock }),
    );
    assert.equal(captured.error, null);
    assert.equal(mock.calls().length, 2);
    assert.equal(JSON.parse(captured.stdout[0]!).status, "completed");
  });

  test("wait after-sha ignores a resting previous pass", async () => {
    withApiKey();
    const mock = mockPrFetch([
      { status: 200, body: review("completed", "oldold0") },
      { status: 200, body: review("completed", "abc123def456") },
    ]);
    const clock = fakeClock();
    const captured = await captureOutput(() =>
      cmdPr(
        ["acme/widgets#12", "--json", "--wait", "--after-sha", "ABC123DEF"],
        { poll: clock },
      ),
    );
    assert.equal(captured.error, null);
    assert.equal(mock.calls().length, 2);
    assert.equal(
      new URL(mock.calls()[1]!).searchParams.get("after_sha"),
      "ABC123DEF",
    );
    assert.equal(JSON.parse(captured.stdout[0]!).head_sha, "abc123def456");
  });

  test("wait continues while the raw review status is in progress", async () => {
    withApiKey();
    const mock = mockPrFetch([
      {
        status: 200,
        body: review("failed", "abc123def456", { raw_status: "in_progress" }),
      },
      { status: 200, body: review("completed") },
    ]);
    const clock = fakeClock();
    const captured = await captureOutput(() =>
      cmdPr(["acme/widgets#12", "--json", "--wait"], { poll: clock }),
    );
    assert.equal(captured.error, null);
    assert.equal(mock.calls().length, 2);
    assert.equal(JSON.parse(captured.stdout[0]!).status, "completed");
  });

  test("wait treats 404 as a pass not persisted yet", async () => {
    withApiKey();
    const mock = mockPrFetch([
      { status: 404, body: { error: "not_found" } },
      { status: 200, body: review("completed") },
    ]);
    const clock = fakeClock();
    const captured = await captureOutput(() =>
      cmdPr(["acme/widgets#12", "--json", "--wait"], { poll: clock }),
    );
    assert.equal(captured.error, null);
    assert.equal(mock.calls().length, 2);
  });

  test("wait timeout exits with REVIEW_EXIT.timeout", async () => {
    withApiKey();
    mockPrFetch([{ status: 200, body: review("in_progress") }]);
    const clock = fakeClock();
    const captured = await captureOutput(() =>
      cmdPr(["acme/widgets#12", "--json", "--wait", "--timeout", "0.01"], {
        poll: clock,
      }),
    );
    assert.ok(captured.error instanceof CommandError);
    assert.equal(captured.error.exitCode, REVIEW_EXIT.timeout);
    assert.equal(captured.error.code, "review_timeout");
  });

  test("wait maps exhausted 429 retries to rate_limited", async () => {
    withApiKey();
    mockPrFetch([
      { status: 429, body: { error: "rate_limited" } },
      { status: 429, body: { error: "rate_limited" } },
      { status: 429, body: { error: "rate_limited" } },
      {
        status: 429,
        body: { error: "rate_limited", retry_after_seconds: 2 },
        headers: { "Retry-After": "2" },
      },
    ]);
    const clock = fakeClock();
    const captured = await captureOutput(() =>
      cmdPr(["acme/widgets#12", "--json", "--wait", "--timeout", "30"], {
        poll: { ...clock, random: () => 0 },
      }),
    );
    assert.ok(captured.error instanceof CommandError);
    assert.equal(captured.error.exitCode, REVIEW_EXIT.rate_limited);
    assert.equal(captured.error.code, "rate_limited");
    assert.equal(captured.error.retryAfterSeconds, 2);
  });

  test("after-sha without wait is usage", () => {
    assert.throws(
      () => parsePrArgs(["acme/widgets#12", "--after-sha", "abc1234"]),
      (err: unknown) =>
        err instanceof CommandError && err.exitCode === REVIEW_EXIT.usage,
    );
  });

  test("after-sha requires a sufficiently specific prefix", () => {
    assert.throws(
      () => parsePrArgs(["acme/widgets#12", "--wait", "--after-sha", "abc123"]),
      /at least 7 characters/,
    );
  });

  test("after-sha requires hexadecimal characters", () => {
    assert.throws(
      () => parsePrArgs(["acme/widgets#12", "--wait", "--after-sha", "abcdefg"]),
      /only hexadecimal characters/,
    );
  });

  test("wait after-sha times out when only a different resting pass exists", async () => {
    withApiKey();
    mockPrFetch([{ status: 200, body: review("completed", "def456789abcdef") }]);
    const clock = fakeClock();
    const captured = await captureOutput(() =>
      cmdPr(
        ["acme/widgets#12", "--json", "--wait", "--after-sha", "abc1234", "--timeout", "0.01"],
        { poll: clock },
      ),
    );
    assert.ok(captured.error instanceof CommandError);
    assert.equal(captured.error.exitCode, REVIEW_EXIT.timeout);
    assert.equal(captured.error.code, "review_timeout");
  });
});
