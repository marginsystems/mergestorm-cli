import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cmdCredits } from "./credits.js";

let originalFetch: typeof globalThis.fetch | undefined;
let originalApiKey: string | undefined;
let originalColumns: number | undefined;

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
  if (originalApiKey === undefined) delete process.env.MERGESTORM_API_KEY;
  else process.env.MERGESTORM_API_KEY = originalApiKey;
  originalApiKey = undefined;
  if (originalColumns === undefined) delete (process.stdout as { columns?: number }).columns;
  else Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
});

function withApiKey(): void {
  originalApiKey = process.env.MERGESTORM_API_KEY;
  process.env.MERGESTORM_API_KEY = "msk_live_test_credits_key";
  process.env.MERGESTORM_API_URL = "https://api.example.test";
}

function setColumns(columns: number): void {
  originalColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
}

function mockCreditsFetch(): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/v1/me")) {
      return new Response(
        JSON.stringify({
          key: { prefix: "msk_live_abcd", name: "laptop", created_at: "2026-08-01T00:00:00Z", last_used_at: null },
          plan_key: "free",
          resets_at: "2026-09-01T00:00:00.000Z",
          usage: {
            standard: { used: 7, limit: 100, remaining: 93 },
            bonus: { remaining: 12 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        items: [
          {
            job_id: "job_recent_1",
            thread_slug: "local/feat/auth",
            status: "completed",
            verdict: "request_changes",
            created_at: "2026-08-24T10:00:00.000Z",
            credits: { standard: 1 },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

async function capture(fn: () => Promise<void>): Promise<string> {
  const stdout: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  try {
    await fn();
    return stdout.join("\n");
  } finally {
    console.log = originalLog;
  }
}

test("credits --json keeps usage and adds recent_jobs", async () => {
  withApiKey();
  mockCreditsFetch();
  const out = await capture(() => cmdCredits(["--json"]));
  const body = JSON.parse(out) as {
    usage: { standard: { used: number }; bonus: { remaining: number } };
    resets_at: string;
    recent_jobs: { job_id: string }[];
  };
  assert.equal(body.usage.standard.used, 7);
  assert.equal(body.usage.bonus.remaining, 12);
  assert.equal(body.resets_at, "2026-09-01T00:00:00.000Z");
  assert.equal(body.recent_jobs[0]?.job_id, "job_recent_1");
});

test("credits pretty panel includes key, plan, and last jobs", async () => {
  withApiKey();
  mockCreditsFetch();
  setColumns(60);
  const out = await capture(() => cmdCredits([]));
  assert.match(out, /msk_live_abcd · free/);
  assert.match(out, /7% used/);
  assert.match(out, /Bonus credits: 12 remaining/);
  assert.match(out, /job_rece/);
  assert.match(out, /request_changes/);
});
