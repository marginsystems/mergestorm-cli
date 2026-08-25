import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { apiFetch, getMe, getReview, parseRetryAfterSeconds } from "./api.js";
import type { Config } from "./config.js";
import { CommandError } from "./errors.js";

const cfg: Config = {
  apiKey: "msk_live_test_revoked_key",
  apiBase: "https://api.example.test",
};

let originalFetch: typeof globalThis.fetch | undefined;

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
});

function mockFetch(status: number, body: unknown = { error: "unauthorized" }): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

/** Hang until the request AbortSignal fires (simulates a stuck API). */
function mockHangingFetch(): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("No signal"));
        return;
      }
      const onAbort = () => {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted", "AbortError"),
        );
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
}

test("apiFetch throws friendly CommandError on HTTP 401", async () => {
  mockFetch(401);
  await assert.rejects(
    () => apiFetch(cfg, "/api/v1/me"),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "auth_invalid" &&
      err.message === "API key invalid or revoked. Run `mergestorm login`.",
  );
});

test("getMe rethrows 401 CommandError instead of returning null", async () => {
  mockFetch(401);
  await assert.rejects(
    () => getMe(cfg),
    (err: unknown) => err instanceof CommandError && err.code === "auth_invalid",
  );
});

test("getMe still returns null on non-auth failures", async () => {
  mockFetch(503, { error: "busy" });
  assert.equal(await getMe(cfg), null);
});

test("apiFetch still returns status body for non-401 errors", async () => {
  mockFetch(500, { error: "boom" });
  const res = await apiFetch(cfg, "/api/v1/me");
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "boom" });
});

test("apiFetch throws CommandError when the request hangs past timeoutMs", async () => {
  mockHangingFetch();
  await assert.rejects(
    () => apiFetch(cfg, "/api/v1/me", { timeoutMs: 25 }),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "api_timeout" &&
      /timed out after \d+s/.test(err.message),
  );
});

test("apiFetch preserves caller AbortError for Ctrl+C detach", async () => {
  mockHangingFetch();
  const ac = new AbortController();
  const pending = apiFetch(cfg, "/api/v1/me", {
    signal: ac.signal,
    timeoutMs: 60_000,
  });
  ac.abort();
  await assert.rejects(
    () => pending,
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
});

test("getMe returns null on request timeout (banner soft-fail)", async () => {
  mockHangingFetch();
  assert.equal(await getMe(cfg, { timeoutMs: 25 }), null);
});

test("getReview returns the job body on HTTP 200", async () => {
  mockFetch(200, { job_id: "job_1", status: "completed" });
  assert.deepEqual(await getReview("job_1", cfg), {
    job_id: "job_1",
    status: "completed",
  });
});

test("parseRetryAfterSeconds prefers the larger of header and body", () => {
  assert.equal(
    parseRetryAfterSeconds({
      header: "8",
      body: { retry_after_seconds: 30 },
    }),
    30,
  );
  assert.equal(parseRetryAfterSeconds({ header: "12", body: { error: "busy" } }), 12);
  assert.equal(parseRetryAfterSeconds({ body: { retry_after_seconds: 4.2 } }), 4.2);
  assert.equal(parseRetryAfterSeconds({ header: "nope", body: {} }), undefined);
});

test("apiFetch exposes Retry-After and retry_after_seconds", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "rate_limited", retry_after_seconds: 15 }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "15" },
    });
  const res = await apiFetch(cfg, "/api/v1/reviews");
  assert.equal(res.status, 429);
  assert.equal(res.retryAfterSeconds, 15);
});

test("getReview throws rate_limited on HTTP 429", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "rate_limited", retry_after_seconds: 9 }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "9" },
    });
  await assert.rejects(
    () => getReview("job_1", cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "rate_limited" &&
      err.exitCode === 7 &&
      err.retryAfterSeconds === 9,
  );
});

test("getReview throws on HTTP 404", async () => {
  mockFetch(404, { error: "not_found" });
  await assert.rejects(
    () => getReview("missing", cfg),
    (err: unknown) =>
      err instanceof CommandError && err.message === "Review not found: missing",
  );
});
