import { stdout as output } from "node:process";
import { loadConfig, resolveApiKey } from "./config.js";
import { CommandError, DetachedError } from "./errors.js";
import {
  dispatchCommand,
  shellCommandSpecs,
} from "./commands/registry.js";
import { ansi } from "./ui/ansi.js";
import { printBannerHeader, shellPrompt } from "./ui/banner.js";
import { CTRL_C_EXIT_HINT, CtrlCExitGate } from "./ui/ctrl-c-exit.js";
import { askLine, formatSlashLabel, PromptClosedError } from "./ui/prompt.js";

/** Shell autocomplete + `/help` — derived from the command registry (STRUCT-01). */
export const COMMANDS = shellCommandSpecs();

function printHelp(): void {
  const rows = COMMANDS.map((c) => {
    const label = formatSlashLabel(c).slice(1);
    return `  ${ansi.green("/" + label.padEnd(20))} ${c.summary}`;
  }).join("\n");
  console.log(`
  ${ansi.bold("Commands")}
${rows}

  Dashboard: https://mergestorm.ai/settings#api
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
        const ok = await dispatchCommand(cmd, args, {
          mode: "shell",
          signal: busyAbort.signal,
          afterAuth: async () => {
            try { await printBannerHeader(); } catch { /* banner is best-effort */ }
          },
        });
        if (!ok) {
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
