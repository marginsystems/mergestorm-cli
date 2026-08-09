import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { apiFetch, getMe } from "./api.js";
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
