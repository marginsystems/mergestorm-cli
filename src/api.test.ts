import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  apiFetch,
  getEnrichedStack,
  getMe,
  getPrVortexReview,
  getReview,
  getSettings,
  listStacks,
  parseRetryAfterSeconds,
  patchSettings,
} from "./api.js";
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

function mockFetch(
  status: number,
  body: unknown = { error: "unauthorized" },
  headers: Record<string, string> = {},
): void {
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
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

test("getPrVortexReview requests the DB-only PR review route", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    assert.equal(
      url,
      "https://api.example.test/api/v1/stacks/pr-review?owner=acme&repo=widgets&pr_number=12",
    );
    assert.equal(url.includes("/stacks/enrich"), false);
    assert.equal(url.includes("/api/v1/reviews"), false);
    return new Response(
      JSON.stringify({
        schema: "mergestorm.pr_review/v1",
        owner: "acme",
        repo: "widgets",
        pr_number: 12,
        status: "completed",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const review = await getPrVortexReview("acme", "widgets", 12, cfg);
  assert.equal(review.schema, "mergestorm.pr_review/v1");
});

test("getPrVortexReview maps 404 and 429 to stable errors", async () => {
  mockFetch(404, { error: "not_found" });
  await assert.rejects(
    () => getPrVortexReview("acme", "widgets", 12, cfg),
    (err: unknown) => err instanceof CommandError && err.code === "not_found",
  );

  mockFetch(
    429,
    { error: "rate_limited", retry_after_seconds: 4 },
    { "Retry-After": "6" },
  );
  await assert.rejects(
    () => getPrVortexReview("acme", "widgets", 12, cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "rate_limited" &&
      err.exitCode === 7 &&
      err.retryAfterSeconds === 6,
  );
});

test("listStacks returns the stack DTOs from the Bearer API", async () => {
  mockFetch(200, {
    stacks: [{ id: "stack-1", owner: "acme", repo: "widgets", layers: [] }],
  });
  const stacks = await listStacks(cfg);
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0]?.id, "stack-1");
});

test("getEnrichedStack requests one encoded stack id", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(
      String(input),
      "https://api.example.test/api/v1/stacks/enrich?stackId=stack%2Fone",
    );
    return new Response(
      JSON.stringify({
        stacks: [
          { id: "stack/one", owner: "acme", repo: "widgets", layers: [] },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const stack = await getEnrichedStack("stack/one", cfg);
  assert.equal(stack?.id, "stack/one");
});

test("getEnrichedStack returns null when the owned stack is absent", async () => {
  mockFetch(200, { stacks: [] });
  assert.equal(await getEnrichedStack("not-owned", cfg), null);
});

test("getEnrichedStack throws on a malformed 200 without a stacks array", async () => {
  mockFetch(200, { error: "oops" });
  await assert.rejects(
    () => getEnrichedStack("stack-1", cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.message === 'Failed to get stack status (HTTP 200): {"error":"oops"}',
  );
});

test("getEnrichedStack throws on API errors", async () => {
  mockFetch(503, { error: "busy" });
  await assert.rejects(
    () => getEnrichedStack("stack-1", cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.message === 'Failed to get stack status (HTTP 503): {"error":"busy"}',
  );
});

const SETTINGS_BODY = {
  auto_review_enabled: true,
  auto_patch_enabled: false,
  cyclone_connected: false,
  github_connected: true,
  vortex_show_thinking_traces: true,
  repo_overview_enabled: false,
  review_unit_land_prs_enabled: true,
  cyclone_review_unit_land_prs_enabled: false,
  vortex_seam_specialist_enabled: true,
};

test("getSettings GETs Bearer /api/v1/settings, never the cookie route", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(url, "https://api.example.test/api/v1/settings");
    assert.equal(url.includes("/api/settings"), false, "cookie route is off limits");
    assert.notEqual(init?.method, "PATCH");
    return new Response(JSON.stringify(SETTINGS_BODY), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  assert.deepEqual(await getSettings(cfg), SETTINGS_BODY);
});

test("getSettings soft-fails 404 and network errors to null, like getMe", async () => {
  mockFetch(404, { error: "not_found" });
  assert.equal(await getSettings(cfg), null);

  originalFetch ??= globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  assert.equal(await getSettings(cfg), null);
});

test("getSettings rethrows 401 instead of returning null", async () => {
  mockFetch(401);
  await assert.rejects(
    () => getSettings(cfg),
    (err: unknown) => err instanceof CommandError && err.code === "auth_invalid",
  );
});

test("patchSettings PATCHes Bearer /api/v1/settings and returns the stored result", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.example.test/api/v1/settings");
    assert.equal(init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(init?.body)), { auto_patch_enabled: false });
    return new Response(JSON.stringify(SETTINGS_BODY), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  assert.deepEqual(await patchSettings({ auto_patch_enabled: false }, cfg), SETTINGS_BODY);
});

test("patchSettings surfaces the API message on a rejected PATCH", async () => {
  mockFetch(400, {
    error: "cyclone_not_connected",
    message: "Connect Cyclone to enable auto-patch.",
  });
  await assert.rejects(
    () => patchSettings({ auto_patch_enabled: true }, cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.message === "Connect Cyclone to enable auto-patch.",
  );
});

test("patchSettings rejects an empty patch without a request", async () => {
  await assert.rejects(
    () => patchSettings({}, cfg),
    (err: unknown) => err instanceof CommandError && err.code === "usage",
  );
});

test("stack reads preserve structured rate-limit details", async () => {
  mockFetch(
    429,
    { error: "rate_limited", retry_after_seconds: 9 },
    { "Retry-After": "7" },
  );
  await assert.rejects(
    () => listStacks(cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "rate_limited" &&
      err.exitCode === 7 &&
      err.retryAfterSeconds === 9,
  );

  mockFetch(
    429,
    { error: "rate_limited", retry_after_seconds: 4 },
    { "Retry-After": "6" },
  );
  await assert.rejects(
    () => getEnrichedStack("stack-1", cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "rate_limited" &&
      err.exitCode === 7 &&
      err.retryAfterSeconds === 6,
  );
});
