import { ansi } from "./ansi.js";

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
 * - `limit === 0` → dim "not included" (premium on non-Maelstrom)
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

  let fillColor = ansi.green;
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

/** Alias kept for callers that still import `formatResetDate`. */
export function formatResetDate(iso: string | null | undefined): string {
  return formatResetLabel(iso);
}
