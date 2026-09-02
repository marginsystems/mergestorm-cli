/**
 * Compact two-row storm mark (Fable / 0.3.14 home). Colored by the caller.
 * Block elements (U+2580..259F) are one cell each; no emoji, no gradients.
 */
export const STORM_MARK: string[] = [
  "▟██▛",
  " ▜▙",
];

/** Widest row of the mark, in cells (every mark glyph is single-cell). */
export const STORM_MARK_WIDTH = Math.max(
  ...STORM_MARK.map((line) => line.length),
);

/** @deprecated Alias — the home panel uses {@link STORM_MARK}. */
export const TORNADO_LOGO = STORM_MARK;
/** @deprecated Alias. */
export const TORNADO_LOGO_WIDTH = STORM_MARK_WIDTH;
/** @deprecated Compact home is the full two-row mark. */
export const TORNADO_LOGO_COMPACT = STORM_MARK;
