import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildConfigRows } from "./browse.js";
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
  ignored_bot_logins: ["renovate"],
  vortex_bot_skip_check: "none" as const,
  vortex_findings_check: "neutral" as const,
  cyclone_patch_failure_check: "failure" as const,
  auto_review_enabled: true,
  auto_patch_enabled: false,
  cyclone_connected: false,
  github_connected: true,
  vortex_show_thinking_traces: true,
  repo_overview_enabled: false,
  review_unit_land_prs_enabled: true,
  cyclone_review_unit_land_prs_enabled: false,
  cyclone_skip_ci_enabled: true,
  cyclone_patch_unverified_languages: false,
  vortex_auto_overflow_enabled: false,
  vortex_skip_all_clear_comments: false,
  vortex_seam_specialist_enabled: true,
  auto_land_default: false,
};

// --- parseSettingsArgs --------------------------------------------------------

test("parseSettingsArgs maps --auto-patch off to auto_patch_enabled: false", () => {
  const parsed = parseSettingsArgs(["--auto-patch", "off"]);
  assert.deepEqual(parsed, { json: false, patch: { auto_patch_enabled: false } });
});

test("parseSettingsArgs maps --cyclone-skip-ci off to cyclone_skip_ci_enabled: false", () => {
  const parsed = parseSettingsArgs(["--cyclone-skip-ci", "off"]);
  assert.deepEqual(parsed, { json: false, patch: { cyclone_skip_ci_enabled: false } });
  assert.deepEqual(parseSettingsArgs(["--cyclone-skip-ci=on"]).patch, { cyclone_skip_ci_enabled: true });
});

test("parseSettingsArgs maps --cyclone-patch-unverified to cyclone_patch_unverified_languages", () => {
  assert.deepEqual(parseSettingsArgs(["--cyclone-patch-unverified", "on"]), {
    json: false,
    patch: { cyclone_patch_unverified_languages: true },
  });
  assert.deepEqual(parseSettingsArgs(["--cyclone-patch-unverified=off"]).patch, {
    cyclone_patch_unverified_languages: false,
  });
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
    "--cyclone-skip-ci",
    "off",
    "--cyclone-patch-unverified=on",
    "--vortex-auto-overflow",
    "off",
    "--vortex-skip-all-clear=on",
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
    cyclone_skip_ci_enabled: false,
    cyclone_patch_unverified_languages: true,
    vortex_auto_overflow_enabled: false,
    vortex_skip_all_clear_comments: true,
    vortex_seam_specialist_enabled: true,
    auto_land_default: true,
  });
});

test("parseSettingsArgs maps --vortex-skip-all-clear to vortex_skip_all_clear_comments", () => {
  assert.deepEqual(parseSettingsArgs(["--vortex-skip-all-clear", "on"]).patch, {
    vortex_skip_all_clear_comments: true,
  });
  assert.deepEqual(parseSettingsArgs(["--vortex-skip-all-clear=off"]).patch, {
    vortex_skip_all_clear_comments: false,
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
  assert.match(text, /Patch languages we cannot typecheck\s+off/);
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

test("enum flags accept their declared values and reject boolean or invalid values", () => {
  assert.deepEqual(parseSettingsArgs([
    "--vortex-skip-check", "neutral", "--vortex-findings=failure", "--cyclone-fail-check", "neutral",
  ]).patch, {
    vortex_bot_skip_check: "neutral", vortex_findings_check: "failure", cyclone_patch_failure_check: "neutral",
  });
  assert.deepEqual(parseSettingsArgs(["--vortex-findings", "success"]).patch, { vortex_findings_check: "success" });
  for (const args of [
    ["--vortex-findings", "none"], ["--vortex-skip-check", "on"], ["--cyclone-fail-check"],
    ["--cyclone-fail-check", "success"],
  ]) {
    assert.throws(() => parseSettingsArgs(args), (e: unknown) => e instanceof CommandError && e.code === "usage");
  }
});

test("ignore bot parser requires an operation and valid login", () => {
  for (const args of [["on"], ["add"], ["remove", "--json"], ["add", "invalid_login"], ["add", " "]]) {
    assert.throws(() => parseSettingsArgs(["--ignore-bot", ...args]), (e: unknown) => e instanceof CommandError && e.code === "usage");
  }
});

test("human settings show stored enums and comma-separated or empty lists", () => {
  const text = formatSettingsLines({ ...SETTINGS_BODY, ignored_bot_logins: ["renovate", "dependabot"] }).join("\n");
  assert.match(text, /Ignored bot logins\s+renovate, dependabot/);
  assert.match(text, /Vortex bot skip check\s+none/);
  assert.match(text, /Vortex findings check\s+neutral/);
  assert.match(text, /Cyclone patch failure check\s+failure/);
  assert.match(formatSettingsLines({ ...SETTINGS_BODY, ignored_bot_logins: [] }).join("\n"), /Ignored bot logins\s+\(empty\)/);
});

test("human settings mark newer kind rows missing from an older API as unavailable", () => {
  const olderSettings = { ...SETTINGS_BODY } as Partial<typeof SETTINGS_BODY>;
  delete olderSettings.ignored_bot_logins;
  delete olderSettings.vortex_bot_skip_check;
  delete olderSettings.vortex_findings_check;
  delete olderSettings.cyclone_patch_failure_check;
  const text = formatSettingsLines(olderSettings as Parameters<typeof formatSettingsLines>[0]).join("\n");
  assert.match(text, /Ignored bot logins\s+\(unavailable\)/);
  assert.match(text, /Vortex bot skip check\s+\(unavailable\)/);
  assert.match(text, /Vortex findings check\s+\(unavailable\)/);
  assert.match(text, /Cyclone patch failure check\s+\(unavailable\)/);
  assert.doesNotMatch(text, /Ignored bot logins\s+off/);
});

for (const [args, expected, methods] of [
  [["add", " Dependabot[BOT] "], ["renovate", "dependabot"], ["GET", "PATCH"]],
  [["add", " Renovate[BOT] "], ["renovate"], ["GET", "PATCH"]],
  [["remove", " Renovate[BOT] "], [], ["GET", "PATCH"]],
  [["clear"], [], ["PATCH"]],
] as const) {
  test(`ignore bot ${args.join(" ")} patches the full canonical list`, async () => {
    useTestEnv();
    originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const method = init?.method ?? "GET";
      seen.push(method);
      if (method === "PATCH") assert.deepEqual(JSON.parse(String(init?.body)), { ignored_bot_logins: expected });
      return Response.json({ ...SETTINGS_BODY, ...(method === "PATCH" ? { ignored_bot_logins: expected } : {}) });
    };
    const text = await captureLog(() => cmdSettings(["--ignore-bot", ...args, "--json"]));
    assert.deepEqual(seen, methods);
    assert.deepEqual(JSON.parse(text).ignored_bot_logins, expected);
  });
}

test("ignore bot add does not write when GET is unavailable", async () => {
  useTestEnv();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    return Response.json({}, { status: 404 });
  };
  await assert.rejects(() => cmdSettings(["--ignore-bot", "add", "renovate", "--json"]), /Settings are not available/);
});

test("ignore bot operations discard legacy invalid stored logins", async () => {
  useTestEnv();
  originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    methods.push(method);
    if (method === "PATCH") {
      assert.deepEqual(JSON.parse(String(init?.body)), { ignored_bot_logins: ["renovate", "dependabot"] });
      return Response.json({ ...SETTINGS_BODY, ignored_bot_logins: ["renovate", "dependabot"] });
    }
    return Response.json({ ...SETTINGS_BODY, ignored_bot_logins: ["legacy_login", "renovate"] });
  };
  await cmdSettings(["--ignore-bot", "add", "dependabot", "--json"]);
  assert.deepEqual(methods, ["GET", "PATCH"]);
});

test("Config tab excludes enum and login rows", () => {
  const rows = buildConfigRows(SETTINGS_BODY);
  for (const key of ["ignored_bot_logins", "vortex_bot_skip_check", "vortex_findings_check", "cyclone_patch_failure_check"]) {
    assert.ok(!rows.some((row) => row.key === key));
  }
  assert.ok(rows.some((row) => row.key === "vortex_skip_all_clear_comments"));
});
