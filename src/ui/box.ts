import { stdout } from "node:process";
import { ansi } from "./ansi.js";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export function visibleWidth(str: string): number {
  return str.replace(ANSI_PATTERN, "").length;
}

/** Below this width, boxed chrome wraps on real TTYs — prefer plain output. */
export const MIN_BOXED_COLUMNS = 48;

/** Usable terminal columns (TTY), with a sensible fallback for pipes/tests. */
export function terminalColumns(fallback = 80): number {
  const cols = stdout.columns;
  if (typeof cols === "number" && Number.isFinite(cols) && cols >= 1) {
    return cols;
  }
  return fallback;
}

/**
 * Whether rounded/full-bleed boxes fit without wrapping.
 * Non-TTY (unknown columns) keeps boxes for tests and CI logs.
 */
export function preferBoxedUi(): boolean {
  const cols = stdout.columns;
  if (typeof cols !== "number" || !Number.isFinite(cols)) return true;
  return cols >= MIN_BOXED_COLUMNS;
}

/**
 * Outer box width for Claude-style full-bleed frames.
 * Never wider than the terminal (minus 1 so the right border doesn't wrap).
 */
export function frameWidth(fallback = 80): number {
  return Math.max(20, terminalColumns(fallback) - 1);
}

export interface RoundedBoxOptions {
  title?: string;
  padding?: number;
  /**
   * Exact outer width (including borders). When set, content is padded to fill.
   * Prefer this for full-width Claude-style frames.
   */
  width?: number;
  /** Grow to at least this outer width (content may still be wider). */
  minWidth?: number;
}

interface BoxChars {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

const ROUNDED: BoxChars = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };
const ASCII: BoxChars = { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };

function boxChars(): BoxChars {
  return !ansi.enabled || process.env.TERM === "dumb" ? ASCII : ROUNDED;
}

function centerLabel(label: string, width: number, fill: string): string {
  const room = Math.max(0, width - visibleWidth(label));
  const left = Math.floor(room / 2);
  const right = room - left;
  return `${fill.repeat(left)}${label}${fill.repeat(right)}`;
}

/**
 * Frames `lines` in a box. By default sized to content; pass `width` /
 * `minWidth` to stretch to the terminal like Claude Code.
 */
export function roundedBox(lines: string[], opts: RoundedBoxOptions = {}): string[] {
  const padding = Math.max(0, opts.padding ?? 1);
  const chars = boxChars();
  const title = opts.title ? ` ${opts.title} ` : "";
  const contentInner =
    Math.max(0, ...lines.map(visibleWidth), visibleWidth(title)) + padding * 2;

  let innerWidth = contentInner;
  if (opts.width !== undefined) {
    // outer = inner + 2 border cols
    innerWidth = Math.max(contentInner, opts.width - 2);
  } else if (opts.minWidth !== undefined) {
    innerWidth = Math.max(contentInner, opts.minWidth - 2);
  }

  const top = ansi.gray(
    title
      ? `${chars.tl}${centerLabel(title, innerWidth, chars.h)}${chars.tr}`
      : `${chars.tl}${chars.h.repeat(innerWidth)}${chars.tr}`,
  );
  const bottom = ansi.gray(`${chars.bl}${chars.h.repeat(innerWidth)}${chars.br}`);

  const body = lines.map((line) => {
    const gap = Math.max(0, innerWidth - padding - visibleWidth(line));
    return `${ansi.gray(chars.v)}${" ".repeat(padding)}${line}${" ".repeat(gap)}${ansi.gray(chars.v)}`;
  });

  return [top, ...body, bottom];
}

/** Pad/truncate a line to an exact visible width (ANSI-safe). */
export function padVisible(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w < width) return `${line}${" ".repeat(width - w)}`;
  // Truncate while preserving ANSI codes: walk the string counting only
  // visible characters, then slice the original at that position.
  let visible = 0;
  let i = 0;
  const re = /\u001b\[[0-9;]*m/g;
  while (visible < width && i < line.length) {
    re.lastIndex = i;
    const m = re.exec(line);
    if (m && m.index === i) {
      i = re.lastIndex;
    } else {
      const code = line.charCodeAt(i);
      i += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
      visible++;
    }
  }
  return line.slice(0, i);
}

/**
 * Join left/right columns into rows of equal left-column width.
 * Extra rows on either side are blank-padded.
 */
export function sideBySide(
  left: string[],
  right: string[],
  leftWidth: number,
  gap = 2,
): string[] {
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const L = padVisible(left[i] ?? "", leftWidth);
    const R = right[i] ?? "";
    out.push(`${L}${" ".repeat(gap)}${R}`);
  }
  return out;
}
