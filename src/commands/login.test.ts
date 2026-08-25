import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Config } from "../config.js";
import { CommandError } from "../errors.js";
import { cmdLogin, validateApiKey } from "./login.js";

const cfg: Config = {
  apiKey: "msk_live_candidate_key",
  apiBase: "https://api.example.test",
};

let originalFetch: typeof globalThis.fetch;

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

function mockFetch(status: number, body: unknown): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

test("validateApiKey accepts a working key", async () => {
  mockFetch(200, {
    key: { prefix: "msk_live_abcd", name: "cli", created_at: "", last_used_at: null },
    plan_key: "pro",
    usage: {
      standard: { used: 0, limit: 100, remaining: 100 },
    },
  });
  const me = await validateApiKey(cfg);
  assert.equal(me.key.prefix, "msk_live_abcd");
});

test("validateApiKey rejects 401 without implying config was written", async () => {
  mockFetch(401, { error: "unauthorized" });
  await assert.rejects(
    () => validateApiKey(cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "auth_invalid" &&
      /not saved/i.test(err.message),
  );
});

test("validateApiKey rejects unreachable / non-200 without saving", async () => {
  mockFetch(503, { error: "busy" });
  await assert.rejects(
    () => validateApiKey(cfg),
    (err: unknown) =>
      err instanceof CommandError && /not saved/i.test(err.message),
  );
});

test("cmdLogin backs off and retries when device start is rate limited", async () => {
  const startPaths: string[] = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v1/cli/device")) {
      startPaths.push(url);
      if (startPaths.length === 1) {
        return new Response(
          JSON.stringify({ error: "rate_limited", retry_after_seconds: 0.01 }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          device_code: "device-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://mergestorm.ai/cli/auth",
          verification_uri_complete: "https://mergestorm.ai/cli/auth?code=ABCD-EFGH",
          interval: 1,
          expires_in: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ error: "authorization_pending" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  };
  await assert.rejects(
    () => cmdLogin([]),
    (err: unknown) =>
      err instanceof CommandError &&
      /timed out/i.test(err.message) &&
      !/unreachable or misconfigured/i.test(err.message),
  );
  assert.equal(startPaths.length, 2);
});

test("cmdLogin backs off and retries when device start returns slow_down (HTTP 400)", async () => {
  const startPaths: string[] = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v1/cli/device")) {
      startPaths.push(url);
      if (startPaths.length === 1) {
        return new Response(
          JSON.stringify({ error: "slow_down", retry_after_seconds: 0.01 }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          device_code: "device-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://mergestorm.ai/cli/auth",
          verification_uri_complete: "https://mergestorm.ai/cli/auth?code=ABCD-EFGH",
          interval: 1,
          expires_in: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ error: "authorization_pending" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  };
  await assert.rejects(
    () => cmdLogin([]),
    (err: unknown) =>
      err instanceof CommandError &&
      /timed out/i.test(err.message) &&
      !/unreachable or misconfigured/i.test(err.message),
  );
  assert.equal(startPaths.length, 2);
});
