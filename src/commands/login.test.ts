import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Config } from "../config.js";
import { CommandError } from "../errors.js";
import { validateApiKey } from "./login.js";

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
      premium: { used: 0, limit: 10, remaining: 10 },
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
