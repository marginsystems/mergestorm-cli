import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "./width.js";
import {
  formatDaysLeft,
  formatResetLabel,
  formatUsagePanel,
  nextUtcMonthStart,
  usageBar,
  usageBarWidth,
} from "./usage.js";

test("usageBar is long bar + percent used only", () => {
  const out = usageBar(7, 100, { width: 20, color: false });
  assert.equal(out, "[█░░░░░░░░░░░░░░░░░░░] 7% used");
  assert.doesNotMatch(out, /\d+\/\d+/); // no used/limit clutter
  assert.doesNotMatch(out, /\(\d+%\)/);
});

test("usageBar clamps over-limit fills to 100%", () => {
  const out = usageBar(150, 100, { width: 10, color: false });
  assert.equal(out, "[██████████] 100% used");
});

test("usageBar handles zero usage", () => {
  const out = usageBar(0, 50, { width: 10, color: false });
  assert.equal(out, "[░░░░░░░░░░] 0% used");
});

test("usageBar shows not included when limit is 0", () => {
  assert.equal(usageBar(0, 0, { color: false }), "not included");
});

test("usageBar shows unlimited when limit is null", () => {
  assert.equal(usageBar(12, null, { color: false }), "unlimited");
});

test("nextUtcMonthStart is the first of next UTC month", () => {
  const iso = nextUtcMonthStart(new Date("2026-07-20T15:00:00Z"));
  assert.equal(iso, "2026-08-01T00:00:00.000Z");
});

test("formatDaysLeft counts whole days until resets_at", () => {
  const now = new Date("2026-08-25T03:00:00.000Z");
  assert.equal(formatDaysLeft("2026-09-05T10:53:00.000Z", now), "11 days left");
  assert.equal(formatDaysLeft("2026-08-26T03:00:00.000Z", now), "1 day left");
  assert.equal(formatDaysLeft("2026-08-25T08:00:00.000Z", now), "5h left");
  assert.equal(formatDaysLeft("2026-08-24T03:00:00.000Z", now), "reset due");
  assert.equal(formatDaysLeft(undefined, now), "");
});

test("formatResetLabel matches Resets … (UTC) wording", () => {
  assert.equal(
    formatResetLabel("2026-08-01T00:00:00.000Z"),
    "Resets Aug 1, 12:00am (UTC)",
  );
  assert.equal(
    formatResetLabel("2026-07-20T15:29:00.000Z"),
    "Resets Jul 20, 3:29pm (UTC)",
  );
});

const PANEL_JOBS = [
  {
    job: "job_abcd",
    verdict: "request_changes",
    thread: "local/feat/auth-refactor",
    credits: "1",
    when: "2h ago",
  },
  {
    job: "job_ef01",
    verdict: "approve",
    thread: "local/feat/short",
    credits: "1",
    when: "1d ago",
  },
];

test("usageBarWidth follows the terminal instead of a fixed 56 cells", () => {
  assert.equal(usageBarWidth(60), 46);
  assert.equal(usageBarWidth(120), 106);
});

test("usage panel fits a 60-column pane without wrapping", () => {
  const lines = formatUsagePanel({
    keyPrefix: "msk_live_abcd",
    plan: "free",
    used: 7,
    limit: 100,
    resetsAt: "2026-09-01T00:00:00.000Z",
    jobs: PANEL_JOBS,
    columns: 60,
    color: false,
  });
  assert.match(lines[0] ?? "", /msk_live_abcd · free/);
  assert.match(lines[1] ?? "", /7% used/);
  assert.match(lines[2] ?? "", /Resets Sep 1/);
  assert.match(lines.join("\n"), /JOB\s+VERDICT\s+THREAD\s+CREDITS\s+WHEN/);
  assert.match(lines.join("\n"), /job_abcd/);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 60, `"${line}" is ${visibleWidth(line)} cells`);
  }
  const bar = usageBar(7, 100, { width: usageBarWidth(60), color: false });
  assert.ok(visibleWidth(`  ${bar}`) <= 60);
  assert.ok(!bar.includes("█".repeat(56)));

  const fullBar = usageBar(150, 100, { width: usageBarWidth(60), color: false });
  assert.match(fullBar, /100% used/);
  assert.ok(visibleWidth(`  ${fullBar}`) <= 60, `"  ${fullBar}" overflows 60 cells`);
});

test("usage panel snapshot at 120 columns keeps identity and five-job table", () => {
  const longJobs = Array.from({ length: 6 }, (_, i) => ({
    job: `job_${String(i).padStart(4, "0")}`,
    verdict: "request_changes",
    thread: "local/feat/very-long-branch-name",
    credits: "1",
    when: "3h ago",
  }));
  const lines = formatUsagePanel({
    keyPrefix: "msk_live_wxyz",
    plan: "pro",
    used: 12,
    limit: 200,
    resetsAt: "2026-09-01T00:00:00.000Z",
    jobs: longJobs,
    columns: 120,
    color: false,
  });
  assert.match(lines.join("\n"), /msk_live_wxyz · pro/);
  assert.equal(lines.filter((line) => line.includes("job_")).length, 5);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 120, `"${line}" is ${visibleWidth(line)} cells`);
  }
});
