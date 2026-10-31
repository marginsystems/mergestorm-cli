import { apiFetch } from "./api.js";
import { loadConfig, type Config } from "./config.js";
import { CommandError, REVIEW_EXIT, rateLimitedMessage, type CommandErrorCode } from "./errors.js";

export const WEB_SEARCH_KINDS = ["web", "news"] as const;
export const WEB_SEARCH_RECENCIES = ["day", "week", "month", "year"] as const;
export const WEB_SEARCH_PAGE_MAX = 5;

export type WebSearchKind = (typeof WEB_SEARCH_KINDS)[number];
export type WebSearchRecency = (typeof WEB_SEARCH_RECENCIES)[number];
export type WebSearchInput = { query: string; kind?: WebSearchKind; recency?: WebSearchRecency; page?: number };
export type WebText = { text: string };

const KNOWN_CODES = new Set<CommandErrorCode>(["invalid_input", "payload_too_large", "web_unavailable"]);

function webFailure(status: number, body: unknown, retryAfterSeconds: number | undefined, action: string): CommandError {
  const row = (body && typeof body === "object" ? body : {}) as { error?: unknown; message?: unknown };
  if (status === 429 || row.error === "rate_limited") {
    return new CommandError(rateLimitedMessage(retryAfterSeconds), REVIEW_EXIT.rate_limited, "rate_limited", retryAfterSeconds !== undefined ? { retryAfterSeconds } : undefined);
  }
  const message = typeof row.message === "string" && row.message ? row.message : null;
  const code = typeof row.error === "string" && KNOWN_CODES.has(row.error as CommandErrorCode) ? (row.error as CommandErrorCode) : undefined;
  if (status === 404 && !code) return new CommandError("This Mergestorm server does not search the web yet.", 1, "not_found");
  return new CommandError(message ?? `${action} (HTTP ${status})`, 1, code);
}

async function call(cfg: Config | undefined, route: string, json: Record<string, unknown>, action: string): Promise<WebText> {
  const { status, body, retryAfterSeconds } = await apiFetch(cfg ?? (await loadConfig()), route, { method: "POST", json });
  if (status !== 200) throw webFailure(status, body, retryAfterSeconds, action);
  return body as WebText;
}

export function searchWeb(input: WebSearchInput, cfg?: Config): Promise<WebText> {
  return call(cfg, "/api/v1/web/search", { ...input }, "Could not search the web");
}

export function readWebPage(url: string, cfg?: Config): Promise<WebText> {
  return call(cfg, "/api/v1/web/page", { url }, "Could not read the page");
}
