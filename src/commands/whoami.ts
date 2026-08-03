import { getMe } from "../api.js";
import { apiBase, configPath, loadConfig, resolveApiKey, keyDisplay } from "../config.js";
import { CommandError } from "../errors.js";
import { ansi } from "../ui/ansi.js";

export async function cmdWhoami(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const cfg = await loadConfig();
  const key = resolveApiKey(cfg);
  if (!key) {
    throw new CommandError("Not logged in. Run `mergestorm login`.");
  }
  const me = await getMe(cfg);
  const payload = {
    key_prefix: me?.key.prefix ?? keyDisplay(key),
    key_name: me?.key.name ?? null,
    plan_key: me?.plan_key ?? null,
    plan_label_key: me?.plan_label_key ?? null,
    api_base: apiBase(cfg),
    config_path: configPath(),
    usage: me?.usage ?? null,
  };
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`  Key      ${ansi.bold(String(payload.key_prefix))}${payload.key_name ? ` (${payload.key_name})` : ""}`);
  if (payload.plan_key) {
    console.log(`  Plan     ${payload.plan_label_key ?? payload.plan_key}`);
  }
  console.log(`  API      ${payload.api_base}`);
  console.log(`  Config   ${payload.config_path}`);
  if (!me) {
    console.log(ansi.dim("  (live account details unavailable — older API or offline)"));
  }
}
