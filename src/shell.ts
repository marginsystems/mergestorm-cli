import { stdout as output } from "node:process";
import { loadConfig, resolveApiKey } from "./config.js";
import { CommandError, DetachedError } from "./errors.js";
import {
  dispatchCommand,
  shellCommandSpecs,
} from "./commands/registry.js";
import { ansi } from "./ui/ansi.js";
import { printBannerHeader, shellPrompt, type BannerHandle } from "./ui/banner.js";
import { CTRL_C_EXIT_HINT, CtrlCExitGate } from "./ui/ctrl-c-exit.js";
import { openHelpBrowser } from "./commands/help.js";
import { showLinePanel } from "./ui/line-tabs.js";
import { askLine, PromptClosedError } from "./ui/prompt.js";

async function showShellNotice(title: string, message: string): Promise<void> {
  const lines = message.split("\n").flatMap((line) => (line ? [`  ${line}`] : [""]));
  await showLinePanel(title, [...lines, "", `  ${ansi.dim("q to return")}`]);
}

/** Shell autocomplete + `/help` ù derived from the command registry (STRUCT-01). */
export const COMMANDS = shellCommandSpecs();

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
  // Idle is always the home screen: header + docked prompt. Command TUIs
  // (usage / credits / status) and printed output become scrollback when
  // the next askLine homes + ED 0. Do not retire the header after the
  // first command ù that is what floated a bare prompt at the top.
  let banner: BannerHandle | null = null;
  const showBanner = async (): Promise<BannerHandle | null> => {
    try {
      banner = await printBannerHeader({ paint: false });
    } catch {
      // Keep the previous chrome on a transient refresh failure rather than
      // blanking the always-on home header.
    }
    return banner;
  };
  banner = await showBanner();

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
          ...(banner
            ? {
                header: (columns?: number, variant?: boolean | "mini" | "nano") =>
                  banner!.rows(columns, variant),
              }
            : {}),
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
        await openHelpBrowser();
        continue;
      }
      if (cmd === "clear") {
        output.write("[2J[H");
        await showBanner();
        continue;
      }

      busyAbort = new AbortController();
      try {
        const ok = await dispatchCommand(cmd, args, {
          mode: "shell",
          signal: busyAbort.signal,
          afterAuth: async () => {
            await showBanner();
          },
        });
        if (!ok) {
          await showShellNotice("Error", `unknown command "${cmd}"\ntype help for the list`);
        }
      } catch (err) {
        if (err instanceof DetachedError) {
          await showShellNotice("Detached", err.message);
        } else if (err instanceof CommandError) {
          await showShellNotice("Error", err.message);
        } else if (err instanceof Error && err.name === "AbortError") {
          await showShellNotice("Aborted", "aborted");
        } else {
          await showShellNotice(
            "Error",
            err instanceof Error ? err.message : String(err),
          );
        }
      } finally {
        busyAbort = null;
      }
      // Re-capture the home header so usage/credits shown above the prompt
      // reflect what the command just consumed (e.g. review spending a credit).
      await showBanner();
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}
