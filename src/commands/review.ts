import { apiFetch, getMe } from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError, DetachedError } from "../errors.js";
import { collectChangedFiles, git } from "../git.js";
import { ansi } from "../ui/ansi.js";

export type ReviewOptions = {
  signal?: AbortSignal;
  /** When true, show Ctrl+C detach hint during poll. */
  interactive?: boolean;
};

/** Parse `origin` remote into GitHub owner/repo when possible. */
export function parseGithubOriginRepo(
  cwd = process.cwd(),
): { owner: string; repo: string } | null {
  try {
    const url = git(["remote", "get-url", "origin"], cwd).trim();
    if (!url) return null;
    const m = url.match(/^(?:https?:\/\/|git@)?github\.com[:/]([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
    if (!m?.[1] || !m[2]) return null;
    return { owner: m[1], repo: m[2] };
  } catch {
    return null;
  }
}

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

export async function cmdReview(args: string[], opts: ReviewOptions = {}): Promise<void> {
  const base = args[0] || "main";
  const head = args[1] || "HEAD";
  const cfg = await loadConfig();
  const meBefore = opts.interactive ? await getMe(cfg) : null;

  console.log(`Collecting diff ${base}...${head} …`);
  const diff = git(["diff", `${base}...${head}`]);
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

  try {
    for (let i = 0; i < 90; i += 1) {
      await sleep(2000, opts.signal);
      const poll = await apiFetch(cfg, `/api/v1/reviews/${job.job_id}`, { signal: opts.signal });
      if (poll.status !== 200) {
        throw new CommandError(`Poll failed: ${JSON.stringify(poll.body, null, 2)}`);
      }
      const row = poll.body as {
        status: string;
        summary?: string;
        verdict?: string;
        findings?: {
          inline?: { path: string; line: number; severity: string; body: string; title?: string }[];
          off_diff?: { path?: string; line?: number; severity: string; body: string }[];
          offDiff?: { path?: string; line?: number; severity: string; body: string }[];
        };
        error?: string;
      };
      if (row.status === "queued" || row.status === "in_progress") {
        process.stdout.write(".");
        continue;
      }
      console.log("");
      if (row.status === "failed" || row.status === "quota_exceeded") {
        throw new CommandError(`Review ${row.status}: ${row.error ?? ""}`);
      }
      console.log(`\nVerdict: ${ansi.bold(row.verdict ?? "comment")}`);
      console.log(row.summary ?? "");
      const inline = row.findings?.inline ?? [];
      const off = row.findings?.off_diff ?? row.findings?.offDiff ?? [];
      for (const c of inline) {
        console.log(`\n[${c.severity}] ${c.path}:${c.line}${c.title ? ` — ${c.title}` : ""}`);
        console.log(c.body);
      }
      for (const c of off) {
        console.log(`\n[${c.severity}] off-diff ${c.path ?? ""}`);
        console.log(c.body);
      }
      if (inline.length === 0 && off.length === 0) {
        console.log("\nNo findings.");
      }
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
    throw err;
  }
  throw new CommandError(`Timed out waiting for review. Check: mergestorm status ${job.job_id}`);
}
