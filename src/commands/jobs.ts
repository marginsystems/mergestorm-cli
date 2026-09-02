import { apiFetch, listJobs, type ThreadDetail } from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { ansi } from "../ui/ansi.js";
import { present } from "../ui/present.js";
import { showLinePanel } from "../ui/line-tabs.js";

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

export async function cmdJobs(
  args: string[],
  opts: { mode?: "oneshot" | "shell" } = {},
): Promise<void> {
  const asJson = args.includes("--json");
  const nArg = args.find((a) => /^\d+$/.test(a));
  const limit = nArg ? Number.parseInt(nArg, 10) : 10;
  const cfg = await loadConfig();
  const items = await listJobs(limit, cfg);

  if (asJson) {
    const text = JSON.stringify({ items }, null, 2);
    if (opts.mode === "shell") {
      await present("Jobs", text.split("\n"));
      return;
    }
    console.log(text);
    return;
  }
  if (items.length === 0) {
    await present("Jobs", [
      `  ${ansi.bold("No review jobs yet")}`,
      "",
      `  ${ansi.brightGreen("review")}  submit a diff`,
      `  ${ansi.brightGreen("usage")}   Status / Usage / Jobs tabs`,
    ]);
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
  await present("Jobs", [
    ansi.dim(fmt(header)),
    ...rows.map((r) => fmt(r)),
    ansi.dim("  branches: `branches` · full history: https://mergestorm.ai/settings#api"),
  ]);
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
    lines.push("");
    lines.push(...buildChainHelpLines({ slug: data.slug, reason: "empty" }));
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

const chainCmd = (name: string, blurb: string): string =>
  `  ${ansi.brightGreen(name.padEnd(22))}${blurb}`;

/** Empty / missing chain — shown in the TTY panel instead of a wiped error. */
export function buildChainHelpLines(opts: {
  slug?: string;
  reason: "missing" | "empty" | "no-repo";
}): string[] {
  const title =
    opts.reason === "empty"
      ? "No reviews on this chain yet"
      : opts.reason === "no-repo"
        ? "No git repo here"
        : "No chain for this branch";
  const lines = [`  ${ansi.bold(title)}`];
  if (opts.slug) lines.push(ansi.dim(`  Looked for  ${opts.slug}`));
  lines.push("");
  lines.push(`  ${ansi.bold("What this is")}`);
  lines.push("  A chain is the review timeline for one branch.");
  lines.push("");
  lines.push(`  ${ansi.bold("Do this")}`);
  if (opts.reason === "no-repo") {
    lines.push(chainCmd("cd <repo>", "then run chain again"));
    lines.push(chainCmd("chain <slug>", "open a known thread"));
  } else {
    lines.push(chainCmd("review", "submit a diff on this branch"));
    lines.push(chainCmd("branches", "pick a branch that already has reviews"));
    lines.push(chainCmd("chain <slug>", "open a known thread slug"));
  }
  return lines;
}

export async function cmdThread(
  slug: string,
  args: string[] = [],
  opts: { mode?: "oneshot" | "shell" } = {},
): Promise<void> {
  const asJson = args.includes("--json");
  const cfg = await loadConfig();
  const { status, body } = await apiFetch(cfg, `/api/v1/threads/${encodeURIComponent(slug)}`);
  if (status === 404) {
    if (asJson || !process.stdin.isTTY || !process.stdout.isTTY) {
      throw new CommandError(`Thread not found: ${slug}`);
    }
    await showLinePanel("Chain", buildChainHelpLines({ slug, reason: "missing" }));
    return;
  }
  if (status !== 200) {
    throw new CommandError(`Failed to load thread (HTTP ${status}): ${JSON.stringify(body)}`);
  }
  if (asJson) {
    const text = JSON.stringify(body, null, 2);
    if (opts.mode === "shell") {
      await present("Thread", text.split("\n"));
      return;
    }
    console.log(text);
    return;
  }
  const data = body as ThreadDetail;
  const lines = formatThreadTimeline({
    ...data,
    branch: data.branch ?? null,
    owner: data.owner ?? null,
    repo: data.repo ?? null,
    pr_number: data.pr_number ?? null,
    status: data.status ?? "active",
    pr_linked_at: data.pr_linked_at ?? null,
    jobs: data.jobs ?? [],
  });
  await showLinePanel("Chain", lines);
}
