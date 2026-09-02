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
  /**
   * Welcome-panel rows sitting directly above this prompt, reflowed per
   * width. Painted on every frame from the pane origin (`ESC[H`) so a
   * resize cannot desync CUU counts. Pass `true` for compact, `"mini"` /
   * `"nano"` for a short pane that still shows the mark.
   */
  header?: (columns?: number, variant?: boolean | "mini" | "nano") => string[];
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

/**
 * Cursor home + ED 0: clears the whole screen from row 1 and leaves the
 * cursor there. Used to redraw the welcome panel on resize, where the old
 * frame's row count is unknowable after the terminal rewraps.
 */
export const HEADER_REDRAW_PREFIX = `\u001b[H${clearDown}`;

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
/** Prompt label + input chrome + footer hint. */
export function promptChromeRows(
  boxed: boolean,
  hasPrompt: boolean,
  hasHint = true,
): number {
  return (hasPrompt ? 1 : 0) + (boxed ? 3 : 1) + (hasHint ? 1 : 0);
}

function resolvedRows(terminalRows: number | undefined): number {
  return typeof terminalRows === "number" && Number.isFinite(terminalRows) && terminalRows >= 1
    ? terminalRows
    : 24;
}

/**
 * Rows available above the input bar for the slash list. Idle home
 * passes 0 — do not pad a blank gap between header and prompt.
 */
export function overlayReserve(
  terminalRows: number | undefined,
  headerRows: number,
  boxed: boolean,
  hasPrompt: boolean,
): number {
  const available =
    resolvedRows(terminalRows) - Math.max(0, headerRows) - promptChromeRows(boxed, hasPrompt);
  return Math.max(0, Math.min(DROPDOWN_MAX_COMMAND_ROWS, available));
}

/** Pad so the slash list sits just above the input bar (Claude-style). */
export function padOverlayRows(rows: OverlayRow[], reserve: number): OverlayRow[] {
  const max = Math.max(0, reserve);
  if (max === 0) return [];
  const visible = rows.slice(0, max);
  const pad = max - visible.length;
  return [...Array.from({ length: pad }, () => ({ text: " " })), ...visible];
}

export interface HomeFrameFit {
  header: string[];
  reserve: number;
  boxed: boolean;
  hasPrompt: boolean;
  hasHint: boolean;
}

/**
 * Pick a header density and input chrome that fit the pane.
 * Never drops the mark when a mini/nano header is provided — a short
 * pane unboxes the input instead of painting an overflowing frame.
 * `dockBottom` uses leftover rows so the prompt sits on the last lines.
 */
export function fitHomeFrame(params: {
  fullHeader: string[];
  compactHeader: string[];
  miniHeader?: string[];
  nanoHeader?: string[];
  terminalRows: number | undefined;
  boxed: boolean;
  hasPrompt: boolean;
  dropdownCount: number;
  dockBottom?: boolean;
}): HomeFrameFit {
  const rows = resolvedRows(params.terminalRows);
  const want = params.dropdownCount > 0
    ? Math.min(DROPDOWN_MAX_COMMAND_ROWS, Math.max(1, params.dropdownCount))
    : 0;

  const headers = [
    params.fullHeader,
    params.compactHeader,
    params.miniHeader ?? [],
    params.nanoHeader ?? [],
  ].filter((h, i, all) => h.length > 0 && all.findIndex((x) => x === h) === i);

  const chromes: Array<{ boxed: boolean; hasPrompt: boolean; hasHint: boolean }> = [];
  if (params.boxed) chromes.push({ boxed: true, hasPrompt: params.hasPrompt, hasHint: true });
  chromes.push({ boxed: false, hasPrompt: params.hasPrompt, hasHint: true });
  chromes.push({ boxed: false, hasPrompt: false, hasHint: true });
  chromes.push({ boxed: false, hasPrompt: false, hasHint: false });

  const tryFit = (
    header: string[],
    chrome: { boxed: boolean; hasPrompt: boolean; hasHint: boolean },
  ): HomeFrameFit | null => {
    const chromeRows = promptChromeRows(chrome.boxed, chrome.hasPrompt, chrome.hasHint);
    const avail = rows - header.length - chromeRows;
    if (avail < 0) return null;
    if (params.dockBottom) {
      return { header, reserve: avail, ...chrome };
    }
    if (want === 0) {
      return { header, reserve: 0, ...chrome };
    }
    const maxList = Math.max(0, Math.min(DROPDOWN_MAX_COMMAND_ROWS, avail));
    if (maxList < 1) return null;
    return { header, reserve: Math.min(want, maxList), ...chrome };
  };

  // Prefer keeping the input boxed: try every header density at the
  // current chrome before unboxing. Otherwise a 12-row pane would pick
  // the full banner + a plain prompt over compact + boxed.
  for (const chrome of chromes) {
    for (const header of headers) {
      const hit = tryFit(header, chrome);
      if (hit) return hit;
    }
  }

  const fallback = params.nanoHeader?.length
    ? params.nanoHeader
    : params.miniHeader?.length
      ? params.miniHeader
      : [];
  return {
    header: fallback,
    reserve: params.dockBottom ? Math.max(0, rows - fallback.length - 1) : 0,
    boxed: false,
    hasPrompt: false,
    hasHint: false,
  };
}

export function dropdownOverlayRows(
  dropdown: CommandSpec[],
  index: number,
  maxRows: number,
): OverlayRow[] {
  const max = Math.max(1, maxRows);
  if (dropdown.length <= max) {
    return dropdown.map((spec, i) => ({
      text: `  ${formatSlashLabel(spec).padEnd(22)}${spec.summary}`,
      selected: i === index,
    }));
  }
  const cmdSlots = Math.max(1, max - 2);
  const view = dropdownViewport(dropdown.length, index, cmdSlots);
  const rows: OverlayRow[] = [];
  if (view.moreAbove > 0) rows.push({ text: `  \u2191 ${view.moreAbove} more` });
  const end = Math.min(dropdown.length, view.start + cmdSlots);
  for (let i = view.start; i < end; i++) {
    const spec = dropdown[i]!;
    rows.push({
      text: `  ${formatSlashLabel(spec).padEnd(22)}${spec.summary}`,
      selected: i === index,
    });
  }
  if (view.moreBelow > 0) rows.push({ text: `  \u2193 ${view.moreBelow} more` });
  return rows.slice(0, max);
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
export function inputCells(
  columns: number | undefined,
  boxedOverride?: boolean,
): { boxed: boolean; cells: number } {
  const boxed = boxedOverride ?? preferBoxedUi(columns);
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
  /**
   * When set, the overlay is padded to this many rows and drawn **above**
   * the input bar. Height stays constant so `/` cannot scroll the header.
   */
  overlayReserve?: number;
  /** Trailing footer row (empty or the Ctrl+C hint). */
  hint?: string;
  /** Welcome-panel rows painted with this frame (idle home screen). */
  header?: string[];
  /** Force boxed / plain input. Default follows {@link preferBoxedUi}. */
  boxed?: boolean;
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
  const { boxed, cells } = inputCells(params.columns, params.boxed);
  const cols = terminalColumns(80, params.columns);
  const win = inputWindow(params.buffer, params.cursor, cells, params.scrollStart ?? 0);
  const header = params.header ?? [];
  const reserve = params.overlayReserve;
  const overlay = params.overlay ?? [];
  const fitted = reserve != null ? padOverlayRows(overlay, reserve) : overlay;
  const inputRow =
    header.length +
    (reserve ?? 0) +
    (params.prompt ? 1 : 0) +
    (boxed ? 1 : 0);

  // Nothing we emit may wrap: a wrapped row is one the CUU count can't see.
  const clip = (text: string): string =>
    visibleWidth(text) > cols - 1 ? sliceVisible(text, 0, cols - 1) : text;

  const paintOverlay = (row: OverlayRow): string => {
    const text = clip(row.text);
    return row.selected ? ansi.invert(text) : ansi.gray(text);
  };

  const rows: string[] = [];
  if (reserve != null) {
    for (const line of header) rows.push(clip(line));
    for (const row of fitted) rows.push(paintOverlay(row));
  } else {
    for (const line of header) rows.push(clip(line));
  }
  if (params.prompt) rows.push(clip(params.prompt));
  const inputLine = `${ansi.brightGreen(INPUT_PREFIX_GLYPH)} ${win.text}`;
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
  if (reserve == null) {
    for (const row of overlay) rows.push(paintOverlay(row));
  }
  if (params.hint != null) {
    rows.push(clip(params.hint === "" ? " " : params.hint));
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
    let scrollStart = 0;
    let finished = false;
    let exitHint = false;
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

    let lastRoom = 24;

    function paint(): void {
      const columns = opts.columns ?? output.columns;
      const boxedNow = preferBoxedUi(columns);
      const rawRoom = opts.rows ?? output.rows;
      const room =
        typeof rawRoom === "number" && Number.isFinite(rawRoom) && rawRoom >= 1
          ? rawRoom
          : lastRoom;
      lastRoom = room;
      const fullHeader = opts.header ? opts.header(columns, false) : [];
      const compactHeader = opts.header ? opts.header(columns, true) : [];
      const miniHeader = opts.header ? opts.header(columns, "mini") : [];
      const nanoHeader = opts.header ? opts.header(columns, "nano") : [];

      const dropdown = currentDropdown();
      if (dropdown.length) {
        if (dropdownIndex >= dropdown.length) dropdownIndex = dropdown.length - 1;
      } else {
        dropdownIndex = 0;
      }

      const roomRows = resolvedRows(room);
      const fit = opts.header
        ? fitHomeFrame({
            fullHeader,
            compactHeader,
            miniHeader,
            nanoHeader,
            terminalRows: room,
            boxed: boxedNow,
            hasPrompt: Boolean(opts.prompt),
            dropdownCount: dropdown.length,
            dockBottom: true,
          })
        : {
            header: [] as string[],
            reserve: overlayReserve(room, 0, boxedNow, Boolean(opts.prompt)),
            boxed: boxedNow,
            hasPrompt: Boolean(opts.prompt),
            hasHint: true,
          };

      const overlay = dropdown.length
        ? dropdownOverlayRows(
            dropdown,
            dropdownIndex,
            Math.max(1, Math.min(DROPDOWN_MAX_COMMAND_ROWS, fit.reserve)),
          )
        : [];

      const frame = buildPromptFrame({
        prompt: fit.hasPrompt ? opts.prompt : undefined,
        buffer,
        cursor,
        columns,
        scrollStart,
        overlay,
        overlayReserve: opts.header || dropdown.length ? fit.reserve : undefined,
        header: fit.header,
        hint: fit.hasHint ? (exitHint ? ansi.dim(CTRL_C_EXIT_HINT) : " ") : undefined,
        boxed: fit.boxed,
      });

      // Never write more rows than the pane — that scrolls the welcome
      // tail (tips / what's new) into view and looks like a broken frame.
      if (frame.rows.length > roomRows) {
        const keep = frame.rows.slice(frame.rows.length - roomRows);
        const shift = frame.rows.length - keep.length;
        frame.rows = keep;
        frame.inputRow = Math.max(0, frame.inputRow - shift);
      }

      // Home screen owns the pane: always origin + ED 0. Relative CUU after
      // a split-drag is what tore the previous layout (cursor home vs
      // includeHeader flipping mid-resize).
      if (opts.header) {
        output.write(HEADER_REDRAW_PREFIX);
      } else if (linesDrawn > 0) {
        output.write(promptRedrawPrefix(drawnInputRow));
      }

      // A full-pane write plus a trailing newline scrolls row 1 into
      // scrollback — that was the missing top border. Stop on the last
      // cell of the last row and CUU from there.
      const fillsPane = Boolean(opts.header) && frame.rows.length >= roomRows;
      output.write(frame.rows.join("\r\n") + (fillsPane ? "" : "\r\n"));
      linesDrawn = frame.rows.length;
      drawnInputRow = frame.inputRow;
      scrollStart = frame.scrollStart;

      const fromRow = fillsPane ? linesDrawn - 1 : linesDrawn;
      output.write(`${up(Math.max(0, fromRow - frame.inputRow))}${col(frame.targetCol)}`);
    }

    function render(): void {
      paint();
    }

    function onResize(): void {
      if (finished) return;
      paint();
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

      // Home chrome already fills the pane. down() + newline scrolls that
      // frame (cursor to the bottom, input jumps up) before /usage paints.
      // Leave the idle screen in place; the next TUI / askLine homes over it.
      // Bare prompts still need the newline so oneshot output starts below.
      // Leaving the shell: one newline so the OS prompt is not on the box.
      if (!opts.header || err instanceof PromptClosedError) {
        if (linesDrawn > 0) {
          const below = linesDrawn - drawnInputRow - 1;
          if (below > 0) output.write(down(below));
        }
        output.write("\n");
      }

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
        if (!(key.ctrl && key.name === "c")) {
          ctrlCExit.reset();
          exitHint = false;
        }
        const dropdown = currentDropdown();

        if (key.ctrl && key.name === "c") {
          if (ctrlCExit.press()) {
            finish(null, new PromptClosedError());
            return;
          }
          exitHint = true;
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
