import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiFetchInit, ApiFetchResult } from "./api.js";
import type { StackDto, StackLayerDto, MergeQueueEntryDto } from "./stack-dto.js";
import {
  pollStackWatch, StackWatchError, StackWatchTimeoutError,
  type PollStackWatchOptions, type StackWatchEnvelope,
} from "./stack-watch.js";
import { conflictLiveParent, conflictRepairSteps, landGateIsPending, stackBlockers, stackBlockersSummary } from "./stack-blockers.js";
import { STACK_WATCH_NOT_DONE_SENTENCE, stackTerminalReason, stackWatchObligation } from "./stack-watch-obligation.js";

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
  const { repair, watch, landGatePending, ...result } = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(landGatePending, null);
  assert.equal(repair?.kind, "ci_failure");
  assert.equal(repair?.kind === "ci_failure" ? repair.failingCheck : null, "lint");
  assert.equal(watch.done, false);
  assert.deepEqual(watch.next?.args, { stack_id: "stack", enrolled_head_sha: HEAD, timeout_s: 45 });
  assert.deepEqual(result, {
    schema: "mergestorm.stack_watch/v1", status: "attention", stackId: "stack",
    blocker: "CI failed — lint", bounceKind: null, prNumber: 42, headSha: HEAD,
    cursor: { stackId: "stack", enrolledHeadSha: HEAD },
    issues: [], currentCandidate: { prNumber: 42, headSha: HEAD }, assessment: "available", busy: [],
    actAfter: null, waitingOn: [],
    agents: { prNumber: 42, headSha: HEAD, vortexStatus: null, cycloneStatus: null, vortexReview: null,
      busy: { vortex: false, cyclone: false } },
  });
  assert.deepEqual(h.calls.map((call) => call.route), ["/api/v1/stacks/enrich?stackId=stack", "/api/v1/stacks/queue?stackId=stack"]);
  assert.deepEqual(h.sleeps, []);
});

test("draft with an empty queue returns pr_draft attention without a bounce cursor", async () => {
  const h = harness(stack([layer({ draft: true })]));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "Draft PR");
  assert.equal(result.bounceKind, "pr_draft");
  assert.deepEqual(result.cursor, { stackId: "stack", enrolledHeadSha: HEAD });
});

test("draft with a matching pr_draft bounce stamps the cursor", async () => {
  const entry = bounce({ bounceDetail: { kind: "pr_draft", headSha: HEAD, prNumber: 42 } });
  const h = harness(stack([layer({ draft: true })]), [entry]);
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "Draft PR");
  assert.equal(result.bounceKind, "pr_draft");
  assert.deepEqual(result.cursor, {
    stackId: "stack", enrolledHeadSha: HEAD, bounceId: entry.id, afterFinishedAt: entry.finishedAt,
  });
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

test("a ci_failure bounce clears once the failed check is rerun green on the same head", async () => {
  const red = { total: 2, success: 1, pending: 0, failure: 1, failingName: "Workspace tests" };
  const rerun = { total: 2, success: 1, pending: 1, failure: 0, failingName: null };
  const green = { total: 2, success: 2, pending: 0, failure: 0, failingName: null };
  const ciBounce = bounce({ bounceDetail: { kind: "ci_failure", headSha: HEAD, failingCheck: "Workspace tests" }, verifyHeadSha: HEAD });
  const atRed = stackBlockers(stack([layer({ ciStatus: "failure", checks: red })]), [ciBounce]);
  assert.equal(atRed.attention?.blocker, "CI failed — Workspace tests");
  const atRerun = stackBlockers(stack([layer({ ciStatus: "pending", checks: rerun })]), [ciBounce]);
  assert.equal(atRerun.attention?.blocker, "CI failed — Workspace tests");
  const atGreen = stackBlockers(stack([layer({ ciStatus: "success", checks: green })]), [ciBounce]);
  assert.equal(atGreen.attention, null);
  assert.equal(atGreen.repair, null);
  const h = harness(stack([layer({ ciStatus: "success", checks: green })]), [ciBounce]);
  const watched = await timedOut(h.options);
  assert.equal(watched.blocker, null);
  assert.equal(watched.repair, null);
  const batchBounce = bounce({ bounceDetail: { kind: "ci_failure", headSha: HEAD, failingCheck: "Workspace tests",
    batch: { id: "batch", withPrNumbers: [43] } }, verifyHeadSha: HEAD });
  const batched = stackBlockers(stack([layer({ ciStatus: "success", checks: green })]), [batchBounce]);
  assert.equal(batched.attention?.bounceKind, "ci_failure");
  const otherHead = stackBlockers(stack([layer({ ciStatus: "success", checks: green })]),
    [bounce({ bounceDetail: { kind: "ci_failure", headSha: NEXT, failingCheck: "lint" } })]);
  assert.equal(otherHead.attention, null);
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

test("a transport failure returns a failed envelope", async () => {
  const h = harness();
  h.options.fetch = async () => { throw new Error("connection refused"); };

  await assert.rejects(
    pollStackWatch(cfg, "stack", h.options),
    (err: unknown) => {
      assert.ok(err instanceof StackWatchError);
      assert.equal(err.lastEnvelope.status, "failed");
      assert.equal(err.lastEnvelope.assessment, "unavailable");
      return true;
    },
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
    assert.deepEqual(h.sleeps, endpoint === "queue" ? [1250] : [1250, 2000]);
    assert.equal(h.ticks[0].status, "rate_limited");
    assert.equal(
      h.calls.find((call) => call.route.includes("&wait="))?.timeoutMs,
      endpoint === "queue" ? 9000 : 8000,
    );
  });
}

for (const kind of ["head_moved", "must_consolidate"] as const) {
  test(`a recoverable bounce never suppresses current-head project CI failure: ${kind}`, async () => {
    for (const failure of [
      { ciStatus: "failure" as const },
      { checks: { total: 1, success: 0, pending: 0, failure: 1, failingName: "project tests" } },
    ]) {
      const h = harness(stack([layer(failure)]), [bounce({ bounceDetail: { kind, headSha: HEAD, prNumber: 42 }, verifyHeadSha: HEAD })]);
      const result = await pollStackWatch(cfg, "stack", h.options);
      assert.equal(result.status, "attention");
      assert.equal(result.blocker, failure.checks ? "CI failed — project tests" : "CI failed");
      assert.equal(result.prNumber, 42);
      assert.equal(result.headSha, HEAD);
      assert.equal(result.bounceKind, null);
    }
  });

  test(`${kind} without a live hard blocker remains recoverable`, async () => {
    const h = harness(stack(), [bounce({ bounceDetail: { kind, headSha: HEAD }, verifyHeadSha: HEAD })]);
    assert.equal((await timedOut(h.options)).blocker, null);
  });
}

for (const state of ["queued", "running", "waiting"] as const) {
  test(`live ${state} does not suppress gate hard blockers`, async () => {
    const h = harness(stack([layer({ ciStatus: "failure" })]), [bounce(), bounce({ id: "live", state })]);
    assert.equal((await pollStackWatch(cfg, "stack", h.options)).status, "attention");
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

test("a Cyclone failure on the head is attention, after red CI and before Tempest", async () => {
  const failed = { agent: "cyclone" as const, status: "failed" as const, sha: HEAD };
  const named = harness(stack([layer({
    agentRuns: [failed, { agent: "tempest", status: "findings", sha: HEAD }],
  })]));
  const result = await pollStackWatch(cfg, "stack", named.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "Cyclone failed");
  assert.equal(result.prNumber, 42);
  const red = harness(stack([layer({ ciStatus: "failure", agentRuns: [failed] })]));
  assert.equal((await pollStackWatch(cfg, "stack", red.options)).blocker, "CI failed");
  const stale = harness(stack([layer({ agentRuns: [{ ...failed, sha: NEXT }] })]));
  assert.equal((await timedOut(stale.options)).blocker, null);
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

test("bounce only on a non-child higher layer is not attention for the current layer", async () => {
  const h = harness(stack([
    layer(),
    layer({ prNumber: 43, position: 1, branch: "child", parentBranch: "feature" }),
    layer({ prNumber: 44, position: 2, parentBranch: "child", headSha: NEXT }),
  ]), [bounce({ bounceDetail: { kind: "ci_failure", headSha: NEXT, prNumber: 44 } })]);
  const result = await timedOut(h.options);
  assert.equal(result.blocker, null);
  assert.deepEqual(result.issues, []);
});

test("conflicted non-adjacent child is attention naming its PR and head", async () => {
  const h = harness(stack([
    layer(),
    layer({ prNumber: 43, position: 1, branch: "middle", parentBranch: "feature" }),
    layer({ prNumber: 44, position: 2, parentBranch: "feature", headSha: NEXT, state: "conflict" }),
  ]));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "Conflict");
  assert.equal(result.prNumber, 44);
  assert.equal(result.headSha, NEXT);
  assert.deepEqual(result.issues, []);
});

for (const conflict of [
  { state: "conflict" as const },
  { restackError: { kind: "rebase_conflict" as const, detail: "conflict", headSha: NEXT, attemptedAt: "", attempts: 1, backupRef: null } },
]) {
  test(`conflicted direct child is attention naming its PR and head: ${conflict.state ?? conflict.restackError.kind}`, async () => {
    const h = harness(stack([
      layer(),
      layer({ prNumber: 43, position: 1, parentBranch: "feature", headSha: NEXT, ...conflict }),
    ]));
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "attention");
    assert.equal(result.blocker, "Conflict");
    assert.equal(result.prNumber, 43);
    assert.equal(result.headSha, NEXT);
    assert.deepEqual(result.currentCandidate, { prNumber: 42, headSha: HEAD });
    assert.deepEqual(result.issues, []);
  });
}

for (const [overrides, expected] of [
  [{ state: "conflict" }, "Conflict"],
  [{ draft: true }, "Draft PR"],
  [{ mergeable: false }, "Merge conflicts vs main"],
  [{ vortexStatus: "failed" }, "Review failed"],
  [{ agentRuns: [{ agent: "cyclone", status: "failed", sha: HEAD }] }, "Cyclone failed"],
  [{ agentRuns: [{ agent: "tempest", status: "findings", sha: HEAD }] }, "Tempest findings"],
  [{ agentRuns: [{ agent: "tempest", status: "failed", sha: HEAD }] }, "Tempest failed"],
  [{ restackError: { kind: "push_failed", detail: "failure", headSha: HEAD, attemptedAt: "", attempts: 1, backupRef: null } }, "Restack failed"],
  [{ restackError: { kind: "push_failed", detail: "force-push failed: ! [remote rejected] b -> b (failure)", headSha: HEAD, attemptedAt: "", attempts: 3, backupRef: null } }, "Restack failed"],
  [{ restackError: { kind: "checkout_failed", detail: "failure", headSha: HEAD, attemptedAt: "", attempts: 1, backupRef: null } }, "Restack failed"],
  [{ restackError: { kind: "head_unresolved", detail: "failure", headSha: HEAD, attemptedAt: "", attempts: 1, backupRef: null } }, "Restack failed"],
] as [Partial<StackLayerDto>, string][]) {
  test(`matches MCP label: ${expected}`, async () => {
    const h = harness(stack([layer(overrides)]));
    assert.equal((await pollStackWatch(cfg, "stack", h.options)).blocker, expected);
  });
}

for (const attempts of [1, 2]) {
  test(`a retryable push failure at attempt ${attempts} is not a hard block`, async () => {
    const h = harness(stack([layer({ state: "needs_restack", restackError: {
      kind: "push_failed", detail: "force-push failed: ! [remote rejected] b -> b (failure)",
      headSha: HEAD, attemptedAt: "", attempts, backupRef: null,
    } })]));
    await assert.rejects(
      pollStackWatch(cfg, "stack", h.options),
      (err: unknown) => err instanceof StackWatchTimeoutError && err.lastEnvelope.blocker === null,
    );
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

for (const endpoint of ["snapshot", "queue"]) {
  test(`Retry-After exceeding deadline preserves rate_limited and retry delay: ${endpoint}`, async () => {
    const h = harness();
    h.state.respond = (route) => (endpoint === "snapshot" || route.includes("&wait="))
      ? { status: 429, body: {}, retryAfterSeconds: 60 }
      : undefined;
    await assert.rejects(pollStackWatch(cfg, "stack", h.options), (err: unknown) => {
      assert.ok(err instanceof StackWatchError);
      assert.equal(err.lastEnvelope.status, "rate_limited");
      assert.equal(err.lastEnvelope.assessment, "unavailable");
      assert.equal(err.retryAfterSeconds, 60);
      return true;
    });
    assert.deepEqual(h.sleeps, []);
    assert.equal(h.calls.length, endpoint === "snapshot" ? 1 : 3);
  });
}

test("transient retries are bounded; exhausted 429 carries rate_limited envelope", async () => {
  const h = harness();
  h.state.respond = () => ({ status: 429, body: {} });
  await assert.rejects(pollStackWatch(cfg, "stack", h.options), (err: unknown) => {
    assert.ok(err instanceof StackWatchError);
    assert.equal(err.lastEnvelope.status, "rate_limited");
    assert.equal(err.lastEnvelope.assessment, "unavailable");
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

for (const honorsSeen of [false, true]) {
  test(`an unchanged bounced row ${honorsSeen ? "held by the server" : "answered instantly"} bounds enrich calls in one 45s slice`, async () => {
    const h = harness(stack(), [bounce()]);
    h.state.respond = (route) => {
      if (!route.includes("/queue")) return undefined;
      const params = new URL(route, "https://local").searchParams;
      if (params.get("wait") !== null) {
        assert.equal(params.get("seen"), "fp-bounce");
        if (honorsSeen) {
          h.state.advance(Number(params.get("wait")) * 1000);
          h.state.stack = stack([layer({ ciStatus: "failure" })]);
        }
      }
      return { status: 200, body: { entries: [bounce()], fingerprint: "fp-bounce" } };
    };
    const options = { ...h.options, timeoutMs: 45_000, cursor: { stackId: "stack", enrolledHeadSha: HEAD, bounceId: "bounce" } };
    const result = honorsSeen ? await pollStackWatch(cfg, "stack", options) : await timedOut(options);
    const enriches = h.calls.filter((call) => call.route.includes("/enrich")).length;
    const held = h.calls.filter((call) => call.route.includes("&wait=")).length;
    if (honorsSeen) {
      assert.equal(result.blocker, "CI failed");
      assert.equal(enriches, 2);
      assert.equal(held, 1);
      assert.deepEqual(h.sleeps, []);
    } else {
      assert.equal(result.blocker, null);
      assert.equal(enriches, 1 + Math.ceil(45_000 / 2_000));
      assert.equal(held, Math.ceil(45_000 / 2_000));
      assert.ok(h.sleeps.every((ms) => ms > 0 && ms <= 2_000));
    }
  });
}

test("a changed held queue snapshot is evaluated without a polling pause", async () => {
  const h = harness(stack(), [bounce({ state: "running" })]);
  h.state.respond = (route) => {
    if (!route.includes("&wait=")) return undefined;
    h.state.entries = [bounce()];
    return undefined;
  };
  const result = await pollStackWatch(cfg, "stack", { ...h.options, timeoutMs: 45_000 });
  assert.equal(result.status, "attention");
  assert.deepEqual(h.sleeps, []);
  assert.ok(h.calls.filter((call) => call.route.includes("&wait=")).every((call) => !call.route.includes("&seen=")));
});

function organism() {
  return stack([
    layer({ prNumber: 41, branch: "feat/cowork-authors" }),
    layer({ prNumber: 42, position: 1, branch: "child", parentBranch: "feat/cowork-authors",
      headSha: NEXT, mergeableHeadSha: NEXT, mergeable: false, mergeableState: "dirty" }),
    ...[43, 44, 45].map((prNumber) => layer({ prNumber, position: prNumber - 41,
      parentBranch: "mg-park-freeze", mergeable: false, mergeableState: "dirty", lastRestackedSha: HEAD,
      ciStatus: prNumber === 45 ? "failure" : "success", vortexStatus: prNumber === 44 ? "throttled" : null })),
  ]);
}

test("Organism pair gate names #42 and preserves parked #45 CI", async () => {
  const h = harness(organism());
  const result = await pollStackWatch(cfg, "stack", { ...h.options, timeoutMs: 0 });
  assert.equal(result.status, "attention");
  assert.equal(result.prNumber, 42);
  assert.equal(result.headSha, NEXT);
  assert.equal(result.blocker, "Merge conflicts vs feat/cowork-authors");
  assert.deepEqual(result.currentCandidate, { prNumber: 41, headSha: HEAD });
  assert.deepEqual(result.issues, [{ prNumber: 45, headSha: HEAD, blocker: "CI failed", bounceKind: null }]);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => !call.route.includes("&wait=")));
});

test("Organism pair gate preserves a headless child head", async () => {
  const fixture = organism();
  fixture.layers[1].headSha = null;
  const h = harness(fixture);
  const result = await pollStackWatch(cfg, "stack", { ...h.options, timeoutMs: 0 });
  assert.equal(result.status, "attention");
  assert.equal(result.prNumber, 42);
  assert.equal(result.headSha, null);
  assert.equal(result.blocker, "Merge conflicts vs feat/cowork-authors");
});

for (const scenario of ["stale", "pending", "different-parent", "parked-bottom"] as const) {
  test(`${scenario} does not produce pair-gate attention`, async () => {
    const fixture = organism();
    fixture.layers = fixture.layers.slice(0, 2);
    if (scenario === "stale") fixture.layers[1].mergeableHeadSha = HEAD;
    if (scenario === "pending") Object.assign(fixture.layers[1], { mergeable: true, mergeableState: "clean", ciStatus: "pending" });
    if (scenario === "different-parent") fixture.layers[1].parentBranch = "other";
    if (scenario === "parked-bottom") fixture.layers = [layer({ parentBranch: "mg-park-freeze", lastRestackedSha: "old", mergeable: false, mergeableState: "dirty" })];
    const h = harness(fixture);
    const result = await pollStackWatch(cfg, "stack", { ...h.options, timeoutMs: 0 });
    assert.equal(result.status, "waiting");
    assert.equal(result.blocker, null);
    assert.equal(result.assessment, "available");
    assert.equal(result.issues.length, scenario === "different-parent" ? 1 : 0);
    assert.equal(h.calls.length, 2);
  });
}

for (const live of [false, true]) {
  test(`issues survive ${live ? "live queue" : "waiting"}`, async () => {
    const fixture = organism();
    Object.assign(fixture.layers[1], { mergeable: true, mergeableState: "clean" });
    const h = harness(fixture, live ? [bounce({ state: "running" })] : []);
    const result = await pollStackWatch(cfg, "stack", { ...h.options, timeoutMs: 0 });
    assert.equal(result.status, live ? "in_progress" : "waiting");
    assert.deepEqual(result.issues.map(issue => issue.prNumber), [45]);
  });
}

test("zero timeout with an unread snapshot stays unavailable and never waiting", async () => {
  const h = harness();
  h.state.respond = () => ({ status: 403, body: {} });
  await assert.rejects(pollStackWatch(cfg, "stack", { ...h.options, timeoutMs: 0 }), (err: unknown) => {
    assert.ok(err instanceof StackWatchError);
    assert.equal(err.lastEnvelope.status, "failed");
    assert.equal(err.lastEnvelope.assessment, "unavailable");
    assert.deepEqual(err.lastEnvelope.issues, []);
    return true;
  });
});

test("zero timeout transport error on an unread snapshot stays unavailable and never waiting", async () => {
  const h = harness();
  h.options.fetch = async () => { throw new Error("network unavailable"); };
  await assert.rejects(pollStackWatch(cfg, "stack", { ...h.options, timeoutMs: 0 }), (err: unknown) => {
    assert.ok(err instanceof StackWatchError);
    assert.equal(err.lastEnvelope.status, "failed");
    assert.equal(err.lastEnvelope.assessment, "unavailable");
    return true;
  });
});

for (const state of ["queued", "running", "waiting", null] as const) {
  test(`zero timeout assesses ${state ?? "quiet"} queue as ${state ? "in_progress" : "waiting"}`, async () => {
    const h = harness(stack(), state ? [bounce({ state })] : []);
    const result = await pollStackWatch(cfg, "stack", { ...h.options, timeoutMs: 0 });
    assert.equal(result.status, state ? "in_progress" : "waiting");
    assert.equal(result.assessment, "available");
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(call => !call.route.includes("&wait=")));
    assert.deepEqual(h.sleeps, []);
  });
}

test("deadline before the first snapshot stays unavailable and never waiting", async () => {
  const h = harness();
  let time = 0;
  await assert.rejects(pollStackWatch(cfg, "stack", { ...h.options, now: () => time++ * 4000 }), (err: unknown) => {
    assert.ok(err instanceof StackWatchTimeoutError);
    assert.equal(err.lastEnvelope.status, "failed");
    assert.equal(err.lastEnvelope.assessment, "unavailable");
    return true;
  });
  assert.equal(h.calls.length, 0);
});

test("degraded mid-wait snapshot invalidates the previous assessment", async () => {
  const h = harness(stack([
    layer(),
    layer({ prNumber: 43, position: 1, ciStatus: "failure" }),
  ]));
  h.state.respond = (route) => route.includes("&wait=")
    ? { status: 200, body: {} }
    : undefined;
  await assert.rejects(pollStackWatch(cfg, "stack", h.options), (err: unknown) => {
    assert.ok(err instanceof StackWatchError);
    assert.equal(err.lastEnvelope.status, "failed");
    assert.equal(err.lastEnvelope.assessment, "unavailable");
    assert.deepEqual(err.lastEnvelope.issues.map((issue) => issue.prNumber), [43]);
    return true;
  });
});

test("a missing stack clears live work from the last poll", async () => {
  const h = harness(unitStack([
    layer({ ...redCi, cycloneStatus: "patching", agentRuns: [{ agent: "cyclone", status: "patching", sha: HEAD }] }),
    layer({ prNumber: 43, position: 1, ciStatus: "failure" }),
  ], { landPrNumber: 43, landingBlockReason: "ci_pending: settling idle project checks" }));
  const live = stackBlockers(h.state.stack);
  assert.ok(live.currentCandidate);
  assert.ok(live.agents);
  assert.ok(live.landGatePending);
  let missing = false;
  h.state.respond = (route) => {
    if (route.includes("&wait=")) missing = true;
    if (missing && route.includes("/enrich")) return { status: 200, body: { stacks: [] } };
    return undefined;
  };
  await assert.rejects(pollStackWatch(cfg, "stack", h.options), (err: unknown) => {
    assert.ok(err instanceof StackWatchError);
    assert.equal(err.lastEnvelope.watch.done, true);
    assert.equal(err.lastEnvelope.watch.reason, "not_found");
    assert.equal(err.lastEnvelope.status, "failed");
    assert.equal(err.lastEnvelope.assessment, "unavailable");
    assert.equal(err.lastEnvelope.blocker, null);
    assert.deepEqual(err.lastEnvelope.issues, []);
    assert.deepEqual(err.lastEnvelope.busy, []);
    assert.equal(err.lastEnvelope.prNumber, null);
    assert.equal(err.lastEnvelope.headSha, null);
    assert.equal(err.lastEnvelope.agents, null);
    assert.equal(err.lastEnvelope.currentCandidate, null);
    assert.equal(err.lastEnvelope.landGatePending, null);
    return true;
  });
});

test("live queue timeout retains in_progress and upstack issues", async () => {
  const h = harness(stack([layer(), layer({ prNumber: 43, position: 1, ciStatus: "failure" })]), [bounce({ state: "running" })]);
  await assert.rejects(pollStackWatch(cfg, "stack", h.options), (err: unknown) => {
    assert.ok(err instanceof StackWatchTimeoutError);
    assert.equal(err.lastEnvelope.status, "in_progress");
    assert.deepEqual(err.lastEnvelope.issues.map(issue => issue.prNumber), [43]);
    return true;
  });
});

test("recoverable bounce cannot suppress another PR sharing its SHA", async () => {
  const h = harness(stack([layer({ ciStatus: "failure" }), layer({ prNumber: 43, position: 1 })]),
    [bounce({ bounceDetail: { kind: "head_moved", headSha: HEAD, prNumber: 43 } })]);
  assert.equal((await pollStackWatch(cfg, "stack", h.options)).blocker, "CI failed");
});

async function heldInProgress(options: PollStackWatchOptions): Promise<StackWatchEnvelope> {
  try { await pollStackWatch(cfg, "stack", options); }
  catch (err) {
    assert.ok(err instanceof StackWatchTimeoutError);
    assert.equal(err.lastEnvelope.status, "in_progress");
    return err.lastEnvelope;
  }
  assert.fail("Expected in_progress timeout");
}

const redCi = { ciStatus: "failure" as const, checks: { total: 1, success: 0, pending: 0, failure: 1, failingName: "lint" } };
const reviewing = (head: string) => ({
  status: "reviewing" as const, skip_reason: null, pass: 2, head_sha: head, phase: null,
  started_at: null, stoppable: true, source: "pr_reviews" as const,
});
const done = (head: string) => ({ ...reviewing(head), status: "done" as const, stoppable: false });

test("CI red while Cyclone patches is in_progress naming the busy agent, never attention", async () => {
  const h = harness(stack([layer({ ...redCi, cycloneStatus: "patching",
    agentRuns: [{ agent: "cyclone", status: "patching", sha: NEXT }] })]));
  const result = await heldInProgress(h.options);
  assert.equal(result.blocker, null);
  assert.equal(result.prNumber, 42);
  assert.equal(result.headSha, HEAD);
  assert.deepEqual(result.busy, [{ prNumber: 42, headSha: HEAD, agent: "cyclone", blocker: "CI failed — lint" }]);
  assert.equal(result.agents?.cycloneStatus, "patching");
  assert.deepEqual(result.agents?.busy, { vortex: false, cyclone: true });
});

test("CI red while Vortex reviews the current head is in_progress", async () => {
  const h = harness(stack([layer({ ...redCi, vortexStatus: "reviewing", vortexReview: reviewing(HEAD),
    agentRuns: [{ agent: "vortex", status: "reviewing", sha: HEAD }] })]));
  const result = await heldInProgress(h.options);
  assert.deepEqual(result.busy.map((entry) => entry.agent), ["vortex"]);
  assert.deepEqual(result.agents?.vortexReview, { status: "reviewing", headSha: HEAD, pass: 2 });
});

test("a Vortex run with an unknown SHA does not hold a CI blocker", async () => {
  const h = harness(stack([layer({ ...redCi, vortexStatus: "reviewing",
    agentRuns: [{ agent: "vortex", status: "reviewing", sha: null }] })]));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "CI failed — lint");
  assert.deepEqual(result.busy, []);
});

test("Vortex still reviewing an older head does not hold attention on the current head", async () => {
  const h = harness(stack([layer({ ...redCi, vortexStatus: "reviewing", vortexReview: done(HEAD),
    agentRuns: [{ agent: "vortex", status: "reviewing", sha: NEXT }] })]));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "CI failed — lint");
  assert.deepEqual(result.busy, []);
  assert.deepEqual(result.agents?.busy, { vortex: false, cyclone: false });
});

test("finished agent runs and resting statuses leave attention", async () => {
  const h = harness(stack([layer({ ...redCi, vortexStatus: "findings", cycloneStatus: "awaiting_fix", vortexReview: done(HEAD),
    agentRuns: [
      { agent: "vortex", status: "reviewing", sha: HEAD, finishedAt: "2026-01-01T00:00:00Z" },
      { agent: "cyclone", status: "patching", sha: HEAD, finishedAt: "2026-01-01T00:00:00Z" },
    ] })]));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
});

test("seam_pending, a legacy queued rollup, and a stale or untimed queued dispatch never hold attention", async () => {
  const queuedView = { ...reviewing(HEAD), status: "queued" as const, stoppable: false };
  for (const extra of [
    { vortexStatus: "seam_pending" as const, agentRuns: [] },
    { vortexStatus: "seam_pending" as const },
    { vortexStatus: "queued" as const },
    { vortexStatus: "queued" as const, vortexReview: queuedView,
      agentRuns: [{ agent: "vortex" as const, status: "queued", sha: HEAD, startedAt: new Date(Date.now() - 16 * 60_000).toISOString() }] },
    { vortexStatus: "queued" as const, vortexReview: queuedView,
      agentRuns: [{ agent: "vortex" as const, status: "queued", sha: null }] },
  ]) {
    const h = harness(stack([layer({ ...redCi, ...extra })]));
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "attention", JSON.stringify(extra));
  }
});

test("a fresh queued Vortex dispatch on the current head holds attention", async () => {
  const h = harness(stack([layer({ ...redCi, vortexStatus: "queued",
    agentRuns: [{ agent: "vortex", status: "queued", sha: HEAD, startedAt: new Date(Date.now() - 60_000).toISOString() }] })]));
  const result = await heldInProgress(h.options);
  assert.deepEqual(result.busy.map((entry) => entry.agent), ["vortex"]);
});

test("the server agentsBusy field is authoritative over the client fallback", async () => {
  const claimed = harness(stack([layer({ ...redCi, agentsBusy: { vortex: false, cyclone: true, headSha: HEAD } })]));
  const held = await heldInProgress(claimed.options);
  assert.deepEqual(held.busy.map((entry) => entry.agent), ["cyclone"]);
  const idle = harness(stack([layer({ ...redCi, cycloneStatus: "patching", agentsBusy: { vortex: false, cyclone: false, headSha: HEAD } })]));
  assert.equal((await pollStackWatch(cfg, "stack", idle.options)).status, "attention");
});

test("a held bounce wakes within one busy recheck once the agent finishes, then stamps the cursor", async () => {
  const h = harness(stack([layer({ cycloneStatus: "patching", agentRuns: [{ agent: "cyclone", status: "patching", sha: HEAD }] })]), [bounce()]);
  const waits: string[] = [];
  h.state.respond = (route) => {
    if (!route.includes("/queue")) return undefined;
    const wait = new URL(route, "https://local").searchParams.get("wait");
    if (wait !== null) {
      waits.push(wait);
      h.state.advance(Number(wait) * 1000);
      h.state.stack = stack([layer({ cycloneStatus: null, agentRuns: [] })]);
    }
    return { status: 200, body: { entries: [bounce()], fingerprint: "fp-bounce" } };
  };
  const result = await pollStackWatch(cfg, "stack", { ...h.options, timeoutMs: 45_000 });
  assert.deepEqual(waits, ["15"]);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "CI failed — lint");
  assert.deepEqual(result.busy, []);
  assert.deepEqual(result.cursor, {
    stackId: "stack", enrolledHeadSha: HEAD, bounceId: "bounce", afterFinishedAt: "2026-01-01T00:01:00Z",
  });
});

test("a busy hold never stamps the bounce into the cursor", async () => {
  const h = harness(stack([layer({ cycloneStatus: "patching" })]), [bounce()]);
  const result = await heldInProgress(h.options);
  assert.deepEqual(result.cursor, { stackId: "stack", enrolledHeadSha: HEAD });
  assert.deepEqual(result.busy.map((entry) => entry.blocker), ["CI failed — lint"]);
});

const dirtyMain = { mergeable: false, mergeableState: "dirty" };
const vortexBusy = { vortexStatus: "reviewing" as const, vortexReview: reviewing(HEAD),
  agentRuns: [{ agent: "vortex" as const, status: "reviewing", sha: HEAD }] };

test("a merge conflict while Vortex reviews is in_progress with the blocker named for after the agents", async () => {
  const h = harness(stack([layer({ ...dirtyMain, ...vortexBusy })]));
  const result = await heldInProgress(h.options);
  assert.equal(result.blocker, "Merge conflicts vs main");
  assert.equal(result.prNumber, 42);
  assert.equal(result.headSha, HEAD);
  assert.equal(result.actAfter, "agents_idle");
  assert.deepEqual(result.waitingOn, ["vortex"]);
  assert.deepEqual(result.issues, [{ prNumber: 42, headSha: HEAD, blocker: "Merge conflicts vs main", bounceKind: null }]);
  assert.deepEqual(result.busy, [{ prNumber: 42, headSha: HEAD, agent: "vortex", blocker: "Merge conflicts vs main" }]);
  assert.equal(result.repair?.kind, "merge_conflict");
  assert.equal(result.watch.done, false);
});

test("restack conflicts, a failed restack and Draft are named while Cyclone patches", async () => {
  const cases: [Partial<StackLayerDto>, string][] = [
    [{ state: "conflict" }, "Conflict"],
    [{ restackError: { kind: "rebase_conflict", detail: "conflict in a.ts", headSha: HEAD, attemptedAt: "2026-01-01T00:00:00Z", attempts: 1, backupRef: null } }, "Conflict"],
    [{ restackError: { kind: "push_failed", detail: "stale info", headSha: HEAD, attemptedAt: "2026-01-01T00:00:00Z", attempts: 3, backupRef: null } }, "Restack failed"],
    [{ draft: true }, "Draft PR"],
  ];
  for (const [extra, blocker] of cases) {
    const h = harness(stack([layer({ ...extra, cycloneStatus: "patching", agentRuns: [{ agent: "cyclone", status: "patching", sha: HEAD }] })]));
    const result = await heldInProgress(h.options);
    assert.equal(result.blocker, blocker, JSON.stringify(extra));
    assert.equal(result.actAfter, "agents_idle");
    assert.deepEqual(result.waitingOn, ["cyclone"]);
  }
});

test("blockers the agents can clear keep the silent hold", async () => {
  const h = harness(stack([layer({ ...redCi, ...vortexBusy })]));
  const result = await heldInProgress(h.options);
  assert.equal(result.blocker, null);
  assert.equal(result.actAfter, null);
  assert.deepEqual(result.waitingOn, []);
  assert.deepEqual(result.issues, []);
  assert.equal(result.repair, null);
});

test("a named merge conflict flips to attention on the first idle snapshot", async () => {
  const h = harness(stack([layer({ ...dirtyMain, ...vortexBusy })]));
  const ticks: StackWatchEnvelope[] = [];
  h.state.respond = (route) => {
    if (!route.includes("/queue")) return undefined;
    const wait = new URL(route, "https://local").searchParams.get("wait");
    if (wait !== null) {
      h.state.advance(Number(wait) * 1000);
      h.state.stack = stack([layer({ ...dirtyMain, vortexStatus: "findings", vortexReview: done(HEAD), agentRuns: [] })]);
    }
    return { status: 200, body: { entries: [], fingerprint: "fp" } };
  };
  const result = await pollStackWatch(cfg, "stack", { ...h.options, timeoutMs: 45_000, onTick: (tick) => ticks.push(tick) });
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "Merge conflicts vs main");
  assert.equal(result.actAfter, null);
  assert.deepEqual(result.waitingOn, []);
  assert.deepEqual(result.issues, []);
  assert.equal(result.repair?.kind, "merge_conflict");
});

test("the summary tells the watcher to act on a held blocker only after the agents", () => {
  const held = stackBlockers(stack([layer({ ...dirtyMain, ...vortexBusy, cycloneStatus: "patching",
    agentRuns: [{ agent: "vortex", status: "reviewing", sha: HEAD }, { agent: "cyclone", status: "patching", sha: HEAD }] })]));
  assert.equal(held.attention, null);
  assert.deepEqual(held.held?.waitingOn, ["cyclone", "vortex"]);
  assert.equal(stackBlockersSummary(held.held, held.issues, held.busy, null, held.held?.actAfter ?? null),
    " · blocked after the agents: #42 Merge conflicts vs main (plan the fix; act once Cyclone patches and Vortex reviews finish and the watch returns attention)");
});

type UnitMember = NonNullable<StackDto["unit"]>["members"][number];
function seamUnit(target: StackDto, seamState: string, seamReviewedSha: string | null,
  promoted: UnitMember[] = [{ prNumber: 41, promotedHeadSha: "promoted", promotedAt: "2026-09-27T00:28:09Z", seamState: "none", seamReviewedSha: null } as UnitMember]): StackDto {
  target.unit = {
    id: "unit", uNumber: 77, state: "growing", branch: "unit", landTarget: "main", landPrNumber: 50,
    tempestLandStatus: null, landingBlockReason: null, landPr: null,
    members: [...promoted, { prNumber: 42, promotedHeadSha: null, promotedAt: "2026-09-27T00:28:21Z", seamState, seamReviewedSha } as UnitMember],
  };
  return target;
}

test("seam findings at the current head are attention on that member", async () => {
  const h = harness(seamUnit(stack(), "findings", HEAD));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "Seam findings");
  assert.equal(result.bounceKind, null);
  assert.equal(result.prNumber, 42);
  assert.equal(result.headSha, HEAD);
  assert.deepEqual(result.cursor, { stackId: "stack", enrolledHeadSha: HEAD });
});

test("seam findings reviewed at an abbreviated head still block", async () => {
  const h = harness(seamUnit(stack(), "findings", HEAD.slice(0, 7).toUpperCase()));
  assert.equal((await pollStackWatch(cfg, "stack", h.options)).blocker, "Seam findings");
});

test("a failed seam review is attention whatever head it last reviewed", async () => {
  for (const reviewed of [null, NEXT, HEAD]) {
    const h = harness(seamUnit(stack(), "failed", reviewed));
    assert.equal((await pollStackWatch(cfg, "stack", h.options)).blocker, "Seam review failed", String(reviewed));
  }
});

test("seam findings on a stale head wait for the re-review", async () => {
  for (const reviewed of [NEXT, null]) {
    const h = harness(seamUnit(stack(), "findings", reviewed));
    const result = await timedOut(h.options);
    assert.equal(result.blocker, null);
    assert.deepEqual(result.issues, []);
  }
});

for (const seamState of ["approved", "none", "reviewing", "pending_rereview"]) {
  test(`seam ${seamState} is not a blocker`, async () => {
    const h = harness(seamUnit(stack(), seamState, HEAD));
    assert.equal((await timedOut(h.options)).blocker, null);
  });
}

test("a pending seam with no review running is attention on that member", async () => {
  const h = harness(seamUnit(stack(), "pending", null));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "Seam review pending, no review running");
  assert.equal(result.prNumber, 42);
  assert.equal(result.headSha, HEAD);
});

const quotaSkipped = { status: "skipped", skip_reason: "quota_exceeded", pass: 1, head_sha: HEAD, phase: null,
  started_at: null, stoppable: false, source: "pr_reviews" } as const;

test("a quota-skipped Vortex review at the candidate head is attention no agent can clear", async () => {
  const h = harness(stack([layer({ vortexStatus: "skipped", vortexReview: quotaSkipped })]));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "Review skipped, out of review quota");
  assert.equal(result.prNumber, 42);
  assert.equal(result.headSha, HEAD);
});

test("a quota-skipped review stays named while Cyclone patches the PR", async () => {
  const h = harness(stack([layer({ vortexStatus: "skipped", vortexReview: quotaSkipped, cycloneStatus: "patching",
    agentRuns: [{ agent: "cyclone", status: "patching", sha: HEAD }] })]));
  const result = await heldInProgress(h.options);
  assert.equal(result.blocker, "Review skipped, out of review quota");
  assert.equal(result.actAfter, "agents_idle");
});

test("other skip reasons and a quota skip at an older head are not blockers", () => {
  for (const review of [{ ...quotaSkipped, skip_reason: "auto_review_off" }, { ...quotaSkipped, head_sha: NEXT },
    { ...quotaSkipped, status: "reviewing" }] as const) {
    assert.equal(stackBlockers(stack([layer({ vortexReview: review })])).attention, null, JSON.stringify(review));
  }
});

test("a pending seam while its review runs is not a blocker", () => {
  const blockers = stackBlockers(seamUnit(stack([layer(vortexBusy)]), "pending", null));
  assert.equal(blockers.attention, null);
  assert.equal(blockers.held, null);
  assert.deepEqual(blockers.issues, []);
});

test("a pending seam with no review running stays named while Cyclone patches the PR", async () => {
  const h = harness(seamUnit(stack([layer({ cycloneStatus: "patching",
    agentRuns: [{ agent: "cyclone", status: "patching", sha: HEAD }] })]), "pending", null));
  const result = await heldInProgress(h.options);
  assert.equal(result.blocker, "Seam review pending, no review running");
  assert.equal(result.actAfter, "agents_idle");
  assert.deepEqual(result.waitingOn, ["cyclone"]);
});

test("seam findings before any member is promoted do not gate promotion", async () => {
  const h = harness(seamUnit(stack(), "findings", HEAD, []));
  assert.equal((await timedOut(h.options)).blocker, null);
});

test("seam findings on an already promoted member are not a blocker", async () => {
  const target = seamUnit(stack(), "findings", HEAD);
  target.unit!.members[1] = { ...target.unit!.members[1]!, promotedHeadSha: HEAD };
  const h = harness(target);
  assert.equal((await timedOut(h.options)).blocker, null);
});

test("seam findings on an upstack member are an issue behind the candidate", async () => {
  const target = seamUnit(stack([layer(), layer({ prNumber: 43, position: 1, branch: "upper", parentBranch: "feature", headSha: NEXT })]), "none", null);
  target.unit!.members.push({ prNumber: 43, promotedHeadSha: null, promotedAt: "2026-09-27T00:28:21Z", seamState: "findings", seamReviewedSha: NEXT } as UnitMember);
  const h = harness(target);
  const result = await timedOut(h.options);
  assert.equal(result.blocker, null);
  assert.deepEqual(result.issues, [{ prNumber: 43, headSha: NEXT, blocker: "Seam findings", bounceKind: null }]);
});

test("seam findings while Vortex re-reviews the seam hold as in_progress", async () => {
  const h = harness(seamUnit(stack([layer({ vortexStatus: "reviewing",
    agentRuns: [{ agent: "vortex", status: "reviewing", sha: HEAD }] })]), "findings", HEAD));
  const result = await heldInProgress(h.options);
  assert.equal(result.blocker, null);
  assert.deepEqual(result.busy, [{ prNumber: 42, headSha: HEAD, agent: "vortex", blocker: "Seam findings" }]);
});

test("a live seam finding outranks a seam_findings bounce without stamping the cursor", async () => {
  const entry = bounce({ bounceDetail: { kind: "seam_findings", headSha: HEAD, prNumber: 42 } });
  const h = harness(seamUnit(stack(), "findings", HEAD), [entry]);
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.blocker, "Seam findings");
  assert.deepEqual(result.cursor, { stackId: "stack", enrolledHeadSha: HEAD });
});

function unitStack(layers: StackLayerDto[], unit: Partial<NonNullable<StackDto["unit"]>> = {}): StackDto {
  return {
    ...stack(layers), trunkBranch: "mg-stack-79",
    unit: {
      id: "unit", uNumber: 79, state: "growing", branch: "mg-stack-79", landTarget: "main", members: [],
      landPrNumber: null, tempestLandStatus: null, landingBlockReason: null, landPr: null, ...unit,
    },
  };
}

test("terminal states: only merged/closed layers with a landed, abandoned, or absent unit end the watch", () => {
  const merged = layer({ state: "merged" });
  const closed = layer({ state: "closed", prNumber: 43, position: 1 });
  assert.equal(stackTerminalReason(null), "not_found");
  assert.equal(stackTerminalReason({ ...stack(), archivedAt: "2026-09-28T00:00:00Z" }), "archived");
  assert.equal(stackTerminalReason(stack([merged])), "landed");
  assert.equal(stackTerminalReason(unitStack([merged], { state: "landed" })), "landed");
  assert.equal(stackTerminalReason(stack([merged, closed])), "closed");
  assert.equal(stackTerminalReason(unitStack([merged], { state: "abandoned" })), "closed");
  assert.equal(stackTerminalReason(stack([layer()])), null);
  assert.equal(stackTerminalReason(stack([layer({ prNumber: 0 })])), null);
  assert.equal(stackTerminalReason(stack([])), null);
  assert.equal(stackTerminalReason(stack([merged, layer({ prNumber: 43, position: 1, state: "conflict" })])), null);
  for (const state of ["open", "growing", "stale", "landing"]) {
    assert.equal(stackTerminalReason(unitStack([merged], { state })), null, state);
  }
  assert.equal(stackTerminalReason(unitStack([merged], { state: "landed", landPrNumber: 90,
    landPr: layer({ prNumber: 90, branch: "mg-land-79" }) })), null);
});

test("the obligation: not-done sentence first, exact next call, done only for terminal reasons", () => {
  const open = stackWatchObligation({ stackId: "stack", terminal: null,
    cursor: { enrolledHeadSha: HEAD, afterFinishedAt: null, bounceId: "b1" }, status: "waiting" });
  assert.equal(open.done, false);
  assert.equal(open.until, "landed");
  assert.equal(open.reason, "open");
  assert.ok(open.message.startsWith(STACK_WATCH_NOT_DONE_SENTENCE));
  assert.match(open.message, /A clean push, a submit, or one merged layer does not finish it/);
  assert.deepEqual(open.next, { tool: "stack_wait", command: "mg stack wait stack --json", background: "mg stack watch stack",
    args: { stack_id: "stack", enrolled_head_sha: HEAD, after_finished_at: null, bounce_id: "b1", timeout_s: 45 } });
  assert.match(open.message, /If you cannot hold a long turn open, run `mg stack watch stack` as a background command instead, notify on output matching MS-WATCH \(ATTENTION\|LANDED\), and end your turn/);
  const attention = stackWatchObligation({ stackId: "stack", terminal: null, status: "attention", attention: { prNumber: 12, blocker: "Conflict" } });
  assert.match(attention.message, /or start `mg stack watch stack --head <pushed-sha>` in the background/);
  const limited = stackWatchObligation({ stackId: "stack", terminal: null, status: "rate_limited", retryAfterSeconds: 9 });
  assert.equal(limited.reason, "rate_limited");
  assert.match(limited.message, /Wait 9s first/);
  const failed = stackWatchObligation({ stackId: "stack", terminal: null, status: "failed" });
  assert.equal(failed.done, false);
  assert.match(failed.message, /does not end the task/);
  assert.equal(stackWatchObligation({ stackId: "stack", terminal: null, unread: true }).reason, "unread");
  assert.match(stackWatchObligation({ stackId: "stack", terminal: null, freshCursor: true }).message, /keep passing that cursor/);
  for (const terminal of ["landed", "closed", "archived", "not_found"] as const) {
    const done = stackWatchObligation({ stackId: "stack", terminal, status: "failed" });
    assert.deepEqual({ done: done.done, reason: done.reason, next: done.next }, { done: true, reason: terminal, next: null });
    assert.doesNotMatch(done.message, /Your task is not done/);
  }
});

test("restack conflict on layer 3 after layer 2 merged into mg-stack-79 repairs against the unit, never mg-park-*", async () => {
  const conflicted = layer({
    branch: "feat/c", parentBranch: "mg-park-79-g1", prNumber: 2858, position: 3, state: "conflict",
    conflictDetail: "conflict in api/src/a.ts, api/src/b.ts",
    restackError: { kind: "rebase_conflict", detail: "conflict in api/src/a.ts, api/src/b.ts", headSha: HEAD,
      attemptedAt: "2026-09-27T00:00:00Z", attempts: 1, backupRef: null, from: { branch: "mg-stack-79", oldSha: NEXT } },
  });
  const h = harness(unitStack([
    layer({ branch: "feat/a", parentBranch: "mg-stack-79", prNumber: 2856, position: 1, state: "merged" }),
    layer({ branch: "feat/b", parentBranch: "feat/a", prNumber: 2857, position: 2, state: "merged" }),
    conflicted,
  ]));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.deepEqual(result.repair, {
    kind: "restack_conflict", prNumber: 2858, headSha: HEAD, branch: "feat/c", liveParent: "mg-stack-79",
    files: ["api/src/a.ts", "api/src/b.ts"], steps: conflictRepairSteps("feat/c", "mg-stack-79"),
  });
  assert.match(result.repair!.kind === "restack_conflict" ? result.repair!.steps : "", /git merge origin\/mg-stack-79/);
  assert.equal(result.watch.done, false);
});

test("the live parent is the open sibling below, not the unit, trunk, or a park freeze", () => {
  const bottom = layer({ branch: "feat/a", parentBranch: "mg-stack-79", prNumber: 1, position: 1 });
  const middle = layer({ branch: "feat/b", parentBranch: "feat/a", prNumber: 2, position: 2 });
  const top = layer({ branch: "feat/c", parentBranch: "mg-park-79-g1", prNumber: 3, position: 3, state: "conflict",
    restackError: { kind: "rebase_conflict", detail: "x", headSha: HEAD, attemptedAt: "", attempts: 1, backupRef: null,
      from: { branch: "mg-park-79-g1", oldSha: NEXT } } });
  const s = unitStack([bottom, middle, top]);
  assert.equal(conflictLiveParent(s, top), "feat/b");
  assert.equal(conflictLiveParent(s, middle), "feat/a");
  assert.equal(conflictLiveParent(s, bottom), "mg-stack-79");
  const promoted = unitStack([bottom, middle, top], { members: [{ prNumber: 2, branch: "feat/b", position: 2,
    promotedHeadSha: HEAD, promotedAt: "", seamState: "approved", seamReviewedSha: null, openedAt: null, mergedAt: null,
    closedAt: null, additions: null, deletions: null, openAdditions: null, openDeletions: null }] });
  assert.equal(conflictLiveParent(promoted, top), "feat/a");
  const staleFrom = unitStack([layer({ ...middle, state: "merged" }), layer({ ...top, restackError: { ...top.restackError!,
    from: { branch: "feat/b", oldSha: NEXT } } })]);
  assert.equal(conflictLiveParent(staleFrom, staleFrom.layers[1]!), "mg-stack-79");
  const parkOnly = { ...stack([layer({ ...top, restackError: null })]), trunkBranch: "mg-park-1-g1" };
  assert.equal(conflictLiveParent(parkOnly, parkOnly.layers[0]!), null);
  assert.match(conflictRepairSteps("feat/c", null), /unknown .*stop and tell the human/);
  for (const candidate of [s, promoted, staleFrom]) {
    for (const l of candidate.layers) assert.doesNotMatch(conflictLiveParent(candidate, l) ?? "", /^mg-park-/);
  }
});

test("a verdict at the current head that is not bound to the base is a pending issue, not silence", async () => {
  const pending = layer({ mergeable: null, mergeableState: "pending", mergeableHeadSha: HEAD });
  const live = stackBlockers(stack([pending]));
  assert.equal(live.attention, null);
  assert.deepEqual(live.issues, [{ prNumber: 42, headSha: HEAD, blocker: "Merge state unknown vs main", bounceKind: null }]);
  assert.match(stackBlockersSummary(live.attention, live.issues), /issues: #42 Merge state unknown vs main/);

  const envelope = await pollStackWatch(cfg, "stack", { ...harness(stack([pending])).options, timeoutMs: 0 });
  assert.equal(envelope.status, "waiting");
  assert.equal(envelope.issues.length, 1);
  assert.equal(envelope.issues[0]!.blocker, "Merge state unknown vs main");

  for (const quiet of [
    layer({ mergeable: null, mergeableState: null, mergeableHeadSha: HEAD }),
    layer({ mergeable: null, mergeableState: "pending", mergeableHeadSha: NEXT }),
    layer({ mergeable: null, mergeableState: "pending", mergeableHeadSha: HEAD, parentBranch: "mg-park-3" }),
  ]) {
    assert.deepEqual(stackBlockers(stack([quiet])).issues, [], JSON.stringify(quiet));
  }

  const promoted = layer({ branch: "feat/a", prNumber: 1, position: 1, mergeable: null, mergeableState: "pending", mergeableHeadSha: HEAD });
  const next = layer({ branch: "feat/b", parentBranch: "feat/a", prNumber: 2, position: 2 });
  const above = unitStack([promoted, next], { members: [{ prNumber: 1, branch: "feat/a", position: 1, seamState: "approved",
    seamReviewedSha: HEAD, promotedHeadSha: HEAD, promotedAt: "2026-01-01T00:00:00Z" }] as never });
  assert.equal(stackBlockers(above).currentCandidate?.prNumber, 2);
  assert.deepEqual(stackBlockers(above).issues, []);
});

test("merge-conflict and CI repairs; a busy hold carries no repair", () => {
  const dirty = layer({ branch: "feat/b", parentBranch: "feat/a", prNumber: 2, position: 2, mergeable: false, mergeableState: "dirty" });
  const bottom = layer({ branch: "feat/a", parentBranch: "mg-stack-79", prNumber: 1, position: 1, state: "merged" });
  const s = unitStack([bottom, dirty]);
  const conflict = stackBlockers(s);
  assert.equal(conflict.repair?.kind, "merge_conflict");
  assert.equal(conflict.repair && "liveParent" in conflict.repair ? conflict.repair.liveParent : undefined, "mg-stack-79");
  const ci = stackBlockers(stack([layer({ ciStatus: "failure", checks: { total: 1, success: 0, pending: 0, failure: 1, failingName: "lint" } })]));
  assert.deepEqual(ci.repair && { kind: ci.repair.kind, branch: ci.repair.branch, failingCheck: "failingCheck" in ci.repair ? ci.repair.failingCheck : null },
    { kind: "ci_failure", branch: "feature", failingCheck: "lint" });
  assert.match(ci.repair!.steps, /gh run view <run-id> --log-failed/);
  const held = stackBlockers(stack([layer({ ciStatus: "failure", cycloneStatus: "patching" })]));
  assert.equal(held.attention, null);
  assert.equal(held.repair, null);
  assert.equal(stackBlockers(stack([layer({ draft: true })])).repair, null);
});

for (const reason of ["ci_pending", "tempest_pending", "tempest_running"]) {
  test(`land gate ${reason} is a wait, not attention`, async () => {
    const land = layer({ branch: "mg-land-79", parentBranch: "main", prNumber: 2874, position: 1 });
    const h = harness(unitStack([land], { state: "landing", landPrNumber: 2874,
      landingBlockReason: `landing blocked: ${reason} on land PR #2874` }));
    h.options.timeoutMs = 0;
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "in_progress");
    assert.equal(result.blocker, null);
    assert.deepEqual(result.landGatePending, { prNumber: 2874, headSha: HEAD, reason: `landing blocked: ${reason} on land PR #2874` });
    assert.equal(result.repair, null);
    assert.equal(result.watch.done, false);
  });
}

test("a failed land gate is still attention", async () => {
  const land = layer({ branch: "mg-land-79", parentBranch: "main", prNumber: 2874, position: 1 });
  const h = harness(unitStack([land], { state: "landing", landPrNumber: 2874,
    landingBlockReason: "landing blocked: tempest_findings on land PR #2874" }));
  h.options.timeoutMs = 0;
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.landGatePending, null);
  assert.equal(landGateIsPending("landing blocked: ci_failure on land PR #1"), false);
  assert.equal(landGateIsPending("ci_pending: settling idle project checks on abc1234"), true);
});

for (const reason of ["tempest_failed", "tempest_stopped"]) {
  test(`land gate ${reason} names the blocker but offers no findings repair`, async () => {
    const land = layer({ branch: "mg-stack-79", parentBranch: "main", prNumber: 2874, position: 1 });
    const h = harness(unitStack([land], { state: "landing", landPrNumber: 2874,
      landingBlockReason: `landing blocked: ${reason} on land PR #2874` }));
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "attention");
    assert.equal(result.blocker, `landing blocked: ${reason} on land PR #2874`);
    assert.equal(result.repair, null);
  });
}

test("tempest findings on the land PR carry a tempest_findings repair on the land branch", async () => {
  const land = layer({ branch: "mg-stack-79", parentBranch: "main", prNumber: 2874, position: 1 });
  const h = harness(unitStack([land], { state: "landing", landPrNumber: 2874,
    landingBlockReason: "landing blocked: tempest_findings on land PR #2874" }));
  h.options.timeoutMs = 0;
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.repair?.kind, "tempest_findings");
  assert.equal(result.repair?.prNumber, 2874);
  assert.equal(result.repair?.branch, "mg-stack-79");
  assert.equal(result.repair && "findings" in result.repair ? result.repair.findings : null,
    "gh api repos/owner/repo/issues/2874/comments");
  assert.match(result.repair!.steps, /ordinary git push \(no force\)/);
  assert.match(result.repair!.steps, /verify each finding/);
});

test("a Tempest findings run on the land PR carries the same repair", () => {
  const land = layer({ branch: "mg-stack-79", parentBranch: "main", prNumber: 2874, position: 1,
    agentRuns: [{ agent: "tempest", status: "findings", sha: HEAD }] });
  const blockers = stackBlockers(unitStack([land], { state: "landing", landPrNumber: 2874 }));
  assert.equal(blockers.attention?.blocker, "Tempest findings");
  assert.equal(blockers.repair?.kind, "tempest_findings");
});

test("a failed Tempest run on the land PR has no findings to fix, so no findings repair", () => {
  const land = layer({ branch: "mg-stack-79", parentBranch: "main", prNumber: 2874, position: 1,
    agentRuns: [{ agent: "tempest", status: "failed", sha: HEAD }] });
  const blockers = stackBlockers(unitStack([land], { state: "landing", landPrNumber: 2874 }));
  assert.equal(blockers.attention?.blocker, "Tempest failed");
  assert.equal(blockers.repair, null);
});

test("a land PR repair never names an undefined branch when the unit branch is unknown", () => {
  const land = layer({ branch: undefined as unknown as string, parentBranch: "main", prNumber: 99, position: 1 });
  const blockers = stackBlockers(unitStack([land], { state: "growing", landPrNumber: 99, branch: undefined,
    landingBlockReason: "landing blocked: tempest_findings on land PR #99" }));
  assert.equal(blockers.repair, null);
});

test("a tempest_findings queue bounce on the land PR carries the tempest_findings repair", () => {
  const land = layer({ branch: "mg-stack-79", parentBranch: "main", prNumber: 2874, position: 1 });
  const entry = bounce({ bounceDetail: { kind: "tempest_findings", headSha: HEAD, prNumber: 2874,
    message: "landing blocked: tempest_findings on land PR #2874" } });
  const blockers = stackBlockers(unitStack([land], { state: "landing", landPrNumber: 2874 }), [entry]);
  assert.equal(blockers.attention?.bounceKind, "tempest_findings");
  assert.match(blockers.attention?.blocker ?? "", /^Tempest findings/);
  assert.equal(blockers.repair?.kind, "tempest_findings");
  assert.equal(blockers.repair?.branch, "mg-stack-79");
});

test("tempest findings on a land PR that Cyclone is patching hold in progress with no repair", () => {
  const land = layer({ branch: "mg-stack-79", parentBranch: "main", prNumber: 2874, position: 1, cycloneStatus: "patching" });
  const blockers = stackBlockers(unitStack([land], { state: "landing", landPrNumber: 2874,
    landingBlockReason: "landing blocked: tempest_findings on land PR #2874" }));
  assert.equal(blockers.attention, null);
  assert.equal(blockers.repair, null);
  assert.deepEqual(blockers.busy.map((entry) => entry.agent), ["cyclone"]);
});

test("tempest findings off the land PR get no tempest_findings repair", () => {
  const other = layer({ branch: "feature", prNumber: 42, agentRuns: [{ agent: "tempest", status: "findings", sha: HEAD }] });
  assert.equal(stackBlockers(stack([other])).repair, null);
});

test("a stack that lands mid-wait ends the wait with watch done instead of timing out", async () => {
  const h = harness();
  let reads = 0;
  h.state.respond = (route) => route.includes("/enrich") && ++reads > 1
    ? { status: 200, body: { stacks: [stack([layer({ state: "merged" })])] } }
    : undefined;
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "waiting");
  assert.deepEqual({ done: result.watch.done, reason: result.watch.reason }, { done: true, reason: "landed" });
});

test("an archived stack and a vanished stack both end the watch", async () => {
  const archived = await pollStackWatch(cfg, "stack", harness({ ...stack(), archivedAt: "2026-09-28T00:00:00Z" }).options);
  assert.equal(archived.watch.reason, "archived");
  assert.equal(archived.watch.done, true);
  const h = harness();
  h.state.respond = (route) => route.includes("/enrich") ? { status: 200, body: { stacks: [] } } : undefined;
  await assert.rejects(() => pollStackWatch(cfg, "stack", h.options), (err: unknown) =>
    err instanceof StackWatchError && err.message === "Stack not found or not owned by the current user" &&
    err.lastEnvelope.status === "failed" && err.lastEnvelope.watch.done && err.lastEnvelope.watch.reason === "not_found");
  const invalid = harness();
  invalid.state.respond = (route) => route.includes("/enrich") ? { status: 200, body: { nope: true } } : undefined;
  await assert.rejects(() => pollStackWatch(cfg, "stack", invalid.options), (err: unknown) =>
    err instanceof StackWatchError && !err.lastEnvelope.watch.done && err.lastEnvelope.watch.reason === "failed");
});

test("timeouts and ticks carry a not-done watch with the fixed cursor", async () => {
  const h = harness();
  const last = await timedOut(h.options);
  assert.equal(last.watch.done, false);
  assert.deepEqual(last.watch.next?.args, { stack_id: "stack", enrolled_head_sha: HEAD, timeout_s: 45 });
  assert.ok(h.ticks.length > 0 && h.ticks.every((tick) => tick.watch && !tick.watch.done));
});

test("attention tells the agent to fix the PR before calling stack_wait again", async () => {
  const h = harness(stack([layer({ ciStatus: "failure", checks: { total: 1, success: 0, pending: 0, failure: 1, failingName: "lint" } })]));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.watch.reason, "attention");
  assert.ok(result.watch.message.startsWith(STACK_WATCH_NOT_DONE_SENTENCE));
  assert.match(result.watch.message, /First fix #42 \(CI failed — lint\); repair, when present, names the fix/);
  assert.match(result.watch.message, /enrolled_head_sha set to the SHA you pushed/);
});

test("the unit land PR on the owned trunk gets the same repair as any layer, against its base", () => {
  const land = layer({ branch: "mg-stack-7", parentBranch: "main", prNumber: 90, position: Number.MAX_SAFE_INTEGER,
    ciStatus: "failure", checks: { total: 1, success: 0, pending: 0, failure: 1, failingName: "ci/test" } });
  const s = { ...unitStack([], { branch: "mg-stack-7", state: "landing", landPrNumber: 90, landPr: land }), trunkBranch: "mg-stack-7" };
  const ci = stackBlockers(s);
  assert.equal(ci.attention?.prNumber, 90);
  assert.equal(ci.repair?.kind, "ci_failure");
  assert.equal(ci.repair?.branch, "mg-stack-7");
  assert.equal(ci.repair?.kind === "ci_failure" ? ci.repair.failingCheck : null, "ci/test");
  const dirty = stackBlockers({ ...s, unit: { ...s.unit!, landPr: { ...land, ciStatus: "success", checks: null, mergeable: false, mergeableState: "dirty" } } });
  assert.match(dirty.attention?.blocker ?? "", /^Merge conflicts/);
  assert.equal(dirty.repair?.kind, "merge_conflict");
  assert.equal(dirty.repair?.branch, "mg-stack-7");
  assert.equal(dirty.repair?.kind === "merge_conflict" ? dirty.repair.liveParent : null, "main");
  assert.match(dirty.repair?.steps ?? "", /^Merge main into mg-stack-7: .*ordinary git push \(no force\)/);
});

test("a promoted member whose stack row reconcile dropped is never the live parent", () => {
  const l2 = layer({ branch: "ms/l2", parentBranch: "mg-stack-7", prNumber: 2, position: 2, state: "conflict",
    restackError: { kind: "rebase_conflict", detail: "conflict in a.ts", headSha: HEAD, attemptedAt: "", attempts: 1, backupRef: null,
      from: { branch: "ms/l1", oldSha: NEXT } } });
  const s = unitStack([l2], { branch: "mg-stack-7", members: [{ prNumber: 1, branch: "ms/l1", position: 1,
    promotedHeadSha: HEAD, promotedAt: "", seamState: "approved", seamReviewedSha: null, openedAt: null, mergedAt: null,
    closedAt: null, additions: null, deletions: null, openAdditions: null, openDeletions: null }] });
  assert.equal(conflictLiveParent(s, l2), "mg-stack-7");
});

function disarmedStack(autoEnqueueWhenReady: boolean | undefined) {
  return { ...stack(), ...(autoEnqueueWhenReady === undefined ? {} : { autoEnqueueWhenReady }) };
}
function disarmingBounce(overrides: Partial<MergeQueueEntryDto> = {}) {
  return bounce({
    bounceReason: "merge_failed",
    bounceDetail: { kind: "merge_failed", prNumber: 42, headSha: NEXT, message: "merge-tree conflict at update-branch" },
    ...overrides,
  });
}

test("Auto land off after a merge_failed bounce returns attention with the bounce and a re-arm repair", async () => {
  const entry = disarmingBounce();
  const h = harness(disarmedStack(false), [entry]);
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "Auto land off after merge_failed bounce");
  assert.equal(result.bounceKind, "merge_failed");
  assert.equal(result.prNumber, 42);
  assert.deepEqual(result.issues.map((issue) => [issue.prNumber, issue.blocker]),
    [[42, "merge failed — merge-tree conflict at update-branch"]]);
  assert.equal(result.repair?.kind, "auto_land_off");
  assert.match(result.repair?.steps ?? "", new RegExp(`mg stack set ${stack().id} --auto-land on`));
  assert.equal(result.cursor.bounceId, entry.id);
});

test("Auto land off with no disarming bounce keeps waiting", async () => {
  for (const entries of [[], [disarmingBounce({ bounceDetail: { kind: "ci_failure", headSha: NEXT } })],
    ]) {
    const result = await timedOut(harness(disarmedStack(false), entries).options);
    assert.equal(result.blocker, null);
    assert.deepEqual(result.issues, []);
  }
});

test("a newer enqueue after a disarming bounce is not named as a disarm", () => {
  const later = disarmingBounce({ id: "later", state: "queued", enqueuedAt: "2026-01-01T00:05:00Z",
    bounceDetail: null, finishedAt: null });
  const result = stackBlockers(disarmedStack(false), [disarmingBounce(), later]);
  assert.equal(result.attention, null);
  assert.deepEqual(result.issues, []);
});

test("a recorded bounced off reason names the entry it points at, not the newest bounce", () => {
  const recorded = disarmingBounce({ id: "recorded", enqueuedAt: "2026-01-01T00:00:00Z" });
  const newer = disarmingBounce({ id: "newer", enqueuedAt: "2026-01-01T00:05:00Z",
    bounceReason: "ci_timeout", bounceDetail: { kind: "ci_timeout", prNumber: 42, headSha: NEXT, message: "timed out" } });
  const result = stackBlockers({ ...disarmedStack(false),
    autoLandOff: { reason: "bounced", entryId: "recorded", at: "2026-01-01T00:01:00Z" } }, [recorded, newer]);
  assert.equal(result.attention?.blocker, "Auto land off after merge_failed bounce");
  assert.equal(result.attention?.bounceKind, "merge_failed");
});

test("a recorded off reason other than bounced keeps a newest disarming bounce out of attention", () => {
  for (const autoLandOff of [
    { reason: "user" as const, entryId: null, at: "2026-01-01T00:10:00Z" },
    { reason: "archive" as const, entryId: null, at: "2026-01-01T00:10:00Z" },
    { reason: "cancelled" as const, entryId: "other", at: "2026-01-01T00:10:00Z" },
    null,
  ]) {
    const result = stackBlockers({ ...disarmedStack(false), autoLandOff }, [disarmingBounce()]);
    assert.equal(result.attention, null, JSON.stringify(autoLandOff));
    assert.deepEqual(result.issues, []);
  }
});

test("a recorded bounced off reason whose entry is not listed does not name another bounce", () => {
  const entry = disarmingBounce();
  const result = stackBlockers({ ...disarmedStack(false),
    autoLandOff: { reason: "bounced", entryId: "gone", at: "2026-01-01T00:01:00Z" } }, [entry]);
  assert.equal(result.attention, null);
  assert.equal(result.repair, null);
  assert.deepEqual(result.issues, []);
});

test("a disarming bounce with Auto land re-armed keeps waiting", async () => {
  for (const armed of [true, undefined]) {
    const result = await timedOut(harness(disarmedStack(armed), [disarmingBounce()]).options);
    assert.equal(result.blocker, null);
    assert.deepEqual(result.issues, []);
  }
});
