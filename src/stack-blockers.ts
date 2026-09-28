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

function seamGateBlocker(stack: StackDto, layer: StackLayerDto): string | null {
  const members = stack.unit?.members ?? [];
  if (layer.prNumber === stack.unit?.landPrNumber) return null;
  if (!members.some((member) => member.promotedHeadSha?.trim())) return null;
  const member = members.find((entry) => entry.prNumber === layer.prNumber);
  if (!member || member.promotedHeadSha?.trim()) return null;
  const seamState = member.seamState?.trim().toLowerCase();
  if (seamState === "failed") return "Seam review failed";
  if (seamState === "findings" && sameHead(member.seamReviewedSha, layer.headSha)) return "Seam findings";
  return null;
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
      if (!restackRetryPending(layer.restackError, layer)) return hardBlock("Restack failed");
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
    const tempest = layer.agentRuns?.find((run) => run.agent === "tempest" &&
      ["findings", "failed"].includes(run.status) && sameHead(run.sha, layer.headSha));
    if (tempest) return hardBlock(`Tempest ${tempest.status}`);
    if (layer.vortexStatus === "failed") return hardBlock("Review failed");
    const seam = seamGateBlocker(stack, layer);
    if (seam) return hardBlock(seam);
    if (stack.unit?.landPrNumber === layer.prNumber) {
      const landing = stack.unit.landingBlockReason?.trim();
      if (landing && !landGateIsPending(landing)) return hardBlock(landing);
      if (stack.unit.tempestLandStatus?.toLowerCase() === "failed") return hardBlock("Tempest failed");
    }
  }
  if (!bounce || !kind || recoverable || !layer || queue.some((entry) => ["queued", "running", "waiting"].includes(entry.state))) return none;
  if ((cursor.bounceId != null && cursor.bounceId === bounce.id) || (cursor.afterFinishedAt &&
    !(Date.parse(bounce.finishedAt ?? "") > Date.parse(cursor.afterFinishedAt)))) return none;
  // Compare with the observed promote/land head, never the enrollment or verify head.
  if (!sameHead(bounce.bounceDetail?.headSha ?? bounce.verifyHeadSha, layer.headSha) ||
    (bounce.bounceDetail?.prNumber != null && bounce.bounceDetail.prNumber !== layer.prNumber)) return none;
  return { blocker: mergeQueueBounceLabel(bounce), bounceKind: kind, bounce };
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

export function stackRepair(
  stack: StackDto,
  attention: StackBlocker | null,
  layer: StackLayerDto | undefined,
  bounce: MergeQueueEntryDto | undefined,
): StackRepairHint | null {
  if (!attention || !layer || attention.prNumber !== layer.prNumber) return null;
  if (stack.unit && layer.prNumber === stack.unit.landPrNumber && layer.branch === stack.unit.branch) return null;
  const restackConflict = attention.blocker === "Conflict" || attention.bounceKind === "restack_conflict";
  const mergeConflict = attention.blocker.startsWith("Merge conflicts");
  if (restackConflict || mergeConflict) {
    const liveParent = conflictLiveParent(stack, layer);
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
  cursor: Pick<StackWatchCursor, "bounceId" | "afterFinishedAt"> = {}) {
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
  for (const layer of open) {
    const selected = layer.prNumber === candidate?.prNumber;
    const result = layerAttention(stack, layer, selected ? queue : [], cursor);
    if (!result.blocker) continue;
    const issue = { prNumber: layer.prNumber, headSha: layer.headSha ?? null,
      blocker: result.blocker, bounceKind: result.bounceKind };
    if (selected || (!attention && layer === child)) {
      attention = issue;
      attentionLayer = layer;
      bounce = result.bounce;
    } else if (!candidate || layer.position > candidate.position) issues.push(issue);
  }
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
  if (busy.length) return { attention: null, issues, currentCandidate, bounce: undefined, busy, agents, repair: null, landGatePending };
  return { attention, issues, currentCandidate, bounce, busy, agents, repair: stackRepair(stack, attention, attentionLayer, bounce), landGatePending };
}

/** Compact contract text shared by status and wait summaries. */
export function stackBlockersSummary(attention: Pick<StackBlocker, "prNumber" | "blocker"> | null,
  issues: StackBlocker[], busy: readonly StackAgentBusy[] = [],
  landGatePending: Pick<StackLandGatePending, "prNumber" | "reason"> | null = null): string {
  const blocked = attention ? ` · blocked: #${attention.prNumber} ${attention.blocker}` : "";
  const working = busy.length
    ? ` · held: #${busy[0]!.prNumber} ${busy[0]!.blocker} while ${busy.map((entry) => entry.agent === "cyclone" ? "Cyclone patches" : "Vortex reviews").join(" and ")}`
    : "";
  const labels = issues.slice(0, 3).map(issue => `#${issue.prNumber} ${issue.blocker}`).join("; ");
  const gate = landGatePending && !attention
    ? ` · land gate: #${landGatePending.prNumber} ${landGatePending.reason} (nothing to fix; wait)`
    : "";
  return blocked + working + gate + (issues.length ? ` · issues: ${labels}${issues.length > 3 ? `; +${issues.length - 3} more` : ""}` : "");
}
