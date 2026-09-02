import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { visibleWidth } from "./width.js";
import { CTRL_C_EXIT_HINT } from "./ctrl-c-exit.js";
import {
  HEADER_REDRAW_PREFIX,
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
  overlayReserve,
  fitHomeFrame,
  promptChromeRows,
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
  const frames = chunks.filter((c) => c.includes("\r\n"));
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

test("dropdownOverlayRows keeps edges inside maxRows", () => {
  const maxRows = 7;
  const rows = dropdownOverlayRows(SPECS, 0, maxRows);
  const commands = rows.filter((r) => r.selected !== undefined);
  const edges = rows.filter((r) => r.selected === undefined);
  assert.ok(rows.length <= maxRows);
  assert.ok(commands.length <= maxRows - 1);
  assert.equal(edges.length, 1);
  assert.match(edges[0]!.text, /\u2193 \d+ more/);
  assert.equal(rows[0]?.selected, true);
});

test("overlayReserve stays at most 8 and can be 0 on a short pane", () => {
  assert.equal(overlayReserve(24, 0, true, true), 8);
  assert.equal(overlayReserve(12, 0, true, true), 7);
  assert.equal(overlayReserve(12, 8, true, true), 0);
});

test("fitHomeFrame docks the prompt on leftover rows when asked", () => {
  const full = Array.from({ length: 9 }, () => "full");
  const compact = Array.from({ length: 5 }, () => "compact");
  const idle = fitHomeFrame({
    fullHeader: full,
    compactHeader: compact,
    terminalRows: 24,
    boxed: true,
    hasPrompt: true,
    dropdownCount: 0,
  });
  assert.deepEqual(idle.header, full);
  assert.equal(idle.reserve, 0);

  const docked = fitHomeFrame({
    fullHeader: full,
    compactHeader: compact,
    terminalRows: 24,
    boxed: true,
    hasPrompt: true,
    dropdownCount: 0,
    dockBottom: true,
  });
  assert.deepEqual(docked.header, full);
  assert.equal(docked.reserve, 24 - 9 - 5);

  const open = fitHomeFrame({
    fullHeader: full,
    compactHeader: compact,
    terminalRows: 24,
    boxed: true,
    hasPrompt: true,
    dropdownCount: 14,
    dockBottom: true,
  });
  assert.deepEqual(open.header, full);
  assert.equal(open.reserve, docked.reserve);

  const short = fitHomeFrame({
    fullHeader: full,
    compactHeader: compact,
    terminalRows: 12,
    boxed: true,
    hasPrompt: true,
    dropdownCount: 0,
    dockBottom: true,
  });
  assert.deepEqual(short.header, compact);
  assert.equal(short.reserve, 12 - 5 - 5);
  assert.equal(short.boxed, true);
  assert.equal(promptChromeRows(true, true), 5);

  const mini = ["mark0", "mark1"];
  const nano = ["mark0 mergestorm"];
  const tiny = fitHomeFrame({
    fullHeader: full,
    compactHeader: compact,
    miniHeader: mini,
    nanoHeader: nano,
    terminalRows: 8,
    boxed: true,
    hasPrompt: true,
    dropdownCount: 0,
    dockBottom: true,
  });
  assert.deepEqual(tiny.header, mini);
  assert.equal(tiny.boxed, true);
  assert.ok(tiny.header.length + promptChromeRows(tiny.boxed, tiny.hasPrompt, tiny.hasHint) <= 8);

  const shorter = fitHomeFrame({
    fullHeader: full,
    compactHeader: compact,
    miniHeader: mini,
    nanoHeader: nano,
    terminalRows: 6,
    boxed: true,
    hasPrompt: true,
    dropdownCount: 0,
    dockBottom: true,
  });
  assert.ok(shorter.header.length > 0, "short pane keeps the mark");
  assert.ok(
    shorter.header.length +
      promptChromeRows(shorter.boxed, shorter.hasPrompt, shorter.hasHint) <= 6,
  );
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
  assert.equal(rows.length, 3 + 1);
  for (const row of rows) assert.ok(visibleWidth(row) <= 79);
  const park = tty.chunks[tty.chunks.length - 1]!;
  const m = /\[(\d+)G$/.exec(park);
  assert.ok(m, park);
  assert.ok(Number(m![1]) <= 79);
  const inputRow = 1;
  assert.ok(park.startsWith(`${ESC}[${rows.length - inputRow}A`));

  tty.press("home");
  assert.ok(/\[5G$/.test(tty.chunks[tty.chunks.length - 1]!));
  const homeRows = lastFrameRows(tty.chunks);
  assert.equal(visibleWidth(homeRows[inputRow - 1]!), 79);

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
  assert.equal(rows.length, 1 + 3 + 1);
  const boxTop = rows.find((row) => /[\u256d+]/.test(stripAnsi(row)));
  assert.ok(boxTop);
  assert.equal(visibleWidth(boxTop!), 99);
  assert.equal(tty.raw.listenerCount("resize"), 1);

  // 100 -> 60: still boxed, the frame width follows. No header: relative CUU.
  const boxedInputRow = 2;
  tty.raw.columns = 60;
  tty.chunks.length = 0;
  tty.raw.emit("resize");
  assert.equal(tty.chunks[0], promptRedrawPrefix(boxedInputRow));
  assert.equal(tty.chunks[0], `${ESC}[${boxedInputRow}A\r${ESC}[0J`);
  rows = lastFrameRows(tty.chunks);
  assert.equal(rows.length, 1 + 3 + 1);
  for (const row of rows) assert.ok(visibleWidth(row) <= 59);

  // 60 -> 40: below MIN_BOXED_COLUMNS, chrome flips to plain.
  tty.raw.columns = 40;
  tty.chunks.length = 0;
  tty.raw.emit("resize");
  assert.equal(tty.chunks[0], promptRedrawPrefix(boxedInputRow));
  rows = lastFrameRows(tty.chunks);
  assert.equal(rows.length, 1 + 1 + 1);
  for (const row of rows) assert.ok(visibleWidth(row) <= 39);

  // The next keypress redraws with the new plain geometry.
  const plainInputRow = 1;
  tty.chunks.length = 0;
  tty.type("!");
  assert.equal(tty.chunks[0], promptRedrawPrefix(plainInputRow));
  assert.ok(tty.chunks[0]!.includes(`\r${ESC}[0J`));

  tty.press("return");
  assert.equal(await done, "hello!");
  assert.equal(tty.raw.listenerCount("resize"), 0);
  assert.equal((tty.input as unknown as EventEmitter).listenerCount("keypress"), 0);
});

test("askLine with a header redraws banner + prompt from row 1 on first paint and resize", async () => {
  const tty = fakeTty(100);
  const headerCalls: Array<number | undefined> = [];
  const done = askLine({
    prompt: "mergestorm",
    input: tty.input,
    output: tty.output,
    header: (columns?: number) => {
      headerCalls.push(columns);
      return [`banner at ${columns}`, ""];
    },
  });
  // Home screen owns the pane from the first frame (not only on resize).
  assert.equal(tty.chunks[0], HEADER_REDRAW_PREFIX);
  assert.equal(headerCalls.length >= 1, true);
  assert.equal(
    headerCalls.every((c) => c === 100),
    true,
    "first paint should pass columns=100",
  );
  const idle = lastFrameRows(tty.chunks);
  assert.ok(stripAnsi(idle[0]!).startsWith("banner at 100"));
  assert.ok(idle.some((row) => stripAnsi(row).includes("mergestorm") || stripAnsi(row).includes("\u203a")));
  // Home screen fills the pane so the hint sits on the last row.
  assert.equal(idle.length, 24);

  tty.raw.columns = 60;
  tty.chunks.length = 0;
  tty.raw.emit("resize");
  assert.equal(tty.chunks[0], HEADER_REDRAW_PREFIX);
  assert.equal(tty.chunks[0], `${ESC}[H${ESC}[0J`);
  assert.ok(headerCalls.some((c) => c === 60));
  assert.ok(tty.chunks[1]!.startsWith("banner at 60\r\n"));
  const rows = lastFrameRows(tty.chunks);
  for (const row of rows) assert.ok(visibleWidth(row) <= 59);

  tty.raw.columns = 80;
  tty.chunks.length = 0;
  tty.raw.emit("resize");
  assert.equal(tty.chunks[0], HEADER_REDRAW_PREFIX);
  assert.ok(headerCalls.some((c) => c === 80));

  tty.press("return");
  assert.equal(await done, "");
});

test("askLine full-pane home write does not add a newline that would scroll the top border off", async () => {
  const tty = fakeTty(80, 16);
  const done = askLine({
    prompt: "mg",
    input: tty.input,
    output: tty.output,
    header: () => ["╭──╮", "│hi│", "╰──╯"],
  });
  assert.equal(tty.chunks[0], HEADER_REDRAW_PREFIX);
  const body = tty.chunks.find((c) => c.includes("╭──╮"));
  assert.ok(body);
  const seps = body!.split("\r\n").length - 1;
  assert.equal(body!.split("\r\n").length, 16, "exactly the pane height, no extra row");
  assert.equal(seps, 15, "joins 16 rows with 15 CR/LF, no trailing newline");
  assert.ok(!body!.endsWith("\r\n"));
  assert.ok(stripAnsi(body!.split("\r\n")[0]!).startsWith("╭"));
  tty.press("return");
  await done;
});

test("askLine with a tall header uses the compact banner on a short pane and still homes", async () => {
  const tty = fakeTty(100, 12);
  const headerCalls: Array<{ columns?: number; compact?: boolean | "mini" | "nano" }> = [];
  const done = askLine({
    prompt: "mergestorm",
    input: tty.input,
    output: tty.output,
    header: (columns?: number, compact?: boolean | "mini" | "nano") => {
      headerCalls.push({ columns, compact });
      return compact ? ["compact"] : Array.from({ length: 9 }, () => "banner");
    },
  });
  assert.equal(tty.chunks[0], HEADER_REDRAW_PREFIX);
  const first = lastFrameRows(tty.chunks);
  assert.ok(first.some((row) => stripAnsi(row).includes("compact")));
  assert.ok(!first.some((row) => stripAnsi(row) === "banner"));

  tty.raw.columns = 60;
  tty.chunks.length = 0;
  tty.raw.emit("resize");
  assert.equal(tty.chunks[0], HEADER_REDRAW_PREFIX);
  const rows = lastFrameRows(tty.chunks);
  assert.ok(rows.some((row) => stripAnsi(row).includes("compact")));
  for (const row of rows) assert.ok(visibleWidth(row) <= 59);
  assert.ok(headerCalls.some((c) => Boolean(c.compact)));

  tty.press("return");
  assert.equal(await done, "");
});

test("askLine on a short pane keeps the mark and does not overflow the frame", async () => {
  const tty = fakeTty(80, 8);
  const done = askLine({
    prompt: "mg",
    input: tty.input,
    output: tty.output,
    header: (_columns?: number, variant?: boolean | "mini" | "nano") => {
      if (variant === "nano") return ["n MARK nano"];
      if (variant === "mini" || variant === true) return ["m MARK mini", "m row2"];
      return Array.from({ length: 9 }, () => "FULL tips what's new");
    },
  });
  const rows = lastFrameRows(tty.chunks);
  assert.ok(rows.length <= 8, `wrote ${rows.length} rows into an 8-row pane`);
  const text = rows.map((r) => stripAnsi(r)).join("\n");
  assert.match(text, /MARK/);
  assert.doesNotMatch(text, /FULL tips/);
  tty.press("return");
  await done;
});

test("askLine with a header does not scroll the pane on enter", async () => {
  const tty = fakeTty(80, 16);
  const done = askLine({
    prompt: "mg",
    input: tty.input,
    output: tty.output,
    header: () => ["╭──╮", "│hi│", "╰──╯"],
  });
  tty.type("/usage");
  tty.chunks.length = 0;
  tty.press("return");
  assert.equal(await done, "/usage");
  assert.equal(tty.chunks.join(""), "", "no down() or newline after a home submit");
});

test("askLine without a header still emits a newline on enter", async () => {
  const tty = fakeTty(80);
  const done = askLine({ input: tty.input, output: tty.output });
  tty.type("hi");
  tty.chunks.length = 0;
  tty.press("return");
  assert.equal(await done, "hi");
  assert.ok(tty.chunks.some((c) => c === "\n"));
});

test("askLine honors an injected columns override", async () => {
  const tty = fakeTty(200);
  const done = askLine({ input: tty.input, output: tty.output, columns: 50 });
  const rows = lastFrameRows(tty.chunks);
  assert.equal(rows.length, 3 + 1);
  for (const row of rows) assert.ok(visibleWidth(row) <= 49);
  tty.press("return");
  assert.equal(await done, "");
});

test("buildPromptFrame with a reserve puts the list above the bar at a fixed height", () => {
  const overlay = dropdownOverlayRows(SPECS, 0, 4);
  const closed = buildPromptFrame({
    prompt: "mergestorm",
    buffer: "",
    cursor: 0,
    columns: 80,
    overlayReserve: 4,
    hint: " ",
  });
  const open = buildPromptFrame({
    prompt: "mergestorm",
    buffer: "/",
    cursor: 1,
    columns: 80,
    overlay,
    overlayReserve: 4,
    hint: " ",
  });
  assert.equal(closed.rows.length, open.rows.length);
  assert.equal(closed.inputRow, open.inputRow);
  assert.ok(
    open.rows.slice(0, open.inputRow).some((row) => stripAnsi(row).includes("/help")),
    "list sits in the reserved rows above the bar",
  );
  assert.ok(stripAnsi(open.rows[open.inputRow]!).includes("\u203a /"));
});

test("askLine docks the home prompt and keeps the header on /", async () => {
  const tty = fakeTty(80);
  const done = askLine({
    prompt: "mergestorm",
    input: tty.input,
    output: tty.output,
    commands: SPECS,
    header: () => ["STORM", "status"],
  });
  assert.equal(tty.chunks[0], HEADER_REDRAW_PREFIX);
  const idle = lastFrameRows(tty.chunks);
  assert.equal(stripAnsi(idle[0]!), "STORM");
  assert.equal(idle.length, 24);
  assert.ok(!idle.some((row) => stripAnsi(row).includes("/help")));

  tty.chunks.length = 0;
  tty.type("/");
  assert.equal(tty.chunks[0], HEADER_REDRAW_PREFIX);
  const open = lastFrameRows(tty.chunks);
  assert.equal(open.length, idle.length);
  assert.equal(stripAnsi(open[0]!), "STORM");
  assert.ok(open.some((row) => stripAnsi(row).includes("/help")));
  const helpAt = open.findIndex((row) => stripAnsi(row).includes("/help"));
  const inputAt = open.findIndex((row) => stripAnsi(row).includes("\u203a"));
  assert.ok(helpAt >= 0 && inputAt > helpAt, "list sits just above the bar");
  tty.press("c", { ctrl: true });
  const hinted = lastFrameRows(tty.chunks);
  assert.equal(hinted.length, 24);
  assert.ok(stripAnsi(hinted[hinted.length - 1]!).includes(CTRL_C_EXIT_HINT));
  tty.press("return");
  await done;
});

test("askLine first Ctrl+C writes the hint on the footer without a second prompt", async () => {
  const tty = fakeTty(80);
  const done = askLine({
    prompt: "mergestorm",
    input: tty.input,
    output: tty.output,
    commands: SPECS,
  });
  tty.type("/");
  const before = lastFrameRows(tty.chunks);
  tty.press("c", { ctrl: true });
  const after = lastFrameRows(tty.chunks);
  assert.equal(after.length, before.length);
  assert.ok(stripAnsi(after[after.length - 1]!).includes(CTRL_C_EXIT_HINT));
  assert.ok(!tty.chunks.join("").includes(`\n${CTRL_C_EXIT_HINT}\n`));
  tty.press("return");
  await done;
});
