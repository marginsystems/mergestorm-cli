import assert from "node:assert/strict";
import { test } from "node:test";
import { formatResetLabel, nextUtcMonthStart, usageBar } from "./usage.js";

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
