import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  gitCommonDir,
  gitTopLevel,
  stableRepoId,
  stackMetaPath,
} from "./repo-identity.js";

async function committedRepo(prefix: string): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  return { root, repo };
}

test("repo identity resolves from nested directories", async () => {
  const f = await committedRepo("mg-repo-id-nested-");
  try {
    const nested = path.join(f.repo, "a", "b");
    await mkdir(nested, { recursive: true });
    assert.equal(gitTopLevel(nested), f.repo);
    assert.equal(stableRepoId(nested), stableRepoId(f.repo));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("linked worktrees share one identity and stack state path", async () => {
  const f = await committedRepo("mg-repo-id-worktree-");
  try {
    const worktree = path.join(f.root, "linked");
    execFileSync("git", ["worktree", "add", "-qb", "feature", worktree], {
      cwd: f.repo,
    });
    const stateRoot = path.join(f.root, "state");
    assert.equal(gitCommonDir(worktree), gitCommonDir(f.repo));
    assert.equal(stableRepoId(worktree), stableRepoId(f.repo));
    assert.equal(
      stackMetaPath(worktree, stateRoot),
      stackMetaPath(f.repo, stateRoot),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("independent clones do not collide", async () => {
  const one = await committedRepo("mg-repo-id-clone-a-");
  const two = await committedRepo("mg-repo-id-clone-b-");
  try {
    assert.notEqual(stableRepoId(one.repo), stableRepoId(two.repo));
  } finally {
    await rm(one.root, { recursive: true, force: true });
    await rm(two.root, { recursive: true, force: true });
  }
});
