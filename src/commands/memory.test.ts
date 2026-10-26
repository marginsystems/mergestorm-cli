import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "../errors.js";
import type { MemoryItem } from "../memory-api.js";
import { cmdMemory, formatMemoryLine, parseMemoryFlags, type MemoryDeps } from "./memory.js";

const CFG = { apiKey: "msk_live_test", apiBase: "https://api.example.test" };
const ID = "00000000-0000-4000-8000-000000000001";
const CHAT = "6a1f0000-0000-4000-8000-000000000001";

const memory = (fields: Partial<MemoryItem> = {}): MemoryItem => ({
  id: ID, scope: "user", repo: null, kind: "fact", text: "Ships on Fridays", source: "user", source_url: null,
  created_at: "2026-10-26T00:00:00.000Z", updated_at: "2026-10-26T00:00:00.000Z", ...fields,
});

async function run(args: string[], api: MemoryDeps["api"], chatId: string | null = null): Promise<string[]> {
  const lines: string[] = [];
  await cmdMemory(args, { loadConfig: async () => CFG, chatId, print: (line) => lines.push(line), api });
  return lines;
}

test("parseMemoryFlags reads repo, kind, scope, limit and json, and refuses flags a subcommand does not take", () => {
  assert.deepEqual(parseMemoryFlags(["Use", "pnpm", "--repo", "https://github.com/Acme/Web.git", "--kind", "rule", "--json"], ["repo", "kind"]), {
    positional: ["Use", "pnpm"], json: true, repo: "acme/web", kind: "rule",
  });
  assert.deepEqual(parseMemoryFlags(["--scope", "repo", "--limit", "5"], ["scope", "limit"]), { positional: [], json: false, scope: "repo", limit: 5 });
  for (const [args, allowed] of [
    [["--repo", "web"], ["repo"]],
    [["--kind", "opinion"], ["kind"]],
    [["--limit", "21"], ["limit"]],
    [["--scope", "team"], ["scope"]],
    [["--kind", "rule"], []],
    [["--repo"], ["repo"]],
  ] as const) {
    assert.throws(() => parseMemoryFlags([...args], allowed), (err) => err instanceof CommandError && err.code === "usage", args.join(" "));
  }
});

test("formatMemoryLine shows the id, kind and repository", () => {
  assert.equal(formatMemoryLine(memory()), `${ID}  (fact) Ships on Fridays`);
  assert.equal(formatMemoryLine(memory({ scope: "repo", repo: "acme/web", kind: "rule", text: "Use pnpm" })), `${ID}  (rule, acme/web) Use pnpm`);
});

test("memory with no subcommand prints the usage", async () => {
  const lines = await run([], {});
  assert.match(lines.join("\n"), /mergestorm memory list/);
});

test("memory list prints the mode and each memory, or JSON", async () => {
  const seen: unknown[] = [];
  const listMemories = async (filter: unknown) => {
    seen.push(filter);
    return { memory_mode: "all" as const, items: [memory()] };
  };
  assert.deepEqual(await run(["list", "--repo", "acme/web"], { listMemories }), ["Memory is all. 1 memory.", `${ID}  (fact) Ships on Fridays`]);
  assert.deepEqual(seen, [{ repo: "acme/web" }]);
  const json = await run(["list", "--json"], { listMemories });
  assert.deepEqual(JSON.parse(json.join("\n")), { memory_mode: "all", items: [memory()] });
});

test("memory add needs a kind and sends the Breeze chat id", async () => {
  const sent: unknown[] = [];
  const saveMemory = async (input: unknown) => {
    sent.push(input);
    return { id: ID, merged: false };
  };
  await assert.rejects(run(["add", "Use", "pnpm"], { saveMemory }), (err) => err instanceof CommandError && err.code === "usage");
  assert.deepEqual(await run(["add", "Use", "pnpm", "--kind", "rule", "--repo", "acme/web"], { saveMemory }, CHAT), [`Saved to memory as ${ID}.`]);
  assert.deepEqual(sent, [{ text: "Use pnpm", kind: "rule", repo: "acme/web", chatId: CHAT }]);
});

test("memory search joins the query and says when memory is off", async () => {
  const sent: unknown[] = [];
  const searchMemories = async (input: { query: string }) => {
    sent.push(input);
    return input.query === "off please"
      ? { memory_mode: "off" as const, rules: [], items: [], total: 0 }
      : { memory_mode: "all" as const, rules: [memory({ kind: "rule", repo: "acme/web", scope: "repo", text: "Use pnpm" })], items: [memory()], total: 2 };
  };
  assert.deepEqual(await run(["search", "package", "manager", "--repo", "acme/web", "--limit", "3"], { searchMemories }), [
    `${ID}  (rule, acme/web) Use pnpm`,
    `${ID}  (fact) Ships on Fridays`,
  ]);
  assert.deepEqual(sent[0], { query: "package manager", repo: "acme/web", limit: 3, chatId: null });
  assert.deepEqual(await run(["search", "off", "please"], { searchMemories }), ["Memory is off, so nothing was searched."]);
  await assert.rejects(run(["search"], { searchMemories }), (err) => err instanceof CommandError && err.code === "usage");
});

test("memory update, delete and mode call their routes", async () => {
  const calls: unknown[] = [];
  const api: MemoryDeps["api"] = {
    updateMemory: async (id, change) => { calls.push(["update", id, change]); return { id, text: change.text }; },
    deleteMemory: async (id) => { calls.push(["delete", id]); return { id, deleted: true }; },
    getMemoryMode: async () => { calls.push(["get"]); return { memory_mode: "all" }; },
    setMemoryMode: async (mode) => { calls.push(["set", mode]); return { memory_mode: mode }; },
  };
  assert.deepEqual(await run(["update", ID, "Ships", "on", "Mondays", "--kind", "preference"], api), [`Memory ${ID} updated.`]);
  assert.deepEqual(await run(["delete", ID], api), [`Memory ${ID} deleted.`]);
  assert.deepEqual(await run(["mode"], api), ["Memory is all."]);
  assert.deepEqual(await run(["mode", "off"], api), ["Memory is off."]);
  assert.deepEqual(calls, [["update", ID, { text: "Ships on Mondays", kind: "preference" }], ["delete", ID], ["get"], ["set", "off"]]);
  await assert.rejects(run(["mode", "sometimes"], api), (err) => err instanceof CommandError && err.code === "usage");
  await assert.rejects(run(["delete"], api), (err) => err instanceof CommandError && err.code === "usage");
  await assert.rejects(run(["update", ID], api), (err) => err instanceof CommandError && err.code === "usage");
  await assert.rejects(run(["purge"], api), (err) => err instanceof CommandError && err.code === "usage");
});
