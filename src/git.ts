import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export function git(args: string[], cwd = process.cwd()): string {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `git ${args.join(" ")} failed`);
    }
    return result.stdout;
  } catch (err) {
    throw new Error(`git ${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Parse `origin` remote into GitHub owner/repo when possible. */
export function parseGithubOriginRepo(
  cwd = process.cwd(),
): { owner: string; repo: string } | null {
  try {
    const url = git(["remote", "get-url", "origin"], cwd).trim();
    if (!url) return null;
    const m = url.match(
      /^(?:https?:\/\/|git@)?github\.com[:/]([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
    );
    if (!m?.[1] || !m[2]) return null;
    return { owner: m[1], repo: m[2] };
  } catch {
    return null;
  }
}

/**
 * Repo-root absolute path for the current working tree.
 * Kept local (not imported from repo-identity) to avoid a git ↔ repo-identity cycle.
 */
function repoRoot(cwd = process.cwd()): string {
  return realpathSync(git(["rev-parse", "--show-toplevel"], cwd).trim());
}

export async function collectChangedFiles(
  base: string,
  head: string,
  cwd = process.cwd(),
): Promise<{ path: string; content: string }[]> {
  const root = repoRoot(cwd);
  const names = git(["diff", "--name-only", "--diff-filter=ACMR", `${base}...${head}`], cwd)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const files: { path: string; content: string }[] = [];
  for (const name of names.slice(0, 40)) {
    const abs = path.join(root, name);
    try {
      const st = await stat(abs);
      if (!st.isFile() || st.size > 400_000) continue;
      const content = await readFile(abs, "utf8");
      files.push({ path: name, content });
    } catch {
      // deleted or unreadable — do not silently drop without a hint
      console.warn(
        `Warning: could not read ${name} for review upload (resolved from repo root); skipping file contents`,
      );
    }
  }
  return files;
}
