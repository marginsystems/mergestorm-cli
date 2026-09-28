import { stdout } from "node:process";

function computeEnabled(): boolean {
  return process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0"
    ? true
    : Boolean(stdout.isTTY) &&
        !process.env.NO_COLOR &&
        process.env.TERM !== "dumb";
}

function wrap(code: string, text: string): string {
  if (!computeEnabled()) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

/**
 * Brand ink. xterm-256 77 (#5FAF5F)  muted green that Terminal.app
 * actually paints. 24-bit `38;2;61;` was read as palette 61 (purple).
 */
export const BRAND_GREEN = { hex: "#5FAF5F", index: 77 } as const;
export const BRAND_GREEN_SGR = `38;5;${BRAND_GREEN.index}`;
/** Full-cell fill. Glyphs like ? leave a hairline; a space with this bg does not. */
export const BRAND_FILL_SGR = `${BRAND_GREEN_SGR};48;5;${BRAND_GREEN.index}`;

function brandGreen(text: string, bold = false): string {
  if (!computeEnabled()) return text;
  return `\x1b[${bold ? "1;" : ""}${BRAND_GREEN_SGR}m${text}\x1b[0m`;
}

function brandFill(text: string): string {
  if (!computeEnabled()) return text;
  return `\x1b[${BRAND_FILL_SGR}m${text}\x1b[0m`;
}

export const ansi = {
  get enabled(): boolean {
    return computeEnabled();
  },
  green: (t: string) => wrap("32", t),
  bold: (t: string) => wrap("1", t),
  dim: (t: string) => wrap("2", t),
  red: (t: string) => wrap("31", t),
  yellow: (t: string) => wrap("33", t),
  gray: (t: string) => wrap("90", t),
  brightGreen: (t: string) => brandGreen(t),
  /** Solid cell (space + fg/bg 77). Stacks flush — no ? hairline. */
  brandFill: (t: string) => brandFill(t),
  invert: (t: string) => wrap("7", t),
  boldGreen: (t: string) => (computeEnabled() ? `\x1b[1;32m${t}\x1b[0m` : t),
  /** Prompt / mark ink. Never ANSI 32, 92, or 24-bit. */
  boldBrightGreen: (t: string) => brandGreen(t, true),
};
