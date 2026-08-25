import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { visibleWidth } from "./width.js";
import {
  askLine,
  buildPromptFrame,
  dropdownMaxRows,
  dropdownOverlayRows,
  dropdownViewport,
  formatSlashLabel,
  inputCells,
  inputWindow,
  isExactSlashCommand,
  matchSlashCommands,
  promptClearOverlay,
  promptRedrawPrefix,
  type CommandSpec,
} from "./prompt.js";

const ESC = "\u001b";
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

/** Minimal TTY doubles for askLine: keypresses are emitted directly. */
function fakeTty(columns: number, rows = 24) {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      this.isRaw = mode;
      return this;
    },
    resume() {
      return this;
    },
    pause() {
      return this;
    },
  });
  const chunks: string[] = [];
  const output = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns,
    rows,
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
  });
  const press = (name: string, extra: Partial<{ ctrl: boolean; meta: boolean; sequence: string }> = {}) =>
    input.emit("keypress", extra.sequence ?? "", { name, ctrl: false, meta: false, shift: false, ...extra });
  const type = (text: string) => {
    for (const ch of text) input.emit("keypress", ch, { name: ch, ctrl: false, meta: false, shift: false });
  };
  return {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    raw: output,
    chunks,
    press,
    type,
  };
}

/** Rows of the most recent frame (split from the last `\r\n`-joined write). */
function lastFrameRows(chunks: string[]): string[] {
  const frames = chunks.filter((c) => c.endsWith("\r\n"));
  return frames[frames.length - 1]!.replace(/\r\n$/, "").split("\r\n");
}

const SPECS: CommandSpec[] = [
  { name: "help", summary: "Show available commands" },
  { name: "login", summary: "Sign in" },
  { name: "logout", summary: "Sign out" },
  { name: "review", summary: "Review git diff" },
  { name: "status", summary: "Show a review job" },
  { name: "credits", aliases: ["usage"], summary: "Credit balance" },
  { name: "jobs", summary: "Recent review jobs" },
  { name: "branches", aliases: ["chains"], summary: "Pick a branch" },
  { name: "chain", summary: "Show a timeline" },
  { name: "whoami", summary: "Key + plan" },
  { name: "thread", summary: "Jobs in a thread" },
  { name: "stack", summary: "Stacks" },
  { name: "clear", summary: "Clear screen" },
  { name: "exit", aliases: ["quit"], summary: "Leave the shell" },
];

test("promptRedrawPrefix puts CR before ED 0 so leftover prompt cells erase", () => {
  const seq = promptRedrawPrefix(2);
  assert.equal(seq, "\x1b[2A\r\x1b[0J");
  assert.ok(seq.includes("\x1b[2A\r\x1b[0J"), "CUU must be followed by CR then ED 0");
  assert.equal(seq.indexOf("\r"), seq.indexOf("\x1b[0J") - 1);
  assert.notEqual(seq, "\x1b[2A\x1b[0J");
});

test("promptRedrawPrefix scales the CUU count to the content row", () => {
  assert.equal(promptRedrawPrefix(1), "\x1b[1A\r\x1b[0J");
  assert.equal(promptRedrawPrefix(0), "\x1b[0A\r\x1b[0J");
});

test("promptClearOverlay drops to the first row after boxed chrome", () => {
  assert.equal(promptClearOverlay(true), "\x1b[2B\r\x1b[0J");
});

test("promptClearOverlay drops one row after a plain content line", () => {
  assert.equal(promptClearOverlay(false), "\x1b[1B\r\x1b[0J");
});

test("formatSlashLabel folds aliases onto the primary name", () => {
  assert.equal(formatSlashLabel({ name: "review", summary: "x" }), "/review");
  assert.equal(
    formatSlashLabel({ name: "credits", aliases: ["usage"], summary: "x" }),
    "/credits \u00b7 usage",
  );
});

test("matchSlashCommands folds aliases and honors dismiss", () => {
  const all = matchSlashCommands("/", SPECS);
  assert.equal(all.length, SPECS.length);
  assert.ok(!all.some((c) => c.name === "usage" || c.name === "quit"));
  assert.equal(matchSlashCommands("/us", SPECS)[0]?.name, "credits");
  assert.equal(matchSlashCommands("/q", SPECS)[0]?.name, "exit");
  assert.deepEqual(matchSlashCommands("/", SPECS, true), []);
  assert.deepEqual(matchSlashCommands("review", SPECS), []);
});

test("isExactSlashCommand keeps typed args on a complete name or alias", () => {
  assert.equal(isExactSlashCommand("/review main", SPECS), true);
  assert.equal(isExactSlashCommand("/usage", SPECS), true);
  assert.equal(isExactSlashCommand("/re", SPECS), false);
  assert.equal(isExactSlashCommand("/", SPECS), false);
});

test("dropdownMaxRows caps at 8 and shrinks on a short pane", () => {
  assert.equal(dropdownMaxRows(24, 2), 8);
  assert.equal(dropdownMaxRows(12, 2), 7);
  assert.equal(dropdownMaxRows(undefined, 2), 8);
});

test("dropdownViewport keeps the highlight visible without wrapping", () => {
  assert.deepEqual(dropdownViewport(14, 0, 8), { start: 0, moreAbove: 0, moreBelow: 6 });
  assert.deepEqual(dropdownViewport(14, 10, 8), { start: 3, moreAbove: 3, moreBelow: 3 });
  assert.deepEqual(dropdownViewport(14, 13, 8), { start: 6, moreAbove: 6, moreBelow: 0 });
  assert.deepEqual(dropdownViewport(4, 2, 8), { start: 0, moreAbove: 0, moreBelow: 0 });
});

test("dropdownOverlayRows at 12 terminal rows is at most 8 commands plus an edge", () => {
  const maxRows = dropdownMaxRows(12, 2);
  const rows = dropdownOverlayRows(SPECS, 0, maxRows);
  const commands = rows.filter((r) => r.selected !== undefined);
  const edges = rows.filter((r) => r.selected === undefined);
  assert.ok(commands.length <= 8);
  assert.equal(commands.length, maxRows);
  assert.equal(edges.length, 1);
  assert.match(edges[0]!.text, /\u2193 \d+ more/);
  assert.equal(rows[0]?.selected, true);
});

test("inputWindow scrolls so the cursor stays inside the cell", () => {
  const buf = "x".repeat(300);
  // cursor at end of a 300-char paste, 20 cells: last 19 glyphs + the cursor cell
  const end = inputWindow(buf, 300, 20);
  assert.equal(end.start, 281);
  assert.equal(end.text, "x".repeat(19));
  assert.equal(end.cursorCol, 19);
  assert.ok(visibleWidth(end.text) < 20);
  // short buffer: no scroll at all
  assert.deepEqual(inputWindow("hello", 5, 20), { start: 0, text: "hello", cursorCol: 5 });
  // left within the window does not move it
  const left = inputWindow(buf, 290, 20, 281);
  assert.equal(left.start, 281);
  assert.equal(left.cursorCol, 9);
  // leaving the left edge drags the window along
  const far = inputWindow(buf, 100, 20, 281);
  assert.equal(far.start, 100);
  assert.equal(far.cursorCol, 0);
  assert.equal(far.text, "x".repeat(20));
  // leaving the right edge scrolls forward
  const right = inputWindow(buf, 120, 20, 100);
  assert.equal(right.start, 101);
  assert.equal(right.cursorCol, 19);
  assert.equal(inputWindow(buf, 0, 20, 281).start, 0);
  assert.deepEqual(inputWindow(buf, 5, 0), { start: 0, text: "", cursorCol: 0 });
});

test("inputWindow measures CJK by cells, not code units", () => {
  const buf = "\u65e5\u672c\u8a9e".repeat(10); // 30 code units, 60 cells
  const w = inputWindow(buf, 30, 11);
  assert.equal(w.start, 50);
  assert.equal(w.cursorCol, 10);
  assert.ok(visibleWidth(w.text) <= 11);
});

test("inputCells: boxed at 120 columns, plain at 40", () => {
  assert.deepEqual(inputCells(120), { boxed: true, cells: 119 - 2 - 2 - 2 });
  assert.deepEqual(inputCells(40), { boxed: false, cells: 39 - 2 });
});

test("buildPromptFrame at 120 columns boxes the input and never exceeds the frame", () => {
  withEnv({ FORCE_COLOR: "1", TERM: "xterm-256color", NO_COLOR: undefined }, () => {
    const frame = buildPromptFrame({
      prompt: "mergestorm",
      buffer: "x".repeat(300),
      cursor: 300,
      columns: 120,
    });
    assert.equal(frame.boxed, true);
    assert.equal(frame.inputRow, 2);
    assert.equal(frame.rows.length, 4);
    for (const row of frame.rows.slice(1)) assert.equal(visibleWidth(row), 119);
    assert.ok(visibleWidth(frame.rows[0]!) < 119);
    assert.equal(frame.targetCol, 2 + 2 + 112 + 1);
    assert.ok(frame.targetCol <= 119);
    assert.ok(stripAnsi(frame.rows[2]!).includes("\u203a "));
    assert.ok(stripAnsi(frame.rows[1]!).startsWith("\u256d"));
  });
});

test("buildPromptFrame at 40 columns is plain and keeps the cursor in view", () => {
  const frame = buildPromptFrame({
    prompt: "mergestorm",
    buffer: "x".repeat(300),
    cursor: 300,
    columns: 40,
  });
  assert.equal(frame.boxed, false);
  assert.equal(frame.inputRow, 1);
  assert.equal(frame.rows.length, 2);
  for (const row of frame.rows) assert.ok(visibleWidth(row) <= 39, String(visibleWidth(row)));
  assert.equal(frame.targetCol, 39);
  assert.ok(!/[\u256d+]/.test(stripAnsi(frame.rows[1]!)));
  assert.ok(stripAnsi(frame.rows[1]!).startsWith("\u203a "));
});

test("buildPromptFrame keeps a mid-buffer cursor and its window stable", () => {
  const first = buildPromptFrame({ buffer: "x".repeat(300), cursor: 300, columns: 80 });
  const back = buildPromptFrame({
    buffer: "x".repeat(300),
    cursor: 295,
    columns: 80,
    scrollStart: first.scrollStart,
  });
  assert.equal(back.scrollStart, first.scrollStart);
  assert.equal(back.targetCol, first.targetCol - 5);
});

test("buildPromptFrame clips slash overlay rows to the terminal", () => {
  const overlay = dropdownOverlayRows(SPECS, 0, 8);
  const frame = buildPromptFrame({ buffer: "/", cursor: 1, columns: 30, overlay });
  assert.ok(frame.rows.length > 2);
  for (const row of frame.rows) assert.ok(visibleWidth(row) <= 29, String(visibleWidth(row)));
});

test("askLine keeps a 300-char paste on one row at 80 columns", async () => {
  const tty = fakeTty(80);
  const done = askLine({ input: tty.input, output: tty.output });
  tty.type("x".repeat(300));
  const rows = lastFrameRows(tty.chunks);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(visibleWidth(row), 79);
  const park = tty.chunks[tty.chunks.length - 1]!;
  const m = /\[(\d+)G$/.exec(park);
  assert.ok(m, park);
  assert.ok(Number(m![1]) <= 79);
  assert.ok(park.startsWith(`${ESC}[2A`));

  tty.press("home");
  assert.ok(/\[5G$/.test(tty.chunks[tty.chunks.length - 1]!));
  assert.equal(visibleWidth(lastFrameRows(tty.chunks)[1]!), 79);

  tty.press("return");
  assert.equal(await done, "x".repeat(300));
});

test("askLine reflows on resize and keeps CR before ED 0 (no smear)", async () => {
  const tty = fakeTty(100);
  const done = askLine({
    prompt: "mergestorm",
    input: tty.input,
    output: tty.output,
    commands: SPECS,
  });
  tty.type("hello");
  let rows = lastFrameRows(tty.chunks);
  assert.equal(rows.length, 4);
  assert.equal(visibleWidth(rows[1]!), 99);
  assert.equal(tty.raw.listenerCount("resize"), 1);

  // 100 -> 60: still boxed, the frame width follows.
  tty.raw.columns = 60;
  tty.chunks.length = 0;
  tty.raw.emit("resize");
  assert.equal(tty.chunks[0], promptRedrawPrefix(2));
  assert.equal(tty.chunks[0], `${ESC}[2A\r${ESC}[0J`);
  rows = lastFrameRows(tty.chunks);
  assert.equal(rows.length, 4);
  for (const row of rows.slice(1)) assert.equal(visibleWidth(row), 59);

  // 60 -> 40: below MIN_BOXED_COLUMNS, chrome flips to plain and inputRow drops.
  tty.raw.columns = 40;
  tty.chunks.length = 0;
  tty.raw.emit("resize");
  // Redraw is relative to the frame that is on screen (boxed, content row 2).
  assert.equal(tty.chunks[0], promptRedrawPrefix(2));
  rows = lastFrameRows(tty.chunks);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.ok(visibleWidth(row) <= 39);

  // The next keypress redraws with the new plain geometry.
  tty.chunks.length = 0;
  tty.type("!");
  assert.equal(tty.chunks[0], promptRedrawPrefix(1));
  assert.ok(tty.chunks[0]!.includes(`\r${ESC}[0J`));

  tty.press("return");
  assert.equal(await done, "hello!");
  assert.ok(tty.chunks.includes(promptClearOverlay(false)));
  assert.equal(tty.raw.listenerCount("resize"), 0);
  assert.equal((tty.input as unknown as EventEmitter).listenerCount("keypress"), 0);
});

test("askLine honors an injected columns override", async () => {
  const tty = fakeTty(200);
  const done = askLine({ input: tty.input, output: tty.output, columns: 50 });
  const rows = lastFrameRows(tty.chunks);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(visibleWidth(row), 49);
  tty.press("return");
  assert.equal(await done, "");
});
