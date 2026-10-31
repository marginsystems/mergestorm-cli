import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { saveAccount, useAccount } from "../config.js";
import { CommandError } from "../errors.js";
import { cmdWhoami } from "./whoami.js";

function withTempHome(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(path.join(tmpdir(), "mg-whoami-"));
  const previous = process.env.MERGESTORM_HOME;
  process.env.MERGESTORM_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MERGESTORM_HOME;
    else process.env.MERGESTORM_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("machine whoami requires live account details", async (t) => {
  const me = {
    account: { github_login: "marginsystems", email: "mark@example.com" },
    key: { prefix: "msk_live_verified", name: "test" },
    plan_key: "starter",
    plan_label_key: "Starter",
    usage: { standard: { used: 1, limit: 10, remaining: 9 } },
  };
  withTempHome(t);
  const originalKey = process.env.MERGESTORM_API_KEY;
  const originalUrl = process.env.MERGESTORM_API_URL;
  process.env.MERGESTORM_API_KEY = "msk_live_cached_test";
  process.env.MERGESTORM_API_URL = "https://api.example.test";
  t.after(() => {
    if (originalKey === undefined) delete process.env.MERGESTORM_API_KEY;
    else process.env.MERGESTORM_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.MERGESTORM_API_URL;
    else process.env.MERGESTORM_API_URL = originalUrl;
  });
  for (const mode of ["live", "404", "network", "timeout", "401"] as const) {
    await t.test(mode, async (t) => {
      t.mock.method(globalThis, "fetch", async () => {
        if (mode === "network") throw new TypeError("fetch failed");
        if (mode === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
        return new Response(JSON.stringify(me), { status: mode === "live" ? 200 : Number(mode) });
      });
      const output: string[] = [];
      t.mock.method(console, "log", (text: string) => output.push(text));
      if (mode === "live") {
        await cmdWhoami(["--json"]);
        assert.equal(output.length, 1);
        const payload = JSON.parse(output[0]!);
        assert.equal(payload.key_prefix, me.key.prefix);
        assert.deepEqual(payload.usage, me.usage);
        assert.equal(payload.account, "marginsystems");
        assert.equal(payload.github_login, "marginsystems");
        assert.equal(payload.email, "mark@example.com");
        assert.deepEqual(payload.accounts, []);
      } else {
        for (const args of [["--json"], []]) {
          await assert.rejects(() => cmdWhoami(args), (err: unknown) => {
            assert.ok(err instanceof CommandError);
            assert.notEqual(err.exitCode, 0);
            if (mode === "401") assert.equal(err.code, "auth_invalid");
            else assert.match(err.message, /Live account details unavailable/);
            return true;
          });
        }
        assert.deepEqual(output, []);
      }
    });
  }
});

test("whoami names the account it ran as, the other saved accounts, and settles a provisional name", async (t) => {
  withTempHome(t);
  const originalKey = process.env.MERGESTORM_API_KEY;
  const originalUrl = process.env.MERGESTORM_API_URL;
  delete process.env.MERGESTORM_API_KEY;
  process.env.MERGESTORM_API_URL = "https://api.example.test";
  t.after(() => {
    if (originalKey === undefined) delete process.env.MERGESTORM_API_KEY;
    else process.env.MERGESTORM_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.MERGESTORM_API_URL;
    else process.env.MERGESTORM_API_URL = originalUrl;
  });
  await saveAccount("msk_live_old1", { apiKey: "msk_live_old1rest" });
  await saveAccount("work", { apiKey: "msk_live_workrest" });
  await useAccount("msk_live_old1");
  const auth: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(
      JSON.stringify({
        key: { prefix: "msk_live_old1", name: "laptop" },
        account: { github_login: "mark", email: null },
        plan_key: "starter",
        usage: { standard: { used: 1, limit: 10, remaining: 9 } },
      }),
      { status: 200 },
    );
  });
  const output: string[] = [];
  t.mock.method(console, "log", (text: string) => output.push(text));
  await cmdWhoami(["--json"]);
  assert.deepEqual(auth, ["Bearer msk_live_old1rest"]);
  const payload = JSON.parse(output[0]!);
  assert.equal(payload.account, "mark");
  assert.deepEqual(payload.accounts, ["work", "mark"]);

  output.length = 0;
  await cmdWhoami([]);
  const text = output.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  assert.match(text, /Account  mark/);
  assert.match(text, /Others   work/);
});

test("whoami prints the account line in a terminal, and says when the API cannot name it", async (t) => {
  withTempHome(t);
  const originalKey = process.env.MERGESTORM_API_KEY;
  const originalUrl = process.env.MERGESTORM_API_URL;
  process.env.MERGESTORM_API_KEY = "msk_live_cached_test";
  process.env.MERGESTORM_API_URL = "https://api.example.test";
  t.after(() => {
    if (originalKey === undefined) delete process.env.MERGESTORM_API_KEY;
    else process.env.MERGESTORM_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.MERGESTORM_API_URL;
    else process.env.MERGESTORM_API_URL = originalUrl;
  });
  const base = { key: { prefix: "msk_live_verified", name: "test" }, plan_key: "starter", usage: { standard: { used: 1, limit: 10, remaining: 9 } } };
  for (const [body, expected] of [
    [{ ...base, account: { github_login: null, email: "mark@example.com" } }, /Account\s+.*mark@example\.com/],
    [base, /Account\s+unknown \(API too old to say\)/],
  ] as const) {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status: 200 }));
    const output: string[] = [];
    t.mock.method(console, "log", (text: string) => output.push(String(text)));
    await cmdWhoami([]);
    assert.match(output.join("\n"), expected);
  }
});
