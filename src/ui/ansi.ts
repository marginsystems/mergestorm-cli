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
  return `[${code}m${text}[0m`;
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
  brightGreen: (t: string) => wrap("92", t),
  invert: (t: string) => wrap("7", t),
  boldGreen: (t: string) => (computeEnabled() ? `[1;32m${t}[0m` : t),
  /** Prompt / mark ink. Never 32 — that reads as sick dark green. */
  boldBrightGreen: (t: string) => (computeEnabled() ? `[1;92m${t}[0m` : t),
};
