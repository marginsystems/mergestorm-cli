import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CommandError } from "./errors.js";

export const DEFAULT_API = "https://api.mergestorm.ai";

export const ACCOUNT_LIMIT = 3;

const KEY_PREFIX_LENGTH = "msk_live_".length + 4;

export type Config = {
  apiKey?: string;
  apiBase?: string;
  ignoreEnv?: boolean;
  account?: string;
};

export type StoredAccount = {
  apiKey: string;
  apiBase?: string;
};

export type AccountStore = {
  accounts: Record<string, StoredAccount>;
  activeAccount?: string;
  apiBase?: string;
  ignoreEnv?: boolean;
};

type StoreFile = AccountStore & { apiKey?: string };

export type AccountSummary = {
  name: string;
  active: boolean;
  keyPrefix: string;
  apiBase: string;
};

export type NamedMe = {
  account?: { github_login?: string | null; email?: string | null } | null;
};

export function mergestormHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MERGESTORM_HOME?.trim();
  return override ? path.resolve(override) : path.join(homedir(), ".mergestorm");
}

export function configPath(): string {
  return path.join(mergestormHome(), "config.json");
}

export function provisionalAccountName(apiKey: string): string {
  return apiKey.slice(0, KEY_PREFIX_LENGTH);
}

export function accountNameFromMe(me: NamedMe | null | undefined): string | null {
  const login = me?.account?.github_login?.trim();
  if (login) return login;
  const email = me?.account?.email?.trim();
  return email || null;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compact(store: AccountStore): AccountStore {
  const out: AccountStore = { accounts: store.accounts };
  if (store.activeAccount && store.accounts[store.activeAccount]) out.activeAccount = store.activeAccount;
  if (store.apiBase) out.apiBase = store.apiBase;
  if (store.ignoreEnv) out.ignoreEnv = true;
  return out;
}

function storedAccount(apiKey: string, apiBase: string | undefined): StoredAccount {
  return apiBase ? { apiKey, apiBase } : { apiKey };
}

export function serializeStore(store: AccountStore): StoreFile {
  const out: StoreFile = compact(store);
  const active = out.activeAccount ? out.accounts[out.activeAccount] : undefined;
  if (!active) return out;
  out.apiKey = active.apiKey;
  if (active.apiBase) out.apiBase = active.apiBase;
  else delete out.apiBase;
  return out;
}

export function migrateStore(raw: unknown): { store: AccountStore; migrated: boolean } {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ignoreEnv = obj.ignoreEnv === true ? true : undefined;
  const apiBase = cleanString(obj.apiBase);
  const apiKey = cleanString(obj.apiKey);
  if (obj.accounts && typeof obj.accounts === "object") {
    const accounts: Record<string, StoredAccount> = {};
    for (const [name, value] of Object.entries(obj.accounts as Record<string, unknown>)) {
      const entry = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const key = cleanString(entry.apiKey);
      if (!key) continue;
      accounts[name] = storedAccount(key, cleanString(entry.apiBase));
    }
    const requested = cleanString(obj.activeAccount);
    let activeAccount = requested && Object.hasOwn(accounts, requested) ? requested : Object.keys(accounts)[0];
    let migrated = false;
    if (apiKey) {
      const owner = Object.keys(accounts).find((name) => accounts[name]!.apiKey === apiKey);
      if (!owner) {
        if (Object.keys(accounts).length < ACCOUNT_LIMIT) {
          const name = provisionalAccountName(apiKey);
          accounts[name] = storedAccount(apiKey, apiBase);
          activeAccount = name;
          migrated = true;
        }
      } else if (owner !== activeAccount) {
        activeAccount = owner;
        migrated = true;
      }
    } else if (activeAccount) {
      migrated = true;
    }
    const store = compact({ accounts, activeAccount, apiBase: activeAccount ? undefined : apiBase, ignoreEnv });
    return { store, migrated };
  }
  if (!apiKey) {
    return { store: compact({ accounts: {}, apiBase, ignoreEnv }), migrated: Object.keys(obj).length > 0 };
  }
  const name = provisionalAccountName(apiKey);
  return {
    store: compact({ accounts: { [name]: storedAccount(apiKey, apiBase) }, activeAccount: name, ignoreEnv }),
    migrated: true,
  };
}

export async function writeStore(store: AccountStore): Promise<void> {
  const file = configPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(serializeStore(store), null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readStore(): Promise<AccountStore> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath(), "utf8"));
  } catch {
    return { accounts: {} };
  }
  const { store, migrated } = migrateStore(raw);
  if (migrated) {
    try {
      await writeStore(store);
    } catch {
      return store;
    }
  }
  return store;
}

function accountNames(store: AccountStore): string[] {
  return Object.keys(store.accounts);
}

function unknownAccountMessage(name: string, store: AccountStore): string {
  const names = accountNames(store);
  if (names.length === 0) {
    return `No account named "${name}". Nobody is logged in; run \`mergestorm login\`.`;
  }
  return `No account named "${name}". Accounts: ${names.join(", ")}.`;
}

let accountOverride: string | undefined;

export async function withAccount<T>(name: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!name) return fn();
  const previous = accountOverride;
  accountOverride = name;
  try {
    return await fn();
  } finally {
    accountOverride = previous;
  }
}

export function requestedAccount(store: AccountStore, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (accountOverride) return accountOverride;
  if (store.ignoreEnv) return undefined;
  return env.MERGESTORM_ACCOUNT?.trim() || undefined;
}

export function selectAccountName(store: AccountStore, requested: string | undefined): string | undefined {
  if (!requested) return store.activeAccount;
  if (Object.hasOwn(store.accounts, requested)) return requested;
  throw new CommandError(unknownAccountMessage(requested, store));
}

export function configFor(store: AccountStore, name: string | undefined): Config {
  const account = name ? store.accounts[name] : undefined;
  const cfg: Config = {};
  if (account && name) {
    cfg.apiKey = account.apiKey;
    cfg.account = name;
  }
  const base = account?.apiBase ?? store.apiBase;
  if (base) cfg.apiBase = base;
  if (store.ignoreEnv) cfg.ignoreEnv = true;
  return cfg;
}

export async function loadConfig(): Promise<Config> {
  const store = await readStore();
  return configFor(store, selectAccountName(store, requestedAccount(store)));
}

export function accountLimitMessage(store: AccountStore): string {
  return `Already ${ACCOUNT_LIMIT} accounts: ${accountNames(store).join(", ")}. Remove one with \`mergestorm account remove <name>\` first.`;
}

export async function saveAccount(
  name: string,
  account: StoredAccount,
  opts: { activate?: boolean } = {},
): Promise<AccountStore> {
  const store = await readStore();
  if (!Object.hasOwn(store.accounts, name) && accountNames(store).length >= ACCOUNT_LIMIT) {
    throw new CommandError(accountLimitMessage(store), 1, "account_limit");
  }
  store.accounts[name] = storedAccount(account.apiKey, account.apiBase);
  if (opts.activate || !store.activeAccount) store.activeAccount = name;
  await writeStore(store);
  return store;
}

export async function useAccount(name: string): Promise<AccountStore> {
  const store = await readStore();
  if (!Object.hasOwn(store.accounts, name)) throw new CommandError(unknownAccountMessage(name, store));
  store.activeAccount = name;
  await writeStore(store);
  return store;
}

export async function removeAccount(name: string): Promise<AccountStore> {
  const store = await readStore();
  if (!Object.hasOwn(store.accounts, name)) throw new CommandError(unknownAccountMessage(name, store));
  delete store.accounts[name];
  if (store.activeAccount === name) store.activeAccount = accountNames(store)[0];
  await writeStore(store);
  return store;
}

export async function renameAccount(from: string, to: string): Promise<AccountStore> {
  const store = await readStore();
  const account = store.accounts[from];
  if (!account || from === to) return store;
  if (Object.hasOwn(store.accounts, to)) {
    throw new CommandError(`An account named "${to}" already exists, so ${from} keeps its name.`);
  }
  delete store.accounts[from];
  store.accounts[to] = account;
  if (store.activeAccount === from) store.activeAccount = to;
  await writeStore(store);
  return store;
}

export function summarizeAccounts(store: AccountStore): AccountSummary[] {
  return Object.entries(store.accounts).map(([name, account]) => ({
    name,
    active: name === store.activeAccount,
    keyPrefix: provisionalAccountName(account.apiKey),
    apiBase: (account.apiBase ?? store.apiBase ?? DEFAULT_API).replace(/\/$/, ""),
  }));
}

export async function listAccounts(): Promise<AccountSummary[]> {
  return summarizeAccounts(await readStore());
}

export async function settleAccountName(cfg: Config, me: NamedMe | null | undefined): Promise<string | undefined> {
  if (!cfg.account || !cfg.apiKey || resolveApiKey(cfg) !== cfg.apiKey) return cfg.account;
  if (cfg.account !== provisionalAccountName(cfg.apiKey)) return cfg.account;
  const name = accountNameFromMe(me);
  if (!name || name === cfg.account) return cfg.account;
  try {
    await renameAccount(cfg.account, name);
  } catch {
    return cfg.account;
  }
  return name;
}

export function splitAccountFlag(args: readonly string[]): { account?: string; args: string[] } {
  const rest: string[] = [];
  let account: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === "--account") {
      value = args[i + 1];
      if (value === undefined || value.startsWith("-")) value = "";
      else i += 1;
    } else if (arg.startsWith("--account=")) {
      value = arg.slice("--account=".length);
    } else {
      rest.push(arg);
      continue;
    }
    if (!value.trim()) {
      throw new CommandError("--account needs an account name. `mergestorm account list` shows them.", 1, "usage");
    }
    account = value.trim();
  }
  return account ? { account, args: rest } : { args: rest };
}

export function apiBase(cfg: Config): string {
  const fromEnv = cfg.ignoreEnv ? undefined : process.env.MERGESTORM_API_URL?.trim();
  return (fromEnv || cfg.apiBase || DEFAULT_API).replace(/\/$/, "");
}

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveChatId(cfg: Config): string | undefined {
  if (cfg.ignoreEnv) return undefined;
  const chatId = process.env.MERGESTORM_CHAT_ID?.trim() ?? "";
  return CHAT_ID.test(chatId) ? chatId.toLowerCase() : undefined;
}

export function resolveApiKey(cfg: Config): string | undefined {
  if (cfg.ignoreEnv) return cfg.apiKey;
  return process.env.MERGESTORM_API_KEY?.trim() || cfg.apiKey;
}

/** Short display form of a stored key (prefix only). */
export function keyDisplay(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length <= 16) return key;
  return `${key.slice(0, 12)}…`;
}
