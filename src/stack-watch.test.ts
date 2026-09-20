import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiFetchInit, ApiFetchResult } from "./api.js";
import type { StackDto, StackLayerDto, MergeQueueEntryDto } from "./stack-dto.js";
import {
  pollStackWatch, StackWatchError, StackWatchTimeoutError,
  type PollStackWatchOptions, type StackWatchEnvelope,
} from "./stack-watch.js";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const cfg = { apiKey: "test" };
function layer(overrides: Partial<StackLayerDto> = {}): StackLayerDto {
  return {
    branch: "feature", parentBranch: "main", prNumber: 42, position: 0, state: "clean",
    openedAt: null, mergedAt: null, closedAt: null, additions: null, deletions: null,
    openAdditions: null, openDeletions: null, title: null, htmlUrl: null,
    ciStatus: "success", reviewStatus: "approved", checks: null, vortexStatus: null,
    cycloneStatus: null, tempestStatus: null, conflictDetail: null, lastRestackedSha: null,
    mergeable: true, mergeableState: "clean", headSha: HEAD, mergeableHeadSha: HEAD,
    ...overrides,
  };
}
function stack(layers = [layer()]): StackDto {
  return { id: "stack", owner: "owner", repo: "repo", trunkBranch: "main", landTarget: "main", archivedAt: null, layers };
}
function bounce(overrides: Partial<MergeQueueEntryDto> = {}): MergeQueueEntryDto {
  return {
    id: "bounce", stackId: "stack", owner: "owner", repo: "repo", state: "bounced", position: 0,
    waitReason: null, bounceReason: null, bounceDetail: { kind: "ci_failure", headSha: HEAD, failingCheck: "lint" },
    enqueuedBy: "agent", enqueuedVia: "cli", enqueuedAt: "2026-01-01T00:00:00Z", attempts: 1,
    landedPrNumbers: [], verifyHeadSha: NEXT, verifyBaseSha: null, finishedAt: "2026-01-01T00:01:00Z",
    ...overrides,
  };
}
function harness(initial = stack(), initialEntries: MergeQueueEntryDto[] = []) {
  let time = 0;
  const calls: { route: string; timeoutMs: number | undefined }[] = [];
  const sleeps: number[] = [];
  const ticks: StackWatchEnvelope[] = [];
  const state = {
    stack: initial, entries: initialEntries,
    respond: undefined as ((route: string, init: ApiFetchInit) => ApiFetchResult | undefined) | undefined,
    advance: (ms: number) => { time += ms; },
  };
  const options: PollStackWatchOptions = {
    timeoutMs: 4_000, now: () => time, random: () => 1,
    sleep: async (ms) => { sleeps.push(ms); time += ms; },
    onTick: (envelope) => { ticks.push(envelope); },
    fetch: async (_cfg, route, init = {}) => {
      calls.push({ route, timeoutMs: init.timeoutMs });
      const response = state.respond?.(route, init);
      if (route.includes("&wait=") && !response) time += 1000;
      return response ?? { status: 200, body: route.includes("/queue") ? { entries: state.entries } : { stacks: [state.stack] } };
    },
  };
  return { state, options, calls, sleeps, ticks };
}
async function timedOut(options: PollStackWatchOptions): Promise<StackWatchEnvelope> {
  try { await pollStackWatch(cfg, "stack", options); }
  catch (err) {
    assert.ok(err instanceof StackWatchTimeoutError);
    assert.equal(err.lastEnvelope.status, "waiting");
    return err.lastEnvelope;
  }
  assert.fail("Expected timeout");
}

test("attention at enrollment: CI on the current head", async () => {
  const h = harness(stack([layer({ ciStatus: "failure", checks: { total: 1, success: 0, pending: 0, failure: 1, failingName: " lint " } })]));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.deepEqual(result, {
    schema: "mergestorm.stack_watch/v1", status: "attention", stackId: "stack",
    blocker: "CI failed — lint", bounceKind: null, prNumber: 42, headSha: HEAD,
    cursor: { stackId: "stack", enrolledHeadSha: HEAD },
  });
  assert.deepEqual(h.calls.map((call) => call.route), ["/api/v1/stacks/enrich?stackId=stack", "/api/v1/stacks/queue?stackId=stack"]);
  assert.deepEqual(h.sleeps, []);
});

test("timeout resume keeps enrollment and selectors through changed heads and retries", async () => {
  const h = harness();
  h.options.onTick = () => { h.state.stack = stack([layer({ headSha: NEXT })]); };
  const first = await timedOut(h.options);
  assert.equal(first.headSha, NEXT);
  assert.equal(first.cursor.enrolledHeadSha, HEAD);
  const cursor = Object.freeze({ ...first.cursor, afterFinishedAt: "2026-01-01T00:00:00Z", bounceId: "reported" });
  let retry = true;
  h.state.respond = () => {
    if (retry) { retry = false; return { status: 429, body: {}, retryAfterSeconds: 1 }; }
  };
  const second = await timedOut({ ...h.options, cursor });
  assert.deepEqual(second.cursor, cursor);
  assert.equal(second.headSha, NEXT);
});

test("stale bounce uses current head, not verify or enrolled head", async () => {
  const h = harness(stack([layer({ headSha: NEXT })]), [bounce({ verifyHeadSha: NEXT })]);
  const result = await timedOut({ ...h.options, cursor: { stackId: "stack", enrolledHeadSha: HEAD } });
  assert.equal(result.blocker, null);
  h.state.entries = [bounce({ bounceDetail: { kind: "ci_failure", headSha: NEXT.slice(0, 7).toUpperCase(), failingCheck: "lint" }, verifyHeadSha: HEAD })];
  const attention = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(attention.blocker, "CI failed — lint");
  assert.equal(attention.bounceKind, "ci_failure");
});

test("surfaced bounce is added to the cursor for the next watch cycle", async () => {
  const h = harness(stack(), [bounce()]);
  const first = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(first.status, "attention");
  assert.deepEqual(first.cursor, {
    stackId: "stack", enrolledHeadSha: HEAD, bounceId: "bounce",
    afterFinishedAt: "2026-01-01T00:01:00Z",
  });
  await assert.rejects(
    pollStackWatch(cfg, "stack", { ...h.options, cursor: first.cursor }),
    (err: unknown) => err instanceof StackWatchTimeoutError && err.lastEnvelope.blocker === null,
  );
});

for (const endpoint of ["snapshot", "queue"]) {
  test(`429 from ${endpoint} backs off using Retry-After then succeeds`, async () => {
    const h = harness();
    let retry = true;
    let enriches = 0;
    h.state.respond = (route) => {
      if (retry && (endpoint === "snapshot" ? route.includes("/enrich") : route.includes("&wait="))) {
        retry = false;
        return { status: 429, body: {}, retryAfterSeconds: 1.25 };
      }
      if (endpoint === "queue" && route.includes("&wait=")) {
        h.state.entries = [bounce()];
      }
      if (endpoint === "snapshot" && route.includes("/enrich") && ++enriches > 1) {
        h.state.entries = [bounce()];
      }
    };
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "attention");
    assert.deepEqual(h.sleeps, [1250]);
    assert.equal(h.ticks[0].status, "rate_limited");
    assert.equal(
      h.calls.find((call) => call.route.includes("&wait="))?.timeoutMs,
      endpoint === "queue" ? 9000 : 8000,
    );
  });
}

for (const kind of ["head_moved", "must_consolidate"] as const) {
  test(`${kind} on current head is recoverable even with stale CI failure`, async () => {
    const h = harness(stack([layer({ ciStatus: "failure" })]), [bounce({ bounceDetail: { kind, headSha: HEAD }, verifyHeadSha: HEAD })]);
    assert.equal((await timedOut(h.options)).blocker, null);
  });
}

for (const state of ["queued", "running", "waiting"] as const) {
  test(`live ${state} suppresses hard blockers and bounce attention`, async () => {
    const h = harness(stack([layer({ ciStatus: "failure" })]), [bounce(), bounce({ id: "live", state })]);
    await timedOut(h.options);
    assert.ok(h.ticks.every((tick) => tick.status === "in_progress" && tick.blocker === null));
  });
}

test("ignores other stacks' live entries and reported bounces", async () => {
  const h = harness(stack(), [bounce(), bounce({ stackId: "other", state: "running" })]);
  assert.equal((await pollStackWatch(cfg, "stack", h.options)).status, "attention");
  await timedOut({ ...h.options, cursor: { stackId: "stack", enrolledHeadSha: HEAD, bounceId: "bounce" } });
  await timedOut({ ...h.options, cursor: { stackId: "stack", enrolledHeadSha: HEAD, afterFinishedAt: h.state.entries[0].finishedAt } });
});

test("Tempest findings take precedence over a failed Vortex review", async () => {
  const h = harness(stack([layer({
    vortexStatus: "failed",
    agentRuns: [{ agent: "tempest", status: "findings", sha: HEAD }],
  })]));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.blocker, "Tempest findings");
});

test("unit land gate blocks the selected land PR", async () => {
  const h = harness(stack([]));
  h.state.stack.unit = {
    id: "unit", uNumber: 1, state: "growing", branch: "unit", landTarget: "main", landPrNumber: 50,
    tempestLandStatus: "failed", landingBlockReason: "tempest_failed on land PR #50",
    landPr: layer({ prNumber: 50 }), members: [],
  };
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.blocker, "tempest_failed on land PR #50");
});

test("stack wait normalizes case-insensitive stack IDs", async () => {
  const h = harness(stack());
  h.state.stack.id = "ABCDEF";
  h.state.entries = [bounce({ stackId: "ABCDEF" })];
  const result = await pollStackWatch(cfg, "abcdef", h.options);
  assert.equal(result.status, "attention");
});

test("bottom unpromoted real layer then unit land PR supplies enrollment", async () => {
  const h = harness(stack([layer({ prNumber: 0, position: -2, headSha: "placeholder" }), layer({ prNumber: 41, position: -1, headSha: "promoted" }), layer({ ciStatus: "failure" })]));
  h.state.stack.unit = {
    id: "unit", uNumber: 1, state: "growing", branch: "unit", landTarget: "main", landPrNumber: 50,
    tempestLandStatus: null, landingBlockReason: null, landPr: layer({ prNumber: 50, headSha: NEXT, ciStatus: "failure" }),
    members: [{ prNumber: 41, promotedHeadSha: "promoted" } as NonNullable<StackDto["unit"]>["members"][number]],
  };
  assert.equal((await pollStackWatch(cfg, "stack", h.options)).cursor.enrolledHeadSha, HEAD);
  h.state.stack.layers.pop();
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.cursor.enrolledHeadSha, NEXT);
  assert.equal(result.prNumber, 50);
});

test("bounce on a higher layer is not attention for the current layer", async () => {
  const h = harness(stack([layer(), layer({ prNumber: 43, position: 1, headSha: NEXT })]), [bounce({ bounceDetail: { kind: "ci_failure", headSha: NEXT, prNumber: 43 } })]);
  await timedOut(h.options);
});

for (const [overrides, expected] of [
  [{ state: "conflict" }, "Conflict"],
  [{ draft: true }, "Draft PR"],
  [{ mergeable: false }, "Merge conflicts"],
  [{ vortexStatus: "failed" }, "Review failed"],
  [{ agentRuns: [{ agent: "tempest", status: "findings", sha: HEAD }] }, "Tempest findings"],
  [{ agentRuns: [{ agent: "tempest", status: "failed", sha: HEAD }] }, "Tempest failed"],
  [{ restackError: { kind: "push_failed", detail: "failure", headSha: HEAD, attemptedAt: "", attempts: 1, backupRef: null } }, "Restack failed"],
] as [Partial<StackLayerDto>, string][]) {
  test(`matches MCP label: ${expected}`, async () => {
    const h = harness(stack([layer(overrides)]));
    assert.equal((await pollStackWatch(cfg, "stack", h.options)).blocker, expected);
  });
}

test("held requests include response headroom and refresh the deadline snapshot", async () => {
  const h = harness();
  let enriches = 0;
  h.state.respond = (route) => {
    if (route.includes("/enrich")) {
      enriches += 1;
      if (enriches === 1) h.state.advance(25_000);
    } else if (route.includes("&wait=")) {
      h.state.advance(1_000);
      h.state.stack = stack([layer({ headSha: NEXT, mergeableHeadSha: NEXT })]);
      h.state.entries = [bounce({
        bounceDetail: { kind: "ci_failure", headSha: NEXT, failingCheck: "lint" },
        verifyHeadSha: NEXT,
      })];
    }
    return undefined;
  };
  const result = await pollStackWatch(cfg, "stack", { ...h.options, timeoutMs: 45_000 });
  assert.equal(result.status, "attention");
  assert.deepEqual(h.calls.map((call) => call.timeoutMs), [30_000, 20_000, 25_000, 5_000]);
  assert.equal(result.headSha, NEXT);
});

test("Retry-After exceeding deadline yields waiting timeout", async () => {
  const h = harness();
  h.state.respond = () => ({ status: 429, body: {}, retryAfterSeconds: 60 });
  await timedOut(h.options);
  assert.deepEqual(h.sleeps, [4000]);
  assert.equal(h.calls.length, 1);
});

test("transient retries are bounded; exhausted 429 carries rate_limited envelope", async () => {
  const h = harness();
  h.state.respond = () => ({ status: 429, body: {} });
  await assert.rejects(pollStackWatch(cfg, "stack", h.options), (err: unknown) => {
    assert.ok(err instanceof StackWatchError);
    assert.equal(err.lastEnvelope.status, "rate_limited");
    return true;
  });
  assert.deepEqual(h.sleeps, [250, 500, 1000]);
  assert.equal(h.calls.length, 4);
});

test("nontransient errors carry failed envelope; cancellation propagates", async () => {
  const h = harness();
  h.state.respond = () => ({ status: 403, body: {} });
  await assert.rejects(pollStackWatch(cfg, "stack", h.options), (err: unknown) => err instanceof StackWatchError && err.lastEnvelope.status === "failed");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pollStackWatch(cfg, "stack", { ...h.options, signal: controller.signal }), { name: "AbortError" });
});


test("apiFetch preserves HTTP Retry-After from the queue", async (t) => {
  const h = harness(stack([layer({ ciStatus: "failure" })]));
  let limited = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const queue = url.includes("/queue");
    if (queue && !limited) {
      limited = true;
      return new Response("{}", { status: 429, headers: { "Retry-After": "1" } });
    }
    return Response.json(queue ? { entries: [] } : { stacks: [h.state.stack] });
  });
  const result = await pollStackWatch(cfg, "stack", { ...h.options, fetch: undefined });
  assert.equal(result.status, "attention");
  assert.deepEqual(h.sleeps, [1000]);
});

test("one held queue GET per 45-second slice, with no polling sleep", async () => {
  const h = harness();
  h.options.timeoutMs = 45_000;
  h.state.respond = (route) => {
    if (!route.includes("/queue")) return undefined;
    const wait = new URL(route, "https://local").searchParams.get("wait");
    if (wait !== null) {
      assert.equal(wait, "45");
      h.state.advance(45_000);
    }
    return { status: 200, body: { entries: [] } };
  };
  await timedOut(h.options);
  assert.equal(h.calls.filter((call) => call.route.includes("/queue")).length, 2);
  assert.deepEqual(h.sleeps, []);
});
