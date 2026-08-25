/**
 * Terminal cell arithmetic. Everything that frames, pads, or parks a cursor
 * must count *cells*, not UTF-16 units: CJK is two cells, combining marks
 * and ZWJ are zero, an astral emoji is one grapheme. Getting this wrong is
 * why the right border of the prompt box drifted on non-Latin input.
 */

const SGR_PATTERN = /\u001b\[[0-9;]*m/g;
const SGR_SPLIT = /(\u001b\[[0-9;]*m)/;

export function stripSgr(str: string): string {
  return str.replace(SGR_PATTERN, "");
}

/**
 * East Asian Wide / Fullwidth ranges (plus emoji presentation blocks).
 * Deliberately excludes Ambiguous-width ranges such as box drawing
 * (U+2500..257F) and block elements (U+2580..259F, the TORNADO_LOGO
 * glyphs), which every terminal we target renders in one cell.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK radicals, Kangxi, ideographic description, CJK symbols
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compat, enclosed CJK
  [0x3400, 0x4dbf], // CJK ext A
  [0x4e00, 0x9fff], // CJK unified
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo ext A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compat ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compat forms, small forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff], // Tangut, Khitan
  [0x1b000, 0x1b2ff], // Kana supplement / ext
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f1e6, 0x1f1ff], // regional indicators (flags pair to one 2-cell cluster)
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], // CJK ext B..F
  [0x30000, 0x3fffd], // CJK ext G..
];

const ZERO_WIDTH_RE = /^[\p{M}\p{Cc}\p{Cf}\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]$/u;

function isWide(cp: number): boolean {
  // Binary search over the sorted range table.
  let lo = 0;
  let hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = WIDE_RANGES[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Cells for one code point on its own (no cluster context). */
export function codePointWidth(cp: number): number {
  if (cp === 0xfe0f) return 0; // VS16 handled at cluster level
  const ch = String.fromCodePoint(cp);
  if (ZERO_WIDTH_RE.test(ch)) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0; // variation selectors
  if (cp >= 0xe0100 && cp <= 0xe01ef) return 0; // VS supplement
  if (cp >= 0xe0020 && cp <= 0xe007f) return 0; // emoji tag sequence
  if (cp >= 0xd800 && cp <= 0xdfff) return 1; // lone surrogate (broken slice)
  return isWide(cp) ? 2 : 1;
}

let segmenter: Intl.Segmenter | null | undefined;

/**
 * Grapheme clusters of `text`, yielded lazily so an early exit (e.g.
 * `sliceVisible` cutting a cell window) never segments the whole tail of a
 * long buffer. Falls back to code-point iteration without Intl.Segmenter.
 */
function* graphemes(text: string): Generator<string> {
  if (segmenter === undefined) {
    try {
      segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    } catch {
      segmenter = null;
    }
  }
  if (segmenter) {
    for (const seg of segmenter.segment(text)) yield seg.segment;
    return;
  }
  for (const ch of text) yield ch;
}

/**
 * Cells one grapheme cluster occupies. A cluster is as wide as its widest
 * base (a ZWJ family emoji is 2, not 6); VS16 promotes a text-style symbol
 * to emoji presentation (2 cells); a cluster of nothing but marks is 0.
 */
export function graphemeWidth(cluster: string): number {
  let width = 0;
  let vs16 = false;
  for (const ch of cluster) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f) {
      vs16 = true;
      continue;
    }
    width = Math.max(width, codePointWidth(cp));
  }
  if (vs16 && width === 1) return 2;
  return width;
}

/** Terminal cells a string occupies, ignoring SGR colour codes. */
export function visibleWidth(str: string): number {
  const plain = stripSgr(str);
  if (!plain) return 0;
  let total = 0;
  for (const cluster of graphemes(plain)) total += graphemeWidth(cluster);
  return total;
}

/**
 * Take the cells `[start, start + cells)` of `str`, keeping every SGR code
 * (so colours survive) and substituting spaces for a wide glyph cut by
 * either edge, so the result's geometry is exactly what the caller asked
 * for even when a CJK character straddles the window.
 */
export function sliceVisible(str: string, start: number, cells: number): string {
  if (cells <= 0) return "";
  const end = start + cells;
  let out = "";
  let offset = 0;
  const parts = str.split(SGR_SPLIT);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part) continue;
    if (i % 2 === 1) {
      out += part;
      continue;
    }
    // Offsets only grow, so once we're past the window no later content can
    // land in it; stop segmenting the tail of a long buffer.
    if (offset > end) continue;
    for (const cluster of graphemes(part)) {
      if (offset > end) break;
      const w = graphemeWidth(cluster);
      const from = offset;
      const to = offset + w;
      offset = to;
      if (w === 0) {
        // Marks attach to the previous glyph; keep them only when that glyph
        // was emitted.
        if (from > start && from <= end) out += cluster;
        continue;
      }
      if (to <= start || from >= end) continue;
      if (from >= start && to <= end) {
        out += cluster;
      } else {
        out += " ".repeat(Math.min(to, end) - Math.max(from, start));
      }
    }
  }
  return out;
}

/** Pad or truncate to an exact cell width (ANSI-safe). */
export function padVisible(line: string, width: number): string {
  const target = Math.max(0, width);
  const w = visibleWidth(line);
  if (w === target) return line;
  if (w < target) return `${line}${" ".repeat(target - w)}`;
  const cut = sliceVisible(line, 0, target);
  const cutWidth = visibleWidth(cut);
  return cutWidth < target ? `${cut}${" ".repeat(target - cutWidth)}` : cut;
}
