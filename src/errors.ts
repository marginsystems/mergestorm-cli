/**
 * Stable machine codes for CommandError control flow.
 * UX copy in `message` may change freely; match on `code`, never on message text.
 */
export type CommandErrorCode =
  | "auth_invalid"
  | "api_timeout"
  | "not_a_repo"
  | "not_found"
  | "missing_api_key"
  | "registered_parent"
  | "usage"
  | "review_quota"
  | "review_failed"
  | "review_timeout"
  | "rate_limited";

/** Stable one-shot exit codes for machine callers of `mergestorm review`. */
export const REVIEW_EXIT = {
  success: 0,
  usage: 2,
  quota: 3,
  failed: 4,
  timeout: 5,
  auth: 6,
  rate_limited: 7,
} as const;

export type CommandErrorExtras = {
  retryAfterSeconds?: number;
};

/** Thrown by command handlers; one-shot mode maps `exitCode` onto process.exitCode. */
export class CommandError extends Error {
  readonly exitCode: number;
  readonly code?: CommandErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    exitCode = 1,
    code?: CommandErrorCode,
    extras?: CommandErrorExtras,
  ) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
    this.code = code;
    if (extras?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = extras.retryAfterSeconds;
    }
  }
}

export const RATE_LIMITED_HINT =
  "Rate limited. Wait for a running review or mergestorm jobs.";

export function rateLimitedMessage(retryAfterSeconds?: number): string {
  if (retryAfterSeconds == null || !Number.isFinite(retryAfterSeconds)) {
    return RATE_LIMITED_HINT;
  }
  return `${RATE_LIMITED_HINT} Retry after ${Math.ceil(retryAfterSeconds)}s.`;
}

export function isCommandErrorCode(
  err: unknown,
  code: CommandErrorCode,
): err is CommandError {
  return err instanceof CommandError && err.code === code;
}

/** Review/status poll aborted by Ctrl+C — shell returns to the prompt. */
export class DetachedError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`detached — check later with: status ${jobId}`);
    this.name = "DetachedError";
    this.jobId = jobId;
  }
}
