import { ansi } from "./ansi.js";

/**
 * The home mark: a tornado drawn as five horizontal bars and one square tail,
 * each an upper-half band (▀). One column is one bar-height wide; half-column
 * ends use the upper quadrants (▝ ▘) so every edge lands where the source art
 * puts it. Same X/width as the SVG, shifted up half a cell. Painted fg 77.
 */
export const TORNADO_LOGO = [
  " ▀▀▀▀▀▀▀▀▀▀▘",
  "▀▀▀▀▀▀▀▀▀   ",
  " ▀▀▀▀▀▀     ",
  "  ▝▀▀▀▀▀    ",
  "    ▝▀▀▘    ",
  "      ▀     ",
];

/** Every sprite glyph is one column. */
export const TORNADO_LOGO_WIDTH = Math.max(...TORNADO_LOGO.map((line) => [...line].length));

/** Paint one sprite row: each run of glyphs in brand green 77, spaces left bare. */
export function paintSpriteRow(row: string): string {
  return row.replace(/[^ ]+/g, (run) => ansi.brightGreen(run));
}
