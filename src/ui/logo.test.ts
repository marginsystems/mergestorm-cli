import assert from "node:assert/strict";
import { test } from "node:test";
import { STORM_MARK, TORNADO_FRAMES, TORNADO_LOGO, TORNADO_LOGO_WIDTH, paintSpriteRow } from "./logo.js";

test("mark is five bars and a square tail, twelve columns wide", () => {
  assert.deepEqual(TORNADO_LOGO, [
    " ▀▀▀▀▀▀▀▀▀▀▘",
    "▀▀▀▀▀▀▀▀▀   ",
    " ▀▀▀▀▀▀     ",
    "  ▝▀▀▀▀▀    ",
    "    ▝▀▀▘    ",
    "      ▀     ",
  ]);
  assert.equal(TORNADO_LOGO_WIDTH, 12);
  for (const row of TORNADO_LOGO) assert.equal([...row].length, TORNADO_LOGO_WIDTH);
  assert.deepEqual(TORNADO_FRAMES, [TORNADO_LOGO]);
  assert.equal(STORM_MARK, TORNADO_LOGO);
});

test("paintSpriteRow inks glyphs in xterm-256 77, never 92 or 24-bit", () => {
  process.env.FORCE_COLOR = "1";
  const painted = TORNADO_LOGO.map(paintSpriteRow);
  assert.equal(painted[0], " \u001b[38;5;77m▀▀▀▀▀▀▀▀▀▀▘\u001b[0m");
  assert.equal(painted[5], "      \u001b[38;5;77m▀\u001b[0m     ");
  assert.doesNotMatch(painted.join("\n"), /[34]8;2;|\u001b\[92m|48;5;/);
});

test("paintSpriteRow without colour prints the glyphs as-is", () => {
  const saved = { force: process.env.FORCE_COLOR, no: process.env.NO_COLOR };
  process.env.FORCE_COLOR = "0";
  process.env.NO_COLOR = "1";
  try {
    assert.deepEqual(TORNADO_LOGO.map(paintSpriteRow), TORNADO_LOGO);
  } finally {
    for (const [key, value] of [["FORCE_COLOR", saved.force], ["NO_COLOR", saved.no]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
