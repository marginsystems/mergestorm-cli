import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { listAccounts, loadConfig, saveAccount, useAccount } from "../config.js";
import { CommandError } from "../errors.js";
import { cmdAccount, logoutAccount } from "./account.js";

const STRIP_ANSI = /\u001b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(STRIP_ANSI, "");

let originalFetch: typeof globalThis.fetch | undefined;

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
});

async function withTempHome(t: { after: (fn: () => Promise<void>) => void }): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "mg-account-"));
  const previousHome = process.env.MERGESTORM_HOME;
  const previousKey = process.env.MERGESTORM_API_KEY;
  const previousAccount = process.env.MERGESTORM_ACCOUNT;
  process.env.MERGESTORM_HOME = home;
  delete process.env.MERGESTORM_API_KEY;
  delete process.env.MERGESTORM_ACCOUNT;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.MERGESTORM_HOME;
    else process.env.MERGESTORM_HOME = previousHome;
    if (previousKey === undefined) delete process.env.MERGESTORM_API_KEY;
    else process.env.MERGESTORM_API_KEY = previousKey;
    if (previousAccount === undefined) delete process.env.MERGESTORM_ACCOUNT;
    else process.env.MERGESTORM_ACCOUNT = previousAccount;
    await rm(home, { recursive: true, force: true });
  });
}

function captureLog(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
  t.after(() => {
    console.log = log;
  });
  return lines;
}

async function seed(): Promise<void> {
  await saveAccount("mark", { apiKey: "msk_live_mark1234rest", apiBase: "https://api.example.test" });
  await saveAccount("work", { apiKey: "msk_live_work1234rest", apiBase: "https://api.example.test" });
  await useAccount("mark");
}

test("account list marks the active account and prints JSON on request", async (t) => {
  await withTempHome(t);
  await seed();
  const lines = captureLog(t);
  await cmdAccount(["list"]);
  const text = strip(lines.join("\n"));
  assert.match(text, /● mark\s+msk_live_mark\s+https:\/\/api\.example\.test/);
  assert.match(text, /○ work\s+msk_live_work/);
  assert.match(text, /2 of 3/);

  lines.length = 0;
  await cmdAccount(["list", "--json"]);
  const payload = JSON.parse(lines.join("\n")) as { active: string; limit: number; accounts: { name: string; active: boolean }[] };
  assert.equal(payload.active, "mark");
  assert.equal(payload.limit, 3);
  assert.deepEqual(payload.accounts.map((a) => [a.name, a.active]), [["mark", true], ["work", false]]);

  lines.length = 0;
  await cmdAccount([]);
  assert.match(strip(lines.join("\n")), /● mark/);
});

test("account list with nobody logged in says so", async (t) => {
  await withTempHome(t);
  const lines = captureLog(t);
  await cmdAccount(["list"]);
  assert.match(lines.join("\n"), /No accounts. Run `mergestorm login`/);
});

test("account use switches the active account and refuses an unknown name", async (t) => {
  await withTempHome(t);
  await seed();
  const lines = captureLog(t);
  await cmdAccount(["use", "work"]);
  assert.match(lines.join("\n"), /Active account: work/);
  assert.equal((await loadConfig()).account, "work");
  await assert.rejects(() => cmdAccount(["use", "nobody"]), /No account named "nobody". Accounts: mark, work./);
  await assert.rejects(
    () => cmdAccount(["use"]),
    (err: unknown) => err instanceof CommandError && err.code === "usage" && /needs an account name/.test(err.message),
  );
  await assert.rejects(
    () => cmdAccount(["frobnicate"]),
    (err: unknown) => err instanceof CommandError && /unknown account subcommand: frobnicate/.test(err.message),
  );
});

test("account remove revokes that account's own key, drops it, and keeps the others", async (t) => {
  await withTempHome(t);
  await seed();
  const calls: { url: string; method: string; auth: string }[] = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), method: init?.method ?? "GET", auth: headers.get("authorization") ?? "" });
    return new Response(JSON.stringify({ ok: true, id: "key-1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const lines = captureLog(t);
  await cmdAccount(["remove", "work"]);
  assert.deepEqual(calls, [
    { url: "https://api.example.test/api/v1/me/key", method: "DELETE", auth: "Bearer msk_live_work1234rest" },
  ]);
  const text = lines.join("\n");
  assert.match(text, /Logged out work. Its API key is revoked./);
  assert.match(text, /Active account: mark/);
  assert.deepEqual((await listAccounts()).map((a) => a.name), ["mark"]);
  assert.equal((await loadConfig()).apiKey, "msk_live_mark1234rest");
});

test("logoutAccount still drops the account when the key cannot be revoked, and says so", async (t) => {
  await withTempHome(t);
  await seed();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
  const lines = await logoutAccount("mark");
  assert.match(lines[0]!, /Logged out mark. Its API key could not be revoked/);
  assert.match(lines[1]!, /Active account: work/);
  assert.deepEqual((await listAccounts()).map((a) => [a.name, a.active]), [["work", true]]);

  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const last = await logoutAccount("work");
  assert.match(last[1]!, /No accounts left/);
  assert.deepEqual(await listAccounts(), []);
  await assert.rejects(() => logoutAccount("work"), /No account named "work". Nobody is logged in/);
});
