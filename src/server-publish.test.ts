import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { StackPublication, StackPublicationCommit, StackPublicationRequest, StackPublicationStatus } from "./api.js";
import { CommandError } from "./errors.js";
import {
  publishBranchServerSide,
  readGit,
  readPublicationCommits,
  SERVER_PUBLISH_MAX_FILE_BYTES,
  type GitRead,
} from "./server-publish.js";

const CFG = { apiKey: "msk_live_test", apiBase: "https://api.example.test" };
const ZERO = "0".repeat(40);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x00, 0x01, 0x80]);
const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function run(cwd: string, args: string[], opts: { input?: Buffer | string; env?: Record<string, string> } = {}): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    input: opts.input,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString("utf8")}`);
  return result.stdout;
}

function out(cwd: string, args: string[], opts: Parameters<typeof run>[2] = {}): string {
  return run(cwd, args, opts).toString("utf8").trim();
}

function commit(work: string, message: string): string {
  run(work, ["add", "-A"]);
  run(work, ["commit", "-q", "-m", message], {
    env: { GIT_AUTHOR_DATE: "2026-10-11T15:03:00-04:00", GIT_COMMITTER_DATE: "2026-10-11T15:04:05+05:30" },
  });
  return out(work, ["rev-parse", "HEAD"]);
}

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mg-server-publish-"));
  roots.push(root);
  run(root, ["init", "-q", "--initial-branch=main", "."]);
  run(root, ["config", "user.name", "Dot Agent"]);
  run(root, ["config", "user.email", "dot@example.com"]);
  run(root, ["config", "core.autocrlf", "false"]);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "README.md"), "# widgets\n");
  writeFileSync(path.join(root, "src", "old-name.ts"), "export const widget = 1;\n");
  writeFileSync(path.join(root, "src", "remove-me.ts"), "export const gone = true;\n");
  writeFileSync(path.join(root, "run.sh"), "#!/bin/sh\necho run\n");
  commit(root, "Initial commit");
  run(root, ["checkout", "-q", "-b", "dot/feature"]);
  return root;
}

function firstFeatureCommit(work: string): string {
  writeFileSync(path.join(work, "logo.png"), PNG);
  rmSync(path.join(work, "src", "remove-me.ts"));
  run(work, ["mv", "src/old-name.ts", "src/new-name.ts"]);
  chmodSync(path.join(work, "run.sh"), 0o755);
  symlinkSync("README.md", path.join(work, "docs-link"));
  mkdirSync(path.join(work, "deep", "nested dir"), { recursive: true });
  writeFileSync(path.join(work, "deep", "nested dir", "ünïcode file.txt"), "naïve café\n");
  return commit(work, "Add the logo and tidy the sources\n\nFixes #7");
}

function rebuildTree(work: string, parentTree: string, entry: StackPublicationCommit): string {
  const env = { GIT_INDEX_FILE: path.join(work, ".git", `rebuild-${Math.random().toString(36).slice(2)}`) };
  run(work, ["read-tree", parentTree], { env });
  const lines = entry.changes.map((change) => {
    if ("deleted" in change) return `0 ${ZERO}\t${change.path}`;
    const stored = out(work, ["hash-object", "-w", "--stdin"], { input: Buffer.from(change.content, "base64") });
    assert.equal(stored, change.sha);
    return `${change.mode} ${stored}\t${change.path}`;
  });
  run(work, ["update-index", "-z", "--index-info"], { env, input: lines.map((line) => `${line}\0`).join("") });
  return out(work, ["write-tree"], { env });
}

function registered(request: StackPublicationRequest, head: { sha: string; tree: string }): StackPublication {
  return {
    state: "registered",
    owner: request.owner,
    repo: request.repo,
    branch: request.branch,
    base: request.base,
    head,
    commits: [],
    branchCreated: request.expectedHead === null,
    branchUpdated: request.expectedHead !== null && request.commits.length > 0,
    pr: { number: 100, url: "https://github.com/acme/widgets/pull/100", created: true },
    stack: { id: "stack-100", autoPatchOverride: false, autoLand: true },
  };
}

function harness(work: string, remote: Partial<StackPublicationStatus> = {}) {
  const gitCalls: string[][] = [];
  const requests: StackPublicationRequest[] = [];
  const read: GitRead = (args, cwd) => {
    gitCalls.push(args);
    return readGit(args, cwd);
  };
  const localTree = () => out(work, ["rev-parse", "dot/feature^{tree}"]);
  return {
    gitCalls,
    requests,
    deps: {
      read,
      getStackPublication: async () => ({
        state: "absent" as const,
        owner: "acme",
        repo: "widgets",
        branch: "dot/feature",
        head: null,
        pr: null,
        stack: null,
        ...remote,
      }),
      submitStackPublication: async (_cfg: unknown, request: StackPublicationRequest) => {
        requests.push(request);
        return registered(request, { sha: "f".repeat(40), tree: localTree() });
      },
    },
    input: {
      cfg: CFG,
      cwd: work,
      owner: "acme",
      repo: "widgets",
      branch: "dot/feature",
      baseBranch: "main",
      title: "Add the logo",
      body: "Fixes #7",
    },
  };
}

test("readPublicationCommits carries binaries, deletions, modes, symlinks and renames so each commit's tree can be rebuilt exactly", () => {
  const work = repo();
  const first = firstFeatureCommit(work);
  writeFileSync(path.join(work, "logo.png"), Buffer.concat([PNG, PNG]));
  chmodSync(path.join(work, "run.sh"), 0o644);
  const second = commit(work, "Grow the logo");
  const commits = readPublicationCommits(readGit, "main", "dot/feature", work);
  assert.equal(commits.length, 2);

  const byPath = new Map(commits[0]!.changes.map((change) => [change.path, change]));
  assert.deepEqual(byPath.get("src/old-name.ts"), { path: "src/old-name.ts", deleted: true });
  assert.deepEqual(byPath.get("src/remove-me.ts"), { path: "src/remove-me.ts", deleted: true });
  const logo = byPath.get("logo.png");
  assert.ok(logo && !("deleted" in logo));
  assert.deepEqual(Buffer.from(logo.content, "base64"), PNG);
  const script = byPath.get("run.sh");
  assert.ok(script && !("deleted" in script) && script.mode === "100755");
  const link = byPath.get("docs-link");
  assert.ok(link && !("deleted" in link) && link.mode === "120000");
  assert.equal(Buffer.from(link.content, "base64").toString("utf8"), "README.md");
  assert.ok(byPath.has("src/new-name.ts"));
  assert.ok(byPath.has("deep/nested dir/ünïcode file.txt"));

  assert.equal(commits[0]!.message, "Add the logo and tidy the sources\n\nFixes #7\n");
  assert.deepEqual(commits[0]!.author, { name: "Dot Agent", email: "dot@example.com", date: "2026-10-11T15:03:00-04:00" });
  assert.deepEqual(commits[0]!.committer, { name: "Dot Agent", email: "dot@example.com", date: "2026-10-11T15:04:05+05:30" });

  let tree = out(work, ["rev-parse", "main^{tree}"]);
  for (const [index, sha] of [first, second].entries()) {
    tree = rebuildTree(work, tree, commits[index]!);
    assert.equal(tree, out(work, ["rev-parse", `${sha}^{tree}`]));
    assert.equal(tree, commits[index]!.tree);
  }
});

test("readPublicationCommits refuses submodules, merge commits and oversized files with a reason", () => {
  const withSubmodule = repo();
  const gitlink = out(withSubmodule, ["rev-parse", "main"]);
  run(withSubmodule, ["update-index", "--add", "--cacheinfo", `160000,${gitlink},vendor/lib`]);
  run(withSubmodule, ["commit", "-q", "-m", "Add a submodule"]);
  assert.throws(
    () => readPublicationCommits(readGit, "main", "dot/feature", withSubmodule),
    (err) => err instanceof CommandError && err.code === "unsupported_publication" && /vendor\/lib.*submodule/.test(err.message),
  );

  const withMerge = repo();
  writeFileSync(path.join(withMerge, "a.txt"), "a\n");
  commit(withMerge, "a");
  run(withMerge, ["checkout", "-q", "-b", "side", "main"]);
  writeFileSync(path.join(withMerge, "b.txt"), "b\n");
  commit(withMerge, "b");
  run(withMerge, ["checkout", "-q", "dot/feature"]);
  run(withMerge, ["merge", "-q", "--no-ff", "-m", "Merge side", "side"]);
  assert.throws(
    () => readPublicationCommits(readGit, "main", "dot/feature", withMerge),
    (err) => err instanceof CommandError && err.code === "unsupported_publication" && /merge commit/.test(err.message),
  );

  const withBigFile = repo();
  writeFileSync(path.join(withBigFile, "big.bin"), Buffer.alloc(SERVER_PUBLISH_MAX_FILE_BYTES + 1, 7));
  commit(withBigFile, "Add a big file");
  assert.throws(
    () => readPublicationCommits(readGit, "main", "dot/feature", withBigFile),
    (err) => err instanceof CommandError && err.code === "payload_too_large" && /big\.bin/.test(err.message),
  );
});

test("publishBranchServerSide sends a new branch onto its base commit and only ever reads the repository", async () => {
  const work = repo();
  firstFeatureCommit(work);
  const h = harness(work);
  const result = await publishBranchServerSide(h.input, h.deps);
  assert.equal(result.stack.autoPatchOverride, false);
  assert.equal(h.requests.length, 1);
  const sent = h.requests[0]!;
  assert.equal(sent.onto, "base");
  assert.equal(sent.expectedHead, null);
  assert.deepEqual(sent.base, { branch: "main", sha: out(work, ["rev-parse", "main"]) });
  assert.equal(sent.commits.length, 1);
  assert.equal(sent.commits[0]!.tree, out(work, ["rev-parse", "dot/feature^{tree}"]));
  const verbs = new Set(h.gitCalls.map((args) => args[0]));
  for (const verb of verbs) {
    assert.ok(["cat-file", "diff-tree", "merge-base", "rev-list", "rev-parse"].includes(verb!), `unexpected git ${verb}`);
  }
  for (const banned of ["push", "fetch", "pull", "remote", "commit", "update-ref", "checkout"]) {
    assert.throws(() => readGit([banned], work), /only reads the repository/);
  }
});

test("publishBranchServerSide appends only the commits GitHub does not have, and sends none when the branch is current", async () => {
  const work = repo();
  const first = firstFeatureCommit(work);
  const firstTree = out(work, ["rev-parse", `${first}^{tree}`]);
  writeFileSync(path.join(work, "more.txt"), "more\n");
  commit(work, "Follow-up");
  const remoteHead = "c".repeat(40);
  const behind = harness(work, { state: "registered", head: { sha: remoteHead, tree: firstTree }, pr: { number: 100, url: "u", base: "mg-stack-7" } });
  const appended = await publishBranchServerSide(behind.input, behind.deps);
  const sent = behind.requests[0]!;
  assert.equal(sent.onto, "head");
  assert.equal(sent.expectedHead, remoteHead);
  assert.deepEqual(sent.commits.map((entry) => entry.message), ["Follow-up\n"]);
  assert.equal(sent.base.branch, "mg-stack-7");
  assert.equal(appended.baseBranch, "mg-stack-7");

  const current = harness(work, { state: "pushed", head: { sha: remoteHead, tree: out(work, ["rev-parse", "dot/feature^{tree}"]) } });
  await publishBranchServerSide(current.input, current.deps);
  assert.equal(current.requests[0]!.onto, "head");
  assert.equal(current.requests[0]!.expectedHead, remoteHead);
  assert.deepEqual(current.requests[0]!.commits, []);
});

test("publishBranchServerSide refuses to move a head it does not recognise unless that exact head is named", async () => {
  const work = repo();
  firstFeatureCommit(work);
  const theirs = "d".repeat(40);
  const foreign = { state: "opened" as const, head: { sha: theirs, tree: "e".repeat(40) } };
  const refused = harness(work, foreign);
  await assert.rejects(
    () => publishBranchServerSide(refused.input, refused.deps),
    (err) => err instanceof CommandError && err.code === "head_changed" && err.message.includes(`--replace-head ${theirs}`),
  );
  assert.equal(refused.requests.length, 0);

  const wrong = harness(work, foreign);
  await assert.rejects(
    () => publishBranchServerSide({ ...wrong.input, replaceHead: "a".repeat(40) }, wrong.deps),
    (err) => err instanceof CommandError && err.code === "head_changed",
  );
  assert.equal(wrong.requests.length, 0);

  const named = harness(work, foreign);
  await publishBranchServerSide({ ...named.input, replaceHead: theirs }, named.deps);
  assert.equal(named.requests[0]!.onto, "base");
  assert.equal(named.requests[0]!.expectedHead, theirs);
  assert.equal(named.requests[0]!.commits.length, 1);
});

test("publishBranchServerSide builds an upper layer on the server's head of its parent and fails when GitHub's tree differs", async () => {
  const work = repo();
  firstFeatureCommit(work);
  run(work, ["checkout", "-q", "-b", "dot/upper"]);
  writeFileSync(path.join(work, "upper.txt"), "upper\n");
  commit(work, "Upper layer");
  const parentOnServer = "b".repeat(40);
  const h = harness(work);
  h.deps.submitStackPublication = async (_cfg, request) => {
    h.requests.push(request);
    return registered(request, { sha: "f".repeat(40), tree: out(work, ["rev-parse", "dot/upper^{tree}"]) });
  };
  await publishBranchServerSide(
    { ...h.input, branch: "dot/upper", baseBranch: "dot/feature", localBaseRef: "dot/feature", remoteBaseSha: parentOnServer },
    h.deps,
  );
  assert.deepEqual(h.requests[0]!.base, { branch: "dot/feature", sha: parentOnServer });
  assert.deepEqual(h.requests[0]!.commits.map((entry) => entry.message), ["Upper layer\n"]);

  const drifted = harness(work);
  drifted.deps.submitStackPublication = async (_cfg, request) => registered(request, { sha: "f".repeat(40), tree: "9".repeat(40) });
  await assert.rejects(
    () => publishBranchServerSide(drifted.input, drifted.deps),
    (err) => err instanceof CommandError && err.code === "tree_mismatch",
  );

  run(work, ["checkout", "-q", "-b", "empty", "main"]);
  const empty = harness(work);
  await assert.rejects(() => publishBranchServerSide({ ...empty.input, branch: "empty" }, empty.deps), /No commits on `empty` ahead of `main`/);
});

test("readPublicationCommits refuses a commit time outside the publishable range and a file name that is not UTF-8", () => {
  const farFuture = repo();
  writeFileSync(path.join(farFuture, "a.txt"), "a\n");
  run(farFuture, ["add", "-A"]);
  const tree = out(farFuture, ["write-tree"]);
  const parent = out(farFuture, ["rev-parse", "HEAD"]);
  const object = `tree ${tree}\nparent ${parent}\nauthor Dot Agent <dot@example.com> 99999999999999999 +0000\ncommitter Dot Agent <dot@example.com> 1760000000 +0000\n\nFrom the far future\n`;
  const sha = out(farFuture, ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { input: object });
  run(farFuture, ["update-ref", "refs/heads/dot/feature", sha]);
  assert.throws(
    () => readPublicationCommits(readGit, "main", "dot/feature", farFuture),
    (err) => err instanceof CommandError && err.code === "unsupported_publication" && /outside the years 1970-9999/.test(err.message),
  );

  const badName = repo();
  const blob = out(badName, ["hash-object", "-w", "--stdin"], { input: "x\n" });
  const env = { GIT_INDEX_FILE: path.join(badName, ".git", "bad-name-index") };
  run(badName, ["read-tree", "HEAD"], { env });
  run(badName, ["update-index", "-z", "--index-info"], {
    env,
    input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from([0x66, 0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]), Buffer.from([0])]),
  });
  const badTree = out(badName, ["write-tree"], { env });
  const badCommit = out(badName, ["commit-tree", badTree, "-p", "HEAD", "-m", "Add a file with a broken name"]);
  run(badName, ["update-ref", "refs/heads/dot/feature", badCommit]);
  assert.throws(
    () => readPublicationCommits(readGit, "main", "dot/feature", badName),
    (err) => err instanceof CommandError && err.code === "unsupported_publication" && /not valid UTF-8/.test(err.message),
  );
});
