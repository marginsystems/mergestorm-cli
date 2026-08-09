import { spawn } from "node:child_process";
import { platform } from "node:os";
import { apiBase, configPath, loadConfig, saveConfig, type Config } from "../config.js";
import { devicePost, getMe, type MeResponse } from "../api.js";
import { CommandError } from "../errors.js";
import { ansi } from "../ui/ansi.js";
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

async function loginWithKey(): Promise<void> {
  // Always use muted secret input on TTY so the key never lands in
  // question()/history echo.
  const key = (
    await readSecretLine("Paste your Mergestorm API key (msk_live_...): ")
  ).trim();
  if (!key.startsWith("msk_live_")) {
    throw new CommandError("Key should start with msk_live_");
  }
  const cfg = await loadConfig();
  cfg.apiKey = key;
  const me = await validateApiKey(cfg);
  await saveConfig(cfg);
  const prefix = me.key?.prefix?.trim() || "msk_live_…";
  console.log(`Verified ${prefix}… · saved to ${configPath()}`);
}

export async function cmdLogin(args: string[]): Promise<void> {
  if (args.includes("--key")) {
    await loginWithKey();
    return;
  }

  const cfg = await loadConfig();
  const base = apiBase(cfg);

  let start;
  try {
    start = await devicePost(base, "/api/v1/cli/device", {});
  } catch {
    throw new CommandError(
      "Could not start device login. The API may be unreachable or misconfigured.\n" +
        "Run `mergestorm login --key` to paste an existing API key instead.",
    );
  }
  if (start.status !== 200 || !start.body?.device_code) {
    throw new CommandError(
      `Could not start device login (HTTP ${start.status}). The API may be unreachable or misconfigured.\n` +
        `Run \`mergestorm login --key\` to paste an existing API key instead.`,
    );
  }

  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    interval,
    expires_in,
  } = start.body as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    interval: number;
    expires_in: number;
  };

  const openUrl = verification_uri_complete || verification_uri;
  console.log("To sign in, open this URL and confirm the code:\n");
  console.log(`  ${ansi.green(openUrl)}`);
  console.log(`\n  Code: ${ansi.bold(user_code)}\n`);
  openBrowser(openUrl);
  console.log("Waiting for approval…");

  const pollMs = Math.max(interval || 5, 2) * 1000;
  const deadline = Date.now() + (expires_in || 600) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    let poll;
    try {
      poll = await devicePost(base, "/api/v1/cli/device/token", { device_code });
    } catch {
      throw new CommandError(
        "Login failed: network error. Check your connection and run `mergestorm login` again.",
      );
    }
    if (poll.status === 200 && poll.body?.api_key) {
      const next = await loadConfig();
      next.apiKey = poll.body.api_key as string;
      await saveConfig(next);
      console.log(`\nLogged in. Key saved to ${configPath()}`);
      return;
    }
    const err = poll.body?.error;
    if (err === "authorization_pending") {
      process.stdout.write(".");
      continue;
    }
    if (err === "key_limit_reached") {
      throw new CommandError(
        "You have reached the max active API keys. Revoke one at https://mergestorm.ai/settings#api and try again.",
      );
    }
    if (err === "expired_token") {
      throw new CommandError("Login code expired. Run `mergestorm login` again.");
    }
    if (err === "already_redeemed") {
      throw new CommandError("This code was already used. Run `mergestorm login` again.");
    }
    throw new CommandError(
      `Login failed: ${typeof err === "string" ? err : JSON.stringify(poll.body)}`,
    );
  }
  throw new CommandError("Login timed out. Run `mergestorm login` again.");
}
