import { getReview } from "../api.js";
import { loadConfig } from "../config.js";
import { showLinePanel } from "../ui/line-tabs.js";
import { canBrowse, formatJobDetailLines } from "./browse.js";
import {
  CommandError,
  DetachedError,
  REVIEW_EXIT,
  isCommandErrorCode,
} from "../errors.js";
import { ansi } from "../ui/ansi.js";
import { renderFindings, type ReviewFindings } from "../ui/findings.js";
import {
  toReviewJobEnvelope,
  type ReviewEnvelopeFallbacks,
  type ReviewJobRow,
} from "../ui/job-envelope.js";
import {
  REVIEW_POLL_DEFAULT_TIMEOUT_MS,
  ReviewPollTimeoutError,
  pollReview,
} from "./review-client.js";

export type ParsedStatusArgs = {
  jobId: string;
  format: "json" | "pretty";
  wait: boolean;
  timeoutMs: number;
};

export type StatusOptions = {
  /** Oneshot defaults to json; the shell defaults to pretty. */
  defaultFormat?: "json" | "pretty";
  signal?: AbortSignal;
  /** When true, Ctrl+C / per-request timeout detaches instead of exiting 5. */
  interactive?: boolean;
  /** Test seam; production uses the two-second poll interval. */
  pollIntervalMs?: number;
  /** Shell: route --json through the hold-to-read panel instead of console.log. */
  mode?: "oneshot" | "shell";
};

const STATUS_USAGE =
  "usage: mergestorm status <job_id> [--json] [--wait] [--timeout seconds]";

function usageError(message = STATUS_USAGE): CommandError {
  return new CommandError(message, REVIEW_EXIT.usage, "usage");
}

export function parseStatusArgs(
  args: string[],
  defaults: { format: "json" | "pretty" } = { format: "json" },
): ParsedStatusArgs {
  let jobId: string | undefined;
  let format = defaults.format;
  let wait = false;
  let timeoutMs = REVIEW_POLL_DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--json") {
      format = "json";
      continue;
    }
    if (a === "--pretty") {
      format = "pretty";
      continue;
    }
    if (a === "--wait") {
      wait = true;
      continue;
    }
    if (a === "--no-wait") {
      wait = false;
      continue;
    }
    if (a === "--timeout" || a.startsWith("--timeout=")) {
      const value = a === "--timeout" ? args[++i] : a.slice("--timeout=".length);
      const seconds = Number(value);
      if (!value || !Number.isFinite(seconds) || seconds <= 0) {
        throw usageError("--timeout must be a positive number of seconds");
      }
      timeoutMs = Math.round(seconds * 1_000);
      wait = true;
      continue;
    }
    if (a.startsWith("-")) {
      throw usageError(`unknown flag: ${a}`);
    }
    if (jobId) throw usageError();
    jobId = a;
  }
  if (!jobId) throw usageError();
  return { jobId, format, wait, timeoutMs };
}

function printPretty(row: ReviewJobRow): void {
  const envelope = toReviewJobEnvelope(row);
  console.log(`Status:  ${envelope.status}`);
  if (envelope.verdict) console.log(`Verdict: ${ansi.bold(envelope.verdict)}`);
  if (envelope.router_mode) console.log(`Router:  ${envelope.router_mode}`);
  if (envelope.specialists_requested.length > 0) {
    console.log(`Requested: ${envelope.specialists_requested.join(", ")}`);
  }
  if (envelope.specialists_run.length > 0) {
    console.log(`Run:       ${envelope.specialists_run.join(", ")}`);
  }
  if (envelope.credits) {
    console.log(`Credits:   ${envelope.credits.standard} standard`);
  }
  if (envelope.summary) console.log(envelope.summary);
  if (envelope.error) console.log(ansi.red(`Error: ${envelope.error}`));
  renderFindings(envelope.findings as ReviewFindings | null | undefined, {
    emptyMessage: envelope.status === "completed",
  });
}

async function showPretty(row: ReviewJobRow): Promise<void> {
  if (canBrowse()) {
    await showLinePanel("Job", formatJobDetailLines(row));
    return;
  }
  printPretty(row);
}

export async function cmdStatus(
  args: string[],
  opts: StatusOptions = {},
): Promise<void> {
  const parsed = parseStatusArgs(args, {
    format: opts.defaultFormat ?? "json",
  });
  const json = parsed.format === "json";
  const interactive = Boolean(opts.interactive && !json);
  const fallback: ReviewEnvelopeFallbacks = { jobId: parsed.jobId };
  let jsonPrinted = false;
  const printJson = async (
    row: ReviewJobRow | null,
    extra: ReviewEnvelopeFallbacks = {},
  ): Promise<void> => {
    const text = JSON.stringify(
      toReviewJobEnvelope(row, { ...fallback, ...extra }),
      null,
      opts.mode === "shell" ? 2 : undefined,
    );
    if (opts.mode === "shell") {
      await showLinePanel("Job", text.split("\n"));
    } else {
      console.log(text);
    }
    jsonPrinted = true;
  };

  try {
    const cfg = await loadConfig();
    if (!parsed.wait) {
      let body: unknown;
      try {
        body = await getReview(parsed.jobId, cfg, { signal: opts.signal });
      } catch (err) {
        if (
          err instanceof CommandError &&
          (err.code === "auth_invalid" || err.code === "missing_api_key")
        ) {
          throw err;
        }
        if (err instanceof Error && err.name === "AbortError") throw err;
        if (isCommandErrorCode(err, "api_timeout")) {
          if (json) await printJson(null, { status: "in_progress", error: err.message });
          throw new CommandError(err.message, REVIEW_EXIT.timeout, "review_timeout");
        }
        if (isCommandErrorCode(err, "rate_limited")) {
          if (json) {
            await printJson(null, {
              status: "rate_limited",
              error: err.message,
              retryAfterSeconds: err.retryAfterSeconds,
            });
          } else {
            console.log(`Status:  rate_limited`);
            console.log(err.message);
          }
          throw err;
        }
        throw new CommandError(
          err instanceof Error ? err.message : String(err),
          REVIEW_EXIT.failed,
          "review_failed",
        );
      }
      const row =
        body && typeof body === "object"
          ? { ...(body as ReviewJobRow), job_id: parsed.jobId }
          : { job_id: parsed.jobId, status: "failed", error: "Invalid review response" };
      if (row.status === "failed" || row.status === "quota_exceeded") {
        if (json) await printJson(row);
        else await showPretty(row);
        throw new CommandError(
          `Review ${row.status}: ${row.error ?? ""}`,
          row.status === "quota_exceeded" ? REVIEW_EXIT.quota : REVIEW_EXIT.failed,
          row.status === "quota_exceeded" ? "review_quota" : "review_failed",
        );
      }
      if (json) await printJson(row);
      else await showPretty(row);
      return;
    }

    if (!json) {
      const waitHint = interactive
        ? ` Waiting… (${ansi.dim("ctrl+c to detach — job keeps running")})`
        : " Waiting…";
      console.log(`Job ${parsed.jobId}.${waitHint}`);
    }

    let row: ReviewJobRow;
    try {
      row = await pollReview(cfg, parsed.jobId, {
        timeoutMs: parsed.timeoutMs,
        intervalMs: opts.pollIntervalMs,
        signal: opts.signal,
        propagateTimeout: interactive,
        onTick(kind) {
          if (json) console.error(kind === "retry" ? "?" : ".");
          else process.stdout.write(kind === "retry" ? "?" : ".");
        },
      });
    } catch (err) {
      if (opts.interactive && err instanceof Error && err.name === "AbortError") {
        throw new DetachedError(parsed.jobId);
      }
      if (interactive && isCommandErrorCode(err, "api_timeout")) {
        throw new DetachedError(parsed.jobId);
      }
      if (err instanceof ReviewPollTimeoutError) {
        const message = `Timed out waiting for review ${parsed.jobId}`;
        if (json) {
          await printJson(err.lastRow, {
            jobId: parsed.jobId,
            status: err.lastRow.status ?? "in_progress",
            error: "Timed out waiting for review.",
          });
        }
        throw new CommandError(message, REVIEW_EXIT.timeout, "review_timeout");
      }
      if (isCommandErrorCode(err, "rate_limited")) {
        if (json) {
          await printJson(null, {
            status: "rate_limited",
            error: err.message,
            retryAfterSeconds: err.retryAfterSeconds,
          });
        } else {
          console.log(`Status:  rate_limited`);
          console.log(err.message);
        }
        throw err;
      }
      throw err;
    }

    if (!json) console.log("");
    if (row.status === "failed" || row.status === "quota_exceeded") {
      const message = `Review ${row.status}: ${row.error ?? ""}`;
      if (json) await printJson(row);
      else await showPretty(row);
      throw new CommandError(
        message,
        row.status === "quota_exceeded" ? REVIEW_EXIT.quota : REVIEW_EXIT.failed,
        row.status === "quota_exceeded" ? "review_quota" : "review_failed",
      );
    }

    if (json) await printJson(row);
    else await showPretty(row);
  } catch (err) {
    if (err instanceof DetachedError) throw err;
    if (
      json &&
      !jsonPrinted &&
      !(err instanceof Error && err.name === "AbortError")
    ) {
      const message = err instanceof Error ? err.message : String(err);
      await printJson(null, { status: "failed", error: message });
    }
    if (
      err instanceof CommandError &&
      (err.code === "auth_invalid" || err.code === "missing_api_key")
    ) {
      throw new CommandError(err.message, REVIEW_EXIT.auth, err.code);
    }
    throw err;
  }
}
