import { setTimeout as sleep } from "node:timers/promises";
import { apiFetch, type ApiFetchResult } from "./api.js";
import type { Config } from "./config.js";
import {
  REVIEW_POLL_INTERVAL_MS,
  REVIEW_POLL_MAX_TRANSIENT_RETRIES,
  isTransientReviewPollError,
  isTransientReviewPollStatus,
  transientRetryWaitMs,
} from "./commands/review-client.js";
import { mergeQueueBounceLabel, type MergeQueueEntryDto, type StackDto, type StackLayerDto } from "./stack-dto.js";

export const STACK_WATCH_SCHEMA = "mergestorm.stack_watch/v1" as const;
export const STACK_WATCH_DEFAULT_TIMEOUT_MS = 45_000;

/** Resume selectors are fixed for the entire wait, including transient retries. */
export type StackWatchCursor = {
  readonly stackId: string;
  readonly enrolledHeadSha: string | null;
  readonly afterFinishedAt?: string | null;
  readonly bounceId?: string | null;
};

export type StackWatchEnvelope = {
  schema: typeof STACK_WATCH_SCHEMA;
  status: "attention" | "waiting" | "in_progress" | "rate_limited" | "failed";
  stackId: string;
  blocker: string | null;
  bounceKind: string | null;
  prNumber: number | null;
  headSha: string | null;
  cursor: StackWatchCursor;
};

export type PollStackWatchOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  cursor?: StackWatchCursor;
  signal?: AbortSignal;
  onTick?: (envelope: StackWatchEnvelope) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Test seam at the apiFetch boundary, including HTTP status and Retry-After. */
  fetch?: typeof apiFetch;
};

export class StackWatchTimeoutError extends Error {
  constructor(readonly lastEnvelope: StackWatchEnvelope) {
    super(`Timed out waiting for stack ${lastEnvelope.stackId}`);
    this.name = "StackWatchTimeoutError";
  }
}

export class StackWatchError extends Error {
  constructor(
    message: string,
    readonly lastEnvelope: StackWatchEnvelope,
    options?: ErrorOptions,
    readonly retryAfterSeconds?: number,
  ) {
    super(message, options);
    this.name = "StackWatchError";
  }
}

function sameHead(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = a?.trim().toLowerCase();
  const right = b?.trim().toLowerCase();
  return !!left && !!right && (left.startsWith(right) || right.startsWith(left));
}

function currentLayer(stack: StackDto): StackLayerDto | undefined {
  const open = stack.layers.filter((layer) =>
    layer.prNumber > 0 && layer.state !== "merged" && layer.state !== "closed",
  );
  const promote = open.filter((layer) =>
    layer.prNumber !== stack.unit?.landPrNumber &&
    !stack.unit?.members.some((member) => member.prNumber === layer.prNumber && member.promotedHeadSha),
  ).sort((a, b) => a.position - b.position);
  const land = stack.unit?.landPr;
  return promote[0] ?? open.find((layer) => layer.prNumber === stack.unit?.landPrNumber) ??
    (land && land.prNumber > 0 && land.state !== "merged" && land.state !== "closed" ? land : undefined);
}

/** Keep label text and precedence aligned with MCP stack-summary.blockerLabel. */
function attention(
  stack: StackDto,
  layer: StackLayerDto | undefined,
  queue: MergeQueueEntryDto[],
  cursor: StackWatchCursor,
): { blocker: string | null; bounceKind: string | null; bounce?: MergeQueueEntryDto } {
  const none = { blocker: null, bounceKind: null };
  if (stack.archivedAt || queue.some((entry) => ["queued", "running", "waiting"].includes(entry.state))) return none;
  const bounce = queue.filter((entry) => entry.state === "bounced")
    .sort((a, b) => (Date.parse(b.finishedAt ?? "") || 0) - (Date.parse(a.finishedAt ?? "") || 0))[0];
  const kind = bounce?.bounceDetail?.kind;
  const recoverable = kind === "head_moved" || kind === "must_consolidate";
  const recoverableSha = kind === "head_moved"
    ? bounce?.bounceDetail?.headSha ?? bounce?.verifyHeadSha
    : bounce?.verifyHeadSha ?? bounce?.bounceDetail?.headSha;
  const currentRecoverable = recoverable && sameHead(layer?.headSha, recoverableSha);
  const hardBlock = (blocker: string) => ({ blocker, bounceKind: null });
  if (layer) {
    if (layer.restackError && layer.state !== "restacking") {
      return hardBlock(layer.restackError.kind === "rebase_conflict" ? "Conflict" : "Restack failed");
    }
    if (layer.state === "conflict") return hardBlock("Conflict");
    if (layer.draft) return hardBlock("Draft PR");
    if ((!layer.headSha || layer.mergeableHeadSha === layer.headSha) &&
      (layer.mergeable === false || layer.mergeableState?.toLowerCase() === "dirty")) return hardBlock("Merge conflicts");
    if (!currentRecoverable && (layer.ciStatus === "failure" || (layer.checks?.failure ?? 0) > 0)) {
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
  if (!bounce || !kind || recoverable || !layer) return none;
  if (cursor.bounceId === bounce.id || (cursor.afterFinishedAt &&
    !(Date.parse(bounce.finishedAt ?? "") > Date.parse(cursor.afterFinishedAt)))) return none;
  // Compare with the observed promote/land head, never the enrollment or verify head.
  if (!sameHead(bounce.bounceDetail?.headSha ?? bounce.verifyHeadSha, layer.headSha) ||
    (bounce.bounceDetail?.prNumber != null && bounce.bounceDetail.prNumber !== layer.prNumber)) return none;
  return { blocker: mergeQueueBounceLabel(bounce), bounceKind: kind, bounce };
}

/** Wait on queue invalidations, then evaluate a fresh stack snapshot. */
export async function pollStackWatch(
  cfg: Config,
  stackId: string,
  opts: PollStackWatchOptions = {},
): Promise<StackWatchEnvelope> {
  const id = stackId.trim().toLowerCase();
  if (!id || (opts.cursor && opts.cursor.stackId.trim().toLowerCase() !== id)) {
    throw new TypeError("A matching stackId is required");
  }
  const timeoutMs = opts.timeoutMs ?? STACK_WATCH_DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? REVIEW_POLL_INTERVAL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError("timeoutMs must be nonnegative and intervalMs must be positive");
  }
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  const fetch = opts.fetch ?? apiFetch;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let enrolled = opts.cursor !== undefined;
  let cursor: StackWatchCursor = Object.freeze({
    ...(opts.cursor ?? { stackId: id, enrolledHeadSha: null }),
    stackId: id,
  });
  let lastEnvelope: StackWatchEnvelope = {
    schema: STACK_WATCH_SCHEMA, status: "waiting", stackId: id, blocker: null,
    bounceKind: null, prNumber: null, headSha: null, cursor,
  };
  let transientFailures = 0;
  const timeout = () => new StackWatchTimeoutError({ ...lastEnvelope, status: "waiting" });
  const pause = async (ms: number) => {
    const remaining = Math.min(ms, Math.max(0, deadline - now()));
    if (remaining > 0) await wait(remaining, opts.signal);
  };
  const request = async (route: string, finalSnapshot = false): Promise<unknown> => {
    let readAfterDeadline = finalSnapshot;
    while (readAfterDeadline || now() < deadline) {
      readAfterDeadline = false;
      opts.signal?.throwIfAborted();
      let response: ApiFetchResult;
      try {
        response = await fetch(cfg, route, {
          signal: opts.signal, timeoutMs: route.includes("&wait=")
            ? Number(new URL(route, "https://local").searchParams.get("wait")) * 1000 + 5_000
            : finalSnapshot ? 5_000 : Math.max(1, Math.min(30_000, deadline - now())),
        });
      } catch (err) {
        if (opts.signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
        if (now() >= deadline) throw timeout();
        if (isTransientReviewPollError(err) && transientFailures < REVIEW_POLL_MAX_TRANSIENT_RETRIES) {
          transientFailures += 1;
          opts.onTick?.(lastEnvelope);
          await pause(transientRetryWaitMs({ failureCount: transientFailures, random: opts.random }));
          continue;
        }
        throw new StackWatchError(err instanceof Error ? err.message : String(err),
          { ...lastEnvelope, status: "failed" }, { cause: err });
      }
      if (response.status === 200) return response.body;
      if (isTransientReviewPollStatus(response.status) && transientFailures < REVIEW_POLL_MAX_TRANSIENT_RETRIES) {
        transientFailures += 1;
        opts.onTick?.({ ...lastEnvelope, status: response.status === 429 ? "rate_limited" : lastEnvelope.status });
        await pause(transientRetryWaitMs({
          failureCount: transientFailures, retryAfterSeconds: response.retryAfterSeconds, random: opts.random,
        }));
        continue;
      }
      throw new StackWatchError(`Stack poll failed (HTTP ${response.status})`, {
        ...lastEnvelope, status: response.status === 429 ? "rate_limited" : "failed",
      }, undefined, response.retryAfterSeconds);
    }
    throw timeout();
  };

  while (now() < deadline) {
    const snapshot = await request(`/api/v1/stacks/enrich?stackId=${encodeURIComponent(id)}`) as { stacks?: StackDto[] } | null;
    let stack = snapshot && Array.isArray(snapshot.stacks)
      ? snapshot.stacks.find((stack) => stack.id.trim().toLowerCase() === id)
      : undefined;
    if (!stack || !Array.isArray(stack.layers)) {
      throw new StackWatchError("Stack snapshot missing or invalid", { ...lastEnvelope, status: "failed" });
    }
    let layer = currentLayer(stack);
    if (!enrolled) {
      cursor = Object.freeze({ stackId: id, enrolledHeadSha: layer?.headSha ?? null });
      enrolled = true;
    }
    lastEnvelope = { ...lastEnvelope, cursor, prNumber: layer?.prNumber ?? null, headSha: layer?.headSha ?? null };
    const initialQueue = await request(`/api/v1/stacks/queue?stackId=${encodeURIComponent(id)}`) as { entries?: MergeQueueEntryDto[] } | null;
    if (!initialQueue || !Array.isArray(initialQueue.entries)) {
      throw new StackWatchError("Invalid merge queue response", { ...lastEnvelope, status: "failed" });
    }
    const initialEntries = initialQueue.entries.filter((entry) => entry.stackId.trim().toLowerCase() === id);
    const initial = attention(stack, layer, initialEntries, cursor);
    if (initial.blocker) {
      const { bounce, ...result } = initial;
      if (bounce) {
        cursor = Object.freeze({
          ...cursor,
          bounceId: bounce.id,
          ...(bounce.finishedAt !== undefined ? { afterFinishedAt: bounce.finishedAt } : {}),
        });
      }
      return { ...lastEnvelope, ...result, cursor, status: "attention" };
    }
    const seconds = Math.min(45, Math.max(1, Math.ceil((deadline - now()) / 1000)));
    const queue = await request(`/api/v1/stacks/queue?stackId=${encodeURIComponent(id)}&wait=${seconds}`) as { entries?: MergeQueueEntryDto[] } | null;
    if (!queue || !Array.isArray(queue.entries)) {
      throw new StackWatchError("Invalid merge queue response", { ...lastEnvelope, status: "failed" });
    }
    if (now() < deadline) {
      const refreshed = await request(`/api/v1/stacks/enrich?stackId=${encodeURIComponent(id)}`, true) as { stacks?: StackDto[] } | null;
      stack = Array.isArray(refreshed?.stacks)
        ? refreshed.stacks.find((candidate) => candidate.id.trim().toLowerCase() === id)
        : undefined;
      if (!stack || !Array.isArray(stack.layers)) {
        throw new StackWatchError("Stack snapshot missing or invalid", { ...lastEnvelope, status: "failed" });
      }
      layer = currentLayer(stack);
      lastEnvelope = { ...lastEnvelope, prNumber: layer?.prNumber ?? null, headSha: layer?.headSha ?? null };
    }
    transientFailures = 0;
    const entries = queue.entries.filter((entry) => entry.stackId.trim().toLowerCase() === id);
    const { bounce, ...result } = attention(stack, layer, entries, cursor);
    if (bounce) {
      cursor = Object.freeze({
        ...cursor,
        bounceId: bounce.id,
        ...(bounce.finishedAt !== undefined ? { afterFinishedAt: bounce.finishedAt } : {}),
      });
    }
    lastEnvelope = {
      ...lastEnvelope, ...result, cursor,
      status: result.blocker ? "attention" : entries.some((entry) => ["queued", "running", "waiting"].includes(entry.state))
        ? "in_progress" : "waiting",
    };
    if (lastEnvelope.status === "attention") return lastEnvelope;
    opts.onTick?.(lastEnvelope);
  }
  throw timeout();
}
