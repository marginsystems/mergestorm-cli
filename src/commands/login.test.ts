import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { Config } from "../config.js";
import { CommandError } from "../errors.js";
import { cmdLogin, pendingLoginPath, validateApiKey } from "./login.js";

const cfg: Config = {
  apiKey: "msk_live_candidate_key",
  apiBase: "https://api.example.test",
};

let originalFetch: typeof globalThis.fetch;

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

function mockFetch(status: number, body: unknown): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

test("validateApiKey accepts a working key", async () => {
  mockFetch(200, {
    key: { prefix: "msk_live_abcd", name: "cli", created_at: "", last_used_at: null },
    plan_key: "pro",
    usage: {
      standard: { used: 0, limit: 100, remaining: 100 },
    },
  });
  const me = await validateApiKey(cfg);
  assert.equal(me.key.prefix, "msk_live_abcd");
});

test("validateApiKey rejects 401 without implying config was written", async () => {
  mockFetch(401, { error: "unauthorized" });
  await assert.rejects(
    () => validateApiKey(cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "auth_invalid" &&
      /not saved/i.test(err.message),
  );
});

test("validateApiKey rejects unreachable / non-200 without saving", async () => {
  mockFetch(503, { error: "busy" });
  await assert.rejects(
    () => validateApiKey(cfg),
    (err: unknown) =>
      err instanceof CommandError && /not saved/i.test(err.message),
  );
});

test("cmdLogin backs off and retries when device start is rate limited", async () => {
  const startPaths: string[] = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v1/cli/device")) {
      startPaths.push(url);
      if (startPaths.length === 1) {
        return new Response(
          JSON.stringify({ error: "rate_limited", retry_after_seconds: 0.01 }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          device_code: "device-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://mergestorm.ai/cli/auth",
          verification_uri_complete: "https://mergestorm.ai/cli/auth?code=ABCD-EFGH",
          interval: 1,
          expires_in: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ error: "authorization_pending" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  };
  await assert.rejects(
    () => cmdLogin([]),
    (err: unknown) =>
      err instanceof CommandError &&
      /timed out/i.test(err.message) &&
      !/unreachable or misconfigured/i.test(err.message),
  );
  assert.equal(startPaths.length, 2);
});

test("cmdLogin backs off and retries when device start returns slow_down (HTTP 400)", async () => {
  const startPaths: string[] = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v1/cli/device")) {
      startPaths.push(url);
      if (startPaths.length === 1) {
        return new Response(
          JSON.stringify({ error: "slow_down", retry_after_seconds: 0.01 }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          device_code: "device-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://mergestorm.ai/cli/auth",
          verification_uri_complete: "https://mergestorm.ai/cli/auth?code=ABCD-EFGH",
          interval: 1,
          expires_in: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ error: "authorization_pending" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  };
  await assert.rejects(
    () => cmdLogin([]),
    (err: unknown) =>
      err instanceof CommandError &&
      /timed out/i.test(err.message) &&
      !/unreachable or misconfigured/i.test(err.message),
  );
  assert.equal(startPaths.length, 2);
});

async function withTempHome(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "mg-login-"));
  const previousHome = process.env.HOME;
  const previousApi = process.env.MERGESTORM_API_URL;
  process.env.HOME = home;
  process.env.MERGESTORM_API_URL = "https://api.example.test";
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousApi === undefined) delete process.env.MERGESTORM_API_URL;
    else process.env.MERGESTORM_API_URL = previousApi;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const deviceStart = {
  device_code: "device-123",
  user_code: "ABCD-EFGH",
  verification_uri: "https://mergestorm.ai/cli/auth",
  verification_uri_complete: "https://mergestorm.ai/cli/auth?code=ABCD-EFGH",
  interval: 1,
  expires_in: 600,
};

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  return readFile(file, "utf8").then(
    (raw) => JSON.parse(raw) as Record<string, unknown>,
    () => null,
  );
}

test("login --start prints the URL and code, keeps the device code on disk, and exits without polling", async (t) => {
  const home = await withTempHome(t);
  const paths: string[] = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    paths.push(new URL(String(input)).pathname);
    return json(200, deviceStart);
  };
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
  t.after(async () => {
    console.log = log;
  });

  await cmdLogin(["--start"]);

  assert.deepEqual(paths, ["/api/v1/cli/device"]);
  const printed = lines.join("\n");
  assert.match(printed, /https:\/\/mergestorm\.ai\/cli\/auth\?code=ABCD-EFGH/);
  assert.match(printed, /Code: ABCD-EFGH/);
  assert.match(printed, /login --finish/);
  assert.ok(!printed.includes("device-123"));
  assert.equal(pendingLoginPath(), path.join(home, ".mergestorm", "login-pending.json"));
  const pending = await readJson(pendingLoginPath());
  assert.equal(pending?.deviceCode, "device-123");
  assert.equal(pending?.userCode, "ABCD-EFGH");
  assert.equal(await readJson(path.join(home, ".mergestorm", "config.json")), null);
});

test("login --finish waits through pending, then saves the key and forgets the device code", async (t) => {
  const home = await withTempHome(t);
  const bodies: unknown[] = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/v1/cli/device") return json(200, deviceStart);
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1
      ? json(400, { error: "authorization_pending" })
      : json(200, { api_key: "msk_live_minted", key_prefix: "msk_live_mint" });
  };

  await cmdLogin(["--start"]);
  await cmdLogin(["--finish"]);

  assert.deepEqual(bodies, [{ device_code: "device-123" }, { device_code: "device-123" }]);
  const config = await readJson(path.join(home, ".mergestorm", "config.json"));
  assert.equal(config?.apiKey, "msk_live_minted");
  assert.equal(await readJson(pendingLoginPath()), null);
});

test("login --finish with nothing started says to run --start and calls nothing", async (t) => {
  await withTempHome(t);
  let called = false;
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    return json(200, {});
  };
  await assert.rejects(
    () => cmdLogin(["--finish"]),
    (err: unknown) => err instanceof CommandError && /login --start/.test(err.message),
  );
  assert.equal(called, false);
});

test("login --finish drops a code the server reports expired and saves no key", async (t) => {
  const home = await withTempHome(t);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    new URL(String(input)).pathname === "/api/v1/cli/device"
      ? json(200, deviceStart)
      : json(400, { error: "expired_token" });

  await cmdLogin(["--start"]);
  await assert.rejects(
    () => cmdLogin(["--finish"]),
    (err: unknown) => err instanceof CommandError && /expired/i.test(err.message),
  );
  assert.equal(await readJson(pendingLoginPath()), null);
  assert.equal(await readJson(path.join(home, ".mergestorm", "config.json")), null);
});
