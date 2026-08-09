import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectChangedFiles, parseGithubOriginRepo } from "./git.js";

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

test("collectChangedFiles reads contents when cwd is a subdirectory", async () => {
  const f = await committedRepo("mg-git-subdir-");
  try {
    const nested = path.join(f.repo, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(f.repo, "packages", "app", "index.ts"), "export const n = 1;\n");
    await writeFile(path.join(f.repo, "top-level.ts"), "export const t = 2;\n");
    execFileSync("git", ["add", "packages/app/index.ts", "top-level.ts"], { cwd: f.repo });
    execFileSync("git", ["commit", "-qm", "add files"], { cwd: f.repo });

    const files = await collectChangedFiles("main~1", "HEAD", nested);
    const byPath = new Map(files.map((file) => [file.path, file.content]));
    assert.equal(byPath.get("packages/app/index.ts"), "export const n = 1;\n");
    assert.equal(byPath.get("top-level.ts"), "export const t = 2;\n");
    assert.equal(files.length, 2);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("parseGithubOriginRepo parses https and ssh origin URLs", async () => {
  const f = await committedRepo("mg-git-origin-");
  try {
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/Acme-Org/my.repo.git"],
      { cwd: f.repo },
    );
    assert.deepEqual(parseGithubOriginRepo(f.repo), {
      owner: "Acme-Org",
      repo: "my.repo",
    });

    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:acme/cli.git"], {
      cwd: f.repo,
    });
    assert.deepEqual(parseGithubOriginRepo(f.repo), { owner: "acme", repo: "cli" });

    execFileSync("git", ["remote", "set-url", "origin", "https://gitlab.com/acme/cli.git"], {
      cwd: f.repo,
    });
    assert.equal(parseGithubOriginRepo(f.repo), null);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("collectChangedFiles warns when a path is unreadable", async () => {
  const f = await committedRepo("mg-git-warn-");
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await writeFile(path.join(f.repo, "gone.ts"), "export {};\n");
    execFileSync("git", ["add", "gone.ts"], { cwd: f.repo });
    execFileSync("git", ["commit", "-qm", "add gone"], { cwd: f.repo });
    // Keep the tree entry in the diff range, but delete the working-tree file so read fails.
    await rm(path.join(f.repo, "gone.ts"));

    const files = await collectChangedFiles("main~1", "HEAD", f.repo);
    assert.equal(files.length, 0);
    assert.ok(
      warnings.some((w) => w.includes("could not read gone.ts")),
      `expected unreadable-file warning, got: ${warnings.join(" | ")}`,
    );
  } finally {
    console.warn = original;
    await rm(f.root, { recursive: true, force: true });
  }
});
