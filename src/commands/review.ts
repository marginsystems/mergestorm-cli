import { apiFetch, getMe } from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError, DetachedError, isCommandErrorCode } from "../errors.js";
import { collectChangedFiles, git, parseGithubOriginRepo } from "../git.js";
import { discoverTrunk } from "../git-stack.js";
import { ansi } from "../ui/ansi.js";
import { renderFindings, type ReviewFindings } from "../ui/findings.js";

/**
 * Diff base when the user omits args[0]. Prefers origin/HEAD / main / master
 * via discoverTrunk (same as stack create) instead of hardcoding "main".
 */
export function resolveReviewBase(explicit: string | undefined, cwd = process.cwd()): string {
  if (explicit) return explicit;
  try {
    return discoverTrunk(cwd);
  } catch {
    throw new CommandError(
      "Could not discover trunk branch. Pass an explicit base: mergestorm review <base> [head]",
    );
  }
}

export type ReviewOptions = {
  signal?: AbortSignal;
  /** When true, show Ctrl+C detach hint during poll. */
  interactive?: boolean;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Max consecutive transient poll failures before surfacing an error. */
export const REVIEW_POLL_MAX_TRANSIENT_RETRIES = 3;

export function reviewStatusHint(jobId: string): string {
  return `Check: mergestorm status ${jobId}`;
}

/** Append recovery hint once a job id exists (idempotent). */
export function withReviewJobRecovery(message: string, jobId: string): string {
  const hint = reviewStatusHint(jobId);
  if (message.includes(`mergestorm status ${jobId}`)) return message;
  return `${message.replace(/\s+$/, "")}\n${hint}`;
}

/** HTTP statuses worth retrying during review poll (not 401/402/404). */
export function isTransientReviewPollStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Network / request-timeout errors worth retrying during review poll. */
export function isTransientReviewPollError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  if (err instanceof CommandError) {
    return err.code === "api_timeout";
  }
  if (err instanceof TypeError && /fetch|network|connection/i.test(err.message)) return true;
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(
    err.message,
  );
}

function asPollCommandError(err: unknown, jobId: string): CommandError {
  if (err instanceof CommandError) {
    return new CommandError(
      withReviewJobRecovery(err.message, jobId),
      err.exitCode,
      err.code,
    );
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new CommandError(withReviewJobRecovery(`Poll failed: ${detail}`, jobId));
}

export async function cmdReview(args: string[], opts: ReviewOptions = {}): Promise<void> {
  const base = resolveReviewBase(args[0]);
  const head = args[1] || "HEAD";
  const cfg = await loadConfig();
  const meBefore = opts.interactive ? await getMe(cfg) : null;

  console.log(`Collecting diff ${base}...${head} …`);
  let diff: string;
  try {
    diff = git(["diff", `${base}...${head}`]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `Could not diff ${base}...${head}: ${detail}. Try \`mergestorm review <base>\` with your trunk branch.`,
    );
  }
  if (!diff.trim()) {
    console.log("No changes to review.");
    return;
  }
  const files = await collectChangedFiles(base, head);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "local";
  const thread = `local/${branch}`.replace(/[^a-zA-Z0-9._/-]/g, "-").slice(0, 120);
  const originRepo = parseGithubOriginRepo();

  console.log(
    `Submitting review (${Buffer.byteLength(diff, "utf8")} byte diff, ${files.length} file(s))…`,
  );

  const { status, body } = await apiFetch(cfg, "/api/v1/reviews", {
    method: "POST",
    json: {
      thread,
      branch,
      ...(originRepo ? { repo: `${originRepo.owner}/${originRepo.repo}` } : {}),
      base_label: base,
      head_label: head,
      diff,
      files,
    },
    signal: opts.signal,
  });

  if (status === 402) {
    throw new CommandError("Monthly review limit reached. Upgrade at https://mergestorm.ai/billing");
  }
  if (status !== 202 && status !== 200) {
    throw new CommandError(`Failed: ${JSON.stringify(body, null, 2)}`);
  }

  const job = body as { job_id: string; status: string };
  const waitHint = opts.interactive
    ? ` Waiting… (${ansi.dim("ctrl+c to detach — job keeps running")})`
    : " Waiting…";
  console.log(`Job ${job.job_id} (${job.status}).${waitHint}`);

  let transientFailures = 0;
  try {
    for (let i = 0; i < 90; i += 1) {
      await sleep(2000, opts.signal);
      let poll: { status: number; body: unknown };
      try {
        poll = await apiFetch(cfg, `/api/v1/reviews/${job.job_id}`, { signal: opts.signal });
      } catch (err) {
        if (opts.interactive && err instanceof Error && err.name === "AbortError") {
          throw err;
        }
        if (opts.interactive && isCommandErrorCode(err, "api_timeout")) {
          throw err;
        }
        if (
          isTransientReviewPollError(err) &&
          transientFailures < REVIEW_POLL_MAX_TRANSIENT_RETRIES
        ) {
          transientFailures += 1;
          if (opts.interactive) process.stdout.write("?");
          continue;
        }
        throw asPollCommandError(err, job.job_id);
      }

      if (poll.status !== 200) {
        if (
          isTransientReviewPollStatus(poll.status) &&
          transientFailures < REVIEW_POLL_MAX_TRANSIENT_RETRIES
        ) {
          transientFailures += 1;
          if (opts.interactive) process.stdout.write("?");
          continue;
        }
        throw new CommandError(
          withReviewJobRecovery(
            `Poll failed: ${JSON.stringify(poll.body, null, 2)}`,
            job.job_id,
          ),
        );
      }
      transientFailures = 0;

      const row = poll.body as {
        status: string;
        summary?: string;
        verdict?: string;
        findings?: ReviewFindings;
        error?: string;
      };
      if (row.status === "queued" || row.status === "in_progress") {
        process.stdout.write(".");
        continue;
      }
      console.log("");
      if (row.status === "failed" || row.status === "quota_exceeded") {
        throw new CommandError(
          withReviewJobRecovery(`Review ${row.status}: ${row.error ?? ""}`, job.job_id),
        );
      }
      console.log(`\nVerdict: ${ansi.bold(row.verdict ?? "comment")}`);
      console.log(row.summary ?? "");
      renderFindings(row.findings, { emptyMessage: true });
      if (opts.interactive && meBefore) {
        const meAfter = await getMe(cfg);
        if (meAfter) {
          const beforeLeft = meBefore.usage.standard.remaining ?? 0;
          const afterLeft = meAfter.usage.standard.remaining ?? 0;
          const used = Math.max(0, beforeLeft - afterLeft);
          if (used > 0) {
            console.log(
              ansi.dim(
                `\n${used} credit${used === 1 ? "" : "s"} used · ${afterLeft} remaining`,
              ),
            );
          }
        }
      }
      return;
    }
  } catch (err) {
    if (opts.interactive && err instanceof Error && err.name === "AbortError") {
      throw new DetachedError(job.job_id);
    }
    if (opts.interactive && isCommandErrorCode(err, "api_timeout")) {
      throw new DetachedError(job.job_id);
    }
    if (err instanceof CommandError) {
      throw new CommandError(
        withReviewJobRecovery(err.message, job.job_id),
        err.exitCode,
        err.code,
      );
    }
    throw err;
  }
  throw new CommandError(
    withReviewJobRecovery("Timed out waiting for review.", job.job_id),
  );
}
