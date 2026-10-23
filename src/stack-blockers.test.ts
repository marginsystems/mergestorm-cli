import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutoLandOffReason, MergeQueueEntryDto, StackDto, StackLayerDto } from "./stack-dto.js";
import {
  VORTEX_FINDINGS_NEED_PERSON,
  cycloneStatusWords,
  stackBlockers,
  stackBlockersSummary,
} from "./stack-blockers.js";

const HEAD = "a".repeat(40);

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

function stack(layers: StackLayerDto[], overrides: Partial<StackDto> = {}): StackDto {
  return { id: "stack", owner: "owner", repo: "repo", trunkBranch: "main", landTarget: "main", archivedAt: null,
    cycloneConflictOff: "account_auto_resolve_off", layers, ...overrides };
}

function timeoutBounce(): MergeQueueEntryDto {
  return {
    id: "bounce", stackId: "stack", owner: "owner", repo: "repo", state: "bounced", position: 0,
    waitReason: null, bounceReason: null,
    bounceDetail: { kind: "ci_timeout", headSha: HEAD, message: "Checks stayed in flight on aaaaaaa for 30 minutes" },
    enqueuedBy: "agent", enqueuedVia: "cli", enqueuedAt: "2026-01-01T00:00:00Z", attempts: 1,
    landedPrNumbers: [], verifyHeadSha: HEAD, verifyBaseSha: null, finishedAt: "2026-01-01T00:31:00Z",
  };
}

const green = { total: 2, success: 2, pending: 0, failure: 0, failingName: null };
const pending = { total: 2, success: 1, pending: 1, failure: 0, failingName: null };

test("a ci_timeout bounce is named while the checks on its head are still pending", () => {
  const result = stackBlockers(stack([layer({ ciStatus: "pending", checks: pending })]), [timeoutBounce()]);
  assert.equal(result.attention?.blocker, "CI timed out — Checks stayed in flight on aaaaaaa for 30 minutes");
  assert.equal(result.attention?.bounceKind, "ci_timeout");
});

test("a ci_timeout bounce is not named once every check on its head is green (#4582)", () => {
  const result = stackBlockers(stack([layer({ checks: green })]), [timeoutBounce()]);
  assert.equal(result.attention, null);
});

test("a ci_timeout bounce on a green head still reports Auto land off until it is turned back on (#4582)", () => {
  const off = stackBlockers(
    stack([layer({ checks: green })], { autoEnqueueWhenReady: false, autoLandOff: { reason: "bounced", entryId: "bounce", at: "2026-01-01T00:31:00Z" } }),
    [timeoutBounce()],
  );
  assert.equal(off.attention?.blocker, "Auto land off after ci_timeout bounce");
  assert.equal(off.attention?.bounceKind, "ci_timeout");
  assert.equal(off.repair?.kind, "auto_land_off");
  assert.match(off.repair?.steps ?? "", /Every check on feature is green at this head now, so nothing needs a change: do not patch or push for it/);
  assert.doesNotMatch(off.repair?.steps ?? "", /Fix the cause/);
  const rearmed = stackBlockers(stack([layer({ checks: green })], { autoEnqueueWhenReady: true }), [timeoutBounce()]);
  assert.equal(rearmed.attention, null);
});

test("a ci_timeout bounce on a head whose checks are still pending is never told nothing needs a change", () => {
  const off = stackBlockers(
    stack([layer({ ciStatus: "pending", checks: pending })], { autoEnqueueWhenReady: false, autoLandOff: { reason: "bounced", entryId: "bounce", at: "2026-01-01T00:31:00Z" } }),
    [timeoutBounce()],
  );
  assert.equal(off.attention?.bounceKind, "ci_timeout");
  assert.doesNotMatch(off.repair?.steps ?? "", /nothing needs a change/);
});

function offStack(reason: AutoLandOffReason, overrides: Partial<StackDto> = {}): StackDto {
  return stack([layer()], { autoEnqueueWhenReady: false,
    autoLandOff: { reason, entryId: null, at: "2026-01-01T00:10:00Z" }, ...overrides });
}

for (const [reason, why] of [
  ["cancelled", "its merge queue entry was cancelled"],
  ["watcher", "Mergestorm found nothing it could land"],
] as const) {
  test(`Auto land switched off with reason ${reason} is attention that tells the agent to ask before re-arming`, () => {
    const result = stackBlockers(offStack(reason));
    assert.deepEqual(result.attention,
      { prNumber: 42, headSha: HEAD, blocker: `Auto land switched off: ${why}`, bounceKind: null });
    assert.deepEqual(result.issues, []);
    assert.equal(result.repair?.kind, "auto_land_switched_off");
    assert.equal(result.repair?.kind === "auto_land_switched_off" && result.repair.offReason, reason);
    assert.match(result.repair?.steps ?? "", /do not patch or push for it/);
    assert.match(result.repair?.steps ?? "", /do not turn Auto land back on yourself/);
    assert.match(result.repair?.steps ?? "", /mg stack set stack --auto-land on\) only when they say so/);
  });
}

test("Auto land switched off by the human, an archive or a landing is not attention", () => {
  for (const reason of ["user", "archive", "landed"] as const) {
    assert.equal(stackBlockers(offStack(reason)).attention, null, reason);
  }
});

test("a stack that is armed again or archived is not reported as switched off", () => {
  assert.equal(stackBlockers(offStack("cancelled", { autoEnqueueWhenReady: true })).attention, null);
  assert.equal(stackBlockers(offStack("cancelled", { archivedAt: "2026-01-01T00:11:00Z" })).attention, null);
});

test("a live blocker on the current PR is reported before the switched-off attention", () => {
  const failing = offStack("cancelled", { layers: [layer({ ciStatus: "failure" })] });
  const result = stackBlockers(failing);
  assert.notEqual(result.attention, null);
  assert.notEqual(result.repair?.kind, "auto_land_switched_off");
  assert.doesNotMatch(result.attention?.blocker ?? "", /^Auto land switched off/);
});

test("the status line says a held fix was held and why, and repeats any other Cyclone status as it is", () => {
  const held = "rewrites existing test assertions (src/a.test.ts: removes or renames a test)";
  assert.equal(
    cycloneStatusWords(layer({ cycloneStatus: "held", cycloneHandoff: { headSha: HEAD, reason: "fix_held", at: null, detail: held } })),
    `held its fix, not pushed (${held})`,
  );
  assert.equal(
    cycloneStatusWords(layer({ cycloneStatus: "held", cycloneHandoff: { headSha: "b".repeat(40), reason: "fix_held", at: null, detail: held } })),
    "held its fix, not pushed",
  );
  assert.equal(cycloneStatusWords(layer({ cycloneStatus: "failed" })), "failed");
  assert.equal(cycloneStatusWords(layer({ cycloneStatus: "patching" })), "patching");
  assert.equal(cycloneStatusWords(layer()), null);
});

test("a CI fix Cyclone held on purpose is named as held, with the reason, and not as a failed CI fix", () => {
  const redCi = { ciStatus: "failure" as const, checks: { total: 1, success: 0, pending: 0, failure: 1, failingName: "lint" } };
  const held = "rewrites existing test assertions (src/a.test.ts: removes or renames a test)";
  const note = (handoff: StackLayerDto["cycloneCiHandoff"]) => {
    const repair = stackBlockers(stack([layer({ ...redCi, cycloneCiHandoff: handoff })])).repair;
    return repair?.kind === "ci_failure" ? repair.note : null;
  };
  assert.equal(
    note({ headSha: HEAD, reason: "ci_fix_held", at: null, detail: held }),
    `Cyclone tried to fix this failing CI at ${HEAD} and left it for a person (Cyclone wrote a CI fix and held it on purpose, so it pushed nothing: ${held}), so it will not try this head again.`,
  );
  assert.equal(
    note({ headSha: HEAD, reason: "ci_fix_held", at: null }),
    `Cyclone tried to fix this failing CI at ${HEAD} and left it for a person (Cyclone wrote a CI fix and held it on purpose, so it pushed nothing), so it will not try this head again.`,
  );
  assert.equal(
    note({ headSha: HEAD, reason: "ci_unresolved", at: null, detail: "boom" }),
    `Cyclone tried to fix this failing CI at ${HEAD} and left it for a person (Cyclone's CI fix failed), so it will not try this head again.`,
  );
});

const H1 = "332a61e".padEnd(40, "1");
const H2 = "827099e".padEnd(40, "2");
const H3 = "9c3b8f0".padEnd(40, "3");
const NOW = Date.parse("2026-10-18T10:44:00Z");

function review(head: string) {
  return { status: "done" as const, skip_reason: null, pass: 1, head_sha: head, phase: null,
    started_at: null, stoppable: false, source: "pr_reviews" as const };
}

function stack8Layer(overrides: Partial<StackLayerDto> & Pick<StackLayerDto, "prNumber" | "position" | "branch" | "headSha">): StackLayerDto {
  return {
    parentBranch: "mg-stack-8", state: "clean",
    openedAt: null, mergedAt: null, closedAt: null, additions: null, deletions: null,
    openAdditions: null, openDeletions: null, title: null, htmlUrl: null,
    ciStatus: "success", reviewStatus: "approved", checks: null, vortexStatus: "all_clear",
    cycloneStatus: null, conflictDetail: null, lastRestackedSha: null,
    mergeable: true, mergeableState: "clean", mergeableHeadSha: overrides.headSha,
    vortexReview: review(overrides.headSha!),
    ...overrides,
  };
}

function findings(prNumber: number, position: number, branch: string, headSha: string, parentBranch: string,
  reviewStatus: StackLayerDto["reviewStatus"], extra: Partial<StackLayerDto> = {}): StackLayerDto {
  return stack8Layer({
    prNumber, position, branch, headSha, parentBranch, reviewStatus, vortexStatus: "findings",
    agentRuns: [{ agent: "vortex", status: "findings", sha: headSha, findingCount: 2 }],
    ...extra,
  });
}

function stack8(overrides: { layers?: StackLayerDto[] } & Partial<StackDto> = {}): StackDto {
  return {
    id: "8f161154-5544-400c-91fe-6b1fdeff7354", owner: "marginsystems", repo: "mergestorm-agent-mac",
    trunkBranch: "mg-stack-8", landTarget: "main", archivedAt: null,
    autoEnqueueWhenReady: true, autoPatchOverride: false, cyclonePatchOff: "stack_auto_patch_off",
    autoLandWait: { reason: "vortex_not_green", prNumber: 1088, headSha: H2, since: "2026-10-18T09:15:38Z", attempts: null, detail: null },
    layers: [
      stack8Layer({ prNumber: 1087, position: 0, branch: "mac/one", headSha: H1 }),
      findings(1088, 1, "mac/two", H2, "mac/one", "changes_requested"),
      findings(1089, 2, "mac/three", H3, "mg-park-8-g1", "reviewed"),
    ],
    ...overrides,
  } as StackDto;
}

test("stack 8: findings on layer 2 with auto-patch off are attention behind a clean candidate", () => {
  const result = stackBlockers(stack8(), [], {}, NOW);
  assert.deepEqual(result.currentCandidate, { prNumber: 1087, headSha: H1 });
  assert.deepEqual(result.attention, { prNumber: 1088, headSha: H2, blocker: VORTEX_FINDINGS_NEED_PERSON, bounceKind: null });
  assert.equal(result.repair?.kind, "vortex_findings");
  assert.equal(result.repair?.prNumber, 1088);
  assert.equal(result.agents?.prNumber, 1088);
  assert.deepEqual(result.issues, []);
  assert.equal(
    stackBlockersSummary(result.attention, result.issues, result.busy, result.landGatePending, null, result.queueWait),
    ` · blocked: #1088 ${VORTEX_FINDINGS_NEED_PERSON}`,
  );
});

test("a comment verdict whose Important findings Cyclone handed to a person is attention, parked or not", () => {
  const base = stack8({ autoLandWait: null });
  base.layers[1] = stack8Layer({ prNumber: 1088, position: 1, branch: "mac/two", headSha: H2, parentBranch: "mac/one" });
  base.layers[2] = findings(1089, 2, "mac/three", H3, "mg-park-8-g1", "reviewed", {
    cycloneHandoff: { headSha: H3, reason: "failed", at: null },
  });
  const result = stackBlockers(base, [], {}, NOW);
  assert.deepEqual(result.attention, { prNumber: 1089, headSha: H3, blocker: VORTEX_FINDINGS_NEED_PERSON, bounceKind: null });
});

for (const reason of ["auto_patch_off", "no_changes", "hold"]) {
  test(`Important findings Cyclone declined on purpose (${reason}) do not stop landing and are not attention`, () => {
    const base = stack8({ autoLandWait: null, cyclonePatchOff: undefined, autoPatchOverride: null });
    base.layers[1] = stack8Layer({ prNumber: 1088, position: 1, branch: "mac/two", headSha: H2, parentBranch: "mac/one" });
    base.layers[2] = findings(1089, 2, "mac/three", H3, "mg-park-8-g1", "reviewed", {
      cycloneHandoff: { headSha: H3, reason, at: null },
    });
    const result = stackBlockers(base, [], {}, NOW);
    assert.equal(result.attention, null);
    assert.deepEqual(result.issues, []);
  });
}

test("request_changes on a layer Cyclone may still patch is not attention", () => {
  const base = stack8({ autoLandWait: null, cyclonePatchOff: undefined, autoPatchOverride: null });
  base.layers[2] = stack8Layer({ prNumber: 1089, position: 2, branch: "mac/three", headSha: H3, parentBranch: "mg-park-8-g1" });
  const result = stackBlockers(base, [], {}, NOW);
  assert.equal(result.attention, null);
  assert.deepEqual(result.issues, []);
});

test("clearing one blocker surfaces the next layer's blocker on the next read", () => {
  const before = stack8();
  before.layers[2] = stack8Layer({ prNumber: 1089, position: 2, branch: "mac/three", headSha: H3, parentBranch: "mg-park-8-g1",
    ciStatus: "failure", checks: { total: 1, success: 0, pending: 0, failure: 1, failingName: "swift test" } });
  const first = stackBlockers(before, [], {}, NOW);
  assert.equal(first.attention?.prNumber, 1088);
  assert.deepEqual(first.issues.map((issue) => issue.prNumber), [1089]);
  const after = structuredClone(before);
  after.layers[1] = stack8Layer({ prNumber: 1088, position: 1, branch: "mac/two", headSha: H2, parentBranch: "mac/one" });
  after.autoLandWait = null;
  const next = stackBlockers(after, [], {}, NOW);
  assert.deepEqual(next.attention, { prNumber: 1089, headSha: H3, blocker: "CI failed — swift test", bounceKind: null });
  assert.equal(next.repair?.kind, "ci_failure");
  assert.deepEqual(next.issues, []);
});

test("a blocked layer an agent is working is skipped for the next blocked layer", () => {
  const base = stack8();
  base.layers[0] = stack8Layer({ prNumber: 1087, position: 0, branch: "mac/one", headSha: H1, ciStatus: "failure",
    cycloneStatus: "patching", agentRuns: [{ agent: "cyclone", status: "patching", sha: H1 }] });
  const result = stackBlockers(base, [], {}, NOW);
  assert.deepEqual(result.attention, { prNumber: 1088, headSha: H2, blocker: VORTEX_FINDINGS_NEED_PERSON, bounceKind: null });
  assert.equal(result.repair?.kind, "vortex_findings");
  assert.equal(result.agents?.prNumber, 1088);
  assert.deepEqual(result.busy, []);
});

test("a stack whose only blocked layer is being patched stays held", () => {
  const base = stack8({ autoLandWait: null });
  base.layers[1] = findings(1088, 1, "mac/two", H2, "mac/one", "changes_requested", {
    ciStatus: "failure", cycloneStatus: "patching", agentRuns: [{ agent: "cyclone", status: "patching", sha: H2 }],
  });
  const result = stackBlockers(base, [], {}, NOW);
  assert.equal(result.attention, null);
});

type Shape = "clean" | "ci" | "findings" | "draft" | "conflict" | "warnings";

const BLOCKING_SHAPES: readonly Shape[] = ["ci", "findings", "draft", "conflict"];

function shaped(prNumber: number, position: number, shape: Shape, busy: boolean): StackLayerDto {
  const branch = `mac/${position}`;
  const headSha = String(position + 1).repeat(40);
  const parentBranch = position === 0 ? "mg-stack-8" : position === 1 ? "mac/0" : "mg-park-8-g1";
  const agent: Partial<StackLayerDto> = busy
    ? { cycloneStatus: "patching", agentRuns: [{ agent: "cyclone", status: "patching", sha: headSha }] }
    : {};
  switch (shape) {
    case "ci": return stack8Layer({ prNumber, position, branch, headSha, parentBranch, ciStatus: "failure", ...agent });
    case "findings": return findings(prNumber, position, branch, headSha, parentBranch, "changes_requested", agent);
    case "warnings": return findings(prNumber, position, branch, headSha, parentBranch, "reviewed", agent);
    case "draft": return stack8Layer({ prNumber, position, branch, headSha, parentBranch, draft: true, ...agent });
    case "conflict": return stack8Layer({ prNumber, position, branch, headSha, parentBranch, state: "conflict", ...agent });
    default: return stack8Layer({ prNumber, position, branch, headSha, parentBranch, ...agent });
  }
}

test("invariant: attention is the lowest blocked layer no agent works, and never null while Auto land waits on one", () => {
  const shapes: Shape[] = ["clean", "ci", "findings", "draft", "conflict", "warnings"];
  let waitedOnActionable = 0;
  for (const s0 of shapes) for (const s1 of shapes) for (const s2 of shapes) {
    for (const busyMask of [0, 1, 2, 4, 7]) {
      const shapesHere = [s0, s1, s2];
      const busyAt = (index: number) => (busyMask & (1 << index)) !== 0;
      const layers = shapesHere.map((shape, index) => shaped(1087 + index, index, shape, busyAt(index)));
      const blocked = shapesHere.flatMap((shape, index) => BLOCKING_SHAPES.includes(shape) ? [index] : []);
      const waited = blocked.length ? layers[blocked[0]!]! : null;
      const result = stackBlockers(stack8({
        layers,
        autoLandWait: waited
          ? { reason: "vortex_not_green", prNumber: waited.prNumber, headSha: waited.headSha!, since: "2026-10-18T09:15:38Z", attempts: null, detail: null }
          : null,
      }), [], {}, NOW);
      const actionable = blocked.filter((index) => !busyAt(index));
      const label = `${shapesHere.join("/")} busy=${busyMask}`;
      if (!actionable.length) {
        assert.equal(result.attention, null, label);
        continue;
      }
      assert.equal(result.attention?.prNumber, 1087 + actionable[0]!, label);
      if (waited && actionable.includes(blocked[0]!)) waitedOnActionable += 1;
    }
  }
  assert.ok(waitedOnActionable > 100, `only ${waitedOnActionable} cases waited on an actionable layer`);
});

const SETTLED = "2026-10-20T10:00:00Z";
const settledPlus = (minutes: number) => Date.parse(SETTLED) + minutes * 60_000;

function reviewedAt(reviewStatus: StackLayerDto["reviewStatus"], overrides: Partial<StackLayerDto> = {}): StackLayerDto {
  return layer({
    vortexStatus: "findings", reviewStatus,
    vortexReview: { status: "done", skip_reason: null, pass: 1, head_sha: HEAD, phase: null, started_at: null,
      stoppable: false, source: "pr_reviews", settled_at: SETTLED },
    agentRuns: [],
    ...overrides,
  });
}

test("a failed Cyclone check with no handoff row leaves request_changes findings as agent attention", () => {
  const result = stackBlockers(stack([reviewedAt("changes_requested", { cycloneStatus: "failed" })]), [], {}, settledPlus(1));
  assert.equal(result.attention?.blocker, VORTEX_FINDINGS_NEED_PERSON);
  assert.equal(result.repair?.kind, "vortex_findings");
  assert.equal(result.repair?.kind === "vortex_findings" ? result.repair.handoff : null, "failed");
  assert.match(result.repair?.steps ?? "", /You fix them/);
});

test("Cyclone never running at a head with request_changes findings is attention after 30 minutes", () => {
  const never = stack([reviewedAt("changes_requested", { cycloneFindingsTakenAtHead: false })]);
  assert.equal(stackBlockers(never, [], {}, settledPlus(29)).attention, null);
  const late = stackBlockers(never, [], {}, settledPlus(30));
  assert.equal(late.attention?.blocker, VORTEX_FINDINGS_NEED_PERSON);
  assert.equal(late.repair?.kind === "vortex_findings" ? late.repair.handoff : null, "not_run");
  assert.match(late.repair?.steps ?? "", /Cyclone has not run on this head in the 30 minutes since Vortex posted these findings/);
});

test("request_changes findings Cyclone settled at the head, or a producer that does not say, are not named as not run", () => {
  for (const settled of [true, undefined]) {
    const result = stackBlockers(stack([reviewedAt("changes_requested", { cycloneFindingsTakenAtHead: settled })]), [], {}, settledPlus(120));
    assert.equal(result.attention, null, String(settled));
  }
});

test("Important findings with no handoff row stay advisory: a failed Cyclone check or no Cyclone run is not attention", () => {
  for (const extra of [{ cycloneStatus: "failed" as const }, { cycloneFindingsTakenAtHead: false }]) {
    assert.equal(stackBlockers(stack([reviewedAt("reviewed", extra)]), [], {}, settledPlus(120)).attention, null, JSON.stringify(extra));
  }
});

test("Cyclone not running is not named while it is patching, on a throttled head, or before the review settles", () => {
  const busy = reviewedAt("changes_requested", { cycloneFindingsTakenAtHead: false, cycloneStatus: "patching" });
  assert.equal(stackBlockers(stack([busy]), [], {}, settledPlus(120)).attention, null);
  const throttled = reviewedAt("changes_requested", { cycloneFindingsTakenAtHead: false, vortexStatus: "throttled" });
  assert.equal(stackBlockers(stack([throttled]), [], {}, settledPlus(120)).attention, null);
  const unsettled = reviewedAt("changes_requested", { cycloneFindingsTakenAtHead: false });
  unsettled.vortexReview = { ...unsettled.vortexReview!, settled_at: null };
  assert.equal(stackBlockers(stack([unsettled]), [], {}, settledPlus(120)).attention, null);
});

for (const reason of ["fix_held", "left_for_human", "failed", "infra_failure", "patch_job_lost", "pr_state_unavailable", "vortex_patch_cap",
  "unsupported_language", "credits_exhausted", "no_billing", "policy_owner_changed"]) {
  test(`a Cyclone ${reason} handoff names agent work, not a person`, () => {
    const result = stackBlockers(stack([reviewedAt("reviewed", { cycloneHandoff: { headSha: HEAD, reason, at: null } })]), [], {}, settledPlus(1));
    assert.equal(result.attention?.blocker, VORTEX_FINDINGS_NEED_PERSON);
    assert.match(result.repair?.steps ?? "", /You fix them/);
    assert.match(result.repair?.steps ?? "", /Dismiss a finding you verified is wrong yourself: mg dismiss owner\/repo#42/);
    assert.doesNotMatch(result.repair?.steps ?? "", /tell the human/);
  });
}

test("a failed Vortex review with no retry is the hard block, ahead of Cyclone's handoff on the same head", () => {
  const failed = layer({
    vortexStatus: "failed", reviewStatus: "changes_requested",
    vortexReview: { status: "failed", skip_reason: null, pass: 1, head_sha: HEAD, phase: null, started_at: null, stoppable: false, source: "pr_reviews" },
    cycloneHandoff: { headSha: HEAD, reason: "left_for_human", at: null },
  });
  const result = stackBlockers(stack([failed]), [], {}, settledPlus(1));
  assert.equal(result.attention?.blocker, "Review failed");
  assert.equal(result.repair?.kind, "vortex_failed");
  const retrying = { ...failed, vortexReview: { ...failed.vortexReview!, skip_reason: "retry_scheduled" } };
  assert.notEqual(stackBlockers(stack([retrying]), [], {}, settledPlus(1)).attention?.blocker, "Review failed");
});

test("the 2026-10-19 cases are attention: #45 fix_held, #1970 left_for_human, #1964 conflict with auto-resolve off", () => {
  const held = stackBlockers(stack([reviewedAt("reviewed", { prNumber: 45, cycloneStatus: "held",
    cycloneHandoff: { headSha: HEAD, reason: "fix_held", at: null, detail: "accounting parse failed" } })]), [], {}, settledPlus(1));
  assert.equal(held.attention?.prNumber, 45);
  assert.equal(held.repair?.kind, "vortex_findings");
  const left = stackBlockers(stack([reviewedAt("reviewed", { prNumber: 1970,
    cycloneHandoff: { headSha: HEAD, reason: "left_for_human", at: null } })]), [], {}, settledPlus(1));
  assert.equal(left.attention?.prNumber, 1970);
  assert.equal(left.repair?.kind, "vortex_findings");
  const conflict = stackBlockers(stack([layer({ prNumber: 1964, mergeable: false, mergeableState: "dirty" })],
    { cycloneConflictOff: "account_auto_resolve_off" }), [], {}, settledPlus(1));
  assert.equal(conflict.attention?.prNumber, 1964);
  assert.equal(conflict.repair?.kind, "merge_conflict");
  assert.match(conflict.repair && "note" in conflict.repair ? conflict.repair.note ?? "" : "", /auto-resolve conflicts is off for the account/);
});
