import * as readline from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ansi } from "./ansi.js";
import { frameWidth, preferBoxedUi, roundedBox, visibleWidth } from "./box.js";
import { CTRL_C_EXIT_HINT, CtrlCExitGate } from "./ctrl-c-exit.js";

export interface CommandSpec {
  name: string;
  summary: string;
}

export interface AskLineOptions {
  prompt?: string;
  history?: string[];
  commands?: CommandSpec[];
}

/** Thrown when the user asks to close the prompt (Ctrl+D empty, or Ctrl+C twice). */
export class PromptClosedError extends Error {
  constructor() {
    super("prompt closed");
    this.name = "PromptClosedError";
  }
}

const up = (n: number) => `[${n}A`;
const down = (n: number) => `[${n}B`;
const col = (n: number) => `[${n}G`;
const clearDown = "[0J";

async function fallbackAskLine(promptLabel?: string): Promise<string> {
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

  if (!input.isTTY || !output.isTTY) {
    return fallbackAskLine(opts.prompt);
  }

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let cursor = 0;
    let historyIndex = history.length;
    let dropdownIndex = 0;
    let linesDrawn = 0;
    let finished = false;
    const ctrlCExit = new CtrlCExitGate();

    const wasRaw = Boolean(input.isRaw);
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    const boxed = preferBoxedUi();
    // Row (0-based) of the "› buffer" content line among the rows we draw each frame.
    // Boxed: optional prompt + top border + content. Plain: optional prompt + content.
    const inputRow = (opts.prompt ? 1 : 0) + (boxed ? 1 : 0);

    function currentDropdown(): CommandSpec[] {
      if (!buffer.startsWith("/")) return [];
      const term = buffer.slice(1).toLowerCase();
      return commands.filter((c) => c.name.toLowerCase().startsWith(term));
    }

    function render(): void {
      if (linesDrawn > 0) {
        output.write(`${up(inputRow)}${clearDown}`);
      }

      const rows: string[] = [];
      if (opts.prompt) rows.push(ansi.dim(opts.prompt));
      const inputLine = `${ansi.green("›")} ${buffer}`;
      if (boxed) {
        // Full terminal width input frame, not content-sized.
        rows.push(...roundedBox([inputLine], { padding: 1, width: frameWidth() }));
      } else {
        // Plain prompt on narrow TTYs (avoids wrapped borders).
        rows.push(inputLine);
      }

      const dropdown = currentDropdown();
      if (dropdown.length) {
        if (dropdownIndex >= dropdown.length) dropdownIndex = dropdown.length - 1;
        dropdown.forEach((c, i) => {
          const label = `  /${c.name.padEnd(12)}${c.summary}`;
          rows.push(i === dropdownIndex ? ansi.invert(label) : ansi.gray(label));
        });
      } else {
        dropdownIndex = 0;
      }

      output.write(rows.join("\r\n") + "\r\n");
      linesDrawn = rows.length;

      const prefixWidth = visibleWidth(`${ansi.green("›")} `);
      // Boxed: border col + padding; plain: column 1.
      const targetCol = (boxed ? 1 + 1 : 0) + prefixWidth + cursor + 1;
      output.write(`${up(linesDrawn - inputRow)}${col(targetCol)}`);
    }

    function cleanup(): void {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(wasRaw);
      // emitKeypressEvents leaves stdin flowing; pause it so an idle shell
      // (no command running) doesn't keep the process alive after exit/EOF.
      input.pause();
    }

    function finish(value: string | null, err?: unknown): void {
      if (finished) return;
      finished = true;
      cleanup();

      const rowsBelow = Math.max(0, linesDrawn - inputRow - 1);
      if (rowsBelow > 0) output.write(down(rowsBelow));
      output.write("\n");

      if (err) reject(err);
      else resolve(value ?? "");
    }

    function acceptDropdown(dropdown: CommandSpec[]): void {
      buffer = `/${dropdown[dropdownIndex]!.name} `;
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
          buffer = "";
          cursor = 0;
          historyIndex = history.length;
          const rowsBelow = Math.max(0, linesDrawn - inputRow - 1);
          if (rowsBelow > 0) output.write(down(rowsBelow));
          output.write(`\n${ansi.dim(CTRL_C_EXIT_HINT)}\n`);
          linesDrawn = 0;
          render();
          return;
        }
        if (key.ctrl && key.name === "d") {
          if (!buffer) finish(null, new PromptClosedError());
          return;
        }
        if (key.name === "return") {
          if (dropdown.length) buffer = `/${dropdown[dropdownIndex]!.name}`;
          finish(buffer);
          return;
        }
        if (key.name === "tab") {
          if (dropdown.length) acceptDropdown(dropdown);
          render();
          return;
        }
        if (key.name === "right") {
          if (dropdown.length) acceptDropdown(dropdown);
          else cursor = Math.min(buffer.length, cursor + 1);
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
            dropdownIndex = (dropdownIndex - 1 + dropdown.length) % dropdown.length;
          } else if (history.length) {
            historyIndex = Math.max(0, historyIndex - 1);
            buffer = history[historyIndex] ?? "";
            cursor = buffer.length;
          }
          render();
          return;
        }
        if (key.name === "down") {
          if (dropdown.length) {
            dropdownIndex = (dropdownIndex + 1) % dropdown.length;
          } else if (history.length) {
            historyIndex = Math.min(history.length, historyIndex + 1);
            buffer = historyIndex >= history.length ? "" : history[historyIndex] ?? "";
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
          buffer = buffer.slice(cursor);
          cursor = 0;
          render();
          return;
        }
        if (key.ctrl && key.name === "k") {
          buffer = buffer.slice(0, cursor);
          render();
          return;
        }
        if (key.name === "backspace") {
          if (cursor > 0) {
            buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
            cursor -= 1;
          }
          render();
          return;
        }
        if (key.name === "delete") {
          buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
          render();
          return;
        }
        if (str && !key.ctrl && !key.meta) {
          buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
          cursor += str.length;
          render();
        }
      } catch (err) {
        finish(null, err);
      }
    }

    input.on("keypress", onKeypress);
    render();
  });
}
