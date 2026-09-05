import { DEFAULT_API } from "../config.js";
import { CommandError } from "../errors.js";
import type { CommandSpec } from "../ui/prompt.js";
import { cmdBranches, cmdChain } from "./branches.js";
import { canBrowse, openTabsBrowser } from "./browse.js";
import { cmdCredits } from "./credits.js";
import { cmdJobs, cmdThread } from "./jobs.js";
import { cmdLogin } from "./login.js";
import { cmdLogout } from "./logout.js";
import { cmdQueue } from "./queue.js";
import { cmdPr } from "./pr.js";
import { cmdReview } from "./review.js";
import { cmdSettings } from "./settings.js";
import { cmdSkill } from "./skill.js";
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
      "mergestorm review [base] [head] Review git diff base...head",
      "  [--json] [--wait|--no-wait] [--timeout seconds]",
      "  [--router off|standard|max|manual] [--specialists id,id]",
      "  [--context text] [--context-file path] [--thread slug]",
      "  [--idempotency-key k] [--webhook-url https://…]",
      "  HTTP 429 exits 7 (rate_limited) with retry_after_seconds",
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
    name: "pr",
    summary: "Latest Vortex review for a GitHub PR",
    usage: [
      "mergestorm pr <owner/repo>#<n>  Fetch the latest Vortex PR review",
      "  [--json] [--wait] [--after-sha <sha>] [--timeout <s>]",
      "  Also accepts: mergestorm pr <owner/repo> <n>",
    ],
    async run(args, ctx) {
      await cmdPr(args, {
        defaultFormat: ctx.mode === "shell" ? "pretty" : "json",
        signal: ctx.signal,
        mode: ctx.mode,
      });
    },
  },
  {
    name: "status",
    summary: "Job panel (id) or Status / Usage / Jobs tabs",
    usage: [
      "mergestorm status <job_id>      Fetch a review job (same envelope as review --json)",
      "  [--json] [--wait] [--timeout seconds]",
      "  HTTP 429 exits 7 (rate_limited) with retry_after_seconds",
      "  With no job id on a TTY: tabbed Status / Usage / Jobs / Config browser",
    ],
    async run(args, ctx) {
      if (args.length === 0 && canBrowse()) {
        await openTabsBrowser("status");
        return;
      }
      if (ctx.mode === "shell") {
        await cmdStatus(args, {
          defaultFormat: "pretty",
          signal: ctx.signal,
          interactive: true,
          mode: "shell",
        });
        return;
      }
      await cmdStatus(args, { defaultFormat: "json" });
    },
  },
  {
    name: "credits",
    aliases: ["usage"],
    summary: "Usage: tabbed browser (TTY) or static panel",
    usage: [
      "mergestorm credits [--json]     Usage panel (bar + last 5 jobs)",
      "  On a TTY: tabbed Status / Usage / Jobs / Config browser (Usage selected)",
    ],
    async run(args) {
      await cmdCredits(args);
    },
  },
  {
    name: "jobs",
    summary: "Recent review jobs (default 10)",
    usage: ["mergestorm jobs [n] [--json]    Recent review jobs"],
    async run(args, ctx) {
      if (
        args.every((a) => a !== "--json") &&
        !args.some((a) => /^\d+$/.test(a)) &&
        canBrowse()
      ) {
        await openTabsBrowser("jobs");
        return;
      }
      await cmdJobs(args, { mode: ctx.mode });
    },
  },
  {
    name: "branches",
    aliases: ["chains"],
    summary: "Pick a recently reviewed branch",
    usage: ["mergestorm branches [n]         Recently reviewed branches (pick on TTY)"],
    async run(args, ctx) {
      await cmdBranches(args, { mode: ctx.mode });
    },
  },
  {
    name: "chain",
    summary: "Branch review-chain timeline (holds until q)",
    usage: [
      "mergestorm chain [slug]         Branch review-chain timeline (default: current)",
    ],
    async run(args, ctx) {
      await cmdChain(args, { mode: ctx.mode });
    },
  },
  {
    name: "whoami",
    summary: "Key + plan (Status tab on a TTY)",
    usage: ["mergestorm whoami [--json]      Key + plan + API base"],
    async run(args, ctx) {
      await cmdWhoami(args, { mode: ctx.mode });
    },
  },
  {
    name: "settings",
    summary: "Automation toggles (Config tab on a TTY)",
    usage: [
      "mergestorm settings [--json]    Read the automation toggles (Config tab on a TTY)",
      "  [--auto-review on|off] [--auto-patch on|off] [--vortex-thinking on|off]",
      "  [--repo-overview on|off] [--review-unit-land on|off]",
      "  [--cyclone-review-unit-land on|off] [--vortex-seam on|off]",
      "  [--auto-land on|off]            Auto land default for stacks opened after this",
      "  With flags: PATCH those settings and print the stored result",
    ],
    async run(args, ctx) {
      await cmdSettings(args, { mode: ctx.mode });
    },
  },
  {
    name: "skill",
    summary: "Install mergestorm-review and mergestorm-pr-loop for Claude or Cursor",
    usage: [
      "mergestorm skill install --claude|--cursor  Copy the mergestorm-review and mergestorm-pr-loop skills into this repo",
      "  [--json]",
    ],
    async run(args) {
      await cmdSkill(args);
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
      await cmdThread(args[0], args.slice(1), { mode: ctx.mode });
    },
  },
  {
    name: "queue",
    summary: "Merge queue: list, add a stack, or remove an entry",
    usage: [
      "mergestorm queue [list] [--json]  List live merge-queue entries",
      "mergestorm queue add <stack-id> [--json]  Queue a stack for verified landing",
      "mergestorm queue rm <entry-id|stack-id> [--json]  Remove a live queue entry",
    ],
    async run(args) {
      await cmdQueue(args);
    },
  },
  {
    name: "stack",
    summary: "Stacks: /stack how-to, list yours, create → submit",
    usage: [
      "mergestorm stack create [name]  New local layer ([--onto] [--trunk] [--extend] [--auto-land on|off] [--auto-review on|off] [--auto-patch on|off])",
      "mergestorm stack submit         Push/open active stack ([--extend] [--auto-land on|off] [--auto-review on|off] [--auto-patch on|off])",
      "mergestorm stack reset --force  Clear this repo's pre-submit authoring state",
      "mergestorm stack list [--json]  List registered stacks",
      "mergestorm stack set <stack-id> [--auto-land on|off] [--auto-review on|off|default] [--auto-patch on|off|default] [--json]  Per-stack policy",
      "mergestorm stack adopt <owner/repo>#<pr> [--auto-land on|off] [--auto-review on|off] [--auto-patch on|off]  Import an open PR chain",
      "mergestorm stack restack <stack-id>   Restack stack descendants",
      "mergestorm stack land <stack-id>      Land bottom PR (or promote into unit)",
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
  { name: "help", summary: "Tabbed help (Start / Commands / Stacks)" },
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

/** Autocomplete / `/help` list for the interactive shell. Aliases fold onto the primary name. */
export function shellCommandSpecs(): CommandSpec[] {
  const specs: CommandSpec[] = [
    { name: "help", summary: SHELL_META[0]!.summary },
    { name: "exit", summary: SHELL_META[2]!.summary, aliases: ["quit"] },
  ];
  for (const c of COMMAND_REGISTRY) {
    if (SHELL_OMIT.has(c.name)) continue;
    specs.push({
      name: c.name,
      summary: c.summary,
      ...(c.aliases?.length ? { aliases: c.aliases } : {}),
    });
  }
  specs.push({ name: "clear", summary: SHELL_META[1]!.summary });
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
