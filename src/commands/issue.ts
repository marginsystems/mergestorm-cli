import { readFileSync } from "node:fs";
import {
  ISSUE_REVIEW_DEFAULT_TIMEOUT_MS,
  IssueReviewTimeoutError,
  issueNotApprovedError,
  issueReviewLines,
  openStackIssue,
  pollIssueReview,
  type IssueReviewStatus,
} from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError, REVIEW_EXIT } from "../errors.js";
import { parseGithubOriginRepo } from "../git.js";

const ISSUE_USAGE = [
  "usage: mergestorm issue create --title <title> [--body <text> | --body-file <path>]",
  "         [--label <name>]… [--repo <owner/repo>] [--wait [--timeout <seconds>]] [--json]",
  "  Opens a GitHub issue through Mergestorm as the Surge App. Needs no gh and no GitHub login.",
  "  Uses existing labels only. Running it again with the same title returns the open issue it already made when that issue is among the newest 100 open issues; an older one, or two calls at once, can still create a duplicate.",
  "  --wait waits for the Vortex issue review afterwards, like issue wait.",
  "       mergestorm issue wait <number> [--repo <owner/repo>] [--timeout <seconds>] [--json]",
  `  Waits for the Vortex review of the issue (default ${ISSUE_REVIEW_DEFAULT_TIMEOUT_MS / 1000}s). Exits 0 once the issue is approved or issue reviews are off.`,
  `  Exits ${REVIEW_EXIT.failed} when the review has points to answer: reply in a comment on the issue, then wait again. Open the pull request only after approval.`,
].join("\n");

const VALUE_FLAGS = new Set(["--title", "--body", "--body-file", "--label", "--repo", "--timeout"]);

type RepoTarget = { owner: string; repo: string };

export type ParsedIssueArgs = {
  title: string;
  body: string;
  labels: string[];
  repo?: RepoTarget;
  json: boolean;
  wait?: boolean;
  timeoutMs?: number;
};

export type ParsedIssueWaitArgs = { number: number; repo?: RepoTarget; timeoutMs: number; json: boolean };

function usage(message?: string): CommandError {
  return new CommandError(message ? `${message}\n${ISSUE_USAGE}` : ISSUE_USAGE, REVIEW_EXIT.usage, "usage");
}

function flagValue(flag: string, raw: string | undefined): string {
  if (raw === undefined || raw.startsWith("--")) throw usage(`${flag} needs a value`);
  return raw;
}

function parseRepo(raw: string): RepoTarget {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw.trim());
  if (!match) throw usage("--repo needs <owner/repo>");
  return { owner: match[1]!, repo: match[2]! };
}

function parseTimeoutMs(raw: string): number {
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1) throw usage("--timeout needs a whole number of seconds, at least 1");
  return seconds * 1000;
}

export function parseIssueCreateArgs(args: string[], readBody: (path: string) => string = (path) => readFileSync(path, "utf8")): ParsedIssueArgs {
  let title = "";
  let body: string | undefined;
  let bodyFile: string | undefined;
  let repo: RepoTarget | undefined;
  const labels: string[] = [];
  let json = false;
  let wait = false;
  let timeoutMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--title") title = flagValue(arg, args[++i]).trim();
    else if (arg === "--body") body = flagValue(arg, args[++i]);
    else if (arg === "--body-file") bodyFile = flagValue(arg, args[++i]);
    else if (arg === "--label") {
      const label = flagValue(arg, args[++i]).trim();
      if (!label) throw usage("--label needs a non-empty name");
      labels.push(label);
    }
    else if (arg === "--repo") repo = parseRepo(flagValue(arg, args[++i]));
    else if (arg === "--json") json = true;
    else if (arg === "--wait") wait = true;
    else if (arg === "--timeout") timeoutMs = parseTimeoutMs(flagValue(arg, args[++i]));
    else throw usage(`unknown argument ${arg}`);
  }
  if (!title) throw usage("--title is required");
  if (body !== undefined && bodyFile !== undefined) throw usage("pass --body or --body-file, not both");
  if (timeoutMs !== undefined && !wait) throw usage("--timeout requires --wait");
  if (bodyFile !== undefined) {
    try {
      body = readBody(bodyFile);
    } catch (err) {
      throw new CommandError(`Could not read ${bodyFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    title,
    body: body ?? "",
    labels,
    ...(repo ? { repo } : {}),
    json,
    ...(wait ? { wait } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

export function parseIssueWaitArgs(args: string[]): ParsedIssueWaitArgs {
  let number: number | undefined;
  let repo: RepoTarget | undefined;
  let timeoutMs = ISSUE_REVIEW_DEFAULT_TIMEOUT_MS;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--repo") repo = parseRepo(flagValue(arg, args[++i]));
    else if (arg === "--timeout") timeoutMs = parseTimeoutMs(flagValue(arg, args[++i]));
    else if (arg === "--json") json = true;
    else if (!arg.startsWith("--") && number === undefined) {
      const match = /^#?(\d+)$/.exec(arg.trim());
      const n = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(n) || n < 1) throw usage(`issue wait needs an issue number, got ${arg}`);
      number = n;
    } else throw usage(`unknown argument ${arg}`);
  }
  if (number === undefined) throw usage("issue wait needs an issue number");
  return { number, ...(repo ? { repo } : {}), timeoutMs, json };
}

export type IssueDeps = {
  cwd?: string;
  loadConfig?: typeof loadConfig;
  openStackIssue?: typeof openStackIssue;
  pollIssueReview?: typeof pollIssueReview;
  parseGithubOriginRepo?: typeof parseGithubOriginRepo;
  readBody?: (path: string) => string;
};

function resolveTarget(repo: RepoTarget | undefined, deps: IssueDeps): RepoTarget {
  const target = repo ?? (deps.parseGithubOriginRepo ?? parseGithubOriginRepo)(deps.cwd ?? process.cwd());
  if (!target) {
    throw new CommandError("Could not parse GitHub owner/repo from `origin`. Pass --repo <owner/repo>.");
  }
  return target;
}

function asAuthExit(err: unknown): unknown {
  if (err instanceof CommandError && (err.code === "auth_invalid" || err.code === "missing_api_key")) {
    return new CommandError(err.message, REVIEW_EXIT.auth, err.code);
  }
  return err;
}

function approvedLine(status: IssueReviewStatus): string {
  if (status.state === "off") return `Issue reviews are off for ${status.owner}/${status.repo}; #${status.number} needs no approval.`;
  if (status.state === "unreviewed") return `Issue reviews for ${status.owner}/${status.repo} run on mention; #${status.number} needs no approval.`;
  if (status.approvedBy === null) return `The Vortex review of ${status.owner}/${status.repo}#${status.number} failed, so it does not hold the pull request back.`;
  const by = status.approvedBy === "human" ? "a person" : "Vortex";
  return `${status.owner}/${status.repo}#${status.number} is approved by ${by}.`;
}

export async function waitForIssueReview(
  target: RepoTarget & { number: number },
  opts: { timeoutMs: number; json: boolean; jsonShape?: (status: IssueReviewStatus) => unknown },
  deps: IssueDeps = {},
): Promise<void> {
  const printJson = (status: IssueReviewStatus) => console.log(JSON.stringify(opts.jsonShape ? opts.jsonShape(status) : status, null, 2));
  const progress = (line: string) => (opts.json ? console.error(line) : console.log(line));
  let status: IssueReviewStatus | null;
  try {
    const cfg = await (deps.loadConfig ?? loadConfig)();
    progress(`Waiting for the Vortex review of ${target.owner}/${target.repo}#${target.number} …`);
    status = await (deps.pollIssueReview ?? pollIssueReview)(cfg, target, { timeoutMs: opts.timeoutMs });
  } catch (err) {
    if (err instanceof IssueReviewTimeoutError) {
      if (opts.json) printJson(err.lastStatus);
      else console.log(issueReviewLines(err.lastStatus).join("\n"));
    }
    throw asAuthExit(err);
  }
  if (!status) {
    throw new CommandError(
      "This Mergestorm server does not review issues yet. Update the API, or open the pull request as before.",
      1,
      "issue_review_unavailable",
    );
  }
  if (opts.json) printJson(status);
  if (status.state === "approved" || status.state === "off" || (status.mode === "mention" && status.state === "unreviewed")) {
    if (!opts.json) {
      console.log(approvedLine(status));
      if (status.next) console.log(status.next);
    }
    return;
  }
  const refusal = issueNotApprovedError([status], `Vortex has not approved ${status.owner}/${status.repo}#${status.number} yet.`);
  if (opts.json) throw new CommandError(refusal.message.split("\n")[0]!, refusal.exitCode, refusal.code);
  throw refusal;
}

export async function cmdIssue(args: string[], deps: IssueDeps = {}): Promise<void> {
  const sub = args[0]?.toLowerCase();
  const asksForHelp = (arg: string | undefined) => arg === "-h" || arg === "--help" || arg === "help";
  const restAsksForHelp = (rest: string[]) => {
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (asksForHelp(arg)) return true;
      if (VALUE_FLAGS.has(arg!)) i++;
    }
    return false;
  };
  if (!sub || asksForHelp(sub) || ((sub === "create" || sub === "wait") && restAsksForHelp(args.slice(1)))) {
    console.log(ISSUE_USAGE);
    return;
  }
  if (sub === "wait") {
    const parsed = parseIssueWaitArgs(args.slice(1));
    const target = resolveTarget(parsed.repo, deps);
    await waitForIssueReview({ ...target, number: parsed.number }, parsed, deps);
    return;
  }
  if (sub !== "create") throw usage(`unknown issue subcommand: ${sub}`);
  const parsed = parseIssueCreateArgs(args.slice(1), deps.readBody);
  const target = resolveTarget(parsed.repo, deps);
  const issue = await (deps.openStackIssue ?? openStackIssue)(
    { owner: target.owner, repo: target.repo, title: parsed.title, body: parsed.body, labels: parsed.labels },
    await (deps.loadConfig ?? loadConfig)(),
  );
  const created = { owner: target.owner, repo: target.repo, ...issue };
  if (parsed.json && !parsed.wait) {
    console.log(JSON.stringify(created, null, 2));
  } else if (!parsed.json) {
    console.log(`${issue.created ? "Opened" : "Already open:"} ${target.owner}/${target.repo}#${issue.number}  ${issue.url}`);
    console.log(`Put \`Fixes #${issue.number}\` in the commit or pull request body.`);
  }
  if (!parsed.wait) return;
  await waitForIssueReview(
    { ...target, number: issue.number },
    {
      timeoutMs: parsed.timeoutMs ?? ISSUE_REVIEW_DEFAULT_TIMEOUT_MS,
      json: parsed.json,
      jsonShape: (review) => ({ ...created, review }),
    },
    deps,
  );
}
