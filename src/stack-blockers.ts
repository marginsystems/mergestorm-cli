import {
  deriveStackAgentsBusy,
  mergeQueueBounceLabel,
  restackRetryPending,
  type MergeQueueEntryDto,
  type StackAgentsBusy,
  type StackDto,
  type StackLayerDto,
} from "./stack-dto.js";
import type { StackWatchCursor } from "./stack-watch.js";

export type StackBlocker = {
  prNumber: number;
  headSha: string | null;
  blocker: string;
  bounceKind: string | null;
};

export type StackAgentBusy = {
  prNumber: number;
  headSha: string | null;
  agent: "vortex" | "cyclone";
  blocker: string;
};

export type StackBusyAgent = StackAgentBusy["agent"];

export type StackHeldBlocker = StackBlocker & {
  actAfter: "agents_idle";
  waitingOn: StackBusyAgent[];
};

export type StackLayerAgents = {
  prNumber: number;
  headSha: string | null;
  vortexStatus: StackLayerDto["vortexStatus"];
  cycloneStatus: StackLayerDto["cycloneStatus"];
  vortexReview: { status: string; headSha: string | null; pass: number | null } | null;
  busy: { vortex: boolean; cyclone: boolean };
};

export type StackRepairHint =
  | {
    kind: "restack_conflict" | "merge_conflict";
    prNumber: number;
    headSha: string | null;
    branch: string;
    liveParent: string | null;
    files: string[];
    steps: string;
  }
  | {
    kind: "ci_failure";
    prNumber: number;
    headSha: string | null;
    branch: string;
    failingCheck: string | null;
    steps: string;
  }
  | {
    kind: "tempest_findings";
    prNumber: number;
    headSha: string | null;
    branch: string;
    findings: string;
    steps: string;
  }
  | {
    kind: "tempest_rerun";
    prNumber: number;
    headSha: string | null;
    branch: string;
    stoppedByPerson: boolean;
    steps: string;
  }
  | {
    kind: "vortex_findings";
    prNumber: number;
    headSha: string | null;
    branch: string;
    handoff: string | null;
    findings: string;
    steps: string;
  }
  | {
    kind: "unit_abandoned";
    prNumber: number;
    headSha: string | null;
    branch: string;
    steps: string;
  }
  | {
    kind: "restack_failed";
    prNumber: number;
    headSha: string | null;
    branch: string;
    liveParent: string | null;
    restackKind: string;
    steps: string;
  }
  | {
    kind: "seam_review_stuck";
    prNumber: number;
    headSha: string | null;
    branch: string;
    seamState: string;
    steps: string;
  }
  | {
    kind: "auto_land_off";
    prNumber: number;
    headSha: string | null;
    branch: string;
    bounceKind: string;
    steps: string;
  }
  | {
    kind: "ci_pending" | "vortex_not_green";
    prNumber: number;
    headSha: string | null;
    branch: string;
    since: string;
    steps: string;
  }
  | {
    kind: "queue_stalled";
    prNumber: number;
    headSha: string | null;
    branch: string;
    since: string | null;
    waitReason: string | null;
    steps: string;
  }
  | {
    kind: "vortex_skipped";
    prNumber: number;
    headSha: string | null;
    branch: string;
    skipReason: string;
    steps: string;
  }
  | {
    kind: "promote_failed";
    prNumber: number;
    headSha: string | null;
    branch: string;
    attempts: number;
    message: string | null;
    steps: string;
  };

export type StackLandGatePending = {
  prNumber: number;
  headSha: string | null;
  reason: string;
};

export function landGateIsPending(reason: string | null | undefined): boolean {
  const token = reason?.trim().replace(/^landing blocked:\s*/i, "").match(/^[a-z_]+/i)?.[0] ?? "";
  return /_(?:pending|running)$/i.test(token);
}

export function layerAgentsBusy(layer: StackLayerDto): StackAgentsBusy {
  return layer.agentsBusy ?? deriveStackAgentsBusy(layer);
}

export function layerAgents(layer: StackLayerDto): StackLayerAgents {
  const busy = layerAgentsBusy(layer);
  const review = layer.vortexReview;
  return {
    prNumber: layer.prNumber,
    headSha: layer.headSha ?? null,
    vortexStatus: layer.vortexStatus ?? null,
    cycloneStatus: layer.cycloneStatus ?? null,
    vortexReview: review ? { status: review.status, headSha: review.head_sha, pass: review.pass } : null,
    busy: { vortex: busy.vortex, cyclone: busy.cyclone },
  };
}

export function isMgParkBase(branch: string | null | undefined): boolean {
  return (branch ?? "").trim().toLowerCase().startsWith("mg-park-");
}

/** GitHub DIRTY vs an mg-park-* freeze is not a merge conflict, verified or not. */
export function boundDirty(layer: StackLayerDto): boolean {
  if (isMgParkBase(layer.parentBranch)) return false;
  if (layer.mergeable == null) return false;
  return (!layer.headSha || layer.mergeableHeadSha === layer.headSha) &&
    (layer.mergeable === false || layer.mergeableState?.toLowerCase() === "dirty");
}

export function mergeabilityPending(layer: StackLayerDto): boolean {
  if (isMgParkBase(layer.parentBranch)) return false;
  return layer.mergeable == null && !!layer.headSha && layer.mergeableHeadSha === layer.headSha &&
    layer.mergeableState?.toLowerCase() === "pending";
}

export function sameHead(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = a?.trim().toLowerCase();
  const right = b?.trim().toLowerCase();
  return !!left && !!right && (left.length === right.length
    ? left === right
    : left.startsWith(right) || right.startsWith(left));
}

export function currentLayer(stack: StackDto): StackLayerDto | undefined {
  const open = stack.layers.filter((layer) =>
    layer.prNumber > 0 && layer.state !== "merged" && layer.state !== "closed",
  );
  const promote = open.filter((layer) =>
    layer.prNumber !== stack.unit?.landPrNumber &&
    !stack.unit?.members?.some((member) => member.prNumber === layer.prNumber && member.promotedHeadSha),
  ).sort((a, b) => a.position - b.position);
  const land = stack.unit?.landPr;
  return promote[0] ?? open.find((layer) => layer.prNumber === stack.unit?.landPrNumber) ??
    (land && land.prNumber > 0 && land.state !== "merged" && land.state !== "closed" ? land : undefined);
}

export const RESTACK_FAILED = "Restack failed";

export const SEAM_REVIEW_NOT_RUNNING = "Seam review pending, no review running";

export const VORTEX_REVIEW_OUT_OF_QUOTA = "Review skipped, out of review quota";

export const SEAM_REVIEW_STUCK = "Seam review stuck in reviewing, no review running";

export const SEAM_REREVIEW_NOT_RUNNING = "Seam re-review pending, no review running";

export const SEAM_VERDICT_STALE = "Seam verdict is for an older head, no review running";

const STUCK_SEAM_BLOCKERS: readonly string[] = [SEAM_REVIEW_STUCK, SEAM_REREVIEW_NOT_RUNNING, SEAM_VERDICT_STALE];

function coreReviewDoneAtHead(layer: StackLayerDto): boolean {
  const review = layer.vortexReview;
  return review?.status === "done" && sameHead(review.head_sha, layer.headSha);
}

export const VORTEX_FINDINGS_NEED_PERSON = "Vortex findings need a person";

function vortexChangesRequestedAtHead(layer: StackLayerDto): boolean {
  const review = layer.vortexReview;
  if (review && !(review.status === "done" && sameHead(review.head_sha, layer.headSha))) return false;
  return layer.vortexStatus === "findings" && layer.reviewStatus === "changes_requested";
}

function cycloneHandoffAtHead(stack: StackDto, layer: StackLayerDto): string | null {
  if (sameHead(layer.cycloneHandoff?.headSha, layer.headSha)) return layer.cycloneHandoff!.reason;
  return stack.cyclonePatchOff ?? (stack.autoPatchOverride === false ? "auto_patch_off" : null);
}

const CYCLONE_HANDOFF_WORDS: Readonly<Record<string, string>> = {
  auto_patch_off: "auto-patch is off for this stack",
  stack_auto_patch_off: "auto-patch is off for this stack",
  account_auto_patch_off: "auto-patch is off for the account and this stack does not turn it on",
  cyclone_not_connected: "Cyclone is not connected to this repo",
};

function cycloneHandoffWords(reason: string): string {
  return CYCLONE_HANDOFF_WORDS[reason] ?? reason.replaceAll("_", " ");
}

function vortexFindingsLeftForPerson(stack: StackDto, layer: StackLayerDto): boolean {
  return vortexChangesRequestedAtHead(layer) && !layerAgentsBusy(layer).cyclone &&
    cycloneHandoffAtHead(stack, layer) !== null;
}

function quotaSkippedReview(layer: StackLayerDto): boolean {
  const review = layer.vortexReview;
  return review?.status === "skipped" && review.skip_reason === "quota_exceeded" &&
    sameHead(review.head_sha, layer.headSha);
}

export const VORTEX_AUTO_REVIEW_OFF = "Vortex auto-review is off, so this head was not reviewed";

export const VORTEX_BILLING_SKIPPED = "Vortex skipped this head: it could not confirm billing";

export const VORTEX_REVIEW_INCOMPLETE = "Vortex reviewed only part of this PR";

const VORTEX_SKIP_BLOCKERS: Readonly<Record<string, string>> = {
  auto_review_off: VORTEX_AUTO_REVIEW_OFF,
  billing_blocked: VORTEX_BILLING_SKIPPED,
  billing_unavailable: VORTEX_BILLING_SKIPPED,
};

function vortexIdleSkipBlocker(layer: StackLayerDto): { blocker: string; skipReason: string } | null {
  if (layerAgentsBusy(layer).vortex) return null;
  const review = layer.vortexReview;
  if (review?.status === "skipped" && sameHead(review.head_sha, layer.headSha)) {
    const reason = review.skip_reason?.trim() ?? "";
    const blocker = VORTEX_SKIP_BLOCKERS[reason];
    if (blocker) return { blocker, skipReason: reason };
  }
  if (layer.vortexStatus === "incomplete" && sameHead(review?.head_sha, layer.headSha)) {
    return { blocker: VORTEX_REVIEW_INCOMPLETE, skipReason: "incomplete" };
  }
  return null;
}

function vortexSkippedSteps(stack: StackDto, layer: StackLayerDto, skipReason: string): string {
  const head = layer.headSha ?? "its live head";
  const mention = `comment @mergestorm-vortex review on #${layer.prNumber}`;
  if (skipReason === "auto_review_off") {
    return `Vortex auto-review is off for ${stack.owner}/${stack.repo} or for this stack, so it skipped #${layer.prNumber} at ${head} and Auto land waits for a review that will not come. Do not patch or push for this. Tell the human: they can turn auto-review on (mg stack set ${stack.id} --auto-review on, or the repo setting in the dashboard), which does not review this head by itself, and then ${mention} to review it now.`;
  }
  if (skipReason === "incomplete") {
    return `Vortex reviewed only some of the files in #${layer.prNumber} at ${head} and left the rest unreviewed, so Auto land waits for full coverage. Do not patch or push for this. To review the remaining files, ${mention} (the Continue button on the stack is unrelated), or tell the human to do it; turning on automatic overflow reviews in the dashboard settings covers this for later heads.`;
  }
  return `Vortex skipped #${layer.prNumber} at ${head} because it could not confirm billing for this account, so Auto land waits for a review that will not come. Do not patch or push for this. Re-run the review: ${mention}. If it is skipped again, tell the human to check the plan and billing in the Mergestorm dashboard.`;
}

function seamGateBlocker(stack: StackDto, layer: StackLayerDto): string | null {
  const members = stack.unit?.members ?? [];
  if (layer.prNumber === stack.unit?.landPrNumber) return null;
  if (!members.some((member) => member.promotedHeadSha?.trim())) return null;
  const member = members.find((entry) => entry.prNumber === layer.prNumber);
  if (!member || member.promotedHeadSha?.trim()) return null;
  const seamState = member.seamState?.trim().toLowerCase();
  if (seamState === "failed") return "Seam review failed";
  if (seamState === "findings" && sameHead(member.seamReviewedSha, layer.headSha)) return "Seam findings";
  if (layerAgentsBusy(layer).vortex) return null;
  if (seamState === "pending") return SEAM_REVIEW_NOT_RUNNING;
  if (seamState === "reviewing") return SEAM_REVIEW_STUCK;
  if (seamState === "pending_rereview") return SEAM_REREVIEW_NOT_RUNNING;
  if (!layer.headSha?.trim() || sameHead(member.seamReviewedSha, layer.headSha)) return null;
  if (seamState === "findings") return SEAM_VERDICT_STALE;
  if (seamState === "approved" && !coreReviewDoneAtHead(layer)) return SEAM_VERDICT_STALE;
  return null;
}

function headChecksAllGreen(layer: StackLayerDto): boolean {
  const checks = layer.checks;
  return layer.ciStatus === "success" && !!checks && checks.total > 0 &&
    checks.failure === 0 && checks.pending === 0 && checks.success > 0;
}

/** Shared live-fact precedence; bounce history is only passed for the candidate. */
function layerAttention(
  stack: StackDto,
  layer: StackLayerDto | undefined,
  queue: MergeQueueEntryDto[],
  cursor: Pick<StackWatchCursor, "bounceId" | "afterFinishedAt">,
): { blocker: string | null; bounceKind: string | null; bounce?: MergeQueueEntryDto } {
  const none = { blocker: null, bounceKind: null };
  if (stack.archivedAt) return none;
  const bounce = queue.filter((entry) => entry.state === "bounced")
    .sort((a, b) => (Date.parse(b.finishedAt ?? "") || 0) - (Date.parse(a.finishedAt ?? "") || 0))[0];
  const kind = bounce?.bounceDetail?.kind;
  const recoverable = kind === "head_moved" || kind === "must_consolidate";
  const hardBlock = (blocker: string) => ({ blocker, bounceKind: null });
  if (layer) {
    if (layer.restackError && layer.state !== "restacking") {
      if (layer.restackError.kind === "rebase_conflict") return hardBlock("Conflict");
      if (!restackRetryPending(layer.restackError, layer)) return hardBlock(RESTACK_FAILED);
    }
    if (layer.state === "conflict") return hardBlock("Conflict");
    if (layer.draft) return {
      blocker: "Draft PR", bounceKind: "pr_draft",
      ...(kind === "pr_draft" && sameHead(bounce.bounceDetail?.headSha ?? bounce.verifyHeadSha, layer.headSha) &&
        (bounce.bounceDetail?.prNumber == null || bounce.bounceDetail.prNumber === layer.prNumber) ? { bounce } : {}),
    };
    if (boundDirty(layer)) return hardBlock(`Merge conflicts${layer.parentBranch ? ` vs ${layer.parentBranch}` : ""}`);
    if (layer.ciStatus === "failure" || (layer.checks?.failure ?? 0) > 0) {
      const name = layer.checks?.failingName?.trim();
      return hardBlock(`CI failed${name ? ` — ${name}` : ""}`);
    }
    if (layer.agentRuns?.some((run) => run.agent === "cyclone" && run.status === "failed" &&
      sameHead(run.sha, layer.headSha))) return hardBlock("Cyclone failed");
    const tempest = layer.agentRuns?.find((run) => run.agent === "tempest" &&
      run.status === "findings" && sameHead(run.sha, layer.headSha));
    if (tempest) return hardBlock(`Tempest ${tempest.status}`);
    if (layer.vortexStatus === "failed") return hardBlock("Review failed");
    if (quotaSkippedReview(layer)) return hardBlock(VORTEX_REVIEW_OUT_OF_QUOTA);
    const vortexSkip = vortexIdleSkipBlocker(layer);
    if (vortexSkip) return hardBlock(vortexSkip.blocker);
    const seam = seamGateBlocker(stack, layer);
    if (seam) return hardBlock(seam);
    if (unitAbandonedUnder(stack, layer)) {
      return hardBlock(`${UNIT_ABANDONED_BLOCKER_PREFIX}${layer.parentBranch?.trim() || stack.trunkBranch}`);
    }
    if (stack.unit?.landPrNumber === layer.prNumber) {
      const landing = stack.unit.landingBlockReason?.trim();
      if (landing && !landGateIsPending(landing)) return hardBlock(landing);
      if (stack.unit.tempestLandStatus?.toLowerCase() === "failed") return hardBlock("Tempest failed");
    }
    if (vortexFindingsLeftForPerson(stack, layer)) return hardBlock(VORTEX_FINDINGS_NEED_PERSON);
  }
  if (!bounce || !kind || recoverable || !layer || queue.some((entry) => ["queued", "running", "waiting"].includes(entry.state))) return none;
  if ((cursor.bounceId != null && cursor.bounceId === bounce.id) || (cursor.afterFinishedAt &&
    !(Date.parse(bounce.finishedAt ?? "") > Date.parse(cursor.afterFinishedAt)))) return none;
  // Compare with the observed promote/land head, never the enrollment or verify head.
  if (!sameHead(bounce.bounceDetail?.headSha ?? bounce.verifyHeadSha, layer.headSha) ||
    (bounce.bounceDetail?.prNumber != null && bounce.bounceDetail.prNumber !== layer.prNumber)) return none;
  if (kind === "ci_failure" && !bounce.bounceDetail?.batch && headChecksAllGreen(layer)) return none;
  return { blocker: mergeQueueBounceLabel(bounce), bounceKind: kind, bounce };
}

const UNIT_ABANDONED_BLOCKER_PREFIX = "Review unit abandoned: based on ";

function unitAbandonedUnder(stack: StackDto, layer: StackLayerDto): boolean {
  if (stack.unit?.state !== "abandoned") return false;
  const open = stack.layers.filter((candidate) => candidate.prNumber > 0 && !isTerminalLayer(candidate))
    .sort((a, b) => a.position - b.position);
  return open.length > 0 && open[0]!.prNumber === layer.prNumber;
}

const AUTO_LAND_DISARMING_BOUNCE_KINDS: readonly string[] = ["merge_failed", "gh_error", "ci_timeout"];
const AUTO_LAND_OFF_BLOCKER_PREFIX = "Auto land off after ";

function isDisarmingBounce(entry: MergeQueueEntryDto | undefined): entry is MergeQueueEntryDto {
  const kind = entry?.bounceDetail?.kind;
  return entry?.state === "bounced" && !!kind && AUTO_LAND_DISARMING_BOUNCE_KINDS.includes(kind);
}

function disarmingBounce(stack: StackDto, queue: MergeQueueEntryDto[]): MergeQueueEntryDto | undefined {
  if (stack.archivedAt || stack.autoEnqueueWhenReady !== false) return undefined;
  const byRecency = [...queue].sort((a, b) =>
    (Date.parse(b.enqueuedAt) || 0) - (Date.parse(a.enqueuedAt) || 0) ||
    (Date.parse(b.finishedAt ?? "") || 0) - (Date.parse(a.finishedAt ?? "") || 0));
  if (stack.autoLandOff === undefined) {
    return isDisarmingBounce(byRecency[0]) ? byRecency[0] : undefined;
  }
  if (stack.autoLandOff?.reason !== "bounced") return undefined;
  const recorded = queue.find((entry) => entry.id === stack.autoLandOff?.entryId);
  if (isDisarmingBounce(recorded)) return recorded;
  return undefined;
}

export const AUTO_LAND_CI_PENDING_ATTENTION_MS = 45 * 60_000;
export const AUTO_LAND_VORTEX_WAIT_ATTENTION_MS = 30 * 60_000;
export const AUTO_LAND_PROMOTE_FAILED_ATTEMPTS = 3;
export const AUTO_LAND_CI_FAILED_BLOCKER = "CI failed — Auto land reads a failing check on GitHub at this head";
const AUTO_LAND_CI_PENDING_PREFIX = "CI pending for ";
const AUTO_LAND_VORTEX_WAIT_PREFIX = "No green Vortex review for ";
const AUTO_LAND_PROMOTE_FAILED_PREFIX = "Promote failed ";

type AutoLandWaitDto = NonNullable<StackDto["autoLandWait"]>;

function waitedMs(since: string, nowMs: number): number | null {
  const sinceMs = Date.parse(since);
  return Number.isFinite(sinceMs) ? Math.max(0, nowMs - sinceMs) : null;
}

function autoLandWaitOn(stack: StackDto, layer: StackLayerDto): AutoLandWaitDto | null {
  const wait = stack.autoLandWait;
  if (!wait || stack.archivedAt || stack.autoEnqueueWhenReady !== true) return null;
  if (wait.prNumber !== layer.prNumber || !sameHead(wait.headSha, layer.headSha)) return null;
  return wait;
}

export function autoLandWaitBlocker(stack: StackDto, layer: StackLayerDto, nowMs: number): string | null {
  const wait = autoLandWaitOn(stack, layer);
  if (!wait) return null;
  const waited = waitedMs(wait.since, nowMs);
  if (waited == null) return null;
  const minutes = Math.floor(waited / 60_000);
  switch (wait.reason) {
    case "ci_failure":
      return AUTO_LAND_CI_FAILED_BLOCKER;
    case "ci_pending":
      return waited >= AUTO_LAND_CI_PENDING_ATTENTION_MS
        ? `${AUTO_LAND_CI_PENDING_PREFIX}${minutes}m — a check on this head has not finished, so Auto land will not queue it`
        : null;
    case "vortex_not_green":
      return waited >= AUTO_LAND_VORTEX_WAIT_ATTENTION_MS
        ? `${AUTO_LAND_VORTEX_WAIT_PREFIX}${minutes}m — Auto land is waiting for an approving Vortex review at this head`
        : null;
    case "promote_merge_failed":
      return (wait.attempts ?? 0) >= AUTO_LAND_PROMOTE_FAILED_ATTEMPTS
        ? `${AUTO_LAND_PROMOTE_FAILED_PREFIX}${wait.attempts} times (merge_failed) — Auto land stopped retrying this head${wait.detail ? `: ${wait.detail}` : ""}`
        : null;
    default:
      return null;
  }
}

export const MERGE_QUEUE_STALL_ATTENTION_MS = 45 * 60_000;
const MERGE_QUEUE_STALLED_PREFIX = "Merge queue stuck: ";
const LIVE_QUEUE_STATES: readonly string[] = ["queued", "running", "waiting"];

export type StackQueueWait = {
  prNumber: number;
  headSha: string | null;
  text: string;
  since: string | null;
  waitReason: string | null;
};

export type MergeQueueWait = {
  text: string;
  stalled: boolean;
  since: string | null;
  waitReason: string | null;
  aheadStackId: string | null;
  aheadOther: boolean;
};

function minutesOf(ms: number | null): number {
  return ms == null ? 0 : Math.floor(ms / 60_000);
}

export function mergeQueueWait(queue: readonly MergeQueueEntryDto[], nowMs: number): MergeQueueWait | null {
  const entry = queue.find((candidate) => LIVE_QUEUE_STATES.includes(candidate.state));
  if (!entry) return null;
  const reason = entry.waitReason?.trim() || null;
  if (entry.state === "queued") {
    const queuedFor = minutesOf(waitedMs(entry.enqueuedAt, nowMs));
    const ahead = entry.aheadInRepo;
    if (!ahead) {
      return {
        text: `Queued ${queuedFor}m in the merge queue, not picked up yet${reason ? ` (last note: ${reason})` : ""}`,
        stalled: false,
        since: entry.enqueuedAt, waitReason: reason, aheadStackId: null, aheadOther: false,
      };
    }
    const aheadMs = ahead.claimedAt ? waitedMs(ahead.claimedAt, nowMs) : null;
    const aheadReason = ahead.waitReason?.trim() || null;
    const who = ahead.stackId ? `stack ${ahead.stackId}` : "another user's stack";
    const aheadFor = aheadMs == null ? "an unknown duration" : `${minutesOf(aheadMs)}m`;
    return {
      text: `Queued ${queuedFor}m behind ${who}, which has been ${ahead.state} in the merge queue for ${aheadFor}${aheadReason ? `: ${aheadReason}` : ""}`,
      stalled: aheadMs != null && aheadMs >= MERGE_QUEUE_STALL_ATTENTION_MS,
      since: ahead.claimedAt, waitReason: aheadReason, aheadStackId: ahead.stackId, aheadOther: !ahead.stackId,
    };
  }
  const since = entry.claimedAt ?? null;
  const liveMs = since === null ? null : waitedMs(since, nowMs);
  const liveFor = liveMs == null ? "an unknown duration" : `${minutesOf(liveMs)}m`;
  return {
    text: `Merge queue ${entry.state === "waiting" ? "waiting" : "running"} for ${liveFor}: ${reason ?? "no reason recorded"}`,
    stalled: liveMs != null && liveMs >= MERGE_QUEUE_STALL_ATTENTION_MS,
    since, waitReason: reason, aheadStackId: null, aheadOther: false,
  };
}

function queueStalledSteps(stack: StackDto, layer: StackLayerDto, wait: MergeQueueWait): string {
  if (wait.aheadStackId || wait.aheadOther) {
    const ahead = wait.aheadStackId
      ? `Run mg stack status ${wait.aheadStackId} and fix what it names there; this stack moves once that entry lands or bounces.`
      : "That entry belongs to another Mergestorm user, so you cannot fix it from here.";
    return `#${layer.prNumber} is waiting in the merge queue behind another entry in ${stack.owner}/${stack.repo} that has made no progress since ${wait.since ?? "it was claimed"}. Nothing on ${layer.branch} needs a change. ${ahead} If it stays stuck, tell the human: the queue for this repo is held by that entry.`;
  }
  return `The merge queue has held #${layer.prNumber} at ${layer.headSha ?? "its head"} since ${wait.since ?? "it was claimed"} without landing or bouncing it${wait.waitReason ? `; its last note is: ${wait.waitReason}` : ", and it recorded no reason"}. If the note names a failing check or a conflict on ${layer.branch}, fix that with an ordinary push. If it waits on CI, list the head's checks (gh run list --branch ${layer.branch}) and re-run the one that never finished (gh run rerun <run-id>). If nothing moves after that, tell the human: they can take the stack out of the queue and enqueue it again (mg queue rm ${stack.id}, then mg queue add ${stack.id}). Do not retarget the PR base.`;
}

function isTerminalLayer(layer: StackLayerDto): boolean {
  return layer.state === "merged" || layer.state === "closed";
}

export function conflictLiveParent(stack: StackDto, layer: StackLayerDto): string | null {
  const promoted = (candidate: StackLayerDto) =>
    !!stack.unit?.members?.some((member) => member.prNumber === candidate.prNumber && member.promotedHeadSha?.trim());
  const sibling = stack.layers
    .filter((candidate) => candidate.prNumber > 0 && candidate.position < layer.position &&
      !isTerminalLayer(candidate) && !promoted(candidate))
    .sort((a, b) => b.position - a.position)[0];
  if (sibling) return sibling.branch;
  const retired = new Set([
    ...stack.layers.filter((candidate) => isTerminalLayer(candidate) || promoted(candidate)).map((candidate) => candidate.branch),
    ...(stack.unit?.members ?? []).filter((member) => member.promotedHeadSha?.trim()).map((member) => member.branch),
  ]);
  const usable = (branch: string | null | undefined): branch is string =>
    !!branch?.trim() && !isMgParkBase(branch) && !retired.has(branch) && branch !== layer.branch;
  for (const branch of [layer.restackError?.from?.branch, layer.parentBranch, stack.unit?.branch, stack.trunkBranch]) {
    if (usable(branch)) return branch;
  }
  return null;
}

function conflictFiles(layer: StackLayerDto, bounce: MergeQueueEntryDto | undefined): string[] {
  const paths = bounce?.bounceDetail?.conflictPaths?.filter((path) => path.trim());
  if (paths?.length) return [...paths];
  const detail = layer.restackError?.kind === "rebase_conflict" ? layer.restackError.detail : layer.conflictDetail;
  const listed = detail?.match(/^conflict in (.+)$/)?.[1];
  return listed ? listed.split(", ").map((path) => path.trim()).filter(Boolean) : [];
}

export function conflictRepairSteps(branch: string, liveParent: string | null): string {
  if (!liveParent) {
    return `The live parent of ${branch} is unknown (it is never an mg-park-* freeze). Do not merge or rebase anything; stop and tell the human.`;
  }
  return `Merge ${liveParent} into ${branch}: git fetch origin, check out ${branch} at its live remote head, git merge origin/${liveParent}, resolve the conflicts, run the tests, then an ordinary git push (no force). Do not rebase onto trunk, main, or mg-park-*, and do not retarget the PR base.`;
}

export function restackFailedRepairSteps(
  branch: string,
  liveParent: string | null,
  failure: { kind: string; detail?: string | null },
): string {
  const why = `Mergestorm could not restack ${branch}${liveParent ? ` onto ${liveParent}` : ""} (${failure.kind}${failure.detail?.trim() ? `: ${failure.detail.trim()}` : ""}) and will not try this head again.`;
  if (!liveParent) {
    return `${why} The live parent of ${branch} is unknown (it is never an mg-park-* freeze). Do not merge or rebase anything; stop and tell the human.`;
  }
  return `${why} Merge ${liveParent} into ${branch}: git fetch origin, check out ${branch} at its live remote head, git merge origin/${liveParent}, resolve any conflicts, run the tests, then an ordinary git push (no force). Mergestorm clears Restack failed once the pushed head contains the tip of ${liveParent}. If GitHub refuses the push (branch protection or permissions), stop and tell the human. Do not rebase onto trunk, main, or mg-park-*, and do not retarget the PR base.`;
}

function landPrLiveParent(stack: StackDto, layer: StackLayerDto): string | null {
  const base = stack.unit?.landTarget?.trim() || layer.parentBranch?.trim();
  return base && !isMgParkBase(base) && base !== layer.branch ? base : null;
}

export function agentsCannotClear(blocker: string): boolean {
  return blocker === "Conflict" || blocker === RESTACK_FAILED || blocker === "Draft PR" ||
    blocker === SEAM_REVIEW_NOT_RUNNING || blocker === VORTEX_REVIEW_OUT_OF_QUOTA ||
    blocker === VORTEX_AUTO_REVIEW_OFF || blocker === VORTEX_BILLING_SKIPPED ||
    blocker === VORTEX_REVIEW_INCOMPLETE ||
    STUCK_SEAM_BLOCKERS.includes(blocker) ||
    blocker.startsWith("Merge conflicts") || blocker.startsWith(UNIT_ABANDONED_BLOCKER_PREFIX);
}

const TEMPEST_RERUN_BLOCKER = /^(?:landing blocked:\s*)?tempest_(failed|stopped)\b/i;

function isTempestFindingsBlocker(attention: StackBlocker, bounce: MergeQueueEntryDto | undefined): boolean {
  const blocker = attention.blocker.trim();
  const reason = bounce?.bounceDetail?.message?.trim();
  if (reason && TEMPEST_RERUN_BLOCKER.test(reason)) return false;
  return attention.bounceKind === "tempest_findings" || /^Tempest findings\b/i.test(blocker) ||
    /^(?:landing blocked:\s*)?tempest_findings\b/i.test(blocker);
}

export function stackRepair(
  stack: StackDto,
  attention: StackBlocker | null,
  layer: StackLayerDto | undefined,
  bounce: MergeQueueEntryDto | undefined,
  queueWait: MergeQueueWait | null = null,
): StackRepairHint | null {
  if (!attention || !layer || attention.prNumber !== layer.prNumber) return null;
  if (queueWait && attention.blocker.startsWith(MERGE_QUEUE_STALLED_PREFIX)) {
    return {
      kind: "queue_stalled",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      since: queueWait.since,
      waitReason: queueWait.waitReason,
      steps: queueStalledSteps(stack, layer, queueWait),
    };
  }
  const landPr = !!stack.unit?.branch && layer.prNumber === stack.unit.landPrNumber && layer.branch === stack.unit.branch;
  const restackConflict = attention.blocker === "Conflict" || attention.bounceKind === "restack_conflict";
  const mergeConflict = attention.blocker.startsWith("Merge conflicts");
  if (restackConflict || mergeConflict) {
    const liveParent = landPr ? landPrLiveParent(stack, layer) : conflictLiveParent(stack, layer);
    return {
      kind: restackConflict ? "restack_conflict" : "merge_conflict",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      liveParent,
      files: conflictFiles(layer, bounce),
      steps: conflictRepairSteps(layer.branch, liveParent),
    };
  }
  if (attention.blocker === RESTACK_FAILED && layer.restackError) {
    const liveParent = landPr ? landPrLiveParent(stack, layer) : conflictLiveParent(stack, layer);
    return {
      kind: "restack_failed",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      liveParent,
      restackKind: layer.restackError.kind,
      steps: restackFailedRepairSteps(layer.branch, liveParent, layer.restackError),
    };
  }
  if (attention.blocker.startsWith(UNIT_ABANDONED_BLOCKER_PREFIX)) {
    const openPrCount = stack.layers.filter((candidate) =>
      candidate.prNumber > 0 && !isTerminalLayer(candidate),
    ).length;
    return {
      kind: "unit_abandoned",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      steps: `The stack's review unit was abandoned when #${layer.prNumber}'s base on GitHub was changed off its mg-stack trunk, so Auto land cannot promote or land this stack. Ask the human whether to re-root it. ${openPrCount < 2 ? `With only one open PR, re-adopting #${layer.prNumber} will not create a review unit; close and resubmit it to create a fresh stack.` : `If yes, tell the human that mg stack adopt ${stack.owner}/${stack.repo}#${layer.prNumber} re-roots it on a new review unit.`} Do not retarget the PR base yourself.`,
    };
  }
  if (STUCK_SEAM_BLOCKERS.includes(attention.blocker)) {
    const member = stack.unit?.members?.find((entry) => entry.prNumber === layer.prNumber);
    const seamState = member?.seamState?.trim().toLowerCase() || "unknown";
    const reviewed = member?.seamReviewedSha?.trim();
    const what = attention.blocker === SEAM_VERDICT_STALE
      ? `The seam (integration) review verdict on #${layer.prNumber} (${seamState}) was made at ${reviewed ? reviewed.slice(0, 7) : "an older head"}, not the live head ${layer.headSha ?? "(unknown)"}, and no seam review is queued or running to replace it`
      : `The seam (integration) review of #${layer.prNumber} is ${seamState} but no seam review is queued or running at ${layer.headSha ?? "the live head"}`;
    return {
      kind: "seam_review_stuck",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      seamState,
      steps: `${what}, so Auto land cannot promote it. Do not patch or push for this. Tell the human to click Continue on the stack in the Mergestorm dashboard, which re-queues the seam review at the live head of ${layer.branch}; a new commit pushed to ${layer.branch} also queues one. Then keep watching.`,
    };
  }
  if (attention.blocker.startsWith(AUTO_LAND_OFF_BLOCKER_PREFIX) && attention.bounceKind) {
    return {
      kind: "auto_land_off",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      bounceKind: attention.bounceKind,
      steps: `The ${attention.bounceKind} bounce turned Auto land off, so nothing will enqueue this stack. Fix the cause of the bounce on ${layer.branch}, then turn Auto land back on (mg stack set ${stack.id} --auto-land on) or enqueue the stack.`,
    };
  }
  if (landPr && isTempestFindingsBlocker(attention, bounce)) {
    const findings = `gh api repos/${stack.owner}/${stack.repo}/issues/${layer.prNumber}/comments`;
    return {
      kind: "tempest_findings",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      findings,
      steps: `Tempest never patches, and Cyclone is not patching this land PR. Read the Tempest report on it (${findings}), verify each finding against ${layer.branch} at its live remote head, fix the real ones with the smallest patch on ${layer.branch}, run the tests, confirm the remote head is still ${layer.headSha ?? "the head you started from"}, then an ordinary git push (no force). Do not retarget the PR base.`,
    };
  }
  const rerunBlocker = attention.blocker.trim().match(TEMPEST_RERUN_BLOCKER) ??
    bounce?.bounceDetail?.message?.trim().match(TEMPEST_RERUN_BLOCKER);
  const rerun = landPr ? rerunBlocker : null;
  if (rerun) {
    const stoppedByPerson = rerun[1]!.toLowerCase() === "stopped";
    const comment = `gh pr comment ${layer.prNumber} --repo ${stack.owner}/${stack.repo} --body`;
    const head = layer.headSha ?? "its live head";
    return {
      kind: "tempest_rerun",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      stoppedByPerson,
      steps: stoppedByPerson
        ? `Tempest's review of land PR #${layer.prNumber} at ${head} was stopped, so Auto land will not land it. There are no findings to fix: do not patch or push. Ask the human whether to run Tempest again. If they say yes, run ${comment} "@mergestorm-tempest review --force" and keep watching.`
        : `Tempest's review of land PR #${layer.prNumber} at ${head} broke before it produced a result, and Mergestorm already re-ran it the most times it will on its own. There are no findings to fix: do not patch or push. Run it once more with ${comment} "@mergestorm-tempest review" and keep watching. If it breaks again, tell the human.`,
    };
  }
  const vortexSkip = vortexIdleSkipBlocker(layer);
  if (vortexSkip && attention.blocker === vortexSkip.blocker) {
    return {
      kind: "vortex_skipped",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      skipReason: vortexSkip.skipReason,
      steps: vortexSkippedSteps(stack, layer, vortexSkip.skipReason),
    };
  }
  const wait = autoLandWaitOn(stack, layer);
  if (wait && attention.blocker.startsWith(AUTO_LAND_CI_PENDING_PREFIX)) {
    return {
      kind: "ci_pending",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      since: wait.since,
      steps: `A check on ${layer.branch} at ${layer.headSha ?? "its head"} has been pending since ${wait.since}, and Auto land will not queue an unfinished head. List the head's checks (gh api repos/${stack.owner}/${stack.repo}/commits/${layer.headSha ?? "<sha>"}/check-runs, and gh run list --branch ${layer.branch}) and find the one that never finished. Re-run it (gh run rerun <run-id>) if it is stuck or was never picked up. If it is a required check that no workflow reports, or it fails again, tell the human. Push a fix only when the check is red for a reason in the code. Do not retarget the PR base.`,
    };
  }
  if (wait && attention.blocker.startsWith(AUTO_LAND_VORTEX_WAIT_PREFIX)) {
    return {
      kind: "vortex_not_green",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      since: wait.since,
      steps: `Auto land has waited since ${wait.since} for an approving Vortex review of ${layer.branch} at ${layer.headSha ?? "its head"}, and no Vortex run is working on it. Read the PR's latest Vortex review (gh api repos/${stack.owner}/${stack.repo}/pulls/${layer.prNumber}/reviews). If it has findings, verify and fix the real ones on ${layer.branch} with an ordinary push, or record a wrong one with mg dismiss as mergestorm-pr-loop describes. If no review exists at this head, or it failed or was skipped, tell the human: nothing re-reviews this head until they re-run the review or push a new head.`,
    };
  }
  if (wait && attention.blocker.startsWith(AUTO_LAND_PROMOTE_FAILED_PREFIX)) {
    const attempts = wait.attempts ?? AUTO_LAND_PROMOTE_FAILED_ATTEMPTS;
    return {
      kind: "promote_failed",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      attempts,
      message: wait.detail,
      steps: `Auto land tried to promote #${layer.prNumber} at ${layer.headSha ?? "its head"} ${attempts} times and GitHub refused the merge each time${wait.detail ? ` (${wait.detail})` : ""}, so it stopped retrying this head. Read why: gh api repos/${stack.owner}/${stack.repo}/pulls/${layer.prNumber} --jq '{mergeable, mergeable_state, base: .base.ref}', and the branch protection on that base. If the cause is in ${layer.branch}, fix it and push with an ordinary push: a new head is retried. If it is outside the PR (branch protection, permissions, a required review), tell the human, and that once it is fixed they can retry the promote by turning Auto land off and on (mg stack set ${stack.id} --auto-land off, then --auto-land on). Do not toggle Auto land yourself, and do not retarget the PR base.`,
    };
  }
  if (attention.blocker === VORTEX_FINDINGS_NEED_PERSON) {
    const findings = `gh api repos/${stack.owner}/${stack.repo}/pulls/${layer.prNumber}/reviews`;
    const handoff = cycloneHandoffAtHead(stack, layer);
    return {
      kind: "vortex_findings",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      handoff,
      findings,
      steps: `Vortex requested changes on ${layer.branch} at ${layer.headSha ?? "its live head"} and Cyclone left them for a person${handoff ? ` (${cycloneHandoffWords(handoff)})` : ""}, so nothing will patch them and Auto land waits. Read the newest Vortex review and its inline comments (${findings}), verify each finding against ${layer.branch} at its live remote head, fix the real ones with the smallest patch, run the tests, confirm the remote head is still ${layer.headSha ?? "the head you started from"}, then an ordinary git push (no force). If a finding is wrong, tell the human; mg dismiss ${stack.owner}/${stack.repo}#${layer.prNumber} --head <sha> --review <id> dismisses that review. Do not retarget the PR base.`,
    };
  }
  if (attention.blocker.startsWith("CI failed") || attention.bounceKind === "ci_failure") {
    const failingCheck = bounce?.bounceDetail?.failingCheck?.trim() || layer.checks?.failingName?.trim() || null;
    return {
      kind: "ci_failure",
      prNumber: layer.prNumber,
      headSha: layer.headSha ?? null,
      branch: layer.branch,
      failingCheck,
      steps: `Read the failing ${failingCheck ? `check ${failingCheck}` : "checks"} on ${layer.branch} (gh run list --branch ${layer.branch}, then gh run view <run-id> --log-failed), fix it on ${layer.branch} with the smallest patch, run that check locally, confirm the remote head is still ${layer.headSha ?? "the head you started from"}, then an ordinary git push. Do not retarget the PR base.`,
    };
  }
  return null;
}

/** Pair-gate attention plus live hard blocks on every other open layer. */
export function stackBlockers(stack: StackDto, entries: MergeQueueEntryDto[] = [],
  cursor: Pick<StackWatchCursor, "bounceId" | "afterFinishedAt"> = {}, nowMs: number = Date.now()) {
  const candidate = currentLayer(stack);
  const currentCandidate = candidate ? { prNumber: candidate.prNumber, headSha: candidate.headSha ?? null } : null;
  const queue = entries.filter((entry) => entry.stackId.trim().toLowerCase() === stack.id.trim().toLowerCase());
  const open = stack.layers.filter((layer) => layer.prNumber > 0 && !["merged", "closed"].includes(layer.state))
    .sort((a, b) => a.position - b.position);
  if (candidate && !open.some((layer) => layer.prNumber === candidate.prNumber)) open.push(candidate);
  const child = candidate && open.filter((layer) =>
    layer.position > candidate.position && layer.parentBranch === candidate.branch &&
    (boundDirty(layer) || layer.state === "conflict" ||
      (layer.state !== "restacking" && layer.restackError?.kind === "rebase_conflict")),
  ).sort((a, b) => a.position - b.position)[0];
  let attention: StackBlocker | null = null;
  let attentionLayer: StackLayerDto | undefined;
  let bounce: MergeQueueEntryDto | undefined;
  const issues: StackBlocker[] = [];
  const queueWait = stack.archivedAt ? null : mergeQueueWait(queue, nowMs);
  for (const layer of open) {
    const selected = layer.prNumber === candidate?.prNumber;
    let result = layerAttention(stack, layer, selected ? queue : [], cursor);
    let disarmed: MergeQueueEntryDto | undefined;
    if (!result.blocker && selected) {
      disarmed = disarmingBounce(stack, queue);
      if (disarmed) {
        const kind = disarmed.bounceDetail!.kind;
        result = { blocker: `${AUTO_LAND_OFF_BLOCKER_PREFIX}${kind} bounce`, bounceKind: kind, bounce: disarmed };
      }
    }
    let waitNamed = false;
    if (!result.blocker) {
      const waiting = autoLandWaitBlocker(stack, layer, nowMs);
      if (waiting) {
        result = { blocker: waiting, bounceKind: null };
        waitNamed = true;
      }
    }
    if (!result.blocker && selected && queueWait?.stalled) {
      result = { blocker: `${MERGE_QUEUE_STALLED_PREFIX}${queueWait.text}`, bounceKind: null };
    }
    if (!result.blocker) {
      if (mergeabilityPending(layer) && (selected || !candidate || layer.position > candidate.position)) {
        issues.push({ prNumber: layer.prNumber, headSha: layer.headSha ?? null,
          blocker: `Merge state unknown${layer.parentBranch ? ` vs ${layer.parentBranch}` : ""}`, bounceKind: null });
      }
      continue;
    }
    const issue = { prNumber: layer.prNumber, headSha: layer.headSha ?? null,
      blocker: result.blocker, bounceKind: result.bounceKind };
    if (
      selected ||
      result.blocker.startsWith(UNIT_ABANDONED_BLOCKER_PREFIX) ||
      (!attention && (layer === child || waitNamed))
    ) {
      attention = issue;
      attentionLayer = layer;
      bounce = result.bounce;
      if (disarmed) issues.push({ prNumber: disarmed.bounceDetail?.prNumber ?? layer.prNumber,
        headSha: disarmed.bounceDetail?.headSha ?? null, blocker: mergeQueueBounceLabel(disarmed), bounceKind: result.bounceKind });
    } else if (!candidate || layer.position > candidate.position) issues.push(issue);
  }
  const queued: StackQueueWait | null = queueWait && candidate && !queueWait.stalled
    ? { prNumber: candidate.prNumber, headSha: candidate.headSha ?? null, text: queueWait.text,
      since: queueWait.since, waitReason: queueWait.waitReason }
    : null;
  const settleIssue = mergeabilitySettleIssue(stack, open, issues, attention);
  if (settleIssue) issues.push(settleIssue);
  const focus = attentionLayer ?? candidate;
  const agents = focus ? layerAgents(focus) : null;
  const busy: StackAgentBusy[] = [];
  if (attention && agents) {
    for (const agent of ["cyclone", "vortex"] as const) {
      if (agents.busy[agent]) busy.push({ prNumber: attention.prNumber, headSha: attention.headSha, agent, blocker: attention.blocker });
    }
  }
  const landing = stack.unit?.landingBlockReason?.trim();
  const landLayer = stack.unit?.landPrNumber != null && !stack.archivedAt
    ? open.find((layer) => layer.prNumber === stack.unit?.landPrNumber)
    : undefined;
  const landGatePending: StackLandGatePending | null = landLayer && landing && landGateIsPending(landing)
    ? { prNumber: landLayer.prNumber, headSha: landLayer.headSha ?? null, reason: landing }
    : null;
  if (busy.length && attention && agentsCannotClear(attention.blocker)) {
    const held: StackHeldBlocker = { ...attention, actAfter: "agents_idle", waitingOn: busy.map((entry) => entry.agent) };
    return { attention: null, held, issues: [attention, ...issues], currentCandidate, bounce: undefined, busy, agents,
      repair: stackRepair(stack, attention, attentionLayer, undefined, queueWait), landGatePending, queueWait: queued };
  }
  if (busy.length) {
    return { attention: null, held: null, issues, currentCandidate, bounce: undefined, busy, agents, repair: null, landGatePending,
      queueWait: queued };
  }
  return { attention, held: null, issues, currentCandidate, bounce, busy, agents,
    repair: stackRepair(stack, attention, attentionLayer, bounce, queueWait), landGatePending, queueWait: queued };
}

function mergeabilitySettleIssue(
  stack: StackDto,
  open: readonly StackLayerDto[],
  issues: readonly StackBlocker[],
  attention: StackBlocker | null,
): StackBlocker | null {
  const settle = stack.autoEnqueueSettle;
  if (stack.archivedAt || settle?.action !== "mergeability") return null;
  if (attention?.prNumber === settle.prNumber) return null;
  if (issues.some((issue) => issue.prNumber === settle.prNumber && issue.blocker.startsWith("Merge state unknown"))) return null;
  const layer = open.find((candidate) => candidate.prNumber === settle.prNumber);
  if (layer && !sameHead(layer.headSha, settle.headSha)) return null;
  const vs = layer?.parentBranch ? ` vs ${layer.parentBranch}` : "";
  return { prNumber: settle.prNumber, headSha: settle.headSha,
    blocker: `Merge state unknown${vs}; Auto land is waiting for a mergeability verdict`, bounceKind: null };
}

/** Compact contract text shared by status and wait summaries. */
export function stackBlockersSummary(attention: Pick<StackBlocker, "prNumber" | "blocker"> | null,
  issues: StackBlocker[], busy: readonly StackAgentBusy[] = [],
  landGatePending: Pick<StackLandGatePending, "prNumber" | "reason"> | null = null,
  actAfter: StackHeldBlocker["actAfter"] | null = null,
  queueWait: Pick<StackQueueWait, "prNumber" | "text"> | null = null): string {
  const agentWork = (entry: StackAgentBusy) => entry.agent === "cyclone" ? "Cyclone patches" : "Vortex reviews";
  const blocked = attention && actAfter && busy.length
    ? ` · blocked after the agents: #${attention.prNumber} ${attention.blocker} (plan the fix; act once ${busy.map(agentWork).join(" and ")} finish and the watch returns attention)`
    : attention ? ` · blocked: #${attention.prNumber} ${attention.blocker}` : "";
  const working = busy.length && !actAfter
    ? ` · held: #${busy[0]!.prNumber} ${busy[0]!.blocker} while ${busy.map(agentWork).join(" and ")}`
    : "";
  const listed = actAfter && attention ? issues.filter((issue) => issue.prNumber !== attention.prNumber || issue.blocker !== attention.blocker) : issues;
  const labels = listed.slice(0, 3).map(issue => `#${issue.prNumber} ${issue.blocker}`).join("; ");
  const gate = landGatePending && !attention
    ? ` · land gate: #${landGatePending.prNumber} ${landGatePending.reason} (nothing to fix; wait)`
    : "";
  const queue = queueWait && !attention ? ` · queue: #${queueWait.prNumber} ${queueWait.text}` : "";
  return blocked + working + gate + queue + (listed.length ? ` · issues: ${labels}${listed.length > 3 ? `; +${listed.length - 3} more` : ""}` : "");
}
