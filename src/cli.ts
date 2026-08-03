#!/usr/bin/env node
import { stdin as input, stdout as output } from "node:process";
import { DEFAULT_API } from "./config.js";
import { CommandError } from "./errors.js";
import { cmdBranches, cmdChain } from "./commands/branches.js";
import { cmdCredits } from "./commands/credits.js";
import { cmdJobs, cmdThread } from "./commands/jobs.js";
import { cmdLogin } from "./commands/login.js";
import { cmdLogout } from "./commands/logout.js";
import { cmdReview } from "./commands/review.js";
import { cmdStack } from "./commands/stack.js";
import { cmdStatus } from "./commands/status.js";
import { cmdWhoami } from "./commands/whoami.js";
import { runShell } from "./shell.js";
import { ansi } from "./ui/ansi.js";
import { printWordmark } from "./ui/banner.js";

function usage(): void {
  printWordmark();
  console.log(`Usage:
  mergestorm                      Interactive shell (TTY)
  mergestorm shell                Explicit shell entry
  mergestorm login                Sign in via browser and store an API key
  mergestorm login --key          Paste an existing API key instead (headless/CI)
  mergestorm logout               Remove the stored API key
  mergestorm review [base] [head] Review git diff base...head (default: main...HEAD)
  mergestorm status <job_id>      Poll a review job (JSON)
  mergestorm credits [--json]     Credit balance (usage bars)
  mergestorm jobs [n] [--json]    Recent review jobs
  mergestorm branches [n]         Recently reviewed branches (pick on TTY)
  mergestorm chain [slug]         Branch review-chain timeline (default: current)
  mergestorm whoami [--json]      Key + plan + API base
  mergestorm thread <slug>        Jobs in a review thread
  mergestorm stack create [name]  New local stack layer (CLI-managed authoring state)
  mergestorm stack submit         Push active local stack, open PRs, register stack
  mergestorm stack reset --force  Clear this repo's pre-submit authoring state
  mergestorm stack list [--json]  List registered stacks
  mergestorm stack adopt <owner/repo>#<pr>  Import an existing open PR chain
  mergestorm stack restack <stack-id>   Restack stack descendants
  mergestorm stack land <stack-id>      Land bottom PR (or promote into unit)
  mergestorm stack auto-promote on|off <stack-id>  Toggle auto-promote when green

  mg is a short alias for mergestorm (same binary).

Env:
  MERGESTORM_API_KEY   API key (overrides config)
  MERGESTORM_API_URL   API base (default ${DEFAULT_API})
`);
}

async function runCommand(cmd: string, args: string[]): Promise<void> {
  if (cmd === "login") return cmdLogin(args);
  if (cmd === "logout") return cmdLogout();
  if (cmd === "review") return cmdReview(args);
  if (cmd === "status") {
    if (!args[0]) throw new CommandError("usage: mergestorm status <job_id>");
    return cmdStatus(args[0], { format: "json" });
  }
  if (cmd === "credits" || cmd === "usage") return cmdCredits(args);
  if (cmd === "jobs") return cmdJobs(args);
  if (cmd === "branches" || cmd === "chains") return cmdBranches(args);
  if (cmd === "chain") return cmdChain(args);
  if (cmd === "whoami") return cmdWhoami(args);
  if (cmd === "thread") {
    if (!args[0]) throw new CommandError("usage: mergestorm thread <slug>");
    return cmdThread(args[0], args.slice(1));
  }
  if (cmd === "stack") return cmdStack(args);
  if (cmd === "shell") return runShell();
  usage();
  throw new CommandError(`unknown command: ${cmd}`);
}

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;

  if (!cmd) {
    if (input.isTTY && output.isTTY) {
      await runShell();
      return;
    }
    usage();
    return;
  }

  if (cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }

  try {
    await runCommand(cmd, args);
  } catch (err) {
    if (err instanceof CommandError) {
      console.error(err.message);
      process.exitCode = err.exitCode;
      return;
    }
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(ansi.red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
