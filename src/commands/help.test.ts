import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHelpTabs, helpTabIndex } from "./help.js";

const STRIP = /\u001b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(STRIP, "");

test("help tabs cover start, commands, and stacks without a wall of text", () => {
  const tabs = buildHelpTabs();
  assert.deepEqual(tabs.map((t) => t.id), ["start", "commands", "stacks"]);
  const text = strip(tabs.flatMap((t) => t.lines).join("\n"));
  assert.match(text, /review/);
  assert.match(text, /usage/);
  assert.match(text, /stack create/);
  assert.match(text, /stack submit/);
  assert.match(text, /--onto/);
  assert.match(text, /stack adopt/);
  const longest = Math.max(...tabs.flatMap((t) => t.lines.map((l) => strip(l).length)));
  assert.ok(longest < 80, `a help row is a wall (${longest})`);
  for (const tab of tabs) {
    assert.ok(tab.lines.length <= 18, `${tab.id} has too many rows`);
  }
});

test("helpTabIndex opens the Stacks page for /stack", () => {
  assert.equal(helpTabIndex("stacks"), 2);
  assert.equal(helpTabIndex("nope"), 0);
});
