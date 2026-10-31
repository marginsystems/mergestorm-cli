#!/usr/bin/env node
import { stdin as input, stdout as output } from "node:process";
import { splitAccountFlag, withAccount } from "./config.js";
import { CommandError } from "./errors.js";
import {
  dispatchCommand,
  formatUsageBody,
} from "./commands/registry.js";
import {
  isSupportedNode,
  unsupportedNodeMessage,
} from "./node-version.js";
import { runShell } from "./shell.js";
import { ansi } from "./ui/ansi.js";
import { printWordmark } from "./ui/banner.js";
import { cliVersion } from "./version.js";

if (!isSupportedNode()) {
  console.error(unsupportedNodeMessage());
  process.exit(1);
}

function usage(): void {
  printWordmark();
  console.log(`Usage:
${formatUsageBody()}
`);
}

async function runCommand(cmd: string, args: string[], account: string | undefined): Promise<void> {
  if (cmd === "help" || cmd === "?") {
    usage();
    return;
  }
  const ok = await dispatchCommand(cmd, args, { mode: "oneshot", account });
  if (!ok) {
    usage();
    throw new CommandError(`unknown command: ${cmd}`);
  }
}

async function main(): Promise<void> {
  try {
    const { account, args: argv } = splitAccountFlag(process.argv.slice(2));
    const [cmd, ...args] = argv;

    if (!cmd) {
      if (input.isTTY && output.isTTY) {
        await withAccount(account, () => runShell());
        return;
      }
      usage();
      return;
    }

    if (cmd === "-h" || cmd === "--help" || cmd === "help" || cmd === "?") {
      usage();
      return;
    }

    if (cmd === "-v" || cmd === "--version" || cmd === "version") {
      console.log(cliVersion());
      return;
    }

    await runCommand(cmd, args, account);
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
