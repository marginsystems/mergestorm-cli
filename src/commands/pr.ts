import { getPrVortexReview, type PrVortexReview } from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError, REVIEW_EXIT } from "../errors.js";
import { ansi } from "../ui/ansi.js";
import { renderFindings, type ReviewFindings } from "../ui/findings.js";
import {
  PrReviewPollTimeoutError,
  REVIEW_POLL_DEFAULT_TIMEOUT_MS,
  pollPrVortexReview,
  type PollPrVortexReviewOptions,
} from "./review-client.js";
import { parseAdoptTarget } from "./stack.js";

const PR_USAGE =
  "usage: mergestorm pr <owner/repo>#<n> [--json] [--wait] [--after-sha <sha>] [--timeout <s>]";

export type ParsedPrArgs = {
  owner: string;
  repo: string;
  prNumber: number;
  format: "json" | "pretty";
  wait: boolean;
  afterSha?: string;
  timeoutMs: number;
};

export type PrOptions = {
  defaultFormat?: "json" | "pretty";
  signal?: AbortSignal;
  pollIntervalMs?: number;
  /** Test seams for deterministic polling. */
  poll?: Pick<PollPrVortexReviewOptions, "sleep" | "now" | "random">;
  mode?: "oneshot" | "shell";
};

function usageError(message = PR_USAGE): CommandError {
  return new CommandError(message, REVIEW_EXIT.usage, "usage");
}

export function parsePrArgs(
  args: string[],
  defaults: { format: "json" | "pretty" } = { format: "json" },
): ParsedPrArgs {
  const target: string[] = [];
  let format = defaults.format;
  let wait = false;
  let afterSha: string | undefined;
  let timeoutMs = REVIEW_POLL_DEFAULT_TIMEOUT_MS;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg === "--pretty") {
      format = "pretty";
      continue;
    }
    if (arg === "--wait") {
      wait = true;
      continue;
    }
    if (arg === "--after-sha" || arg.startsWith("--after-sha=")) {
      const value =
        arg === "--after-sha" ? args[++i] : arg.slice("--after-sha=".length);
      if (!value?.trim()) throw usageError("--after-sha requires a non-empty SHA");
      afterSha = value.trim();
      if (afterSha.length < 7) {
        throw usageError("--after-sha must be at least 7 characters");
      }
      if (!/^[0-9a-f]+$/i.test(afterSha)) {
        throw usageError("--after-sha must contain only hexadecimal characters");
      }
      continue;
    }
    if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      const value = arg === "--timeout" ? args[++i] : arg.slice("--timeout=".length);
      const seconds = Number(value);
      if (!value || !Number.isFinite(seconds) || seconds <= 0) {
        throw usageError("--timeout must be a positive number of seconds");
      }
      timeoutMs = Math.round(seconds * 1_000);
      wait = true;
      continue;
    }
    if (arg.startsWith("-")) throw usageError(`unknown flag: ${arg}`);
    target.push(arg);
  }

  if (afterSha && !wait) throw usageError("--after-sha requires --wait");
  if (target.length < 1 || target.length > 2) throw usageError();
  let parsed: ReturnType<typeof parseAdoptTarget>;
  try {
    parsed = parseAdoptTarget(target);
  } catch {
    throw usageError();
  }
  return { ...parsed, format, wait, afterSha, timeoutMs };
}

function printPretty(envelope: PrVortexReview): void {
  console.log(`Status:        ${envelope.status}`);
  if (envelope.verdict) console.log(`Verdict:       ${ansi.bold(envelope.verdict)}`);
  if (envelope.head_sha) console.log(`Head:          ${envelope.head_sha}`);
  console.log(`Finding count: ${envelope.finding_count}`);
  if (envelope.skip_reason) console.log(`Skip reason:   ${envelope.skip_reason}`);
  if (envelope.summary) console.log(envelope.summary);
  renderFindings(envelope.findings as ReviewFindings | null, {
    emptyMessage: envelope.status === "completed",
  });
}

export async function cmdPr(args: string[], opts: PrOptions = {}): Promise<void> {
  const parsed = parsePrArgs(args, {
    format: opts.defaultFormat ?? "json",
  });
  const cfg = await loadConfig();
  let envelope: PrVortexReview;
  if (parsed.wait) {
    try {
      envelope = await pollPrVortexReview(
        cfg,
        parsed.owner,
        parsed.repo,
        parsed.prNumber,
        {
          timeoutMs: parsed.timeoutMs,
          intervalMs: opts.pollIntervalMs,
          afterSha: parsed.afterSha,
          signal: opts.signal,
          ...opts.poll,
          onTick(kind) {
            if (parsed.format === "json") console.error(kind === "retry" ? "?" : ".");
            else process.stdout.write(kind === "retry" ? "?" : ".");
          },
        },
      );
    } catch (err) {
      if (err instanceof PrReviewPollTimeoutError) {
        throw new CommandError(err.message, REVIEW_EXIT.timeout, "review_timeout");
      }
      throw err;
    }
    if (parsed.format === "pretty") console.log("");
  } else {
    envelope = await getPrVortexReview(
      parsed.owner,
      parsed.repo,
      parsed.prNumber,
      cfg,
      { signal: opts.signal },
    );
  }

  if (parsed.format === "json") {
    console.log(JSON.stringify(envelope, null, opts.mode === "shell" ? 2 : undefined));
  } else {
    printPretty(envelope);
  }
}
