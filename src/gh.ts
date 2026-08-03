import { spawnSync } from "node:child_process";
import { CommandError } from "./errors.js";

export function runGh(
  args: string[],
  cwd = process.cwd(),
): { ok: true; stdout: string } | { ok: false; stderr: string; status: number | null } {
  const result = spawnSync("gh", args, { cwd, encoding: "utf8" });
  if (result.error) {
    const msg = result.error.message || String(result.error);
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, stderr: "gh not found", status: null };
    }
    return { ok: false, stderr: msg, status: result.status };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      stderr: (result.stderr || result.stdout || `gh ${args.join(" ")} failed`).trim(),
      status: result.status,
    };
  }
  return { ok: true, stdout: result.stdout ?? "" };
}

export function requireGh(cwd = process.cwd()): void {
  const check = runGh(["--version"], cwd);
  if (!check.ok) {
    throw new CommandError(
      "GitHub CLI (`gh`) is required for `stack submit`. Install https://cli.github.com and run `gh auth login`.",
    );
  }
  const auth = runGh(["auth", "status"], cwd);
  if (!auth.ok) {
    throw new CommandError(
      "`gh` is installed but not authenticated. Run `gh auth login`, then retry `stack submit`.",
    );
  }
}

/** Open PR number for `head` branch in owner/repo, or null. */
export function findOpenPrNumber(
  owner: string,
  repo: string,
  headBranch: string,
  cwd = process.cwd(),
): number | null {
  const res = runGh(
    [
      "pr",
      "list",
      "--repo",
      `${owner}/${repo}`,
      "--head",
      headBranch,
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      "1",
    ],
    cwd,
  );
  if (!res.ok) {
    throw new CommandError(`Failed to list PRs for ${headBranch}: ${res.stderr}`);
  }
  try {
    const rows = JSON.parse(res.stdout) as { number?: number }[];
    const n = rows[0]?.number;
    return typeof n === "number" && n > 0 ? n : null;
  } catch (e) {
    throw new CommandError(`Failed to parse PR list response: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function createPr(input: {
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body?: string;
  cwd?: string;
}): number {
  const cwd = input.cwd ?? process.cwd();
  const args = [
    "pr",
    "create",
    "--repo",
    `${input.owner}/${input.repo}`,
    "--base",
    input.base,
    "--head",
    input.head,
    "--title",
    input.title,
    "--body",
    input.body ?? "",
  ];
  const res = runGh(args, cwd);
  if (!res.ok) {
    throw new CommandError(
      `Failed to open PR ${input.head} → ${input.base}: ${res.stderr}`,
    );
  }
  // stdout is typically the PR URL
  const url = res.stdout.trim();
  const m = /\/pull\/(\d+)/.exec(url);
  if (m?.[1]) return Number(m[1]);
  // Fallback: re-list
  const n = findOpenPrNumber(input.owner, input.repo, input.head, cwd);
  if (n != null) return n;
  throw new CommandError(
    `Opened PR at ${url || "(unknown URL)"} but could not determine PR number. Check your repository's pull requests.`,
  );
}
