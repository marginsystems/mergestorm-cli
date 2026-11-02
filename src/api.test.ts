import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  adoptStack,
  LandedQueueReadError,
  readLandedQueueEntry,
  apiFetch,
  dismissThreadsLine,
  cancelMergeQueueEntry,
  enqueueStack,
  ensureUpperPark,
  findStackPull,
  openStackPull,
  getEnrichedStack,
  getMe,
  getPrVortexReview,
  getReview,
  getSettings,
  listStacks,
  parseRetryAfterSeconds,
  patchSettings,
  setStackPolicy,
  getIssueReview,
  getIssueReviewMode,
  parseIssueReviewStatus,
  pollIssueReview,
  issueReviewWaitAfter,
  IssueReviewTimeoutError,
  issueNotApprovedRefusal,
  NO_LINKED_ISSUE,
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
      err.message === "API key invalid or revoked. Run `mergestorm login` (agents: `mergestorm login --start`, then `--finish`).",
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
  cyclone_skip_ci_enabled: true,
  cyclone_patch_unverified_languages: false,
  vortex_seam_specialist_enabled: true,
  auto_land_default: false,
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

test("adoptStack preserves the server error code and message", async () => {
  mockFetch(400, {
    error: "cyclone_not_installed",
    message: "Install Cyclone on this repository, then adopt. Cyclone is required for stacks.",
  });
  await assert.rejects(
    () => adoptStack("acme", "widgets", 42, cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "cyclone_not_installed" &&
      err.message ===
        "Install Cyclone on this repository, then adopt. Cyclone is required for stacks.",
  );
});

test("adoptStack ignores prose and blank messages as structured error fields", async () => {
  mockFetch(409, { error: "Cannot enable Auto land on an archived stack", message: "" });
  await assert.rejects(
    () => adoptStack("acme", "widgets", 42, cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === undefined &&
      err.message === 'Failed to import stack (HTTP 409): {"error":"Cannot enable Auto land on an archived stack","message":""}',
  );
});

test("adoptStack preserves server adopt codes and supplies copy for bare codes", async () => {
  mockFetch(422, { error: "not_stacked", stack: null, chain: [] });
  await assert.rejects(
    () => adoptStack("acme", "widgets", 42, cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "not_stacked" &&
      err.message === "This pull request is not part of a stack.",
  );

  mockFetch(503, { error: "busy" });
  await assert.rejects(
    () => adoptStack("acme", "widgets", 42, cfg),
    (err: unknown) => err instanceof CommandError && err.code === "busy",
  );

  mockFetch(503, { error: "supabase_unconfigured" });
  await assert.rejects(
    () => adoptStack("acme", "widgets", 42, cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "supabase_unconfigured" &&
      err.message === "Stacks are not configured on this server.",
  );
});


test("setStackPolicy surfaces the API cyclone_not_connected PATCH message", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.example.test/api/v1/stacks/stack-1");
    assert.equal(init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(init?.body)), { autoPatchOverride: true });
    return Response.json({
      error: "cyclone_not_connected",
      message: "Connect Cyclone to enable auto-patch.",
    }, { status: 400 });
  };
  await assert.rejects(() => setStackPolicy("stack-1", { autoPatchOverride: true }, cfg),
    (err: unknown) => err instanceof CommandError &&
      err.code === "cyclone_not_connected" &&
      err.message === "Connect Cyclone to enable auto-patch.");
});

test("setStackPolicy sends the auto-resolve-conflicts and auto-fix-ci overrides", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), {
      autoResolveConflictsOverride: true,
      autoFixCiOverride: null,
    });
    return Response.json({ autoResolveConflictsOverride: true, autoFixCiOverride: null });
  };
  assert.deepEqual(
    await setStackPolicy("stack-1", { autoResolveConflictsOverride: true, autoFixCiOverride: null }, cfg),
    { autoResolveConflictsOverride: true, autoFixCiOverride: null },
  );
});

const PULL_INPUT = {
  owner: "acme",
  repo: "widgets",
  head: "ms/feat-a",
  base: "main",
  title: "feat: a",
  body: "Body.",
};

test("openStackPull returns the number and created flag", async () => {
  mockFetch(201, { number: 77, url: "https://github.com/acme/widgets/pull/77", created: true });
  assert.deepEqual(await openStackPull(cfg, PULL_INPUT), {
    number: 77,
    url: "https://github.com/acme/widgets/pull/77",
    created: true,
  });
});

test("openStackPull maps cyclone_not_installed to the actionable sentence with the API link", async () => {
  mockFetch(400, {
    error: "cyclone_not_installed",
    message:
      "Opening PRs needs either the GitHub CLI (gh auth login) or Mergestorm Surge installed on acme/widgets " +
      "(https://github.com/apps/mergestorm-cyclone-staging/installations/new).",
  });
  await assert.rejects(
    () => openStackPull(cfg, PULL_INPUT),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "cyclone_not_installed" &&
      err.message ===
        "Opening PRs needs either the GitHub CLI (gh auth login) or Mergestorm Surge installed on acme/widgets " +
          "(https://github.com/apps/mergestorm-cyclone-staging/installations/new).",
  );
});

test("findStackPull falls back to the canonical install link on a transport not-installed error", async () => {
  mockFetch(500, { error: "github_unavailable", message: "GitHub App is not installed on acme/widgets" });
  await assert.rejects(
    () => findStackPull(cfg, { owner: "acme", repo: "widgets", head: "ms/feat-a" }),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "cyclone_not_installed" &&
      err.message.endsWith(
        "Mergestorm Surge installed on acme/widgets (https://github.com/apps/mergestorm-surge/installations/new).",
      ),
  );
});

test("openStackPull prints the server's Surge sentence and install link when the reason is a Surge one", async () => {
  mockFetch(400, {
    error: "cyclone_not_installed",
    reason: "surge_not_installed",
    message: "Opening PRs needs either the GitHub CLI (gh auth login) or Mergestorm Surge installed on acme/widgets (https://github.com/apps/mergestorm-surge/installations/new).",
  });
  await assert.rejects(
    () => openStackPull(cfg, PULL_INPUT),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "cyclone_not_installed" &&
      err.reason === "surge_not_installed" &&
      err.message === "Opening PRs needs either the GitHub CLI (gh auth login) or Mergestorm Surge installed on acme/widgets (https://github.com/apps/mergestorm-surge/installations/new)." &&
      !/Cyclone/.test(err.message),
  );
});

test("findStackPull appends a separate installUrl to a Surge refusal and falls back when the message is missing", async () => {
  mockFetch(400, {
    error: "cyclone_not_installed",
    reason: "surge_not_installed",
    message: "Mergestorm Surge is not installed on acme/widgets.",
    installUrl: "https://github.com/apps/mergestorm-surge/installations/new",
  });
  await assert.rejects(
    () => findStackPull(cfg, { owner: "acme", repo: "widgets", head: "ms/feat-a" }),
    (err: unknown) =>
      err instanceof CommandError &&
      err.message ===
        "Mergestorm Surge is not installed on acme/widgets. (https://github.com/apps/mergestorm-surge/installations/new)",
  );
  mockFetch(403, { error: "cyclone_permission_missing", reason: "surge_permission_missing" });
  await assert.rejects(
    () => findStackPull(cfg, { owner: "acme", repo: "widgets", head: "ms/feat-a" }),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "cyclone_permission_missing" &&
      err.reason === "surge_permission_missing" &&
      err.message === "Mergestorm Surge is not installed or not ready on this repository. Install it from Agents.",
  );
});

test("openStackPull keeps today's Cyclone sentence for a refusal without a Surge reason", async () => {
  for (const reason of [undefined, "", "other_reason", 7]) {
    mockFetch(400, {
      error: "cyclone_not_installed",
      ...(reason === undefined ? {} : { reason }),
      message: "Cyclone is not installed on acme/widgets.",
    });
    await assert.rejects(
      () => openStackPull(cfg, PULL_INPUT),
      (err: unknown) =>
        err instanceof CommandError &&
        err.code === "cyclone_not_installed" &&
        err.reason === undefined &&
        err.message ===
          "Opening PRs needs either the GitHub CLI (gh auth login) or Mergestorm Surge installed on acme/widgets " +
            "(https://github.com/apps/mergestorm-surge/installations/new).",
    );
  }
});

test("adoptStack surfaces a Surge installation held by another Mergestorm account under its own code", async () => {
  const message =
    "The Mergestorm Surge GitHub App is installed on acme/widgets, but its installation on GitHub ohnodev is linked to a different Mergestorm account. Sign in to the Mergestorm account that connected GitHub ohnodev, or connect GitHub ohnodev to this account from Agents.";
  mockFetch(400, { error: "surge_other_account", reason: "surge_other_account", installed_on: "ohnodev", message });
  await assert.rejects(
    () => adoptStack("acme", "widgets", 42, cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "surge_other_account" &&
      err.reason === "surge_other_account" &&
      err.message === message,
  );
});

test("adoptStack carries the Surge reason with the server's Surge message, and no reason without one", async () => {
  mockFetch(400, { error: "cyclone_not_connected", reason: "surge_not_connected", message: "Install the Mergestorm Surge GitHub App to adopt this pull request. Surge is the write app: adopt, restack, the merge queue, and Auto land all run through it. Install it from Agents." });
  await assert.rejects(
    () => adoptStack("acme", "widgets", 42, cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "cyclone_not_connected" &&
      err.reason === "surge_not_connected" &&
      err.message === "Install the Mergestorm Surge GitHub App to adopt this pull request. Surge is the write app: adopt, restack, the merge queue, and Auto land all run through it. Install it from Agents.",
  );
  mockFetch(400, { error: "cyclone_not_connected", message: "Connect the Cyclone GitHub App to adopt this pull request." });
  await assert.rejects(
    () => adoptStack("acme", "widgets", 42, cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "cyclone_not_connected" &&
      err.reason === undefined &&
      err.message === "Connect the Cyclone GitHub App to adopt this pull request.",
  );
});

test("a stack POST prints the server's Surge message; without a Surge reason it keeps the raw failure", async () => {
  mockFetch(400, { error: "cyclone_not_connected", reason: "surge_not_connected", message: "Install the Mergestorm Surge GitHub App to adopt this pull request. Surge is the write app: adopt, restack, the merge queue, and Auto land all run through it. Install it from Agents." });
  await assert.rejects(
    () => ensureUpperPark("stack-1", cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "cyclone_not_connected" &&
      err.reason === "surge_not_connected" &&
      err.message === "Install the Mergestorm Surge GitHub App to adopt this pull request. Surge is the write app: adopt, restack, the merge queue, and Auto land all run through it. Install it from Agents.",
  );
  mockFetch(400, { error: "cyclone_not_connected", message: "Connect Cyclone." });
  await assert.rejects(
    () => ensureUpperPark("stack-1", cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === undefined &&
      err.message ===
        'Failed to ensure upper-park freeze (HTTP 400): {"error":"cyclone_not_connected","message":"Connect Cyclone."}',
  );
});

test("enqueueStack prints the server's own line for a GitHub read failure, and a fixed line when there is none", async () => {
  mockFetch(503, {
    error: "github_unreadable",
    message: "Not queued: Mergestorm could not read #7 from GitHub, so it cannot record the head being queued. Nothing was enqueued; try again.",
  });
  await assert.rejects(
    () => enqueueStack("stack-1", cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "github_unreadable" &&
      err.exitCode === 1 &&
      err.message === "Not queued: Mergestorm could not read #7 from GitHub, so it cannot record the head being queued. Nothing was enqueued; try again.",
  );
  for (const message of [undefined, 7, "  ", "\u001b[2J"]) {
    mockFetch(503, { error: "github_unreadable", ...(message === undefined ? {} : { message }) });
    await assert.rejects(
      () => enqueueStack("stack-1", cfg),
      (err: unknown) =>
        err instanceof CommandError &&
        err.code === "github_unreadable" &&
        err.exitCode === 1 &&
        err.message === "GitHub could not be read just now; try again.",
    );
  }
});

test("enqueueStack strips escape sequences and control characters from the server's GitHub read failure", async () => {
  mockFetch(503, {
    error: "github_unreadable",
    message: "Not queued: \u001b[31mcould not read\u001b[0m #7\u0007\u009b from GitHub\r; try again.",
  });
  await assert.rejects(
    () => enqueueStack("stack-1", cfg),
    (err: unknown) =>
      err instanceof CommandError && err.message === "Not queued: could not read #7 from GitHub; try again.",
  );
});

test("cancelMergeQueueEntry keeps the raw failure for github_unreadable", async () => {
  mockFetch(503, { error: "github_unreadable", message: "Not queued." });
  await assert.rejects(
    () => cancelMergeQueueEntry("entry-1", cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === undefined &&
      err.message ===
        'Failed to remove merge queue entry (HTTP 503): {"error":"github_unreadable","message":"Not queued."}',
  );
});

test("a Surge refusal drops an install link that is not a GitHub App install page and strips escape sequences", async () => {
  for (const installUrl of [
    "https://evil.example/apps/mergestorm-surge/installations/new",
    "http://github.com/apps/mergestorm-surge/installations/new",
    "see https://github.com/apps/mergestorm-surge/installations/new",
    "https://github.com/apps/mergestorm-surge",
    "javascript:alert(1)",
    7,
  ]) {
    mockFetch(400, {
      error: "cyclone_not_installed",
      reason: "surge_not_installed",
      message: "\u001b]0;owned\u0007Mergestorm \u001b[1mSurge\u001b[0m is not installed on acme/widgets.\u0000",
      installUrl,
    });
    await assert.rejects(
      () => findStackPull(cfg, { owner: "acme", repo: "widgets", head: "ms/feat-a" }),
      (err: unknown) =>
        err instanceof CommandError &&
        err.reason === "surge_not_installed" &&
        err.message === "Mergestorm Surge is not installed on acme/widgets.",
    );
  }
  mockFetch(400, {
    error: "cyclone_not_installed",
    reason: "surge_not_installed",
    message: "Mergestorm Surge is not installed on acme/widgets.",
    installUrl: "https://github.com/apps/mergestorm-surge/installations/new/permissions?x=1 \u001b[31mtrailing",
  });
  await assert.rejects(
    () => findStackPull(cfg, { owner: "acme", repo: "widgets", head: "ms/feat-a" }),
    (err: unknown) =>
      err instanceof CommandError &&
      err.message ===
        "Mergestorm Surge is not installed on acme/widgets. (https://github.com/apps/mergestorm-surge/installations/new)",
  );
});

test("adoptStack shows the install link of a Surge refusal", async () => {
  mockFetch(400, {
    error: "cyclone_not_installed",
    reason: "surge_not_installed",
    message: "Install Mergestorm Surge on this repository, then adopt. Surge is required for stacks.",
    installUrl: "https://github.com/apps/mergestorm-surge/installations/new",
  });
  await assert.rejects(
    () => adoptStack("acme", "widgets", 42, cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "cyclone_not_installed" &&
      err.reason === "surge_not_installed" &&
      err.message ===
        "Install Mergestorm Surge on this repository, then adopt. Surge is required for stacks. (https://github.com/apps/mergestorm-surge/installations/new)",
  );
});

test("enqueueStack prints the server's Surge message and keeps other refusals as they were", async () => {
  mockFetch(400, { error: "cyclone_not_connected", reason: "surge_not_connected", message: "Install the Mergestorm Surge GitHub App to adopt this pull request. Surge is the write app: adopt, restack, the merge queue, and Auto land all run through it. Install it from Agents." });
  await assert.rejects(
    () => enqueueStack("stack-1", cfg),
    (err: unknown) => err instanceof CommandError && err.reason === "surge_not_connected" && err.message === "Install the Mergestorm Surge GitHub App to adopt this pull request. Surge is the write app: adopt, restack, the merge queue, and Auto land all run through it. Install it from Agents.",
  );
  mockFetch(400, { error: "cyclone_not_connected", message: "Connect Cyclone." });
  await assert.rejects(
    () => enqueueStack("stack-1", cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.message ===
        'Failed to add stack to merge queue (HTTP 400): {"error":"cyclone_not_connected","message":"Connect Cyclone."}',
  );
  mockFetch(503, { error: "busy" });
  await assert.rejects(
    () => enqueueStack("stack-1", cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.message === 'Failed to add stack to merge queue (HTTP 503): {"error":"busy"}',
  );
});

test("findStackPull returns null when no PR is open", async () => {
  mockFetch(200, { number: null, url: null });
  assert.equal(await findStackPull(cfg, { owner: "acme", repo: "widgets", head: "ms/feat-a" }), null);
});

test("landed queue reads retain HTTP status and the larger Retry-After", async () => {
  mockFetch(429, { retry_after_seconds: 12 }, { "Retry-After": "7" });
  await assert.rejects(readLandedQueueEntry(cfg, "stack"), (err: unknown) => {
    assert.ok(err instanceof LandedQueueReadError);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterSeconds, 12);
    return true;
  });
});

test("landed queue reads retain auth failures", async () => {
  mockFetch(401);
  await assert.rejects(readLandedQueueEntry(cfg, "stack"), /API key invalid/);
});

test("landed queue reads enforce request deadlines", async () => {
  mockHangingFetch();
  await assert.rejects(readLandedQueueEntry(cfg, "stack", { timeoutMs: 10 }), /Request timed out/);
});

test("landed queue reads preserve caller cancellation", async () => {
  mockHangingFetch();
  const controller = new AbortController();
  const request = readLandedQueueEntry(cfg, "stack", { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
});

test("dismissThreadsLine reports resolved, failed and missing review threads", () => {
  assert.equal(dismissThreadsLine({ threads: [] }), null);
  assert.equal(dismissThreadsLine({}), null);
  assert.equal(
    dismissThreadsLine({
      threads: [
        { finding_id: "1", state: "resolved" },
        { finding_id: "2", state: "already_resolved" },
        { finding_id: "3", state: "failed" },
        { finding_id: "4", state: "not_found" },
      ],
    }),
    "GitHub threads: 2 of 4 resolved. Could not resolve 3; run the same dismissal again to retry. No thread found for 4.",
  );
});

test("apiFetch names the Breeze chat from MERGESTORM_CHAT_ID, unless the config ignores the environment", async () => {
  const seen: Array<string | null> = [];
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seen.push(new Headers(init?.headers).get("x-mergestorm-chat-id"));
    return new Response("{}", { status: 200 });
  };
  const before = process.env.MERGESTORM_CHAT_ID;
  try {
    process.env.MERGESTORM_CHAT_ID = "6A1F0000-0000-4000-8000-000000000001";
    await apiFetch(cfg, "/api/v1/me");
    await apiFetch({ ...cfg, ignoreEnv: true }, "/api/v1/me");
    process.env.MERGESTORM_CHAT_ID = "not-a-chat";
    await apiFetch(cfg, "/api/v1/me");
  } finally {
    if (before === undefined) delete process.env.MERGESTORM_CHAT_ID;
    else process.env.MERGESTORM_CHAT_ID = before;
  }
  assert.deepEqual(seen, ["6a1f0000-0000-4000-8000-000000000001", null, null]);
});

const ISSUE_TARGET = { owner: "acme", repo: "widgets", number: 12 };

test("parseIssueReviewStatus reads the mode and treats a response without one as auto while reviews are on", () => {
  assert.equal(parseIssueReviewStatus({ state: "unreviewed", enabled: true, mode: "mention" }, ISSUE_TARGET)?.mode, "mention");
  assert.equal(parseIssueReviewStatus({ state: "unreviewed", enabled: true }, ISSUE_TARGET)?.mode, "auto");
  assert.equal(parseIssueReviewStatus({ state: "off", enabled: false }, ISSUE_TARGET)?.mode, "off");
  assert.equal(parseIssueReviewStatus({ state: "unreviewed", enabled: true, mode: "sometimes" }, ISSUE_TARGET)?.mode, "auto");
});

function issueReviewBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: "acme",
    repo: "widgets",
    number: 12,
    enabled: true,
    mode: "auto",
    state: "needs_answers",
    approvedBy: null,
    round: 2,
    maxRounds: 4,
    verdict: "needs_answers",
    summary: "Two questions first.",
    points: [{ kind: "question", text: "Which repo?", blocking: true }, { kind: "risk", text: "Rollback?", blocking: false }],
    commentUrl: "https://github.com/acme/widgets/issues/12#issuecomment-1",
    next: "Answer both points in a comment on #12.",
    ...overrides,
  };
}

test("getIssueReview reads the review state of the issue in that repository", async () => {
  const urls: string[] = [];
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify(issueReviewBody()), { status: 200 });
  };
  assert.deepEqual(await getIssueReview(cfg, ISSUE_TARGET), {
    ...issueReviewBody(),
    wait: { status: "points", reason: "needs_answers", verdictRound: 2, verdictAt: null, answeredAt: null, retryAt: null, minutes: null },
  });
  assert.deepEqual(urls, ["https://api.example.test/api/v1/stacks/issues/12/review?owner=acme&repo=widgets"]);
});

test("getIssueReviewMode reads the repository mode and returns null when the server has no answer for it", async () => {
  const urls: string[] = [];
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ owner: "acme", repo: "widgets", mode: "mention" }), { status: 200 });
  };
  assert.equal(await getIssueReviewMode(cfg, { owner: "acme", repo: "widgets" }), "mention");
  assert.deepEqual(urls, ["https://api.example.test/api/v1/stacks/issues/review-mode?owner=acme&repo=widgets"]);
  mockFetch(404, { error: "not_found" });
  assert.equal(await getIssueReviewMode(cfg, { owner: "acme", repo: "widgets" }), null);
  mockFetch(200, { mode: "sometimes" });
  await assert.rejects(() => getIssueReviewMode(cfg, { owner: "acme", repo: "widgets" }), /Failed to read the issue review mode/);
});

test("getIssueReview returns null when the server predates issue reviews", async () => {
  mockFetch(404, { error: "not_found" });
  assert.equal(await getIssueReview(cfg, ISSUE_TARGET), null);
});

test("getIssueReview refuses when the server says the repository is not connected", async () => {
  mockFetch(404, { error: "not_found", message: "acme/widgets is not connected to this Mergestorm account." });
  await assert.rejects(
    () => getIssueReview(cfg, ISSUE_TARGET),
    (err) => err instanceof CommandError && err.code === "not_found" && /acme\/widgets is not connected to this Mergestorm account\. Connect it in Mergestorm/.test(err.message),
  );
});

test("getIssueReview refuses an unknown state and keeps the server message and rate limits", async () => {
  mockFetch(200, issueReviewBody({ state: "maybe" }));
  await assert.rejects(() => getIssueReview(cfg, ISSUE_TARGET), /Failed to read the issue review of acme\/widgets#12 \(HTTP 200\)/);
  mockFetch(503, { message: "GitHub is down" });
  await assert.rejects(
    () => getIssueReview(cfg, ISSUE_TARGET),
    (err) => err instanceof CommandError && err.code === "issue_review_unavailable" && err.message === "GitHub is down",
  );
  mockFetch(429, { error: "rate_limited" }, { "retry-after": "4" });
  await assert.rejects(
    () => getIssueReview(cfg, ISSUE_TARGET),
    (err) => err instanceof CommandError && err.code === "rate_limited" && err.exitCode === 7,
  );
});

test("pollIssueReview polls every interval while the review is pending and retries a 5xx", async () => {
  const responses = [
    { status: 200, body: issueReviewBody({ state: "pending", verdict: null, points: [] }) },
    { status: 502, body: { message: "bad gateway" } },
    { status: 200, body: issueReviewBody({ state: "approved", approvedBy: "vortex", verdict: "ready", points: [] }) },
  ];
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = async () => {
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  const sleeps: number[] = [];
  let clock = 0;
  const status = await pollIssueReview(cfg, ISSUE_TARGET, {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  assert.equal(status?.state, "approved");
  assert.equal(status?.approvedBy, "vortex");
  assert.deepEqual(sleeps, [10_000, 10_000]);
});

test("pollIssueReview returns a settled state at once and times out with the last pending read", async () => {
  mockFetch(200, issueReviewBody());
  assert.equal((await pollIssueReview(cfg, ISSUE_TARGET, { sleep: async () => assert.fail("no sleep") }))?.state, "needs_answers");
  mockFetch(200, issueReviewBody({ state: "pending", round: 1 }));
  let clock = 0;
  await assert.rejects(
    () =>
      pollIssueReview(cfg, ISSUE_TARGET, {
        timeoutMs: 25_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    (err) =>
      err instanceof IssueReviewTimeoutError &&
      err.exitCode === 5 &&
      err.lastStatus.state === "pending" &&
      err.lastStatus.round === 1,
  );
});

test("adoptStack and openStackPull turn a 409 issue_not_approved into the blocking issues and what to do", async () => {
  const refusal = {
    error: "issue_not_approved",
    message: "Vortex has not approved #12.",
    issues: [issueReviewBody()],
  };
  const expected = [
    "Vortex has not approved #12.",
    "acme/widgets#12: needs_answers (round 2 of 4)",
    "  Two questions first.",
    "  1. [question] Which repo?",
    "  2. [note: risk] Rollback?",
    "  Review: https://github.com/acme/widgets/issues/12#issuecomment-1",
    "  Next: Answer both points in a comment on #12.",
    "  Reply once in a comment on #12, accepting each blocking point's suggested fix or saying why not; then run `mergestorm issue wait 12 --repo acme/widgets --after-round 2` once.",
  ].join("\n");
  mockFetch(409, refusal);
  await assert.rejects(
    () => adoptStack("acme", "widgets", 42, cfg),
    (err) => err instanceof CommandError && err.code === "issue_not_approved" && err.message === expected,
  );
  mockFetch(409, refusal);
  await assert.rejects(
    () => openStackPull(cfg, PULL_INPUT),
    (err) => err instanceof CommandError && err.code === "issue_not_approved" && err.message === expected,
  );
});

test("pollIssueReview keeps waiting on an auto-mode issue Vortex has not reviewed yet, until its round finishes", async () => {
  const responses = [
    issueReviewBody({ state: "unreviewed", mode: "auto", round: null, verdict: null, points: [] }),
    issueReviewBody({ state: "pending", round: 1, verdict: null, points: [] }),
    issueReviewBody({ state: "needs_answers", round: 1 }),
  ];
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(responses.shift()!), { status: 200 });
  let clock = 0;
  const sleeps: number[] = [];
  const status = await pollIssueReview(cfg, ISSUE_TARGET, {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  assert.equal(status?.state, "needs_answers");
  assert.deepEqual(sleeps, [10_000, 10_000]);
});

function waitBody(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { status, reason: status, verdictRound: 2, verdictAt: "2026-11-02T06:22:32Z", answeredAt: null, retryAt: null, minutes: null, ...extra };
}

function scriptedIssueReviews(bodies: Record<string, unknown>[]): () => number {
  let reads = 0;
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = async () => {
    const body = bodies[Math.min(reads, bodies.length - 1)]!;
    reads++;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return () => reads;
}

function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let clock = 0;
  return { now: () => clock, sleep: async (ms) => { clock += ms; } };
}

test("pollIssueReview never returns the stale verdict once the server has seen an answer", async () => {
  const reads = scriptedIssueReviews([
    issueReviewBody({ state: "pending", wait: waitBody("answered_waiting_for_round", { answeredAt: "2026-11-02T06:24:54Z" }) }),
    issueReviewBody({ state: "pending", round: 3, verdict: "needs_answers", wait: waitBody("round_running", { verdictRound: 2 }) }),
    issueReviewBody({ state: "approved", approvedBy: "vortex", round: 3, verdict: "ready", points: [], wait: waitBody("approved", { verdictRound: 3 }) }),
  ]);
  const status = await pollIssueReview(cfg, ISSUE_TARGET, fakeClock());
  assert.equal(status?.state, "approved");
  assert.equal(status?.wait.status, "approved");
  assert.equal(reads(), 3);
});

test("pollIssueReview with a round cursor keeps waiting past the verdict it already saw and wakes on the next round", async () => {
  const reads = scriptedIssueReviews([
    issueReviewBody({ wait: waitBody("points") }),
    issueReviewBody({ wait: waitBody("points") }),
    issueReviewBody({ round: 3, wait: waitBody("points", { verdictRound: 3 }) }),
  ]);
  const status = await pollIssueReview(cfg, ISSUE_TARGET, { afterRound: 2, ...fakeClock() });
  assert.equal(status?.round, 3);
  assert.equal(status?.wait.status, "points");
  assert.equal(status?.wait.verdictRound, 3);
  assert.equal(reads(), 3);
  scriptedIssueReviews([issueReviewBody({ wait: waitBody("points") })]);
  assert.equal((await pollIssueReview(cfg, ISSUE_TARGET, { afterRound: 1, sleep: async () => assert.fail("no sleep") }))?.wait.status, "points");
});

test("pollIssueReview carries the wait start through a timed-out retry so short waits still reach the no-answer stall", async () => {
  const verdictAt = Date.parse("2026-11-02T06:00:00Z");
  const start = verdictAt + 30 * 60_000;
  scriptedIssueReviews([issueReviewBody({ wait: waitBody("points", { verdictAt: "2026-11-02T06:00:00Z" }) })]);
  let clock = start;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  let retry = "";
  await assert.rejects(
    () => pollIssueReview(cfg, ISSUE_TARGET, { afterRound: 2, timeoutMs: 60_000, now: () => clock, sleep }),
    (err) => {
      if (!(err instanceof IssueReviewTimeoutError)) return false;
      retry = err.message;
      return true;
    },
  );
  assert.match(retry, new RegExp(`mergestorm issue wait 12 --repo acme/widgets --after-round 2 --waiting-since ${start}`));
  const stalled = await pollIssueReview(cfg, ISSUE_TARGET, { afterRound: 2, waitingSince: start, timeoutMs: 60_000, now: () => clock, sleep });
  assert.equal(stalled?.wait.status, "stalled");
  assert.equal(stalled?.wait.reason, "no_answer_seen");
});

test("pollIssueReview reports a stall when no round follows the cursor, and the server's own stall at once", async () => {
  scriptedIssueReviews([issueReviewBody({ wait: waitBody("points", { verdictAt: null }) })]);
  const stalled = await pollIssueReview(cfg, ISSUE_TARGET, { afterRound: 2, timeoutMs: 3_600_000, ...fakeClock() });
  assert.equal(stalled?.wait.status, "stalled");
  assert.equal(stalled?.wait.reason, "no_answer_seen");
  assert.equal(stalled?.wait.minutes, 10);
  scriptedIssueReviews([issueReviewBody({ state: "pending", wait: waitBody("stalled", { reason: "commenter_not_allowed", minutes: 12 }) })]);
  const server = await pollIssueReview(cfg, ISSUE_TARGET, { afterRound: 2, sleep: async () => assert.fail("no sleep") });
  assert.equal(server?.wait.status, "stalled");
  assert.equal(server?.wait.reason, "commenter_not_allowed");
});

test("the no-answer stall clock starts at the verdict, so a fresh wait on an old verdict stalls after a short grace", () => {
  const verdictAt = Date.parse("2026-11-02T06:22:32Z");
  const status = parseIssueReviewStatus(issueReviewBody({ wait: waitBody("points") }), ISSUE_TARGET)!;
  const at = (minutesAfterVerdict: number, waitedMs: number) =>
    issueReviewWaitAfter(status, { afterRound: 2, waitedMs, nowMs: verdictAt + minutesAfterVerdict * 60_000 });
  assert.equal(at(30, 60_000).status, "answered_waiting_for_round");
  const late = at(30, 2 * 60_000);
  assert.equal(late.status, "stalled");
  assert.equal(late.minutes, 30);
  assert.equal(at(5, 5 * 60_000).status, "answered_waiting_for_round");
});

test("an older server's unreviewed auto issue gets the same first-round stall", () => {
  const legacy = parseIssueReviewStatus(issueReviewBody({ state: "unreviewed", round: null, verdict: null }), ISSUE_TARGET)!;
  assert.equal(legacy.wait.status, "stalled");
  assert.equal(issueReviewWaitAfter(legacy, { waitedMs: 60_000 }).status, "round_running");
  assert.equal(issueReviewWaitAfter(legacy, { waitedMs: 10 * 60_000 }).status, "stalled");
});

test("pollIssueReview gives a new issue time for its first round before calling it stalled", async () => {
  const reads = scriptedIssueReviews([
    issueReviewBody({ state: "unreviewed", round: null, verdict: null, points: [], wait: waitBody("stalled", { reason: "no_review_started", verdictRound: null }) }),
    issueReviewBody({ state: "needs_answers", round: 1, wait: waitBody("points", { verdictRound: 1 }) }),
  ]);
  const status = await pollIssueReview(cfg, ISSUE_TARGET, fakeClock());
  assert.equal(status?.wait.status, "points");
  assert.equal(reads(), 2);
});

test("pollIssueReview reports the round cap as an approval", async () => {
  scriptedIssueReviews([issueReviewBody({ state: "approved", approvedBy: "vortex", wait: waitBody("approved", { reason: "round_cap" }) })]);
  const status = await pollIssueReview(cfg, ISSUE_TARGET, { afterRound: 2, sleep: async () => assert.fail("no sleep") });
  assert.equal(status?.wait.status, "approved");
  assert.equal(status?.wait.reason, "round_cap");
});

test("an older server without a wait object still reads, and a cursor still holds its stale verdict back", () => {
  const legacy = parseIssueReviewStatus(issueReviewBody(), ISSUE_TARGET)!;
  assert.deepEqual(legacy.wait, { status: "points", reason: "needs_answers", verdictRound: 2, verdictAt: null, answeredAt: null, retryAt: null, minutes: null });
  assert.equal(issueReviewWaitAfter(legacy, { afterRound: 2, waitedMs: 0 }).status, "answered_waiting_for_round");
  assert.equal(issueReviewWaitAfter(legacy, { afterRound: 1, waitedMs: 0 }).status, "points");
});

test("issueNotApprovedRefusal marks a refusal with no linked issue so no reply instructions follow it", () => {
  const unlinked = issueNotApprovedRefusal(409, { error: "issue_not_approved", message: "add Fixes #N", issues: [] }, "acme", "widgets");
  assert.equal(unlinked?.reason, NO_LINKED_ISSUE);
  const named = issueNotApprovedRefusal(409, { error: "issue_not_approved", message: "#12 is pending", issues: [{ number: 12, state: "pending" }] }, "acme", "widgets");
  assert.equal(named?.reason, undefined);
});
