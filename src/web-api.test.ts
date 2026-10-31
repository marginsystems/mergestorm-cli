import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CommandError } from "./errors.js";
import { readWebPage, searchWeb } from "./web-api.js";

const CFG = { apiKey: "msk_live_test", apiBase: "https://api.example.test", ignoreEnv: true };
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const headerBag = new Headers(init?.headers);
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headerBag.get("authorization") });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  return calls;
}

test("searchWeb and readWebPage post to the web routes with the API key", async () => {
  let calls = respond(200, { text: "Search results" });
  assert.deepEqual(await searchWeb({ query: "node 24", kind: "news", page: 2 }, CFG), { text: "Search results" });
  assert.deepEqual(calls[0], { url: "https://api.example.test/api/v1/web/search", method: "POST", body: { query: "node 24", kind: "news", page: 2 }, auth: "Bearer msk_live_test" });

  calls = respond(200, { text: "Title: Node 24" });
  assert.deepEqual(await readWebPage("https://nodejs.org/", CFG), { text: "Title: Node 24" });
  assert.deepEqual(calls[0], { url: "https://api.example.test/api/v1/web/page", method: "POST", body: { url: "https://nodejs.org/" }, auth: "Bearer msk_live_test" });
});

test("a spent web budget is a rate-limit error with its retry time", async () => {
  respond(429, { error: "rate_limited", message: "Too many requests." }, { "retry-after": "120" });
  await assert.rejects(searchWeb({ query: "node" }, CFG), (error: unknown) => error instanceof CommandError && error.code === "rate_limited" && error.retryAfterSeconds === 120);
});

test("server errors keep their code and message", async () => {
  respond(503, { error: "web_unavailable", message: "Web search is not set up on this server." });
  await assert.rejects(readWebPage("https://nodejs.org/", CFG), (error: unknown) => error instanceof CommandError && error.code === "web_unavailable" && error.message === "Web search is not set up on this server.");
  respond(404, { error: "Not Found" });
  await assert.rejects(searchWeb({ query: "node" }, CFG), (error: unknown) => error instanceof CommandError && error.code === "not_found");
});
