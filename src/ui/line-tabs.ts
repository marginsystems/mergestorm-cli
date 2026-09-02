import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import { ansi } from "./ansi.js";
import {
  frameWidth,
  preferBoxedUi,
  roundedBox,
  terminalColumns,
} from "./box.js";
import { padVisible, visibleWidth } from "./width.js";
import { tabsBodyRows, tabsHintLine, type TabsLayout } from "./tabs.js";

export type LineTab = {
  id: string;
  label: string;
  lines: string[];
};

export type LineTabsState = {
  index: number;
  scroll: number[];
};

export function initialLineTabsState(tabCount: number, start = 0): LineTabsState {
  const n = Math.max(1, tabCount);
  return {
    index: Math.max(0, Math.min(start, n - 1)),
    scroll: Array.from({ length: n }, () => 0),
  };
}

export function reduceLineTabsKey(
  state: LineTabsState,
  key: "left" | "right" | "up" | "down" | "escape" | "q",
  tabCount: number,
  maxScroll: number,
): { kind: "close" } | { kind: "state"; state: LineTabsState } {
  if (key === "q" || key === "escape") return { kind: "close" };
  const last = Math.max(0, tabCount - 1);
  if (key === "left") {
    return { kind: "state", state: { ...state, index: Math.max(0, state.index - 1) } };
  }
  if (key === "right") {
    return { kind: "state", state: { ...state, index: Math.min(last, state.index + 1) } };
  }
  const scroll = state.scroll.slice();
  const at = state.index;
  if (key === "up") scroll[at] = Math.max(0, (scroll[at] ?? 0) - 1);
  if (key === "down") scroll[at] = Math.min(maxScroll, (scroll[at] ?? 0) + 1);
  return { kind: "state", state: { ...state, scroll } };
}

function titleOf(tabs: LineTab[], index: number, color: boolean): string {
  const parts = tabs.map((tab, i) => {
    if (!color) return i === index ? `[${tab.label}]` : ` ${tab.label} `;
    return i === index ? ansi.boldBrightGreen(tab.label) : ansi.dim(tab.label);
  });
  return parts.join(color ? ansi.dim(" · ") : " · ");
}

export function layoutLineTabs(
  tabs: LineTab[],
  state: LineTabsState,
  columns?: number,
  rows?: number,
  color = false,
): TabsLayout {
  const boxed = preferBoxedUi(columns);
  const cols = terminalColumns(80, columns);
  const outer = frameWidth(80, columns);
  const contentCells = boxed ? Math.max(20, outer - 4) : Math.max(20, cols - 1);
  const bodyRows = tabsBodyRows(rows);
  const tab = tabs[state.index] ?? tabs[0];
  const content = tab ? tab.lines : [];
  const start = Math.min(
    Math.max(0, state.scroll[state.index] ?? 0),
    Math.max(0, content.length - bodyRows),
  );
  const clip = (line: string): string =>
    visibleWidth(line) > contentCells ? padVisible(line, contentCells) : line;
  const body = content.slice(start, start + bodyRows).map(clip);
  while (body.length < bodyRows) body.push("");

  const hint = tabsHintLine("←→ tabs · ↑↓ scroll · esc close", undefined, cols, color);
  const title = titleOf(tabs, state.index, color);
  if (!boxed) {
    const plainTitle = visibleWidth(title) > cols - 1 ? padVisible(title, cols - 1) : title;
    return { lines: [plainTitle, ...body, hint], bodyRows, contentRows: content.length };
  }
  return {
    lines: [...roundedBox(body, { title, width: outer, padding: 1 }), hint],
    bodyRows,
    contentRows: content.length,
  };
}

const up = (n: number) => `\u001b[${n}A`;
const clearDown = "\u001b[0J";
const homeClear = `\u001b[H${clearDown}`;

/** Hold-to-read panel. TTY: tabbed frame. Pipe: print the lines. */
export async function showLinePanel(label: string, lines: string[]): Promise<void> {
  const input = stdin;
  const output = stdout;
  if (!input.isTTY || !output.isTTY) {
    for (const line of lines) console.log(line);
    return;
  }
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "page";
  await runLineTabsBrowser({ tabs: [{ id, label, lines }] });
}

export async function runLineTabsBrowser(opts: {
  tabs: LineTab[];
  initial?: number;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  color?: boolean;
}): Promise<void> {
  const input = opts.input ?? stdin;
  const output = opts.output ?? stdout;
  const tabs = opts.tabs;
  const color = opts.color ?? ansi.enabled;

  if (!input.isTTY || !output.isTTY) {
    for (const tab of tabs) {
      console.log(`  ${tab.label}`);
      for (const line of tab.lines) console.log(line);
      console.log("");
    }
    return;
  }

  return new Promise<void>((resolve) => {
    let state = initialLineTabsState(tabs.length, opts.initial ?? 0);
    let lastLayout: TabsLayout | null = null;
    let linesDrawn = 0;
    let finished = false;
    const wasRaw = Boolean(input.isRaw);

    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    function render(prefix?: string): void {
      if (prefix) output.write(prefix);
      else if (linesDrawn > 0) output.write(`${up(linesDrawn)}\r${clearDown}`);
      lastLayout = layoutLineTabs(tabs, state, output.columns, output.rows, color);
      output.write(lastLayout.lines.join("\r\n") + "\r\n");
      linesDrawn = lastLayout.lines.length;
    }

    function finish(): void {
      if (finished) return;
      finished = true;
      input.removeListener("keypress", onKeypress);
      output.removeListener("resize", onResize);
      input.setRawMode(wasRaw);
      input.pause();
      if (linesDrawn > 0) output.write(`${up(linesDrawn)}\r${clearDown}`);
      resolve();
    }

    function onResize(): void {
      if (!finished) render(homeClear);
    }

    function onKeypress(str: string, key: readline.Key): void {
      if (finished || !key) return;
      if (key.ctrl && key.name === "c") {
        finish();
        return;
      }
      let name: "left" | "right" | "up" | "down" | "escape" | "q" | null = null;
      if (key.name === "left" || key.name === "right" || key.name === "up" || key.name === "down") {
        name = key.name;
      } else if (key.name === "escape") name = "escape";
      else if (key.name === "q" || str === "q") name = "q";
      if (!name) return;
      const maxScroll = lastLayout
        ? Math.max(0, lastLayout.contentRows - lastLayout.bodyRows)
        : 0;
      const step = reduceLineTabsKey(state, name, tabs.length, maxScroll);
      if (step.kind === "close") {
        finish();
        return;
      }
      state = step.state;
      try {
        render();
      } catch {
        finish();
      }
    }

    input.on("keypress", onKeypress);
    output.on("resize", onResize);
    try {
      render(homeClear);
    } catch {
      finish();
    }
  });
}
