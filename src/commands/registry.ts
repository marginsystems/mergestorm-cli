import { DEFAULT_API } from "../config.js";
import { CommandError } from "../errors.js";
import type { CommandSpec } from "../ui/prompt.js";
import { cmdBranches, cmdChain } from "./branches.js";
import { cmdCredits } from "./credits.js";
import { cmdJobs, cmdThread } from "./jobs.js";
import { cmdLogin } from "./login.js";
import { cmdLogout } from "./logout.js";
import { cmdReview } from "./review.js";
import { cmdStack } from "./stack.js";
import { cmdStatus } from "./status.js";
import { cmdWhoami } from "./whoami.js";

/** Shared dispatch context for oneshot argv and the interactive shell. */
export type CommandContext = {
  mode: "oneshot" | "shell";
  signal?: AbortSignal;
  /** Shell: refresh banner after login/logout. */
  afterAuth?: () => Promise<void>;
};

export type RegistryCommand = {
  name: string;
  /** Alternate names that resolve to the same handler (also listed in shell autocomplete). */
  aliases?: string[];
  /** Short line for shell `/help` and autocomplete. */
  summary: string;
  /** Lines under oneshot `Usage:` (already prefixed with `mergestorm …`). */
  usage: string[];
  run: (args: string[], ctx: CommandContext) => Promise<void>;
};

/**
 * Single source of truth for CLI commands (STRUCT-01).
 * Derive oneshot usage, shell COMMANDS, and both dispatchers from this table.
 */
export const COMMAND_REGISTRY: RegistryCommand[] = [
  {
    name: "login",
    summary: "Sign in via browser (or paste a key)",
    usage: [
      "mergestorm login                Sign in via browser and store an API key",
      "mergestorm login --key          Paste an existing API key instead (headless/CI)",
    ],
    async run(args, ctx) {
      await cmdLogin(args);
      if (ctx.afterAuth) await ctx.afterAuth();
    },
  },
  {
    name: "logout",
    summary: "Remove the stored API key",
    usage: ["mergestorm logout               Remove the stored API key"],
    async run(_args, ctx) {
      await cmdLogout();
      if (ctx.afterAuth) await ctx.afterAuth();
    },
  },
  {
    name: "review",
    summary: "Review git diff (default origin/HEAD or main or master)",
    usage: [
      "mergestorm review [base] [head] Review git diff base...head (default: origin/HEAD or main or master)",
    ],
    async run(args, ctx) {
      if (ctx.mode === "shell") {
        await cmdReview(args, { signal: ctx.signal, interactive: true });
        return;
      }
      await cmdReview(args);
    },
  },
  {
    name: "status",
    summary: "Show a review job",
    usage: [
      "mergestorm status <job_id>      Fetch a review job and print JSON (one shot)",
    ],
    async run(args, ctx) {
      if (!args[0]) {
        throw new CommandError(
          ctx.mode === "shell"
            ? "usage: status <job_id>"
            : "usage: mergestorm status <job_id>",
        );
      }
      if (ctx.mode === "shell") {
        await cmdStatus(args[0], { format: "pretty", signal: ctx.signal });
        return;
      }
      await cmdStatus(args[0], { format: "json" });
    },
  },
  {
    name: "credits",
    aliases: ["usage"],
    summary: "Credit balance with usage bars",
    usage: ["mergestorm credits [--json]     Credit balance (usage bars)"],
    async run(args) {
      await cmdCredits(args);
    },
  },
  {
    name: "jobs",
    summary: "Recent review jobs (default 10)",
    usage: ["mergestorm jobs [n] [--json]    Recent review jobs"],
    async run(args) {
      await cmdJobs(args);
    },
  },
  {
    name: "branches",
    aliases: ["chains"],
    summary: "Pick a recently reviewed branch",
    usage: ["mergestorm branches [n]         Recently reviewed branches (pick on TTY)"],
    async run(args) {
      await cmdBranches(args);
    },
  },
  {
    name: "chain",
    summary: "Show a branch review-chain timeline",
    usage: [
      "mergestorm chain [slug]         Branch review-chain timeline (default: current)",
    ],
    async run(args) {
      await cmdChain(args);
    },
  },
  {
    name: "whoami",
    summary: "Key + plan + API base",
    usage: ["mergestorm whoami [--json]      Key + plan + API base"],
    async run(args) {
      await cmdWhoami(args);
    },
  },
  {
    name: "thread",
    summary: "Jobs in a review thread",
    usage: ["mergestorm thread <slug>        Jobs in a review thread"],
    async run(args, ctx) {
      if (!args[0]) {
        throw new CommandError(
          ctx.mode === "shell"
            ? "usage: thread <slug>"
            : "usage: mergestorm thread <slug>",
        );
      }
      await cmdThread(args[0], args.slice(1));
    },
  },
  {
    name: "stack",
    summary: "Stacks: create, submit, list, adopt, restack, land",
    usage: [
      "mergestorm stack create [name]  New local stack layer (CLI-managed authoring state)",
      "mergestorm stack submit         Push active local stack, open PRs, register stack",
      "mergestorm stack reset --force  Clear this repo's pre-submit authoring state",
      "mergestorm stack list [--json]  List registered stacks",
      "mergestorm stack adopt <owner/repo>#<pr>  Import an existing open PR chain",
      "mergestorm stack restack <stack-id>   Restack stack descendants",
      "mergestorm stack land <stack-id>      Land bottom PR (or promote into unit)",
      "mergestorm stack auto-promote on|off <stack-id>  Toggle auto-promote when green",
    ],
    async run(args) {
      await cmdStack(args);
    },
  },
  {
    name: "shell",
    summary: "Explicit shell entry",
    usage: ["mergestorm shell                Explicit shell entry"],
    /** Shell entry is oneshot-only; interactive shell does not list it. */
    async run() {
      const { runShell } = await import("../shell.js");
      await runShell();
    },
  },
];

/** Shell meta commands (not dispatched via {@link COMMAND_REGISTRY}). */
const SHELL_META: CommandSpec[] = [
  { name: "help", summary: "Show available commands" },
  { name: "clear", summary: "Clear screen and reprint banner" },
  { name: "exit", summary: "Leave the shell" },
  { name: "quit", summary: "Leave the shell" },
];

/** Commands omitted from shell autocomplete (oneshot-only entrypoints). */
const SHELL_OMIT = new Set(["shell"]);

export function findCommand(name: string): RegistryCommand | undefined {
  const key = name.toLowerCase();
  return COMMAND_REGISTRY.find(
    (c) => c.name === key || (c.aliases?.includes(key) ?? false),
  );
}

/** Autocomplete / `/help` list for the interactive shell. */
export function shellCommandSpecs(): CommandSpec[] {
  const specs: CommandSpec[] = [{ name: "help", summary: SHELL_META[0]!.summary }];
  for (const c of COMMAND_REGISTRY) {
    if (SHELL_OMIT.has(c.name)) continue;
    specs.push({ name: c.name, summary: c.summary });
    for (const alias of c.aliases ?? []) {
      specs.push({ name: alias, summary: c.summary });
    }
  }
  specs.push(
    { name: "clear", summary: SHELL_META[1]!.summary },
    { name: "exit", summary: SHELL_META[2]!.summary },
    { name: "quit", summary: SHELL_META[3]!.summary },
  );
  return specs;
}

export function formatUsageBody(): string {
  // Historical order: interactive entry → shell → version → registry (minus shell).
  const shellEntry = COMMAND_REGISTRY.find((c) => c.name === "shell");
  const others = COMMAND_REGISTRY.filter((c) => c.name !== "shell");
  const cmdLines = [
    "mergestorm                      Interactive shell (TTY)",
    ...(shellEntry?.usage ?? []),
    "mergestorm -v, --version        Print CLI version",
    ...others.flatMap((c) => c.usage),
  ]
    .map((line) => `  ${line}`)
    .join("\n");
  return `${cmdLines}

  mg is a short alias for mergestorm (same binary).

Env:
  MERGESTORM_API_KEY   API key (overrides config)
  MERGESTORM_API_URL   API base (default ${DEFAULT_API})
`;
}

/**
 * Run a registered command. Returns false when `name` is unknown
 * (caller prints usage / shell hint).
 */
export async function dispatchCommand(
  name: string,
  args: string[],
  ctx: CommandContext,
): Promise<boolean> {
  const cmd = findCommand(name);
  if (!cmd) return false;
  // `shell` as a subcommand is oneshot-only.
  if (cmd.name === "shell" && ctx.mode === "shell") return false;
  await cmd.run(args, ctx);
  return true;
}
