import { loadConfig, type Config } from "../config.js";
import { CommandError, REVIEW_EXIT } from "../errors.js";
import {
  MEMORY_KINDS,
  MEMORY_SEARCH_LIMIT_MAX,
  deleteMemory,
  getMemoryMode,
  isMemoryKind,
  isMemoryMode,
  isMemoryScope,
  listMemories,
  memoryChatId,
  saveMemory,
  searchMemories,
  setMemoryMode,
  updateMemory,
  type MemoryItem,
  type MemoryKind,
  type MemoryScope,
} from "../memory-api.js";

export const MEMORY_USAGE = [
  "usage: mergestorm memory list [--scope user|repo] [--repo <owner/repo>] [--kind <kind>] [--json]",
  "       mergestorm memory search <query> [--repo <owner/repo>] [--limit <1-20>] [--json]",
  "       mergestorm memory add <text> --kind <kind> [--repo <owner/repo>] [--json]",
  "       mergestorm memory update <id> <text> [--kind <kind>] [--json]",
  "       mergestorm memory delete <id> [--json]",
  "       mergestorm memory mode [off|on_request|all] [--json]",
  `  kind is one of ${MEMORY_KINDS.join(", ")}. With --repo a memory is about that repository, otherwise about you.`,
  "  search covers your memories, and with --repo that repository's memories and standing rules too.",
  "  Inside a Breeze chat (MERGESTORM_CHAT_ID), add and search follow that chat's memory setting.",
].join("\n");

export const MEMORY_SUBCOMMANDS = ["list", "search", "add", "update", "delete", "mode"] as const;

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

type Flags = { positional: string[]; json: boolean; repo?: string; kind?: MemoryKind; scope?: MemoryScope; limit?: number };

function usage(message?: string): CommandError {
  return new CommandError(message ? `${message}\n${MEMORY_USAGE}` : MEMORY_USAGE, REVIEW_EXIT.usage, "usage");
}

export function parseMemoryFlags(args: string[], allowed: ReadonlyArray<"repo" | "kind" | "scope" | "limit">): Flags {
  const flags: Flags = { positional: [], json: false };
  const value = (flag: string, raw: string | undefined): string => {
    if (raw === undefined || raw.startsWith("--")) throw usage(`${flag} needs a value`);
    return raw.trim();
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    if (arg === "--json") flags.json = true;
    else if (name === "repo" && allowed.includes("repo")) {
      const repo = value(arg, args[++i]).replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
      if (!REPO.test(repo)) throw usage("--repo needs <owner/repo>");
      flags.repo = repo.toLowerCase();
    } else if (name === "kind" && allowed.includes("kind")) {
      const kind = value(arg, args[++i]);
      if (!isMemoryKind(kind)) throw usage(`--kind is one of ${MEMORY_KINDS.join(", ")}`);
      flags.kind = kind;
    } else if (name === "scope" && allowed.includes("scope")) {
      const scope = value(arg, args[++i]);
      if (!isMemoryScope(scope)) throw usage("--scope is user or repo");
      flags.scope = scope;
    } else if (name === "limit" && allowed.includes("limit")) {
      const limit = Number(value(arg, args[++i]));
      if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_SEARCH_LIMIT_MAX) throw usage(`--limit is a whole number from 1 to ${MEMORY_SEARCH_LIMIT_MAX}`);
      flags.limit = limit;
    } else if (arg.startsWith("--")) throw usage(`unknown argument ${arg}`);
    else flags.positional.push(arg);
  }
  return flags;
}

export function formatMemoryLine(memory: MemoryItem): string {
  const where = memory.repo ? `${memory.kind}, ${memory.repo}` : memory.kind;
  return `${memory.id}  (${where}) ${memory.text}`;
}

export type MemoryDeps = {
  loadConfig?: () => Promise<Config>;
  chatId?: string | null;
  print?: (line: string) => void;
  api?: Partial<{
    listMemories: typeof listMemories;
    searchMemories: typeof searchMemories;
    saveMemory: typeof saveMemory;
    updateMemory: typeof updateMemory;
    deleteMemory: typeof deleteMemory;
    getMemoryMode: typeof getMemoryMode;
    setMemoryMode: typeof setMemoryMode;
  }>;
};

export async function cmdMemory(args: string[], deps: MemoryDeps = {}): Promise<void> {
  const print = deps.print ?? ((line: string) => console.log(line));
  const api = { listMemories, searchMemories, saveMemory, updateMemory, deleteMemory, getMemoryMode, setMemoryMode, ...deps.api };
  const sub = args[0]?.toLowerCase();
  const rest = args.slice(1);
  if (!sub || sub === "-h" || sub === "--help" || sub === "help" || rest.some((arg) => arg === "-h" || arg === "--help")) {
    print(MEMORY_USAGE);
    return;
  }
  const config = () => (deps.loadConfig ?? loadConfig)();
  const chatId = deps.chatId === undefined ? memoryChatId() : deps.chatId;
  const emit = (json: boolean, data: unknown, lines: () => string[]) => {
    if (json) print(JSON.stringify(data, null, 2));
    else for (const line of lines()) print(line);
  };

  if (sub === "list" || sub === "ls") {
    const flags = parseMemoryFlags(rest, ["repo", "kind", "scope"]);
    if (flags.positional.length > 0) throw usage(`unexpected argument ${flags.positional[0]}`);
    const listed = await api.listMemories({ ...(flags.scope ? { scope: flags.scope } : {}), ...(flags.repo ? { repo: flags.repo } : {}), ...(flags.kind ? { kind: flags.kind } : {}) }, await config());
    emit(flags.json, listed, () => [
      `Memory is ${listed.memory_mode}. ${listed.items.length === 1 ? "1 memory" : `${listed.items.length} memories`}.`,
      ...listed.items.map(formatMemoryLine),
    ]);
    return;
  }

  if (sub === "search") {
    const flags = parseMemoryFlags(rest, ["repo", "limit"]);
    const query = flags.positional.join(" ").trim();
    if (!query) throw usage("search needs a query");
    const found = await api.searchMemories({ query, ...(flags.repo ? { repo: flags.repo } : {}), ...(flags.limit ? { limit: flags.limit } : {}), chatId }, await config());
    emit(flags.json, found, () => {
      if (found.memory_mode === "off") return ["Memory is off, so nothing was searched."];
      const all = [...found.rules, ...found.items];
      return all.length === 0 ? ["Nothing in memory matches."] : all.map(formatMemoryLine);
    });
    return;
  }

  if (sub === "add" || sub === "save" || sub === "remember") {
    const flags = parseMemoryFlags(rest, ["repo", "kind"]);
    const text = flags.positional.join(" ").trim();
    if (!text) throw usage("add needs the text to remember");
    if (!flags.kind) throw usage(`add needs --kind (${MEMORY_KINDS.join(", ")})`);
    const saved = await api.saveMemory({ text, kind: flags.kind, ...(flags.repo ? { repo: flags.repo } : {}), chatId }, await config());
    emit(flags.json, saved, () => [saved.merged ? `That matched memory ${saved.id}, which now says this.` : `Saved to memory as ${saved.id}.`]);
    return;
  }

  if (sub === "update" || sub === "edit") {
    const flags = parseMemoryFlags(rest, ["kind"]);
    const [id, ...words] = flags.positional;
    const text = words.join(" ").trim();
    if (!id || !text) throw usage("update needs a memory id and the new text");
    const updated = await api.updateMemory(id, { text, ...(flags.kind ? { kind: flags.kind } : {}) }, await config());
    emit(flags.json, updated, () => [`Memory ${updated.id} updated.`]);
    return;
  }

  if (sub === "delete" || sub === "rm" || sub === "forget") {
    const flags = parseMemoryFlags(rest, []);
    const [id, extra] = flags.positional;
    if (!id || extra !== undefined) throw usage("delete needs one memory id");
    const deleted = await api.deleteMemory(id, await config());
    emit(flags.json, deleted, () => [`Memory ${deleted.id} deleted.`]);
    return;
  }

  if (sub === "mode") {
    const flags = parseMemoryFlags(rest, []);
    const [mode, extra] = flags.positional;
    if (extra !== undefined) throw usage(`unexpected argument ${extra}`);
    if (mode !== undefined && !isMemoryMode(mode)) throw usage("mode is off, on_request or all");
    const result = mode === undefined ? await api.getMemoryMode(await config()) : await api.setMemoryMode(mode, await config());
    emit(flags.json, result, () => [`Memory is ${result.memory_mode}.`]);
    return;
  }

  throw usage(`unknown memory subcommand: ${sub}`);
}
