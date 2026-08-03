import { stdout as output } from "node:process";
import { loadConfig, resolveApiKey } from "./config.js";
import { CommandError, DetachedError } from "./errors.js";
import { cmdBranches, cmdChain } from "./commands/branches.js";
import { cmdCredits } from "./commands/credits.js";
import { cmdJobs, cmdThread } from "./commands/jobs.js";
import { cmdLogin } from "./commands/login.js";
import { cmdLogout } from "./commands/logout.js";
import { cmdReview } from "./commands/review.js";
import { cmdStack } from "./commands/stack.js";
import { cmdStatus } from "./commands/status.js";
import { cmdWhoami } from "./commands/whoami.js";
import { ansi } from "./ui/ansi.js";
import { printBannerHeader, shellPrompt } from "./ui/banner.js";
import { CTRL_C_EXIT_HINT, CtrlCExitGate } from "./ui/ctrl-c-exit.js";
import { askLine, PromptClosedError, type CommandSpec } from "./ui/prompt.js";

export const COMMANDS: CommandSpec[] = [
  { name: "help", summary: "Show available commands" },
  { name: "login", summary: "Sign in via browser (or paste a key)" },
  { name: "logout", summary: "Remove the stored API key" },
  { name: "review", summary: "Review git diff (default main...HEAD)" },
  { name: "status", summary: "Show a review job" },
  { name: "credits", summary: "Credit balance with usage bars" },
  { name: "usage", summary: "Credit balance with usage bars" },
  { name: "jobs", summary: "Recent review jobs (default 10)" },
  { name: "branches", summary: "Pick a recently reviewed branch" },
  { name: "chains", summary: "Alias for branches" },
  { name: "chain", summary: "Show a branch review-chain timeline" },
  { name: "whoami", summary: "Key + plan + API base" },
  { name: "thread", summary: "Jobs in a review thread" },
  { name: "stack", summary: "Stacks: create, submit, list, adopt, restack, land" },
  { name: "clear", summary: "Clear screen and reprint banner" },
  { name: "exit", summary: "Leave the shell" },
  { name: "quit", summary: "Leave the shell" },
];

function printHelp(): void {
  const rows = COMMANDS.map((c) => `  ${ansi.green("/" + c.name.padEnd(10))} ${c.summary}`).join(
    "\n",
  );
  console.log(`
  ${ansi.bold("Commands")}
${rows}

  Dashboard: https://mergestorm.ai/dashboard/api
`);
}

/** Strips an optional leading "/" so both "review" and "/review" work. */
export function parseLine(line: string): { cmd: string; args: string[] } | null {
  let trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) trimmed = trimmed.slice(1).trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  return { cmd, args: parts.slice(1) };
}

export async function runShell(): Promise<void> {
  try { await printBannerHeader(); } catch { /* banner is best-effort */ }

  const history: string[] = [];

  let busyAbort: AbortController | null = null;
  const idleCtrlC = new CtrlCExitGate();
  let exiting = false;

  const onSigint = () => {
    // Busy commands: first Ctrl+C aborts/detaches only -- never exit the shell.
    // Exit confirm is for the idle prompt (see askLine); do not arm idleCtrlC here.
    if (busyAbort) {
      busyAbort.abort();
      return;
    }
    // Rare path: SIGINT outside raw-mode prompt (e.g. between turns).
    // Idle TTY Ctrl+C is handled in askLine as a keypress.
    if (idleCtrlC.press()) {
      output.write("\n");
      exiting = true;
      return;
    }
    output.write(`\n${ansi.dim(CTRL_C_EXIT_HINT)}\n`);
  };
  process.on("SIGINT", onSigint);

  try {
    while (true) {
      const cfg = await loadConfig();
      const loggedIn = Boolean(resolveApiKey(cfg));
      if (exiting) break;
      let line: string;
      try {
        line = await askLine({
          prompt: shellPrompt(loggedIn),
          history,
          commands: COMMANDS,
        });
      } catch (err) {
        if (err instanceof PromptClosedError) {
          console.log("");
          break;
        }
        throw err;
      }
      idleCtrlC.reset();

      const parsed = parseLine(line);
      if (!parsed) continue;
      if (line.trim()) history.push(line);
      const { cmd, args } = parsed;

      if (cmd === "exit" || cmd === "quit") break;
      if (cmd === "help" || cmd === "?") {
        printHelp();
        continue;
      }
      if (cmd === "clear") {
        output.write("[2J[H");
        try { await printBannerHeader(); } catch { /* banner is best-effort */ }
        continue;
      }

      busyAbort = new AbortController();
      try {
        if (cmd === "login") {
          await cmdLogin(args);
          await printBannerHeader();
        } else if (cmd === "logout") {
          await cmdLogout();
          await printBannerHeader();
        } else if (cmd === "review") {
          await cmdReview(args, { signal: busyAbort.signal, interactive: true });
        } else if (cmd === "status") {
          if (!args[0]) {
            throw new CommandError('usage: status <job_id>');
          }
          await cmdStatus(args[0], { format: "pretty", signal: busyAbort.signal });
        } else if (cmd === "credits" || cmd === "usage") {
          await cmdCredits(args);
        } else if (cmd === "jobs") {
          await cmdJobs(args);
        } else if (cmd === "branches" || cmd === "chains") {
          await cmdBranches(args);
        } else if (cmd === "chain") {
          await cmdChain(args);
        } else if (cmd === "whoami") {
          await cmdWhoami(args);
        } else if (cmd === "thread") {
          if (!args[0]) {
            throw new CommandError("usage: thread <slug>");
          }
          await cmdThread(args[0], args.slice(1));
        } else if (cmd === "stack") {
          await cmdStack(args);
        } else {
          console.error(ansi.dim(`unknown command "${cmd}" -- type help`));
        }
      } catch (err) {
        if (err instanceof DetachedError) {
          console.log(`\n${ansi.yellow(err.message)}`);
        } else if (err instanceof CommandError) {
          console.error(ansi.red(err.message));
        } else if (err instanceof Error && err.name === "AbortError") {
          console.log(ansi.dim("\naborted"));
        } else {
          console.error(ansi.red(err instanceof Error ? err.message : String(err)));
        }
      } finally {
        busyAbort = null;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}
