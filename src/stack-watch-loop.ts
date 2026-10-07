import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "./config.js";
import { API_TIMEOUT_PREFIX, readLandedQueueEntry } from "./api.js";
import { isTransientReviewPollError } from "./commands/review-client.js";
import type { MergeQueueEntryDto } from "./stack-dto.js";
import {
  pollStackWatch,
  StackWatchError,
  StackWatchTimeoutError,
  type StackWatchCursor,
  type StackWatchEnvelope,
} from "./stack-watch.js";

export const STACK_WATCH_MARKER = "MS-WATCH";
export const STACK_WATCH_EXIT = { landed: 0, attention: 3, timeout: 5 } as const;
export const STACK_WATCH_SLICE_MS = 300_000;
export const STACK_WATCH_RECHECK_MS = 30_000;
export const STACK_WATCH_FAILED_RETRY_MS = 15_000;
export const STACK_WATCH_RATE_LIMIT_WAIT_MS = 30_000;
export const STACK_WATCH_TRANSIENT_WINDOW_MS = 15 * 60_000;
export const STACK_WATCH_TRANSIENT_MAX_WAIT_MS = 60_000;

const TRANSIENT_WATCH_FAILURE = /HTTP (?:408|429|5\d\d)|snapshot missing|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|connection/i;

export function isTransientWatchFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (isTransientReviewPollError(err)) return true;
  if (err.cause !== undefined && isTransientReviewPollError(err.cause)) return true;
  return err.message.startsWith(API_TIMEOUT_PREFIX) || TRANSIENT_WATCH_FAILURE.test(err.message);
}

export type StackWatchUntil = "attention" | "landed";

export type StackWatchOutcome = "attention" | "landed" | "failed" | "timeout" | "aborted";

export type RunStackWatchOptions = {
  until?: StackWatchUntil;
  ignore?: readonly string[];
  maxMs?: number;
  json?: boolean;
  cursor?: StackWatchCursor;
  signal?: AbortSignal;
  write?: (line: string) => void;
  writeMarker?: (line: string) => void;
  poll?: typeof pollStackWatch;
  readLanded?: (cfg: Config, stackId: string) => Promise<MergeQueueEntryDto | null>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

export type StackWatchLoopResult = {
  outcome: StackWatchOutcome;
  exitCode: number;
  envelope: StackWatchEnvelope | null;
};

const ELAPSED_MINUTES = /\b\d+m\b/g;

export function blockerWithoutElapsedMinutes(blocker: string | null | undefined): string {
  return (blocker ?? "").replace(ELAPSED_MINUTES, "Nm");
}

export function stackWatchAttentionKey(envelope: Pick<StackWatchEnvelope, "prNumber" | "headSha" | "blocker">): string {
  return `${envelope.prNumber ?? ""}|${envelope.headSha ?? ""}|${blockerWithoutElapsedMinutes(envelope.blocker)}`;
}

export function stackWatchAttentionLine(envelope: StackWatchEnvelope): string {
  return `${STACK_WATCH_MARKER} ATTENTION pr=${envelope.prNumber ?? "none"} head=${envelope.headSha ?? "none"} blocker=${JSON.stringify(envelope.blocker ?? "")} repair=${envelope.repair?.kind ?? "none"}`;
}

export function stackWatchLandedLine(envelope: StackWatchEnvelope): string {
  return `${STACK_WATCH_MARKER} LANDED stack=${envelope.stackId} reason=${envelope.watch.reason}`;
}

export function stackWatchFailedLine(stackId: string, message: string): string {
  return `${STACK_WATCH_MARKER} ATTENTION failed stack=${stackId} error=${JSON.stringify(message)}`;
}

export function stackWatchTimeoutLine(stackId: string, maxMs: number): string {
  return `${STACK_WATCH_MARKER} TIMEOUT stack=${stackId} after=${Math.round(maxMs / 60_000)}m`;
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

export async function runStackWatch(
  cfg: Config,
  stackId: string,
  opts: RunStackWatchOptions = {},
): Promise<StackWatchLoopResult> {
  const id = stackId.trim().toLowerCase();
  const until = opts.until ?? "attention";
  const ignore = opts.ignore ?? [];
  const write = opts.write ?? ((line: string) => console.log(line));
  const writeMarker = opts.json ? opts.writeMarker ?? ((line: string) => console.error(line)) : write;
  const poll = opts.poll ?? pollStackWatch;
  const readLanded = opts.readLanded ?? readLandedQueueEntry;
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  const deadline = opts.maxMs !== undefined ? now() + opts.maxMs : Number.POSITIVE_INFINITY;
  const emit = (line: string, envelope: StackWatchEnvelope | null, outcome: StackWatchOutcome | null) => {
    writeMarker(line);
    if (opts.json && outcome) write(JSON.stringify(envelope ?? { stackId: id, outcome }));
  };
  const pause = async (ms: number) => {
    const remaining = Math.min(ms, Math.max(0, deadline - now()));
    if (remaining > 0) await wait(remaining, opts.signal);
  };

  let cursor = opts.cursor;
  let failures = 0;
  let permanentFailures = 0;
  const seenPrs = new Set<number>();
  const notePrs = (envelope: StackWatchEnvelope) => {
    if (envelope.prNumber) seenPrs.add(envelope.prNumber);
    if (envelope.currentCandidate?.prNumber) seenPrs.add(envelope.currentCandidate.prNumber);
  };
  let transientSince: number | null = null;
  const ignoredKeys = new Map<string, string>();
  let reportedKey: string | null = null;

  const confirmedLanding = async (envelope: StackWatchEnvelope): Promise<StackWatchEnvelope> => {
    if (envelope.watch.reason !== "not_found") return envelope;
    let entry: MergeQueueEntryDto | null = null;
    try {
      entry = await readLanded(cfg, id);
    } catch {
      return {
        ...envelope,
        watch: {
          ...envelope.watch,
          reason: "landing_unconfirmed",
          message: "The stack is gone, but its landed merge queue entry could not be read. Landing is unconfirmed. Confirm each PR is merged (gh pr view <n> --json state) before reporting it landed. The watch is done; do not report it landed.",
        },
      };
    }
    const enrolledHead = envelope.cursor?.enrolledHeadSha ?? null;
    const ours = Boolean(entry) && (
      entry!.landedPrNumbers.some((pr) => seenPrs.has(pr)) ||
      (enrolledHead !== null && entry!.verifyHeadSha === enrolledHead)
    );
    if (!entry || !ours) return envelope;
    return { ...envelope, watch: { ...envelope.watch, reason: "landed", message: `This stack is landed (merge queue landed #${entry.landedPrNumbers.join(", #")}). The watch is done; stop calling stack_wait for it.` } };
  };
  const finished = async (seen: StackWatchEnvelope): Promise<StackWatchLoopResult> => {
    const envelope = await confirmedLanding(seen);
    const landed = envelope.watch.reason === "landed";
    const outcome = landed ? "landed" : "attention";
    emit(landed ? stackWatchLandedLine(envelope)
      : `${STACK_WATCH_MARKER} ATTENTION stack=${envelope.stackId} reason=${envelope.watch.reason}`, envelope, outcome);
    if (!opts.json) write(envelope.watch.message);
    return { outcome, exitCode: landed ? STACK_WATCH_EXIT.landed : STACK_WATCH_EXIT.attention, envelope };
  };
  const failed = async (
    message: string,
    envelope: StackWatchEnvelope | null,
    transient: boolean,
  ): Promise<StackWatchLoopResult | null> => {
    failures += 1;
    if (transient) {
      permanentFailures = 0;
      transientSince ??= now();
      if (now() - transientSince < STACK_WATCH_TRANSIENT_WINDOW_MS) {
        await pause(Math.min(STACK_WATCH_TRANSIENT_MAX_WAIT_MS, STACK_WATCH_FAILED_RETRY_MS * 2 ** Math.min(failures - 1, 4)));
        return null;
      }
    } else {
      permanentFailures += 1;
    }
    if (permanentFailures >= 2 || transient) {
      emit(stackWatchFailedLine(id, message), envelope, "failed");
      return { outcome: "failed", exitCode: STACK_WATCH_EXIT.attention, envelope };
    }
    await pause(STACK_WATCH_FAILED_RETRY_MS);
    return null;
  };

  try {
    while (now() < deadline) {
      let envelope: StackWatchEnvelope;
      try {
        envelope = await poll(cfg, id, {
          timeoutMs: Math.min(STACK_WATCH_SLICE_MS, Math.max(0, deadline - now())),
          ...(cursor ? { cursor } : {}),
          signal: opts.signal,
        });
      } catch (err) {
        if (isAbort(err, opts.signal)) throw err;
        if (err instanceof StackWatchTimeoutError) {
          notePrs(err.lastEnvelope);
          cursor = err.lastEnvelope.cursor;
          failures = 0;
          permanentFailures = 0;
          if (err.lastEnvelope.assessment === "available") transientSince = null;
          continue;
        }
        if (err instanceof StackWatchError && err.lastEnvelope.watch.done) {
          notePrs(err.lastEnvelope);
          return await finished(err.lastEnvelope);
        }
        if (err instanceof StackWatchError && err.lastEnvelope.status === "rate_limited") {
          await pause(err.retryAfterSeconds !== undefined ? Math.max(1_000, err.retryAfterSeconds * 1000) : STACK_WATCH_RATE_LIMIT_WAIT_MS);
          continue;
        }
        const result = await failed(err instanceof Error ? err.message : String(err),
          err instanceof StackWatchError ? err.lastEnvelope : null, isTransientWatchFailure(err));
        if (result) return result;
        continue;
      }
      failures = 0;
      permanentFailures = 0;
      transientSince = null;
      cursor = envelope.cursor;
      notePrs(envelope);
      if (envelope.watch.done) return await finished(envelope);
      if (envelope.status === "attention") {
        const key = stackWatchAttentionKey(envelope);
        const blocker = (envelope.blocker ?? "").toLowerCase();
        for (const needle of ignore) {
          const normalizedNeedle = needle.trim().toLowerCase();
          if (normalizedNeedle && blocker.includes(normalizedNeedle) && !ignoredKeys.has(normalizedNeedle)) {
            ignoredKeys.set(normalizedNeedle, key);
          }
        }
        const silent = [...ignoredKeys.values()].includes(key) || key === reportedKey;
        if (!silent) {
          emit(stackWatchAttentionLine(envelope), envelope, until === "attention" ? "attention" : null);
          if (until === "attention") return { outcome: "attention", exitCode: STACK_WATCH_EXIT.attention, envelope };
          reportedKey = key;
        }
      }
      await pause(STACK_WATCH_RECHECK_MS);
    }
  } catch (err) {
    if (isAbort(err, opts.signal)) {
      if (opts.json) write(JSON.stringify({ stackId: id, outcome: "aborted" }));
      return { outcome: "aborted", exitCode: 130, envelope: null };
    }
    throw err;
  }
  emit(stackWatchTimeoutLine(id, opts.maxMs ?? 0), null, "timeout");
  return { outcome: "timeout", exitCode: STACK_WATCH_EXIT.timeout, envelope: null };
}
