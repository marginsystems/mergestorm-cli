import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutoLandOffReason, MergeQueueEntryDto, StackDto, StackLayerDto } from "./stack-dto.js";
import { cycloneStatusWords, stackBlockers } from "./stack-blockers.js";

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
