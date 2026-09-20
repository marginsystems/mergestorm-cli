import {
  getSettings,
  patchSettings,
  type SettingsPatch,
  type SettingsResponse,
} from "../api.js";
import { BEARER_SETTINGS, BEARER_SETTINGS_FLAGS } from "../automation-catalog.js";
import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { present } from "../ui/present.js";
import { buildConfigRows, canBrowse, openTabsBrowser } from "./browse.js";

/**
 * CLI flag → Bearer settings key. Boolean flags take on|off. The connected flags are
 * read-only on the API and deliberately have no flag here.
 */
export const SETTINGS_FLAGS = BEARER_SETTINGS_FLAGS;

type IgnoreBotOperation = { action: "add" | "remove"; login: string } | { action: "clear" };
export type SettingsArgs = { json: boolean; patch: SettingsPatch; ignoreBots?: IgnoreBotOperation[] };

function canonicalLogin(raw: string): string {
  const login = raw.trim().toLowerCase().replace(/\[bot\]$/, "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(login)) {
    throw new CommandError(`Invalid bot login: ${raw}.`, 2, "usage");
  }
  return login;
}

/** Parse boolean and enum flags plus ordered ignore-list operations. */
export function parseSettingsArgs(args: string[]): SettingsArgs {
  let json = false;
  const ignoreBots: IgnoreBotOperation[] = [];
  const patch: SettingsPatch = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const key = SETTINGS_FLAGS[flag];
    if (!key) {
      throw new CommandError(
        `Unknown settings flag: ${flag}. See \`mergestorm --help\`.`,
        2,
        "usage",
      );
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
    const row = BEARER_SETTINGS.find((row) => row.key === key)!;
    if ("kind" in row && row.kind === "logins") {
      if (value === "clear") ignoreBots.push({ action: "clear" });
      else if ((value === "add" || value === "remove") && args[i + 1] && !args[i + 1]!.startsWith("--")) {
        ignoreBots.push({ action: value, login: canonicalLogin(args[++i]!) });
      } else {
        throw new CommandError(`${flag} takes add <login>, remove <login>, or clear.`, 2, "usage");
      }
      continue;
    }
    if ("kind" in row && row.kind === "enum") {
      if (value === undefined || !(row.values as readonly string[]).includes(value)) {
        throw new CommandError(`${flag} takes ${row.values.join(" or ")}.`, 2, "usage");
      }
      Object.assign(patch, { [key]: value });
      continue;
    }
    if (value !== "on" && value !== "off") {
      throw new CommandError(`${flag} takes on or off.`, 2, "usage");
    }
    Object.assign(patch, { [key]: value === "on" });
  }
  return { json, patch, ...(ignoreBots.length ? { ignoreBots } : {}) };
}

/** Static printout includes the Config toggles plus enum and login settings. */
export function formatSettingsLines(settings: SettingsResponse): string[] {
  const rows = [
    ...buildConfigRows(settings),
    ...BEARER_SETTINGS.filter((row) => "kind" in row).map((row) => ({
      ...row, writable: true, value: settings[row.key],
    })),
  ];
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  return rows.map((row) => {
    const value = "kind" in row && row.value === undefined
      ? "(unavailable)"
      : Array.isArray(row.value)
      ? row.value.join(", ") || "(empty)"
      : typeof row.value === "string"
      ? row.value
      : row.writable
      ? row.value
        ? "on"
        : "off"
      : row.value
        ? "connected"
        : "not connected";
    return `  ${row.label.padEnd(labelWidth + 2)}${value}`;
  });
}

export async function cmdSettings(
  args: string[],
  opts: { mode?: "oneshot" | "shell" } = {},
): Promise<void> {
  const { json, patch, ignoreBots } = parseSettingsArgs(args);
  const hasPatch = Object.keys(patch).length > 0 || Boolean(ignoreBots?.length);

  // Bare `settings` on a TTY: the tabbed browser, opened on Config.
  if (!hasPatch && !json && canBrowse()) {
    await openTabsBrowser("config");
    return;
  }

  const cfg = await loadConfig();
  if (ignoreBots?.length) {
    // A leading clear needs no read. Otherwise fetch before writing the full list.
    const current = ignoreBots[0]!.action === "clear" ? null : await getSettings(cfg);
    if (ignoreBots[0]!.action !== "clear" && !current) {
      throw new CommandError("Settings are not available; cannot update ignored bot logins.");
    }
    let logins = [...new Set((current?.ignored_bot_logins ?? []).flatMap((raw) => {
      try {
        return [canonicalLogin(raw)];
      } catch {
        return [];
      }
    }))];
    for (const op of ignoreBots) {
      if (op.action === "clear") logins = [];
      else if (op.action === "remove") logins = logins.filter((login) => login !== op.login);
      else if (!logins.includes(op.login)) logins.push(op.login);
    }
    patch.ignored_bot_logins = logins;
  }
  let settings: SettingsResponse;
  if (hasPatch) {
    settings = await patchSettings(patch, cfg);
  } else {
    const got = await getSettings(cfg);
    if (!got) {
      throw new CommandError(
        "Settings are not available (offline or API too old). " +
          "Try again or open https://mergestorm.ai/settings",
      );
    }
    settings = got;
  }

  if (json) {
    const text = JSON.stringify(settings, null, 2);
    if (opts.mode === "shell") {
      await present("Settings", text.split("\n"));
      return;
    }
    console.log(text);
    return;
  }
  await present("Settings", formatSettingsLines(settings));
}
