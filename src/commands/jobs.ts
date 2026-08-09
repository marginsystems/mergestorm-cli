import { apiFetch, listJobs, type ThreadDetail } from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { ansi } from "../ui/ansi.js";

export function relativeWhen(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export async function cmdJobs(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const nArg = args.find((a) => /^\d+$/.test(a));
  const limit = nArg ? Number.parseInt(nArg, 10) : 10;
  const cfg = await loadConfig();
  const items = await listJobs(limit, cfg);

  if (asJson) {
    console.log(JSON.stringify({ items }, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log(ansi.dim("  No review jobs yet. Run `review` to submit one."));
    return;
  }

  const header = ["JOB", "STATUS", "VERDICT", "THREAD", "WHEN"];
  const rows = items.map((j) => [
    j.job_id.slice(0, 8),
    j.status,
    j.verdict ?? "-",
    (j.thread_slug ?? "-").slice(0, 20),
    relativeWhen(j.created_at),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)),
  );
  const fmt = (cols: string[]) =>
    "  " + cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(ansi.dim(fmt(header)));
  for (const r of rows) console.log(fmt(r));
  console.log(ansi.dim("  branches: `branches` · full history: https://mergestorm.ai/settings#api"));
}

/** Numbered chain timeline for a thread (branch/PR meta when present). */
export function formatThreadTimeline(data: ThreadDetail): string[] {
  const lines: string[] = [];
  const title = data.branch?.trim()
    ? `${data.branch}  (${data.slug})`
    : data.slug;
  lines.push(`  ${ansi.bold(title)} · ${data.job_count} job(s) · ${data.status}`);
  if (data.owner && data.repo) {
    const pr =
      data.pr_number != null
        ? `https://github.com/${data.owner}/${data.repo}/pull/${data.pr_number}`
        : `${data.owner}/${data.repo}`;
    lines.push(`  ${ansi.dim(pr)}`);
  }

  const jobs = [...(data.jobs ?? [])].sort((a, b) => {
    const an = a.thread_job_number ?? Infinity;
    const bn = b.thread_job_number ?? Infinity;
    if (an !== bn) return an - bn;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  if (jobs.length === 0) {
    lines.push(ansi.dim("  (no jobs in this chain yet)"));
    return lines;
  }

  for (const j of jobs) {
    const n = j.thread_job_number != null ? `#${j.thread_job_number}` : "#?";
    lines.push(
      `  ${n.padEnd(4)}  ${j.job_id.slice(0, 8)}  ${(j.status ?? "-").padEnd(12)}  ${(j.verdict ?? "-").padEnd(16)}  ${relativeWhen(j.created_at)}`,
    );
  }
  return lines;
}

export async function cmdThread(slug: string, args: string[] = []): Promise<void> {
  const asJson = args.includes("--json");
  const cfg = await loadConfig();
  const { status, body } = await apiFetch(cfg, `/api/v1/threads/${encodeURIComponent(slug)}`);
  if (status === 404) {
    throw new CommandError(`Thread not found: ${slug}`);
  }
  if (status !== 200) {
    throw new CommandError(`Failed to load thread (HTTP ${status}): ${JSON.stringify(body)}`);
  }
  if (asJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const data = body as ThreadDetail;
  for (const line of formatThreadTimeline({
    ...data,
    branch: data.branch ?? null,
    owner: data.owner ?? null,
    repo: data.repo ?? null,
    pr_number: data.pr_number ?? null,
    status: data.status ?? "active",
    pr_linked_at: data.pr_linked_at ?? null,
    jobs: data.jobs ?? [],
  })) {
    console.log(line);
  }
}
