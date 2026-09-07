import {
  adoptStack,
  ensureUpperPark,
  landNextStack,
  listStacks,
  restackStack,
  setStackPolicy,
  type StackDto,
  type StackPolicyPatch,
} from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { createPr, findOpenPrNumber, requireGh } from "../gh.js";
import { parseGithubOriginRepo } from "../git.js";
import {
  branchExists,
  commitsAheadOf,
  createBranchFromHead,
  currentBranch,
  defaultLayerBranchName,
  deleteBranch,
  discoverTrunk,
  fetchRemoteBranch,
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
  setActivePolicy,
} from "../stack-meta.js";
import { isMgParkBranch, planSubmitLayerBases } from "../submit-pr-base.js";
import { ansi } from "../ui/ansi.js";
import { runLineTabsBrowser } from "../ui/line-tabs.js";
import { present } from "../ui/present.js";
import { canBrowse } from "./browse.js";
import { openHelpBrowser } from "./help.js";

const STACK_USAGE = `usage:
  mergestorm stack create [name] [--onto <branch>] [--trunk <branch>] [--extend] [--auto-land on|off] [--auto-review on|off] [--auto-patch on|off] [--json]
  mergestorm stack submit [--extend] [--auto-land on|off] [--auto-review on|off] [--auto-patch on|off] [--json]
  mergestorm stack reset --force
  mergestorm stack list [--json]
  mergestorm stack set <stack-id> [--auto-land on|off] [--auto-review on|off|default] [--auto-patch on|off|default] [--json]
  mergestorm stack adopt <owner/repo>#<pr> [--auto-land on|off] [--auto-review on|off] [--auto-patch on|off] [--json]
  mergestorm stack restack <stack-id> [--json]
  mergestorm stack land <stack-id> [--json]

  --auto-review / --auto-patch pin Vortex auto-review / Cyclone auto-patch for
  one stack in either direction. Absent, or \`default\` on stack set, follows
  the account setting.
  stack submit opens PRs with a body generated from each layer tip commit.
  Layers 1–2 use the git parent as GitHub base. Layer 3+ opens onto the
  review-unit park freeze (mg-park-*) so adopt does not retarget after open.
  Parenting onto a branch that already belongs to a registered (submitted)
  stack requires --extend on create and submit — otherwise mg starts a new
  stack from trunk. stack land promotes into the review unit when one exists;
  otherwise lands the bottom open PR (unit-less stacks).`;

/** Cap the registered-stack guard's API probe so it cannot stall local authoring. */
const STACK_GUARD_TIMEOUT_MS = 8_000;

/** A registered stack layer that would become the parent of a new layer. */
export type RegisteredParentHit = {
  stackId: string;
  owner: string;
  repo: string;
  branch: string;
  prNumber: number;
  position: number;
};

/** Find a registered stack layer whose branch matches `parentBranch`. */
export function findRegisteredParent(
  stacks: StackDto[],
  parentBranch: string,
  owner?: string,
  repo?: string,
): RegisteredParentHit | null {
  const want = parentBranch.trim();
  if (!want) return null;
  for (const s of stacks) {
    if (owner !== undefined && repo !== undefined) {
      if (s.owner !== owner || s.repo !== repo) continue;
    }
    for (const layer of s.layers) {
      if (layer.branch === want) {
        return {
          stackId: s.id,
          owner: s.owner,
          repo: s.repo,
          branch: layer.branch,
          prNumber: layer.prNumber,
          position: layer.position,
        };
      }
    }
  }
  return null;
}

/**
 * Refuse silently growing an already-registered stack.
 * Local unsubmitted parents are fine; only API-listed layers trip this.
 */
export function assertMayParentOntoRegistered(
  parentBranch: string,
  stacks: StackDto[],
  extend: boolean,
  verb: "create" | "submit",
  owner?: string,
  repo?: string,
): RegisteredParentHit | null {
  const hit = findRegisteredParent(stacks, parentBranch, owner, repo);
  if (!hit) return null;
  if (extend) return hit;
  const pr = hit.prNumber > 0 ? `PR #${hit.prNumber}` : "an open PR";
  throw new CommandError(
    `Parent \`${hit.branch}\` is already layer ${hit.position} of registered stack ${hit.stackId} (${hit.owner}/${hit.repo}, ${pr}).\n` +
      `Refusing to ${verb} a new layer onto that stack without an explicit opt-in.\n` +
      `• New independent stack: check out trunk and pass \`--onto <trunk>\` (e.g. \`mg stack create --onto main\`).\n` +
      `• Intentionally grow that stack: pass \`--extend\` on \`stack ${verb}\`.`,
    1,
    "registered_parent",
  );
}

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

const stackCmd = (name: string, blurb: string): string =>
  `  ${ansi.brightGreen(name.padEnd(26))}${blurb}`;

/** Empty + populated bodies for the TTY `stack list` panel. */
export function buildStackListLines(stacks: StackDto[]): string[] {
  if (stacks.length === 0) {
    return [
      `  ${ansi.bold("None yet")}`,
      "  No registered stacks for this key.",
      "",
      `  ${ansi.bold("Author one")}`,
      stackCmd("stack create", "new layer on this branch"),
      "  commit, then  stack submit",
      "",
      `  ${ansi.bold("Or import")}`,
      stackCmd("stack adopt org/repo#12", "open GitHub chain"),
      "",
      ansi.dim("  Dashboard: https://mergestorm.ai/dashboard"),
    ];
  }
  const lines: string[] = [];
  for (const s of stacks) {
    lines.push(...formatStackHuman(s));
    lines.push("");
  }
  lines.push(ansi.dim("  create · submit · land <id> · q to close"));
  return lines;
}

/** Short per-stack policy suffixes: Auto land when on, overrides when pinned. */
export function stackPolicyLabels(
  s: Pick<StackDto, "autoEnqueueWhenReady" | "autoReviewOverride" | "autoPatchOverride">,
): string[] {
  const labels: string[] = [];
  if (s.autoEnqueueWhenReady) labels.push("auto-land on");
  if (typeof s.autoReviewOverride === "boolean") {
    labels.push(`auto-review ${s.autoReviewOverride ? "on" : "off"}`);
  }
  if (typeof s.autoPatchOverride === "boolean") {
    labels.push(`auto-patch ${s.autoPatchOverride ? "on" : "off"}`);
  }
  return labels;
}

function formatStackHuman(s: StackDto): string[] {
  const lines: string[] = [];
  lines.push(
    `  ${ansi.bold(`${s.owner}/${s.repo}`)}  trunk=${s.trunkBranch}` +
      stackPolicyLabels(s)
        .map((label) => `  ${label}`)
        .join(""),
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

/** Per-open policy flags shared by create, submit, and adopt (`on|off` only). */
export type StackOpenPolicyFlags = {
  autoLand?: boolean;
  autoReview?: boolean;
  autoPatch?: boolean;
};

const OPEN_POLICY_FLAGS: ReadonlyArray<{
  flag: string;
  key: keyof StackOpenPolicyFlags;
}> = [
  { flag: "--auto-land", key: "autoLand" },
  { flag: "--auto-review", key: "autoReview" },
  { flag: "--auto-patch", key: "autoPatch" },
];

/**
 * Consume one `--auto-* on|off` flag at `args[i]` (space or `=` form). Returns
 * the next index to scan, or null when `args[i]` is not a policy flag.
 */
function takeOpenPolicyFlag(
  args: string[],
  i: number,
  into: StackOpenPolicyFlags,
  verb: string,
): number | null {
  const a = args[i]!;
  for (const { flag, key } of OPEN_POLICY_FLAGS) {
    if (a === flag) {
      into[key] = parseOnOff(args[i + 1], flag, verb);
      return i + 2;
    }
    if (a.startsWith(`${flag}=`)) {
      into[key] = parseOnOff(a.slice(flag.length + 1), flag, verb);
      return i + 1;
    }
  }
  return null;
}

/** Wire policy for adopt from the parsed `on|off` flags; absent keys stay off the body. */
export function openPolicyPatch(flags: StackOpenPolicyFlags): StackPolicyPatch | undefined {
  const patch: StackPolicyPatch = {
    ...(typeof flags.autoLand === "boolean" ? { autoEnqueueWhenReady: flags.autoLand } : {}),
    ...(typeof flags.autoReview === "boolean" ? { autoReviewOverride: flags.autoReview } : {}),
    ...(typeof flags.autoPatch === "boolean" ? { autoPatchOverride: flags.autoPatch } : {}),
  };
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Parse `stack create` argv into options. Exported for tests. */
export function parseStackCreateArgs(args: string[]): {
  name?: string;
  onto?: string;
  trunk?: string;
  extend: boolean;
  autoLand?: boolean;
  autoReview?: boolean;
  autoPatch?: boolean;
  asJson: boolean;
} {
  let name: string | undefined;
  let onto: string | undefined;
  let trunk: string | undefined;
  let extend = false;
  const policy: StackOpenPolicyFlags = {};
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") {
      asJson = true;
      continue;
    }
    if (a === "--extend") {
      extend = true;
      continue;
    }
    const next = takeOpenPolicyFlag(args, i, policy, "stack create");
    if (next !== null) {
      i = next - 1;
      continue;
    }
    if (a === "--onto") {
      const v = args[++i];
      if (!v) {
        throw new CommandError(
          "usage: mergestorm stack create [name] [--onto <branch>] [--trunk <branch>] [--extend]",
        );
      }
      onto = v;
      continue;
    }
    if (a.startsWith("--onto=")) {
      onto = a.slice("--onto=".length);
      continue;
    }
    if (a === "--trunk") {
      const v = args[++i];
      if (!v) {
        throw new CommandError(
          "usage: mergestorm stack create [name] [--onto <branch>] [--trunk <branch>] [--extend]",
        );
      }
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
      throw new CommandError(
        "usage: mergestorm stack create [name] [--onto <branch>] [--trunk <branch>] [--extend]",
      );
    }
    name = a;
  }
  return {
    name,
    onto,
    trunk,
    extend,
    autoLand: policy.autoLand,
    autoReview: policy.autoReview,
    autoPatch: policy.autoPatch,
    asJson,
  };
}

/** Parse `stack submit` argv. Exported for tests. */
export function parseStackSubmitArgs(args: string[]): {
  extend: boolean;
  autoLand?: boolean;
  autoReview?: boolean;
  autoPatch?: boolean;
  asJson: boolean;
} {
  let extend = false;
  const policy: StackOpenPolicyFlags = {};
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") {
      asJson = true;
      continue;
    }
    if (a === "--extend") {
      extend = true;
      continue;
    }
    const next = takeOpenPolicyFlag(args, i, policy, "stack submit");
    if (next !== null) {
      i = next - 1;
      continue;
    }
    throw new CommandError(
      "usage: mergestorm stack submit [--extend] [--auto-land on|off] [--auto-review on|off] [--auto-patch on|off] [--json]",
    );
  }
  return {
    extend,
    autoLand: policy.autoLand,
    autoReview: policy.autoReview,
    autoPatch: policy.autoPatch,
    asJson,
  };
}

function parseOnOff(raw: string | undefined, flag: string, verb: string): boolean {
  if (raw === "on") return true;
  if (raw === "off") return false;
  throw new CommandError(`usage: mergestorm ${verb} [${flag} on|off]`);
}

/** `stack set` overrides are tri-state: `default` writes null (follow the account flag). */
function parseOnOffDefault(
  raw: string | undefined,
  flag: string,
  verb: string,
): boolean | null {
  if (raw === "on") return true;
  if (raw === "off") return false;
  if (raw === "default") return null;
  throw new CommandError(`usage: mergestorm ${verb} [${flag} on|off|default]`);
}

export function parseStackAdoptArgs(args: string[]): {
  owner: string;
  repo: string;
  prNumber: number;
  autoLand?: boolean;
  autoReview?: boolean;
  autoPatch?: boolean;
  asJson: boolean;
} {
  const targetArgs: string[] = [];
  const policy: StackOpenPolicyFlags = {};
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") {
      asJson = true;
      continue;
    }
    const next = takeOpenPolicyFlag(args, i, policy, "stack adopt <owner/repo>#<pr>");
    if (next !== null) {
      i = next - 1;
      continue;
    }
    if (a.startsWith("-")) {
      throw new CommandError(`${STACK_USAGE}\nunknown flag: ${a}`);
    }
    targetArgs.push(a);
  }
  const target = parseAdoptTarget(targetArgs);
  return {
    ...target,
    autoLand: policy.autoLand,
    autoReview: policy.autoReview,
    autoPatch: policy.autoPatch,
    asJson,
  };
}

export type StackSetArgs = {
  stackId: string;
  /** At least one of these is present. */
  autoLand?: boolean;
  autoReview?: boolean | null;
  autoPatch?: boolean | null;
  asJson: boolean;
};

export function parseStackSetArgs(args: string[]): StackSetArgs {
  const usage =
    "usage: mergestorm stack set <stack-id> [--auto-land on|off] [--auto-review on|off|default] [--auto-patch on|off|default] [--json]";
  const verb = "stack set <stack-id>";
  let stackId: string | undefined;
  let autoLand: boolean | undefined;
  let autoReview: boolean | null | undefined;
  let autoPatch: boolean | null | undefined;
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") {
      asJson = true;
    } else if (arg === "--auto-land") {
      autoLand = parseOnOff(args[++i], "--auto-land", verb);
    } else if (arg.startsWith("--auto-land=")) {
      autoLand = parseOnOff(arg.slice("--auto-land=".length), "--auto-land", verb);
    } else if (arg === "--auto-review") {
      autoReview = parseOnOffDefault(args[++i], "--auto-review", verb);
    } else if (arg.startsWith("--auto-review=")) {
      autoReview = parseOnOffDefault(arg.slice("--auto-review=".length), "--auto-review", verb);
    } else if (arg === "--auto-patch") {
      autoPatch = parseOnOffDefault(args[++i], "--auto-patch", verb);
    } else if (arg.startsWith("--auto-patch=")) {
      autoPatch = parseOnOffDefault(arg.slice("--auto-patch=".length), "--auto-patch", verb);
    } else if (arg.startsWith("-") || stackId !== undefined) {
      throw new CommandError(usage);
    } else {
      stackId = arg;
    }
  }
  if (autoLand === undefined && autoReview === undefined && autoPatch === undefined) {
    throw new CommandError(usage);
  }
  return {
    stackId: requireStackId(stackId, usage),
    ...(autoLand !== undefined ? { autoLand } : {}),
    ...(autoReview !== undefined ? { autoReview } : {}),
    ...(autoPatch !== undefined ? { autoPatch } : {}),
    asJson,
  };
}

export function parseStackResetArgs(args: string[]): void {
  if (args.length !== 1 || args[0] !== "--force") {
    throw new CommandError(
      "usage: mergestorm stack reset --force\nClears only CLI-managed pre-submit state; branches, PRs, and registered stacks are unchanged.",
    );
  }
}

/** Injectable seams for unit tests. Production callers omit deps. */
export type StackCreateDeps = {
  cwd?: string;
  gitTopLevel?: typeof gitTopLevel;
  worktreeDirty?: typeof worktreeDirty;
  currentBranch?: typeof currentBranch;
  branchExists?: typeof branchExists;
  createBranchFromHead?: typeof createBranchFromHead;
  deleteBranch?: typeof deleteBranch;
  discoverTrunk?: typeof discoverTrunk;
  defaultLayerBranchName?: typeof defaultLayerBranchName;
  loadStackMeta?: typeof loadStackMeta;
  saveStackMeta?: typeof saveStackMeta;
  listStacks?: typeof listStacks;
  loadConfig?: typeof loadConfig;
  parseGithubOriginRepo?: typeof parseGithubOriginRepo;
};

export async function cmdStackCreate(
  args: string[],
  deps: StackCreateDeps = {},
): Promise<void> {
  const {
    name,
    onto,
    trunk: trunkFlag,
    extend,
    autoLand,
    autoReview,
    autoPatch,
    asJson,
  } = parseStackCreateArgs(args);
  const cwd = deps.cwd ?? process.cwd();
  const gitTopLevelFn = deps.gitTopLevel ?? gitTopLevel;
  const worktreeDirtyFn = deps.worktreeDirty ?? worktreeDirty;
  const currentBranchFn = deps.currentBranch ?? currentBranch;
  const branchExistsFn = deps.branchExists ?? branchExists;
  const createBranchFromHeadFn = deps.createBranchFromHead ?? createBranchFromHead;
  const deleteBranchFn = deps.deleteBranch ?? deleteBranch;
  const discoverTrunkFn = deps.discoverTrunk ?? discoverTrunk;
  const defaultLayerBranchNameFn = deps.defaultLayerBranchName ?? defaultLayerBranchName;
  const loadStackMetaFn = deps.loadStackMeta ?? loadStackMeta;
  const saveStackMetaFn = deps.saveStackMeta ?? saveStackMeta;
  const listStacksFn = deps.listStacks ?? listStacks;
  const loadConfigFn = deps.loadConfig ?? loadConfig;
  const parseOriginFn = deps.parseGithubOriginRepo ?? parseGithubOriginRepo;
  try {
    gitTopLevelFn(cwd);
  } catch {
    throw new CommandError(
      "Not in a git repository. Run `mg stack create` from inside the repository whose stack you want to author.",
    );
  }

  if (worktreeDirtyFn(cwd)) {
    throw new CommandError(
      "Working tree is dirty. Commit or stash changes before `stack create`.",
    );
  }

  const parentBranch = onto?.trim() || currentBranchFn(cwd);
  if (!parentBranch) {
    throw new CommandError(
      "Detached HEAD. Check out a branch (or pass --onto <branch>) before `stack create`.",
    );
  }
  if (!branchExistsFn(parentBranch, cwd)) {
    throw new CommandError(`Parent branch not found: ${parentBranch}`);
  }

  const branch = defaultLayerBranchNameFn(name);
  if (branchExistsFn(branch, cwd)) {
    throw new CommandError(`Branch already exists: ${branch}`);
  }

  let meta = await loadStackMetaFn(cwd);
  const trunk = trunkFlag?.trim() || meta?.trunk || discoverTrunkFn(cwd);
  if (!meta) {
    meta = emptyStackMeta(trunk);
  } else if (trunkFlag?.trim() && meta.trunk !== trunk) {
    throw new CommandError(
      `Stack trunk is ${meta.trunk}; refusing --trunk ${trunk}. Run \`mg stack reset --force\` to discard local pre-submit state.`,
    );
  }

  // --trunk only sets metadata; parent defaults to current branch. Call that out
  // when someone passes --trunk while sitting on a different branch without --onto.
  if (trunkFlag?.trim() && !onto?.trim() && parentBranch !== trunk) {
    console.error(
      ansi.dim(
        `  note: --trunk ${trunk} does not change the parent; new layer parents onto \`${parentBranch}\`. ` +
          `Pass \`--onto ${trunk}\` for a fresh stack from trunk.`,
      ),
    );
  }

  // Block silent attach onto an already-submitted stack tip (requires --extend).
  // --trunk is user metadata, so a registered tip must not be able to masquerade
  // as trunk — always consult the stacks API rather than trusting parent === trunk.
  // Best-effort: API/key failures degrade to a warning so create stays local.
  const origin = parseOriginFn(cwd);
  let registeredHit: RegisteredParentHit | null = null;
  if (origin) {
    try {
      const cfg = await loadConfigFn();
      const registered = await listStacksFn(cfg, { timeoutMs: STACK_GUARD_TIMEOUT_MS });
      registeredHit = assertMayParentOntoRegistered(
        parentBranch,
        registered,
        extend,
        "create",
        origin.owner,
        origin.repo,
      );
    } catch (err) {
      if (err instanceof CommandError && err.code === "registered_parent") throw err;
      console.error(
        ansi.dim(
          `  warning: could not check registered stacks (${err instanceof Error ? err.message : String(err)}); ` +
            `skipping --extend guard. Pass --extend if you intend to grow an open stack.`,
        ),
      );
    }
  } else {
    console.error(
      ansi.dim(
        "  warning: could not determine GitHub owner/repo from `origin`; skipping --extend guard. Pass --extend if you intend to grow an open stack.",
      ),
    );
  }
  if (parentBranch === trunk && extend && !registeredHit) {
    throw new CommandError(
      "`--extend` is only valid when parenting onto a registered stack layer, not trunk. Omit --extend (or pass --onto <tip> --extend).",
    );
  }

  try {
    meta = selectStackForCreate(meta, parentBranch);
    meta = setActivePolicy(meta, {
      autoEnqueueWhenReady: autoLand,
      autoReviewOverride: autoReview,
      autoPatchOverride: autoPatch,
    });
  } catch (err) {
    throw new CommandError(err instanceof Error ? err.message : String(err));
  }

  try {
    createBranchFromHeadFn(branch, cwd);
  } catch (err) {
    throw new CommandError(err instanceof Error ? err.message : String(err));
  }

  try {
    meta = appendLayer(meta, { branch, parentBranch });
    await saveStackMetaFn(meta, cwd);
  } catch (err) {
    try { deleteBranchFn(branch, cwd); } catch { /* rollback best-effort */ }
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
          extend: Boolean(registeredHit),
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
  const created: string[] = [
    ansi.brightGreen(`  Created ${branch} (onto ${parentBranch})`),
  ];
  if (registeredHit) {
    created.push(
      ansi.dim(
        `  extending registered stack ${registeredHit.stackId}` +
          (registeredHit.prNumber > 0 ? ` (from #${registeredHit.prNumber})` : ""),
      ),
    );
  }
  created.push(
    ansi.dim(
      `  trunk: ${meta.trunk} · local stacks: ${meta.stacks.length} · active layers: ${layers.length}`,
    ),
  );
  created.push(ansi.dim("  authoring state: managed automatically outside the repository"));
  await present("Stack", created);
}

/** Injectable seams for unit tests (STRUCT-04). Production callers omit deps. */
export type StackSubmitDeps = {
  cwd?: string;
  gitTopLevel?: (cwd?: string) => string;
  loadStackMeta?: typeof loadStackMeta;
  saveStackMeta?: typeof saveStackMeta;
  parseGithubOriginRepo?: typeof parseGithubOriginRepo;
  requireGh?: (cwd?: string) => void;
  branchExists?: typeof branchExists;
  fetchRemoteBranch?: typeof fetchRemoteBranch;
  pushBranch?: typeof pushBranch;
  findOpenPrNumber?: typeof findOpenPrNumber;
  commitsAheadOf?: typeof commitsAheadOf;
  tipCommitSubject?: typeof tipCommitSubject;
  tipCommitMessage?: typeof tipCommitMessage;
  buildPrBodyFromCommit?: typeof buildPrBodyFromCommit;
  createPr?: typeof createPr;
  loadConfig?: typeof loadConfig;
  listStacks?: typeof listStacks;
  adoptStack?: typeof adoptStack;
  ensureUpperPark?: typeof ensureUpperPark;
};

export async function cmdStackSubmit(
  args: string[],
  deps: StackSubmitDeps = {},
): Promise<void> {
  const { extend, autoLand, autoReview, autoPatch, asJson } = parseStackSubmitArgs(args);
  const progress = (message: string) => {
    if (asJson) console.error(message);
    else console.log(message);
  };
  const cwd = deps.cwd ?? process.cwd();
  const gitTopLevelFn = deps.gitTopLevel ?? gitTopLevel;
  const loadStackMetaFn = deps.loadStackMeta ?? loadStackMeta;
  const saveStackMetaFn = deps.saveStackMeta ?? saveStackMeta;
  const parseOriginFn = deps.parseGithubOriginRepo ?? parseGithubOriginRepo;
  const requireGhFn = deps.requireGh ?? requireGh;
  const branchExistsFn = deps.branchExists ?? branchExists;
  const fetchRemoteBranchFn = deps.fetchRemoteBranch ?? fetchRemoteBranch;
  const pushBranchFn = deps.pushBranch ?? pushBranch;
  const findOpenPrNumberFn = deps.findOpenPrNumber ?? findOpenPrNumber;
  const commitsAheadOfFn = deps.commitsAheadOf ?? commitsAheadOf;
  const tipCommitSubjectFn = deps.tipCommitSubject ?? tipCommitSubject;
  const tipCommitMessageFn = deps.tipCommitMessage ?? tipCommitMessage;
  const buildPrBodyFn = deps.buildPrBodyFromCommit ?? buildPrBodyFromCommit;
  const createPrFn = deps.createPr ?? createPr;
  const loadConfigFn = deps.loadConfig ?? loadConfig;
  const listStacksFn = deps.listStacks ?? listStacks;
  const adoptStackFn = deps.adoptStack ?? adoptStack;
  const ensureUpperParkFn = deps.ensureUpperPark ?? ensureUpperPark;

  try {
    gitTopLevelFn(cwd);
  } catch {
    throw new CommandError(
      "Not in a git repository. Run `mg stack submit` from inside the repo whose stack you want to push.",
    );
  }
  const meta = await loadStackMetaFn(cwd);
  const layers = meta ? activeLayers(meta) : [];
  if (!meta || layers.length === 0) {
    throw new CommandError(
      "No local stack layers. Run `mg stack create` (then commit your code) before `stack submit`.",
    );
  }
  const origin = parseOriginFn(cwd);
  if (!origin) {
    throw new CommandError(
      "Could not parse GitHub owner/repo from `origin`. Set a github.com remote and retry.",
    );
  }
  const { owner, repo } = origin;

  requireGhFn(cwd);

  // Safety net: refuse submit that would open/register onto a registered tip
  // without --extend. Check every layer's parent (mid-stack layers from older
  // local state must not sail through), scoped to this repo, and fail closed
  // when the API cannot be consulted — otherwise the attach happens anyway.
  // meta.trunk is user metadata, so it must not exempt a registered tip from
  // the check (a tip can masquerade as trunk via --trunk at create).
  const parents = [...new Set(layers.map((l) => l.parentBranch || meta.trunk))];
  let registeredHits = 0;
  let registered: StackDto[] = [];
  try {
    const cfg = await loadConfigFn();
    registered = await listStacksFn(cfg, { timeoutMs: STACK_GUARD_TIMEOUT_MS });
    for (const parent of parents) {
      if (assertMayParentOntoRegistered(parent, registered, extend, "submit", owner, repo)) {
        registeredHits += 1;
      }
    }
  } catch (err) {
    if (err instanceof CommandError && err.code === "registered_parent") throw err;
    throw new CommandError(
      `Could not verify that the stack parents onto registered stacks (${err instanceof Error ? err.message : String(err)}); ` +
        `refusing to submit. If a layer grows a registered stack, pass --extend (retry when the API is reachable).`,
    );
  }
  if (extend && registeredHits === 0 && parents.every((p) => p === meta.trunk)) {
    throw new CommandError(
      "`--extend` is only valid when a layer parents onto a registered stack layer, not trunk.",
    );
  }

  const plans = planSubmitLayerBases({
    layers,
    trunk: meta.trunk,
    registered,
    owner,
    repo,
  });

  // Explicit submit flags win; otherwise a fresh (unregistered) stack carries
  // the choices remembered at `stack create`. Joining a registered stack
  // never replays stored create-time flags onto it.
  const stored = meta.stacks[meta.active];
  const freshStack = plans.every((plan) => plan.stackId === null);
  const pick = (
    flag: boolean | undefined,
    remembered: boolean | undefined,
  ): boolean | undefined =>
    typeof flag === "boolean"
      ? flag
      : freshStack && typeof remembered === "boolean"
        ? remembered
        : undefined;
  const policy = openPolicyPatch({
    autoLand: pick(autoLand, stored?.autoEnqueueWhenReady),
    autoReview: pick(autoReview, stored?.autoReviewOverride),
    autoPatch: pick(autoPatch, stored?.autoPatchOverride),
  });

  for (const layer of layers) {
    if (!branchExistsFn(layer.branch, cwd)) {
      throw new CommandError(`Stack layer branch missing locally: ${layer.branch}`);
    }
    progress(ansi.dim(`  Pushing ${layer.branch} …`));
    try {
      pushBranchFn(layer.branch, cwd);
    } catch (err) {
      throw new CommandError(err instanceof Error ? err.message : String(err));
    }
  }

  const opened: { branch: string; base: string; prNumber: number; created: boolean }[] = [];
  const pendingPark = plans.filter((plan) => {
    if (findOpenPrNumberFn(owner, repo, plan.branch, cwd) != null) return false;
    return plan.githubBase == null;
  });

  const openLayerPr = (branch: string, base: string): { prNumber: number; created: boolean } => {
    const existing = findOpenPrNumberFn(owner, repo, branch, cwd);
    if (existing != null) {
      progress(ansi.dim(`  PR #${existing} already open for ${branch}`));
      return { prNumber: existing, created: false };
    }
    const aheadRef = isMgParkBranch(base) ? `origin/${base}` : base;
    if (isMgParkBranch(base)) {
      try {
        fetchRemoteBranchFn(base, cwd);
      } catch (err) {
        throw new CommandError(
          `Could not fetch park base \`${base}\` (${err instanceof Error ? err.message : String(err)}).`,
        );
      }
    } else if (!branchExistsFn(base, cwd)) {
      throw new CommandError(`Stack base branch missing locally: ${base}`);
    }
    let ahead: number;
    try {
      ahead = commitsAheadOfFn(aheadRef, branch, cwd);
    } catch (err) {
      throw new CommandError(err instanceof Error ? err.message : String(err));
    }
    if (ahead < 1) {
      throw new CommandError(
        `No commits on \`${branch}\` ahead of \`${base}\`. ` +
          `Commit your changes, then retry \`mg stack submit\`.`,
      );
    }
    const title = tipCommitSubjectFn(branch, cwd);
    const body = buildPrBodyFn(tipCommitMessageFn(branch, cwd));
    progress(ansi.dim(`  Opening PR ${branch} → ${base} …`));
    return {
      prNumber: createPrFn({
        owner,
        repo,
        base,
        head: branch,
        title,
        body,
        cwd,
      }),
      created: true,
    };
  };

  for (const plan of plans) {
    if (plan.githubBase == null && findOpenPrNumberFn(owner, repo, plan.branch, cwd) == null) {
      continue;
    }
    const base = plan.githubBase ?? plan.gitParent;
    const { prNumber, created } = openLayerPr(plan.branch, base);
    opened.push({ branch: plan.branch, base, prNumber, created });
  }

  const cfg = await loadConfigFn();
  type AdoptPayload = {
    error?: string;
    stack?: { id?: string; trunkBranch?: string } | null;
    chain?: unknown[];
  };
  let adoptData: AdoptPayload | null = null;
  let stackId = plans.find((plan) => plan.stackId)?.stackId ?? null;

  const registerPr = async (prNumber: number): Promise<void> => {
    progress(ansi.dim(`  Registering stack via import (${owner}/${repo}#${prNumber}) …`));
    const body = await adoptStackFn(owner, repo, prNumber, cfg, policy);
    if (typeof body !== "object" || body === null) {
      throw new CommandError("Unexpected response shape from adopt API");
    }
    const data = body as AdoptPayload;
    if (data.error) {
      throw new CommandError(data.error);
    }
    if (!data.stack) {
      throw new CommandError("Stack was not registered");
    }
    adoptData = data;
    if (typeof data.stack.id === "string" && data.stack.id) {
      stackId = data.stack.id;
    }
  };

  if (pendingPark.length > 0) {
    if (opened.length > 0) {
      await registerPr(opened[0]!.prNumber);
    }
    if (!stackId) {
      throw new CommandError(
        "Cannot mint a park freeze before the stack is registered. Open layers 1–2 first, then retry.",
      );
    }
    progress(ansi.dim(`  Ensuring upper-park freeze for stack ${stackId} …`));
    const park = await ensureUpperParkFn(stackId, cfg);
    for (const plan of pendingPark) {
      const { prNumber, created } = openLayerPr(plan.branch, park.freezeBranch);
      opened.push({ branch: plan.branch, base: park.freezeBranch, prNumber, created });
    }
    await registerPr(opened[opened.length - 1]!.prNumber);
  } else {
    if (opened.length === 0) {
      throw new CommandError("No pull requests to register after submit.");
    }
    await registerPr(opened[0]!.prNumber);
  }

  const data = adoptData!;

  // Drop the submitted local stack so the next create onto trunk starts fresh.
  await saveStackMetaFn(removeActiveStack(meta), cwd);

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

  const summary: string[] = [];
  for (const row of opened) {
    const verb = row.created ? "opened" : "exists";
    summary.push(
      ansi.brightGreen(
        `  #${row.prNumber}  ${row.branch} → ${row.base}  (${verb})`,
      ),
    );
  }
  if (stackId) {
    summary.push(ansi.brightGreen(`  Registered stack ${stackId}`));
  } else {
    summary.push(ansi.dim("  Stack registration returned no stack ID"));
  }
  summary.push(ansi.dim("  Dashboard: https://mergestorm.ai/dashboard"));
  await present("Stack", summary);
}

async function cmdStackReset(args: string[]): Promise<void> {
  parseStackResetArgs(args);
  await resetStackMeta(process.cwd());
  await present("Stack", [
    ansi.brightGreen(
      "  Cleared CLI-managed pre-submit stack state. Branches, PRs, and registered stacks were not changed.",
    ),
  ]);
}

async function cmdStackList(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const cfg = await loadConfig();
  const stacks = await listStacks(cfg);
  if (asJson) {
    console.log(JSON.stringify({ stacks }, null, 2));
    return;
  }
  if (canBrowse()) {
    await runLineTabsBrowser({
      tabs: [{ id: "yours", label: "Stacks", lines: buildStackListLines(stacks) }],
    });
    return;
  }
  if (stacks.length === 0) {
    await present("Stacks", [
      ansi.dim("  No stacks yet. Author with `stack create` → commit → `stack submit`."),
      ansi.dim("  Import an existing chain only: `stack adopt owner/repo#pr`"),
      ansi.dim("  Dashboard: https://mergestorm.ai/dashboard"),
    ]);
    return;
  }
  const listed: string[] = [];
  for (const s of stacks) {
    listed.push(...formatStackHuman(s), "");
  }
  listed.push(ansi.dim("  Dashboard: https://mergestorm.ai/dashboard"));
  await present("Stacks", listed);
}

export type StackSetDeps = {
  loadConfig?: typeof loadConfig;
  setStackPolicy?: typeof setStackPolicy;
};

/** Human summary lines for a `stack set` write, one per flag. */
export function stackSetSummary(parsed: StackSetArgs): string[] {
  const tri = (value: boolean | null) =>
    value === null ? "default (account setting)" : value ? "on" : "off";
  const lines: string[] = [];
  if (parsed.autoLand !== undefined) {
    lines.push(`Auto land ${parsed.autoLand ? "on" : "off"}`);
  }
  if (parsed.autoReview !== undefined) {
    lines.push(`Auto-review ${tri(parsed.autoReview)}`);
  }
  if (parsed.autoPatch !== undefined) {
    lines.push(`Auto-patch ${tri(parsed.autoPatch)}`);
  }
  return lines;
}

export async function cmdStackSet(
  args: string[],
  deps: StackSetDeps = {},
): Promise<void> {
  const parsed = parseStackSetArgs(args);
  const cfg = await (deps.loadConfig ?? loadConfig)();
  const body = await (deps.setStackPolicy ?? setStackPolicy)(
    parsed.stackId,
    {
      ...(parsed.autoLand !== undefined ? { autoEnqueueWhenReady: parsed.autoLand } : {}),
      ...(parsed.autoReview !== undefined ? { autoReviewOverride: parsed.autoReview } : {}),
      ...(parsed.autoPatch !== undefined ? { autoPatchOverride: parsed.autoPatch } : {}),
    },
    cfg,
  );
  if (parsed.asJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  await present(
    "Stack",
    stackSetSummary(parsed).map((line) =>
      ansi.brightGreen(`  ${line} for ${parsed.stackId}`),
    ),
  );
}

async function cmdStackAdopt(args: string[]): Promise<void> {
  const { owner, repo, prNumber, autoLand, autoReview, autoPatch, asJson } =
    parseStackAdoptArgs(args);
  const cfg = await loadConfig();
  const body = await adoptStack(
    owner,
    repo,
    prNumber,
    cfg,
    openPolicyPatch({ autoLand, autoReview, autoPatch }),
  );
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
  const imported: string[] = [
    ansi.brightGreen(
      `  Imported ${owner}/${repo}#${prNumber}` +
        (stack?.id ? ` → ${stack.id}` : "") +
        (Array.isArray(chain) ? ` (${chain.length} layer(s))` : ""),
    ),
  ];
  if (stack?.trunkBranch) {
    imported.push(ansi.dim(`  trunk: ${stack.trunkBranch}`));
  }
  imported.push(ansi.dim("  Dashboard: https://mergestorm.ai/dashboard"));
  await present("Stack", imported);
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
  await present("Stack", [
    ansi.brightGreen(`  Restack started` + (fromBranch ? ` from ${fromBranch}` : "") + ` (${id})`),
  ]);
}

async function cmdStackLand(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const id = requireStackId(
    args.find((a) => a !== "--json"),
    "usage: mergestorm stack land <stack-id>",
  );
  const cfg = await loadConfig();
  // Server routes unit stacks to promote-next (land tip into review unit).
  const body = await landNextStack(id, cfg);
  if (asJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const pr = (body as { mergedPrNumber?: number }).mergedPrNumber;
  const branch = (body as { mergedBranch?: string }).mergedBranch;
  const uNumber = (body as { uNumber?: number }).uNumber;
  if (typeof uNumber === "number" && uNumber > 0) {
    await present("Stack", [
      ansi.brightGreen(
        `  Promoted` +
          (pr != null ? ` #${pr}` : "") +
          ` into U${uNumber}` +
          (branch ? ` (${branch})` : "") +
          ` on ${id}`,
      ),
    ]);
    return;
  }
  await present("Stack", [
    ansi.brightGreen(
      `  Landed` +
        (pr != null ? ` #${pr}` : "") +
        (branch ? ` (${branch})` : "") +
        ` on ${id}`,
    ),
  ]);
}

export async function cmdStack(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();
  const rest = args.slice(1);
  // Help must exit 0 — print usage, do not throw CommandError.
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    if (canBrowse()) {
      await openHelpBrowser("stacks");
      return;
    }
    console.log(STACK_USAGE);
    return;
  }
  if (sub === "create") return cmdStackCreate(rest);
  if (sub === "submit") return cmdStackSubmit(rest);
  if (sub === "reset") return cmdStackReset(rest);
  if (sub === "list" || sub === "ls") return cmdStackList(rest);
  if (sub === "set") return cmdStackSet(rest);
  if (sub === "adopt") return cmdStackAdopt(rest);
  if (sub === "restack") return cmdStackRestack(rest);
  if (sub === "land" || sub === "land-next") return cmdStackLand(rest);
  throw new CommandError(`${STACK_USAGE}\nunknown stack subcommand: ${sub}`);
}
