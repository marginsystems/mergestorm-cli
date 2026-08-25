import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
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
export function repoRoot(cwd = process.cwd()): string {
  return realpathSync(git(["rev-parse", "--show-toplevel"], cwd).trim());
}

/**
 * Repo-root-relative names of files changed between base and head that resolve
 * inside the sandbox root. Bounds both the uploaded file contents and the diff
 * itself to the sandbox so tracked files outside it never reach the API.
 */
export async function changedNamesInSandbox(
  base: string,
  head: string,
  cwd = process.cwd(),
  sandboxRoot?: string,
): Promise<string[]> {
  const root = repoRoot(cwd);
  const bound = sandboxRoot ? await realpath(path.resolve(sandboxRoot)) : root;
  // D/T are included so deletions and type changes stay in the review diff,
  // even though their contents cannot be read from the working tree for upload.
  // -z disables core.quotePath quoting and NUL-terminates names, so paths with
  // spaces or non-ASCII characters survive the split verbatim.
  const names = git(
    ["diff", "--name-only", "-z", "--diff-filter=ACMRDT", `${base}...${head}`],
    cwd,
  )
    .split("\0")
    .filter(Boolean);
  const kept: string[] = [];
  for (const name of names) {
    const abs = path.join(root, name);
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      // Deleted from the working tree: resolve the nearest existing ancestor so
      // the path can still be bounded against the sandbox for the diff pathspec.
      let ancestor = path.dirname(abs);
      let realAncestor: string | undefined;
      while (!realAncestor) {
        try {
          realAncestor = await realpath(ancestor);
        } catch {
          const up = path.dirname(ancestor);
          if (up === ancestor) throw new Error(`cannot resolve ${abs}`);
          ancestor = up;
        }
      }
      real = path.join(realAncestor, path.relative(ancestor, abs));
    }
    const relToBound = path.relative(bound, real);
    if (relToBound === ".." || relToBound.startsWith(`..${path.sep}`)) {
      console.warn(
        `Warning: skipping ${name} for review upload: it resolves outside the ${
          sandboxRoot ? "sandbox root" : "repo root"
        }`,
      );
      continue;
    }
    kept.push(name);
  }
  return kept;
}

export async function collectChangedFiles(
  base: string,
  head: string,
  cwd = process.cwd(),
  sandboxRoot?: string,
): Promise<{ path: string; content: string }[]> {
  const root = repoRoot(cwd);
  const names = await changedNamesInSandbox(base, head, cwd, sandboxRoot);
  const files: { path: string; content: string }[] = [];
  for (const name of names.slice(0, 40)) {
    const abs = path.join(root, name);
    try {
      const st = await stat(abs);
      if (!st.isFile() || st.size > 400_000) continue;
      const content = await readFile(abs, "utf8");
      files.push({ path: name, content });
    } catch {
      console.warn(
        `Warning: could not read ${name} for review upload (resolved from repo root); skipping file contents`,
      );
    }
  }
  return files;
}
