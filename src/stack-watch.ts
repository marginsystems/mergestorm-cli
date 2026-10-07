import {
  currentLayer,
  layerAgents,
  stackBlockers,
  type StackAgentBusy,
  type StackBlocker,
  type StackBusyAgent,
  type StackHeldBlocker,
  type StackLayerAgents,
  type StackLandGatePending,
  type StackQueueWait,
  type StackRepairHint,
} from "./stack-blockers.js";
import {
  stackTerminalReason,
  stackWatchObligation,
  type StackWatchDoneReason,
  type StackWatchObligation,
} from "./stack-watch-obligation.js";
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
import { type MergeQueueEntryDto, type StackDto } from "./stack-dto.js";

export const STACK_WATCH_SCHEMA = "mergestorm.stack_watch/v1" as const;
export const STACK_WATCH_DEFAULT_TIMEOUT_MS = 45_000;
export const STACK_WATCH_BUSY_RECHECK_S = 15;

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
  issues: StackBlocker[];
  currentCandidate: { prNumber: number; headSha: string | null } | null;
  assessment: "available" | "unavailable";
  busy: StackAgentBusy[];
  actAfter: StackHeldBlocker["actAfter"] | null;
  waitingOn: StackBusyAgent[];
  agents: StackLayerAgents | null;
  repair: StackRepairHint | null;
  landGatePending: StackLandGatePending | null;
  queueWait?: StackQueueWait | null;
  watch: StackWatchObligation;
};

type StackWatchSnapshot = Omit<StackWatchEnvelope, "watch">;

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
  let lastEnvelope: StackWatchSnapshot = {
    schema: STACK_WATCH_SCHEMA, status: "failed", stackId: id, blocker: null,
    bounceKind: null, prNumber: null, headSha: null, cursor,
    issues: [], currentCandidate: null, assessment: "unavailable", busy: [], actAfter: null, waitingOn: [], agents: null, repair: null,
    landGatePending: null,
  };
  let terminal: StackWatchDoneReason | null = null;
  const seal = (snapshot: StackWatchSnapshot, retryAfterSeconds?: number): StackWatchEnvelope => ({
    ...snapshot,
    watch: stackWatchObligation({
      stackId: id, terminal, cursor: snapshot.cursor, status: snapshot.status, retryAfterSeconds,
      attention: snapshot.status === "attention" && snapshot.blocker && snapshot.prNumber != null
        ? { prNumber: snapshot.prNumber, blocker: snapshot.blocker } : null,
    }),
  });
  let transientFailures = 0;
  const timeout = () => new StackWatchTimeoutError(seal(lastEnvelope));
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
        lastEnvelope = { ...lastEnvelope, assessment: "unavailable" };
        if (now() >= deadline && timeoutMs !== 0) throw timeout();
        if (timeoutMs !== 0 && isTransientReviewPollError(err) && transientFailures < REVIEW_POLL_MAX_TRANSIENT_RETRIES) {
          transientFailures += 1;
          opts.onTick?.(seal(lastEnvelope));
          await pause(transientRetryWaitMs({ failureCount: transientFailures, random: opts.random }));
          continue;
        }
        throw new StackWatchError(err instanceof Error ? err.message : String(err),
          seal({ ...lastEnvelope, status: "failed", assessment: "unavailable" }), { cause: err });
      }
      if (response.status === 200) return response.body;
      lastEnvelope = { ...lastEnvelope, assessment: "unavailable" };
      const retryWaitMs = transientRetryWaitMs({
        failureCount: transientFailures + 1, retryAfterSeconds: response.retryAfterSeconds, random: opts.random,
      });
      if (timeoutMs !== 0 && isTransientReviewPollStatus(response.status) && transientFailures < REVIEW_POLL_MAX_TRANSIENT_RETRIES &&
        (response.status !== 429 || retryWaitMs < deadline - now())) {
        transientFailures += 1;
        opts.onTick?.(seal({ ...lastEnvelope, status: response.status === 429 ? "rate_limited" : lastEnvelope.status },
          response.status === 429 ? response.retryAfterSeconds : undefined));
        await pause(retryWaitMs);
        continue;
      }
      throw new StackWatchError(`Stack poll failed (HTTP ${response.status})`, seal({
        ...lastEnvelope, status: response.status === 429 ? "rate_limited" : "failed",
        assessment: "unavailable",
      }, response.retryAfterSeconds), undefined, response.retryAfterSeconds);
    }
    throw timeout();
  };

  const enrich = async (finalSnapshot: boolean): Promise<StackDto> => {
    const snapshot = await request(`/api/v1/stacks/enrich?stackId=${encodeURIComponent(id)}`, finalSnapshot) as { stacks?: StackDto[] } | null;
    const stack = snapshot && Array.isArray(snapshot.stacks)
      ? snapshot.stacks.find((candidate) => candidate.id.trim().toLowerCase() === id)
      : undefined;
    if (snapshot && Array.isArray(snapshot.stacks) && !stack) {
      terminal = "not_found";
      throw new StackWatchError("Stack not found or not owned by the current user",
        seal({ ...lastEnvelope, status: "failed", assessment: "unavailable", blocker: null, issues: [], busy: [], actAfter: null, waitingOn: [],
          prNumber: null, headSha: null, repair: null, agents: null, currentCandidate: null, landGatePending: null, queueWait: null }));
    }
    if (!stack || !Array.isArray(stack.layers)) {
      throw new StackWatchError("Stack snapshot missing or invalid", seal({ ...lastEnvelope, status: "failed", assessment: "unavailable" }));
    }
    terminal = stackTerminalReason(stack);
    return stack;
  };
  const queueRoute = `/api/v1/stacks/queue?stackId=${encodeURIComponent(id)}`;
  const readQueue = async (route: string, finalSnapshot = false) => {
    const queue = await request(route, finalSnapshot) as { entries?: MergeQueueEntryDto[]; fingerprint?: unknown } | null;
    if (!queue || !Array.isArray(queue.entries)) {
      throw new StackWatchError("Invalid merge queue response", seal({ ...lastEnvelope, status: "failed", assessment: "unavailable" }));
    }
    return {
      entries: queue.entries.filter((entry) => entry.stackId.trim().toLowerCase() === id),
      fingerprint: typeof queue.fingerprint === "string" && queue.fingerprint ? queue.fingerprint : null,
    };
  };
  const evaluate = (stack: StackDto, entries: MergeQueueEntryDto[]) => {
    const { attention, held: named, issues, currentCandidate, bounce, busy, agents, repair, landGatePending, queueWait } =
      stackBlockers(stack, entries, cursor, now());
    if (bounce) cursor = Object.freeze({ ...cursor, bounceId: bounce.id,
      ...(bounce.finishedAt !== undefined ? { afterFinishedAt: bounce.finishedAt } : {}) });
    const held = busy[0];
    const shown = attention ?? named;
    lastEnvelope = { ...lastEnvelope, cursor, issues, currentCandidate, assessment: "available", busy, agents, repair, landGatePending, queueWait,
      actAfter: named?.actAfter ?? null, waitingOn: named?.waitingOn ?? [],
      blocker: shown?.blocker ?? null, bounceKind: shown?.bounceKind ?? null,
      prNumber: shown?.prNumber ?? held?.prNumber ?? currentCandidate?.prNumber ?? null,
      headSha: shown ? shown.headSha : held ? held.headSha : currentCandidate?.headSha ?? null,
      status: attention ? "attention" : busy.length || landGatePending || entries.some((entry) => ["queued", "running", "waiting"].includes(entry.state))
        ? "in_progress" : "waiting" };
  };

  let stack = await enrich(timeoutMs === 0);
  const layer = currentLayer(stack);
  if (!enrolled) {
    cursor = Object.freeze({ stackId: id, enrolledHeadSha: layer?.headSha ?? null });
    enrolled = true;
  }
  lastEnvelope = { ...lastEnvelope, cursor, prNumber: layer?.prNumber ?? null, headSha: layer?.headSha ?? null,
    agents: layer ? layerAgents(layer) : null };
  let queue = await readQueue(queueRoute, timeoutMs === 0);
  evaluate(stack, queue.entries);
  if (lastEnvelope.status === "attention" || timeoutMs === 0 || terminal) return seal(lastEnvelope);
  while (now() < deadline) {
    const heldAt = now();
    const seconds = Math.min(lastEnvelope.busy.length ? STACK_WATCH_BUSY_RECHECK_S : 45,
      Math.max(1, Math.ceil((deadline - heldAt) / 1000)));
    const seen = queue.fingerprint ? `&seen=${encodeURIComponent(queue.fingerprint)}` : "";
    const held = await readQueue(`${queueRoute}&wait=${seconds}${seen}`);
    if (JSON.stringify(held.entries) === JSON.stringify(queue.entries)) {
      await pause(intervalMs - (now() - heldAt));
    }
    queue = held;
    stack = await enrich(true);
    const refreshed = currentLayer(stack);
    lastEnvelope = { ...lastEnvelope, prNumber: refreshed?.prNumber ?? null, headSha: refreshed?.headSha ?? null,
      agents: refreshed ? layerAgents(refreshed) : null };
    transientFailures = 0;
    evaluate(stack, queue.entries);
    if (lastEnvelope.status === "attention" || terminal) return seal(lastEnvelope);
    opts.onTick?.(seal(lastEnvelope));
  }
  throw timeout();
}
