import assert from "node:assert/strict";
import { test } from "node:test";
import type { MeResponse } from "../api.js";
import { cliVersion } from "../version.js";
import { buildBannerRows, shellPrompt, type BannerState } from "./banner.js";
import { STORM_MARK } from "./logo.js";
import { visibleWidth } from "./width.js";

const STRIP_ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(STRIP_ANSI, "");

const ME: MeResponse = {
  key: {
    prefix: "msk_live_abcd",
    name: "laptop",
    created_at: "2026-08-01T00:00:00Z",
    last_used_at: null,
  },
  plan_key: "free",
  plan_label_key: "maelstrom",
  resets_at: "2026-09-01T00:00:00.000Z",
  usage: { standard: { used: 7, limit: 100, remaining: 93 } },
};

function loggedIn(version = "0.3.14"): BannerState {
  return { version, me: ME, key: "msk_live_abcd1234", keyInvalid: false };
}

test("banner rows never exceed the frame at 120 columns", () => {
  const rows = buildBannerRows(loggedIn(), 120);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= 119, `"${row}" is ${visibleWidth(row)} cells`);
  }
  const text = stripAnsi(rows.join("\n"));
  assert.match(text, /mergestorm v0\.3\.14/);
  assert.match(text, /msk_live_abcd · maelstrom/);
  assert.match(text, /7% used/);
  assert.ok(text.includes(STORM_MARK[0]!), "Fable mark row 1 present");
  assert.ok(text.includes(STORM_MARK[1]!.trim()), "Fable mark row 2 present");
  const inner = rows.filter((row) => /^[│|]/.test(stripAnsi(row)));
  assert.ok(inner.length >= 2);
  assert.ok(stripAnsi(inner[0]!).includes("mergestorm"), "title is the first row under the top border");
  assert.ok(!inner[0]!.includes(STORM_MARK[0]!));
  assert.ok(inner[1]!.includes(STORM_MARK[0]!), "mark starts one row below the title");
  assert.ok(stripAnsi(rows[0]!).match(/^[╭+]/), "first emitted row is the top border");
  assert.ok(stripAnsi(rows[rows.length - 1]!).match(/^[╰+]/), "no blank row after the bottom border");
});

test("banner rows never exceed the frame at 60 columns", () => {
  const rows = buildBannerRows(loggedIn(), 60);
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= 59, `"${row}" is ${visibleWidth(row)} cells`);
  }
  // Reflow, not wrap: the same state fits both widths (the resize redraw
  // calls this per width, so this is the no-smear property).
  const wide = buildBannerRows(loggedIn(), 120);
  assert.equal(rows.length, wide.length);
});

test("banner below 48 columns drops the frame instead of wrapping it", () => {
  const rows = buildBannerRows(loggedIn(), 40);
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= 39, `"${row}" is ${visibleWidth(row)} cells`);
    assert.ok(!/[╭╰│+|]/.test(stripAnsi(row).slice(0, 1)), `no border in "${row}"`);
  }
  assert.match(stripAnsi(rows.join("\n")), /mergestorm v0\.3\.14/);
});

test("shellPrompt is mg in the same green as the wordmark, never dim", () => {
  const STRIP = /\u001b\[[0-9;]*m/g;
  for (const loggedIn of [true, false]) {
    const raw = shellPrompt(loggedIn);
    assert.equal(raw.replace(STRIP, ""), "mg");
    assert.ok(!raw.includes("\u001b[2m"), "must not be dim");
    assert.ok(!raw.includes("mergestorm"), "prompt is mg, never the word mergestorm");
    if (raw !== "mg") {
      assert.ok(raw.includes("92"), "bright green 92, never sick 32");
      assert.ok(!raw.includes("32"), "never dark green 32 on the prompt");
    }
  }
});

test("banner mark is the two-row Fable storm mark", () => {
  assert.equal(STORM_MARK.length, 2);
  for (const line of STORM_MARK) {
    assert.ok(visibleWidth(line) > 0);
    assert.ok(visibleWidth(line) <= 4, "mark stays compact");
  }
});

test("banner logged-out state points at login", () => {
  const rows = buildBannerRows(
    { version: "0.3.14", me: null, key: undefined, keyInvalid: false },
    100,
  );
  assert.match(stripAnsi(rows.join("\n")), /not logged in/);
  assert.doesNotMatch(stripAnsi(rows.join("\n")), /% used/);
});

test("banner invalid-key state says so and hides the bar", () => {
  const rows = buildBannerRows(
    { version: "0.3.14", me: ME, key: "msk_live_dead", keyInvalid: true },
    100,
  );
  const text = stripAnsi(rows.join("\n"));
  assert.match(text, /invalid or revoked/);
  assert.doesNotMatch(text, /% used/);
});

test("compact banner keeps mark, tagline, tips, and what's new", () => {
  const full = buildBannerRows(loggedIn(), 120);
  const compact = buildBannerRows(loggedIn(), 120, { compact: true });
  assert.ok(compact.length < full.length);
  const text = stripAnsi(compact.join("\n"));
  assert.match(text, /mergestorm v0\.3\.14/);
  assert.match(text, /msk_live_abcd · maelstrom/);
  assert.ok(text.includes(STORM_MARK[0]!));
  assert.match(text, /local reviews \+ stacked PRs/);
  assert.match(text, /review a diff/);
  assert.match(text, /New in v/);
});

test("mini banner keeps the mark plus the short-pane copy", () => {
  const compact = buildBannerRows(loggedIn(), 80, { density: "compact" });
  const mini = buildBannerRows(loggedIn(), 80, { density: "mini" });
  assert.ok(mini.length >= 4);
  assert.ok(mini.length < compact.length);
  const text = stripAnsi(mini.join("\n"));
  assert.match(text, /mergestorm v0\.3\.14/);
  assert.ok(text.includes(STORM_MARK[0]!));
  assert.ok(text.includes(STORM_MARK[1]!.trim()));
  assert.match(text, /local reviews \+ stacked PRs/);
  assert.match(text, /review a diff/);
  assert.match(text, /New in v/);
  for (const row of mini) {
    assert.ok(!/^[╭╰]/.test(stripAnsi(row)), "mini has no box");
  }
});

test("nano banner is one row with the mark", () => {
  const nano = buildBannerRows(loggedIn(), 80, { density: "nano" });
  assert.equal(nano.length, 1);
  const text = stripAnsi(nano[0]!);
  assert.ok(text.includes(STORM_MARK[0]!));
  assert.match(text, /mergestorm/);
});

test("narrow short view shortens copy instead of clipping mid-word", () => {
  for (const cols of [48, 56, 64, 80]) {
    const rows = [
      ...buildBannerRows(loggedIn(), cols, { density: "mini" }),
      ...buildBannerRows(loggedIn(), cols, { density: "compact" }),
    ];
    for (const row of rows) {
      assert.ok(visibleWidth(row) <= cols - 1, `${cols}col row is ${visibleWidth(row)}: ${stripAnsi(row)}`);
      const text = stripAnsi(row);
      assert.doesNotMatch(text, /usa$/);
      assert.doesNotMatch(text, /Jo$/);
      assert.doesNotMatch(text, /open with us$/);
    }
  }
  const mini = stripAnsi(buildBannerRows(loggedIn(), 56, { density: "mini" }).join("\n"));
  assert.match(mini, /New in v0\.3\.14: Status \/ Usage \/ Jobs tabs/);
  assert.doesNotMatch(mini, /open with usage/);
});

test("what's new covers the shipped package version (no empty pane)", () => {
  // 0.3.13 shipped with no WHATS_NEW entry and an empty right pane; keep
  // the map keyed to the real package version from here on.
  const rows = buildBannerRows(loggedIn(cliVersion()), 120);
  const text = stripAnsi(rows.join("\n"));
  assert.match(text, new RegExp(`New in v${cliVersion().replace(/\./g, "\\.")}`));
  assert.match(text, /nginx 413 names the upload limit/);
});
