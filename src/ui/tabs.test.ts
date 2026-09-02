import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  initialTabsState,
  layoutTabs,
  reduceTabsKey,
  runTabsBrowser,
  tabsBodyRows,
  tabsHintLine,
  tabsMaxScroll,
  type TabsConfigRow,
  type TabsData,
  type TabsState,
} from "./tabs.js";
import { visibleWidth } from "./width.js";

const STRIP_ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(STRIP_ANSI, "");

function fixtureConfig(): TabsConfigRow[] {
  return [
    { key: "auto_review_enabled", label: "Auto review", value: true, writable: true },
    { key: "auto_patch_enabled", label: "Auto patch", value: false, writable: true },
    { key: "cyclone_connected", label: "Cyclone", value: false, writable: false },
    { key: "github_connected", label: "GitHub", value: true, writable: false },
  ];
}

function fixtureData(jobCount = 12): TabsData {
  return {
    statusLines: [
      "  Key     msk_live_abcd (laptop)",
      "  Plan    maelstrom",
      "  API     https://mergestorm.ai",
      "  Credits 7 / 100 used · 93 left",
      "  Resets  Resets Sep 1, 12:00am (UTC) · 7 days left",
    ],
    footerNote: "API reachable",
    usage: {
      keyPrefix: "msk_live_abcd",
      plan: "maelstrom",
      used: 7,
      limit: 100,
      resetsAt: "2026-09-01T00:00:00.000Z",
      jobs: [
        {
          job: "job_0000",
          verdict: "approve",
          thread: "local/feat/x",
          credits: "1",
          when: "2h ago",
        },
      ],
    },
    jobs: Array.from({ length: jobCount }, (_, i) => ({
      id: `job_${String(i).padStart(4, "0")}xyz`,
      cells: {
        job: `job_${String(i).padStart(4, "0")}`,
        status: "completed",
        verdict: i % 2 ? "approve" : "request_changes",
        thread: "local/feat/very-long-branch",
        when: `${i + 1}h ago`,
      },
    })),
    config: fixtureConfig(),
    color: false,
  };
}

// --- layoutTabs -------------------------------------------------------------

test("layoutTabs at 60 and 120 columns never exceeds the frame", () => {
  for (const columns of [60, 120]) {
    for (const tab of ["status", "usage", "jobs", "config"] as const) {
      const layout = layoutTabs(initialTabsState(tab), fixtureData(), columns, 24);
      for (const line of layout.lines) {
        assert.ok(
          visibleWidth(line) <= columns - 1,
          `${tab}@${columns}: "${line}" is ${visibleWidth(line)} cells`,
        );
      }
    }
  }
});

test("layoutTabs fits the terminal height (body scrolls in rows - 4)", () => {
  const layout = layoutTabs(initialTabsState("jobs"), fixtureData(30), 100, 24);
  assert.equal(layout.bodyRows, tabsBodyRows(24));
  assert.equal(layout.bodyRows, 20);
  // top border + body + bottom border + hint stays inside the pane.
  assert.ok(layout.lines.length <= 23, String(layout.lines.length));

  const short = layoutTabs(initialTabsState("jobs"), fixtureData(30), 100, 10);
  assert.ok(short.lines.length <= 9, String(short.lines.length));
});

test("layoutTabs keeps a constant frame height across tabs", () => {
  const data = fixtureData();
  const heights = (["status", "usage", "jobs", "config"] as const).map(
    (tab) => layoutTabs(initialTabsState(tab), data, 100, 24).lines.length,
  );
  assert.equal(new Set(heights).size, 1, heights.join(","));
});

test("layoutTabs titles the frame with all four tabs, active marked", () => {
  const layout = layoutTabs(initialTabsState("usage"), fixtureData(), 100, 24);
  const top = stripAnsi(layout.lines[0]!);
  assert.match(top, /Status/);
  assert.match(top, /\[Usage\]/);
  assert.match(top, /Jobs/);
  assert.match(top, /Config/);
  assert.match(stripAnsi(layout.lines.join("\n")), /7% used/);
});

test("layoutTabs jobs tab shows the table and follows the selection", () => {
  const data = fixtureData(30);
  const state: TabsState = { ...initialTabsState("jobs"), jobsIndex: 29 };
  const layout = layoutTabs(state, data, 100, 24);
  const text = stripAnsi(layout.lines.join("\n"));
  assert.match(text, /JOB\s+STATUS\s+VERDICT\s+THREAD\s+WHEN/);
  // The selected last row scrolled into view, marked.
  assert.match(text, /› job_0029/);
  assert.doesNotMatch(text, /job_0000\b/);
});

test("layoutTabs below 48 columns falls back to a plain frame", () => {
  const layout = layoutTabs(initialTabsState("status"), fixtureData(), 40, 24);
  for (const line of layout.lines) {
    assert.ok(visibleWidth(line) <= 39, `"${line}"`);
    assert.ok(!/^[╭╰│+|]/.test(stripAnsi(line)), `no border in "${line}"`);
  }
  assert.match(stripAnsi(layout.lines[0]!), /\[Status\]/);
});

test("layoutTabs renders a detail view in place with scroll", () => {
  const detailRows = Array.from({ length: 40 }, (_, i) => `  detail line ${i}`);
  const state: TabsState = {
    ...initialTabsState("jobs"),
    detail: { jobId: "job_0003xyz", rows: detailRows },
    scroll: { status: 0, usage: 0, detail: 5 },
  };
  const layout = layoutTabs(state, fixtureData(), 100, 24);
  const text = stripAnsi(layout.lines.join("\n"));
  assert.match(text, /detail line 5/);
  assert.doesNotMatch(text, /detail line 4\b/);
  assert.match(stripAnsi(layout.lines[0]!), /Jobs › job_0003/);
  assert.equal(layout.contentRows, 40);
  assert.equal(tabsMaxScroll(layout), 40 - layout.bodyRows);
});

test("tabsHintLine pins the reachability note on the right", () => {
  const line = tabsHintLine("←→ tabs · esc close", "API reachable", 60, false);
  const text = stripAnsi(line);
  assert.ok(text.startsWith(" ←→ tabs"));
  assert.ok(text.endsWith("API reachable"));
  assert.ok(text.includes("  "), "left and right are separated");
  assert.doesNotMatch(text, /●/);
});

test("layoutTabs says so when usage data is unavailable", () => {
  const data: TabsData = { ...fixtureData(), usage: null };
  const layout = layoutTabs(initialTabsState("usage"), data, 100, 24);
  assert.match(stripAnsi(layout.lines.join("\n")), /Usage unavailable/);
});

test("layoutTabs config tab lists toggles and connected flags with a selection", () => {
  const state: TabsState = { ...initialTabsState("config"), configIndex: 1 };
  const layout = layoutTabs(state, fixtureData(), 100, 24);
  const text = stripAnsi(layout.lines.join("\n"));
  assert.match(text, /Auto review\s+on/);
  assert.match(text, /› Auto patch\s+off/);
  assert.match(text, /Cyclone\s+not connected/);
  assert.match(text, /GitHub\s+connected/);
  assert.match(text, /space toggle/);
});

test("layoutTabs says so when settings are unavailable", () => {
  const data: TabsData = { ...fixtureData(), config: null };
  const layout = layoutTabs(initialTabsState("config"), data, 100, 24);
  assert.match(stripAnsi(layout.lines.join("\n")), /Settings unavailable/);
});

test("layoutTabs renders the config note under the rows", () => {
  const data: TabsData = { ...fixtureData(), configNote: "Connect Cyclone to enable auto-patch." };
  const layout = layoutTabs(initialTabsState("config"), data, 100, 24);
  assert.match(stripAnsi(layout.lines.join("\n")), /Connect Cyclone/);
});

// --- reduceTabsKey ----------------------------------------------------------

const CTX = { jobsCount: 12, maxScroll: 10 };

test("left/right switch tabs and clamp at the ends (no wrap-around)", () => {
  let state = initialTabsState("status");
  let step = reduceTabsKey(state, "left", CTX);
  assert.equal(step.kind, "state");
  if (step.kind === "state") assert.equal(step.state.tab, "status");

  step = reduceTabsKey(state, "right", CTX);
  if (step.kind === "state") state = step.state;
  assert.equal(state.tab, "usage");
  step = reduceTabsKey(state, "right", CTX);
  if (step.kind === "state") state = step.state;
  assert.equal(state.tab, "jobs");
  step = reduceTabsKey(state, "right", CTX);
  if (step.kind === "state") state = step.state;
  assert.equal(state.tab, "config");
  step = reduceTabsKey(state, "right", CTX);
  if (step.kind === "state") state = step.state;
  assert.equal(state.tab, "config", "right past the last tab stays put");
});

test("up/down scroll the body and clamp to the content", () => {
  let state = initialTabsState("usage");
  let step = reduceTabsKey(state, "up", CTX);
  if (step.kind === "state") state = step.state;
  assert.equal(state.scroll.usage, 0, "cannot scroll above the top");
  for (let i = 0; i < 20; i++) {
    step = reduceTabsKey(state, "down", CTX);
    if (step.kind === "state") state = step.state;
  }
  assert.equal(state.scroll.usage, CTX.maxScroll, "clamped to maxScroll");
});

test("up/down on the jobs tab move the selection and clamp", () => {
  let state = initialTabsState("jobs");
  let step = reduceTabsKey(state, "up", CTX);
  if (step.kind === "state") state = step.state;
  assert.equal(state.jobsIndex, 0);
  for (let i = 0; i < 20; i++) {
    step = reduceTabsKey(state, "down", CTX);
    if (step.kind === "state") state = step.state;
  }
  assert.equal(state.jobsIndex, CTX.jobsCount - 1);
});

test("up/down on the config tab move the selection and clamp", () => {
  const ctx = { ...CTX, config: fixtureConfig() };
  let state = initialTabsState("config");
  let step = reduceTabsKey(state, "up", ctx);
  if (step.kind === "state") state = step.state;
  assert.equal(state.configIndex, 0);
  for (let i = 0; i < 10; i++) {
    step = reduceTabsKey(state, "down", ctx);
    if (step.kind === "state") state = step.state;
  }
  assert.equal(state.configIndex, ctx.config.length - 1);
});

test("space on a writable config row requests a toggle to the flipped value", () => {
  const ctx = { ...CTX, config: fixtureConfig() };
  const state: TabsState = { ...initialTabsState("config"), configIndex: 1 };
  const step = reduceTabsKey(state, "space", ctx);
  assert.equal(step.kind, "toggle-setting");
  if (step.kind === "toggle-setting") {
    assert.equal(step.key, "auto_patch_enabled");
    assert.equal(step.value, true, "off row toggles to on");
  }
});

test("space on a read-only config row is a no-op", () => {
  const ctx = { ...CTX, config: fixtureConfig() };
  const state: TabsState = { ...initialTabsState("config"), configIndex: 2 };
  const step = reduceTabsKey(state, "space", ctx);
  assert.equal(step.kind, "state");
  if (step.kind === "state") assert.deepEqual(step.state, state);
});

test("space outside the config tab is a no-op", () => {
  const ctx = { ...CTX, config: fixtureConfig() };
  for (const tab of ["status", "usage", "jobs"] as const) {
    const step = reduceTabsKey(initialTabsState(tab), "space", ctx);
    assert.equal(step.kind, "state");
  }
});

test("enter on the jobs tab opens the selected job", () => {
  const state: TabsState = { ...initialTabsState("jobs"), jobsIndex: 3 };
  const step = reduceTabsKey(state, "return", CTX);
  assert.equal(step.kind, "open-job");
  if (step.kind === "open-job") assert.equal(step.index, 3);
});

test("enter elsewhere is a no-op", () => {
  const step = reduceTabsKey(initialTabsState("usage"), "return", CTX);
  assert.equal(step.kind, "state");
});

test("esc closes the browser, but backs out of a detail first", () => {
  assert.equal(reduceTabsKey(initialTabsState("usage"), "escape", CTX).kind, "close");
  const withDetail: TabsState = {
    ...initialTabsState("jobs"),
    detail: { jobId: "job_x", rows: ["  x"] },
    scroll: { status: 0, usage: 0, detail: 4 },
  };
  const step = reduceTabsKey(withDetail, "escape", CTX);
  assert.equal(step.kind, "state");
  if (step.kind === "state") {
    assert.equal(step.state.detail, null);
    assert.equal(step.state.tab, "jobs", "esc returns to the jobs tab");
    assert.equal(step.state.scroll.detail, 0);
  }
});

test("q always closes, and up/down scroll an open detail", () => {
  const withDetail: TabsState = {
    ...initialTabsState("jobs"),
    detail: { jobId: "job_x", rows: ["  x"] },
  };
  assert.equal(reduceTabsKey(withDetail, "q", CTX).kind, "close");
  const step = reduceTabsKey(withDetail, "down", CTX);
  assert.equal(step.kind, "state");
  if (step.kind === "state") assert.equal(step.state.scroll.detail, 1);
});

// --- runTabsBrowser ---------------------------------------------------------

/** Minimal TTY doubles (same shape as prompt.test.ts). */
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
  const press = (name: string, str = "") =>
    input.emit("keypress", str, { name, ctrl: false, meta: false, shift: false });
  return {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    raw: output,
    rawInput: input,
    chunks,
    press,
  };
}

function lastFrame(chunks: string[]): string {
  const frames = chunks.filter((c) => c.endsWith("\r\n"));
  return stripAnsi(frames[frames.length - 1] ?? "");
}

test("runTabsBrowser arrows across tabs, opens a job in place, and closes clean", async () => {
  const tty = fakeTty(100);
  const loaded: string[] = [];
  const done = runTabsBrowser({
    initial: "usage",
    data: fixtureData(5),
    input: tty.input,
    output: tty.output,
    loadJobDetail: async (jobId) => {
      loaded.push(jobId);
      return ["  detail for " + jobId];
    },
  });
  assert.equal(tty.chunks[0], "\u001b[H\u001b[0J");
  assert.match(lastFrame(tty.chunks), /\[Usage\]/);
  assert.match(lastFrame(tty.chunks), /7% used/);

  tty.press("right");
  assert.match(lastFrame(tty.chunks), /\[Jobs\]/);
  assert.match(lastFrame(tty.chunks), /› job_0000/);

  tty.press("down");
  assert.match(lastFrame(tty.chunks), /› job_0001/);

  tty.press("return");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(loaded, ["job_0001xyz"]);
  assert.match(lastFrame(tty.chunks), /detail for job_0001xyz/);

  tty.press("escape");
  assert.match(lastFrame(tty.chunks), /› job_0001/, "esc returns to the jobs list");

  tty.press("q", "q");
  await done;
  // Frame erased; raw mode and listeners restored.
  const tail = tty.chunks[tty.chunks.length - 1]!;
  assert.match(tail, /\u001b\[\d+A\r\u001b\[0J/);
  assert.equal(tty.rawInput.listenerCount("keypress"), 0);
  assert.equal(tty.raw.listenerCount("resize"), 0);
  assert.equal((tty.rawInput as unknown as { isRaw: boolean }).isRaw, false);
});

test("runTabsBrowser space toggles a config row via toggleSetting and refreshes", async () => {
  const tty = fakeTty(100);
  const toggles: [string, boolean][] = [];
  const done = runTabsBrowser({
    initial: "config",
    data: fixtureData(2),
    input: tty.input,
    output: tty.output,
    toggleSetting: async (key, value) => {
      toggles.push([key, value]);
      return fixtureConfig().map((row) =>
        row.key === key ? { ...row, value } : row,
      );
    },
  });
  assert.match(lastFrame(tty.chunks), /\[Config\]/);
  assert.match(lastFrame(tty.chunks), /› Auto review\s+on/);

  tty.press("space", " ");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(toggles, [["auto_review_enabled", false]]);
  assert.match(lastFrame(tty.chunks), /› Auto review\s+off/);

  // Space on a read-only row never calls toggleSetting.
  tty.press("down");
  tty.press("down");
  tty.press("space", " ");
  await new Promise((r) => setImmediate(r));
  assert.equal(toggles.length, 1);

  tty.press("q", "q");
  await done;
});

test("runTabsBrowser re-renders from row 1 on resize", async () => {
  const tty = fakeTty(100);
  const done = runTabsBrowser({
    initial: "status",
    data: fixtureData(2),
    input: tty.input,
    output: tty.output,
  });
  tty.chunks.length = 0;
  tty.raw.columns = 60;
  tty.raw.emit("resize");
  assert.equal(tty.chunks[0], "\u001b[H\u001b[0J");
  const frame = lastFrame(tty.chunks);
  for (const line of frame.replace(/\r\n$/, "").split("\r\n")) {
    assert.ok(visibleWidth(line) <= 59, `"${line}" is ${visibleWidth(line)} cells`);
  }
  tty.press("escape");
  await done;
});
