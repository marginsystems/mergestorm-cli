import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  apiFetch,
  applyPrReviewQuery,
  isPositiveInteger,
  type PrReviewPassSelector,
  type PrVortexReview,
} from "../api.js";
import type { Config } from "../config.js";
import { CommandError, REVIEW_EXIT, isCommandErrorCode, rateLimitedMessage } from "../errors.js";
import {
  changedNamesInSandbox,
  collectChangedFiles,
  git,
  parseGithubOriginRepo,
  repoRoot,
} from "../git.js";
import type { ReviewJobRow } from "../ui/job-envelope.js";

export const REVIEW_POLL_INTERVAL_MS = 2_000;
export const REVIEW_POLL_DEFAULT_TIMEOUT_MS = 480_000;
export const REVIEW_POLL_MAX_TRANSIENT_RETRIES = 3;
export const REVIEW_POLL_BACKOFF_MS = 250;
export const REVIEW_POLL_MAX_INTERVAL_MS = 5_000;
export const REVIEW_POLL_STRETCH_AFTER_MS = 60_000;
export const REVIEW_POLL_STRETCH_SPAN_MS = 60_000;

/** Same thread slug contract as POST /api/v1/reviews. */
export const REVIEW_THREAD_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/;
/** Same product limit as `api/src/v1/reviews.ts` `MAX_DIFF_BYTES`. */
export const MAX_REVIEW_DIFF_BYTES = 1_000_000;
export const MAX_CONTEXT_TEXT_CHARS = 60_000;
export const MAX_CONTEXT_FILES = 10;
export const MAX_CONTEXT_FILE_CHARS = 16_000;
export const MAX_CONTEXT_FILES_TOTAL = 60_000;
export const MAX_IDEMPOTENCY_KEY_CHARS = 128;

export type ReviewInput = {
  thread: string;
  branch: string;
  repo?: string;
  baseLabel: string;
  headLabel: string;
  diff: string;
  files: { path: string; content: string }[];
};

export async function collectReviewInput(
  base: string,
  head: string,
  cwd = process.cwd(),
  sandboxRoot?: string,
): Promise<ReviewInput | null> {
  let diff: string;
  try {
    const names = await changedNamesInSandbox(base, head, cwd, sandboxRoot);
    if (names.length === 0) {
      diff = "";
    } else {
      const canonicalCwd = await realpath(cwd);
      const root = repoRoot(canonicalCwd);
      const specs = names.map(
        (name) => `:(literal)${relative(canonicalCwd, join(root, name))}`,
      );
      // Collection must not execute configured diff or text conversion helpers.
      diff = git(["diff", "--no-ext-diff", "--no-textconv", `${base}...${head}`, "--", ...specs], cwd);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `Could not diff ${base}...${head}: ${detail}. Try \`mergestorm review <base>\` with your trunk branch.`,
      2,
      "usage",
    );
  }
  if (!diff.trim()) return null;

  const files = await collectChangedFiles(base, head, cwd, sandboxRoot);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim() || "local";
  const thread = `local/${branch}`.replace(/[^a-zA-Z0-9._/-]/g, "-").slice(0, 120);
  const originRepo = parseGithubOriginRepo(cwd);
  return {
    thread,
    branch,
    ...(originRepo ? { repo: `${originRepo.owner}/${originRepo.repo}` } : {}),
    baseLabel: base,
    headLabel: head,
    diff,
    files,
  };
}

export type SubmitReviewOptions = {
  routerMode?: string;
  specialists?: string[];
  context?: string;
  contextFiles?: { path: string; content: string }[];
  idempotencyKey?: string;
  webhookUrl?: string;
  signal?: AbortSignal;
};

export type ReviewContextPayload = {
  context?: string;
  contextFiles?: { path: string; content: string }[];
};

export type LoadReviewContextOptions = {
  context?: string;
  contextFiles: string[];
  cwd?: string;
  readStdin?: () => Promise<string>;
  /** Bound contextFiles to this directory; defaults to the canonical repo root. */
  sandboxCwd?: string;
};

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function contextUsage(message: string): CommandError {
  return new CommandError(message, REVIEW_EXIT.usage, "usage");
}

/** Load --context / --context-file and enforce the API caps client-side. */
export async function loadReviewContext(
  opts: LoadReviewContextOptions,
): Promise<ReviewContextPayload> {
  const cwd = opts.cwd ?? process.cwd();
  let context: string | undefined;
  if (opts.context !== undefined) {
    const raw =
      opts.context === "-"
        ? await (opts.readStdin ?? defaultReadStdin)()
        : opts.context;
    context = raw.trim();
    if (!context) {
      throw contextUsage("--context is empty");
    }
    if (context.length > MAX_CONTEXT_TEXT_CHARS) {
      throw contextUsage(
        `--context is ${context.length} chars; max is ${MAX_CONTEXT_TEXT_CHARS}`,
      );
    }
  }

  if (opts.contextFiles.length > MAX_CONTEXT_FILES) {
    throw contextUsage(
      `--context-file may be repeated at most ${MAX_CONTEXT_FILES} times`,
    );
  }

  const contextFiles: { path: string; content: string }[] = [];
  let total = 0;
  for (const rawPath of opts.contextFiles) {
    const abs = resolve(cwd, rawPath);
    const boundaryLabel = opts.sandboxCwd ? "working directory" : "repo root";
    let targetReal: string;
    let sandboxReal: string;
    try {
      sandboxReal = opts.sandboxCwd ? await realpath(resolve(opts.sandboxCwd)) : repoRoot(cwd);
    } catch {
      throw contextUsage(
        `--context-file ${rawPath} must be inside the ${boundaryLabel}`,
      );
    }
    try {
      targetReal = await realpath(abs);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw contextUsage(`could not read --context-file ${rawPath}: ${detail}`);
    }
    if (targetReal !== sandboxReal && !targetReal.startsWith(`${sandboxReal}${sep}`)) {
      throw contextUsage(`--context-file ${rawPath} must be inside the ${boundaryLabel}`);
    }
    let content: string;
    try {
      content = await readFile(targetReal, "utf8");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw contextUsage(`could not read --context-file ${rawPath}: ${detail}`);
    }
    if (content.length > MAX_CONTEXT_FILE_CHARS) {
      throw contextUsage(
        `--context-file ${rawPath} is ${content.length} chars; max is ${MAX_CONTEXT_FILE_CHARS} per file`,
      );
    }
    total += content.length;
    if (total > MAX_CONTEXT_FILES_TOTAL) {
      throw contextUsage(
        `--context-file total is ${total} chars; max is ${MAX_CONTEXT_FILES_TOTAL}`,
      );
    }
    contextFiles.push({ path: relative(cwd, abs), content });
  }

  return {
    ...(context ? { context } : {}),
    ...(contextFiles.length > 0 ? { contextFiles } : {}),
  };
}

export async function submitReview(
  cfg: Config,
  input: ReviewInput,
  opts: SubmitReviewOptions = {},
): Promise<{ status: number; row: ReviewJobRow; retryAfterSeconds?: number }> {
  const { status, body, retryAfterSeconds } = await apiFetch(cfg, "/api/v1/reviews", {
    method: "POST",
    json: {
      thread: input.thread,
      branch: input.branch,
      ...(input.repo ? { repo: input.repo } : {}),
      base_label: input.baseLabel,
      head_label: input.headLabel,
      diff: input.diff,
      files: input.files,
      ...(opts.routerMode ? { router_mode: opts.routerMode } : {}),
      ...(opts.specialists?.length ? { specialists: opts.specialists } : {}),
      ...(opts.context ? { context: opts.context } : {}),
      ...(opts.contextFiles?.length ? { context_files: opts.contextFiles } : {}),
      ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
      ...(opts.webhookUrl ? { webhook_url: opts.webhookUrl } : {}),
    },
    signal: opts.signal,
  });
  return {
    status,
    row: body && typeof body === "object" ? (body as ReviewJobRow) : {},
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

function reviewSubmitErrorText(body: unknown): string {
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    const message = typeof rec.message === "string" ? rec.message.trim() : "";
    const error = typeof rec.error === "string" ? rec.error.trim() : "";
    if (message) return message;
    if (error) return error;
  }
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed && !trimmed.startsWith("<")) return trimmed.slice(0, 240);
  }
  return "";
}

/**
 * Human copy for a failed POST /api/v1/reviews.
 * nginx 413 is HTML, so `submitReview` stores `{}` and used to print `Failed: {}`.
 */
export function formatReviewSubmitError(status: number, body: unknown): string {
  const detail = reviewSubmitErrorText(body);
  if (status === 413) {
    if (detail) return `${detail} No review job was created and no credits were charged.`;
    return (
      "Upload rejected (HTTP 413). nginx stopped the body before a review job was created, " +
      "so no credits were charged. Max diff size is 1 MB / 1_000_000 bytes."
    );
  }
  if (detail) return `Failed (HTTP ${status}): ${detail}`;
  return `Failed (HTTP ${status}). The API did not return a JSON error body.`;
}

/** Exponential backoff with jitter in `[0.5, 1.0]` of the base delay. */
export function transientRetryWaitMs(input: {
  retryAfterSeconds?: number;
  failureCount: number;
  random?: () => number;
}): number {
  const exp = REVIEW_POLL_BACKOFF_MS * 2 ** Math.max(0, input.failureCount - 1);
  const jitter = 0.5 + (input.random ?? Math.random)() * 0.5;
  const backoff = Math.min(REVIEW_POLL_MAX_INTERVAL_MS, Math.round(exp * jitter));
  const fromHeader =
    input.retryAfterSeconds != null && Number.isFinite(input.retryAfterSeconds)
      ? Math.round(input.retryAfterSeconds * 1000)
      : 0;
  return Math.max(fromHeader, backoff);
}

/** Keep the default 2s cadence for a minute, then ramp toward 5s. */
export function stretchedPollIntervalMs(elapsedMs: number, intervalMs: number): number {
  if (intervalMs !== REVIEW_POLL_INTERVAL_MS) return intervalMs;
  if (elapsedMs < REVIEW_POLL_STRETCH_AFTER_MS) return intervalMs;
  const t = Math.min(
    1,
    (elapsedMs - REVIEW_POLL_STRETCH_AFTER_MS) / REVIEW_POLL_STRETCH_SPAN_MS,
  );
  return Math.round(intervalMs + t * (REVIEW_POLL_MAX_INTERVAL_MS - intervalMs));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isTransientReviewPollStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function isTransientReviewPollError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  if (err instanceof CommandError) return err.code === "api_timeout";
  if (err instanceof TypeError && /fetch|network|connection/i.test(err.message)) return true;
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(
    err.message,
  );
}

export class ReviewPollTimeoutError extends Error {
  readonly jobId: string;
  readonly lastRow: ReviewJobRow;

  constructor(jobId: string, lastRow: ReviewJobRow) {
    super(`Timed out waiting for review ${jobId}`);
    this.name = "ReviewPollTimeoutError";
    this.jobId = jobId;
    this.lastRow = lastRow;
  }
}

export class PrReviewPollTimeoutError extends Error {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly lastEnvelope: PrVortexReview | null;

  constructor(
    owner: string,
    repo: string,
    prNumber: number,
    lastEnvelope: PrVortexReview | null,
  ) {
    super(`Timed out waiting for PR review ${owner}/${repo}#${prNumber}`);
    this.name = "PrReviewPollTimeoutError";
    this.owner = owner;
    this.repo = repo;
    this.prNumber = prNumber;
    this.lastEnvelope = lastEnvelope;
  }
}

export type PollReviewOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  onTick?: (kind: "progress" | "retry") => void;
  /** Rethrow per-request api_timeout instead of folding it into a poll timeout (interactive detach). */
  propagateTimeout?: boolean;
  /** Test seam; production uses `setTimeout`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam; production uses `Date.now`. */
  now?: () => number;
  /** Test seam for backoff jitter; production uses `Math.random`. */
  random?: () => number;
};

export type PollPrVortexReviewOptions = PollReviewOptions &
  PrReviewPassSelector & {
    afterSha?: string;
  };

function shaMatches(actual: string | null | undefined, expected: string): boolean {
  const left = actual?.trim().toLowerCase() ?? "";
  const right = expected.trim().toLowerCase();
  return Boolean(
    left && right.length >= 7 && (left.startsWith(right) || right.startsWith(left)),
  );
}

/** Poll the DB-only PR review endpoint until the requested pass is resting. */
export async function pollPrVortexReview(
  cfg: Config,
  owner: string,
  repo: string,
  prNumber: number,
  opts: PollPrVortexReviewOptions = {},
): Promise<PrVortexReview> {
  const timeoutMs = opts.timeoutMs ?? REVIEW_POLL_DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? REVIEW_POLL_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? sleep;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const query = new URLSearchParams({
    owner,
    repo,
    pr_number: String(prNumber),
  });
  // #2027: the pass selector is fixed for the whole wait. after_pass stays
  // what the caller handed in on every poll and every retry; it is never
  // replaced by the pass of an in-progress envelope seen along the way.
  applyPrReviewQuery(query, opts);
  let transientFailures = 0;
  let lastEnvelope: PrVortexReview | null = null;

  const sleepBeforeRetry = async (retryAfterSeconds?: number) => {
    const waitMs = Math.min(
      transientRetryWaitMs({
        retryAfterSeconds,
        failureCount: transientFailures,
        random: opts.random,
      }),
      Math.max(0, deadline - now()),
    );
    if (waitMs > 0) await wait(waitMs, opts.signal);
  };

  const sleepBeforePoll = async () => {
    const waitMs = Math.min(
      stretchedPollIntervalMs(now() - startedAt, intervalMs),
      Math.max(0, deadline - now()),
    );
    if (waitMs > 0) await wait(waitMs, opts.signal);
  };

  while (now() < deadline) {
    let poll: { status: number; body: unknown; retryAfterSeconds?: number };
    try {
      poll = await apiFetch(cfg, `/api/v1/stacks/pr-review?${query.toString()}`, {
        signal: opts.signal,
        timeoutMs: Math.max(1, Math.min(30_000, deadline - now())),
      });
    } catch (err) {
      if (
        isTransientReviewPollError(err) &&
        transientFailures < REVIEW_POLL_MAX_TRANSIENT_RETRIES
      ) {
        transientFailures += 1;
        opts.onTick?.("retry");
        await sleepBeforeRetry();
        continue;
      }
      if (isCommandErrorCode(err, "api_timeout")) {
        if (opts.propagateTimeout) throw err;
        break;
      }
      if (isTransientReviewPollError(err)) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new CommandError(
          `Poll failed: ${detail}`,
          REVIEW_EXIT.failed,
          "review_failed",
        );
      }
      throw err;
    }

    if (poll.status === 404) {
      transientFailures = 0;
      opts.onTick?.("progress");
      await sleepBeforePoll();
      continue;
    }
    if (poll.status !== 200) {
      if (
        isTransientReviewPollStatus(poll.status) &&
        transientFailures < REVIEW_POLL_MAX_TRANSIENT_RETRIES
      ) {
        transientFailures += 1;
        opts.onTick?.("retry");
        await sleepBeforeRetry(poll.retryAfterSeconds);
        continue;
      }
      if (poll.status === 429) {
        throw new CommandError(
          rateLimitedMessage(poll.retryAfterSeconds),
          REVIEW_EXIT.rate_limited,
          "rate_limited",
          { retryAfterSeconds: poll.retryAfterSeconds },
        );
      }
      throw new CommandError(
        `Poll failed: ${JSON.stringify(poll.body, null, 2)}`,
        REVIEW_EXIT.failed,
        "review_failed",
      );
    }

    transientFailures = 0;
    if (!poll.body || typeof poll.body !== "object") {
      throw new CommandError(
        "Poll failed: invalid PR review response",
        REVIEW_EXIT.failed,
        "review_failed",
      );
    }
    const envelope = poll.body as PrVortexReview;
    // The server filters by pass; re-check here so a server that ignores the
    // selector can never satisfy the wait with the wrong pass.
    if (
      (opts.pass !== undefined || opts.afterPass !== undefined) &&
      (!isPositiveInteger(envelope.pass) || (opts.pass !== undefined && envelope.pass !== opts.pass) ||
        (opts.afterPass !== undefined && envelope.pass <= opts.afterPass))
    ) {
      opts.onTick?.("progress");
      await sleepBeforePoll();
      continue;
    }
    lastEnvelope = envelope;
    const resting = (lastEnvelope.raw_status ?? lastEnvelope.status) !== "in_progress";
    const matches = !opts.afterSha || shaMatches(lastEnvelope.head_sha, opts.afterSha);
    if (resting && matches) return lastEnvelope;

    opts.onTick?.("progress");
    await sleepBeforePoll();
  }

  throw new PrReviewPollTimeoutError(owner, repo, prNumber, lastEnvelope);
}

export async function pollReview(
  cfg: Config,
  jobId: string,
  opts: PollReviewOptions = {},
): Promise<ReviewJobRow> {
  const timeoutMs = opts.timeoutMs ?? REVIEW_POLL_DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? REVIEW_POLL_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? sleep;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let transientFailures = 0;
  let lastRow: ReviewJobRow = { job_id: jobId, status: "queued" };

  const sleepBeforeRetry = async (retryAfterSeconds?: number) => {
    const waitMs = Math.min(
      transientRetryWaitMs({
        retryAfterSeconds,
        failureCount: transientFailures,
        random: opts.random,
      }),
      Math.max(0, deadline - now()),
    );
    if (waitMs > 0) await wait(waitMs, opts.signal);
  };

  while (now() < deadline) {
    let poll: { status: number; body: unknown; retryAfterSeconds?: number };
    try {
      poll = await apiFetch(cfg, `/api/v1/reviews/${jobId}`, {
        signal: opts.signal,
        timeoutMs: Math.max(1, Math.min(30_000, deadline - now())),
      });
    } catch (err) {
      if (
        isTransientReviewPollError(err) &&
        transientFailures < REVIEW_POLL_MAX_TRANSIENT_RETRIES
      ) {
        transientFailures += 1;
        opts.onTick?.("retry");
        await sleepBeforeRetry();
        continue;
      }
      if (isCommandErrorCode(err, "api_timeout")) {
        if (opts.propagateTimeout) throw err;
        break;
      }
      if (isTransientReviewPollError(err)) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new CommandError(
          `Poll failed: ${detail}`,
          REVIEW_EXIT.failed,
          "review_failed",
        );
      }
      throw err;
    }

    if (poll.status !== 200) {
      if (
        isTransientReviewPollStatus(poll.status) &&
        transientFailures < REVIEW_POLL_MAX_TRANSIENT_RETRIES
      ) {
        transientFailures += 1;
        opts.onTick?.("retry");
        await sleepBeforeRetry(poll.retryAfterSeconds);
        continue;
      }
      if (poll.status === 429) {
        const message = rateLimitedMessage(poll.retryAfterSeconds);
        throw new CommandError(message, REVIEW_EXIT.rate_limited, "rate_limited", {
          retryAfterSeconds: poll.retryAfterSeconds,
        });
      }
      throw new CommandError(
        `Poll failed: ${JSON.stringify(poll.body, null, 2)}`,
        REVIEW_EXIT.failed,
        "review_failed",
      );
    }

    transientFailures = 0;
    lastRow =
      poll.body && typeof poll.body === "object"
        ? { ...(poll.body as ReviewJobRow), job_id: jobId }
        : { job_id: jobId, status: "failed", error: "Invalid review response" };
    if (lastRow.status === "queued" || lastRow.status === "in_progress") {
      opts.onTick?.("progress");
      const waitMs = Math.min(
        stretchedPollIntervalMs(now() - startedAt, intervalMs),
        Math.max(0, deadline - now()),
      );
      if (waitMs > 0) await wait(waitMs, opts.signal);
      continue;
    }
    return lastRow;
  }

  throw new ReviewPollTimeoutError(jobId, lastRow);
}
