/** Thrown by command handlers; one-shot mode maps `exitCode` onto process.exitCode. */
export class CommandError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
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
