import { spawnSync } from "node:child_process";
import {
  getStackPublication,
  submitStackPublication,
  type StackPublication,
  type StackPublicationChange,
  type StackPublicationCommit,
  type StackPublicationIdentity,
  type StackPublicationStatus,
} from "./api.js";
import { loadConfig, type Config } from "./config.js";
import { CommandError } from "./errors.js";
import { parseGithubOriginRepo } from "./git.js";
import { currentBranch, discoverTrunk, tipCommitMessage, tipCommitSubject } from "./git-stack.js";
import { buildPrBodyFromCommit } from "./pr-body.js";

export const SERVER_PUBLISH_MAX_COMMITS = 20;
export const SERVER_PUBLISH_MAX_CHANGES = 500;
export const SERVER_PUBLISH_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SERVER_PUBLISH_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const SERVER_PUBLISH_MAX_COMMIT_BYTES = 1024 * 1024;
export const SERVER_PUBLISH_FILE_MODES = ["100644", "100755", "120000"] as const;
export const SERVER_PUBLISH_HISTORY_SCAN = 500;

type FileMode = (typeof SERVER_PUBLISH_FILE_MODES)[number];

export type GitRead = (args: string[], cwd: string) => Buffer;

const READ_ONLY_GIT = new Set(["cat-file", "diff-tree", "merge-base", "rev-list", "rev-parse", "symbolic-ref"]);

export function readGit(args: string[], cwd: string): Buffer {
  if (!READ_ONLY_GIT.has(args[0] ?? "")) {
    throw new Error(`server-side publication only reads the repository; refusing git ${args[0] ?? ""}`);
  }
  const result = spawnSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString("utf8").trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function text(read: GitRead, args: string[], cwd: string): string {
  return read(args, cwd).toString("utf8").trim();
}

function resolves(read: GitRead, ref: string, cwd: string): string | null {
  try {
    return text(read, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd) || null;
  } catch {
    return null;
  }
}

function isoWithOffset(epochSeconds: number, offset: string): string | null {
  const sign = offset.startsWith("-") ? -1 : 1;
  const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)));
  const shifted = new Date((epochSeconds + minutes * 60) * 1000);
  if (Number.isNaN(shifted.getTime()) || shifted.getUTCFullYear() < 1970 || shifted.getUTCFullYear() > 9999) return null;
  return `${shifted.toISOString().slice(0, 19)}${offset.slice(0, 3)}:${offset.slice(3, 5)}`;
}

function parseIdentity(line: string, sha: string): StackPublicationIdentity {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) throw new CommandError(`Could not read the author or committer of ${sha}.`, 1, "unsupported_publication");
  const date = isoWithOffset(Number(match[3]), match[4]!);
  if (!date) {
    throw new CommandError(
      `Commit ${sha} has an author or committer time (${match[3]} ${match[4]}) outside the years 1970-9999 and cannot be published.`,
      1,
      "unsupported_publication",
    );
  }
  return { name: match[1]!.trim() ? match[1]! : match[2]!, email: match[2]!, date };
}

export function readCommitHeader(
  read: GitRead,
  sha: string,
  cwd: string,
): { tree: string; parents: string[]; author: StackPublicationIdentity; committer: StackPublicationIdentity; message: string } {
  const commitBytes = Number(text(read, ["cat-file", "-s", sha], cwd));
  if (commitBytes > SERVER_PUBLISH_MAX_COMMIT_BYTES) {
    throw new CommandError(
      `Commit ${sha} is ${commitBytes} bytes; server-side publication reads commits up to ${SERVER_PUBLISH_MAX_COMMIT_BYTES} bytes.`,
      1,
      "payload_too_large",
    );
  }
  const commitObject = read(["cat-file", "commit", sha], cwd);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(commitObject);
  } catch {
    throw new CommandError(`Commit ${sha} is not valid UTF-8 and cannot be published losslessly.`, 1, "unsupported_publication");
  }
  const split = raw.indexOf("\n\n");
  const head = split === -1 ? raw : raw.slice(0, split);
  const message = split === -1 ? "" : raw.slice(split + 2);
  let tree = "";
  const parents: string[] = [];
  let author = "";
  let committer = "";
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
    else if (line.startsWith("author ")) author = line.slice(7);
    else if (line.startsWith("committer ")) committer = line.slice(10);
  }
  if (!tree || !message.trim()) {
    throw new CommandError(`Commit ${sha} has no tree or no message and cannot be published.`, 1, "unsupported_publication");
  }
  return { tree, parents, author: parseIdentity(author, sha), committer: parseIdentity(committer, sha), message };
}

export function readCommitChanges(
  read: GitRead,
  parent: string,
  sha: string,
  cwd: string,
  budget: { changes: number; bytes: number },
): StackPublicationChange[] {
  const listing = read(
    ["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-commit-id", "--abbrev=40", parent, sha],
    cwd,
  );
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(listing);
  } catch {
    throw new CommandError(
      `Commit ${sha} changes a file whose name is not valid UTF-8. Server-side publication cannot carry that name exactly; rename the file.`,
      1,
      "unsupported_publication",
    );
  }
  const tokens = raw.split("\0");
  const changes: StackPublicationChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i]!;
    const path = tokens[i + 1]!;
    const [, newMode, , newSha, status] = meta.replace(/^:/, "").split(" ");
    budget.changes += 1;
    if (budget.changes > SERVER_PUBLISH_MAX_CHANGES) {
      throw new CommandError(
        `More than ${SERVER_PUBLISH_MAX_CHANGES} changed paths; server-side publication cannot carry this branch in one request.`,
        1,
        "payload_too_large",
      );
    }
    if (status === "D") {
      changes.push({ path, deleted: true });
      continue;
    }
    if (!(SERVER_PUBLISH_FILE_MODES as readonly string[]).includes(newMode ?? "")) {
      throw new CommandError(
        `${path} has Git mode ${newMode}, which server-side publication does not support` +
          `${newMode === "160000" ? " (it is a submodule)" : ""}. Supported modes are ${SERVER_PUBLISH_FILE_MODES.join(", ")}.`,
        1,
        "unsupported_publication",
      );
    }
    const size = Number(text(read, ["cat-file", "-s", newSha!], cwd));
    if (size > SERVER_PUBLISH_MAX_FILE_BYTES) {
      throw new CommandError(
        `${path} is ${size} bytes; server-side publication carries files up to ${SERVER_PUBLISH_MAX_FILE_BYTES} bytes.`,
        1,
        "payload_too_large",
      );
    }
    budget.bytes += size;
    if (budget.bytes > SERVER_PUBLISH_MAX_TOTAL_BYTES) {
      throw new CommandError(
        `More than ${SERVER_PUBLISH_MAX_TOTAL_BYTES} bytes of file content; server-side publication cannot carry this branch in one request.`,
        1,
        "payload_too_large",
      );
    }
    const content = read(["cat-file", "blob", newSha!], cwd);
    changes.push({ path, mode: newMode as FileMode, sha: newSha!, content: content.toString("base64") });
  }
  return changes;
}

export function readPublicationCommits(read: GitRead, from: string, to: string, cwd: string): StackPublicationCommit[] {
  try {
    read(["merge-base", "--is-ancestor", from, to], cwd);
  } catch {
    throw new CommandError(`${from} is not an ancestor of ${to}; the commits to publish are not a straight line.`, 1, "unsupported_publication");
  }
  if (text(read, ["rev-list", "--min-parents=2", "--max-count=1", `${from}..${to}`], cwd)) {
    throw new CommandError(
      `A merge commit sits between ${from} and ${to}. Server-side publication carries single-parent commits only; rebase or squash the branch.`,
      1,
      "unsupported_publication",
    );
  }
  const shas = text(read, ["rev-list", "--reverse", `${from}..${to}`], cwd).split("\n").filter(Boolean);
  if (shas.length > SERVER_PUBLISH_MAX_COMMITS) {
    throw new CommandError(
      `${shas.length} commits to publish; server-side publication carries at most ${SERVER_PUBLISH_MAX_COMMITS} at once. Squash the branch.`,
      1,
      "payload_too_large",
    );
  }
  const commits: StackPublicationCommit[] = [];
  const budget = { changes: 0, bytes: 0 };
  for (const sha of shas) {
    const header = readCommitHeader(read, sha, cwd);
    const changes = readCommitChanges(read, header.parents[0]!, sha, cwd, budget);
    commits.push({
      message: header.message,
      author: header.author,
      committer: header.committer,
      tree: header.tree,
      changes,
    });
  }
  return commits;
}

function localCommitWithTree(read: GitRead, from: string, branch: string, head: { sha: string; tree: string }, cwd: string): string | null {
  const lines = text(
    read,
    ["rev-list", `--max-count=${SERVER_PUBLISH_HISTORY_SCAN}`, "--format=%H %T", "--no-commit-header", `${from}..${branch}`],
    cwd,
  )
    .split("\n")
    .filter(Boolean);
  let match: string | null = null;
  for (const line of lines) {
    const [sha, lineTree] = line.split(" ");
    if (lineTree !== head.tree) continue;
    if (sha === head.sha) return sha!;
    match ??= sha!;
  }
  return match;
}

export type ServerPublishInput = {
  cfg: Config;
  cwd: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  localBaseRef?: string;
  remoteBaseSha?: string;
  title: string;
  body: string;
  autoLand?: boolean;
  replaceHead?: string;
};

export type ServerPublishDeps = {
  read?: GitRead;
  getStackPublication?: typeof getStackPublication;
  submitStackPublication?: typeof submitStackPublication;
};

export type ServerPublishResult = StackPublication & { baseBranch: string };

export async function publishBranchServerSide(
  input: ServerPublishInput,
  deps: ServerPublishDeps = {},
): Promise<ServerPublishResult> {
  const read = deps.read ?? readGit;
  const status = deps.getStackPublication ?? getStackPublication;
  const submit = deps.submitStackPublication ?? submitStackPublication;
  const { cfg, cwd, owner, repo, branch } = input;

  if (!resolves(read, branch, cwd)) throw new CommandError(`Branch missing locally: ${branch}`);
  const remote: StackPublicationStatus = await status(cfg, { owner, repo, branch });
  const baseBranch = remote.pr?.base ?? input.baseBranch;
  const localBase =
    input.localBaseRef ??
    (resolves(read, `refs/remotes/origin/${input.baseBranch}`, cwd) ? `refs/remotes/origin/${input.baseBranch}` : input.baseBranch);
  if (!resolves(read, localBase, cwd)) throw new CommandError(`Base branch missing locally: ${localBase}`);
  const fork = text(read, ["merge-base", localBase, branch], cwd);
  const baseSha = input.remoteBaseSha ?? fork;

  let onto: "base" | "head" = "base";
  let expectedHead: string | null = null;
  let from = fork;
  if (remote.head) {
    const published = remote.head.tree ? localCommitWithTree(read, fork, branch, { sha: remote.head.sha, tree: remote.head.tree }, cwd) : null;
    if (published) {
      onto = "head";
      expectedHead = remote.head.sha;
      from = published;
    } else if (input.replaceHead) {
      if (input.replaceHead !== remote.head.sha) {
        throw new CommandError(
          `${branch} is at ${remote.head.sha} on GitHub, not ${input.replaceHead}. Nothing was changed.`,
          1,
          "head_changed",
        );
      }
      expectedHead = remote.head.sha;
    } else {
      throw new CommandError(
        `${branch} on GitHub is at ${remote.head.sha}, whose files match no commit of your local ${branch}. ` +
          `Someone else pushed to it, or you rewrote the branch. Nothing was changed. ` +
          `To replace that head with your local branch, pass --replace-head ${remote.head.sha}.`,
        1,
        "head_changed",
      );
    }
  }

  const commits = readPublicationCommits(read, from, branch, cwd);
  if (commits.length === 0 && onto === "base") {
    throw new CommandError(`No commits on \`${branch}\` ahead of \`${input.baseBranch}\`. Commit your changes, then retry.`);
  }
  const publication = await submit(cfg, {
    owner,
    repo,
    branch,
    base: { branch: baseBranch, sha: baseSha },
    expectedHead,
    onto,
    commits,
    pr: { title: input.title, body: input.body },
    ...(typeof input.autoLand === "boolean" ? { autoLand: input.autoLand } : {}),
  });
  const localTree = text(read, ["rev-parse", `${branch}^{tree}`], cwd);
  if (publication.head.tree !== localTree) {
    throw new CommandError(
      `GitHub has tree ${publication.head.tree} at ${branch}, but your local branch has tree ${localTree}.`,
      1,
      "tree_mismatch",
    );
  }
  return { ...publication, baseBranch };
}

export type WorkingBranchInput = {
  cwd?: string;
  owner?: string;
  repo?: string;
  branch?: string;
  base?: string;
  title?: string;
  body?: string;
  autoLand?: boolean;
  replaceHead?: string;
  cfg?: Config;
};

export type WorkingBranchDeps = ServerPublishDeps & {
  publishBranchServerSide?: typeof publishBranchServerSide;
  loadConfig?: typeof loadConfig;
};

export function workingBranchTarget(input: WorkingBranchInput): { cwd: string; owner: string; repo: string; branch: string } {
  const cwd = input.cwd ?? process.cwd();
  const origin = input.owner && input.repo ? { owner: input.owner, repo: input.repo } : parseGithubOriginRepo(cwd);
  if (!origin) {
    throw new CommandError("Could not parse GitHub owner/repo from `origin`. Set a github.com remote, or pass owner and repo.");
  }
  const branch = input.branch ?? currentBranch(cwd);
  if (!branch) throw new CommandError("Not on a branch. Check one out or name the branch to publish.");
  return { cwd, owner: origin.owner, repo: origin.repo, branch };
}

export async function publishWorkingBranch(
  input: WorkingBranchInput,
  deps: WorkingBranchDeps = {},
): Promise<ServerPublishResult> {
  const { cwd, owner, repo, branch } = workingBranchTarget(input);
  let baseBranch = input.base;
  if (!baseBranch) {
    try {
      baseBranch = discoverTrunk(cwd);
    } catch (err) {
      throw new CommandError(`${err instanceof Error ? err.message : String(err)} Name the base branch.`);
    }
  }
  const { publishBranchServerSide: publish = publishBranchServerSide, loadConfig: load = loadConfig, ...publishDeps } = deps;
  return publish(
    {
      cfg: input.cfg ?? (await load()),
      cwd,
      owner,
      repo,
      branch,
      baseBranch,
      title: input.title ?? tipCommitSubject(branch, cwd),
      body: input.body ?? buildPrBodyFromCommit(tipCommitMessage(branch, cwd)),
      ...(typeof input.autoLand === "boolean" ? { autoLand: input.autoLand } : {}),
      ...(input.replaceHead ? { replaceHead: input.replaceHead } : {}),
    },
    publishDeps,
  );
}

export async function workingBranchPublication(
  input: WorkingBranchInput,
  deps: Pick<WorkingBranchDeps, "getStackPublication" | "loadConfig"> = {},
): Promise<StackPublicationStatus> {
  const { owner, repo, branch } = workingBranchTarget(input);
  const cfg = input.cfg ?? (await (deps.loadConfig ?? loadConfig)());
  return (deps.getStackPublication ?? getStackPublication)(cfg, { owner, repo, branch });
}
