import { getMe } from "../api.js";
import { apiBase, configPath, loadConfig, resolveApiKey } from "../config.js";
import { CommandError } from "../errors.js";
import { ansi } from "../ui/ansi.js";
import { present } from "../ui/present.js";
import { canBrowse, openTabsBrowser } from "./browse.js";

export async function cmdWhoami(
  args: string[],
  opts: { mode?: "oneshot" | "shell" } = {},
): Promise<void> {
  const asJson = args.includes("--json");
  const cfg = await loadConfig();
  const key = resolveApiKey(cfg);
  if (!key) {
    throw new CommandError("Not logged in. Run `mergestorm login`.");
  }
  if (!asJson && canBrowse()) {
    await openTabsBrowser("status");
    return;
  }
  const me = await getMe(cfg);
  if (!me) {
    throw new CommandError("Live account details unavailable. Could not verify account with /me.");
  }
  const payload = {
    key_prefix: me.key.prefix,
    key_name: me.key.name ?? null,
    plan_key: me.plan_key ?? null,
    plan_label_key: me.plan_label_key ?? null,
    api_base: apiBase(cfg),
    config_path: configPath(),
    usage: me.usage ?? null,
  };
  if (asJson) {
    const text = JSON.stringify(payload, null, 2);
    if (opts.mode === "shell") {
      await present("Account", text.split("\n"));
      return;
    }
    console.log(text);
    return;
  }
  const lines = [
    `  Key      ${ansi.bold(String(payload.key_prefix))}${payload.key_name ? ` (${payload.key_name})` : ""}`,
  ];
  if (payload.plan_key) {
    lines.push(`  Plan     ${payload.plan_label_key ?? payload.plan_key}`);
  }
  lines.push(`  API      ${payload.api_base}`);
  lines.push(`  Config   ${payload.config_path}`);
  await present("Account", lines);
}
