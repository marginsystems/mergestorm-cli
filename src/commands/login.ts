import { spawn } from "node:child_process";
import { platform } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  accountNameFromMe,
  apiBase,
  configFor,
  configPath,
  mergestormHome,
  provisionalAccountName,
  readStore,
  saveAccount,
  type Config,
  type NamedMe,
} from "../config.js";
import { accountLabel, devicePost, getMe, revokeOwnKey, type AccountIdentity, type MeResponse } from "../api.js";
import { CommandError } from "../errors.js";
import { ansi } from "../ui/ansi.js";
import { present } from "../ui/present.js";
import { readSecretLine } from "../ui/secret-input.js";

function openBrowser(url: string): void {
  const os = platform();
  const cmd = os === "darwin" ? "open" : os === "win32" ? "cmd" : "xdg-open";
  const args = os === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // URL is printed for manual open
  }
}

/**
 * Probe /api/v1/me with an in-memory config. Does not write disk.
 * Throws CommandError when the key must not be saved.
 */
export async function validateApiKey(cfg: Config): Promise<MeResponse> {
  try {
    const me = await getMe(cfg);
    if (!me) {
      throw new CommandError(
        "Could not verify API key (API unreachable or too old). Key was not saved.",
      );
    }
    return me;
  } catch (err) {
    if (err instanceof CommandError && err.code === "auth_invalid") {
      throw new CommandError(
        "API key invalid or revoked. Key was not saved. Check the key and run `mergestorm login --key` again.",
        1,
        "auth_invalid",
      );
    }
    throw err;
  }
}

async function loginConfig(): Promise<Config> {
  const store = await readStore();
  return configFor(store, store.activeAccount);
}

export function loggedInLine(account: AccountIdentity | null | undefined): string {
  const label = accountLabel(account);
  return label ? `Logged in as ${label}.` : "Logged in.";
}

async function storeLogin(
  cfg: Config,
  me: NamedMe | null,
  opts: { minted: boolean },
): Promise<string> {
  const apiKey = cfg.apiKey ?? "";
  const name = accountNameFromMe(me) ?? provisionalAccountName(apiKey);
  const before = await readStore();
  const replaced = Object.hasOwn(before.accounts, name) ? configFor(before, name) : undefined;
  try {
    await saveAccount(name, { apiKey, apiBase: cfg.apiBase }, { activate: true });
  } catch (err) {
    if (opts.minted && err instanceof CommandError && err.code === "account_limit") {
      await revokeOwnKey(cfg, { timeoutMs: 8_000 });
    }
    throw err;
  }
  if (replaced?.apiKey && replaced.apiKey !== apiKey) {
    await revokeOwnKey({ ...replaced, ignoreEnv: true }, { timeoutMs: 8_000 });
  }
  return name;
}

async function loginWithKey(): Promise<void> {
  // Always use muted secret input on TTY so the key never lands in
  // question()/history echo.
  const key = (
    await readSecretLine("Paste your Mergestorm API key (msk_live_...): ")
  ).trim();
  if (!key.startsWith("msk_live_")) {
    throw new CommandError("Key should start with msk_live_");
  }
  const cfg = await loginConfig();
  const candidate: Config = { apiKey: key, apiBase: apiBase(cfg), ignoreEnv: true };
  const me = await validateApiKey(candidate);
  const name = await storeLogin(candidate, me, { minted: false });
  const prefix = me.key?.prefix?.trim() || "msk_live_…";
  await present("Login", [`  Logged in as ${name}. Verified ${prefix}… · saved to ${configPath()}`]);
}

type DeviceStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
};

type PendingLogin = {
  deviceCode: string;
  userCode: string;
  openUrl: string;
  apiBase: string;
  pollMs: number;
  expiresAt: number;
};

export function pendingLoginPath(): string {
  return path.join(mergestormHome(), "login-pending.json");
}

async function savePendingLogin(pending: PendingLogin): Promise<void> {
  await mkdir(mergestormHome(), { recursive: true });
  await writeFile(pendingLoginPath(), JSON.stringify(pending, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function loadPendingLogin(): Promise<PendingLogin | null> {
  try {
    const parsed = JSON.parse(await readFile(pendingLoginPath(), "utf8")) as Partial<PendingLogin>;
    if (
      typeof parsed.deviceCode !== "string" ||
      typeof parsed.userCode !== "string" ||
      typeof parsed.openUrl !== "string" ||
      typeof parsed.apiBase !== "string" ||
      typeof parsed.pollMs !== "number" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return parsed as PendingLogin;
  } catch {
    return null;
  }
}

async function clearPendingLogin(deviceCode: string): Promise<void> {
  const pending = await loadPendingLogin();
  if (pending?.deviceCode !== deviceCode) return;
  await rm(pendingLoginPath(), { force: true });
}

async function startDeviceLogin(base: string): Promise<DeviceStart> {
  let start;
  let attempt = 0;
  do {
    try {
      start = await devicePost(base, "/api/v1/cli/device", {});
    } catch {
      throw new CommandError(
        "Could not start device login. The API may be unreachable or misconfigured.\n" +
          "Run `mergestorm login --key` to paste an existing API key instead.",
      );
    }
    const err = start.body?.error;
    if (err !== "rate_limited" && err !== "slow_down") break;
    if (start.status !== 429 && start.status !== 400) break;
    const backoff = Number(start.body?.retry_after_seconds);
    const waitMs = Number.isFinite(backoff) && backoff > 0 ? backoff * 1000 : 5000;
    if (attempt === 2) {
      throw new CommandError(
        `Device login is rate limited for this IP. Wait ${Math.ceil(waitMs / 1000)}s, then run \`mergestorm login\` again.`,
      );
    }
    console.log(
      `Device login is rate limited. Waiting ${Math.ceil(waitMs / 1000)}s before trying again…`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
    attempt += 1;
  } while (attempt < 3);
  if (start.status !== 200 || !start.body?.device_code) {
    throw new CommandError(
      `Could not start device login (HTTP ${start.status}). The API may be unreachable or misconfigured.\n` +
        `Run \`mergestorm login --key\` to paste an existing API key instead.`,
    );
  }
  return start.body as DeviceStart;
}

function pendingFromStart(base: string, start: DeviceStart): PendingLogin {
  return {
    deviceCode: start.device_code,
    userCode: start.user_code,
    openUrl: start.verification_uri_complete || start.verification_uri,
    apiBase: base,
    pollMs: Math.max(start.interval || 5, 2) * 1000,
    expiresAt: Date.now() + (start.expires_in || 600) * 1000,
  };
}

async function pollDeviceLogin(
  pending: PendingLogin,
  retryCommand: string,
  recovery: string,
): Promise<void> {
  while (Date.now() < pending.expiresAt) {
    let poll;
    try {
      poll = await devicePost(pending.apiBase, "/api/v1/cli/device/token", {
        device_code: pending.deviceCode,
      });
    } catch {
      throw new CommandError(
        `Login failed: network error. Check your connection and run \`${retryCommand}\` again.`,
      );
    }
    if (poll.status === 200 && poll.body?.api_key) {
      const minted: Config = { apiKey: poll.body.api_key as string, apiBase: pending.apiBase, ignoreEnv: true };
      await clearPendingLogin(pending.deviceCode);
      let me: NamedMe | null = accountLabel(poll.body?.account as AccountIdentity | undefined)
        ? { account: poll.body.account as AccountIdentity }
        : null;
      if (!me) {
        try {
          me = await getMe(minted, { timeoutMs: 8_000 });
        } catch {
          me = null;
        }
      }
      const name = await storeLogin(minted, me, { minted: true });
      await present("Login", [`  Logged in as ${name}. Key saved to ${configPath()}`]);
      return;
    }
    const err = poll.body?.error;
    if (err === "authorization_pending") {
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, pending.pollMs));
      continue;
    }
    if (err === "slow_down" || err === "rate_limited") {
      const backoff = Number(poll.body?.retry_after_seconds);
      await new Promise((r) =>
        setTimeout(r, Number.isFinite(backoff) && backoff > 0 ? backoff * 1000 : pending.pollMs),
      );
      continue;
    }
    if (err === "key_limit_reached") {
      throw new CommandError(
        "You have reached the max active API keys. Revoke one at https://mergestorm.ai/settings#api and try again.",
      );
    }
    if (err === "expired_token" || err === "already_redeemed" || err === "access_denied") {
      await clearPendingLogin(pending.deviceCode);
    }
    if (err === "expired_token") {
      throw new CommandError(`Login code expired. ${recovery}`);
    }
    if (err === "already_redeemed") {
      throw new CommandError(`This code was already used. ${recovery}`);
    }
    throw new CommandError(
      `Login failed: ${typeof err === "string" ? err : JSON.stringify(poll.body)}`,
    );
  }
  await clearPendingLogin(pending.deviceCode);
  throw new CommandError(`Login timed out. ${recovery}`);
}

async function loginStart(): Promise<void> {
  const cfg = await loginConfig();
  const base = apiBase(cfg);
  const pending = pendingFromStart(base, await startDeviceLogin(base));
  await savePendingLogin(pending);
  const minutes = Math.max(1, Math.round((pending.expiresAt - Date.now()) / 60_000));
  console.log("Ask the account owner to open this URL, sign in, and approve the code:\n");
  console.log(`  ${pending.openUrl}`);
  console.log(`\n  Code: ${pending.userCode}\n`);
  console.log(`The code expires in ${minutes} minutes.`);
  console.log("After they approve, run `mergestorm login --finish` to store the API key.");
}

async function loginFinish(): Promise<void> {
  const pending = await loadPendingLogin();
  if (!pending) {
    throw new CommandError("No login is waiting. Run `mergestorm login --start` first.");
  }
  if (Date.now() >= pending.expiresAt) {
    await clearPendingLogin(pending.deviceCode);
    throw new CommandError("Login code expired. Run `mergestorm login --start` again.");
  }
  console.log(`Waiting for approval of code ${pending.userCode} at ${pending.openUrl}`);
  await pollDeviceLogin(
    pending,
    "mergestorm login --finish",
    "Run `mergestorm login --start`, then `mergestorm login --finish`.",
  );
}

export interface LoginDeps {
  openBrowser: (url: string) => void;
}

export async function cmdLogin(
  args: string[],
  deps: LoginDeps = { openBrowser },
): Promise<void> {
  if (args.includes("--key")) {
    await loginWithKey();
    return;
  }
  if (args.includes("--start")) {
    await loginStart();
    return;
  }
  if (args.includes("--finish")) {
    await loginFinish();
    return;
  }

  const cfg = await loginConfig();
  const base = apiBase(cfg);
  const pending = pendingFromStart(base, await startDeviceLogin(base));

  console.log("To sign in, open this URL and confirm the code:\n");
  console.log(`  ${ansi.brightGreen(pending.openUrl)}`);
  console.log(`\n  Code: ${ansi.bold(pending.userCode)}\n`);
  if (process.stdout.isTTY) {
    deps.openBrowser(pending.openUrl);
  } else {
    console.log(
      "No terminal here. If this command may be cut off before the approval, use `mergestorm login --start`, then `mergestorm login --finish`.",
    );
  }
  console.log("Waiting for approval…");
  await pollDeviceLogin(pending, "mergestorm login", "Run `mergestorm login` again.");
}
