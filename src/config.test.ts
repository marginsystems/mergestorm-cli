import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ACCOUNT_LIMIT,
  accountNameFromMe,
  apiBase,
  configPath,
  listAccounts,
  loadConfig,
  mergestormHome,
  migrateStore,
  provisionalAccountName,
  readStore,
  removeAccount,
  resolveApiKey,
  saveAccount,
  serializeStore,
  settleAccountName,
  splitAccountFlag,
  useAccount,
  withAccount,
} from "./config.js";
import { CommandError } from "./errors.js";
import { cliStacksRoot } from "./repo-identity.js";

function withTempHome(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(path.join(tmpdir(), "mg-home-"));
  const previous = process.env.MERGESTORM_HOME;
  const previousAccount = process.env.MERGESTORM_ACCOUNT;
  const previousKey = process.env.MERGESTORM_API_KEY;
  process.env.MERGESTORM_HOME = root;
  delete process.env.MERGESTORM_ACCOUNT;
  delete process.env.MERGESTORM_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.MERGESTORM_HOME;
    else process.env.MERGESTORM_HOME = previous;
    if (previousAccount === undefined) delete process.env.MERGESTORM_ACCOUNT;
    else process.env.MERGESTORM_ACCOUNT = previousAccount;
    if (previousKey === undefined) delete process.env.MERGESTORM_API_KEY;
    else process.env.MERGESTORM_API_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

test("mergestormHome is ~/.mergestorm unless MERGESTORM_HOME names another directory", () => {
  assert.equal(mergestormHome({}), path.join(homedir(), ".mergestorm"));
  assert.equal(mergestormHome({ MERGESTORM_HOME: "   " }), path.join(homedir(), ".mergestorm"));
  assert.equal(mergestormHome({ MERGESTORM_HOME: " /workspace/.mg-state " }), "/workspace/.mg-state");
  assert.equal(mergestormHome({ MERGESTORM_HOME: "relative/state" }), path.resolve("relative/state"));
});

test("MERGESTORM_HOME moves the saved accounts and the stack state out of the home directory", async (t) => {
  const root = withTempHome(t);
  assert.equal(configPath(), path.join(root, "config.json"));
  assert.equal(cliStacksRoot(), path.join(root, "stacks"));
  await saveAccount("mark", { apiKey: "msk_live_test" });
  assert.deepEqual(readJson(path.join(root, "config.json")), {
    accounts: { mark: { apiKey: "msk_live_test" } },
    activeAccount: "mark",
    apiKey: "msk_live_test",
  });
  assert.deepEqual(await loadConfig(), { apiKey: "msk_live_test", account: "mark" });
});

test("MERGESTORM_API_KEY and MERGESTORM_API_URL win over a saved login but never over an ignoreEnv config", () => {
  const savedKey = process.env.MERGESTORM_API_KEY;
  const savedUrl = process.env.MERGESTORM_API_URL;
  process.env.MERGESTORM_API_KEY = "msk_live_from_env_aaaaaaaaaaaaaaaa";
  process.env.MERGESTORM_API_URL = "https://env.example.test";
  try {
    const saved = { apiKey: "msk_live_saved_bbbbbbbbbbbbbbbb", apiBase: "https://saved.example.test/" };
    assert.equal(resolveApiKey(saved), "msk_live_from_env_aaaaaaaaaaaaaaaa");
    assert.equal(apiBase(saved), "https://env.example.test");
    const pinned = { ...saved, ignoreEnv: true };
    assert.equal(resolveApiKey(pinned), "msk_live_saved_bbbbbbbbbbbbbbbb");
    assert.equal(apiBase(pinned), "https://saved.example.test");
    assert.equal(resolveApiKey({ ignoreEnv: true }), undefined);
  } finally {
    if (savedKey === undefined) delete process.env.MERGESTORM_API_KEY;
    else process.env.MERGESTORM_API_KEY = savedKey;
    if (savedUrl === undefined) delete process.env.MERGESTORM_API_URL;
    else process.env.MERGESTORM_API_URL = savedUrl;
  }
});

test("migrateStore turns a single-key config into one provisional account and keeps a modern store as is", () => {
  const legacy = migrateStore({ apiKey: "msk_live_abcd1234rest", apiBase: "https://api.example.test", ignoreEnv: true });
  assert.equal(legacy.migrated, true);
  assert.deepEqual(legacy.store, {
    accounts: { msk_live_abcd: { apiKey: "msk_live_abcd1234rest", apiBase: "https://api.example.test" } },
    activeAccount: "msk_live_abcd",
    ignoreEnv: true,
  });
  assert.equal(provisionalAccountName("msk_live_abcd1234rest"), "msk_live_abcd");

  const baseOnly = migrateStore({ apiBase: "https://api.example.test" });
  assert.deepEqual(baseOnly.store, { accounts: {}, apiBase: "https://api.example.test" });
  assert.equal(baseOnly.migrated, true);

  assert.deepEqual(migrateStore({}), { store: { accounts: {} }, migrated: false });
  assert.deepEqual(migrateStore("junk"), { store: { accounts: {} }, migrated: false });

  const modern = migrateStore({
    accounts: { a: { apiKey: "msk_live_a" }, b: { apiKey: "msk_live_b", apiBase: "https://b.example.test" }, broken: {} },
    activeAccount: "gone",
  });
  assert.equal(modern.migrated, true);
  assert.deepEqual(modern.store, {
    accounts: { a: { apiKey: "msk_live_a" }, b: { apiKey: "msk_live_b", apiBase: "https://b.example.test" } },
    activeAccount: "a",
  });
});

test("the file keeps the active account's key at the top level for older readers, and an older writer's key becomes an account", () => {
  const accounts = { a: { apiKey: "msk_live_a" }, b: { apiKey: "msk_live_b", apiBase: "https://b.example.test" } };
  assert.deepEqual(serializeStore({ accounts, activeAccount: "b" }), {
    accounts,
    activeAccount: "b",
    apiKey: "msk_live_b",
    apiBase: "https://b.example.test",
  });
  assert.deepEqual(serializeStore({ accounts, activeAccount: "a", apiBase: "https://stale.example.test" }), {
    accounts,
    activeAccount: "a",
    apiKey: "msk_live_a",
  });
  assert.deepEqual(serializeStore({ accounts: {}, apiBase: "https://only.example.test" }), {
    accounts: {},
    apiBase: "https://only.example.test",
  });

  const consistent = migrateStore({ accounts, activeAccount: "b", apiKey: "msk_live_b", apiBase: "https://b.example.test" });
  assert.deepEqual(consistent, { store: { accounts, activeAccount: "b" }, migrated: false });

  const switched = migrateStore({ accounts, activeAccount: "a", apiKey: "msk_live_b" });
  assert.deepEqual(switched, { store: { accounts, activeAccount: "b" }, migrated: true });

  const legacyWriter = migrateStore({ accounts, activeAccount: "a", apiKey: "msk_live_zzzz1234new", apiBase: "https://api.example.test" });
  assert.equal(legacyWriter.migrated, true);
  assert.deepEqual(legacyWriter.store, {
    accounts: { ...accounts, msk_live_zzzz: { apiKey: "msk_live_zzzz1234new", apiBase: "https://api.example.test" } },
    activeAccount: "msk_live_zzzz",
  });
});

test("a single-key config migrates in place on first read and every command sees that account", async (t) => {
  const root = withTempHome(t);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "config.json"), JSON.stringify({ apiKey: "msk_live_old1rest", apiBase: "https://api.example.test" }));
  assert.deepEqual(await loadConfig(), { apiKey: "msk_live_old1rest", apiBase: "https://api.example.test", account: "msk_live_old1" });
  assert.deepEqual(readJson(path.join(root, "config.json")), {
    accounts: { msk_live_old1: { apiKey: "msk_live_old1rest", apiBase: "https://api.example.test" } },
    activeAccount: "msk_live_old1",
    apiKey: "msk_live_old1rest",
    apiBase: "https://api.example.test",
  });
  assert.deepEqual(await listAccounts(), [
    { name: "msk_live_old1", active: true, keyPrefix: "msk_live_old1", apiBase: "https://api.example.test" },
  ]);
});

test("a provisional account takes the name /me reports, once", async (t) => {
  withTempHome(t);
  await saveAccount("msk_live_old1", { apiKey: "msk_live_old1rest" });
  await saveAccount("other", { apiKey: "msk_live_otherrest" });
  const cfg = await loadConfig();
  assert.equal(cfg.account, "msk_live_old1");
  assert.equal(await settleAccountName(cfg, null), "msk_live_old1");
  assert.equal(await settleAccountName(cfg, { account: { github_login: null, email: null } }), "msk_live_old1");
  assert.equal(await settleAccountName(cfg, { account: { github_login: "mark", email: "mark@example.test" } }), "mark");
  assert.deepEqual((await listAccounts()).map((a) => [a.name, a.active]), [["other", false], ["mark", true]]);
  const named = await loadConfig();
  assert.equal(named.account, "mark");
  assert.equal(await settleAccountName(named, { account: { github_login: "renamed", email: null } }), "mark");
  assert.equal(accountNameFromMe({ account: { github_login: " ", email: " mark@example.test " } }), "mark@example.test");
  assert.equal(accountNameFromMe({}), null);
});

test("saveAccount keeps up to three accounts, re-authenticates one in place, and refuses a fourth by name", async (t) => {
  withTempHome(t);
  await saveAccount("a", { apiKey: "msk_live_a1" });
  await saveAccount("b", { apiKey: "msk_live_b1" }, { activate: true });
  await saveAccount("c", { apiKey: "msk_live_c1" });
  assert.equal(ACCOUNT_LIMIT, 3);
  assert.deepEqual((await listAccounts()).map((a) => [a.name, a.active]), [["a", false], ["b", true], ["c", false]]);
  await saveAccount("a", { apiKey: "msk_live_a2" }, { activate: true });
  assert.equal((await loadConfig()).apiKey, "msk_live_a2");
  await assert.rejects(
    () => saveAccount("d", { apiKey: "msk_live_d1" }),
    (err: unknown) => err instanceof CommandError && err.code === "account_limit" && /Already 3 accounts: a, b, c/.test(err.message),
  );
  assert.deepEqual((await listAccounts()).map((a) => a.name), ["a", "b", "c"]);
});

test("useAccount switches the active account and removeAccount drops one and falls back to the first left", async (t) => {
  withTempHome(t);
  await saveAccount("a", { apiKey: "msk_live_a1" });
  await saveAccount("b", { apiKey: "msk_live_b1" });
  await useAccount("b");
  assert.equal((await loadConfig()).account, "b");
  await assert.rejects(() => useAccount("zz"), /No account named "zz". Accounts: a, b./);
  await removeAccount("b");
  assert.equal((await loadConfig()).account, "a");
  await removeAccount("a");
  assert.deepEqual(await loadConfig(), {});
  await assert.rejects(() => removeAccount("a"), /No account named "a". Nobody is logged in/);
  assert.deepEqual(await readStore(), { accounts: {} });
});

test("--account beats MERGESTORM_ACCOUNT, which beats the active account, and an unknown name is refused", async (t) => {
  withTempHome(t);
  await saveAccount("a", { apiKey: "msk_live_a1" });
  await saveAccount("b", { apiKey: "msk_live_b1" });
  await saveAccount("c", { apiKey: "msk_live_c1" });
  await useAccount("a");
  assert.equal((await loadConfig()).apiKey, "msk_live_a1");
  process.env.MERGESTORM_ACCOUNT = "b";
  assert.equal((await loadConfig()).apiKey, "msk_live_b1");
  assert.equal(await withAccount("c", async () => (await loadConfig()).apiKey), "msk_live_c1");
  assert.equal((await loadConfig()).apiKey, "msk_live_b1");
  assert.equal(await withAccount(undefined, async () => (await loadConfig()).account), "b");
  process.env.MERGESTORM_ACCOUNT = "nope";
  await assert.rejects(() => loadConfig(), /No account named "nope". Accounts: a, b, c./);
  await assert.rejects(() => withAccount("nope", () => loadConfig()), /No account named "nope"/);
  delete process.env.MERGESTORM_ACCOUNT;
  assert.equal((await loadConfig()).account, "a");
  process.env.MERGESTORM_API_KEY = "msk_live_env";
  assert.equal(resolveApiKey(await withAccount("c", () => loadConfig())), "msk_live_env");
});

test("splitAccountFlag lifts --account out of any argv position", () => {
  assert.deepEqual(splitAccountFlag(["--account", "b", "whoami", "--json"]), { account: "b", args: ["whoami", "--json"] });
  assert.deepEqual(splitAccountFlag(["stack", "submit", "--account=c"]), { account: "c", args: ["stack", "submit"] });
  assert.deepEqual(splitAccountFlag(["review", "main"]), { args: ["review", "main"] });
  for (const argv of [["whoami", "--account"], ["--account", "--json"], ["--account="]]) {
    assert.throws(() => splitAccountFlag(argv), (err: unknown) => err instanceof CommandError && /--account needs an account name/.test(err.message));
  }
});
