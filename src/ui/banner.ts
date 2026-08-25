import { getMe, type MeResponse } from "../api.js";
import { CommandError } from "../errors.js";
import { keyDisplay, loadConfig, resolveApiKey } from "../config.js";
import { cliVersion } from "../version.js";
import { ansi } from "./ansi.js";
import {
  frameWidth,
  padVisible,
  preferBoxedUi,
  roundedBox,
  sideBySide,
  visibleWidth,
} from "./box.js";
import { TORNADO_LOGO } from "./logo.js";
import { usageBar } from "./usage.js";

const WORDMARK = `
 __  __ ___ ___  ___ ___ ___ _____ ___  ___ __  __
|  \\/  | __| _ \\/ __| __/ __|_   _/ _ \\| _ \\  \\/  |
| |\\/| | _||   / (_ | _|\\__ \\ | || (_) |   / |\\/| |
|_|  |_|___|_|_\\\\___|___|___/ |_| \\___/|_|_\\_|  |_|
`.trimEnd();

/** Used by the non-interactive `usage()` path in cli.ts — the boxed banner is shell-only. */
export function printWordmark(): void {
  console.log(ansi.boldGreen(WORDMARK));
  console.log(
    ansi.dim(`  review local diffs fast · mergestorm.ai · v${cliVersion()}`),
  );
  console.log("");
}

// Keyed by CLI version so the banner surfaces exactly what shipped in that release.
const WHATS_NEW: Record<string, string[]> = {
  "0.2.0": [
    "Boxed welcome banner with a fresh look",
    "Live `/` slash-command autocomplete in the shell",
  ],
  "0.3.0": [
    "Usage meter (N% used) + credit reset time",
    "`branches` / `chain` — explore branch review timelines",
  ],
  "0.3.1": [
    "Full-width welcome panel + input (matches terminal columns)",
    "Two-column layout: status left, tips/what's new right",
    "Ctrl+C twice at the prompt to exit",
  ],
  "0.3.2": [
    "`mg` short alias — same binary as `mergestorm`",
  ],
  "0.3.3": [
    "`stack list` / `adopt` / `restack` / `land` / `auto-promote`",
  ],
  "0.3.4": [
    "`stack create` / `submit` — author stacks with `mg` (not Graphite)",
    "Adopt is import-only; happy path is create → submit → restack → land",
  ],
  "0.3.5": [
    "`stack submit` fills PR body from the tip commit (keeps Fixes/Closes)",
    "Unit-stack `stack land` promotes (matches server gates)",
  ],
  "0.3.6": [
    "Stack state under ~/.mergestorm/stacks/ (multi-stack + legacy migrate)",
    "`stack reset --force` clears stale local authoring state",
  ],
  "0.3.7": [
    "MIT license + public source at github.com/marginsystems/mergestorm-cli",
    "npm repository/bugs point at the public CLI repo",
  ],
  "0.3.8": [
    "Command registry + CommandError.code (no message-regex control flow)",
    "cmdStackSubmit unit-tested; shared findings renderer; origin parse in git.ts",
    "Review poll retries + status <job_id> recovery; empty-submit / narrow-TTY fixes",
    "login --key muted + validated; API timeouts; Node 22 hard-fail; --version",
  ],
  "0.3.9": [
    "Public source repo open (github.com/marginsystems/mergestorm-cli)",
    "npm description points at MIT build-from-source URL",
    "Dashboard links → Settings → API / Work (product URL cleanup)",
  ],
  "0.3.10": [
    "README: verify public git SHA + npm integrity (build from mergestorm-cli)",
  ],
  "0.3.12": [
    "review --router off|standard|max|manual (same smart router as Agents)",
    "review --specialists security,frontend,… to pin or invoke lanes",
  ],
};

function formatStatusLines(
  me: MeResponse | null,
  key: string | undefined,
  barWidth: number,
  keyInvalid = false,
): string[] {
  if (!key) {
    return [
      `${ansi.dim("○")} not logged in — type ${ansi.green("login")} to sign in`,
      `  or ${ansi.green("login --key")} to paste an API key`,
    ];
  }
  if (keyInvalid) {
    return [
      `${ansi.dim("○")} API key invalid or revoked — type ${ansi.green("login")} to sign in again`,
    ];
  }
  const display = me?.key.prefix ?? keyDisplay(key) ?? "msk_live_…";
  if (!me) {
    return [`${ansi.green("●")} logged in (${ansi.bold(display)})`];
  }
  const plan = me.plan_label_key ?? me.plan_key;
  const s = me.usage.standard;
  return [
    `${ansi.green("●")} ${ansi.bold(display)}  ·  ${plan}`,
    usageBar(s.used, s.limit, { width: barWidth }),
  ];
}

function tipsLines(): string[] {
  return [
    ansi.dim("Tips for getting started"),
    `  ${ansi.green("review")}      review origin/HEAD or main`,
    `  ${ansi.green("stack")}       create → submit → restack → land`,
    `  ${ansi.green("/help")}       list all commands`,
  ];
}

function whatsNewLines(version: string): string[] {
  const entries = WHATS_NEW[version];
  if (!entries || !entries.length) return [];
  return [
    ansi.dim(`What's new in v${version}`),
    ...entries.map((entry) => `  ${ansi.green("•")} ${entry}`),
  ];
}

function centerLine(line: string, width: number): string {
  const room = Math.max(0, width - visibleWidth(line));
  const left = Math.floor(room / 2);
  return `${" ".repeat(left)}${line}${" ".repeat(room - left)}`;
}

export async function printBannerHeader(): Promise<void> {
  const cfg = await loadConfig();
  const key = resolveApiKey(cfg);
  let me: MeResponse | null = null;
  let keyInvalid = false;
  if (key) {
    try {
      // Short probe so a hung API cannot stall shell startup for the full request budget.
      me = await getMe(cfg, { timeoutMs: 8_000 });
    } catch (err) {
      if (err instanceof CommandError) {
        keyInvalid = true;
      } else {
        throw err;
      }
    }
  }

  const version = cliVersion();
  const outer = frameWidth();
  // Inner content width inside the box (borders + padding).
  const inner = Math.max(40, outer - 4);

  // Two columns: left = logo + status, right = tips + what's new.
  const leftColW = Math.max(28, Math.floor(inner * 0.42));
  const rightColW = Math.max(24, inner - leftColW - 2);
  const barWidth = Math.max(12, leftColW - 4);

  const logoLines = TORNADO_LOGO.map((line) =>
    centerLine(ansi.brightGreen(line), leftColW),
  );
  const leftCol = [
    ...logoLines,
    "",
    ...formatStatusLines(me, key, barWidth, keyInvalid),
  ];

  const rightCol = [
    ...tipsLines(),
    "",
    ...whatsNewLines(version),
  ];

  // Clip right column lines that overflow the right pane.
  const rightClipped = rightCol.map((line) =>
    visibleWidth(line) <= rightColW ? line : padVisible(line, rightColW),
  );

  const rows = sideBySide(leftCol, rightClipped, leftColW, 2);
  if (!preferBoxedUi()) {
    // Narrow panes — plain lines beat wrapped box frames.
    console.log(ansi.boldGreen(`mergestorm v${version}`));
    for (const line of rows) console.log(line);
    console.log("");
    return;
  }
  const panel = roundedBox(rows, {
    title: `mergestorm v${version}`,
    width: outer,
    padding: 1,
  });
  for (const line of panel) {
    console.log(line);
  }
  console.log("");
}

export function shellPrompt(loggedIn: boolean): string {
  return loggedIn ? ansi.boldGreen("mergestorm") : ansi.dim("mergestorm");
}
