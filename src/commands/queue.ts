import {
  cancelMergeQueueEntry,
  enqueueStack,
  listMergeQueueEntries,
  type MergeQueueEntryDto,
} from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { ansi } from "../ui/ansi.js";
import { runLineTabsBrowser } from "../ui/line-tabs.js";
import { present } from "../ui/present.js";
import { visibleWidth } from "../ui/width.js";
import { canBrowse } from "./browse.js";

/** Injectable seams for unit tests. Production callers omit deps. */
export type QueueCmdDeps = {
  canBrowse?: () => boolean;
  runLineTabsBrowser?: typeof runLineTabsBrowser;
};

const QUEUE_STATE_GLYPHS: Record<string, string> = {
  queued: "○",
  running: "●",
  waiting: "◐",
  bounced: "×",
  landed: "✓",
  cancelled: "·",
};

function queueStateGlyph(state: string): string {
  return QUEUE_STATE_GLYPHS[state] ?? "·";
}

function colorQueueGlyph(state: string, glyph: string): string {
  if (state === "running") return ansi.brightGreen(glyph);
  if (state === "waiting") return ansi.yellow(glyph);
  if (state === "bounced") return ansi.red(glyph);
  return ansi.dim(glyph);
}

export const QUEUE_USAGE = `usage:
  mergestorm queue [list] [--json]
  mergestorm queue add <stack-id> [--json]
  mergestorm queue rm <entry-id|stack-id> [--json]

  queue lists your live merge-queue entries. rm prefers an entry id; a live
  stack id is resolved to its queue entry before cancellation.`;

function positionalArgs(args: string[]): string[] {
  const unknown = args.filter(
    (arg) =>
      arg.startsWith("-") &&
      arg !== "--json" &&
      arg !== "-h" &&
      arg !== "--help",
  );
  if (unknown.length > 0) {
    throw new CommandError(`unknown queue option: ${unknown[0]}`, 2, "usage");
  }
  return args.filter((arg) => arg !== "--json");
}

function requireIdentifier(value: string | undefined, usage: string): string {
  const id = value?.trim();
  if (!id) throw new CommandError(usage, 2, "usage");
  return id;
}

/** Entry ids win; otherwise a live stack id resolves to its entry id. */
export function resolveQueueEntryId(
  idOrStackId: string,
  entries: readonly MergeQueueEntryDto[],
): string {
  const entry = entries.find((candidate) => candidate.id === idOrStackId);
  if (entry) return entry.id;
  const stackEntry = entries.find((candidate) => candidate.stackId === idOrStackId);
  return stackEntry?.id ?? idOrStackId;
}

export function buildQueueListLines(
  entries: readonly MergeQueueEntryDto[],
  fullStackId = false,
): string[] {
  if (entries.length === 0) {
    return [
      `  ${ansi.bold("Nothing queued")}`,
      "",
      `  ${ansi.brightGreen("queue add <stack-id>")}  send a stack for verified landing`,
    ];
  }
  return entries.map((entry) => {
    const reason = entry.waitReason ?? entry.bounceReason;
    const glyph = colorQueueGlyph(entry.state, queueStateGlyph(entry.state));
    const id = fullStackId ? entry.stackId : entry.stackId.slice(0, 8);
    const core =
      `  ${String(entry.position).padStart(2)}  ` +
      `${glyph} ${entry.state.padEnd(8)}  ${entry.owner}/${entry.repo}  ${id}` +
      (reason ? `  ${reason}` : "");
    const who =
      entry.enqueuedBy === "human" || entry.enqueuedBy === "agent"
        ? `  by ${entry.enqueuedBy}`
        : "";
    const withWho = `${core}${who}`;
    return visibleWidth(withWho) <= 75 ? withWho : core;
  });
}

async function listQueue(asJson: boolean, deps: QueueCmdDeps = {}): Promise<void> {
  const cfg = await loadConfig();
  const entries = await listMergeQueueEntries(cfg);
  if (asJson) {
    console.log(JSON.stringify({ entries }, null, 2));
    return;
  }
  const browse = deps.canBrowse ?? canBrowse;
  const browseable = browse();
  const lines = buildQueueListLines(entries, !browseable);
  if (browseable) {
    const runBrowser = deps.runLineTabsBrowser ?? runLineTabsBrowser;
    await runBrowser({
      tabs: [{ id: "queue", label: "Queue", lines }],
    });
    return;
  }
  await present("Merge queue", lines);
}

async function addQueue(args: string[], asJson: boolean): Promise<void> {
  const id = requireIdentifier(
    args[0],
    "usage: mergestorm queue add <stack-id> [--json]",
  );
  if (args.length > 1) {
    throw new CommandError(
      "usage: mergestorm queue add <stack-id> [--json]",
      2,
      "usage",
    );
  }
  const cfg = await loadConfig();
  const body = await enqueueStack(id, cfg);
  if (asJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const entry = (body as { entry?: Partial<MergeQueueEntryDto> } | null)?.entry;
  const duplicate = (body as { duplicate?: unknown } | null)?.duplicate === true;
  await present("Merge queue", [
    ansi.brightGreen(
      `  ${duplicate ? "Already queued" : "Queued"} ${id}` +
        (entry?.position ? ` at position ${entry.position}` : ""),
    ),
  ]);
}

async function removeQueue(args: string[], asJson: boolean): Promise<void> {
  const requested = requireIdentifier(
    args[0],
    "usage: mergestorm queue rm <entry-id|stack-id> [--json]",
  );
  if (args.length > 1) {
    throw new CommandError(
      "usage: mergestorm queue rm <entry-id|stack-id> [--json]",
      2,
      "usage",
    );
  }
  const cfg = await loadConfig();
  const entries = await listMergeQueueEntries(cfg);
  const entryId = resolveQueueEntryId(requested, entries);
  const body = await cancelMergeQueueEntry(entryId, cfg);
  if (asJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  await present("Merge queue", [
    ansi.brightGreen(`  Removed ${entryId} from the merge queue`),
  ]);
}

export async function cmdQueue(
  args: string[],
  deps: QueueCmdDeps = {},
): Promise<void> {
  const asJson = args.includes("--json");
  const positional = positionalArgs(args);
  const sub = positional[0]?.toLowerCase();

  if (sub === "-h" || sub === "--help" || sub === "help") {
    console.log(QUEUE_USAGE);
    return;
  }
  if (!sub || sub === "list" || sub === "ls") {
    if (positional.length > (sub ? 1 : 0)) {
      throw new CommandError(QUEUE_USAGE, 2, "usage");
    }
    await listQueue(asJson, deps);
    return;
  }
  if (sub === "add") {
    await addQueue(positional.slice(1), asJson);
    return;
  }
  if (sub === "rm" || sub === "remove") {
    await removeQueue(positional.slice(1), asJson);
    return;
  }
  throw new CommandError(`${QUEUE_USAGE}\nunknown queue subcommand: ${sub}`);
}
