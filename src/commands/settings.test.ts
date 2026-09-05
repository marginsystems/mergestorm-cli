import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CommandError } from "../errors.js";
import {
  cmdSettings,
  formatSettingsLines,
  parseSettingsArgs,
  SETTINGS_FLAGS,
} from "./settings.js";

const STRIP_ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(STRIP_ANSI, "");

const SETTINGS_BODY = {
  auto_review_enabled: true,
  auto_patch_enabled: false,
  cyclone_connected: false,
  github_connected: true,
  vortex_show_thinking_traces: true,
  repo_overview_enabled: false,
  review_unit_land_prs_enabled: true,
  cyclone_review_unit_land_prs_enabled: false,
  vortex_seam_specialist_enabled: true,
  auto_land_default: false,
};

// --- parseSettingsArgs --------------------------------------------------------

test("parseSettingsArgs maps --auto-patch off to auto_patch_enabled: false", () => {
  const parsed = parseSettingsArgs(["--auto-patch", "off"]);
  assert.deepEqual(parsed, { json: false, patch: { auto_patch_enabled: false } });
});

test("parseSettingsArgs maps --auto-land on to auto_land_default: true", () => {
  const parsed = parseSettingsArgs(["--auto-land", "on"]);
  assert.deepEqual(parsed, { json: false, patch: { auto_land_default: true } });
  assert.deepEqual(parseSettingsArgs(["--auto-land=off"]).patch, { auto_land_default: false });
});

test("parseSettingsArgs collects every flag with both value forms", () => {
  const parsed = parseSettingsArgs([
    "--auto-review",
    "off",
    "--auto-patch=off",
    "--vortex-thinking",
    "on",
    "--repo-overview=on",
    "--review-unit-land",
    "on",
    "--cyclone-review-unit-land",
    "off",
    "--vortex-seam=on",
    "--auto-land",
    "on",
    "--json",
  ]);
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.patch, {
    auto_review_enabled: false,
    auto_patch_enabled: false,
    vortex_show_thinking_traces: true,
    repo_overview_enabled: true,
    review_unit_land_prs_enabled: true,
    cyclone_review_unit_land_prs_enabled: false,
    vortex_seam_specialist_enabled: true,
    auto_land_default: true,
  });
});

test("parseSettingsArgs rejects values other than on|off", () => {
  for (const argv of [
    ["--auto-review", "true"],
    ["--auto-review=yes"],
    ["--auto-review"],
  ]) {
    assert.throws(
      () => parseSettingsArgs(argv),
      (err: unknown) =>
        err instanceof CommandError &&
        err.code === "usage" &&
        /takes on or off/.test(err.message),
      argv.join(" "),
    );
  }
});

test("parseSettingsArgs rejects unknown and read-only flags", () => {
  for (const flag of [
    "--cyclone-connected",
    "--github-connected",
    "--definitely-not-a-setting",
  ]) {
    assert.throws(
      () => parseSettingsArgs([flag, "on"]),
      (err: unknown) =>
        err instanceof CommandError &&
        err.code === "usage" &&
        err.message.includes(flag),
      flag,
    );
  }
});

test("SETTINGS_FLAGS covers only the writable allowlist", () => {
  const keys = Object.values(SETTINGS_FLAGS);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(!keys.includes("cyclone_connected" as never));
  assert.ok(!keys.includes("github_connected" as never));
});

// --- formatSettingsLines ------------------------------------------------------

test("formatSettingsLines prints on/off toggles and connected flags", () => {
  const text = stripAnsi(formatSettingsLines(SETTINGS_BODY).join("\n"));
  assert.match(text, /Auto review\s+on/);
  assert.match(text, /Auto patch\s+off/);
  assert.match(text, /Cyclone\s+not connected/);
  assert.match(text, /GitHub\s+connected/);
});

// --- cmdSettings (piped) ------------------------------------------------------

let originalFetch: typeof globalThis.fetch | undefined;
let originalApiKey: string | undefined;
let originalApiUrl: string | undefined;

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
  if (originalApiKey === undefined) delete process.env.MERGESTORM_API_KEY;
  else process.env.MERGESTORM_API_KEY = originalApiKey;
  originalApiKey = undefined;
  if (originalApiUrl === undefined) delete process.env.MERGESTORM_API_URL;
  else process.env.MERGESTORM_API_URL = originalApiUrl;
  originalApiUrl = undefined;
});

function useTestEnv(): void {
  originalApiKey = process.env.MERGESTORM_API_KEY;
  process.env.MERGESTORM_API_KEY = "msk_live_test_key";
  originalApiUrl = process.env.MERGESTORM_API_URL;
  process.env.MERGESTORM_API_URL = "https://api.example.test";
}

async function captureLog(run: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return stripAnsi(out.join("\n"));
}

test("cmdSettings with no flags GETs /api/v1/settings and prints the shape", async () => {
  useTestEnv();
  originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response(JSON.stringify(SETTINGS_BODY), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const text = await captureLog(() => cmdSettings([]));
  assert.deepEqual(urls, ["GET https://api.example.test/api/v1/settings"]);
  assert.match(text, /Auto review\s+on/);
  assert.match(text, /GitHub\s+connected/);
});

test("cmdSettings with a flag PATCHes and prints the returned settings as JSON", async () => {
  useTestEnv();
  originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push(`${init?.method ?? "GET"} ${String(input)}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { auto_patch_enabled: false });
    return new Response(
      JSON.stringify({ ...SETTINGS_BODY, auto_patch_enabled: false }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const text = await captureLog(() => cmdSettings(["--auto-patch", "off", "--json"]));
  assert.deepEqual(urls, ["PATCH https://api.example.test/api/v1/settings"]);
  assert.deepEqual(JSON.parse(text), { ...SETTINGS_BODY, auto_patch_enabled: false });
});

test("cmdSettings surfaces the API message when a PATCH is rejected", async () => {
  useTestEnv();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: "cyclone_not_connected",
        message: "Connect Cyclone to enable auto-patch.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  await assert.rejects(
    () => cmdSettings(["--auto-patch", "on"]),
    (err: unknown) =>
      err instanceof CommandError &&
      err.message === "Connect Cyclone to enable auto-patch.",
  );
});
