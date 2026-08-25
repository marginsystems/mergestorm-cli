import assert from "node:assert/strict";
import { test } from "node:test";
import { TORNADO_LOGO } from "./logo.js";
import { padVisible, sliceVisible, visibleWidth } from "./width.js";

const ESC = "\u001b";

test("visibleWidth counts CJK as two cells", () => {
  assert.equal(visibleWidth("\u65e5\u672c\u8a9e"), 6);
  assert.equal(visibleWidth("a\u65e5\u672c\u8a9eb"), 8);
  // fullwidth Latin
  assert.equal(visibleWidth("ＡＢ"), 4);
});

test("visibleWidth gives combining marks zero cells", () => {
  assert.equal(visibleWidth("é"), 1);
  assert.equal("é".length, 2);
  assert.equal(visibleWidth("näive"), 5);
});

test("visibleWidth treats a ZWJ emoji sequence as one wide grapheme", () => {
  const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
  assert.equal(family.length, 8);
  assert.notEqual(visibleWidth(family), family.length);
  assert.equal(visibleWidth(family), 2);
  // a lone astral emoji is one 2-cell grapheme, not two UTF-16 units
  assert.equal(visibleWidth("\u{1F600}"), 2);
});

test("visibleWidth promotes a VS16 text-style symbol to two cells", () => {
  // ❤ (U+2764) and ✈ (U+2708) are not in WIDE_RANGES; only VS16 promotes them.
  assert.equal(visibleWidth("\u2764"), 1);
  assert.equal(visibleWidth("\u2764\ufe0f"), 2);
  assert.equal(visibleWidth("\u2708\ufe0f"), 2);
  // VS16 on an already-wide base must not change the width.
  assert.equal(visibleWidth("\u{1F600}\ufe0f"), 2);
});

test("visibleWidth ignores SGR colour codes", () => {
  assert.equal(visibleWidth(`${ESC}[1;32mHello${ESC}[0m`), 5);
  assert.equal(visibleWidth(`${ESC}[32m\u65e5\u672c\u8a9e${ESC}[0m`), 6);
  assert.equal(visibleWidth(""), 0);
});

test("visibleWidth keeps TORNADO_LOGO block glyphs at one cell each", () => {
  for (const line of TORNADO_LOGO) {
    assert.equal(visibleWidth(line), Array.from(line).length, line);
  }
  assert.equal(visibleWidth(TORNADO_LOGO[0]!), 12);
});

test("visibleWidth keeps box drawing at one cell", () => {
  assert.equal(visibleWidth("╭──╮"), 4);
  assert.equal(visibleWidth("│ hi │"), 6);
  assert.equal(visibleWidth("› "), 2);
});

test("sliceVisible takes a cell window and keeps SGR codes", () => {
  assert.equal(sliceVisible("abcdef", 2, 3), "cde");
  assert.equal(sliceVisible("abcdef", 4, 10), "ef");
  assert.equal(sliceVisible("abcdef", 0, 0), "");
  const coloured = `${ESC}[32mabc${ESC}[0mdef`;
  assert.equal(sliceVisible(coloured, 1, 3), `${ESC}[32mbc${ESC}[0md`);
  assert.equal(visibleWidth(sliceVisible(coloured, 1, 3)), 3);
});

test("sliceVisible pads a wide glyph cut by the window edge with spaces", () => {
  const s = "a\u65e5\u672c\u8a9eb"; // cells: a=0, 日=1-2, 本=3-4, 語=5-6, b=7
  assert.equal(sliceVisible(s, 0, 3), "a日");
  assert.equal(sliceVisible(s, 0, 2), "a ");
  assert.equal(sliceVisible(s, 2, 3), " 本");
  assert.equal(visibleWidth(sliceVisible(s, 2, 3)), 3);
  assert.equal(sliceVisible(s, 1, 100), "\u65e5\u672c\u8a9eb");
});

test("sliceVisible keeps combining marks with their base", () => {
  assert.equal(sliceVisible("xéy", 1, 1), "é");
  assert.equal(sliceVisible("xéy", 2, 1), "y");
});

test("padVisible truncates by cells, not UTF-16 units", () => {
  assert.equal(padVisible("\u65e5\u672c\u8a9e", 4), "日本");
  assert.equal(padVisible("\u65e5\u672c\u8a9e", 3), "日 ");
  assert.equal(visibleWidth(padVisible("\u65e5\u672c\u8a9e", 3)), 3);
  assert.equal(padVisible("ab", 4), "ab  ");
  assert.equal(padVisible("\u{1F600}\u{1F600}", 2), "\u{1F600}");
});
