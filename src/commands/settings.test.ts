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
  auto_resolve_conflicts_enabled: false,
  auto_fix_ci_enabled: false,
  cyclone_connected: false,
  github_connected: true,
  vortex_show_thinking_traces: true,
  repo_overview_enabled: false,
  review_unit_land_prs_enabled: true,
  cyclone_skip_ci_enabled: true,
  cyclone_patch_unverified_languages: false,
  vortex_auto_overflow_enabled: false,
  vortex_skip_all_clear_comments: false,
  vortex_seam_specialist_enabled: true,
  auto_land_default: false,
  auto_land_settle_seconds: 60,
  merge_queue_batch_enabled: false,
  merge_queue_batch_size: 4,
};

// --- parseSettingsArgs --------------------------------------------------------

test("parseSettingsArgs maps --auto-patch off to auto_patch_enabled: false", () => {
  const parsed = parseSettingsArgs(["--auto-patch", "off"]);
  assert.deepEqual(parsed, { json: false, patch: { auto_patch_enabled: false } });
});

test("parseSettingsArgs maps the Cyclone automation flags", () => {
  assert.deepEqual(parseSettingsArgs(["--auto-resolve-conflicts", "on", "--auto-fix-ci=off"]), {
    json: false,
    patch: { auto_resolve_conflicts_enabled: true, auto_fix_ci_enabled: false },
  });
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

test("parseSettingsArgs maps --merge-queue-batch and a batch size from 2 through 8", () => {
  assert.deepEqual(parseSettingsArgs(["--merge-queue-batch", "on", "--merge-queue-batch-size", "6"]), {
    json: false,
    patch: { merge_queue_batch_enabled: true, merge_queue_batch_size: 6 },
  });
  assert.deepEqual(parseSettingsArgs(["--merge-queue-batch=off"]).patch, { merge_queue_batch_enabled: false });
  assert.deepEqual(parseSettingsArgs(["--merge-queue-batch-size=2"]).patch, { merge_queue_batch_size: 2 });
  assert.deepEqual(parseSettingsArgs(["--merge-queue-batch-size", "8"]).patch, { merge_queue_batch_size: 8 });
  for (const args of [
    ["--merge-queue-batch-size"], ["--merge-queue-batch-size", "1"], ["--merge-queue-batch-size", "9"],
    ["--merge-queue-batch-size", "on"], ["--merge-queue-batch-size", "3.5"], ["--merge-queue-batch-size="],
  ]) {
    assert.throws(
      () => parseSettingsArgs(args),
      (err: unknown) =>
        err instanceof Error &&
        err.message === "--merge-queue-batch-size takes a whole number from 2 through 8.",
      args.join(" "),
    );
  }
  assert.throws(() => parseSettingsArgs(["--merge-queue-batch", "4"]), /--merge-queue-batch takes on or off\./);
});

test("formatSettingsLines prints the batch size as a plain number and the settle wait in seconds", () => {
  const text = formatSettingsLines({ ...SETTINGS_BODY, merge_queue_batch_enabled: true, merge_queue_batch_size: 6 }).join("\n");
  assert.match(text, /Merge queue batch size \(pull requests\)\s+6\n/);
  assert.doesNotMatch(text, /Merge queue batch size \(pull requests\)\s+6s/);
  assert.match(text, /Auto land settle \(seconds\)\s+60s/);
});

test("parseSettingsArgs maps --auto-land-settle to whole seconds from 15 through 300", () => {
  assert.deepEqual(parseSettingsArgs(["--auto-land-settle", "30"]), {
    json: false,
    patch: { auto_land_settle_seconds: 30 },
  });
  assert.deepEqual(parseSettingsArgs(["--auto-land-settle=300"]).patch, { auto_land_settle_seconds: 300 });
  assert.deepEqual(parseSettingsArgs(["--auto-land-settle", "15"]).patch, { auto_land_settle_seconds: 15 });
  for (const args of [
    ["--auto-land-settle"], ["--auto-land-settle", "14"], ["--auto-land-settle", "301"],
    ["--auto-land-settle", "on"], ["--auto-land-settle", "30.5"], ["--auto-land-settle", "-30"],
    ["--auto-land-settle="],
  ]) {
    assert.throws(
      () => parseSettingsArgs(args),
      (e: unknown) => e instanceof CommandError && e.code === "usage" && /15 through 300/.test(e.message),
      JSON.stringify(args),
    );
  }
});

test("human settings print the Auto land settle seconds", () => {
  const text = formatSettingsLines({ ...SETTINGS_BODY, auto_land_settle_seconds: 30 }).join("\n");
  assert.match(text, /Auto land settle \(seconds\)\s+30s/);
});

test("parseSettingsArgs collects every flag with both value forms", () => {
  const parsed = parseSettingsArgs([
    "--auto-review",
    "off",
    "--auto-patch=off",
    "--vortex-thinking",
    "on",
    "--repo-overview=on",
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

test("formatSettingsLines is unchanged when the server sends no stacks_ready", () => {
  const text = stripAnsi(formatSettingsLines(SETTINGS_BODY).join("\n"));
  assert.doesNotMatch(text, /Stacks, merge queue, Auto land/);
  assert.doesNotMatch(text, /auto patch\)/);
  assert.deepEqual(
    buildConfigRows(SETTINGS_BODY).filter((row) => !row.writable),
    [
      { key: "cyclone_connected", label: "Cyclone", value: false, writable: false },
      { key: "github_connected", label: "GitHub", value: true, writable: false },
    ],
  );
});

test("formatSettingsLines says whether stacks, the merge queue and Auto land are ready and labels Cyclone as auto patch", () => {
  const ready = stripAnsi(formatSettingsLines({ ...SETTINGS_BODY, stacks_ready: true }).join("\n"));
  assert.match(ready, /Stacks, merge queue, Auto land\s+ready$/m);
  assert.match(ready, /Cyclone \(auto patch\)\s+not connected$/m);
  assert.match(ready, /GitHub\s+connected$/m);

  const notReady = stripAnsi(
    formatSettingsLines({ ...SETTINGS_BODY, cyclone_connected: true, stacks_ready: false }).join("\n"),
  );
  assert.match(notReady, /Stacks, merge queue, Auto land\s+not ready \(install Mergestorm Surge\)$/m);
  assert.match(notReady, /Cyclone \(auto patch\)\s+connected$/m);

  const rows = buildConfigRows({ ...SETTINGS_BODY, stacks_ready: true });
  assert.deepEqual(
    rows.filter((row) => !row.writable).map((row) => row.key),
    ["stacks_ready", "cyclone_connected", "github_connected"],
  );
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
