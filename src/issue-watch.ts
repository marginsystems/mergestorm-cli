import type { Config } from "./config.js";
import {
  API_TIMEOUT_PREFIX,
  IssueReviewTimeoutError,
  issueReviewLines,
  issueReviewStallAdvice,
  pollIssueReview,
  type IssueReviewStatus,
  type IssueReviewTarget,
} from "./api.js";
import { CommandError } from "./errors.js";

const ISSUE_WATCH_MARKER = "MS-ISSUE";
export const ISSUE_WATCH_EXIT = { ready: 0, attention: 3, timeout: 5 } as const;
export const ISSUE_WATCH_NOTIFY_PATTERN = "MS-ISSUE (READY|POINTS|STALLED|ATTENTION|TIMEOUT)";
export const ISSUE_WATCH_SLICE_MS = 300_000;
const ISSUE_WATCH_FAILED_RETRY_MS = 15_000;
const ISSUE_WATCH_TRANSIENT_WINDOW_MS = 15 * 60_000;
const ISSUE_WATCH_TRANSIENT_MAX_WAIT_MS = 60_000;

const TRANSIENT_ISSUE_WATCH_FAILURE = /HTTP (?:408|429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|connection/i;

type IssueWatchOutcome = "ready" | "points" | "stalled" | "failed" | "timeout" | "aborted";

export type IssueWatchResult = { outcome: IssueWatchOutcome; exitCode: number; status: IssueReviewStatus | null };

export type RunIssueWatchOptions = {
  afterRound?: number;
  maxMs?: number;
  json?: boolean;
  signal?: AbortSignal;
  write?: (line: string) => void;
  writeMarker?: (line: string) => void;
  poll?: typeof pollIssueReview;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

function isTransientIssueWatchFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof CommandError && (err.code === "api_timeout" || err.code === "issue_review_unavailable" || err.code === "rate_limited")) return true;
  return err.message.startsWith(API_TIMEOUT_PREFIX) || TRANSIENT_ISSUE_WATCH_FAILURE.test(err.message);
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function issueWatchCommand(repo: string, number: number, afterRound?: number | null): string {
  return `mergestorm issue watch ${number} --repo ${repo}${afterRound ? ` --after-round ${afterRound}` : ""}`;
}

export function issueWatchFailedLine(number: number | string, message: string): string {
  return `${ISSUE_WATCH_MARKER} ATTENTION failed issue=${number} error=${JSON.stringify(message)}`;
}

function verdictRound(status: IssueReviewStatus): number {
  return status.wait.verdictRound ?? status.round ?? 0;
}

export function issueWatchLine(status: IssueReviewStatus): string | null {
  switch (status.wait.status) {
    case "approved":
      return `${ISSUE_WATCH_MARKER} READY issue=${status.number}`;
    case "points":
      return `${ISSUE_WATCH_MARKER} POINTS issue=${status.number} round=${verdictRound(status)}`;
    case "stalled":
      return `${ISSUE_WATCH_MARKER} STALLED issue=${status.number} round=${verdictRound(status)} minutes=${status.wait.minutes ?? 0} reason=${status.wait.reason}`;
    default:
      return null;
  }
}

function issueWatchFollowUp(status: IssueReviewStatus): string[] {
  const lines = issueReviewLines(status);
  if (status.wait.status === "points") {
    lines.push(`  Answer the blocking points in ONE comment on #${status.number}, then run \`${issueWatchCommand(`${status.owner}/${status.repo}`, status.number, verdictRound(status))}\` once in the background.`);
  } else if (status.wait.status === "stalled") {
    lines.push(`  ${issueReviewStallAdvice(status.wait.reason)}`);
  }
  return lines;
}

export async function runIssueWatch(cfg: Config, target: IssueReviewTarget, opts: RunIssueWatchOptions = {}): Promise<IssueWatchResult> {
  const write = opts.write ?? ((line: string) => console.log(line));
  const writeMarker = opts.json ? opts.writeMarker ?? ((line: string) => console.error(line)) : write;
  const poll = opts.poll ?? pollIssueReview;
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? defaultSleep;
  const started = now();
  const deadline = opts.maxMs !== undefined ? started + opts.maxMs : Number.POSITIVE_INFINITY;
  const emit = (line: string, status: IssueReviewStatus | null, outcome: IssueWatchOutcome) => {
    writeMarker(line);
    if (opts.json) write(JSON.stringify(status ?? { issue: target.number, outcome }));
  };
  const pause = async (ms: number) => {
    const remaining = Math.min(ms, Math.max(0, deadline - now()));
    if (remaining > 0) await wait(remaining, opts.signal);
  };
  let failures = 0;
  let permanentFailures = 0;
  let transientSince: number | null = null;
  try {
    while (now() < deadline) {
      const sliceStarted = now();
      let status: IssueReviewStatus | null;
      try {
        status = await poll(cfg, target, {
          timeoutMs: Math.min(ISSUE_WATCH_SLICE_MS, Math.max(1, deadline - now())),
          waitingSince: started,
          ...(opts.afterRound !== undefined ? { afterRound: opts.afterRound } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.sleep ? { sleep: opts.sleep } : {}),
          ...(opts.now ? { now: opts.now } : {}),
        });
      } catch (err) {
        if (isAbort(err, opts.signal)) throw err;
        if (err instanceof IssueReviewTimeoutError) {
          failures = 0;
          permanentFailures = 0;
          transientSince = null;
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        failures += 1;
        if (isTransientIssueWatchFailure(err)) {
          permanentFailures = 0;
          transientSince ??= sliceStarted;
          if (now() - transientSince < ISSUE_WATCH_TRANSIENT_WINDOW_MS) {
            await pause(Math.min(ISSUE_WATCH_TRANSIENT_MAX_WAIT_MS, ISSUE_WATCH_FAILED_RETRY_MS * 2 ** Math.min(failures - 1, 4)));
            continue;
          }
          emit(issueWatchFailedLine(target.number, `No issue review read for 15 minutes: ${message}`), null, "failed");
          return { outcome: "failed", exitCode: ISSUE_WATCH_EXIT.attention, status: null };
        }
        permanentFailures += 1;
        if (permanentFailures >= 2) {
          emit(issueWatchFailedLine(target.number, message), null, "failed");
          return { outcome: "failed", exitCode: ISSUE_WATCH_EXIT.attention, status: null };
        }
        await pause(ISSUE_WATCH_FAILED_RETRY_MS);
        continue;
      }
      if (!status) {
        emit(issueWatchFailedLine(target.number, "This Mergestorm server does not review issues yet."), null, "failed");
        return { outcome: "failed", exitCode: 1, status: null };
      }
      const line = issueWatchLine(status);
      if (!line) continue;
      const outcome: IssueWatchOutcome = status.wait.status === "approved" ? "ready" : status.wait.status === "points" ? "points" : "stalled";
      emit(line, status, outcome);
      if (!opts.json) for (const followUp of issueWatchFollowUp(status)) write(followUp);
      return { outcome, exitCode: outcome === "ready" ? ISSUE_WATCH_EXIT.ready : ISSUE_WATCH_EXIT.attention, status };
    }
  } catch (err) {
    if (isAbort(err, opts.signal)) {
      if (opts.json) write(JSON.stringify({ issue: target.number, outcome: "aborted" }));
      return { outcome: "aborted", exitCode: 130, status: null };
    }
    throw err;
  }
  emit(`${ISSUE_WATCH_MARKER} TIMEOUT issue=${target.number} after=${(opts.maxMs ?? 0) / 60_000}m`, null, "timeout");
  return { outcome: "timeout", exitCode: ISSUE_WATCH_EXIT.timeout, status: null };
}
