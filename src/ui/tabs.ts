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
import { formatUsagePanel, type UsagePanelInput } from "./usage.js";
import { dropdownViewport } from "./prompt.js";

export type TabId = "status" | "usage" | "jobs" | "config";

export const TAB_ORDER: readonly TabId[] = ["status", "usage", "jobs", "config"];

const TAB_LABELS: Record<TabId, string> = {
  status: "Status",
  usage: "Usage",
  jobs: "Jobs",
  config: "Config",
};

export type TabsJob = {
  id: string;
  cells: {
    job: string;
    status: string;
    verdict: string;
    thread: string;
    when: string;
  };
};

/** One Config-tab row: a writable on/off toggle or a read-only connection. */
export type TabsConfigRow = {
  /** Settings key sent on PATCH (writable rows only). */
  key: string;
  label: string;
  value: boolean;
  writable: boolean;
};

export type TabsData = {
  /** Prebuilt whoami + credits lines for the Status tab. */
  statusLines: string[];
  /** Right-aligned chrome note (reachability). Lives on the hint row. */
  footerNote?: string;
  /** Usage panel input minus width concerns; null when the API degraded. */
  usage: Omit<UsagePanelInput, "columns" | "color"> | null;
  /** Usage-tab body when the panel is unavailable (overrides the default). */
  usageEmptyText?: string;
  jobs: TabsJob[];
  /** Jobs-tab body when the list is empty (e.g. the list call failed). */
  jobsEmptyText?: string;
  /** Config tab rows; null when GET /api/v1/settings degraded. */
  config: TabsConfigRow[] | null;
  /** Config-tab body when settings are unavailable (overrides the default). */
  configEmptyText?: string;
  /** Transient Config-tab status line (PATCH in flight or rejected). */
  configNote?: string;
  color?: boolean;
};

export type TabsDetail = { jobId: string; rows: string[] };

export type TabsState = {
  tab: TabId;
  /** Body scroll per scrollable view; jobs and config scroll by selection. */
  scroll: { status: number; usage: number; detail: number };
  jobsIndex: number;
  configIndex: number;
  /** In-place `status <id>` view on the Jobs tab; Esc returns to the list. */
  detail: TabsDetail | null;
};

export function initialTabsState(tab: TabId = "status"): TabsState {
  return {
    tab,
    scroll: { status: 0, usage: 0, detail: 0 },
    jobsIndex: 0,
    configIndex: 0,
    detail: null,
  };
}

export type TabsKeyName =
  | "left"
  | "right"
  | "up"
  | "down"
  | "return"
  | "space"
  | "escape"
  | "q";

export type TabsStep =
  | { kind: "state"; state: TabsState }
  | { kind: "close" }
  | { kind: "open-job"; index: number; state: TabsState }
  | { kind: "toggle-setting"; key: string; value: boolean; state: TabsState };

export type TabsReduceCtx = {
  jobsCount: number;
  /** Max scroll offset of the active view (content rows minus body rows). */
  maxScroll: number;
  /** Config rows so Space knows which key to flip (read-only rows no-op). */
  config?: readonly TabsConfigRow[];
};

function clampNum(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

/**
 * One keypress against the browser state. Pure so tests can drive the whole
 * key map without a TTY. Tabs clamp at the ends (no wrap-around, so "which
 * tab am I on" never gets ambiguous); Esc backs out of a job detail before
 * it closes the browser; `q` always closes.
 */
export function reduceTabsKey(
  state: TabsState,
  key: TabsKeyName,
  ctx: TabsReduceCtx,
): TabsStep {
  if (key === "q") return { kind: "close" };
  if (key === "escape") {
    if (state.detail) {
      return {
        kind: "state",
        state: { ...state, detail: null, scroll: { ...state.scroll, detail: 0 } },
      };
    }
    return { kind: "close" };
  }
  if (key === "left" || key === "right") {
    const at = TAB_ORDER.indexOf(state.tab);
    const next = key === "left" ? Math.max(0, at - 1) : Math.min(TAB_ORDER.length - 1, at + 1);
    return {
      kind: "state",
      state: {
        ...state,
        tab: TAB_ORDER[next]!,
        detail: null,
        scroll: { ...state.scroll, detail: 0 },
      },
    };
  }
  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    if (state.detail) {
      return {
        kind: "state",
        state: {
          ...state,
          scroll: {
            ...state.scroll,
            detail: clampNum(state.scroll.detail + delta, 0, ctx.maxScroll),
          },
        },
      };
    }
    if (state.tab === "jobs") {
      return {
        kind: "state",
        state: {
          ...state,
          jobsIndex: clampNum(state.jobsIndex + delta, 0, Math.max(0, ctx.jobsCount - 1)),
        },
      };
    }
    if (state.tab === "config") {
      const count = ctx.config?.length ?? 0;
      return {
        kind: "state",
        state: {
          ...state,
          configIndex: clampNum(state.configIndex + delta, 0, Math.max(0, count - 1)),
        },
      };
    }
    return {
      kind: "state",
      state: {
        ...state,
        scroll: {
          ...state.scroll,
          [state.tab as "status" | "usage"]: clampNum(
            state.scroll[state.tab as "status" | "usage"] + delta,
            0,
            ctx.maxScroll,
          ),
        },
      },
    };
  }
  if (key === "return" && state.tab === "jobs" && !state.detail && ctx.jobsCount > 0) {
    return { kind: "open-job", index: state.jobsIndex, state };
  }
  if (key === "space" && state.tab === "config" && !state.detail) {
    const row = ctx.config?.[state.configIndex];
    // Read-only rows (connected flags) ignore Space instead of erroring.
    if (row?.writable) {
      return { kind: "toggle-setting", key: row.key, value: !row.value, state };
    }
  }
  return { kind: "state", state };
}

/** Body rows available inside the frame: total rows minus chrome + hint. */
export function tabsBodyRows(rows: number | undefined): number {
  const r =
    typeof rows === "number" && Number.isFinite(rows) && rows >= 1 ? rows : 24;
  return Math.max(3, r - 4);
}

export type TabsLayout = {
  /** Full frame (border, body, hint); no line wider than `columns - 1`. */
  lines: string[];
  bodyRows: number;
  /** Content rows of the active view before clipping (drives max scroll). */
  contentRows: number;
};

export function tabsMaxScroll(layout: TabsLayout): number {
  return Math.max(0, layout.contentRows - layout.bodyRows);
}

function tabsTitle(state: TabsState, color: boolean): string {
  const parts = TAB_ORDER.map((tab) => {
    let label = TAB_LABELS[tab];
    if (tab === "jobs" && state.detail) {
      label = `${label} › ${state.detail.jobId.slice(0, 8)}`;
    }
    if (!color) return tab === state.tab ? `[${label}]` : ` ${label} `;
    return tab === state.tab ? ansi.boldBrightGreen(label) : ansi.dim(label);
  });
  return parts.join(color ? ansi.dim(" · ") : " · ");
}

function jobsBody(
  state: TabsState,
  data: TabsData,
  bodyRows: number,
  width: number,
  color: boolean,
): string[] {
  if (data.jobs.length === 0) {
    const text = data.jobsEmptyText ?? "No review jobs yet. Run `review` to submit one.";
    return [`  ${color ? ansi.dim(text) : text}`];
  }
  const header = ["JOB", "STATUS", "VERDICT", "THREAD", "WHEN"];
  const cells = data.jobs.map((j) => [
    j.cells.job,
    j.cells.status,
    j.cells.verdict,
    j.cells.thread,
    j.cells.when,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => r[i]?.length ?? 0)),
  );
  const fmt = (cols: string[]) =>
    cols.map((c, i) => padVisible(c, widths[i]!)).join("  ");

  const lines: string[] = [`    ${color ? ansi.dim(fmt(header)) : fmt(header)}`];
  const viewportRows = Math.max(1, bodyRows - 1);
  const view = dropdownViewport(data.jobs.length, state.jobsIndex, viewportRows);
  const end = Math.min(data.jobs.length, view.start + viewportRows);
  for (let i = view.start; i < end; i++) {
    const selected = i === state.jobsIndex;
    const marker = selected ? "›" : " ";
    const row = `  ${color && selected ? ansi.brightGreen(marker) : marker} ${fmt(cells[i]!)}`;
    const clipped = visibleWidth(row) > width ? padVisible(row, width) : row;
    lines.push(color && selected ? ansi.invert(clipped) : clipped);
  }
  return lines;
}

/** On/off rows for the Config tab; scrolls by selection like the jobs list. */
function configBody(
  state: TabsState,
  data: TabsData,
  bodyRows: number,
  width: number,
  color: boolean,
): string[] {
  if (!data.config || data.config.length === 0) {
    const text =
      data.configEmptyText ?? "Settings unavailable (offline or older API).";
    return [`  ${color ? ansi.dim(text) : text}`];
  }
  const rows = data.config;
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  const noteRows = data.configNote ? 1 : 0;
  const viewportRows = Math.max(1, bodyRows - noteRows);
  const view = dropdownViewport(rows.length, state.configIndex, viewportRows);
  const end = Math.min(rows.length, view.start + viewportRows);
  const lines: string[] = [];
  for (let i = view.start; i < end; i++) {
    const row = rows[i]!;
    const selected = i === state.configIndex;
    const marker = selected ? "›" : " ";
    const value = row.writable
      ? row.value
        ? "on"
        : "off"
      : row.value
        ? "connected"
        : "not connected";
    const paintedValue = !color
      ? value
      : row.writable
        ? row.value
          ? ansi.brightGreen(value)
          : ansi.dim(value)
        : ansi.dim(value);
    const line = `  ${color && selected ? ansi.brightGreen(marker) : marker} ${padVisible(
      row.label,
      labelWidth + 2,
    )}${paintedValue}`;
    const clipped = visibleWidth(line) > width ? padVisible(line, width) : line;
    lines.push(color && selected ? ansi.invert(clipped) : clipped);
  }
  if (data.configNote) {
    const note = `  ${data.configNote}`;
    lines.push(color ? ansi.dim(note) : note);
  }
  return lines;
}

/** Key hint on the left, optional reachability note on the right. */
export function tabsHintLine(
  left: string,
  right: string | undefined,
  columns: number,
  color: boolean,
): string {
  const room = Math.max(1, columns - 1);
  const L = ` ${color ? ansi.dim(left) : left}`;
  if (!right) {
    return visibleWidth(L) > room ? padVisible(L, room) : L;
  }
  const R = color ? ansi.dim(right) : right;
  if (visibleWidth(L) + 1 + visibleWidth(R) > room) {
    const keep = Math.max(0, room - visibleWidth(R) - 1);
    const clippedL = padVisible(L, keep);
    const gap = Math.max(1, room - visibleWidth(clippedL) - visibleWidth(R));
    return `${clippedL}${" ".repeat(gap)}${R}`;
  }
  return `${L}${" ".repeat(Math.max(1, room - visibleWidth(L) - visibleWidth(R)))}${R}`;
}

/**
 * The whole browser frame for one render: tab strip in the top border, the
 * active tab's body clipped to `rows - 4`, and a dim key hint. Pure; the
 * raw-mode loop and tests both consume it.
 */
export function layoutTabs(
  state: TabsState,
  data: TabsData,
  columns?: number,
  rows?: number,
): TabsLayout {
  const color = data.color ?? false;
  const boxed = preferBoxedUi(columns);
  const cols = terminalColumns(80, columns);
  const outer = frameWidth(80, columns);
  const contentCells = boxed ? Math.max(20, outer - 4) : Math.max(20, cols - 1);
  const bodyRows = tabsBodyRows(rows);

  const clip = (line: string): string =>
    visibleWidth(line) > contentCells ? padVisible(line, contentCells) : line;

  let content: string[];
  let contentRows: number;
  let scroll = 0;
  if (state.detail) {
    content = state.detail.rows;
    contentRows = content.length;
    scroll = state.scroll.detail;
  } else if (state.tab === "status") {
    content = data.statusLines;
    contentRows = content.length;
    scroll = state.scroll.status;
  } else if (state.tab === "usage") {
    const usageEmpty =
      data.usageEmptyText ?? "Usage unavailable (offline or older API).";
    content = data.usage
      ? formatUsagePanel({ ...data.usage, columns: contentCells, color })
      : [`  ${color ? ansi.dim(usageEmpty) : usageEmpty}`];
    contentRows = content.length;
    scroll = state.scroll.usage;
  } else if (state.tab === "config") {
    content = configBody(state, data, bodyRows, contentCells, color);
    // Config scrolls by selection inside configBody; no body scroll.
    contentRows = content.length;
    scroll = 0;
  } else {
    content = jobsBody(state, data, bodyRows, contentCells, color);
    // The jobs list scrolls by selection inside jobsBody; no body scroll.
    contentRows = content.length;
    scroll = 0;
  }

  const start = clampNum(scroll, 0, Math.max(0, contentRows - bodyRows));
  const body = content.slice(start, start + bodyRows).map(clip);
  // Constant frame height regardless of tab, so redraws replace every row.
  while (body.length < bodyRows) body.push("");

  const hint = state.detail
    ? "↑↓ scroll · esc back to jobs · q quit"
    : state.tab === "jobs"
      ? "←→ tabs · ↑↓ select · enter open · q close"
      : state.tab === "config"
        ? "←→ tabs · ↑↓ select · space toggle · q close"
        : "←→ tabs · ↑↓ scroll · esc close";
  const clippedHint = tabsHintLine(hint, data.footerNote, cols, color);

  const title = tabsTitle(state, color);
  if (!boxed) {
    const plainTitle =
      visibleWidth(title) > cols - 1 ? padVisible(title, cols - 1) : title;
    return {
      lines: [plainTitle, ...body, clippedHint],
      bodyRows,
      contentRows,
    };
  }
  return {
    lines: [
      ...roundedBox(body, { title, width: outer, padding: 1 }),
      clippedHint,
    ],
    bodyRows,
    contentRows,
  };
}

const up = (n: number) => `\u001b[${n}A`;
const clearDown = "\u001b[0J";
/** Resize redraw clears from row 1: old rows may have wrapped (see prompt.ts). */
const homeClear = `\u001b[H${clearDown}`;

export type TabsBrowserOptions = {
  initial?: TabId;
  data: TabsData;
  /** Fetches `status <id>` rows for the Jobs tab's Enter action. */
  loadJobDetail?: (jobId: string) => Promise<string[]>;
  /** PATCHes one setting for the Config tab's Space action; resolves to the refreshed rows. */
  toggleSetting?: (key: string, value: boolean) => Promise<TabsConfigRow[]>;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
};

/**
 * Raw-mode tabbed browser (Status / Usage / Jobs / Config) on the select.ts
 * loop: Left/Right switch tabs, Up/Down scroll or select, Enter opens a job
 * in place, Space toggles a Config setting, `q`/Esc close, resize re-renders.
 * Non-TTY streams fall back to the static panels (callers normally gate on
 * TTY already).
 */
export async function runTabsBrowser(opts: TabsBrowserOptions): Promise<void> {
  const input = opts.input ?? stdin;
  const output = opts.output ?? stdout;
  const data = opts.data;

  if (!input.isTTY || !output.isTTY) {
    const layout = layoutTabs(
      initialTabsState(opts.initial ?? "status"),
      data,
      output.columns,
      output.rows,
    );
    for (const line of layout.lines) console.log(line);
    return;
  }

  return new Promise<void>((resolve) => {
    let state = initialTabsState(opts.initial ?? "status");
    let lastLayout: TabsLayout | null = null;
    let linesDrawn = 0;
    let finished = false;
    let detailSeq = 0;
    let toggleSeq = 0;
    const wasRaw = Boolean(input.isRaw);

    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    function render(prefix?: string): void {
      if (prefix) {
        output.write(prefix);
      } else if (linesDrawn > 0) {
        output.write(`${up(linesDrawn)}\r${clearDown}`);
      }
      lastLayout = layoutTabs(state, data, output.columns, output.rows);
      output.write(lastLayout.lines.join("\r\n") + "\r\n");
      linesDrawn = lastLayout.lines.length;
    }

    function onResize(): void {
      if (!finished) render(homeClear);
    }

    function cleanup(): void {
      input.removeListener("keypress", onKeypress);
      output.removeListener("resize", onResize);
      input.setRawMode(wasRaw);
      input.pause();
    }

    function finish(): void {
      if (finished) return;
      finished = true;
      cleanup();
      // Erase the frame so the shell prompt reclaims the space.
      if (linesDrawn > 0) output.write(`${up(linesDrawn)}\r${clearDown}`);
      resolve();
    }

    function openJob(index: number): void {
      const job = data.jobs[index];
      if (!job || !opts.loadJobDetail) return;
      const seq = ++detailSeq;
      state = {
        ...state,
        detail: {
          jobId: job.id,
          rows: [`  Loading job ${job.id.slice(0, 8)}…`],
        },
        scroll: { ...state.scroll, detail: 0 },
      };
      render();
      opts
        .loadJobDetail(job.id)
        .then((rows) => {
          if (finished || seq !== detailSeq) return;
          if (!state.detail || state.detail.jobId !== job.id) return;
          state = { ...state, detail: { jobId: job.id, rows } };
          render();
        })
        .catch((err: unknown) => {
          if (finished || seq !== detailSeq) return;
          if (!state.detail || state.detail.jobId !== job.id) return;
          const message = err instanceof Error ? err.message : String(err);
          state = {
            ...state,
            detail: { jobId: job.id, rows: [ansi.red(`  ${message}`)] },
          };
          render();
        });
    }

    function applyToggle(key: string, value: boolean): void {
      if (!opts.toggleSetting) return;
      const seq = ++toggleSeq;
      data.configNote = "saving…";
      render();
      opts
        .toggleSetting(key, value)
        .then((rows) => {
          if (finished || seq !== toggleSeq) return;
          data.config = rows;
          delete data.configNote;
          render();
        })
        .catch((err: unknown) => {
          if (finished || seq !== toggleSeq) return;
          // Keep the stored rows; only the note reports the rejection.
          data.configNote = err instanceof Error ? err.message : String(err);
          render();
        });
    }

    function onKeypress(str: string, key: readline.Key): void {
      if (finished || !key) return;
      if (key.ctrl && key.name === "c") {
        finish();
        return;
      }
      let name: TabsKeyName | null = null;
      if (key.name === "left" || key.name === "right" || key.name === "up" || key.name === "down") {
        name = key.name;
      } else if (key.name === "return") {
        name = "return";
      } else if (key.name === "space" || str === " ") {
        name = "space";
      } else if (key.name === "escape") {
        name = "escape";
      } else if (key.name === "q" || str === "q") {
        name = "q";
      }
      if (!name) return;
      const step = reduceTabsKey(state, name, {
        jobsCount: data.jobs.length,
        maxScroll: lastLayout ? tabsMaxScroll(lastLayout) : 0,
        config: data.config ?? [],
      });
      if (step.kind === "close") {
        finish();
        return;
      }
      if (step.kind === "open-job") {
        openJob(step.index);
        return;
      }
      if (step.kind === "toggle-setting") {
        applyToggle(step.key, step.value);
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
      // First paint homes so we do not write from the idle input row
      // (mid-pane) and scroll the welcome chrome.
      render(homeClear);
    } catch {
      finish();
    }
  });
}
