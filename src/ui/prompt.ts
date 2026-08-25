import * as readline from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ansi } from "./ansi.js";
import {
  frameWidth,
  preferBoxedUi,
  roundedBox,
  sliceVisible,
  terminalColumns,
  visibleWidth,
} from "./box.js";
import { CTRL_C_EXIT_HINT, CtrlCExitGate } from "./ctrl-c-exit.js";

export interface CommandSpec {
  name: string;
  aliases?: string[];
  summary: string;
}

export interface AskLineOptions {
  prompt?: string;
  history?: string[];
  commands?: CommandSpec[];
  /** Terminal rows; defaults to output.rows. Caps the slash viewport. */
  rows?: number;
  /**
   * Terminal columns; defaults to output.columns, re-read on every render so
   * a resize mid-prompt reflows the frame instead of smearing it.
   */
  columns?: number;
  /** Streams (defaults: process.stdin / process.stdout). Injectable for tests. */
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/** Thrown when the user asks to close the prompt (Ctrl+D empty, or Ctrl+C twice). */
export class PromptClosedError extends Error {
  constructor() {
    super("prompt closed");
    this.name = "PromptClosedError";
  }
}

const up = (n: number) => `\u001b[${n}A`;
const down = (n: number) => `\u001b[${n}B`;
const col = (n: number) => `\u001b[${n}G`;
const clearDown = "\u001b[0J";

/**
 * Redraw prefix from the parked content-row cursor.
 * CUU keeps the column, so CR must come before ED 0 or leftover
 * prompt cells survive (`merg` + `mergestorm` -> `mergmmmmmergestorm`).
 */
export function promptRedrawPrefix(inputRow: number): string {
  return `${up(inputRow)}\r${clearDown}`;
}

/**
 * From the content row, move to the first row after the input chrome
 * and erase the slash overlay. Boxed chrome is top + content + bottom
 * (`down(2)`). Plain chrome is the content line (`down(1)`).
 */
export function promptClearOverlay(boxed: boolean): string {
  return `${down(boxed ? 2 : 1)}\r${clearDown}`;
}

export const DROPDOWN_MAX_COMMAND_ROWS = 8;

export function formatSlashLabel(spec: CommandSpec): string {
  const extra = spec.aliases?.length
    ? ` \u00b7 ${spec.aliases.join(" \u00b7 ")}`
    : "";
  return `/${spec.name}${extra}`;
}

export function specMatchesTerm(spec: CommandSpec, term: string): boolean {
  if (spec.name.toLowerCase().startsWith(term)) return true;
  return (spec.aliases ?? []).some((alias) => alias.toLowerCase().startsWith(term));
}

export function slashToken(buffer: string): string | null {
  if (!buffer.startsWith("/")) return null;
  return buffer.slice(1).split(/\s/, 1)[0]!.toLowerCase();
}

export function matchSlashCommands(
  buffer: string,
  specs: CommandSpec[],
  dismissed = false,
): CommandSpec[] {
  if (dismissed) return [];
  const token = slashToken(buffer);
  if (token == null) return [];
  return specs.filter((spec) => specMatchesTerm(spec, token));
}

export function isExactSlashCommand(buffer: string, specs: CommandSpec[]): boolean {
  const token = slashToken(buffer);
  if (!token) return false;
  return specs.some(
    (spec) => spec.name === token || (spec.aliases ?? []).includes(token),
  );
}

export function dropdownMaxRows(terminalRows: number | undefined, inputRow: number): number {
  const rows = typeof terminalRows === "number" && Number.isFinite(terminalRows) && terminalRows >= 1
    ? terminalRows
    : 24;
  return Math.max(1, Math.min(DROPDOWN_MAX_COMMAND_ROWS, rows - inputRow - 3));
}

export function dropdownViewport(
  count: number,
  index: number,
  maxRows: number,
): { start: number; moreAbove: number; moreBelow: number } {
  const max = Math.max(1, maxRows);
  if (count <= max) return { start: 0, moreAbove: 0, moreBelow: 0 };
  const clampedIndex = Math.max(0, Math.min(index, count - 1));
  let start = 0;
  if (clampedIndex >= max) start = clampedIndex - max + 1;
  if (start + max > count) start = Math.max(0, count - max);
  return {
    start,
    moreAbove: start,
    moreBelow: Math.max(0, count - start - max),
  };
}

export type OverlayRow = { text: string; selected?: boolean };

/** Overlay rows (no invert). At most `maxRows` commands plus edge markers. */
export function dropdownOverlayRows(
  dropdown: CommandSpec[],
  index: number,
  maxRows: number,
): OverlayRow[] {
  const view = dropdownViewport(dropdown.length, index, maxRows);
  const rows: OverlayRow[] = [];
  if (view.moreAbove > 0) rows.push({ text: `  \u2191 ${view.moreAbove} more` });
  const end = Math.min(dropdown.length, view.start + Math.max(1, maxRows));
  for (let i = view.start; i < end; i++) {
    const spec = dropdown[i]!;
    rows.push({
      text: `  ${formatSlashLabel(spec).padEnd(22)}${spec.summary}`,
      selected: i === index,
    });
  }
  if (view.moreBelow > 0) rows.push({ text: `  \u2193 ${view.moreBelow} more` });
  return rows;
}

/** Input prefix glyph (U+203A), kept as an escape so editors can't mangle it. */
export const INPUT_PREFIX_GLYPH = "\u203a";
/** Cells the `> ` prefix occupies before the buffer. */
export const INPUT_PREFIX_CELLS = 2;
/** Padding inside the boxed input frame. */
export const INPUT_BOX_PADDING = 1;

export interface InputWindow {
  /** First buffer cell shown. */
  start: number;
  /** The visible slice of the buffer (ANSI-free, at most `cells` wide). */
  text: string;
  /** Cursor column within the window, 0-based. */
  cursorCol: number;
}

/**
 * Horizontal scroll for a one-row editor: pick the `cells`-wide window of
 * `buffer` that keeps the cursor on screen, moving the previous window only
 * when the cursor leaves it. Never wraps onto a second physical row.
 */
export function inputWindow(
  buffer: string,
  cursor: number,
  cells: number,
  prevStart = 0,
): InputWindow {
  if (cells <= 0) return { start: 0, text: "", cursorCol: 0 };
  const cursorCells = visibleWidth(buffer.slice(0, Math.max(0, cursor)));
  const totalCells = visibleWidth(buffer);
  // The cursor needs a cell of its own at end-of-line, so a full window
  // shows at most `cells - 1` glyphs past the scroll origin.
  const maxStart = Math.max(0, totalCells - (cells - 1));
  let start = Math.min(Math.max(0, prevStart), maxStart);
  if (cursorCells < start) start = cursorCells;
  if (cursorCells > start + cells - 1) start = cursorCells - (cells - 1);
  return {
    start,
    text: sliceVisible(buffer, start, cells),
    cursorCol: cursorCells - start,
  };
}

/** Cells available to the buffer (after the prefix) on a content row. */
export function inputCells(columns: number | undefined): { boxed: boolean; cells: number } {
  const boxed = preferBoxedUi(columns);
  const contentCells = boxed
    ? frameWidth(80, columns) - 2 - INPUT_BOX_PADDING * 2
    : terminalColumns(80, columns) - 1;
  return { boxed, cells: Math.max(0, contentCells - INPUT_PREFIX_CELLS) };
}

export interface PromptFrameInput {
  prompt?: string;
  buffer: string;
  cursor: number;
  /** Terminal columns at draw time; undefined = unknown (boxed at 80). */
  columns?: number;
  /** Previous scroll origin, so left/right only move the window at the edges. */
  scrollStart?: number;
  overlay?: OverlayRow[];
}

export interface PromptFrame {
  rows: string[];
  boxed: boolean;
  /** Row (0-based) of the content line within `rows`. */
  inputRow: number;
  /** 1-based column to park the cursor on the content row. */
  targetCol: number;
  scrollStart: number;
}

/**
 * Everything one prompt redraw writes, computed from the current terminal
 * width. Every row fits in `columns - 1` cells so nothing wraps and the
 * CUU count on the next redraw stays honest.
 */
export function buildPromptFrame(params: PromptFrameInput): PromptFrame {
  const { boxed, cells } = inputCells(params.columns);
  const cols = terminalColumns(80, params.columns);
  const win = inputWindow(params.buffer, params.cursor, cells, params.scrollStart ?? 0);
  const inputRow = (params.prompt ? 1 : 0) + (boxed ? 1 : 0);

  // Nothing we emit may wrap: a wrapped row is one the CUU count can't see.
  const clip = (text: string): string =>
    visibleWidth(text) > cols - 1 ? sliceVisible(text, 0, cols - 1) : text;

  const rows: string[] = [];
  if (params.prompt) rows.push(ansi.dim(clip(params.prompt)));
  const inputLine = `${ansi.green(INPUT_PREFIX_GLYPH)} ${win.text}`;
  if (boxed) {
    // Full terminal width input frame, not content-sized.
    rows.push(
      ...roundedBox([inputLine], {
        padding: INPUT_BOX_PADDING,
        width: frameWidth(80, params.columns),
      }),
    );
  } else {
    // Plain prompt on narrow TTYs (avoids wrapped borders).
    rows.push(inputLine);
  }
  for (const row of params.overlay ?? []) {
    const text = clip(row.text);
    rows.push(row.selected ? ansi.invert(text) : ansi.gray(text));
  }

  // Boxed: border col + padding; plain: column 1.
  const targetCol =
    (boxed ? 1 + INPUT_BOX_PADDING : 0) + INPUT_PREFIX_CELLS + win.cursorCol + 1;
  return { rows, boxed, inputRow, targetCol, scrollStart: win.start };
}

async function fallbackAskLine(
  promptLabel: string | undefined,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Promise<string> {
  const rl = createInterface({ input, output, terminal: false });
  try {
    return await rl.question(promptLabel ? `${promptLabel}> ` : "> ");
  } finally {
    rl.close();
  }
}

/**
 * Hand-rolled raw-mode line editor: bordered input box, history, and a live
 * slash-command dropdown. Falls back to plain readline on a non-TTY stream.
 */
export async function askLine(opts: AskLineOptions): Promise<string> {
  const commands = opts.commands ?? [];
  const history = opts.history ?? [];
  const input = opts.input ?? stdin;
  const output = opts.output ?? stdout;

  if (!input.isTTY || !output.isTTY) {
    return fallbackAskLine(opts.prompt, input, output);
  }

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let cursor = 0;
    let historyIndex = history.length;
    let dropdownIndex = 0;
    let dropdownDismissed = false;
    let linesDrawn = 0;
    // Geometry of the frame currently on screen. The redraw prefix and the
    // final overlay clear must use *these*, not a fresh measurement, because
    // the cursor is parked relative to what was actually drawn.
    let drawnInputRow = 0;
    let drawnBoxed = true;
    let scrollStart = 0;
    let finished = false;
    const ctrlCExit = new CtrlCExitGate();

    const wasRaw = Boolean(input.isRaw);
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    function currentDropdown(): CommandSpec[] {
      return matchSlashCommands(buffer, commands, dropdownDismissed);
    }

    function setBuffer(next: string): void {
      if (next !== buffer) dropdownDismissed = false;
      buffer = next;
    }

    function render(): void {
      if (linesDrawn > 0) {
        output.write(promptRedrawPrefix(drawnInputRow));
      }

      // Re-measured every frame: the terminal may have been resized since
      // the last draw, flipping boxed/plain or changing the frame width.
      const columns = opts.columns ?? output.columns;
      const boxedNow = preferBoxedUi(columns);
      const inputRowNow = (opts.prompt ? 1 : 0) + (boxedNow ? 1 : 0);

      const dropdown = currentDropdown();
      let overlay: OverlayRow[] = [];
      if (dropdown.length) {
        if (dropdownIndex >= dropdown.length) dropdownIndex = dropdown.length - 1;
        const maxRows = dropdownMaxRows(opts.rows ?? output.rows, inputRowNow);
        overlay = dropdownOverlayRows(dropdown, dropdownIndex, maxRows);
      } else {
        dropdownIndex = 0;
      }

      const frame = buildPromptFrame({
        prompt: opts.prompt,
        buffer,
        cursor,
        columns,
        scrollStart,
        overlay,
      });

      output.write(frame.rows.join("\r\n") + "\r\n");
      linesDrawn = frame.rows.length;
      drawnInputRow = frame.inputRow;
      drawnBoxed = frame.boxed;
      scrollStart = frame.scrollStart;

      output.write(`${up(linesDrawn - frame.inputRow)}${col(frame.targetCol)}`);
    }

    function onResize(): void {
      if (!finished) render();
    }

    function cleanup(): void {
      input.removeListener("keypress", onKeypress);
      output.removeListener("resize", onResize);
      input.setRawMode(wasRaw);
      // emitKeypressEvents leaves stdin flowing; pause it so an idle shell
      // (no command running) doesn't keep the process alive after exit/EOF.
      input.pause();
    }

    function finish(value: string | null, err?: unknown): void {
      if (finished) return;
      finished = true;
      cleanup();

      if (linesDrawn > 0) output.write(promptClearOverlay(drawnBoxed));
      output.write("\n");

      if (err) reject(err);
      else resolve(value ?? "");
    }

    function acceptDropdown(dropdown: CommandSpec[]): void {
      setBuffer(`/${dropdown[dropdownIndex]!.name} `);
      cursor = buffer.length;
      dropdownIndex = 0;
    }

    function onKeypress(str: string, key: readline.Key): void {
      try {
        if (finished || !key) return;
        if (!(key.ctrl && key.name === "c")) ctrlCExit.reset();
        const dropdown = currentDropdown();

        if (key.ctrl && key.name === "c") {
          if (ctrlCExit.press()) {
            finish(null, new PromptClosedError());
            return;
          }
          setBuffer("");
          cursor = 0;
          scrollStart = 0;
          historyIndex = history.length;
          dropdownIndex = 0;
          if (linesDrawn > 0) output.write(promptClearOverlay(drawnBoxed));
          output.write(`\n${ansi.dim(CTRL_C_EXIT_HINT)}\n`);
          linesDrawn = 0;
          render();
          return;
        }
        if (key.ctrl && key.name === "d") {
          if (!buffer) finish(null, new PromptClosedError());
          return;
        }
        if (key.name === "escape") {
          if (dropdown.length) dropdownDismissed = true;
          render();
          return;
        }
        if (key.name === "return") {
          if (
            dropdown.length &&
            !dropdownDismissed &&
            !isExactSlashCommand(buffer, dropdown)
          ) {
            setBuffer(`/${dropdown[dropdownIndex]!.name}`);
          }
          finish(buffer);
          return;
        }
        if (key.name === "tab") {
          if (dropdown.length) acceptDropdown(dropdown);
          render();
          return;
        }
        if (key.name === "right") {
          cursor = Math.min(buffer.length, cursor + 1);
          render();
          return;
        }
        if (key.name === "left") {
          cursor = Math.max(0, cursor - 1);
          render();
          return;
        }
        if (key.name === "up") {
          if (dropdown.length) {
            dropdownIndex = Math.max(0, dropdownIndex - 1);
          } else if (history.length) {
            historyIndex = Math.max(0, historyIndex - 1);
            setBuffer(history[historyIndex] ?? "");
            cursor = buffer.length;
          }
          render();
          return;
        }
        if (key.name === "down") {
          if (dropdown.length) {
            dropdownIndex = Math.min(dropdown.length - 1, dropdownIndex + 1);
          } else if (history.length) {
            historyIndex = Math.min(history.length, historyIndex + 1);
            setBuffer(historyIndex >= history.length ? "" : history[historyIndex] ?? "");
            cursor = buffer.length;
          }
          render();
          return;
        }
        if (key.name === "home" || (key.ctrl && key.name === "a")) {
          cursor = 0;
          render();
          return;
        }
        if (key.name === "end" || (key.ctrl && key.name === "e")) {
          cursor = buffer.length;
          render();
          return;
        }
        if (key.ctrl && key.name === "u") {
          setBuffer(buffer.slice(cursor));
          cursor = 0;
          render();
          return;
        }
        if (key.ctrl && key.name === "k") {
          setBuffer(buffer.slice(0, cursor));
          render();
          return;
        }
        if (key.name === "backspace") {
          if (cursor > 0) {
            setBuffer(buffer.slice(0, cursor - 1) + buffer.slice(cursor));
            cursor -= 1;
          }
          render();
          return;
        }
        if (key.name === "delete") {
          setBuffer(buffer.slice(0, cursor) + buffer.slice(cursor + 1));
          render();
          return;
        }
        if (str && !key.ctrl && !key.meta) {
          setBuffer(buffer.slice(0, cursor) + str + buffer.slice(cursor));
          cursor += str.length;
          render();
        }
      } catch (err) {
        finish(null, err);
      }
    }

    input.on("keypress", onKeypress);
    output.on("resize", onResize);
    render();
  });
}
