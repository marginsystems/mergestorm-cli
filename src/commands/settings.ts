import {
  getSettings,
  listRepoSettings,
  patchRepoSettings,
  patchSettings,
  REPO_SETTINGS_KEYS,
  type RepoSettings,
  type RepoSettingsKey,
  type RepoSettingsPatch,
  type SettingsPatch,
  type SettingsResponse,
} from "../api.js";
import { BEARER_SETTINGS, BEARER_SETTINGS_FLAGS } from "../automation-catalog.js";
import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { present } from "../ui/present.js";
import { readOnlyRowWords, type TabsConfigRow } from "../ui/tabs.js";
import { buildConfigRows, canBrowse, openTabsBrowser } from "./browse.js";

/**
 * CLI flag → Bearer settings key. Boolean flags take on|off. The connected flags are
 * read-only on the API and deliberately have no flag here.
 */
export const SETTINGS_FLAGS = BEARER_SETTINGS_FLAGS;

type IgnoreBotOperation = { action: "add" | "remove"; login: string } | { action: "clear" };
export type RepoSettingsScope = { owner: string; repo: string; patch: RepoSettingsPatch };
export type SettingsArgs = {
  json: boolean;
  patch: SettingsPatch;
  ignoreBots?: IgnoreBotOperation[];
  repo?: RepoSettingsScope;
  listRepos?: boolean;
};

const REPO_FLAG_LABELS: Readonly<Record<RepoSettingsKey, string>> = {
  auto_patch_enabled: "Auto patch",
  auto_review_enabled: "Auto review",
  auto_land_default: "Auto land (new stacks)",
};

function parseRepoSlug(raw: string | undefined): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw ?? "");
  if (!match) throw new CommandError("--repo takes <owner>/<repo>.", 2, "usage");
  return { owner: match[1]!, repo: match[2]! };
}

function repoArg(args: string[]): { slug: string | undefined; rest: string[]; listRepos: boolean } {
  const rest: string[] = [];
  let slug: string | undefined;
  let found = false;
  let listRepos = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--repos") listRepos = true;
    else if (arg === "--repo") {
      found = true;
      slug = args[++i];
    } else if (arg.startsWith("--repo=")) {
      found = true;
      slug = arg.slice("--repo=".length);
    } else rest.push(arg);
  }
  if (found && slug === undefined) slug = "";
  return { slug, rest, listRepos };
}

function parseRepoSettingsArgs(slug: string, args: string[]): SettingsArgs {
  const scope: RepoSettingsScope = { ...parseRepoSlug(slug), patch: {} };
  let json = false;
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
      throw new CommandError(`Unknown settings flag: ${flag}. See \`mergestorm --help\`.`, 2, "usage");
    }
    if (!(REPO_SETTINGS_KEYS as readonly string[]).includes(key)) {
      throw new CommandError(
        `${flag} is an account setting. With --repo only --auto-patch, --auto-review and --auto-land can be set.`,
        2,
        "usage",
      );
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
    if (value !== "on" && value !== "off" && value !== "inherit") {
      throw new CommandError(`${flag} takes on, off or inherit with --repo.`, 2, "usage");
    }
    scope.patch[key as RepoSettingsKey] = value === "inherit" ? null : value === "on";
  }
  return { json, patch: {}, repo: scope };
}

function repoSettingWords(value: boolean | null): string {
  return value === null ? "inherit (follows the account)" : value ? "on" : "off";
}

export function formatRepoSettingsLines(repos: readonly RepoSettings[]): string[] {
  if (repos.length === 0) return ["  No repositories are connected to this account."];
  const width = Math.max(...Object.values(REPO_FLAG_LABELS).map((label) => label.length));
  return repos.flatMap((entry) => [
    `  ${entry.owner}/${entry.repo}`,
    ...REPO_SETTINGS_KEYS.map(
      (key) => `    ${REPO_FLAG_LABELS[key].padEnd(width + 2)}${repoSettingWords(entry[key])}`,
    ),
  ]);
}

async function cmdRepoSettings(
  parsed: SettingsArgs,
  opts: { mode?: "oneshot" | "shell" },
): Promise<void> {
  const cfg = await loadConfig();
  let repos: RepoSettings[];
  const scope = parsed.repo;
  if (scope && Object.keys(scope.patch).length > 0) {
    repos = [await patchRepoSettings(scope.owner, scope.repo, scope.patch, cfg)];
  } else {
    repos = await listRepoSettings(cfg);
    if (scope) {
      const wanted = `${scope.owner}/${scope.repo}`.toLowerCase();
      repos = repos.filter((entry) => `${entry.owner}/${entry.repo}`.toLowerCase() === wanted);
      if (repos.length === 0) {
        throw new CommandError(`${scope.owner}/${scope.repo} is not connected to this account.`);
      }
    }
  }
  if (parsed.json) {
    const text = JSON.stringify(scope ? repos[0] : { repos }, null, 2);
    if (opts.mode === "shell") {
      await present("Repository settings", text.split("\n"));
      return;
    }
    console.log(text);
    return;
  }
  await present("Repository settings", formatRepoSettingsLines(repos));
}

function canonicalLogin(raw: string): string {
  const login = raw.trim().toLowerCase().replace(/\[bot\]$/, "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(login)) {
    throw new CommandError(`Invalid bot login: ${raw}.`, 2, "usage");
  }
  return login;
}

/** Parse boolean and enum flags plus ordered ignore-list operations. */
export function parseSettingsArgs(rawArgs: string[]): SettingsArgs {
  const { slug, rest: args, listRepos } = repoArg(rawArgs);
  if (slug !== undefined) {
    if (listRepos) throw new CommandError("--repos and --repo cannot be combined.", 2, "usage");
    return parseRepoSettingsArgs(slug, args);
  }
  if (listRepos) {
    const other = args.find((arg) => arg !== "--json");
    if (other) throw new CommandError(`--repos lists repository settings and takes only --json, not ${other}.`, 2, "usage");
    return { json: args.includes("--json"), patch: {}, listRepos: true };
  }
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
    if ("kind" in row && (row.kind === "seconds" || row.kind === "count")) {
      const amount = value !== undefined && /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isInteger(amount) || amount < row.min || amount > row.max) {
        const unit = row.kind === "seconds" ? " of seconds" : "";
        throw new CommandError(
          `${flag} takes a whole number${unit} from ${row.min} through ${row.max}.`,
          2,
          "usage",
        );
      }
      Object.assign(patch, { [key]: amount });
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
      : typeof row.value === "number"
      ? "kind" in row && row.kind === "seconds" ? `${row.value}s` : String(row.value)
      : row.writable
      ? row.value
        ? "on"
        : "off"
      : readOnlyRowWords(row as TabsConfigRow);
    return `  ${row.label.padEnd(labelWidth + 2)}${value}`;
  });
}

export async function cmdSettings(
  args: string[],
  opts: { mode?: "oneshot" | "shell" } = {},
): Promise<void> {
  const parsed = parseSettingsArgs(args);
  if (parsed.repo || parsed.listRepos) {
    await cmdRepoSettings(parsed, opts);
    return;
  }
  const { json, patch, ignoreBots } = parsed;
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
