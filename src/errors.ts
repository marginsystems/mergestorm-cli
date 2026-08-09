/**
 * Stable machine codes for CommandError control flow.
 * UX copy in `message` may change freely; match on `code`, never on message text.
 */
export type CommandErrorCode =
  | "auth_invalid"
  | "api_timeout"
  | "not_a_repo"
  | "missing_api_key";

/** Thrown by command handlers; one-shot mode maps `exitCode` onto process.exitCode. */
export class CommandError extends Error {
  readonly exitCode: number;
  readonly code?: CommandErrorCode;

  constructor(message: string, exitCode = 1, code?: CommandErrorCode) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
    this.code = code;
  }
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
