import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiFetchInit, ApiFetchResult } from "./api.js";
import type { MergeQueueBounceKind, StackAgentRun, StackDto, StackLayerDto, MergeQueueEntryDto } from "./stack-dto.js";
import {
  pollStackWatch, StackWatchError, StackWatchTimeoutError,
  type PollStackWatchOptions, type StackWatchEnvelope,
} from "./stack-watch.js";
import {
  CI_DID_NOT_FINISH_BLOCKER,
  agentsCannotClear, autoFixCiActive, autoResolveActive, conflictLiveParent, conflictRepairSteps, landGateIsPending, mergeQueueWait,
  stackBlockers, stackBlockersSummary, type StackBlockerReason,
} from "./stack-blockers.js";
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
    cycloneStatus: null, conflictDetail: null, lastRestackedSha: null,
    mergeable: true, mergeableState: "clean", headSha: HEAD, mergeableHeadSha: HEAD,
    ...overrides,
  };
}
function stack(layers = [layer()]): StackDto {
  return { id: "stack", owner: "owner", repo: "repo", trunkBranch: "main", landTarget: "main", archivedAt: null,
    cycloneConflictOff: "account_auto_resolve_off", layers };
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
  const { repair, watch, landGatePending, queueWait, ...result } = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(landGatePending, null);
  assert.equal(queueWait, null);
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

test("a failed Cyclone run on the head is not attention and does not hide the blocker behind it", async () => {
  const failed = { agent: "cyclone" as const, status: "failed" as const, sha: HEAD };
  const alone = harness(stack([layer({ agentRuns: [failed] })]));
  assert.equal((await timedOut(alone.options)).blocker, null);
  const withFailedReview = harness(stack([layer({ vortexStatus: "failed", agentRuns: [failed] })]));
  const result = await pollStackWatch(cfg, "stack", withFailedReview.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "Review failed");
  assert.equal(result.prNumber, 42);
  const red = harness(stack([layer({ ciStatus: "failure", agentRuns: [failed] })]));
  assert.equal((await pollStackWatch(cfg, "stack", red.options)).blocker, "CI failed");
});

test("an older server's cyclone_failed Auto land wait is read as a plain wait, never as a Cyclone block", () => {
  const s = waiting("cyclone_failed");
  assert.equal(stackBlockers(s, [], {}, 10 * MINUTE).attention, null);
  const late = stackBlockers(s, [], {}, 50 * MINUTE);
  assert.equal(late.attention?.blocker, "Auto land has waited 50m: cyclone failed");
  assert.equal(late.repair?.kind, "auto_land_waiting");
});

test("unit land gate blocks the selected land PR", async () => {
  const h = harness(stack([]));
  h.state.stack.unit = {
    id: "unit", uNumber: 1, state: "growing", branch: "unit", landTarget: "main", landPrNumber: 50,
    landingBlockReason: "ci_failure on land PR #50",
    landPr: layer({ prNumber: 50 }), members: [],
  };
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.blocker, "ci_failure on land PR #50");
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
    landingBlockReason: null, landPr: layer({ prNumber: 50, headSha: NEXT, ciStatus: "failure" }),
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

for (const kind of ["checkout_failed", "head_unresolved", "retarget_failed"] as const) {
  test(`Restack failed (${kind}) carries a merge-the-parent repair`, async () => {
    const h = harness(stack([
      layer({ state: "needs_restack",
        restackError: { kind, detail: "boom", headSha: HEAD, attemptedAt: "", attempts: 1, backupRef: null } }),
    ]));
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.blocker, "Restack failed");
    assert.equal(result.repair?.kind, "restack_failed");
    assert.equal(result.repair?.kind === "restack_failed" ? result.repair.liveParent : null, "main");
    assert.equal(result.repair?.kind === "restack_failed" ? result.repair.restackKind : null, kind);
    assert.match(result.repair?.steps ?? "", new RegExp(`\\(${kind}: boom\\)`));
    assert.match(result.repair?.steps ?? "", /git merge origin\/main/);
    assert.match(result.repair?.steps ?? "", /clears Restack failed once the pushed head contains the tip of main/);
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
    layer(),
    layer({ prNumber: 43, position: 1, ciStatus: "failure" }),
  ], { state: "landing", landPrNumber: 43, landingBlockReason: "ci_pending: settling idle project checks on abc1234" }),
    [bounce({ state: "running", bounceDetail: null, finishedAt: null, claimedAt: null })]);
  const live = stackBlockers(h.state.stack, h.state.entries);
  assert.deepEqual(live.issues.map((issue) => issue.prNumber), [43]);
  assert.ok(live.currentCandidate);
  assert.ok(live.landGatePending);
  assert.ok(live.queueWait);
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
    assert.equal(err.lastEnvelope.queueWait, null);
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
    landingBlockReason: null, landPr: null,
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

test("seam findings on a stale head wait while the re-review runs", () => {
  for (const reviewed of [NEXT, null]) {
    const blockers = stackBlockers(seamUnit(stack([layer(vortexBusy)]), "findings", reviewed));
    assert.equal(blockers.attention, null);
    assert.equal(blockers.held, null);
    assert.deepEqual(blockers.issues, []);
  }
});

test("a seam verdict for an older head with no review running is attention with a Continue repair", async () => {
  for (const [seamState, reviewed] of [["findings", NEXT], ["findings", null], ["approved", NEXT]] as const) {
    const h = harness(seamUnit(stack(), seamState, reviewed));
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "attention", seamState);
    assert.equal(result.blocker, "Seam verdict is for an older head, no review running");
    assert.equal(result.prNumber, 42);
    assert.equal(result.repair?.kind, "seam_review_stuck");
    assert.match(result.repair?.steps ?? "", /click Continue on the stack/);
  }
});

test("a stale approved seam is not a blocker once a Vortex review finished at the head", () => {
  const done = { status: "done", skip_reason: null, pass: 1, head_sha: HEAD, phase: null,
    started_at: null, stoppable: false, source: "pr_reviews" } as const;
  assert.equal(stackBlockers(seamUnit(stack([layer({ vortexReview: done })]), "approved", NEXT)).attention, null);
});

for (const [seamState, blocker] of [
  ["reviewing", "Seam review stuck in reviewing, no review running"],
  ["pending_rereview", "Seam re-review pending, no review running"],
] as const) {
  test(`seam ${seamState} with no review running is attention with a Continue repair`, async () => {
    const h = harness(seamUnit(stack(), seamState, NEXT));
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "attention");
    assert.equal(result.blocker, blocker);
    assert.equal(result.prNumber, 42);
    assert.equal(result.headSha, HEAD);
    assert.equal(result.repair?.kind, "seam_review_stuck");
    assert.match(result.repair?.steps ?? "", new RegExp(`is ${seamState} but no seam review is queued or running`));
  });

  test(`seam ${seamState} while its review runs is not a blocker`, () => {
    const blockers = stackBlockers(seamUnit(stack([layer(vortexBusy)]), seamState, NEXT));
    assert.equal(blockers.attention, null);
    assert.equal(blockers.held, null);
    assert.deepEqual(blockers.issues, []);
  });

  test(`seam ${seamState} with no review running stays named while Cyclone patches the PR`, async () => {
    const h = harness(seamUnit(stack([layer({ cycloneStatus: "patching",
      agentRuns: [{ agent: "cyclone", status: "patching", sha: HEAD }] })]), seamState, NEXT));
    const result = await heldInProgress(h.options);
    assert.equal(result.blocker, blocker);
    assert.equal(result.actAfter, "agents_idle");
  });
}

for (const seamState of ["approved", "none"]) {
  test(`seam ${seamState} at the head is not a blocker`, async () => {
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
  for (const review of [{ ...quotaSkipped, skip_reason: "head_superseded" }, { ...quotaSkipped, head_sha: NEXT },
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
      landPrNumber: null, landingBlockReason: null, landPr: null, ...unit,
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
  assert.match(open.message, /If your host has a confirmed notification that resumes this task/);
  assert.match(open.message, /a process left running is not a notification/);
  assert.match(open.message, /it cannot wake an agent by itself/);
  assert.match(open.message, /Without a confirmed notification, keep using stack_wait with the returned cursor/);
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
    note: "Cyclone will not resolve this conflict by itself: auto-resolve conflicts is off for the account and this stack does not turn it on.",
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

for (const reason of ["ci_pending", "some_new_gate_running"]) {
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
    landingBlockReason: "landing blocked: ci_failure on land PR #2874" }));
  h.options.timeoutMs = 0;
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.landGatePending, null);
  assert.equal(landGateIsPending("landing blocked: ci_failure on land PR #1"), false);
  assert.equal(landGateIsPending("ci_pending: settling idle project checks on abc1234"), true);
});

test("a stack whose land PR is gone is attention with a land_pr_unavailable repair, not a wait forever", async () => {
  const merged = layer({ state: "merged", prNumber: 42, position: 1 });
  const closedLand = layer({ branch: "mg-stack-79", parentBranch: "main", prNumber: 2874, position: 2, state: "closed" });
  const reason = "landing blocked: land_pr_unavailable: Validation Failed: head invalid";
  const gone = unitStack([merged], { state: "growing", landPrNumber: 2874, landPr: closedLand, landingBlockReason: reason });
  assert.equal(stackTerminalReason(gone), null);
  const h = harness(gone);
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker,
    "No open land PR for mg-stack-79 — every layer is merged into it, but it cannot land in main without one");
  assert.equal(result.prNumber, 2874);
  assert.equal(result.headSha, HEAD);
  assert.equal(result.watch.done, false);
  assert.equal(result.repair?.kind, "land_pr_unavailable");
  assert.equal(result.repair?.kind === "land_pr_unavailable" ? result.repair.detail : null, "Validation Failed: head invalid");
  assert.equal(result.repair?.branch, "mg-stack-79");
  assert.match(result.repair?.steps ?? "", /git ls-remote origin refs\/heads\/mg-stack-79/);
  assert.match(result.repair?.steps ?? "", /gh pr view 2874 --repo owner\/repo --json headRefOid,state/);
  assert.match(result.repair?.steps ?? "", /or close the stack if the work is no longer wanted/);

  const alsoStored = stackBlockers({
    ...gone,
    autoEnqueueWhenReady: true,
    autoLandWait: { reason: "land_pr_unavailable", prNumber: null, headSha: null, since: new Date(0).toISOString(), attempts: null, detail: null },
  }, [], {}, 50 * 60_000);
  assert.equal(alsoStored.attention?.blocker, result.blocker);
  assert.equal(alsoStored.repair?.kind, "land_pr_unavailable");
  assert.deepEqual(alsoStored.issues, []);

  const neverOpened = stackBlockers(unitStack([merged], { state: "growing", landingBlockReason: reason }));
  assert.equal(neverOpened.attention?.prNumber, 42);
  assert.equal(neverOpened.attention?.headSha, null);
  assert.equal(neverOpened.repair?.kind, "land_pr_unavailable");
  assert.match(neverOpened.repair?.steps ?? "", /git push origin <sha>:refs\/heads\/mg-stack-79/);
});

test("a missing land PR is not raised while the gate only waits, on an open layer, or once the unit is finished", () => {
  const merged = layer({ state: "merged", prNumber: 42, position: 1 });
  const reason = "landing blocked: land_pr_unavailable: Validation Failed: head invalid";
  const quiet = (s: StackDto) => assert.equal(stackBlockers(s).attention, null);
  quiet(unitStack([merged], { state: "growing", landingBlockReason: "landing blocked: ci_pending on land PR #2874" }));
  quiet(unitStack([merged], { state: "growing", landingBlockReason: null }));
  quiet(unitStack([merged], { state: "landed", landingBlockReason: reason }));
  quiet(unitStack([merged], { state: "abandoned", landingBlockReason: reason }));
  quiet({ ...unitStack([merged], { state: "growing", landingBlockReason: reason }), archivedAt: "2026-10-02T00:00:00Z" });
  quiet(unitStack([merged, layer({ prNumber: 43, position: 2 })], { state: "growing", landingBlockReason: reason }));
  quiet(unitStack([merged], { state: "growing", landPrNumber: 2874, landingBlockReason: reason,
    landPr: layer({ branch: "mg-stack-79", prNumber: 2874, position: 2, state: "merged" }) }));
  const open = layer({ branch: "mg-stack-79", parentBranch: "main", prNumber: 2874, position: 2 });
  assert.equal(stackBlockers(unitStack([merged], { state: "growing", landPrNumber: 2874, landPr: open, landingBlockReason: reason }))
    .repair?.kind, undefined);
});

const OLD_SERVER_LAND = () => layer({ branch: "mg-stack-79", parentBranch: "main", prNumber: 2874, position: 1 });

for (const token of ["tempest_findings", "tempest_failed", "tempest_stopped", "tempest_skipped", "tempest_trigger_failed"]) {
  test(`old server: land gate ${token} is attention with the server's text and no repair, like any unrecognised land gate`, async () => {
    const reason = `landing blocked: ${token} on land PR #2874`;
    const h = harness(unitStack([OLD_SERVER_LAND()], { state: "landing", landPrNumber: 2874,
      tempestLandStatus: "failed", landingBlockReason: reason } as Partial<NonNullable<StackDto["unit"]>>));
    h.options.timeoutMs = 0;
    const result = await pollStackWatch(cfg, "stack", h.options);
    const unknown = stackBlockers(unitStack([OLD_SERVER_LAND()], { state: "landing", landPrNumber: 2874,
      landingBlockReason: "landing blocked: some_new_gate on land PR #2874" }));
    assert.equal(result.status, "attention");
    assert.equal(result.blocker, reason);
    assert.equal(result.prNumber, 2874);
    assert.equal(result.repair, null);
    assert.equal(result.landGatePending, null);
    assert.equal(result.watch.done, false);
    assert.equal(unknown.attention?.blocker, "landing blocked: some_new_gate on land PR #2874");
    assert.equal(unknown.repair, null);
  });
}

for (const token of ["tempest_pending", "tempest_running"]) {
  test(`old server: land gate ${token} is a wait, like any other pending or running land gate`, async () => {
    const reason = `landing blocked: ${token} on land PR #2874`;
    const h = harness(unitStack([OLD_SERVER_LAND()], { state: "landing", landPrNumber: 2874, landingBlockReason: reason }));
    h.options.timeoutMs = 0;
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "in_progress");
    assert.equal(result.blocker, null);
    assert.deepEqual(result.landGatePending, { prNumber: 2874, headSha: HEAD, reason });
    assert.equal(result.watch.done, false);
  });
}

test("old server: tempestLandStatus failed with no landing block reason is ignored", () => {
  const blockers = stackBlockers(unitStack([OLD_SERVER_LAND()], { state: "landing", landPrNumber: 2874,
    tempestLandStatus: "failed", landingBlockReason: null } as Partial<NonNullable<StackDto["unit"]>>));
  assert.equal(blockers.attention, null);
  assert.deepEqual(blockers.issues, []);
});

test("old server: a Tempest agent run is ignored, neither a blocker nor a busy agent", async () => {
  for (const status of ["findings", "failed", "running", "queued"] as const) {
    const run = { agent: "tempest", status, sha: HEAD } as unknown as StackAgentRun;
    const onLayer = stackBlockers(stack([layer({ tempestStatus: "findings", agentRuns: [run] } as Partial<StackLayerDto>)]));
    assert.equal(onLayer.attention, null, status);
    assert.deepEqual(onLayer.busy, [], status);
    assert.deepEqual(onLayer.agents?.busy, { vortex: false, cyclone: false }, status);
    const onLand = stackBlockers(unitStack([{ ...OLD_SERVER_LAND(), agentRuns: [run] }], { state: "landing", landPrNumber: 2874 }));
    assert.equal(onLand.attention, null, status);
    assert.equal(onLand.repair, null, status);
  }
  const behind = harness(stack([layer({
    vortexStatus: "failed", agentRuns: [{ agent: "tempest", status: "findings", sha: HEAD } as unknown as StackAgentRun],
  })]));
  assert.equal((await pollStackWatch(cfg, "stack", behind.options)).blocker, "Review failed");
});

for (const kind of ["tempest_findings", "tempest_rerun"] as const) {
  test(`old server: a ${kind} queue bounce is attention with the stored bounce reason and no repair, like any unknown bounce kind`, async () => {
    const message = `landing blocked: ${kind === "tempest_rerun" ? "tempest_skipped" : kind} on land PR #2874`;
    const entry = bounce({ bounceReason: kind, bounceDetail: { kind: kind as string as MergeQueueBounceKind, headSha: HEAD, prNumber: 2874, message } });
    const h = harness(unitStack([OLD_SERVER_LAND()], { state: "landing", landPrNumber: 2874 }), [entry]);
    h.options.timeoutMs = 0;
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "attention");
    assert.equal(result.bounceKind, kind);
    assert.equal(result.blocker, kind);
    assert.equal(result.repair, null);
    assert.equal(result.watch.done, false);
    const other = stackBlockers(unitStack([OLD_SERVER_LAND()], { state: "landing", landPrNumber: 2874 }),
      [bounce({ bounceDetail: { kind: "seam_findings", headSha: HEAD, prNumber: 2874 } })]);
    assert.equal(other.attention?.bounceKind, "seam_findings");
    assert.equal(other.repair, null);
  });
}

test("old server: a tempest_pending Auto land wait is read as a plain wait, then named in generic words", () => {
  const s = waiting("tempest_pending");
  assert.equal(stackBlockers(s, [], {}, 10 * MINUTE).attention, null);
  const late = stackBlockers(s, [], {}, 50 * MINUTE);
  assert.equal(late.attention?.blocker, "Auto land has waited 50m: tempest pending");
  assert.equal(late.repair?.kind, "auto_land_waiting");
});

test("new server: a payload with no Tempest fields at all is read without a crash", async () => {
  const bareLayer = OLD_SERVER_LAND();
  assert.equal("tempestStatus" in bareLayer, false);
  const base = unitStack([bareLayer], { state: "landing", landPrNumber: 2874,
    landingBlockReason: "landing blocked: ci_pending on land PR #2874" });
  const bareUnit = base.unit!;
  assert.equal("tempestLandStatus" in bareUnit, false);
  const h = harness({ ...base, unit: bareUnit as NonNullable<StackDto["unit"]> });
  h.options.timeoutMs = 0;
  const waitingResult = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(waitingResult.status, "in_progress");
  assert.equal(waitingResult.blocker, null);
  const clear = stackBlockers({ ...base, unit: { ...bareUnit, landingBlockReason: null } as NonNullable<StackDto["unit"]> });
  assert.equal(clear.attention, null);
  assert.deepEqual(clear.issues, []);
  const blocked = stackBlockers({ ...base,
    unit: { ...bareUnit, landingBlockReason: "landing blocked: ci_failure on land PR #2874" } as NonNullable<StackDto["unit"]> });
  assert.equal(blocked.attention?.blocker, "landing blocked: ci_failure on land PR #2874");
});

test("a failed land gate on a land PR that Cyclone is patching holds in progress with no repair", () => {
  const land = layer({ branch: "mg-stack-79", parentBranch: "main", prNumber: 2874, position: 1, cycloneStatus: "patching" });
  const blockers = stackBlockers(unitStack([land], { state: "landing", landPrNumber: 2874,
    landingBlockReason: "landing blocked: ci_failure on land PR #2874" }));
  assert.equal(blockers.attention, null);
  assert.equal(blockers.repair, null);
  assert.deepEqual(blockers.busy.map((entry) => entry.agent), ["cyclone"]);
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
  const result = stackBlockers(disarmedStack(false), [disarmingBounce(), later], {}, Date.parse("2026-01-01T00:06:00Z"));
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

function mergeabilitySettle(prNumber: number, headSha: string): NonNullable<StackDto["autoEnqueueSettle"]> {
  return { action: "mergeability", prNumber, headSha, startedAt: "2026-10-02T00:00:00Z" };
}

test("Auto land's mergeability settle at a layer's head is a Merge state unknown issue (#3020)", () => {
  const s = { ...stack([layer({ mergeable: null, mergeableState: null, mergeableHeadSha: null })]), autoEnqueueSettle: mergeabilitySettle(42, HEAD) };
  const result = stackBlockers(s);
  assert.equal(result.attention, null);
  assert.deepEqual(result.issues, [{
    prNumber: 42, headSha: HEAD, bounceKind: null,
    blocker: "Merge state unknown vs main; Auto land is waiting for a mergeability verdict",
  }]);
  assert.match(stackBlockersSummary(result.attention, result.issues), /issues: #42 Merge state unknown vs main; Auto land is waiting/);
});

test("the mergeability settle adds nothing for an older head, an already pending layer, or another action (#3020)", () => {
  const unknown = layer({ mergeable: null, mergeableState: null, mergeableHeadSha: null });
  assert.deepEqual(stackBlockers({ ...stack([unknown]), autoEnqueueSettle: mergeabilitySettle(42, NEXT) }).issues, []);
  const pending = layer({ mergeable: null, mergeableState: "pending", mergeableHeadSha: HEAD });
  assert.deepEqual(stackBlockers({ ...stack([pending]), autoEnqueueSettle: mergeabilitySettle(42, HEAD) }).issues.map((issue) => issue.blocker),
    ["Merge state unknown vs main"]);
  assert.deepEqual(stackBlockers({ ...stack([unknown]), autoEnqueueSettle: { ...mergeabilitySettle(42, HEAD), action: "ready" } }).issues, []);
});

test("an abandoned unit under two open PRs is attention on the bottom PR with a unit_abandoned repair", () => {
  const bottom = layer({ prNumber: 42, position: 1, branch: "feat/a", parentBranch: "main" });
  const top = layer({ prNumber: 43, position: 2, branch: "feat/b", parentBranch: "feat/a", headSha: NEXT });
  const result = stackBlockers({ ...unitStack([bottom, top], { state: "abandoned" }), trunkBranch: "main" });
  assert.equal(result.attention?.prNumber, 42);
  assert.equal(result.attention?.blocker, "Review unit abandoned: based on main");
  assert.equal(result.repair?.kind, "unit_abandoned");
  assert.match(result.repair?.steps ?? "", /mg stack adopt owner\/repo#42/);
  assert.match(result.repair?.steps ?? "", /Ask the human/);
  assert.match(result.repair?.steps ?? "", /tell the human that mg stack adopt/);
});

test("an abandoned bottom remains attention when the next layer is the promote candidate", () => {
  const bottom = layer({ prNumber: 42, position: 1, branch: "feat/a", parentBranch: "main" });
  const top = layer({ prNumber: 43, position: 2, branch: "feat/b", parentBranch: "feat/a", headSha: NEXT });
  const result = stackBlockers(unitStack([bottom, top], {
    state: "abandoned",
    members: [{
      prNumber: 42, openedAt: null, mergedAt: null, closedAt: null, additions: null, deletions: null,
      openAdditions: null, openDeletions: null, branch: "feat/a", position: 1, seamState: "none",
      seamReviewedSha: null, promotedHeadSha: HEAD, promotedAt: "2026-10-02T00:00:00Z",
    }],
  }));
  assert.equal(result.currentCandidate?.prNumber, 43);
  assert.equal(result.attention?.prNumber, 42);
  assert.equal(result.attention?.blocker, "Review unit abandoned: based on main");
  assert.equal(result.repair?.kind, "unit_abandoned");
});

test("an abandoned unit with one open PR left is a unit_abandoned blocker", () => {
  const bottom = layer({ prNumber: 42, position: 1, branch: "feat/a", parentBranch: "main" });
  const result = stackBlockers(unitStack([bottom], { state: "abandoned" }));
  assert.equal(result.attention?.prNumber, 42);
  assert.equal(result.repair?.kind, "unit_abandoned");
  assert.match(result.repair?.steps ?? "", /close and resubmit it/);
  assert.doesNotMatch(result.repair?.steps ?? "", /mg stack adopt/);
});

test("an abandoned unit remains named while Vortex reviews its bottom PR", async () => {
  const h = harness(unitStack([layer({ ...vortexBusy })], { state: "abandoned" }));
  const result = await heldInProgress(h.options);
  assert.equal(result.blocker, "Review unit abandoned: based on main");
  assert.equal(result.prNumber, 42);
  assert.equal(result.actAfter, "agents_idle");
  assert.deepEqual(result.waitingOn, ["vortex"]);
  assert.equal(result.repair?.kind, "unit_abandoned");
});

test("a PR-less child does not hide an abandoned unit repair", () => {
  const bottom = layer({ prNumber: 42, position: 1, branch: "feat/a", parentBranch: "main" });
  const child = layer({ prNumber: 0, position: 2, branch: "feat/b", parentBranch: "feat/a", headSha: NEXT });
  const result = stackBlockers(unitStack([bottom, child], { state: "abandoned" }));
  assert.equal(result.attention?.prNumber, 42);
  assert.equal(result.repair?.kind, "unit_abandoned");
});

test("a live unit does not get a unit_abandoned blocker", () => {
  const bottom = layer({ prNumber: 42, position: 1, branch: "feat/a", parentBranch: "main" });
  const top = layer({ prNumber: 43, position: 2, branch: "feat/b", parentBranch: "feat/a", headSha: NEXT });
  assert.equal(stackBlockers(unitStack([bottom, top], { state: "growing" })).repair?.kind, undefined);
});

const MINUTE = 60_000;

function waiting(
  reason: string,
  overrides: Partial<NonNullable<StackDto["autoLandWait"]>> = {},
  layers = [layer()],
): StackDto {
  return {
    ...stack(layers),
    autoEnqueueWhenReady: true,
    autoLandWait: { reason, prNumber: 42, headSha: HEAD, since: new Date(0).toISOString(), attempts: null, detail: null, ...overrides },
  };
}

test("Auto land's live ci_failure is attention while the ledger shows CI green (#3453)", async () => {
  const h = harness(waiting("ci_failure"));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "CI failed — Auto land reads a failing check on GitHub at this head");
  assert.equal(result.prNumber, 42);
  assert.equal(result.headSha, HEAD);
  assert.equal(result.repair?.kind, "ci_failure");
  assert.match(result.repair?.steps ?? "", /gh run list --branch feature/);
});

test("Auto land's ci_pending is named only after a long wait (#3453)", () => {
  const s = waiting("ci_pending");
  assert.equal(stackBlockers(s, [], {}, 10 * MINUTE).attention, null);
  assert.deepEqual(stackBlockers(s, [], {}, 10 * MINUTE).issues, []);
  const late = stackBlockers(s, [], {}, 50 * MINUTE);
  assert.deepEqual(late.attention, {
    prNumber: 42, headSha: HEAD, bounceKind: null,
    blocker: "CI pending for 50m — a check on this head has not finished, so Auto land will not queue it",
  });
  assert.equal(late.repair?.kind, "ci_pending");
  assert.match(late.repair?.steps ?? "", /gh run rerun/);
});

test("a land PR check that never finishes becomes attention after 45 minutes instead of a land gate wait forever", () => {
  const land = layer({ branch: "mg-stack-79", parentBranch: "main", prNumber: 2874, position: 2, ciStatus: "pending" });
  const merged = layer({ state: "merged", prNumber: 42, position: 1 });
  const s: StackDto = {
    ...unitStack([merged], { state: "growing", landPrNumber: 2874, landPr: land,
      landingBlockReason: "landing blocked: ci_pending on land PR #2874" }),
    autoEnqueueWhenReady: true,
    autoLandWait: { reason: "ci_pending", prNumber: 2874, headSha: HEAD, since: new Date(0).toISOString(), attempts: null, detail: null },
  };
  const early = stackBlockers(s, [], {}, 10 * MINUTE);
  assert.equal(early.attention, null);
  assert.deepEqual(early.landGatePending,
    { prNumber: 2874, headSha: HEAD, reason: "landing blocked: ci_pending on land PR #2874" });
  const late = stackBlockers(s, [], {}, 50 * MINUTE);
  assert.deepEqual(late.attention, {
    prNumber: 2874, headSha: HEAD, bounceKind: null,
    blocker: "CI pending for 50m — a check on this head has not finished, so Auto land will not queue it",
  });
  assert.equal(late.repair?.kind, "ci_pending");
  assert.match(late.repair?.steps ?? "", /gh run list --branch mg-stack-79/);
  assert.match(stackBlockersSummary(late.attention, late.issues, late.busy, late.landGatePending), /blocked: #2874 CI pending for 50m/);
});

test("Auto land's vortex_not_green is held while Vortex reviews and attention once it is idle (#3453)", () => {
  const s = waiting("vortex_not_green");
  assert.equal(stackBlockers(s, [], {}, 20 * MINUTE).attention, null);
  const reviewing = waiting("vortex_not_green", {}, [layer({ vortexStatus: "reviewing" })]);
  const held = stackBlockers(reviewing, [], {}, 40 * MINUTE);
  assert.equal(held.attention, null);
  assert.deepEqual(held.busy.map((entry) => entry.agent), ["vortex"]);
  const idle = stackBlockers(s, [], {}, 40 * MINUTE);
  assert.equal(idle.attention?.blocker,
    "No green Vortex review for 40m — Auto land is waiting for an approving Vortex review at this head");
  assert.equal(idle.repair?.kind, "vortex_not_green");
});

test("a promote Auto land stopped retrying is attention with a promote_failed repair (#3453)", () => {
  const twice = waiting("promote_merge_failed", { attempts: 2, detail: "Base branch was modified" });
  assert.equal(stackBlockers(twice, [], {}, MINUTE).attention, null);
  const stopped = stackBlockers(
    waiting("promote_merge_failed", { attempts: 3, detail: "Base branch was modified" }), [], {}, MINUTE);
  assert.equal(stopped.attention?.blocker,
    "Promote failed 3 times (merge_failed) — Auto land stopped retrying this head: Base branch was modified");
  assert.equal(stopped.repair?.kind, "promote_failed");
  assert.equal(stopped.repair?.kind === "promote_failed" ? stopped.repair.attempts : null, 3);
  assert.match(stopped.repair?.steps ?? "", /mg stack set stack --auto-land off/);
  assert.match(stackBlockersSummary(stopped.attention, stopped.issues), /blocked: #42 Promote failed 3 times/);
});

test("Auto land's wait names nothing for another head, an unarmed or archived stack, or a short wait (#3453)", () => {
  const late = 120 * MINUTE;
  assert.equal(stackBlockers(waiting("ci_failure", { headSha: NEXT }), [], {}, late).attention, null);
  assert.equal(stackBlockers({ ...waiting("ci_failure"), autoEnqueueWhenReady: false }, [], {}, late).attention, null);
  assert.equal(stackBlockers({ ...waiting("ci_failure"), archivedAt: "2026-10-02T00:00:00Z" }, [], {}, late).attention, null);
  assert.equal(stackBlockers(waiting("stack_dirty"), [], {}, 44 * MINUTE).attention, null);
  assert.equal(stackBlockers(waiting("stack_dirty", { prNumber: 41 }), [], {}, late).attention, null);
  assert.equal(stackBlockers({ ...stack(), autoEnqueueWhenReady: true }, [], {}, late).attention, null);
});

test("a more specific ledger blocker wins over Auto land's wait (#3453)", () => {
  const conflicted = waiting("ci_failure", {}, [layer({ state: "conflict" })]);
  assert.equal(stackBlockers(conflicted, [], {}, MINUTE).attention?.blocker, "Conflict");
  const red = waiting("ci_failure", {}, [layer({ ciStatus: "failure", checks: { total: 1, success: 0, pending: 0, failure: 1, failingName: "lint" } })]);
  assert.equal(stackBlockers(red, [], {}, MINUTE).attention?.blocker, "CI failed — lint");
});

test("Auto land's wait on the child of a clean bottom is attention on the child (#3453)", () => {
  const child = layer({ branch: "child", parentBranch: "feature", prNumber: 43, position: 1, headSha: NEXT, mergeableHeadSha: NEXT });
  const s = waiting("ci_failure", { prNumber: 43, headSha: NEXT }, [layer(), child]);
  const result = stackBlockers(s, [], {}, MINUTE);
  assert.deepEqual(result.attention, {
    prNumber: 43, headSha: NEXT, bounceKind: null, blocker: "CI failed — Auto land reads a failing check on GitHub at this head",
  });
  assert.deepEqual(result.currentCandidate, { prNumber: 42, headSha: HEAD });
  assert.equal(result.repair?.kind, "ci_failure");
  assert.equal(result.repair?.prNumber, 43);
});

for (const [reason, words] of [
  ["stack_dirty", "this layer is not clean (it has a conflict or needs a restack)"],
  ["mergeability_unknown", "GitHub has not said whether this PR can merge into its base"],
  ["must_consolidate", "this PR's base is not the stack's land target, and the stack has no review unit to promote it into"],
  ["missing_head", "GitHub returned no head commit for this PR"],
  ["github_unreadable", "Mergestorm cannot read this PR from GitHub"],
  ["parked_base", "this PR's base is a parked branch (mg-park-*) and has not been moved back"],
  ["some_new_token", "some new token"],
] as const) {
  test(`Auto land waiting 45 minutes on ${reason} is attention in plain words with a repair`, async () => {
    const s = waiting(reason);
    assert.equal(stackBlockers(s, [], {}, 44 * MINUTE).attention, null);
    const h = harness(s);
    h.options.now = () => 50 * MINUTE;
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "attention");
    assert.equal(result.blocker, `Auto land has waited 50m: ${words}`);
    assert.equal(result.prNumber, 42);
    assert.equal(result.repair?.kind, "auto_land_waiting");
    assert.equal(result.repair?.kind === "auto_land_waiting" ? result.repair.reason : null, reason);
    assert.match(result.repair?.steps ?? "", /Run mg stack status stack and read what it shows for #42/);
    assert.match(result.repair?.steps ?? "", /tell the human what Auto land is waiting for and since when/);
  });
}

test("a wait stored without a head or without a PR is matched on the stack", () => {
  const noHead = stackBlockers(waiting("conflict_unchanged", { headSha: null }), [], {}, 50 * MINUTE);
  assert.equal(noHead.attention?.blocker,
    "Auto land has waited 50m: the merge queue bounced this PR for a conflict, and neither the PR nor its base has changed since");
  assert.equal(noHead.attention?.prNumber, 42);
  assert.equal(noHead.repair?.kind, "auto_land_waiting");

  const noPr = stackBlockers(waiting("layer_without_pr", { prNumber: null, headSha: null }), [], {}, 50 * MINUTE);
  assert.equal(noPr.attention?.blocker, "Auto land has waited 50m: a layer of this stack has no pull request");
  assert.equal(noPr.attention?.prNumber, 42);

  const merged = layer({ state: "merged", prNumber: 42, position: 1 });
  const landed: StackDto = {
    ...unitStack([merged], { state: "growing" }),
    autoEnqueueWhenReady: true,
    autoLandWait: { reason: "trunk_in_land_target_without_land_pr", prNumber: null, headSha: NEXT,
      since: new Date(0).toISOString(), attempts: null, detail: null },
  };
  assert.equal(stackBlockers(landed, [], {}, 10 * MINUTE).attention, null);
  const stuck = stackBlockers(landed, [], {}, 50 * MINUTE);
  assert.deepEqual(stuck.attention, {
    prNumber: 42, headSha: HEAD, bounceKind: null,
    blocker: "Auto land has waited 50m: the stack's commits are already in the land target, but no merged land PR was found",
  });
  assert.equal(stuck.repair?.kind, "auto_land_waiting");
});

for (const [reason, what, permission] of [
  ["check_runs_unreadable", "the check runs", /Checks: read on owner\/repo/],
  ["commit_statuses_unreadable", "the commit statuses", /Commit statuses: read on owner\/repo/],
  ["ci_unreadable", "the check runs and commit statuses", /Checks: read and Commit statuses: read on owner\/repo/],
] as const) {
  test(`${reason} with a refused read is attention at once and names the missing GitHub App permission`, async () => {
    const h = harness(waiting(reason, { detail: "HTTP 403" }));
    h.options.now = () => MINUTE;
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "attention");
    assert.equal(result.blocker, `Mergestorm cannot read ${what} on this head (HTTP 403) — Auto land cannot tell whether CI passed`);
    assert.equal(result.repair?.kind, "ci_unreadable");
    assert.match(result.repair?.steps ?? "", permission);
    assert.match(result.repair?.steps ?? "", /do not patch or push for this/);
  });
}

test("an unreadable CI wait with no refusal recorded is named after 10 minutes, so a short GitHub outage stays a wait", () => {
  assert.equal(stackBlockers(waiting("check_runs_unreadable", { detail: "HTTP 502" }), [], {}, 9 * MINUTE).attention, null);
  assert.equal(stackBlockers(waiting("check_runs_unreadable"), [], {}, 9 * MINUTE).attention, null);
  const late = stackBlockers(waiting("check_runs_unreadable", { detail: "HTTP 502" }), [], {}, 11 * MINUTE);
  assert.equal(late.attention?.blocker,
    "Mergestorm cannot read the check runs on this head (HTTP 502) — Auto land cannot tell whether CI passed");
  assert.equal(late.repair?.kind, "ci_unreadable");
  assert.equal(stackBlockers(waiting("check_runs_unreadable", { detail: "HTTP 404" }), [], {}, MINUTE).repair?.kind, "ci_unreadable");
});

const changesRequested = (extra: Partial<StackLayerDto> = {}) => layer({
  vortexStatus: "findings", reviewStatus: "changes_requested", vortexReview: done(HEAD), ...extra,
});

for (const reason of ["vortex_patch_cap", "hold", "auto_patch_off", "no_billing", "pr_state_unavailable"]) {
  test(`Vortex findings Cyclone left for a person (${reason}) are attention with a repair hint`, async () => {
    const h = harness(stack([changesRequested({ cycloneHandoff: { headSha: HEAD, reason, at: null } })]));
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "attention");
    assert.equal(result.blocker, "Vortex findings need a person");
    assert.equal(result.prNumber, 42);
    assert.equal(result.repair?.kind, "vortex_findings");
    assert.equal(result.repair?.kind === "vortex_findings" ? result.repair.handoff : null, reason);
    assert.match(result.repair?.steps ?? "", /repos\/owner\/repo\/pulls\/42\/reviews/);
  });
}

test("a stack with auto-patch off names Vortex findings at the head with no Cyclone row", () => {
  const off = { ...stack([changesRequested()]), autoPatchOverride: false };
  assert.equal(stackBlockers(off).attention?.blocker, "Vortex findings need a person");
  assert.equal(stackBlockers(stack([changesRequested()])).attention, null);
});

for (const [reason, words] of [
  ["account_auto_patch_off", /auto-patch is off for the account/],
  ["cyclone_not_connected", /Cyclone is not connected to this repo/],
  ["stack_auto_patch_off", /auto-patch is off for this stack/],
] as const) {
  test(`Vortex findings at the head with no Cyclone row are named when Cyclone will not patch (${reason})`, async () => {
    const h = harness({ ...stack([changesRequested()]), cyclonePatchOff: reason });
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "attention");
    assert.equal(result.blocker, "Vortex findings need a person");
    assert.equal(result.repair?.kind, "vortex_findings");
    assert.equal(result.repair?.kind === "vortex_findings" ? result.repair.handoff : null, reason);
    assert.match(result.repair?.steps ?? "", words);
  });
}

test("Vortex findings are not named when Cyclone will not patch but Cyclone is working the PR", () => {
  const off = { ...stack([changesRequested({ cycloneStatus: "patching" })]), cyclonePatchOff: "account_auto_patch_off" as const };
  assert.equal(stackBlockers(off).attention, null);
});

test("Vortex findings are not named while Cyclone may still patch them", () => {
  const handoff = { headSha: HEAD, reason: "vortex_patch_cap", at: null };
  for (const candidate of [
    changesRequested({ cycloneHandoff: { ...handoff, headSha: NEXT } }),
    changesRequested({ cycloneHandoff: null }),
    changesRequested({ cycloneHandoff: handoff, reviewStatus: "approved" }),
    changesRequested({ cycloneHandoff: handoff, vortexStatus: "all_clear" }),
    changesRequested({ cycloneHandoff: handoff, vortexReview: done(NEXT) }),
    changesRequested({ cycloneHandoff: handoff, vortexReview: reviewing(HEAD) }),
  ]) {
    assert.equal(stackBlockers(stack([candidate])).attention, null, JSON.stringify(candidate));
  }
  const patching = stackBlockers(stack([changesRequested({ cycloneHandoff: handoff, cycloneStatus: "patching" })]));
  assert.equal(patching.attention, null);
});

test("a more specific blocker on the head wins over Vortex findings left for a person", () => {
  const handoff = { headSha: HEAD, reason: "hold", at: null };
  assert.equal(stackBlockers(stack([changesRequested({ cycloneHandoff: handoff, ...redCi })])).attention?.blocker, "CI failed — lint");
  assert.equal(stackBlockers(stack([changesRequested({
    cycloneHandoff: handoff, agentRuns: [{ agent: "cyclone", status: "failed", sha: HEAD }],
  })])).attention?.blocker, stackBlockers(stack([changesRequested({ cycloneHandoff: handoff })])).attention?.blocker);
});

const QUEUE_NOW = Date.parse("2026-01-01T02:00:00Z");
function minutesBefore(minutes: number): string {
  return new Date(QUEUE_NOW - minutes * 60_000).toISOString();
}

test("a live queue entry names its wait reason and how long it has been held", async () => {
  const live = bounce({ state: "waiting", bounceDetail: null, finishedAt: null, waitReason: "CI pending on abc1234 (Tests)",
    claimedAt: minutesBefore(12) });
  const h = harness(stack(), [live]);
  h.options.now = () => QUEUE_NOW;
  h.options.timeoutMs = 0;
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "in_progress");
  assert.deepEqual(result.queueWait, {
    prNumber: 42, headSha: HEAD, text: "Merge queue waiting for 12m: CI pending on abc1234 (Tests)",
    since: minutesBefore(12), waitReason: "CI pending on abc1234 (Tests)",
  });
  assert.equal(stackBlockersSummary(null, [], [], null, null, result.queueWait),
    " · queue: #42 Merge queue waiting for 12m: CI pending on abc1234 (Tests)");
});

test("a fresh queued entry with no live entry ahead is not stalled", () => {
  const queued = bounce({ state: "queued", bounceDetail: null, finishedAt: null, enqueuedAt: minutesBefore(10) });
  const wait = mergeQueueWait([queued], QUEUE_NOW);
  const result = stackBlockers(stack(), [queued], {}, QUEUE_NOW);
  assert.equal(wait?.text, "Queued 10m in the merge queue, not picked up yet");
  assert.equal(wait?.stalled, false);
  assert.equal(result.attention, null);
});

test("a queue entry held past the stall threshold is attention with a plain repair", () => {
  const live = bounce({ state: "running", bounceDetail: null, finishedAt: null, waitReason: "gh_error: Server Error, retry 2/3",
    claimedAt: minutesBefore(50) });
  const result = stackBlockers(stack(), [live], {}, QUEUE_NOW);
  assert.equal(result.attention?.blocker, "Merge queue stuck: Merge queue running for 50m: gh_error: Server Error, retry 2/3");
  assert.equal(result.repair?.kind, "queue_stalled");
  assert.match(result.repair?.steps ?? "", /mg queue rm stack, then mg queue add stack/);
  assert.equal(result.queueWait, null);
});

test("a queued entry with nothing live ahead is a wait for 44 minutes after it was enqueued and attention after 45", async () => {
  const queued = (minutes: number, extra: Partial<MergeQueueEntryDto> = {}) =>
    bounce({ state: "queued", bounceDetail: null, finishedAt: null, enqueuedAt: minutesBefore(minutes), ...extra });
  const early = harness(stack(), [queued(44)]);
  early.options.now = () => QUEUE_NOW;
  early.options.timeoutMs = 0;
  const waitingResult = await pollStackWatch(cfg, "stack", early.options);
  assert.equal(waitingResult.status, "in_progress");
  assert.equal(waitingResult.blocker, null);
  assert.equal(waitingResult.queueWait?.text, "Queued 44m in the merge queue, not picked up yet");

  const h = harness(stack(), [queued(50, { claimedAt: minutesBefore(1), waitReason: "main keeps moving" })]);
  h.options.now = () => QUEUE_NOW;
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker,
    "Merge queue stuck: Queued 50m in the merge queue, not picked up yet (last note: main keeps moving)");
  assert.equal(result.repair?.kind, "queue_stalled");
  assert.equal(result.repair?.kind === "queue_stalled" ? result.repair.since : null, minutesBefore(50));
  assert.match(result.repair?.steps ?? "", /nothing is working on it or on an entry ahead of it; its last note is: main keeps moving/);
  assert.match(result.repair?.steps ?? "", /do not patch or push for this/);
  assert.match(result.repair?.steps ?? "", /mg queue rm stack, then mg queue add stack/);
});

test("a running entry without a claim timestamp has an unknown age", () => {
  const live = bounce({ state: "running", bounceDetail: null, finishedAt: null, enqueuedAt: minutesBefore(90), claimedAt: null });
  const result = stackBlockers(stack(), [live], {}, QUEUE_NOW);
  assert.equal(result.attention, null);
  assert.deepEqual(result.queueWait, {
    prNumber: 42, headSha: HEAD, text: "Merge queue running for an unknown duration: no reason recorded",
    since: null, waitReason: null,
  });

  const queued = bounce({ state: "queued", bounceDetail: null, finishedAt: null, enqueuedAt: minutesBefore(90),
    aheadInRepo: { stackId: null, state: "running", claimedAt: null, waitReason: null } });
  const behind = stackBlockers(stack(), [queued], {}, QUEUE_NOW);
  assert.equal(behind.attention, null);
  assert.equal(behind.queueWait?.text,
    "Queued 90m behind another user's stack, which has been running in the merge queue for an unknown duration");
  assert.equal(behind.queueWait?.since, null);
});

test("a queued entry names the stack ahead of it and wakes the watch once that entry stalls", async () => {
  const queued = (claimedMinutes: number) => bounce({ state: "queued", bounceDetail: null, finishedAt: null, position: 1,
    enqueuedAt: minutesBefore(55), aheadInRepo: { stackId: "other-stack", state: "waiting", claimedAt: minutesBefore(claimedMinutes),
      waitReason: "CI pending on def5678" } });
  const fresh = stackBlockers(stack(), [queued(20)], {}, QUEUE_NOW);
  assert.equal(fresh.attention, null);
  assert.equal(fresh.queueWait?.text,
    "Queued 55m behind stack other-stack, which has been waiting in the merge queue for 20m: CI pending on def5678");

  const h = harness(stack(), [queued(46)]);
  h.options.now = () => QUEUE_NOW;
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.match(result.blocker ?? "", /^Merge queue stuck: Queued 55m behind stack other-stack/);
  assert.equal(result.repair?.kind, "queue_stalled");
  assert.match(result.repair?.steps ?? "", /mg stack status other-stack/);
});

test("a queued entry behind another user's entry does not show that user's stack or reason", () => {
  const queued = bounce({ state: "queued", bounceDetail: null, finishedAt: null, enqueuedAt: minutesBefore(5),
    aheadInRepo: { stackId: null, state: "running", claimedAt: minutesBefore(3), waitReason: null } });
  const result = stackBlockers(stack(), [queued], {}, QUEUE_NOW);
  assert.equal(result.queueWait?.text, "Queued 5m behind another user's stack, which has been running in the merge queue for 3m");
});

for (const [skipReason, blocker, step] of [
  ["auto_review_off", "Vortex auto-review is off, so this head was not reviewed", /turning auto-review on \(mg stack set stack --auto-review on, or the account setting in the dashboard\) queues a review of this head by itself\. To review only this head and leave auto-review off, comment @mergestorm-vortex review on #42/],
  ["billing_blocked", "Vortex skipped this head: it could not confirm billing", /check the plan and billing/],
  ["billing_unavailable", "Vortex skipped this head: it could not confirm billing", /comment @mergestorm-vortex review on #42/],
  ["ignored_author", "Vortex skipped this head: the PR author is on the ignored authors list", /To review this head once, comment @mergestorm-vortex review on #42\. To have this author's PRs reviewed by themselves, tell the human to remove the author from the ignored authors list/],
  ["repo_disabled", "Vortex skipped this head: reviews are turned off for this repository", /a mention will not run a review while the repository is off\. Tell the human to turn the repository on in the Mergestorm dashboard/],
] as const) {
  test(`a Vortex review skipped for ${skipReason} at the head is attention at once, without Auto land`, async () => {
    const h = harness(stack([layer({ vortexStatus: "skipped", vortexReview: { ...quotaSkipped, skip_reason: skipReason } })]));
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "attention");
    assert.equal(result.blocker, blocker);
    assert.equal(result.repair?.kind, "vortex_skipped");
    assert.equal(result.repair?.kind === "vortex_skipped" ? result.repair.skipReason : null, skipReason);
    assert.match(result.repair?.steps ?? "", step);
  });
}

test("a Vortex review that covered only part of the PR is attention with the mention that continues it", async () => {
  const h = harness(stack([layer({ vortexStatus: "incomplete",
    vortexReview: { ...quotaSkipped, status: "done", skip_reason: null } })]));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "Vortex reviewed only part of this PR");
  assert.equal(result.repair?.kind, "vortex_skipped");
  assert.equal(result.repair?.kind === "vortex_skipped" ? result.repair.skipReason : null, "incomplete");
  assert.match(result.repair?.steps ?? "", /left the rest unreviewed/);
});

for (const [vortexStatus, review, blocker] of [
  ["skipped", { ...quotaSkipped, skip_reason: "auto_review_off" }, "Vortex auto-review is off, so this head was not reviewed"],
  ["skipped", { ...quotaSkipped, skip_reason: "billing_blocked" }, "Vortex skipped this head: it could not confirm billing"],
  ["incomplete", { ...quotaSkipped, status: "done", skip_reason: null }, "Vortex reviewed only part of this PR"],
] as const) {
  test(`${blocker} stays named while Cyclone patches the PR`, async () => {
    const h = harness(stack([layer({ vortexStatus, vortexReview: review, cycloneStatus: "patching",
      agentRuns: [{ agent: "cyclone", status: "patching", sha: HEAD }] })]));
    const result = await heldInProgress(h.options);
    assert.equal(result.blocker, blocker);
    assert.equal(result.actAfter, "agents_idle");
    assert.deepEqual(result.waitingOn, ["cyclone"]);
  });
}

test("an incomplete Vortex review at an older head is not named at the live head", () => {
  const review = { ...quotaSkipped, status: "done" as const, skip_reason: null, head_sha: NEXT };
  assert.equal(stackBlockers(stack([layer({ vortexStatus: "incomplete", vortexReview: review })])).attention, null);
});

test("a skipped or partial Vortex review is not named while a Vortex run works on the head", () => {
  for (const overrides of [
    { vortexStatus: "skipped", vortexReview: { ...quotaSkipped, skip_reason: "auto_review_off" },
      agentRuns: [{ agent: "vortex", status: "reviewing", sha: HEAD }] },
    { vortexStatus: "incomplete", vortexReview: { ...quotaSkipped, status: "reviewing", skip_reason: null } },
  ] as const) {
    const blockers = stackBlockers(stack([layer(overrides as Partial<StackLayerDto>)]));
    assert.equal(blockers.attention, null, JSON.stringify(overrides));
    if (overrides.vortexStatus === "incomplete") assert.deepEqual(blockers.busy, []);
  }
});

test("an auto_review_off skip at an older head is not named at the live head", () => {
  const review = { ...quotaSkipped, skip_reason: "auto_review_off", head_sha: NEXT };
  assert.equal(stackBlockers(stack([layer({ vortexStatus: "skipped", vortexReview: review })])).attention, null);
});

test("a Vortex retry that is scheduled is a named wait, never attention, also past the 30 minute Vortex rule", async () => {
  const retrying = { ...quotaSkipped, skip_reason: "retry_scheduled" };
  for (const vortexStatus of ["skipped", "failed"] as const) {
    const h = harness({ ...waiting("vortex_not_green", {}, [layer({ vortexStatus, vortexReview: retrying })]) });
    h.options.now = () => 50 * MINUTE;
    h.options.timeoutMs = 0;
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "waiting", vortexStatus);
    assert.equal(result.blocker, null);
    assert.equal(result.repair, null);
    assert.deepEqual(result.issues, [{ prNumber: 42, headSha: HEAD, bounceKind: null,
      blocker: "Vortex hit a temporary error on this head and will retry by itself" }]);
  }
  const olderHead = layer({ vortexStatus: "failed", vortexReview: { ...retrying, head_sha: NEXT } });
  const h = harness(stack([olderHead]));
  h.options.timeoutMs = 0;
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "waiting");
  assert.equal(result.blocker, null);
  assert.equal(result.repair, null);
});

test("Review failed carries a vortex_failed repair that says how to run the review again", () => {
  const result = stackBlockers(stack([layer({ vortexStatus: "failed" })]));
  assert.equal(result.attention?.blocker, "Review failed");
  assert.equal(result.repair?.kind, "vortex_failed");
  assert.match(result.repair?.steps ?? "", /gh pr comment 42 --repo owner\/repo --body "@mergestorm-vortex review"/);
  assert.match(result.repair?.steps ?? "", /a new commit pushed to feature also queues one\. If it fails again, tell the human/);
});

test("a stray PR open on the stack branch is attention at once with a members_remaining repair", () => {
  const land = layer({ branch: "mg-stack-79", parentBranch: "main", prNumber: 2874, position: 2 });
  const merged = layer({ state: "merged", prNumber: 42, position: 1 });
  const detail = "PR #4 is still open on mg-stack-79 and is not a layer of this stack: close it, retarget it or adopt it";
  const s: StackDto = {
    ...unitStack([merged], { state: "growing", landPrNumber: 2874, landPr: land }),
    autoEnqueueWhenReady: true,
    autoLandWait: { reason: "members_remaining", prNumber: 2874, headSha: HEAD, since: new Date(0).toISOString(), attempts: null, detail },
  };
  const result = stackBlockers(s, [], {}, MINUTE);
  assert.deepEqual(result.attention, { prNumber: 2874, headSha: HEAD, bounceKind: null,
    blocker: `The land PR cannot be queued: ${detail}` });
  assert.equal(result.repair?.kind, "members_remaining");
  assert.equal(result.repair?.kind === "members_remaining" ? result.repair.detail : null, detail);
  assert.match(result.repair?.steps ?? "", /do not patch or push for this\. Close that PR, retarget it to another base, or adopt it into the stack/);
  assert.match(result.repair?.steps ?? "", /a draft PR or a PR from a fork cannot be adopted, so close or retarget it/);
  const tokenShaped = stackBlockers(
    { ...s, autoLandWait: { ...s.autoLandWait!, detail: "members_remaining: #4, #5 still open" } }, [], {}, MINUTE);
  assert.equal(tokenShaped.attention?.blocker, "The land PR cannot be queued: members_remaining: #4, #5 still open");
  assert.equal(tokenShaped.repair?.kind, "members_remaining");
  const bare = stackBlockers({ ...s, autoLandWait: { ...s.autoLandWait!, detail: null } }, [], {}, MINUTE);
  assert.equal(bare.attention?.blocker,
    "The land PR cannot be queued: a PR that is not a layer of this stack is still open on the stack branch");
  assert.equal(bare.repair?.kind, "members_remaining");
});

test("the queue's merge_failed bounce for a stray PR on the stack branch is shown with its message", () => {
  const message = "PR #4 is still open on mg-stack-79 and is not a layer of this stack: close it, retarget it or adopt it, then re-enqueue";
  const bounced = bounce({ bounceDetail: { kind: "merge_failed", headSha: HEAD, message } });
  const result = stackBlockers(stack(), [bounced]);
  assert.equal(result.attention?.blocker, `merge failed — ${message}`);
});

for (const [reason, words] of [
  ["infra_failure", /Cyclone could not start the patch: GitHub sign-in, comment load or checkout kept failing/],
  ["no_changes", /Cyclone found nothing to change for these findings/],
  ["credits_exhausted", /the account is out of standard credits this month/],
  ["no_billing", /the account has no billing set up/],
  ["unsupported_language", /the findings are in a language Cyclone does not patch/],
  ["policy_owner_changed", /the stack's owner changed while the patch was queued/],
  ["patch_job_lost", /Cyclone's patch job was lost before it finished/],
] as const) {
  test(`the Cyclone hand-off ${reason} is said in plain words`, () => {
    const result = stackBlockers(stack([changesRequested({ cycloneHandoff: { headSha: HEAD, reason, at: null } })]));
    assert.equal(result.repair?.kind, "vortex_findings");
    assert.match(result.repair?.steps ?? "", words);
  });
}

test("the agents-busy hold names exactly the blockers no agent run clears", () => {
  const expected: Record<StackBlockerReason, boolean> = {
    restack_conflict: true,
    restack_failed: true,
    draft_pr: true,
    merge_conflict: true,
    ci_failed: false,
    vortex_failed: false,
    vortex_out_of_quota: true,
    vortex_skipped: true,
    vortex_findings_need_person: false,
    seam_failed: false,
    seam_findings: false,
    seam_not_running: true,
    seam_review_stuck: true,
    seam_rereview_not_running: true,
    seam_verdict_stale: true,
    unit_abandoned: true,
    land_gate: false,
    bounce: false,
    auto_land_off: false,
    auto_land_ci_pending: false,
    auto_land_members_remaining: false,
    auto_land_vortex_wait: false,
    auto_land_promote_failed: false,
    auto_land_ci_unreadable: false,
    auto_land_waited: false,
    queue_stalled: false,
    land_pr_missing: false,
  };
  for (const reason of Object.keys(expected) as StackBlockerReason[]) {
    assert.equal(agentsCannotClear(reason), expected[reason], reason);
  }
});

test("attention, held and issues carry only the published blocker fields", () => {
  const published = ["blocker", "bounceKind", "headSha", "prNumber"];
  const plain = stackBlockers(stack([layer(dirtyMain)]));
  assert.deepEqual(Object.keys(plain.attention ?? {}).sort(), published);
  const held = stackBlockers(stack([layer({ ...dirtyMain, ...vortexBusy })]));
  assert.deepEqual(Object.keys(held.held ?? {}).sort(), ["actAfter", ...published, "waitingOn"].sort());
  for (const issue of held.issues) assert.deepEqual(Object.keys(issue).sort(), published);
});

const autoResolveOn = (layers: StackLayerDto[]): StackDto => ({ ...stack(layers), cycloneConflictOff: undefined });
const restackConflict = {
  state: "conflict" as const, conflictDetail: "conflict in api/src/a.ts",
  restackError: { kind: "rebase_conflict" as const, detail: "conflict in api/src/a.ts", headSha: HEAD,
    attemptedAt: new Date(Date.now() - 30_000).toISOString(), attempts: 1, backupRef: null },
};
const queuedConflictJob = (minutesAgo = 1): Partial<StackLayerDto> => ({
  agentRuns: [{ agent: "cyclone", status: "queued", sha: HEAD, startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() }],
});
const conflictHandoff = (reason = "conflict_needs_person") => ({ cycloneConflictHandoff: { headSha: HEAD, reason, at: null } });

test("with auto-resolve on, a layer conflict while Cyclone's conflict job is queued is plain in_progress, not a held blocker", async () => {
  for (const conflict of [restackConflict, dirtyMain]) {
    const h = harness(autoResolveOn([layer({ ...conflict, ...queuedConflictJob() })]));
    const result = await heldInProgress(h.options);
    assert.equal(result.blocker, null);
    assert.equal(result.actAfter, null);
    assert.deepEqual(result.busy.map((entry) => entry.agent), ["cyclone"]);
    assert.equal(result.repair, null);
  }
});

test("with auto-resolve on, a conflict waiting for the sweep inside the enqueue grace is in_progress", async () => {
  const h = harness(autoResolveOn([layer({ ...dirtyMain, cycloneConflictPendingSince: new Date(Date.now() - 30_000).toISOString() })]));
  const result = await heldInProgress(h.options);
  assert.equal(result.blocker, null);
  assert.deepEqual(result.busy.map((entry) => entry.agent), ["cyclone"]);
});

test("a conflict whose enqueue grace or queued job went stale is attention again", async () => {
  for (const extra of [
    { cycloneConflictPendingSince: new Date(Date.now() - 3 * 60_000).toISOString() },
    queuedConflictJob(16),
  ]) {
    const h = harness(autoResolveOn([layer({ ...dirtyMain, ...extra })]));
    const result = await pollStackWatch(cfg, "stack", h.options);
    assert.equal(result.status, "attention", JSON.stringify(extra));
    assert.equal(result.blocker, "Merge conflicts vs main");
    assert.equal(result.repair?.kind, "merge_conflict");
  }
});

test("after Cyclone hands the conflict off at the head, the watch returns attention with the reason in the repair", async () => {
  const h = harness(autoResolveOn([layer({ ...restackConflict, ...conflictHandoff("auto_resolve_daily_cap") })]));
  const result = await pollStackWatch(cfg, "stack", h.options);
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "Conflict");
  assert.equal(result.repair?.kind, "restack_conflict");
  assert.match(result.repair?.kind === "restack_conflict" ? result.repair.note ?? "" : "", /left it for a person \(Cyclone already resolved conflicts on this PR twice today, its daily cap\)/);
});

test("a conflict handed off at the head stays named in the hold while Vortex is busy", async () => {
  const h = harness(autoResolveOn([layer({ ...dirtyMain, ...vortexBusy, ...conflictHandoff() })]));
  const result = await heldInProgress(h.options);
  assert.equal(result.blocker, "Merge conflicts vs main");
  assert.equal(result.actAfter, "agents_idle");
  assert.match(result.repair?.kind === "merge_conflict" ? result.repair.note ?? "" : "", /Cyclone could not resolve the conflict and left it for a person/);
});

test("with auto-resolve off, a conflict is attention and held while an agent is busy, as before", async () => {
  const off = (extra: Partial<StackLayerDto>) => ({ ...stack([layer({ ...dirtyMain, ...extra })]), cycloneConflictOff: "stack_auto_resolve_off" as const });
  const attention = await pollStackWatch(cfg, "stack", harness(off({})).options);
  assert.equal(attention.status, "attention");
  assert.equal(attention.repair?.kind === "merge_conflict" ? attention.repair.steps : "", conflictRepairSteps("feature", "main"));
  assert.equal(attention.repair?.kind === "merge_conflict" ? attention.repair.note : "", "Cyclone will not resolve this conflict by itself: auto-resolve conflicts is off for this stack.");
  const held = await heldInProgress(harness(off(vortexBusy)).options);
  assert.equal(held.actAfter, "agents_idle");
  assert.equal(held.blocker, "Merge conflicts vs main");
});

test("a conflict handoff never marks Vortex findings as left for a person, and a findings handoff still does", () => {
  assert.equal(stackBlockers(autoResolveOn([changesRequested(conflictHandoff())])).attention, null);
  assert.equal(stackBlockers(autoResolveOn([changesRequested({ cycloneHandoff: { headSha: HEAD, reason: "hold", at: null } })])).attention?.blocker,
    "Vortex findings need a person");
});

test("autoResolveActive is off for the land PR, with the toggle off, and after a handoff at the head", () => {
  const plain = layer();
  assert.equal(autoResolveActive(autoResolveOn([plain]), plain), true);
  assert.equal(autoResolveActive(stack([plain]), plain), false);
  assert.equal(autoResolveActive(autoResolveOn([plain]), layer(conflictHandoff())), false);
  assert.equal(autoResolveActive(autoResolveOn([plain]), layer({ cycloneConflictHandoff: { headSha: NEXT, reason: "x", at: null } })), true);
  const land = { ...unitStack([plain], { landPrNumber: 42 }), cycloneConflictOff: undefined };
  assert.equal(autoResolveActive(land, plain), false);
  assert.equal(agentsCannotClear("merge_conflict", autoResolveOn([plain]), plain), false);
  assert.equal(agentsCannotClear("restack_conflict", autoResolveOn([plain]), plain), false);
  assert.equal(agentsCannotClear("restack_failed", autoResolveOn([plain]), plain), true);
  assert.equal(agentsCannotClear("merge_conflict", land, plain), true);
});

const autoFixCiOff = (layers: StackLayerDto[]): StackDto => ({ ...stack(layers), cycloneCiOff: "stack_auto_fix_ci_off" });
const queuedCiJob = (minutesAgo = 1): Partial<StackLayerDto> => ({
  agentRuns: [{ agent: "cyclone", status: "queued", sha: HEAD, startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() }],
});
const ciHandoff = (reason = "ci_unverified") => ({ cycloneCiHandoff: { headSha: HEAD, reason, at: null } });

test("with auto-fix CI on, red CI while Cyclone's CI job is queued or the sweep is inside the enqueue grace is in_progress", async () => {
  for (const extra of [queuedCiJob(), { cycloneCiPendingSince: new Date(Date.now() - 30_000).toISOString() }]) {
    const result = await heldInProgress(harness(stack([layer({ ...redCi, ...extra })])).options);
    assert.equal(result.blocker, null, JSON.stringify(extra));
    assert.equal(result.actAfter, null);
    assert.deepEqual(result.busy.map((entry) => entry.agent), ["cyclone"]);
    assert.equal(result.repair, null);
  }
});

test("red CI whose CI enqueue grace or queued job went stale is attention again", async () => {
  for (const extra of [{ cycloneCiPendingSince: new Date(Date.now() - 3 * 60_000).toISOString() }, queuedCiJob(16)]) {
    const result = await pollStackWatch(cfg, "stack", harness(stack([layer({ ...redCi, ...extra })])).options);
    assert.equal(result.status, "attention", JSON.stringify(extra));
    assert.equal(result.repair?.kind, "ci_failure");
  }
});

test("after Cyclone hands the CI failure off at the head, the watch returns attention with the reason in the note", async () => {
  const result = await pollStackWatch(cfg, "stack", harness(stack([layer({ ...redCi, ...ciHandoff("ci_rerun_exhausted") })])).options);
  assert.equal(result.status, "attention");
  assert.equal(result.repair?.kind, "ci_failure");
  const repair = result.repair?.kind === "ci_failure" ? result.repair : null;
  assert.equal(repair?.note, `Cyclone tried to fix this failing CI at ${HEAD} and left it for a person (Cyclone already had Surge re-run this check once at this head), so it will not try this head again.`);
  const plain = stackBlockers(stack([layer(redCi)])).repair;
  assert.equal(repair?.steps, plain?.kind === "ci_failure" ? plain.steps : "");
});

test("with auto-fix CI off, red CI is attention with a note naming why, and the steps are unchanged", async () => {
  const result = await pollStackWatch(cfg, "stack", harness(autoFixCiOff([layer(redCi)])).options);
  assert.equal(result.status, "attention");
  const repair = result.repair?.kind === "ci_failure" ? result.repair : null;
  assert.equal(repair?.note, "Cyclone will not fix this failing CI by itself: auto-fix CI is off for this stack.");
  const plain = stackBlockers(stack([layer(redCi)])).repair;
  assert.equal(repair?.steps, plain?.kind === "ci_failure" ? plain.steps : "");
  assert.equal(plain?.kind === "ci_failure" ? plain.note : "", undefined);
  const account = stackBlockers({ ...stack([layer(redCi)]), cycloneCiOff: "account_auto_fix_ci_off" }).repair;
  assert.match(account?.kind === "ci_failure" ? account.note ?? "" : "", /auto-fix CI is off for the account and this stack does not turn it on/);
});

test("a CI handoff never changes the findings or conflict handoffs, and ci_failed stays agent-clearable", () => {
  assert.equal(stackBlockers(stack([changesRequested(ciHandoff())])).attention, null);
  assert.equal(stackBlockers(autoResolveOn([layer({ ...restackConflict, ...ciHandoff() })])).repair?.kind, "restack_conflict");
  const conflictRepair = stackBlockers(autoResolveOn([layer({ ...restackConflict, ...ciHandoff() })])).repair;
  assert.equal(conflictRepair?.kind === "restack_conflict" ? conflictRepair.note : "", undefined);
  assert.equal(agentsCannotClear("ci_failed", stack([layer(redCi)]), layer(redCi)), false);
  const held = stackBlockers(stack([layer({ ...redCi, ...vortexBusy, ...ciHandoff() })]));
  assert.equal(held.attention, null);
  assert.equal(held.held, null);
});

test("autoFixCiActive is off for the land PR, with the toggle off, and after a CI handoff at the head", () => {
  const plain = layer();
  assert.equal(autoFixCiActive(stack([plain]), plain), true);
  assert.equal(autoFixCiActive(autoFixCiOff([plain]), plain), false);
  assert.equal(autoFixCiActive(stack([plain]), layer(ciHandoff())), false);
  assert.equal(autoFixCiActive(stack([plain]), layer({ cycloneCiHandoff: { headSha: NEXT, reason: "x", at: null } })), true);
  assert.equal(autoFixCiActive(stack([plain]), layer(conflictHandoff())), true);
  assert.equal(autoFixCiActive(unitStack([plain], { landPrNumber: 42 }), plain), false);
});

test("pending CI that Cyclone left for a person at the head is named, with re-run steps and the hand-off note", () => {
  const cancelled = { ciStatus: "pending" as const, ...ciHandoff("ci_rerun_exhausted") };
  const result = stackBlockers(stack([layer(cancelled)]));
  assert.equal(result.attention?.blocker, CI_DID_NOT_FINISH_BLOCKER);
  const repair = result.repair?.kind === "ci_failure" ? result.repair : null;
  assert.match(repair?.steps ?? "", /gh run rerun <run-id>/);
  assert.match(repair?.note ?? "", /left it for a person/);
  assert.equal(stackBlockers(stack([layer({ ciStatus: "pending" })])).attention, null);
  assert.equal(stackBlockers(stack([layer({ ciStatus: "pending", cycloneCiHandoff: { headSha: NEXT, reason: "x", at: null } })])).attention, null);
});
