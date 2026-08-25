import { stdout } from "node:process";
import { ansi } from "./ansi.js";
import { padVisible, sliceVisible, visibleWidth } from "./width.js";

// Cell arithmetic lives in width.ts; re-exported so existing `./box.js`
// importers (banner, prompt) keep working.
export { padVisible, sliceVisible, visibleWidth };

/** Below this width, boxed chrome wraps on real TTYs — prefer plain output. */
export const MIN_BOXED_COLUMNS = 48;

/**
 * Usable terminal columns (TTY), with a sensible fallback for pipes/tests.
 * Pass `columns` to measure a stream other than process.stdout (or a
 * post-resize value); `undefined` reads stdout at call time.
 */
export function terminalColumns(fallback = 80, columns?: number): number {
  const cols = columns ?? stdout.columns;
  if (typeof cols === "number" && Number.isFinite(cols) && cols >= 1) {
    return cols;
  }
  return fallback;
}

/**
 * Whether rounded/full-bleed boxes fit without wrapping.
 * Non-TTY (unknown columns) keeps boxes for tests and CI logs.
 */
export function preferBoxedUi(columns?: number): boolean {
  const cols = columns ?? stdout.columns;
  if (typeof cols !== "number" || !Number.isFinite(cols)) return true;
  return cols >= MIN_BOXED_COLUMNS;
}

/**
 * Outer box width for Claude-style full-bleed frames.
 * Never wider than the terminal (minus 1 so the right border doesn't wrap).
 */
export function frameWidth(fallback = 80, columns?: number): number {
  return Math.max(20, terminalColumns(fallback, columns) - 1);
}

export interface RoundedBoxOptions {
  title?: string;
  padding?: number;
  /**
   * Exact outer width (including borders). When set, content is padded to
   * fill and *clipped* to fit: no row is ever wider than this, because a row
   * that wraps is a row the redraw math doesn't know about.
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
  let title = opts.title ? ` ${opts.title} ` : "";
  const contentInner =
    Math.max(0, ...lines.map(visibleWidth), visibleWidth(title)) + padding * 2;

  let innerWidth = contentInner;
  let body = lines;
  if (opts.width !== undefined) {
    // outer = inner + 2 border cols; clamp, never grow.
    innerWidth = Math.max(0, opts.width - 2);
    const contentCells = Math.max(0, innerWidth - padding * 2);
    body = lines.map((line) =>
      visibleWidth(line) > contentCells ? padVisible(line, contentCells) : line,
    );
    if (visibleWidth(title) > innerWidth) title = sliceVisible(title, 0, innerWidth);
  } else if (opts.minWidth !== undefined) {
    innerWidth = Math.max(contentInner, opts.minWidth - 2);
  }

  const top = ansi.gray(
    title
      ? `${chars.tl}${centerLabel(title, innerWidth, chars.h)}${chars.tr}`
      : `${chars.tl}${chars.h.repeat(innerWidth)}${chars.tr}`,
  );
  const bottom = ansi.gray(`${chars.bl}${chars.h.repeat(innerWidth)}${chars.br}`);

  const leftPad = Math.min(padding, innerWidth);
  const rows = body.map((line) => {
    const gap = Math.max(0, innerWidth - leftPad - visibleWidth(line));
    return `${ansi.gray(chars.v)}${" ".repeat(leftPad)}${line}${" ".repeat(gap)}${ansi.gray(chars.v)}`;
  });

  return [top, ...rows, bottom];
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
