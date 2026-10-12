import { readFileSync } from "node:fs";
import { openStackIssue } from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError, REVIEW_EXIT } from "../errors.js";
import { parseGithubOriginRepo } from "../git.js";

export const ISSUE_USAGE = [
  "usage: mergestorm issue create --title <title> [--body <text> | --body-file <path>]",
  "         [--label <name>]… [--repo <owner/repo>] [--json]",
  "  Opens a GitHub issue through Mergestorm as the Surge App. Needs no gh and no GitHub login.",
  "  Uses existing labels only. Running it again with the same title returns the open issue it already made when that issue is among the newest 100 open issues; an older one, or two calls at once, can still create a duplicate.",
].join("\n");

const VALUE_FLAGS = new Set(["--title", "--body", "--body-file", "--label", "--repo"]);

export type ParsedIssueArgs = { title: string; body: string; labels: string[]; repo?: { owner: string; repo: string }; json: boolean };

function usage(message?: string): CommandError {
  return new CommandError(message ? `${message}\n${ISSUE_USAGE}` : ISSUE_USAGE, REVIEW_EXIT.usage, "usage");
}

export function parseIssueCreateArgs(args: string[], readBody: (path: string) => string = (path) => readFileSync(path, "utf8")): ParsedIssueArgs {
  let title = "";
  let body: string | undefined;
  let bodyFile: string | undefined;
  let repo: ParsedIssueArgs["repo"];
  const labels: string[] = [];
  let json = false;
  const value = (flag: string, raw: string | undefined): string => {
    if (raw === undefined || raw.startsWith("--")) throw usage(`${flag} needs a value`);
    return raw;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--title") title = value(arg, args[++i]).trim();
    else if (arg === "--body") body = value(arg, args[++i]);
    else if (arg === "--body-file") bodyFile = value(arg, args[++i]);
    else if (arg === "--label") {
      const label = value(arg, args[++i]).trim();
      if (!label) throw usage("--label needs a non-empty name");
      labels.push(label);
    }
    else if (arg === "--repo") {
      const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value(arg, args[++i]).trim());
      if (!match) throw usage("--repo needs <owner/repo>");
      repo = { owner: match[1]!, repo: match[2]! };
    } else if (arg === "--json") json = true;
    else throw usage(`unknown argument ${arg}`);
  }
  if (!title) throw usage("--title is required");
  if (body !== undefined && bodyFile !== undefined) throw usage("pass --body or --body-file, not both");
  if (bodyFile !== undefined) {
    try {
      body = readBody(bodyFile);
    } catch (err) {
      throw new CommandError(`Could not read ${bodyFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { title, body: body ?? "", labels, ...(repo ? { repo } : {}), json };
}

export type IssueDeps = {
  cwd?: string;
  loadConfig?: typeof loadConfig;
  openStackIssue?: typeof openStackIssue;
  parseGithubOriginRepo?: typeof parseGithubOriginRepo;
  readBody?: (path: string) => string;
};

export async function cmdIssue(args: string[], deps: IssueDeps = {}): Promise<void> {
  const sub = args[0]?.toLowerCase();
  const asksForHelp = (arg: string | undefined) => arg === "-h" || arg === "--help" || arg === "help";
  const createAsksForHelp = (rest: string[]) => {
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (asksForHelp(arg)) return true;
      if (VALUE_FLAGS.has(arg!)) i++;
    }
    return false;
  };
  if (!sub || asksForHelp(sub) || (sub === "create" && createAsksForHelp(args.slice(1)))) {
    console.log(ISSUE_USAGE);
    return;
  }
  if (sub !== "create") throw usage(`unknown issue subcommand: ${sub}`);
  const parsed = parseIssueCreateArgs(args.slice(1), deps.readBody);
  const target = parsed.repo ?? (deps.parseGithubOriginRepo ?? parseGithubOriginRepo)(deps.cwd ?? process.cwd());
  if (!target) {
    throw new CommandError("Could not parse GitHub owner/repo from `origin`. Pass --repo <owner/repo>.");
  }
  const issue = await (deps.openStackIssue ?? openStackIssue)(
    { owner: target.owner, repo: target.repo, title: parsed.title, body: parsed.body, labels: parsed.labels },
    await (deps.loadConfig ?? loadConfig)(),
  );
  if (parsed.json) {
    console.log(JSON.stringify({ owner: target.owner, repo: target.repo, ...issue }, null, 2));
    return;
  }
  console.log(`${issue.created ? "Opened" : "Already open:"} ${target.owner}/${target.repo}#${issue.number}  ${issue.url}`);
  console.log(`Put \`Fixes #${issue.number}\` in the commit or pull request body.`);
}
