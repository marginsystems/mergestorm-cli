import { getMe } from "../api.js";
import { loadConfig } from "../config.js";
import {
  CommandError,
  DetachedError,
  REVIEW_EXIT,
  isCommandErrorCode,
  rateLimitedMessage,
} from "../errors.js";
import { discoverTrunk } from "../git-stack.js";
import { ansi } from "../ui/ansi.js";
import { formatFindingsLines, type ReviewFindings } from "../ui/findings.js";
import { present } from "../ui/present.js";
import {
  toReviewJobEnvelope,
  type ReviewEnvelopeFallbacks,
  type ReviewJobRow,
} from "../ui/job-envelope.js";
import {
  MAX_IDEMPOTENCY_KEY_CHARS,
  REVIEW_POLL_DEFAULT_TIMEOUT_MS,
  REVIEW_POLL_MAX_TRANSIENT_RETRIES,
  REVIEW_THREAD_SLUG_RE,
  ReviewPollTimeoutError,
  collectReviewInput,
  isTransientReviewPollError,
  isTransientReviewPollStatus,
  loadReviewContext,
  pollReview,
  submitReview,
} from "./review-client.js";

export {
  REVIEW_POLL_MAX_TRANSIENT_RETRIES,
  isTransientReviewPollError,
  isTransientReviewPollStatus,
};

/** Same public specialist allowlist as the API contract and migration 117. */
export const VORTEX_ROUTER_MODES = ["off", "standard", "max", "manual"] as const;
/** Standard/Max fleet caps; Manual is capped at Max. */
export const VORTEX_ROUTER_CAPS = { standard: 3, max: 5 } as const;
/**
 * Pinnable L0 lanes only. Keep this list byte-identical to
 * `pinnableVortexSpecialistIds(VORTEX_SPECIALIST_IDS)` in review-findings
 * (`cli-lockstep.test.ts`). Do not add `governance` (round-gated) or `seam`
 * (phase-gated). Those L1 lanes are not local pins.
 */
export const VORTEX_SPECIALIST_IDS = [
  "security",
  "performance",
  "architecture",
  "tests",
  "data",
  "api",
  "frontend",
] as const;
type VortexRouterMode = (typeof VORTEX_ROUTER_MODES)[number];
type VortexSpecialistId = (typeof VORTEX_SPECIALIST_IDS)[number];

function isVortexRouterMode(value: unknown): value is VortexRouterMode {
  return typeof value === "string" && (VORTEX_ROUTER_MODES as readonly string[]).includes(value);
}

function isVortexSpecialistId(value: unknown): value is VortexSpecialistId {
  return typeof value === "string" && (VORTEX_SPECIALIST_IDS as readonly string[]).includes(value);
}

function normalizeVortexSpecialistIds(value: unknown): VortexSpecialistId[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set(
    value.filter((id): id is VortexSpecialistId =>
      typeof id === "string" && (VORTEX_SPECIALIST_IDS as readonly string[]).includes(id),
    ),
  );
  return VORTEX_SPECIALIST_IDS.filter((id) => selected.has(id));
}

/**
 * Diff base when the user omits args[0]. Prefers origin/HEAD / main / master
 * via discoverTrunk (same as stack create) instead of hardcoding "main".
 */
export type ParsedReviewArgs = {
  base?: string;
  head?: string;
  router?: VortexRouterMode;
  specialists: VortexSpecialistId[];
  format: "pretty" | "json";
  wait: boolean;
  timeoutMs: number;
  context?: string;
  contextFiles: string[];
  idempotencyKey?: string;
  webhookUrl?: string;
  thread?: string;
};

const REVIEW_USAGE =
  "usage: mergestorm review [base] [head] [--json] [--wait|--no-wait] [--timeout seconds] [--router off|standard|max|manual] [--specialists id,id] [--context text] [--context-file path] [--idempotency-key k] [--webhook-url https://…] [--thread slug]";

function usageError(message = REVIEW_USAGE): CommandError {
  return new CommandError(message, REVIEW_EXIT.usage, "usage");
}

function takeFlagValue(
  args: string[],
  i: number,
  name: string,
): { value: string; i: number } {
  const a = args[i]!;
  const prefix = `--${name}=`;
  const value = a === `--${name}` ? args[i + 1] : a.slice(prefix.length);
  if (value === undefined || (a === `--${name}` && value.startsWith("--"))) {
    throw usageError(`--${name} requires a value`);
  }
  return { value, i: a === `--${name}` ? i + 1 : i };
}

/** Parse the human and machine-safe `review` flags. */
export function parseReviewArgs(args: string[]): ParsedReviewArgs {
  const positional: string[] = [];
  let router: VortexRouterMode | undefined;
  let specialists: VortexSpecialistId[] = [];
  let format: "pretty" | "json" = "pretty";
  let wait = true;
  let waitFlag: "--wait" | "--no-wait" | null = null;
  let timeoutMs = REVIEW_POLL_DEFAULT_TIMEOUT_MS;
  let context: string | undefined;
  const contextFiles: string[] = [];
  let idempotencyKey: string | undefined;
  let webhookUrl: string | undefined;
  let thread: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--json") {
      format = "json";
      continue;
    }
    if (a === "--wait" || a === "--no-wait") {
      if (waitFlag && waitFlag !== a) throw usageError("--wait and --no-wait cannot be combined");
      waitFlag = a;
      wait = a === "--wait";
      continue;
    }
    if (a === "--timeout" || a.startsWith("--timeout=")) {
      const value = a === "--timeout" ? args[++i] : a.slice("--timeout=".length);
      const seconds = Number(value);
      if (!value || !Number.isFinite(seconds) || seconds <= 0) {
        throw usageError("--timeout must be a positive number of seconds");
      }
      timeoutMs = Math.round(seconds * 1_000);
      continue;
    }
    if (a === "--router" || a.startsWith("--router=")) {
      const value = a === "--router" ? args[++i] : a.slice("--router=".length);
      if (!isVortexRouterMode(value)) {
        throw usageError();
      }
      router = value;
      continue;
    }
    if (a === "--specialists" || a.startsWith("--specialists=")) {
      const value = a === "--specialists" ? args[++i] : a.slice("--specialists=".length);
      if (!value?.trim()) {
        throw usageError();
      }
      const raw = value.split(",").map((s) => s.trim()).filter(Boolean);
      if (raw.length === 0) throw usageError();
      const unknown = raw.filter((id) => !isVortexSpecialistId(id));
      if (unknown.length > 0) {
        throw usageError(`Unknown specialist: ${[...new Set(unknown)].join(", ")}`);
      }
      specialists = normalizeVortexSpecialistIds(raw);
      continue;
    }
    if (a === "--context-file" || a.startsWith("--context-file=")) {
      const taken = takeFlagValue(args, i, "context-file");
      i = taken.i;
      if (!taken.value.trim()) throw usageError("--context-file requires a path");
      contextFiles.push(taken.value);
      continue;
    }
    if (a === "--context" || a.startsWith("--context=")) {
      const taken = takeFlagValue(args, i, "context");
      i = taken.i;
      context = taken.value;
      continue;
    }
    if (a === "--idempotency-key" || a.startsWith("--idempotency-key=")) {
      const taken = takeFlagValue(args, i, "idempotency-key");
      i = taken.i;
      const key = taken.value.trim();
      if (!key) throw usageError("--idempotency-key requires a value");
      if (key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
        throw usageError(`--idempotency-key is ${key.length} chars; max is ${MAX_IDEMPOTENCY_KEY_CHARS}`);
      }
      idempotencyKey = key;
      continue;
    }
    if (a === "--webhook-url" || a.startsWith("--webhook-url=")) {
      const taken = takeFlagValue(args, i, "webhook-url");
      i = taken.i;
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(taken.value);
      } catch {
        throw usageError("--webhook-url must be an https URL");
      }
      if (parsedUrl.protocol !== "https:") {
        throw usageError("--webhook-url must be an https URL");
      }
      webhookUrl = parsedUrl.toString();
      continue;
    }
    if (a === "--thread" || a.startsWith("--thread=")) {
      const taken = takeFlagValue(args, i, "thread");
      i = taken.i;
      const slug = taken.value.trim();
      if (!REVIEW_THREAD_SLUG_RE.test(slug)) {
        throw usageError("--thread must be 1–120 chars [A-Za-z0-9._/-]");
      }
      thread = slug;
      continue;
    }
    if (a.startsWith("-")) {
      throw usageError(`unknown flag: ${a}`);
    }
    positional.push(a);
  }
  if (positional.length > 2) throw usageError();
  if (specialists.length > 0 && router == null) router = "manual";
  if (router === "manual" && specialists.length === 0) {
    throw usageError(
      "usage: mergestorm review [base] [head] --router manual --specialists id,id",
    );
  }
  if (router === "manual" && specialists.length > VORTEX_ROUTER_CAPS.max) {
    throw usageError(
      "usage: mergestorm review [base] [head] --router manual --specialists id,id (manual runs at most 5 specialists)",
    );
  }
  if (router === "off" && specialists.length > 0) {
    throw usageError("--router off cannot be combined with --specialists");
  }
  return {
    base: positional[0],
    head: positional[1],
    router,
    specialists,
    format,
    wait,
    timeoutMs,
    context,
    contextFiles,
    idempotencyKey,
    webhookUrl,
    thread,
  };
}

export function resolveReviewBase(explicit: string | undefined, cwd = process.cwd()): string {
  if (explicit) return explicit;
  try {
    return discoverTrunk(cwd);
  } catch {
    throw new CommandError(
      "Could not discover trunk branch. Pass an explicit base: mergestorm review <base> [head]",
      REVIEW_EXIT.usage,
      "usage",
    );
  }
}

export type ReviewOptions = {
  signal?: AbortSignal;
  /** When true, show Ctrl+C detach hint during poll. */
  interactive?: boolean;
  /** Test seam; production uses the two-second poll interval. */
  pollIntervalMs?: number;
};

export function reviewStatusHint(jobId: string): string {
  return `Check: mergestorm status ${jobId}`;
}

/** Append recovery hint once a job id exists (idempotent). */
export function withReviewJobRecovery(message: string, jobId: string): string {
  const hint = reviewStatusHint(jobId);
  if (message.includes(`mergestorm status ${jobId}`)) return message;
  return `${message.replace(/\s+$/, "")}\n${hint}`;
}

function asPollCommandError(err: unknown, jobId: string): CommandError {
  if (err instanceof CommandError) {
    return new CommandError(
      withReviewJobRecovery(err.message, jobId),
      err.exitCode,
      err.code,
      err.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: err.retryAfterSeconds }
        : undefined,
    );
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new CommandError(withReviewJobRecovery(`Poll failed: ${detail}`, jobId));
}

export async function cmdReview(args: string[], opts: ReviewOptions = {}): Promise<void> {
  const parsed = parseReviewArgs(args);
  const base = resolveReviewBase(parsed.base);
  const head = parsed.head || "HEAD";
  const json = parsed.format === "json";
  const interactive = Boolean(opts.interactive && !json);
  const fallback: ReviewEnvelopeFallbacks = {
    baseLabel: base,
    headLabel: head,
    routerMode: parsed.router ?? null,
    specialistsRequested: parsed.specialists,
  };
  let jsonPrinted = false;
  let webhookSecret: string | null = null;
  const printJson = (row: ReviewJobRow | null, extra: ReviewEnvelopeFallbacks = {}) => {
    const rowWithSecret = {
      ...(row ?? {}),
      ...(webhookSecret ? { webhook_secret: webhookSecret } : {}),
    };
    console.log(JSON.stringify(toReviewJobEnvelope(rowWithSecret, { ...fallback, ...extra })));
    jsonPrinted = true;
  };
  const progress = (message: string) => {
    if (json) console.error(message);
    else console.log(message);
  };

  try {
    const cfg = await loadConfig();
    const meBefore = interactive ? await getMe(cfg) : null;
    progress(`Collecting diff ${base}...${head} …`);
    const input = await collectReviewInput(base, head);
    if (!input) {
      if (json) printJson(null, { status: "no_changes" });
      else console.log("No changes to review.");
      return;
    }
    if (parsed.thread) input.thread = parsed.thread;
    fallback.threadSlug = input.thread;
    const extras = await loadReviewContext({
      context: parsed.context,
      contextFiles: parsed.contextFiles,
    });

    progress(
      `Submitting review (${Buffer.byteLength(input.diff, "utf8")} byte diff, ${input.files.length} file(s))…`,
    );
    if (parsed.router) {
      progress(
        `Fleet router=${parsed.router}${parsed.specialists.length ? ` specialists=${parsed.specialists.join(",")}` : ""}`,
      );
    }

    let submitted: { status: number; row: ReviewJobRow; retryAfterSeconds?: number };
    try {
      submitted = await submitReview(cfg, input, {
        routerMode: parsed.router,
        specialists: parsed.specialists,
        context: extras.context,
        contextFiles: extras.contextFiles,
        idempotencyKey: parsed.idempotencyKey,
        webhookUrl: parsed.webhookUrl,
        signal: opts.signal,
      });
    } catch (err) {
      if (!isTransientReviewPollError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (json) printJson(null, { status: "in_progress", error: message });
      throw new CommandError(message, REVIEW_EXIT.timeout, "review_timeout");
    }
    const jobId = submitted.row.job_id ?? submitted.row.id ?? null;
    fallback.jobId = jobId;
    webhookSecret = submitted.row.webhook_secret ?? null;

    if (submitted.status === 402) {
      const message =
        "Review limit reached for this period. Upgrade at https://mergestorm.ai/billing";
      if (json) printJson(submitted.row, { status: "quota_exceeded", error: message });
      throw new CommandError(message, REVIEW_EXIT.quota, "review_quota");
    }
    if (submitted.status === 429) {
      const retryAfterSeconds = submitted.retryAfterSeconds;
      const message = rateLimitedMessage(retryAfterSeconds);
      if (json) {
        printJson(submitted.row, {
          status: "rate_limited",
          error: message,
          retryAfterSeconds,
        });
      }
      throw new CommandError(message, REVIEW_EXIT.rate_limited, "rate_limited", {
        retryAfterSeconds,
      });
    }
    if (submitted.status !== 202 && submitted.status !== 200) {
      const message = `Failed: ${JSON.stringify(submitted.row, null, 2)}`;
      if (json) printJson(submitted.row, { status: "failed", error: message });
      throw new CommandError(message, REVIEW_EXIT.failed, "review_failed");
    }
    if (!jobId) {
      const message = "Review API returned no job_id";
      if (json) printJson(submitted.row, { status: "failed", error: message });
      throw new CommandError(message, REVIEW_EXIT.failed, "review_failed");
    }

    if (!parsed.wait) {
      if (json) printJson(submitted.row, { jobId });
      else console.log(`Job ${jobId} (${submitted.row.status ?? "queued"}).`);
      return;
    }

    if (!json) {
      const waitHint = interactive
        ? ` Waiting… (${ansi.dim("ctrl+c to detach — job keeps running")})`
        : " Waiting…";
      console.log(`Job ${jobId} (${submitted.row.status ?? "queued"}).${waitHint}`);
    }

    let row: ReviewJobRow;
    try {
      row = await pollReview(cfg, jobId, {
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
        throw new DetachedError(jobId);
      }
      if (interactive && isCommandErrorCode(err, "api_timeout")) {
        throw new DetachedError(jobId);
      }
      if (err instanceof ReviewPollTimeoutError) {
        const message = withReviewJobRecovery("Timed out waiting for review.", jobId);
        if (json) {
          printJson(err.lastRow, {
            jobId,
            status: err.lastRow.status ?? "in_progress",
            error: "Timed out waiting for review.",
          });
        }
        throw new CommandError(message, REVIEW_EXIT.timeout, "review_timeout");
      }
      if (isCommandErrorCode(err, "rate_limited")) {
        if (json) {
          printJson(null, {
            status: "rate_limited",
            error: err.message,
            retryAfterSeconds: err.retryAfterSeconds,
          });
        }
        throw asPollCommandError(err, jobId);
      }
      throw asPollCommandError(err, jobId);
    }

    if (!json) console.log("");
    if (row.status === "failed" || row.status === "quota_exceeded") {
      const message = withReviewJobRecovery(
        `Review ${row.status}: ${row.error ?? ""}`,
        jobId,
      );
      if (json) printJson(row, { jobId });
      throw new CommandError(
        message,
        row.status === "quota_exceeded" ? REVIEW_EXIT.quota : REVIEW_EXIT.failed,
        row.status === "quota_exceeded" ? "review_quota" : "review_failed",
      );
    }

    if (json) {
      printJson(row, { jobId });
      return;
    }

    const ran = row.specialists_run ?? row.findings?.specialists_run ?? [];
    const result: string[] = [
      `Verdict: ${ansi.bold(row.verdict ?? "comment")}`,
    ];
    if (ran.length > 0) result.push(ansi.dim(`Specialists: ${ran.join(", ")}`));
    if (row.summary) result.push(row.summary);
    result.push(
      ...formatFindingsLines(row.findings as ReviewFindings | null | undefined, {
        emptyMessage: true,
      }),
    );
    if (interactive && meBefore) {
      const meAfter = await getMe(cfg);
      if (meAfter) {
        const beforeLeft = meBefore.usage.standard.remaining ?? 0;
        const afterLeft = meAfter.usage.standard.remaining ?? 0;
        const used = Math.max(0, beforeLeft - afterLeft);
        if (used > 0) {
          result.push(
            ansi.dim(
              `${used} credit${used === 1 ? "" : "s"} used · ${afterLeft} remaining`,
            ),
          );
        }
      }
    }
    await present("Review", result);
  } catch (err) {
    if (err instanceof DetachedError) throw err;
    if (
      json &&
      !jsonPrinted &&
      !(err instanceof Error && err.name === "AbortError")
    ) {
      const message = err instanceof Error ? err.message : String(err);
      printJson(null, { status: "failed", error: message });
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
