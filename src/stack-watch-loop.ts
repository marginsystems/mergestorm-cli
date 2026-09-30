import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "./config.js";
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
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

export type StackWatchLoopResult = {
  outcome: StackWatchOutcome;
  exitCode: number;
  envelope: StackWatchEnvelope | null;
};

export function stackWatchAttentionKey(envelope: Pick<StackWatchEnvelope, "prNumber" | "headSha" | "blocker">): string {
  return `${envelope.prNumber ?? ""}|${envelope.headSha ?? ""}|${envelope.blocker ?? ""}`;
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
  const ignoredKeys = new Map<string, string>();
  let reportedKey: string | null = null;

  const landed = (envelope: StackWatchEnvelope): StackWatchLoopResult => {
    emit(stackWatchLandedLine(envelope), envelope, "landed");
    if (!opts.json) write(envelope.watch.message);
    return { outcome: "landed", exitCode: STACK_WATCH_EXIT.landed, envelope };
  };
  const failed = async (message: string, envelope: StackWatchEnvelope | null): Promise<StackWatchLoopResult | null> => {
    failures += 1;
    if (failures >= 2) {
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
          cursor = err.lastEnvelope.cursor;
          failures = 0;
          continue;
        }
        if (err instanceof StackWatchError && err.lastEnvelope.watch.done) return landed(err.lastEnvelope);
        if (err instanceof StackWatchError && err.lastEnvelope.status === "rate_limited") {
          await pause(err.retryAfterSeconds !== undefined ? Math.max(1_000, err.retryAfterSeconds * 1000) : STACK_WATCH_RATE_LIMIT_WAIT_MS);
          continue;
        }
        const result = await failed(err instanceof Error ? err.message : String(err),
          err instanceof StackWatchError ? err.lastEnvelope : null);
        if (result) return result;
        continue;
      }
      failures = 0;
      cursor = envelope.cursor;
      if (envelope.watch.done) return landed(envelope);
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
