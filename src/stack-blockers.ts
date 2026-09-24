import { mergeQueueBounceLabel, restackRetryPending, type MergeQueueEntryDto, type StackDto, type StackLayerDto } from "./stack-dto.js";
import type { StackWatchCursor } from "./stack-watch.js";

export type StackBlocker = {
  prNumber: number;
  headSha: string | null;
  blocker: string;
  bounceKind: string | null;
};

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
    if (stack.unit?.landPrNumber === layer.prNumber) {
      if (stack.unit.landingBlockReason?.trim()) return hardBlock(stack.unit.landingBlockReason.trim());
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
      bounce = result.bounce;
    } else if (!candidate || layer.position > candidate.position) issues.push(issue);
  }
  return { attention, issues, currentCandidate, bounce };
}

/** Compact contract text shared by status and wait summaries. */
export function stackBlockersSummary(attention: Pick<StackBlocker, "prNumber" | "blocker"> | null,
  issues: StackBlocker[]): string {
  const blocked = attention ? ` · blocked: #${attention.prNumber} ${attention.blocker}` : "";
  const labels = issues.slice(0, 3).map(issue => `#${issue.prNumber} ${issue.blocker}`).join("; ");
  return blocked + (issues.length ? ` · issues: ${labels}${issues.length > 3 ? `; +${issues.length - 3} more` : ""}` : "");
}
