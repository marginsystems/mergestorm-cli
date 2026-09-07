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
  terminalColumns,
  visibleWidth,
} from "./box.js";
import { STORM_MARK, STORM_MARK_WIDTH } from "./logo.js";
import { formatResetLabel, usageBar } from "./usage.js";

const WORDMARK = `
 __  __ ___ ___  ___ ___ ___ _____ ___  ___ __  __
|  \\/  | __| _ \\/ __| __/ __|_   _/ _ \\| _ \\  \\/  |
| |\\/| | _||   / (_ | _|\\__ \\ | || (_) |   / |\\/| |
|_|  |_|___|_|_\\\\___|___|___/ |_| \\___/|_|_\\_|  |_|
`.trimEnd();

/** Used by the non-interactive `usage()` path in cli.ts — the boxed banner is shell-only. */
export function printWordmark(): void {
  console.log(ansi.boldBrightGreen(WORDMARK));
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
  "0.3.14": [
    "Status / Usage / Jobs tabs (open with usage)",
    "resize-safe home screen",
  ],
  "0.3.15": [
    "mg pr --wait --after-sha, mg settings, mergestorm-pr-loop skill on npm",
    "mg skill install copies review + pr-loop from the packed tarball",
  ],
  "0.3.16": [
    "PR loop: verify each finding, prefer a small diff, post mergestorm-loop: dismiss on skip",
  ],
  "0.3.17": [
    "nginx 413 names the upload limit instead of Failed: {}",
  ],
};

/** Everything the welcome panel needs, captured once so redraws stay sync. */
export type BannerState = {
  version: string;
  me: MeResponse | null;
  key: string | undefined;
  keyInvalid: boolean;
};

/** Full welcome, mid pane, or Claude-style short chrome that still shows the mark. */
export type BannerDensity = "full" | "compact" | "mini" | "nano";

/** `true` = compact. Strings pick the short-pane densities. */
export type BannerVariant = boolean | "mini" | "nano";

/** Handle returned by {@link printBannerHeader}; `rows` reflows for a resize. */
export type BannerHandle = {
  rows(columns?: number, variant?: BannerVariant): string[];
};

function densityFromVariant(variant?: BannerVariant): BannerDensity {
  if (variant === "mini" || variant === "nano") return variant;
  return variant ? "compact" : "full";
}

/** Home usage bars stay compact (Claude-style), not full-bleed. */
const BANNER_BAR_MAX = 30;
/** `[` + `]` + ` 100% used` around the bar cells. */
const BAR_CHROME_CELLS = 12;

function statusLine(state: BannerState): string {
  if (!state.key) {
    return `${ansi.dim("○")} not logged in · type ${ansi.brightGreen("login")} to sign in`;
  }
  if (state.keyInvalid) {
    return `${ansi.dim("○")} API key invalid or revoked · type ${ansi.brightGreen("login")} to sign in again`;
  }
  const display = state.me?.key.prefix ?? keyDisplay(state.key) ?? "msk_live_…";
  if (!state.me) {
    return `${ansi.brightGreen("●")} ${ansi.bold(display)} ${ansi.dim("· account details unavailable")}`;
  }
  const plan = state.me.plan_label_key ?? state.me.plan_key;
  return `${ansi.brightGreen("●")} ${ansi.bold(display)} · ${plan}`;
}

function usageLine(me: MeResponse, contentCells: number, indent: number): string {
  const room = Math.max(8, contentCells - indent - BAR_CHROME_CELLS);
  const bar = usageBar(me.usage.standard.used, me.usage.standard.limit, {
    width: Math.min(BANNER_BAR_MAX, room),
  });
  const reset = ansi.dim(`· ${formatResetLabel(me.resets_at)}`);
  const combined = `${bar} ${reset}`;
  return visibleWidth(combined) <= contentCells - indent ? combined : bar;
}

/** First candidate that fits. Never mid-word clip — omit if nothing fits. */
function firstFit(options: string[], cells: number): string | null {
  for (const opt of options) {
    if (visibleWidth(opt) <= cells) return opt;
  }
  return null;
}

function tipsLine(cells: number): string | null {
  const sep = ansi.dim(" · ");
  return firstFit(
    [
      [
        `${ansi.brightGreen("review")} ${ansi.dim("a diff")}`,
        `${ansi.brightGreen("usage")} ${ansi.dim("for tabs")}`,
        `${ansi.brightGreen("/help")} ${ansi.dim("for all commands")}`,
      ].join(sep),
      [ansi.brightGreen("review"), ansi.brightGreen("usage"), ansi.brightGreen("/help")].join(sep),
      [ansi.brightGreen("review"), ansi.brightGreen("/help")].join(sep),
    ],
    cells,
  );
}

function tagline(cells: number): string | null {
  return firstFit(
    [
      ansi.dim("local reviews + stacked PRs · mergestorm.ai"),
      ansi.dim("reviews + stacked PRs"),
      ansi.dim("reviews · stacks"),
    ],
    cells,
  );
}

/** Shorten until it fits. Never clip mid-word (that was "…Jobs tabs (open with usa"). */
function whatsNewLine(version: string, cells: number): string | null {
  const entries = WHATS_NEW[version];
  if (!entries || !entries.length) return null;
  const first = entries[0]!;
  const noParen = first.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const candidates = [
    `New in v${version}: ${first}`,
    `New in v${version}: ${noParen}`,
    `New: ${noParen}`,
    `New in v${version}`,
  ];
  const extra = entries.slice(1);
  const withExtra = `${candidates[0]} · ${extra.join(" · ")}`;
  const options = extra.length > 0 ? [withExtra, ...candidates] : candidates;
  const hit = firstFit(options, cells);
  return hit ? ansi.dim(hit) : null;
}

/**
 * The whole welcome panel as rows, reflowed to `columns`. Every row fits in
 * `columns - 1` cells so a redraw's cursor math stays honest; below
 * MIN_BOXED_COLUMNS the frame drops away instead of wrapping.
 */
export function buildBannerRows(
  state: BannerState,
  columns?: number,
  opts?: { compact?: boolean; density?: BannerDensity },
): string[] {
  const boxed = preferBoxedUi(columns);
  const density = opts?.density ?? (opts?.compact ? "compact" : "full");
  const outer = frameWidth(80, columns);
  const contentCells = boxed
    ? Math.max(20, outer - 4)
    : Math.max(20, terminalColumns(80, columns) - 1);
  const indent = STORM_MARK_WIDTH + 2;
  const pad = " ".repeat(indent);

  const clip = (line: string): string =>
    visibleWidth(line) > contentCells ? padVisible(line, contentCells) : line;

  const mark = (row: number): string =>
    padVisible(ansi.brightGreen(STORM_MARK[row] ?? ""), indent);

  const title = `${ansi.boldBrightGreen("mergestorm")} ${ansi.dim(`v${state.version}`)}`;

  if (density === "nano") {
    const one = `${mark(0)}${title}  ${statusLine(state)}`;
    return [clip(one)];
  }

  if (density === "mini") {
    // Short pane: mark + who you are, then the same cues as the full home.
    const line0 = clip(`${mark(0)}${title}  ${statusLine(state)}`);
    const line1 =
      state.me && !state.keyInvalid
        ? clip(`${mark(1)}${usageLine(state.me, contentCells, indent)}`)
        : clip(mark(1));
    const room = contentCells - indent;
    const blurb = tagline(room);
    const tips = tipsLine(room);
    const fresh = whatsNewLine(state.version, room);
    return [
      line0,
      line1,
      ...(blurb ? [clip(`${pad}${blurb}`)] : []),
      ...(tips ? [clip(`${pad}${tips}`)] : []),
      ...(fresh ? [clip(`${pad}${fresh}`)] : []),
    ];
  }

  const content: string[] = [
    clip(`${pad}${title}`),
    clip(`${mark(0)}${statusLine(state)}`),
  ];
  if (state.me && !state.keyInvalid) {
    content.push(clip(`${mark(1)}${usageLine(state.me, contentCells, indent)}`));
  } else {
    content.push(clip(mark(1)));
  }

  const room = contentCells - indent;
  const blurb = tagline(room);
  const tips = tipsLine(room);
  const fresh = whatsNewLine(state.version, room);
  if (blurb) content.push(clip(`${pad}${blurb}`));
  if (tips) content.push(clip(`${pad}${tips}`));
  if (fresh) content.push(clip(`${pad}${fresh}`));

  if (boxed && density === "full") {
    content.splice(3, 0, "");
    return [...roundedBox(content, { width: outer, padding: 1 })];
  }

  if (boxed) {
    return [...roundedBox(content, { width: outer, padding: 1 })];
  }
  return content.map(clip);
}

/**
 * Print the welcome panel and return a handle whose `rows()` reflows the
 * same data for a new width (used by the prompt's resize redraw).
 */
export async function printBannerHeader(opts?: {
  /** When false, only build the handle; the prompt paints the rows. */
  paint?: boolean;
}): Promise<BannerHandle> {
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

  const state: BannerState = { version: cliVersion(), me, key, keyInvalid };
  if (opts?.paint !== false) {
    for (const line of buildBannerRows(state)) {
      console.log(line);
    }
  }
  return {
    rows: (columns?: number, variant?: BannerVariant) =>
      buildBannerRows(state, columns, { density: densityFromVariant(variant) }),
  };
}

export function shellPrompt(_loggedIn: boolean): string {
  // Bright mark green. Never dim, never 32, never the word "mergestorm".
  return ansi.boldBrightGreen("mg");
}
