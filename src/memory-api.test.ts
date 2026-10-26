import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CommandError } from "./errors.js";
import { deleteMemory, getMemoryMode, listMemories, memoryChatId, saveMemory, searchMemories, setMemoryMode, updateMemory } from "./memory-api.js";

const CFG = { apiKey: "msk_live_test", apiBase: "https://api.example.test", ignoreEnv: true };
const ID = "00000000-0000-4000-8000-000000000001";
const CHAT = "6a1f0000-0000-4000-8000-000000000001";
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

test("memoryChatId accepts a chat id and ignores anything else", () => {
  assert.equal(memoryChatId(` ${CHAT.toUpperCase()} `), CHAT);
  assert.equal(memoryChatId("nope"), null);
  assert.equal(memoryChatId(null), null);
});

test("each call hits its memories route with the API key", async () => {
  let calls = respond(200, { memory_mode: "all", items: [] });
  await listMemories({ scope: "repo", repo: "acme/web", kind: "rule" }, CFG);
  assert.deepEqual(calls[0], { url: "https://api.example.test/api/v1/memories?scope=repo&repo=acme%2Fweb&kind=rule", method: "GET", body: undefined, auth: "Bearer msk_live_test" });

  calls = respond(200, { memory_mode: "all", rules: [], items: [], total: 0 });
  await searchMemories({ query: "package manager", repo: "acme/web", limit: 5, chatId: CHAT }, CFG);
  assert.equal(calls[0]!.url, `https://api.example.test/api/v1/memories/search?query=package+manager&repo=acme%2Fweb&limit=5&chat_id=${CHAT}`);

  calls = respond(201, { id: ID, merged: false });
  assert.deepEqual(await saveMemory({ text: "Use pnpm", kind: "rule", repo: "acme/web", chatId: CHAT }, CFG), { id: ID, merged: false });
  assert.deepEqual(calls[0]!.body, { text: "Use pnpm", kind: "rule", repo: "acme/web", chat_id: CHAT });
  assert.equal(calls[0]!.method, "POST");

  calls = respond(200, { id: ID, text: "Use npm" });
  await updateMemory(ID, { text: "Use npm" }, CFG);
  assert.deepEqual([calls[0]!.method, calls[0]!.url, calls[0]!.body], ["PATCH", `https://api.example.test/api/v1/memories/${ID}`, { text: "Use npm" }]);

  calls = respond(200, { id: ID, deleted: true });
  await deleteMemory(ID, CFG);
  assert.deepEqual([calls[0]!.method, calls[0]!.url], ["DELETE", `https://api.example.test/api/v1/memories/${ID}`]);

  calls = respond(200, { memory_mode: "off" });
  assert.deepEqual(await getMemoryMode(CFG), { memory_mode: "off" });
  calls = respond(200, { memory_mode: "on_request" });
  await setMemoryMode("on_request", CFG);
  assert.deepEqual([calls[0]!.method, calls[0]!.body], ["PUT", { memory_mode: "on_request" }]);
});

test("server refusals become command errors with their code", async () => {
  respond(409, { error: "memory_off", message: "Memory is off, so nothing was saved." });
  await assert.rejects(saveMemory({ text: "x", kind: "fact" }, CFG), (err) => err instanceof CommandError && err.code === "memory_off" && /Memory is off/.test(err.message));

  respond(404, { error: "not_found", message: "There is no memory with that id." });
  await assert.rejects(deleteMemory(ID, CFG), (err) => err instanceof CommandError && err.code === "not_found" && /no memory with that id/.test(err.message));

  respond(404, "Not Found");
  await assert.rejects(listMemories({}, CFG), (err) => err instanceof CommandError && /does not manage memories yet/.test(err.message));

  respond(429, { error: "rate_limited", message: "slow down", retry_after_seconds: 9 }, { "retry-after": "9" });
  await assert.rejects(getMemoryMode(CFG), (err) => err instanceof CommandError && err.code === "rate_limited" && err.retryAfterSeconds === 9);
});
