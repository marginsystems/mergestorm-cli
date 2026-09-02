import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialLineTabsState,
  layoutLineTabs,
  reduceLineTabsKey,
  showLinePanel,
  type LineTab,
} from "./line-tabs.js";
import { visibleWidth } from "./width.js";

const STRIP = /\u001b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(STRIP, "");

const TABS: LineTab[] = [
  { id: "a", label: "Start", lines: ["  one", "  two", "  three"] },
  { id: "b", label: "Commands", lines: Array.from({ length: 20 }, (_, i) => `  row ${i}`) },
  { id: "c", label: "Stacks", lines: ["  stack"] },
];

test("layoutLineTabs titles the active tab and stays inside the frame", () => {
  const layout = layoutLineTabs(TABS, initialLineTabsState(3), 80, 16, false);
  const text = strip(layout.lines.join("\n"));
  assert.match(text, /\[Start\]/);
  assert.match(text, /Commands/);
  assert.match(text, /one/);
  for (const row of layout.lines) assert.ok(visibleWidth(row) <= 79);
});

test("reduceLineTabsKey clamps tabs and scrolls the active page", () => {
  let state = initialLineTabsState(3);
  let step = reduceLineTabsKey(state, "left", 3, 10);
  if (step.kind === "state") state = step.state;
  assert.equal(state.index, 0);
  step = reduceLineTabsKey(state, "right", 3, 10);
  if (step.kind === "state") state = step.state;
  assert.equal(state.index, 1);
  step = reduceLineTabsKey(state, "down", 3, 10);
  if (step.kind === "state") state = step.state;
  assert.equal(state.scroll[1], 1);
  step = reduceLineTabsKey(state, "q", 3, 10);
  assert.equal(step.kind, "close");
});

test("showLinePanel prints lines on a non-TTY", async () => {
  const out: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  try {
    await showLinePanel("Chain", ["  none yet", "  stack create"]);
  } finally {
    console.log = original;
  }
  assert.deepEqual(out, ["  none yet", "  stack create"]);
});
