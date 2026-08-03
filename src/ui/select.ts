import * as readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { ansi } from "./ansi.js";

export type SelectOptions<T> = {
  title?: string;
  items: T[];
  render: (item: T, index: number) => string;
  /** Hint printed under the list (default: arrow/enter/esc keys). */
  hint?: string;
};

const up = (n: number) => `\u001b[${n}A`;
const clearDown = "\u001b[0J";

/**
 * Raw-mode arrow-key list selector (Claude-style). Returns the chosen item, or
 * `null` if cancelled / empty. Non-TTY: prints a numbered list and returns null
 * (caller should fall back to a table / prompt).
 */
export async function selectFromList<T>(opts: SelectOptions<T>): Promise<T | null> {
  const items = opts.items;
  if (items.length === 0) return null;

  if (!input.isTTY || !output.isTTY) {
    if (opts.title) console.log(ansi.bold(`  ${opts.title}`));
    items.forEach((item, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${opts.render(item, i)}`);
    });
    console.log(
      ansi.dim(
        opts.hint ?? "  (non-interactive — use `chain <slug>` or re-run on a TTY to select)",
      ),
    );
    return null;
  }

  return new Promise<T | null>((resolve) => {
    let index = 0;
    let linesDrawn = 0;
    let finished = false;
    const wasRaw = Boolean(input.isRaw);

    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    function render(): void {
      if (linesDrawn > 0) {
        output.write(`${up(linesDrawn)}${clearDown}`);
      }
      const rows: string[] = [];
      if (opts.title) rows.push(ansi.bold(opts.title));
      items.forEach((item, i) => {
        const body = opts.render(item, i);
        const marker = i === index ? ansi.green("›") : " ";
        const line = ` ${marker} ${body}`;
        rows.push(i === index ? ansi.invert(line) : line);
      });
      rows.push(
        ansi.dim(opts.hint ?? "↑↓ navigate · enter select · esc cancel"),
      );
      output.write(rows.join("\r\n") + "\r\n");
      linesDrawn = rows.length;
    }

    function cleanup(): void {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
    }

    function finish(value: T | null): void {
      if (finished) return;
      finished = true;
      cleanup();
      output.write("\n");
      resolve(value);
    }

    function onKeypress(_str: string, key: readline.Key): void {
      if (finished || !key) return;
      if (key.name === "up") {
        index = (index - 1 + items.length) % items.length;
        try { render(); } catch { finish(null); }
        return;
      }
      if (key.name === "down") {
        index = (index + 1) % items.length;
        try { render(); } catch { finish(null); }
        return;
      }
      if (key.name === "return") {
        finish(items[index]!);
        return;
      }
      if (
        key.name === "escape" ||
        key.name === "q" ||
        (key.ctrl && key.name === "c")
      ) {
        finish(null);
      }
    }

    input.on("keypress", onKeypress);
    try { render(); } catch { finish(null); }
  });
}
