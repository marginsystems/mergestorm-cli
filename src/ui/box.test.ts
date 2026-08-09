import assert from "node:assert/strict";
import { test } from "node:test";
import { stdout } from "node:process";
import {
  frameWidth,
  preferBoxedUi,
  roundedBox,
  sideBySide,
  visibleWidth,
} from "./box.js";

const STRIP_ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(STRIP_ANSI, "");

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("visibleWidth strips ANSI escape codes before measuring", () => {
  assert.equal(visibleWidth("\u001b[1;32mHello\u001b[0m"), 5);
  assert.equal(visibleWidth("plain"), 5);
  assert.equal(visibleWidth(""), 0);
});

test("roundedBox pads every row to equal visible width with rounded borders", () => {
  withEnv({ FORCE_COLOR: "1", TERM: "xterm-256color", NO_COLOR: undefined }, () => {
    const box = roundedBox(["a", "bb", "ccc"]);
    assert.equal(box.length, 5); // top + 3 content rows + bottom
    const stripped = box.map(stripAnsi);
    assert.ok(stripped[0]!.startsWith("╭"));
    assert.ok(stripped[0]!.endsWith("╮"));
    assert.ok(stripped[4]!.startsWith("╰"));
    assert.ok(stripped[4]!.endsWith("╯"));
    const widths = box.map(visibleWidth);
    assert.ok(widths.every((w) => w === widths[0]));
    assert.ok(stripped[3]!.includes("ccc"));
  });
});

test("roundedBox width option stretches to full outer width", () => {
  withEnv({ FORCE_COLOR: "1", TERM: "xterm-256color", NO_COLOR: undefined }, () => {
    const box = roundedBox(["hi"], { width: 40 });
    assert.equal(visibleWidth(box[0]!), 40);
    assert.equal(visibleWidth(box[1]!), 40);
    assert.equal(visibleWidth(box[2]!), 40);
  });
});

test("roundedBox centers a title in the top border", () => {
  withEnv({ FORCE_COLOR: "1", TERM: "xterm-256color", NO_COLOR: undefined }, () => {
    const box = roundedBox(["hello world"], { title: "demo", width: 40 });
    const top = stripAnsi(box[0]!);
    assert.ok(top.includes("demo"));
    assert.ok(top.startsWith("╭"));
    assert.ok(top.endsWith("╮"));
    assert.equal(visibleWidth(box[0]!), 40);
  });
});

test("roundedBox falls back to ASCII borders when TERM=dumb", () => {
  withEnv({ FORCE_COLOR: "1", TERM: "dumb", NO_COLOR: undefined }, () => {
    const box = roundedBox(["hi"]);
    const stripped = box.map(stripAnsi);
    assert.ok(stripped[0]!.startsWith("+"));
    assert.ok(stripped[0]!.includes("-"));
    assert.ok(stripped[2]!.startsWith("+"));
    for (const line of stripped) {
      assert.ok(!/[╭╮╰╯│─]/.test(line));
    }
  });
});

test("roundedBox falls back to ASCII borders when color is disabled", () => {
  withEnv({ FORCE_COLOR: undefined, NO_COLOR: "1", TERM: "xterm-256color" }, () => {
    const box = roundedBox(["hi"]);
    assert.ok(box[0]!.startsWith("+"));
  });
});

test("sideBySide pads left column to a fixed width", () => {
  const rows = sideBySide(["a", "bb"], ["right"], 6, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0], "a     " + "  " + "right");
  assert.equal(rows[1], "bb    " + "  " + "");
});

test("frameWidth never exceeds the terminal", () => {
  const restore = (stdout as { columns?: number }).columns;
  try {
    (stdout as { columns?: number }).columns = undefined;
    assert.equal(frameWidth(80), 79);
    assert.equal(frameWidth(40), 39);

    (stdout as { columns?: number }).columns = 45;
    assert.equal(frameWidth(), 44);

    (stdout as { columns?: number }).columns = 120;
    assert.equal(frameWidth(), 119);
  } finally {
    (stdout as { columns?: number }).columns = restore;
  }
});

test("preferBoxedUi is false on narrow TTYs", () => {
  const restore = (stdout as { columns?: number }).columns;
  try {
    (stdout as { columns?: number }).columns = 40;
    assert.equal(preferBoxedUi(), false);
    (stdout as { columns?: number }).columns = 80;
    assert.equal(preferBoxedUi(), true);
    (stdout as { columns?: number }).columns = undefined;
    assert.equal(preferBoxedUi(), true);
  } finally {
    (stdout as { columns?: number }).columns = restore;
  }
});
