import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { Config } from "../config.js";
import { CommandError } from "../errors.js";
import { cmdLogin, loggedInLine, pendingLoginPath, validateApiKey } from "./login.js";

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

test("cmdLogin backs off and retries when device start is rate limited", async (t) => {
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
  const opened: string[] = [];
  const wasTTY = process.stdout.isTTY;
  process.stdout.isTTY = true;
  t.after(() => {
    process.stdout.isTTY = wasTTY;
  });
  await assert.rejects(
    () => cmdLogin([], { openBrowser: (url) => void opened.push(url) }),
    (err: unknown) =>
      err instanceof CommandError &&
      /timed out/i.test(err.message) &&
      !/unreachable or misconfigured/i.test(err.message),
  );
  assert.equal(startPaths.length, 2);
  assert.deepEqual(opened, ["https://mergestorm.ai/cli/auth?code=ABCD-EFGH"]);
});

test("cmdLogin backs off and retries when device start returns slow_down (HTTP 400)", async (t) => {
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
  const opened: string[] = [];
  const wasTTY = process.stdout.isTTY;
  process.stdout.isTTY = true;
  t.after(() => {
    process.stdout.isTTY = wasTTY;
  });
  await assert.rejects(
    () => cmdLogin([], { openBrowser: (url) => void opened.push(url) }),
    (err: unknown) =>
      err instanceof CommandError &&
      /timed out/i.test(err.message) &&
      !/unreachable or misconfigured/i.test(err.message),
  );
  assert.equal(startPaths.length, 2);
  assert.deepEqual(opened, ["https://mergestorm.ai/cli/auth?code=ABCD-EFGH"]);
});

async function withTempHome(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "mg-login-"));
  const previousHome = process.env.HOME;
  const previousStore = process.env.MERGESTORM_HOME;
  const previousApi = process.env.MERGESTORM_API_URL;
  const previousKey = process.env.MERGESTORM_API_KEY;
  process.env.HOME = home;
  delete process.env.MERGESTORM_HOME;
  delete process.env.MERGESTORM_API_KEY;
  process.env.MERGESTORM_API_URL = "https://api.example.test";
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousStore === undefined) delete process.env.MERGESTORM_HOME;
    else process.env.MERGESTORM_HOME = previousStore;
    if (previousApi === undefined) delete process.env.MERGESTORM_API_URL;
    else process.env.MERGESTORM_API_URL = previousApi;
    if (previousKey === undefined) delete process.env.MERGESTORM_API_KEY;
    else process.env.MERGESTORM_API_KEY = previousKey;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

const ME = {
  key: { prefix: "msk_live_mint", name: "cli", created_at: "", last_used_at: null },
  account: { github_login: "mark", email: "mark@example.test" },
  plan_key: "pro",
  usage: { standard: { used: 0, limit: 100, remaining: 100 } },
};

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

test("cmdLogin opens the approval URL in a terminal and never without one", async (t) => {
  await withTempHome(t);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    String(input).endsWith("/api/v1/cli/device")
      ? json(200, { ...deviceStart, expires_in: 1 })
      : json(400, { error: "authorization_pending" });
  const log = console.log;
  console.log = () => {};
  const wasTTY = process.stdout.isTTY;
  t.after(async () => {
    console.log = log;
    process.stdout.isTTY = wasTTY;
  });

  for (const isTTY of [true, false]) {
    process.stdout.isTTY = isTTY;
    const opened: string[] = [];
    await assert.rejects(() => cmdLogin([], { openBrowser: (url) => void opened.push(url) }));
    assert.deepEqual(opened, isTTY ? [deviceStart.verification_uri_complete] : []);
  }
});

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

test("login --finish waits through pending, then saves the key under the account /me names and forgets the device code", async (t) => {
  const home = await withTempHome(t);
  const bodies: unknown[] = [];
  const meAuth: string[] = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/v1/cli/device") return json(200, deviceStart);
    if (pathname === "/api/v1/me") {
      meAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      return json(200, ME);
    }
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1
      ? json(400, { error: "authorization_pending" })
      : json(200, { api_key: "msk_live_minted", key_prefix: "msk_live_mint" });
  };
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
  t.after(async () => {
    console.log = log;
  });

  await cmdLogin(["--start"]);
  await cmdLogin(["--finish"]);

  assert.deepEqual(bodies, [{ device_code: "device-123" }, { device_code: "device-123" }]);
  assert.deepEqual(meAuth, ["Bearer msk_live_minted"]);
  assert.deepEqual(await readJson(path.join(home, ".mergestorm", "config.json")), {
    accounts: { mark: { apiKey: "msk_live_minted", apiBase: "https://api.example.test" } },
    activeAccount: "mark",
    apiKey: "msk_live_minted",
    apiBase: "https://api.example.test",
  });
  assert.match(lines.join("\n"), /Logged in as mark/);
  assert.equal(await readJson(pendingLoginPath()), null);
});

async function finishLoginAs(login: string | null, apiKey: string): Promise<void> {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/v1/cli/device") return json(200, deviceStart);
    if (pathname === "/api/v1/me") {
      return login ? json(200, { ...ME, account: { github_login: login, email: null } }) : json(404, { error: "not_found" });
    }
    return json(200, { api_key: apiKey, key_prefix: apiKey.slice(0, 13) });
  };
  await cmdLogin(["--start"]);
  await cmdLogin(["--finish"]);
}

test("a second login adds an account and makes it active; logging in again as a saved account replaces its key", async (t) => {
  const home = await withTempHome(t);
  const log = console.log;
  console.log = () => {};
  t.after(async () => {
    console.log = log;
  });
  await finishLoginAs("mark", "msk_live_mark1");
  await finishLoginAs("work", "msk_live_work1");
  assert.deepEqual(await readJson(path.join(home, ".mergestorm", "config.json")), {
    accounts: {
      mark: { apiKey: "msk_live_mark1", apiBase: "https://api.example.test" },
      work: { apiKey: "msk_live_work1", apiBase: "https://api.example.test" },
    },
    activeAccount: "work",
    apiKey: "msk_live_work1",
    apiBase: "https://api.example.test",
  });
  await finishLoginAs("mark", "msk_live_mark2");
  const config = await readJson(path.join(home, ".mergestorm", "config.json"));
  assert.deepEqual((config?.accounts as Record<string, { apiKey: string }>).mark.apiKey, "msk_live_mark2");
  assert.equal(config?.activeAccount, "mark");
  assert.deepEqual(Object.keys(config?.accounts as object), ["mark", "work"]);
});

test("an older API that names no account stores the login under its key prefix", async (t) => {
  const home = await withTempHome(t);
  const log = console.log;
  console.log = () => {};
  t.after(async () => {
    console.log = log;
  });
  await finishLoginAs(null, "msk_live_abcd1234rest");
  assert.deepEqual(await readJson(path.join(home, ".mergestorm", "config.json")), {
    accounts: { msk_live_abcd: { apiKey: "msk_live_abcd1234rest", apiBase: "https://api.example.test" } },
    activeAccount: "msk_live_abcd",
    apiKey: "msk_live_abcd1234rest",
    apiBase: "https://api.example.test",
  });
});

test("a fourth account is refused by name, its freshly minted key revoked, and the three stay", async (t) => {
  const home = await withTempHome(t);
  const log = console.log;
  console.log = () => {};
  t.after(async () => {
    console.log = log;
  });
  await finishLoginAs("a", "msk_live_a1");
  await finishLoginAs("b", "msk_live_b1");
  await finishLoginAs("c", "msk_live_c1");
  const revokes: string[] = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/v1/cli/device") return json(200, deviceStart);
    if (pathname === "/api/v1/me") return json(200, { ...ME, account: { github_login: "d", email: null } });
    if (pathname === "/api/v1/me/key") {
      revokes.push(`${init?.method} ${new Headers(init?.headers).get("authorization")}`);
      return json(200, { ok: true, id: "key-d" });
    }
    return json(200, { api_key: "msk_live_d1", key_prefix: "msk_live_d1" });
  };
  await cmdLogin(["--start"]);
  await assert.rejects(
    () => cmdLogin(["--finish"]),
    (err: unknown) =>
      err instanceof CommandError &&
      err.code === "account_limit" &&
      /Already 3 accounts: a, b, c\. Remove one with `mergestorm account remove <name>` first\./.test(err.message),
  );
  assert.deepEqual(revokes, ["DELETE Bearer msk_live_d1"]);
  const config = await readJson(path.join(home, ".mergestorm", "config.json"));
  assert.deepEqual(Object.keys(config?.accounts as object), ["a", "b", "c"]);
  assert.equal(config?.activeAccount, "c");
  assert.equal(await readJson(pendingLoginPath()), null);
});

test("a device token that already names the account is stored under it without calling /me", async (t) => {
  const home = await withTempHome(t);
  const paths: string[] = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    paths.push(pathname);
    if (pathname === "/api/v1/cli/device") return json(200, deviceStart);
    return json(200, {
      api_key: "msk_live_minted",
      key_prefix: "msk_live_mint",
      account: { github_login: "marginsystems", email: "mark@example.com" },
    });
  };
  const printed: string[] = [];
  t.mock.method(console, "log", (text: string) => printed.push(String(text)));
  await cmdLogin(["--start"]);
  await cmdLogin(["--finish"]);
  assert.ok(!paths.includes("/api/v1/me"), paths.join(" "));
  const config = await readJson(path.join(home, ".mergestorm", "config.json"));
  assert.equal(config?.activeAccount, "marginsystems");
  assert.equal(config?.apiKey, "msk_live_minted");
  assert.ok(printed.some((line) => line.includes("Logged in as marginsystems.")), printed.join("\n"));
});

test("loggedInLine falls back to the email, then to a plain Logged in", () => {
  assert.equal(loggedInLine({ github_login: "marginsystems", email: "mark@example.com" }), "Logged in as marginsystems.");
  assert.equal(loggedInLine({ github_login: null, email: "mark@example.com" }), "Logged in as mark@example.com.");
  assert.equal(loggedInLine({ github_login: null, email: null }), "Logged in.");
  assert.equal(loggedInLine(undefined), "Logged in.");
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

test("plain login with no terminal points at --start and --finish", async (t) => {
  await withTempHome(t);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    new URL(String(input)).pathname === "/api/v1/cli/device"
      ? json(200, { ...deviceStart, expires_in: 1 })
      : json(400, { error: "authorization_pending" });
  const lines: string[] = [];
  const log = console.log;
  const wasTty = process.stdout.isTTY;
  process.stdout.isTTY = false;
  console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
  t.after(async () => {
    console.log = log;
    process.stdout.isTTY = wasTty;
  });

  await assert.rejects(() => cmdLogin([]), /timed out/i);
  assert.match(lines.join("\n"), /login --start`, then `mergestorm login --finish/);
});
