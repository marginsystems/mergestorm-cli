import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  activeLayers,
  appendLayer,
  emptyStackMeta,
  loadStackMeta,
  removeActiveStack,
  resetStackMeta,
  saveStackMeta,
  selectStackForCreate,
  setActiveAutoEnqueue,
  stackMetaPath,
  type StackMeta,
} from "./stack-meta.js";
import { defaultLayerBranchName, slugifyBranchName } from "./git-stack.js";

async function fixture(prefix: string): Promise<{
  root: string;
  repo: string;
  stateRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, "repo");
  const stateRoot = path.join(root, "state");
  await mkdir(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return { root, repo, stateRoot };
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

test("slugifyBranchName and defaultLayerBranchName", () => {
  assert.equal(slugifyBranchName("Feat Foo!"), "feat-foo");
  assert.equal(defaultLayerBranchName("feat/bar"), "feat/bar");
  assert.equal(defaultLayerBranchName("bar"), "ms/bar");
  assert.match(defaultLayerBranchName(), /^ms\//);
});

test("save/load round-trip is global, private, atomic, and leaves repo clean", async () => {
  const f = await fixture("mg-stack-global-");
  try {
    const meta: StackMeta = {
      version: 2,
      trunk: "main",
      stacks: [
        {
          layers: [{ branch: "ms/a", parentBranch: "main" }],
          autoEnqueueWhenReady: true,
        },
      ],
      active: 0,
    };
    await saveStackMeta(meta, f.repo, f.stateRoot);
    const file = stackMetaPath(f.repo, f.stateRoot);
    assert.equal(await exists(path.join(f.repo, ".mergestorm")), false);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await loadStackMeta(f.repo, f.stateRoot), meta);

    const next = appendLayer(meta, { branch: "ms/b", parentBranch: "ms/a" });
    await saveStackMeta(next, f.repo, f.stateRoot);
    assert.deepEqual(await loadStackMeta(f.repo, f.stateRoot), next);
    assert.deepEqual(
      (await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("save cleans up orphaned temp files left by an interrupted write", async () => {
  const f = await fixture("mg-stack-orphan-");
  try {
    const file = stackMetaPath(f.repo, f.stateRoot);
    await mkdir(path.dirname(file), { recursive: true });
    const orphan = path.join(path.dirname(file), "stack.json.999.orphan.tmp");
    await writeFile(orphan, "{}");
    await saveStackMeta(emptyStackMeta("main"), f.repo, f.stateRoot);
    assert.equal(await exists(orphan), false);
    assert.deepEqual(
      (await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("reset removes global and legacy state but no branches or server state", async () => {
  const f = await fixture("mg-stack-reset-");
  try {
    await saveStackMeta(emptyStackMeta("main"), f.repo, f.stateRoot);
    await resetStackMeta(f.repo, f.stateRoot);
    assert.equal(await exists(stackMetaPath(f.repo, f.stateRoot)), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("reset outside a git worktree clears nothing instead of crashing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mg-stack-nongit-"));
  const cwd = path.join(root, "norepo");
  const stateRoot = path.join(root, "state");
  await mkdir(cwd);
  try {
    await assert.doesNotReject(resetStackMeta(cwd, stateRoot));
    assert.equal(await exists(path.join(stateRoot)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset does not crash for a linked worktree whose main repository was deleted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mg-stack-broken-"));
  try {
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "linked");
    const stateRoot = path.join(root, "state");
    await mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
    execFileSync("git", ["worktree", "add", "-qb", "feature", worktree], { cwd: repo });
    await rm(repo, { recursive: true, force: true });
    await assert.doesNotReject(resetStackMeta(worktree, stateRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load returns null when neither global nor legacy state exists", async () => {
  const f = await fixture("mg-stack-missing-");
  try {
    assert.equal(await loadStackMeta(f.repo, f.stateRoot), null);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("malformed global state points to CLI reset recovery", async () => {
  const f = await fixture("mg-stack-malformed-");
  try {
    const file = stackMetaPath(f.repo, f.stateRoot);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ version: 2, trunk: "main", stacks: [], active: 0 }),
    );
    await assert.rejects(
      loadStackMeta(f.repo, f.stateRoot),
      /mg stack reset --force/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("non-object JSON in global state points to CLI reset recovery", async () => {
  const f = await fixture("mg-stack-nonobject-");
  try {
    const file = stackMetaPath(f.repo, f.stateRoot);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify("x"));
    await assert.rejects(loadStackMeta(f.repo, f.stateRoot), /mg stack reset --force/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("save corrects permissive existing directory and file modes", async () => {
  const f = await fixture("mg-stack-modes-");
  try {
    const file = stackMetaPath(f.repo, f.stateRoot);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
    await writeFile(file, "{}", { mode: 0o644 });
    await chmod(path.dirname(file), 0o755);
    await saveStackMeta(emptyStackMeta("main"), f.repo, f.stateRoot);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("multi-stack selection and cleanup preserve independent stacks", () => {
  let meta = setActiveAutoEnqueue(emptyStackMeta("main"), true);
  meta = appendLayer(meta, {
    branch: "ms/one",
    parentBranch: "main",
  });
  assert.equal(meta.stacks[0]!.autoEnqueueWhenReady, true);
  meta = selectStackForCreate(meta, "main");
  meta = setActiveAutoEnqueue(meta, false);
  meta = appendLayer(meta, { branch: "ms/two", parentBranch: "main" });
  assert.equal(meta.stacks.length, 2);
  assert.equal(meta.stacks[1]!.autoEnqueueWhenReady, false);
  assert.deepEqual(activeLayers(meta), [
    { branch: "ms/two", parentBranch: "main" },
  ]);
  assert.throws(() => selectStackForCreate(meta, "ms/one"), /different local stack/);

  const after = removeActiveStack(meta);
  assert.equal(after.stacks.length, 1);
  assert.equal(after.active, 0);
  assert.equal(after.stacks[0]!.layers[0]!.branch, "ms/one");
});

test("activeLayers rejects an out-of-range active index", () => {
  const meta: StackMeta = {
    version: 2,
    trunk: "main",
    stacks: [{ layers: [] }],
    active: 3,
  };
  assert.throws(() => activeLayers(meta), /mg stack reset --force/);
});
