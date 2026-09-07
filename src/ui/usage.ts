import { ansi } from "./ansi.js";
import { frameWidth } from "./box.js";
import { padVisible, visibleWidth } from "./width.js";

export type UsageBarOpts = {
  /** Bar width in cells (default 56). */
  width?: number;
  /** When false, return plain text with no ANSI (default: respect ansi.enabled). */
  color?: boolean;
};

/**
 * Usage meter — long thin bar + percent only:
 *   `[████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 7% used`
 *
 * No used/limit clutter. Edge cases:
 * - `limit === 0` → dim "not included"
 * - `limit == null` → "unlimited" (dev-bypass)
 */
export function usageBar(
  used: number,
  limit: number | null | undefined,
  opts: UsageBarOpts = {},
): string {
  const width = Math.max(8, opts.width ?? 56);
  const color = opts.color ?? ansi.enabled;

  if (limit == null) {
    return color ? ansi.dim("unlimited") : "unlimited";
  }
  if (limit === 0) {
    return color ? ansi.dim("not included") : "not included";
  }

  const safeUsed = Math.max(0, Number.isFinite(used) ? used : 0);
  const ratio = Math.min(1, safeUsed / limit);
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);
  const pct = Math.min(100, Math.round((safeUsed / limit) * 100));

  // Filled segment colored; empty + label stay dim.
  const filledSeg = "█".repeat(filled);
  const emptySeg = "░".repeat(empty);
  const suffix = ` ${pct}% used`;

  if (!color) {
    return `[${filledSeg}${emptySeg}]${suffix}`;
  }

  let fillColor = ansi.brightGreen;
  if (ratio >= 0.9) fillColor = ansi.red;
  else if (ratio >= 0.75) fillColor = ansi.yellow;

  return (
    `[${fillColor(filledSeg)}${ansi.dim(emptySeg)}]` + ansi.dim(suffix)
  );
}

/** Start of the next UTC calendar month (matches API `resets_at`). */
export function nextUtcMonthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * Reset footer: `Resets Aug 1, 12:00am (UTC)`.
 * Falls back to next UTC month start when `iso` is missing/invalid.
 */
export function formatResetLabel(iso: string | null | undefined, now = new Date()): string {
  const d = iso ? new Date(iso) : new Date(nextUtcMonthStart(now));
  const when = Number.isNaN(d.getTime()) ? new Date(nextUtcMonthStart(now)) : d;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const month = months[when.getUTCMonth()]!;
  const day = when.getUTCDate();
  let h = when.getUTCHours();
  const m = when.getUTCMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  const mm = String(m).padStart(2, "0");
  return `Resets ${month} ${day}, ${h}:${mm}${ampm} (UTC)`;
}

/** How long until `iso` (the API `resets_at`). Empty when the date is unusable. */
export function formatDaysLeft(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const ms = d.getTime() - now.getTime();
  if (ms <= 0) return "reset due";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days >= 2) return `${days} days left`;
  if (days === 1) return "1 day left";
  if (hours >= 1) return `${hours}h left`;
  return "resets soon";
}

/** Bar cells so `  [bar] 100% used` stays inside the terminal. */
export function usageBarWidth(columns: number): number {
  return Math.max(8, frameWidth(80, columns) - 13);
}

export type UsagePanelJob = {
  job: string;
  verdict: string;
  thread: string;
  credits: string;
  when: string;
};

export type UsagePanelInput = {
  keyPrefix: string;
  plan: string;
  used: number;
  limit: number | null;
  bonusRemaining?: number;
  resetsAt: string | null | undefined;
  jobs: UsagePanelJob[];
  /** When the jobs fetch failed, show this instead of "No review jobs yet." */
  jobsError?: string;
  columns: number;
  color?: boolean;
};

function clipLine(line: string, columns: number): string {
  if (visibleWidth(line) <= columns) return line;
  return padVisible(line, columns);
}

/**
 * Static `/usage` panel: identity, a bar sized from `frameWidth()`, reset
 * line, then the last five jobs. Every row is clipped to `columns`.
 */
export function formatUsagePanel(input: UsagePanelInput): string[] {
  const columns = Math.max(20, input.columns);
  const color = input.color ?? false;
  const identity = `● ${input.keyPrefix} · ${input.plan}`;
  const bar = usageBar(input.used, input.limit, {
    width: usageBarWidth(columns),
    color,
  });
  const lines = [
    `  ${identity}`,
    `  ${bar}`,
    `  ${formatResetLabel(input.resetsAt)}`,
    ...(input.bonusRemaining == null
      ? []
      : [`  Bonus credits: ${input.bonusRemaining} remaining`]),
    "",
  ];

  if (input.jobs.length === 0) {
    lines.push(input.jobsError ? `  ${input.jobsError}` : "  No review jobs yet.");
    return lines.map((line) => clipLine(line, columns));
  }

  const inner = Math.max(20, columns - 2);
  const jobW = 8;
  const verdictW = 15;
  const creditsW = 7;
  const whenW = 8;
  const gaps = 8;
  const threadW = Math.max(6, inner - jobW - verdictW - creditsW - whenW - gaps);
  const header = ["JOB", "VERDICT", "THREAD", "CREDITS", "WHEN"];
  const widths = [jobW, verdictW, threadW, creditsW, whenW];
  const fmt = (cols: string[]) =>
    "  " + cols.map((c, i) => padVisible(c, widths[i]!)).join("  ");
  lines.push(fmt(header));
  for (const job of input.jobs.slice(0, 5)) {
    lines.push(
      fmt([job.job, job.verdict, job.thread, job.credits, job.when]),
    );
  }
  return lines.map((line) => clipLine(line, columns));
}
