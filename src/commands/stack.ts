import {
  adoptStack,
  landNextStack,
  listStacks,
  restackStack,
  setStackAutoPromote,
  type StackDto,
} from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { createPr, findOpenPrNumber, requireGh } from "../gh.js";
import {
  branchExists,
  createBranchFromHead,
  currentBranch,
  defaultLayerBranchName,
  deleteBranch,
  discoverTrunk,
  pushBranch,
  tipCommitMessage,
  tipCommitSubject,
  worktreeDirty,
} from "../git-stack.js";
import { buildPrBodyFromCommit } from "../pr-body.js";
import { gitTopLevel } from "../repo-identity.js";
import {
  activeLayers,
  appendLayer,
  emptyStackMeta,
  loadStackMeta,
  removeActiveStack,
  resetStackMeta,
  saveStackMeta,
  selectStackForCreate,
} from "../stack-meta.js";
import { ansi } from "../ui/ansi.js";
import { parseGithubOriginRepo } from "./review.js";

const STACK_USAGE = `usage:
  mergestorm stack create [name] [--onto <branch>] [--trunk <branch>] [--json]
  mergestorm stack submit [--json]
  mergestorm stack reset --force
  mergestorm stack list [--json]
  mergestorm stack adopt <owner/repo>#<pr>
  mergestorm stack restack <stack-id> [--json]
  mergestorm stack land <stack-id> [--json]
  mergestorm stack auto-promote on|off <stack-id> [--json]

  stack submit opens PRs with a body generated from each layer tip commit.
  stack land promotes into the review unit when one exists; otherwise lands
  the bottom open PR (unit-less stacks).`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireStackId(raw: string | undefined, usage: string): string {
  const id = raw?.trim() ?? "";
  if (!id || !UUID_RE.test(id)) {
    throw new CommandError(usage);
  }
  return id;
}

/** Parse `owner/repo#12` or `owner/repo 12`. */
export function parseAdoptTarget(args: string[]): { owner: string; repo: string; prNumber: number } {
  const joined = args.join(" ").trim();
  const hashMatch = /^([^/\s]+)\/([^#\s]+)#([1-9]\d*)$/.exec(joined);
  if (hashMatch) {
    return {
      owner: hashMatch[1]!,
      repo: hashMatch[2]!,
      prNumber: Number(hashMatch[3]),
    };
  }
  if (args.length >= 2) {
    const slash = /^([^/\s]+)\/([^/\s]+)$/.exec(args[0]!);
    const pr = Number(args[1]);
    if (slash && Number.isInteger(pr) && pr > 0) {
      return { owner: slash[1]!, repo: slash[2]!, prNumber: pr };
    }
  }
  throw new CommandError(`usage: mergestorm stack adopt <owner/repo>#<pr>`);
}

function formatStackHuman(s: StackDto): string[] {
  const lines: string[] = [];
  const auto = s.autoPromoteWhenGreen ? " · auto-promote" : "";
  lines.push(
    `  ${ansi.bold(`${s.owner}/${s.repo}`)}  trunk=${s.trunkBranch}${auto}`,
  );
  lines.push(`  ${ansi.dim(s.id)}`);
  if (s.layers.length === 0) {
    lines.push(ansi.dim("    (no layers)"));
    return lines;
  }
  for (const layer of s.layers) {
    const title = layer.title ? ` ${layer.title}` : "";
    const pr = layer.prNumber > 0 ? `#${layer.prNumber}` : "—";
    lines.push(
      `    ${String(layer.position).padStart(2)}  ${pr.padEnd(5)}  ${layer.state.padEnd(14)}  ${layer.branch}${title}`,
    );
  }
  return lines;
}

/** Parse `stack create` argv into options. Exported for tests. */
export function parseStackCreateArgs(args: string[]): {
  name?: string;
  onto?: string;
  trunk?: string;
  asJson: boolean;
} {
  let name: string | undefined;
  let onto: string | undefined;
  let trunk: string | undefined;
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") {
      asJson = true;
      continue;
    }
    if (a === "--onto") {
      const v = args[++i];
      if (!v) throw new CommandError("usage: mergestorm stack create [name] [--onto <branch>]");
      onto = v;
      continue;
    }
    if (a.startsWith("--onto=")) {
      onto = a.slice("--onto=".length);
      continue;
    }
    if (a === "--trunk") {
      const v = args[++i];
      if (!v) throw new CommandError("usage: mergestorm stack create [name] [--trunk <branch>]");
      trunk = v;
      continue;
    }
    if (a.startsWith("--trunk=")) {
      trunk = a.slice("--trunk=".length);
      continue;
    }
    if (a.startsWith("-")) {
      throw new CommandError(`${STACK_USAGE}\nunknown flag: ${a}`);
    }
    if (name != null) {
      throw new CommandError("usage: mergestorm stack create [name] [--onto <branch>] [--trunk <branch>]");
    }
    name = a;
  }
  return { name, onto, trunk, asJson };
}

export function parseStackResetArgs(args: string[]): void {
  if (args.length !== 1 || args[0] !== "--force") {
    throw new CommandError(
      "usage: mergestorm stack reset --force\nClears only CLI-managed pre-submit state; branches, PRs, and registered stacks are unchanged.",
    );
  }
}

async function cmdStackCreate(args: string[]): Promise<void> {
  const { name, onto, trunk: trunkFlag, asJson } = parseStackCreateArgs(args);
  const cwd = process.cwd();
  try {
    gitTopLevel(cwd);
  } catch {
    throw new CommandError(
      "Not in a git repository. Run `mg stack create` from inside the repository whose stack you want to author.",
    );
  }

  if (worktreeDirty(cwd)) {
    throw new CommandError(
      "Working tree is dirty. Commit or stash changes before `stack create`.",
    );
  }

  const parentBranch = onto?.trim() || currentBranch(cwd);
  if (!parentBranch) {
    throw new CommandError(
      "Detached HEAD. Check out a branch (or pass --onto <branch>) before `stack create`.",
    );
  }
  if (!branchExists(parentBranch, cwd)) {
    throw new CommandError(`Parent branch not found: ${parentBranch}`);
  }

  const branch = defaultLayerBranchName(name);
  if (branchExists(branch, cwd)) {
    throw new CommandError(`Branch already exists: ${branch}`);
  }

  let meta = await loadStackMeta(cwd);
  const trunk = trunkFlag?.trim() || meta?.trunk || discoverTrunk(cwd);
  if (!meta) {
    meta = emptyStackMeta(trunk);
  } else if (trunkFlag?.trim() && meta.trunk !== trunk) {
    throw new CommandError(
      `Stack trunk is ${meta.trunk}; refusing --trunk ${trunk}. Run \`mg stack reset --force\` to discard local pre-submit state.`,
    );
  }

  try {
    meta = selectStackForCreate(meta, parentBranch);
  } catch (err) {
    throw new CommandError(err instanceof Error ? err.message : String(err));
  }

  try {
    createBranchFromHead(branch, cwd);
  } catch (err) {
    throw new CommandError(err instanceof Error ? err.message : String(err));
  }

  try {
    meta = appendLayer(meta, { branch, parentBranch });
    await saveStackMeta(meta, cwd);
  } catch (err) {
    try { deleteBranch(branch, cwd); } catch { /* rollback best-effort */ }
    throw new CommandError(err instanceof Error ? err.message : String(err));
  }

  const layers = activeLayers(meta);
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          branch,
          parentBranch,
          trunk: meta.trunk,
          active: meta.active,
          stacks: meta.stacks.length,
          layers,
          meta,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(ansi.green(`  Created ${branch} (onto ${parentBranch})`));
  console.log(
    ansi.dim(
      `  trunk: ${meta.trunk} · local stacks: ${meta.stacks.length} · active layers: ${layers.length}`,
    ),
  );
  console.log(ansi.dim("  authoring state: managed automatically outside the repository"));
}

async function cmdStackSubmit(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  if (args.some((a) => a !== "--json")) {
    throw new CommandError("usage: mergestorm stack submit [--json]");
  }
  const cwd = process.cwd();
  try {
    gitTopLevel(cwd);
  } catch {
    throw new CommandError(
      "Not in a git repository. Run `mg stack submit` from inside the repo whose stack you want to push.",
    );
  }
  const meta = await loadStackMeta(cwd);
  const layers = meta ? activeLayers(meta) : [];
  if (!meta || layers.length === 0) {
    throw new CommandError(
      "No local stack layers. Run `mg stack create` (then commit your code) before `stack submit`.",
    );
  }

  const origin = parseGithubOriginRepo(cwd);
  if (!origin) {
    throw new CommandError(
      "Could not parse GitHub owner/repo from `origin`. Set a github.com remote and retry.",
    );
  }
  const { owner, repo } = origin;

  requireGh(cwd);

  const opened: { branch: string; base: string; prNumber: number; created: boolean }[] = [];

  for (const layer of layers) {
    const base = layer.parentBranch || meta.trunk;
    if (!branchExists(layer.branch, cwd)) {
      throw new CommandError(`Stack layer branch missing locally: ${layer.branch}`);
    }
    console.log(ansi.dim(`  Pushing ${layer.branch} …`));
    try {
      pushBranch(layer.branch, cwd);
    } catch (err) {
      throw new CommandError(err instanceof Error ? err.message : String(err));
    }

    let prNumber = findOpenPrNumber(owner, repo, layer.branch, cwd);
    let created = false;
    if (prNumber == null) {
      const title = tipCommitSubject(layer.branch, cwd);
      const body = buildPrBodyFromCommit(tipCommitMessage(layer.branch, cwd));
      console.log(ansi.dim(`  Opening PR ${layer.branch} → ${base} …`));
      prNumber = createPr({
        owner,
        repo,
        base,
        head: layer.branch,
        title,
        body,
        cwd,
      });
      created = true;
    } else {
      console.log(ansi.dim(`  PR #${prNumber} already open for ${layer.branch}`));
    }
    opened.push({ branch: layer.branch, base, prNumber, created });
  }

  const registerPr = opened[0]!.prNumber;
  const cfg = await loadConfig();
  console.log(ansi.dim(`  Registering stack via import (${owner}/${repo}#${registerPr}) …`));
  const body = await adoptStack(owner, repo, registerPr, cfg);
  if (typeof body !== "object" || body === null) {
    throw new CommandError("Unexpected response shape from adopt API");
  }
  const data = body as { error?: string; stack?: { id?: string; trunkBranch?: string } | null; chain?: unknown[] };
  if (data.error) {
    throw new CommandError(data.error);
  }
  if (!data.stack) {
    throw new CommandError("Stack was not registered");
  }
  const stackId = data.stack.id;

  // Drop the submitted local stack so the next create onto trunk starts fresh.
  await saveStackMeta(removeActiveStack(meta), cwd);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          owner,
          repo,
          layers: opened,
          stackId: stackId ?? null,
          trunk: data.stack?.trunkBranch ?? meta.trunk,
          chain: data.chain ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  for (const row of opened) {
    const verb = row.created ? "opened" : "exists";
    console.log(
      ansi.green(
        `  #${row.prNumber}  ${row.branch} → ${row.base}  (${verb})`,
      ),
    );
  }
  if (stackId) {
    console.log(ansi.green(`  Registered stack ${stackId}`));
  } else {
    console.log(ansi.dim("  Stack registration returned no stack ID"));
  }
  console.log(ansi.dim("  Dashboard: https://mergestorm.ai/dashboard/stacks"));
}

async function cmdStackReset(args: string[]): Promise<void> {
  parseStackResetArgs(args);
  await resetStackMeta(process.cwd());
  console.log(
    ansi.green(
      "  Cleared CLI-managed pre-submit stack state. Branches, PRs, and registered stacks were not changed.",
    ),
  );
}

async function cmdStackList(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const cfg = await loadConfig();
  const stacks = await listStacks(cfg);
  if (asJson) {
    console.log(JSON.stringify({ stacks }, null, 2));
    return;
  }
  if (stacks.length === 0) {
    console.log(
      ansi.dim("  No stacks yet. Author with `stack create` → commit → `stack submit`."),
    );
    console.log(
      ansi.dim("  Import an existing chain only: `stack adopt owner/repo#pr`"),
    );
    console.log(ansi.dim("  Dashboard: https://mergestorm.ai/dashboard/stacks"));
    return;
  }
  for (const s of stacks) {
    for (const line of formatStackHuman(s)) console.log(line);
    console.log("");
  }
  console.log(ansi.dim("  Dashboard: https://mergestorm.ai/dashboard/stacks"));
}

async function cmdStackAdopt(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const targetArgs = args.filter((a) => a !== "--json");
  if (targetArgs.length === 0) {
    throw new CommandError(`usage: mergestorm stack adopt <owner/repo>#<pr>`);
  }
  const { owner, repo, prNumber } = parseAdoptTarget(targetArgs);
  const cfg = await loadConfig();
  const body = await adoptStack(owner, repo, prNumber, cfg);
  if (asJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  if (typeof body !== "object" || body === null) {
    throw new CommandError("Unexpected response shape from adopt API");
  }
  const data = body as { stack?: { id?: string; trunkBranch?: string }; chain?: unknown[] };
  const stack = data.stack;
  const chain = data.chain;
  console.log(
    ansi.green(
      `  Imported ${owner}/${repo}#${prNumber}` +
        (stack?.id ? ` → ${stack.id}` : "") +
        (Array.isArray(chain) ? ` (${chain.length} layer(s))` : ""),
    ),
  );
  if (stack?.trunkBranch) {
    console.log(ansi.dim(`  trunk: ${stack.trunkBranch}`));
  }
  console.log(ansi.dim("  Dashboard: https://mergestorm.ai/dashboard/stacks"));
}

async function cmdStackRestack(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const id = requireStackId(
    args.find((a) => a !== "--json"),
    "usage: mergestorm stack restack <stack-id>",
  );
  const cfg = await loadConfig();
  const body = await restackStack(id, cfg);
  if (asJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const fromBranch = (body as { fromBranch?: string }).fromBranch;
  console.log(
    ansi.green(`  Restack started` + (fromBranch ? ` from ${fromBranch}` : "") + ` (${id})`),
  );
}

async function cmdStackLand(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const id = requireStackId(
    args.find((a) => a !== "--json"),
    "usage: mergestorm stack land <stack-id>",
  );
  const cfg = await loadConfig();
  // Server routes unit stacks to promote-next (#244 / AUD-07).
  const body = await landNextStack(id, cfg);
  if (asJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const pr = (body as { mergedPrNumber?: number }).mergedPrNumber;
  const branch = (body as { mergedBranch?: string }).mergedBranch;
  const uNumber = (body as { uNumber?: number }).uNumber;
  if (typeof uNumber === "number" && uNumber > 0) {
    console.log(
      ansi.green(
        `  Promoted` +
          (pr != null ? ` #${pr}` : "") +
          ` into U${uNumber}` +
          (branch ? ` (${branch})` : "") +
          ` on ${id}`,
      ),
    );
    return;
  }
  console.log(
    ansi.green(
      `  Landed` +
        (pr != null ? ` #${pr}` : "") +
        (branch ? ` (${branch})` : "") +
        ` on ${id}`,
    ),
  );
}

async function cmdStackAutoLand(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const filtered = args.filter((a) => a !== "--json");
  const mode = filtered[0]?.toLowerCase();
  const id = requireStackId(
    filtered[1],
    "usage: mergestorm stack auto-promote on|off <stack-id>",
  );
  if (mode !== "on" && mode !== "off") {
    throw new CommandError("usage: mergestorm stack auto-promote on|off <stack-id>");
  }
  const cfg = await loadConfig();
  const body = await setStackAutoPromote(id, mode === "on", cfg);
  if (asJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  console.log(ansi.green(`  Auto-promote ${mode} for ${id}`));
}

export async function cmdStack(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();
  const rest = args.slice(1);
  if (!sub || sub === "-h" || sub === "--help") {
    throw new CommandError(STACK_USAGE);
  }
  if (sub === "create") return cmdStackCreate(rest);
  if (sub === "submit") return cmdStackSubmit(rest);
  if (sub === "reset") return cmdStackReset(rest);
  if (sub === "list" || sub === "ls") return cmdStackList(rest);
  if (sub === "adopt") return cmdStackAdopt(rest);
  if (sub === "restack") return cmdStackRestack(rest);
  if (sub === "land" || sub === "land-next") return cmdStackLand(rest);
  if (
    sub === "auto-promote" ||
    sub === "autopromote" ||
    sub === "auto-land" ||
    sub === "autoland"
  ) {
    return cmdStackAutoLand(rest);
  }
  throw new CommandError(`${STACK_USAGE}\nunknown stack subcommand: ${sub}`);
}
