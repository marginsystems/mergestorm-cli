import {
  getSettings,
  patchSettings,
  type SettingsPatch,
  type SettingsResponse,
} from "../api.js";
import { BEARER_SETTINGS_FLAGS } from "../automation-catalog.js";
import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { present } from "../ui/present.js";
import { buildConfigRows, canBrowse, openTabsBrowser } from "./browse.js";

/**
 * CLI flag → Bearer settings key. on|off only. The connected flags are
 * read-only on the API and deliberately have no flag here.
 */
export const SETTINGS_FLAGS = BEARER_SETTINGS_FLAGS;

export type SettingsArgs = { json: boolean; patch: SettingsPatch };

/** Parse `settings` argv. Accepts `--flag on|off` and `--flag=on|off`. */
export function parseSettingsArgs(args: string[]): SettingsArgs {
  let json = false;
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
    if (value !== "on" && value !== "off") {
      throw new CommandError(`${flag} takes on or off.`, 2, "usage");
    }
    patch[key] = value === "on";
  }
  return { json, patch };
}

/** Static printout of the GET/PATCH response shape (rows match the Config tab). */
export function formatSettingsLines(settings: SettingsResponse): string[] {
  const rows = buildConfigRows(settings);
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  return rows.map((row) => {
    const value = row.writable
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
  const { json, patch } = parseSettingsArgs(args);
  const hasPatch = Object.keys(patch).length > 0;

  // Bare `settings` on a TTY: the tabbed browser, opened on Config.
  if (!hasPatch && !json && canBrowse()) {
    await openTabsBrowser("config");
    return;
  }

  const cfg = await loadConfig();
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
