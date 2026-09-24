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
    issues: [], currentCandidate: { prNumber: 42, headSha: HEAD }, assessment: "available",
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
