import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commitsAheadOf } from "./git-stack.js";

async function repoWithMain(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mg-commits-ahead-"));
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

test("commitsAheadOf is 0 for a freshly created empty layer", async () => {
  const f = await repoWithMain();
  try {
    execFileSync("git", ["checkout", "-qb", "ms/empty"], { cwd: f.repo });
    assert.equal(commitsAheadOf("main", "ms/empty", f.repo), 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("commitsAheadOf counts commits unique to head", async () => {
  const f = await repoWithMain();
  try {
    execFileSync("git", ["checkout", "-qb", "ms/work"], { cwd: f.repo });
    await writeFile(path.join(f.repo, "a.ts"), "export {};\n");
    execFileSync("git", ["add", "a.ts"], { cwd: f.repo });
    execFileSync("git", ["commit", "-qm", "work"], { cwd: f.repo });
    assert.equal(commitsAheadOf("main", "ms/work", f.repo), 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
