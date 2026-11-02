import { readFileSync } from "node:fs";
import {
  ISSUE_REVIEW_ANSWER_GRACE_MS,
  ISSUE_REVIEW_DEFAULT_TIMEOUT_MS,
  ISSUE_REVIEW_STALL_MS,
  ISSUE_REVIEW_TAG,
  IssueReviewTimeoutError,
  issueNotApprovedError,
  issueReviewLines,
  issueReviewStallAdvice,
  openStackIssue,
  pollIssueReview,
  type IssueReviewStatus,
} from "../api.js";
import { loadConfig } from "../config.js";
import { issueWatchFailedLine, runIssueWatch, ISSUE_WATCH_EXIT, ISSUE_WATCH_NOTIFY_PATTERN } from "../issue-watch.js";
import { CommandError, REVIEW_EXIT } from "../errors.js";
import { parseGithubOriginRepo } from "../git.js";

const ISSUE_USAGE = [
  "usage: mergestorm issue create --title <title> [--body <text> | --body-file <path>]",
  "         [--label <name>]… [--repo <owner/repo>] [--wait [--timeout <seconds>]] [--json]",
  "  Opens a GitHub issue through Mergestorm as the Surge App. Needs no gh and no GitHub login.",
  "  Uses existing labels only. Running it again with the same title returns the open issue it already made when that issue is among the newest 100 open issues; an older one, or two calls at once, can still create a duplicate.",
  "  --wait waits for the Vortex issue review afterwards, like issue wait.",
  "       mergestorm issue wait <number> [--after-round <round>] [--waiting-since <epoch-ms>] [--repo <owner/repo>] [--timeout <seconds>] [--json]",
  `  Waits for the next Vortex verdict on the issue (default ${ISSUE_REVIEW_DEFAULT_TIMEOUT_MS / 1000}s). Spends no model tokens and no GitHub API calls while it waits.`,
  "  --after-round R: you already saw the round R verdict and answered it. The wait never returns that verdict again; it blocks until a newer round finishes.",
  "  --waiting-since MS: when this wait began, in epoch milliseconds. A timed-out wait prints it in the command to run next, so the stall clock carries across retries.",
  "  Without --after-round the wait still blocks once Vortex has seen an answer after the latest verdict.",
  `  Exits 0 when the issue is approved, issue reviews are off, or the repo reviews on mention and none was requested yet.`,
  `  Exits ${REVIEW_EXIT.failed} when the review has points: answer them in ONE new comment on the issue (the author or a maintainer; on a mention-mode repo the comment must tag ${ISSUE_REVIEW_TAG} and Vortex starts the next round at once; on an auto-mode repo Vortex starts it about 90s later, and an edit of the issue body by them starts one too; editing an earlier comment starts nothing), then run the printed \`mergestorm issue wait N --after-round R\` once.`,
  `  Exits ${REVIEW_EXIT.stalled} when no round started ${ISSUE_REVIEW_STALL_MS / 60_000} minutes after an answer, at once when an answer failed or was skipped without starting a round, when no review has started ${ISSUE_REVIEW_STALL_MS / 60_000} minutes into the wait, or ${ISSUE_REVIEW_STALL_MS / 60_000} minutes after the verdict with no answer seen (once the wait is at least ${ISSUE_REVIEW_ANSWER_GRACE_MS / 60_000} minutes old), with the reason. Tag ${ISSUE_REVIEW_TAG} at most once for that round, or tell the human; do not poll.`,
  `  Exits ${REVIEW_EXIT.timeout} on timeout: run the same command once more. One wait per round; never poll GitHub with gh or sleep loops.`,
  "       mergestorm issue watch <number> [--after-round <round>] [--max <minutes>] [--repo <owner/repo>] [--json]",
  "  The background form of issue wait, like stack watch: prints nothing and spends no tokens while it waits, then prints one line and exits.",
  `  Run it as a background command with a notification on output matching ${ISSUE_WATCH_NOTIFY_PATTERN}, then end your turn.`,
  `  MS-ISSUE READY issue=N (exit ${ISSUE_WATCH_EXIT.ready}): open the pull request.`,
  `  MS-ISSUE POINTS issue=N round=R (exit ${ISSUE_WATCH_EXIT.attention}): answer in one comment, then watch again with --after-round R.`,
  `  MS-ISSUE STALLED issue=N round=R minutes=M reason=X (exit ${ISSUE_WATCH_EXIT.attention}): tag ${ISSUE_REVIEW_TAG} at most once for that round, or tell the human once, and end the turn.`,
  `  MS-ISSUE ATTENTION failed issue=N error="…" (exit ${ISSUE_WATCH_EXIT.attention}) when reads keep failing; MS-ISSUE TIMEOUT (exit ${ISSUE_WATCH_EXIT.timeout}) after --max.`,
].join("\n");

const VALUE_FLAGS = new Set(["--title", "--body", "--body-file", "--label", "--repo", "--timeout", "--after-round", "--waiting-since", "--max"]);

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

export type ParsedIssueWaitArgs = { number: number; repo?: RepoTarget; timeoutMs: number; json: boolean; afterRound?: number; waitingSince?: number };

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
  let afterRound: number | undefined;
  let waitingSince: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--after-round") {
      const raw = flagValue(arg, args[++i]);
      const round = Number(raw);
      if (!Number.isSafeInteger(round) || round < 1) throw usage(`--after-round needs a round number, got ${raw}`);
      afterRound = round;
    } else if (arg === "--waiting-since") {
      const raw = flagValue(arg, args[++i]);
      const since = Number(raw);
      if (!Number.isSafeInteger(since) || since < 1) throw usage(`--waiting-since needs epoch milliseconds, got ${raw}`);
      waitingSince = since;
    } else if (arg === "--repo") repo = parseRepo(flagValue(arg, args[++i]));
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
  return {
    number,
    ...(repo ? { repo } : {}),
    timeoutMs,
    json,
    ...(afterRound !== undefined ? { afterRound } : {}),
    ...(waitingSince !== undefined ? { waitingSince } : {}),
  };
}

export type ParsedIssueWatchArgs = { number: number; repo?: RepoTarget; json: boolean; afterRound?: number; maxMs?: number };

export function parseIssueWatchArgs(args: string[]): ParsedIssueWatchArgs {
  const rest: string[] = [];
  let maxMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--max") {
      const raw = flagValue(arg, args[++i]);
      const ms = Math.round(Number(raw) * 60_000);
      if (!Number.isFinite(ms) || ms <= 0) throw usage("--max must be a positive number of minutes");
      maxMs = ms;
    } else if (arg === "--timeout") throw usage("issue watch takes --max <minutes>, not --timeout");
    else rest.push(arg);
  }
  const { timeoutMs: _timeout, ...wait } = parseIssueWaitArgs(rest);
  return { ...wait, ...(maxMs !== undefined ? { maxMs } : {}) };
}

export type IssueDeps = {
  cwd?: string;
  loadConfig?: typeof loadConfig;
  openStackIssue?: typeof openStackIssue;
  pollIssueReview?: typeof pollIssueReview;
  runIssueWatch?: typeof runIssueWatch;
  parseGithubOriginRepo?: typeof parseGithubOriginRepo;
  readBody?: (path: string) => string;
  signal?: AbortSignal;
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
  opts: { timeoutMs: number; json: boolean; afterRound?: number; waitingSince?: number; jsonShape?: (status: IssueReviewStatus) => unknown },
  deps: IssueDeps = {},
): Promise<void> {
  const printJson = (status: IssueReviewStatus) => console.log(JSON.stringify(opts.jsonShape ? opts.jsonShape(status) : status, null, 2));
  const progress = (line: string) => (opts.json ? console.error(line) : console.log(line));
  let status: IssueReviewStatus | null;
  try {
    const cfg = await (deps.loadConfig ?? loadConfig)();
    const after = opts.afterRound ? ` after round ${opts.afterRound}` : "";
    progress(`Waiting for the next Vortex verdict on ${target.owner}/${target.repo}#${target.number}${after} …`);
    status = await (deps.pollIssueReview ?? pollIssueReview)(cfg, target, {
      timeoutMs: opts.timeoutMs,
      ...(opts.afterRound !== undefined ? { afterRound: opts.afterRound } : {}),
      ...(opts.waitingSince !== undefined ? { waitingSince: opts.waitingSince } : {}),
    });
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
  if (status.wait.status === "stalled") {
    const round = status.wait.verdictRound ?? status.round ?? 0;
    const minutes = status.wait.minutes ?? 0;
    const line = `MS-ISSUE STALLED issue=${status.number} round=${round} minutes=${minutes} reason=${status.wait.reason}`;
    const message = `${line}\n${issueReviewStallAdvice(status.wait.reason, status.mode)}`;
    if (!opts.json) console.log(issueReviewLines(status).join("\n"));
    throw new CommandError(opts.json ? line : message, REVIEW_EXIT.stalled, "issue_review_stalled");
  }
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
  if (!sub || asksForHelp(sub) || ((sub === "create" || sub === "wait" || sub === "watch") && restAsksForHelp(args.slice(1)))) {
    console.log(ISSUE_USAGE);
    return;
  }
  if (sub === "wait") {
    const parsed = parseIssueWaitArgs(args.slice(1));
    const target = resolveTarget(parsed.repo, deps);
    await waitForIssueReview({ ...target, number: parsed.number }, parsed, deps);
    return;
  }
  if (sub === "watch") {
    await cmdIssueWatch(args.slice(1), deps);
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

async function cmdIssueWatch(args: string[], deps: IssueDeps): Promise<void> {
  const json = args.includes("--json");
  const marker = json ? console.error : console.log;
  let number: number | string = args.find((arg, i) => /^#?\d+$/.test(arg) && !VALUE_FLAGS.has(args[i - 1] ?? ""))?.replace("#", "") ?? "none";
  let result: Awaited<ReturnType<typeof runIssueWatch>>;
  try {
    const parsed = parseIssueWatchArgs(args);
    number = parsed.number;
    const target = resolveTarget(parsed.repo, deps);
    const cfg = await (deps.loadConfig ?? loadConfig)();
    result = await (deps.runIssueWatch ?? runIssueWatch)(cfg, { ...target, number: parsed.number }, {
      json,
      ...(parsed.afterRound !== undefined ? { afterRound: parsed.afterRound } : {}),
      ...(parsed.maxMs !== undefined ? { maxMs: parsed.maxMs } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.pollIssueReview ? { poll: deps.pollIssueReview } : {}),
    });
  } catch (err) {
    marker(issueWatchFailedLine(number, err instanceof Error ? err.message : String(err)));
    if (json) console.log(JSON.stringify({ issue: number, outcome: "failed" }));
    throw asAuthExit(err);
  }
  if (result.exitCode === ISSUE_WATCH_EXIT.ready) return;
  const reason = result.outcome === "timeout"
    ? `Stopped watching issue #${number} after --max; it is not approved.`
    : result.outcome === "points"
      ? `Issue #${number} has points to answer.`
      : result.outcome === "stalled"
        ? `No new Vortex round on issue #${number}.`
        : `Stopped watching issue #${number}; it is not approved.`;
  throw new CommandError(reason, result.exitCode, result.outcome === "timeout" ? "review_timeout" : result.outcome === "stalled" ? "issue_review_stalled" : "issue_not_approved");
}
