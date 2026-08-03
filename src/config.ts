import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_API = "https://api.mergestorm.ai";

export type Config = {
  apiKey?: string;
  apiBase?: string;
};

export function mergestormHome(): string {
  return path.join(homedir(), ".mergestorm");
}

export function configPath(): string {
  return path.join(mergestormHome(), "config.json");
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(configPath(), "utf8");
    return JSON.parse(raw) as Config;
  } catch {
    return {};
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  const dir = path.dirname(configPath());
  await mkdir(dir, { recursive: true });
  await writeFile(configPath(), JSON.stringify(cfg, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function clearConfig(): Promise<void> {
  await rm(configPath(), { force: true });
}

export function apiBase(cfg: Config): string {
  return (process.env.MERGESTORM_API_URL?.trim() || cfg.apiBase || DEFAULT_API).replace(/\/$/, "");
}

export function resolveApiKey(cfg: Config): string | undefined {
  return process.env.MERGESTORM_API_KEY?.trim() || cfg.apiKey;
}

/** Short display form of a stored key (prefix only). */
export function keyDisplay(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length <= 16) return key;
  return `${key.slice(0, 12)}…`;
}
