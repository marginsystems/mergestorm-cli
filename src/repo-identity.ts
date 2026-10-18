import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { mergestormHome } from "./config.js";
import { CommandError } from "./errors.js";
import { git } from "./git.js";

/** Classify git "not a repo" failures once at the boundary; callers match on code. */
function rethrowIfNotARepo(err: unknown): never {
  const detail = err instanceof Error ? err.message : String(err);
  if (/not a git repository/i.test(detail)) {
    throw new CommandError(detail, 1, "not_a_repo");
  }
  throw err;
}

export function gitTopLevel(cwd = process.cwd()): string {
  try {
    return realpathSync(git(["rev-parse", "--show-toplevel"], cwd).trim());
  } catch (err) {
    rethrowIfNotARepo(err);
  }
}

/**
 * Each worktree has its own authoring state.
 * Independent clones remain isolated even when they point at the same remote.
 */
export function stableRepoId(cwd = process.cwd()): string {
  let raw: string;
  try {
    raw = git(["rev-parse", "--git-dir"], cwd).trim();
  } catch (err) {
    rethrowIfNotARepo(err);
  }
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  return createHash("sha256")
    .update(realpathSync(absolute))
    .digest("hex")
    .slice(0, 20);
}

export function cliStacksRoot(): string {
  return path.join(mergestormHome(), "stacks");
}

export function repoStateDir(
  cwd = process.cwd(),
  stacksRoot = cliStacksRoot(),
): string {
  return path.join(stacksRoot, stableRepoId(cwd));
}

export function stackMetaPath(
  cwd = process.cwd(),
  stacksRoot = cliStacksRoot(),
): string {
  return path.join(repoStateDir(cwd, stacksRoot), "stack.json");
}
