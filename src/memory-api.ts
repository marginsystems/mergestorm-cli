import { apiFetch } from "./api.js";
import { loadConfig, type Config } from "./config.js";
import { CommandError, REVIEW_EXIT, rateLimitedMessage, type CommandErrorCode } from "./errors.js";

export const MEMORY_MODES = ["off", "on_request", "all"] as const;
export const MEMORY_SCOPES = ["user", "repo"] as const;
export const MEMORY_KINDS = ["rule", "style", "preference", "fact", "project"] as const;
export const MEMORY_SEARCH_LIMIT_MAX = 20;

export type MemoryMode = (typeof MEMORY_MODES)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MemoryItem = {
  id: string;
  scope: MemoryScope;
  repo: string | null;
  kind: MemoryKind;
  text: string;
  source: string | null;
  source_url: string | null;
  created_at: string;
  updated_at: string;
};

export type MemoryList = { memory_mode: MemoryMode; items: MemoryItem[] };
export type MemorySearch = { memory_mode: MemoryMode; rules: MemoryItem[]; items: MemoryItem[]; total: number };
export type MemorySaved = { id: string; merged: boolean };
export type MemoryUpdated = { id: string; text: string; kind?: MemoryKind };

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function memoryChatId(value: string | null | undefined = process.env.MERGESTORM_CHAT_ID): string | null {
  const trimmed = value?.trim() ?? "";
  return CHAT_ID.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function isMemoryMode(value: unknown): value is MemoryMode {
  return typeof value === "string" && (MEMORY_MODES as readonly string[]).includes(value);
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && (MEMORY_SCOPES as readonly string[]).includes(value);
}

const KNOWN_CODES = new Set<CommandErrorCode>(["invalid_input", "not_found", "memory_off", "memory_full", "memory_unavailable", "payload_too_large"]);

function memoryFailure(status: number, body: unknown, retryAfterSeconds: number | undefined, action: string): CommandError {
  const row = (body && typeof body === "object" ? body : {}) as { error?: unknown; message?: unknown };
  if (status === 429 || row.error === "rate_limited") {
    return new CommandError(rateLimitedMessage(retryAfterSeconds), REVIEW_EXIT.rate_limited, "rate_limited", retryAfterSeconds !== undefined ? { retryAfterSeconds } : undefined);
  }
  const message = typeof row.message === "string" && row.message ? row.message : null;
  const code = typeof row.error === "string" && KNOWN_CODES.has(row.error as CommandErrorCode) ? (row.error as CommandErrorCode) : undefined;
  if (status === 404 && !code) return new CommandError("This Mergestorm server does not manage memories yet.", 1, "not_found");
  return new CommandError(message ?? `${action} (HTTP ${status})`, 1, code);
}

async function call<T>(cfg: Config | undefined, route: string, init: Parameters<typeof apiFetch>[2], ok: number[], action: string): Promise<T> {
  const { status, body, retryAfterSeconds } = await apiFetch(cfg ?? (await loadConfig()), route, init);
  if (!ok.includes(status)) throw memoryFailure(status, body, retryAfterSeconds, action);
  return body as T;
}

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function listMemories(filter: { scope?: MemoryScope; repo?: string; kind?: MemoryKind } = {}, cfg?: Config): Promise<MemoryList> {
  return call(cfg, `/api/v1/memories${query(filter)}`, {}, [200], "Could not list memories");
}

export function searchMemories(input: { query: string; repo?: string; limit?: number; chatId?: string | null }, cfg?: Config): Promise<MemorySearch> {
  return call(cfg, `/api/v1/memories/search${query({ query: input.query, repo: input.repo, limit: input.limit, chat_id: input.chatId })}`, {}, [200], "Could not search memories");
}

export function saveMemory(input: { text: string; kind: MemoryKind; repo?: string | null; chatId?: string | null }, cfg?: Config): Promise<MemorySaved> {
  const json = { text: input.text, kind: input.kind, ...(input.repo ? { repo: input.repo } : {}), ...(input.chatId ? { chat_id: input.chatId } : {}) };
  return call(cfg, "/api/v1/memories", { method: "POST", json }, [200, 201], "Could not save the memory");
}

export function updateMemory(id: string, change: { text: string; kind?: MemoryKind }, cfg?: Config): Promise<MemoryUpdated> {
  return call(cfg, `/api/v1/memories/${encodeURIComponent(id)}`, { method: "PATCH", json: change }, [200], "Could not update the memory");
}

export function deleteMemory(id: string, cfg?: Config): Promise<{ id: string; deleted: true }> {
  return call(cfg, `/api/v1/memories/${encodeURIComponent(id)}`, { method: "DELETE" }, [200], "Could not delete the memory");
}

export function getMemoryMode(cfg?: Config): Promise<{ memory_mode: MemoryMode }> {
  return call(cfg, "/api/v1/memories/mode", {}, [200], "Could not read the memory mode");
}

export function setMemoryMode(mode: MemoryMode, cfg?: Config): Promise<{ memory_mode: MemoryMode }> {
  return call(cfg, "/api/v1/memories/mode", { method: "PUT", json: { memory_mode: mode } }, [200], "Could not set the memory mode");
}
