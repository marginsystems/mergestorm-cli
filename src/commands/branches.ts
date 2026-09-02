import { stdin as input, stdout as output } from "node:process";
import { listThreads, type ThreadListItem } from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { git } from "../git.js";
import { ansi } from "../ui/ansi.js";
import { present } from "../ui/present.js";
import { selectFromList } from "../ui/select.js";
import { buildChainHelpLines, cmdThread, relativeWhen } from "./jobs.js";
import { showLinePanel } from "../ui/line-tabs.js";

/** One-line label for a branch/thread row (also used by tests). */
export function formatBranchRow(item: ThreadListItem): string {
  const name = (item.branch?.trim() || item.slug).slice(0, 36);
  const jobs = `${item.job_count} job${item.job_count === 1 ? "" : "s"}`;
  const verdict = item.last_verdict ?? "-";
  const when = relativeWhen(item.last_activity_at);
  const pr =
    item.owner && item.repo && item.pr_number != null
      ? `  PR #${item.pr_number}`
      : "";
  const closed = item.status === "closed" ? "  closed" : "";
  return `${name.padEnd(36)}  ${jobs.padEnd(8)}  ${verdict.padEnd(12)}  ${when}${pr}${closed}`;
}

function formatBranchTableLines(items: ThreadListItem[]): string[] {
  const header = ["BRANCH / SLUG", "JOBS", "VERDICT", "WHEN", "PR"];
  const rows = items.map((t) => [
    (t.branch?.trim() || t.slug).slice(0, 36),
    String(t.job_count),
    t.last_verdict ?? "-",
    relativeWhen(t.last_activity_at),
    t.pr_number != null ? `#${t.pr_number}` : "-",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)),
  );
  const fmt = (cols: string[]) =>
    "  " + cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [
    ansi.dim(fmt(header)),
    ...rows.map((r) => fmt(r)),
    ansi.dim("  open a chain:  chain <slug>   ·   or re-run on a TTY to pick"),
  ];
}

/** Interactive list of recently reviewed branches → open chain on select. */
export async function cmdBranches(
  args: string[] = [],
  opts: { mode?: "oneshot" | "shell" } = {},
): Promise<void> {
  const asJson = args.includes("--json");
  const nArg = args.find((a) => /^\d+$/.test(a));
  const limit = nArg ? Number.parseInt(nArg, 10) : 20;
  const cfg = await loadConfig();
  const items = await listThreads(limit, cfg);

  if (asJson) {
    const text = JSON.stringify({ items }, null, 2);
    if (opts.mode === "shell") {
      await present("Branches", text.split("\n"));
      return;
    }
    console.log(text);
    return;
  }
  if (items.length === 0) {
    await present("Branches", [
      `  ${ansi.bold("No reviewed branches yet")}`,
      "",
      `  ${ansi.brightGreen("review")}  submit a diff on this branch`,
    ]);
    return;
  }

  if (!input.isTTY || !output.isTTY) {
    await present("Branches", formatBranchTableLines(items));
    return;
  }

  const picked = await selectFromList({
    title: "Recently reviewed branches",
    items,
    render: (item) => formatBranchRow(item),
  });
  if (!picked) {
    return;
  }
  await cmdThread(picked.slug, []);
}

/**
 * Show the review-chain timeline for a branch/thread.
 * Defaults to `local/<current-git-branch>` when no slug is given.
 */
export async function cmdChain(
  args: string[] = [],
  opts: { mode?: "oneshot" | "shell" } = {},
): Promise<void> {
  const asJson = args.includes("--json");
  const positional = args.filter((a) => a !== "--json");
  let slug = positional[0]?.trim() ?? "";

  if (!slug) {
    try {
      const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "local";
      slug = `local/${branch}`.replace(/[^a-zA-Z0-9._/-]/g, "-").slice(0, 120);
    } catch {
      if (asJson || !process.stdin.isTTY || !process.stdout.isTTY) {
        throw new CommandError(
          "usage: chain <slug>   (or run inside a git repo to use the current branch)",
        );
      }
      await showLinePanel("Chain", buildChainHelpLines({ reason: "no-repo" }));
      return;
    }
  }

  await cmdThread(slug, asJson ? ["--json"] : [], opts);
}
