import { git } from "./git.js";

/** Current branch name, or null when detached. */
export function currentBranch(cwd = process.cwd()): string | null {
  try {
    const name = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
    if (!name || name === "HEAD") return null;
    return name;
  } catch {
    return null;
  }
}

/**
 * True when the worktree has staged/unstaged/untracked changes that should
 * block `stack create`. Stack authoring metadata lives outside the worktree.
 * Legacy repo-local `.mergestorm/stack.json` is ignored because `loadStackMeta`
 * migrates it out of the worktree during `stack create`; counting it as dirty
 * would block that migration and every subsequent create.
 */
export function worktreeDirty(cwd = process.cwd()): boolean {
  const out = git(["status", "--porcelain"], cwd);
  for (const line of out.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    // porcelain: XY PATH or XY ORIG -> PATH (renames only)
    const status = trimmed.slice(0, 2);
    const pathPart = (status.includes("R") || status.includes("C"))
      ? trimmed.slice(3).split(" -> ").pop()?.trim() ?? ""
      : trimmed.slice(3).trim();
    if (
      pathPart.startsWith(".mergestorm/") ||
      pathPart.endsWith("/.mergestorm/") ||
      pathPart.endsWith("/.mergestorm/stack.json")
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Resolve trunk branch: --trunk flag, then origin/HEAD, then main/master if present.
 */
export function discoverTrunk(cwd = process.cwd()): string {
  try {
    const sym = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd).trim();
    // origin/main → main
    const m = /^origin\/(.+)$/.exec(sym);
    if (m?.[1]) return m[1];
  } catch {
    // no origin/HEAD
  }
  for (const candidate of ["main", "master"]) {
    try {
      git(["rev-parse", "--verify", candidate], cwd);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    "Could not discover trunk branch. Pass --trunk <name> or set origin/HEAD.",
  );
}

export function branchExists(name: string, cwd = process.cwd()): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], cwd);
    return true;
  } catch {
    return false;
  }
}

export function deleteBranch(name: string, cwd = process.cwd()): void {
  git(["branch", "-D", name], cwd);
}

export function createBranchFromHead(name: string, cwd = process.cwd()): void {
  git(["checkout", "-b", name], cwd);
}

/** Slugify a free-form name into a safe branch segment. */
export function slugifyBranchName(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "");
  return s || `layer-${Date.now().toString(36)}`;
}

export function defaultLayerBranchName(explicit?: string): string {
  if (explicit?.trim()) {
    const s = slugifyBranchName(explicit);
    return s.includes("/") ? s : `ms/${s}`;
  }
  return `ms/${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36).slice(-4)}`;
}

/**
 * How many commits are on `head` that are not reachable from `base`
 * (`git rev-list --count base..head`). Used by stack submit to refuse empty layers.
 */
export function commitsAheadOf(base: string, head: string, cwd = process.cwd()): number {
  const out = git(["rev-list", "--count", `${base}..${head}`], cwd).trim();
  const n = Number.parseInt(out, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Could not count commits on ${head} ahead of ${base}`);
  }
  return n;
}

/** Push branch to origin and set upstream. */
export function pushBranch(branch: string, cwd = process.cwd()): void {
  try {
    git(["push", "-u", "origin", branch], cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `git push failed for ${branch}. Check remote auth (SSH key or credential helper).\n${msg}`,
    );
  }
}

/** First line of the tip commit on `branch` (for PR title). */
export function tipCommitSubject(branch: string, cwd = process.cwd()): string {
  try {
    const s = git(["log", "-1", "--format=%s", branch], cwd).trim();
    if (s) return s;
    console.warn(`Warning: no commit message on ${branch}; using branch name as PR title`);
    return branch;
  } catch {
    console.warn(`Warning: could not read commit message on ${branch}; using branch name as PR title`);
    return branch;
  }
}

/** Full tip commit message on `branch` (subject + body; for PR description). */
export function tipCommitMessage(branch: string, cwd = process.cwd()): string {
  try {
    const s = git(["log", "-1", "--format=%B", branch], cwd);
    if (s.trim()) return s;
    return tipCommitSubject(branch, cwd);
  } catch {
    return tipCommitSubject(branch, cwd);
  }
}
