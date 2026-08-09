/**
 * CLI-owned pre-submit stack metadata for `mg stack create` / `submit`.
 * Stored outside repositories under ~/.mergestorm/stacks/<repo-id>/.
 */
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { CommandError, isCommandErrorCode } from "./errors.js";
import { git } from "./git.js";
import {
  cliStacksRoot,
  gitTopLevel,
  LEGACY_STACK_META_REL,
  legacyStackMetaPath,
  repoStateDir,
  stackMetaPath as resolveStackMetaPath,
} from "./repo-identity.js";

export type StackLayerMeta = {
  branch: string;
  /** Parent branch name (trunk for the bottom layer). */
  parentBranch: string;
};

export type LocalStack = {
  layers: StackLayerMeta[];
};

export type StackMeta = {
  version: 2;
  trunk: string;
  stacks: LocalStack[];
  /** Index into `stacks` for create/submit. */
  active: number;
};

/** Exported only for legacy migration/tests. New state never uses this path. */
export const STACK_META_REL = LEGACY_STACK_META_REL;

export function stackMetaPath(
  cwd = process.cwd(),
  stacksRoot = cliStacksRoot(),
): string {
  return resolveStackMetaPath(cwd, stacksRoot);
}

function isLayer(value: unknown): value is StackLayerMeta {
  if (!value || typeof value !== "object") return false;
  const layer = value as StackLayerMeta;
  return typeof layer.branch === "string" && typeof layer.parentBranch === "string";
}

function normalizeMeta(raw: unknown): StackMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as {
    version?: unknown;
    trunk?: unknown;
    stacks?: unknown;
    active?: unknown;
    layers?: unknown;
  };
  if (typeof obj.trunk !== "string" || !obj.trunk.trim()) {
    throw new Error(
      "Stack authoring state has no trunk; run `mg stack reset --force` to clear it.",
    );
  }

  if (obj.version === 2) {
    if (!Array.isArray(obj.stacks) || obj.stacks.length === 0) {
      throw new Error(
        "Stack authoring state has no stacks; run `mg stack reset --force` to clear it.",
      );
    }
    const stacks: LocalStack[] = [];
    for (const stack of obj.stacks) {
      if (
        !stack ||
        typeof stack !== "object" ||
        !Array.isArray((stack as LocalStack).layers) ||
        !(stack as LocalStack).layers.every(isLayer)
      ) {
        throw new Error(
          "Stack authoring state has a malformed stack entry; run `mg stack reset --force` to clear it.",
        );
      }
      stacks.push({ layers: (stack as LocalStack).layers });
    }
    const active = obj.active;
    if (
      typeof active !== "number" ||
      !Number.isInteger(active) ||
      active < 0 ||
      active >= stacks.length
    ) {
      throw new Error(
        "Stack authoring state has an invalid active stack; run `mg stack reset --force` to clear it.",
      );
    }
    return { version: 2, trunk: obj.trunk, stacks, active };
  }

  if (obj.version === 1) {
    if (!Array.isArray(obj.layers) || !obj.layers.every(isLayer)) {
      throw new Error(
        "Stack authoring state has malformed legacy layers; run `mg stack reset --force` to clear it.",
      );
    }
    return {
      version: 2,
      trunk: obj.trunk,
      stacks: [{ layers: obj.layers }],
      active: 0,
    };
  }

  throw new Error(
    "Stack authoring state has an unknown version; run `mg stack reset --force` to clear it.",
  );
}

function parseStateJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new CommandError(
      "Stack authoring state is not valid JSON; run `mg stack reset --force` to clear it.",
    );
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

async function removeLegacyFile(
  file: string,
  cwd = process.cwd(),
  force = false,
): Promise<void> {
  const top = gitTopLevel(cwd);
  const rel = path.relative(top, file);
  try {
    git(["rm", "-f", "--", rel], top);
  } catch (err) {
    // Fall back to a plain unlink only for untracked files; otherwise the
    // index entry would remain after the worktree copy is gone.
    if (git(["ls-files", "--", rel], top).trim() !== "") {
      if (!force) {
        throw new Error(
          `git rm failed for tracked ${rel}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      git(["update-index", "--force-remove", "--", rel], top);
    }
    await unlink(file);
  }
  try {
    await rmdir(path.dirname(file));
  } catch {
    // Leave a non-empty .mergestorm directory untouched.
  }
}

export async function loadStackMeta(
  cwd = process.cwd(),
  stacksRoot = cliStacksRoot(),
): Promise<StackMeta | null> {
  const file = stackMetaPath(cwd, stacksRoot);
  const legacyFile = legacyStackMetaPath(cwd);
  const raw = await readIfExists(file);
  const legacyRaw = await readIfExists(legacyFile);

  if (raw !== null) {
    const meta = normalizeMeta(parseStateJson(raw));
    if (meta === null) {
      throw new CommandError(
        "Stack authoring state is not an object; run `mg stack reset --force` to clear it.",
      );
    }
    if (legacyRaw !== null) {
      const stateDir = repoStateDir(cwd, stacksRoot);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = path.join(stateDir, `legacy-conflict-${stamp}.json`);
      try {
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await chmod(stateDir, 0o700);
        await copyFile(legacyFile, backup);
        await chmod(backup, 0o600);
        await removeLegacyFile(legacyFile, cwd);
      } catch (err) {
        throw new CommandError(
          `Failed to preserve legacy stack state${err instanceof Error ? `: ${err.message}` : ""}; run \`mg stack reset --force\` to clear it.`,
        );
      }
      console.warn(
        `Warning: global stack state already existed; preserved legacy state at ${backup}.`,
      );
    }
    return meta;
  }

  if (legacyRaw === null) return null;
  const migrated = normalizeMeta(parseStateJson(legacyRaw));
  if (!migrated) return null;
  try {
    await saveStackMeta(migrated, cwd, stacksRoot);
    await removeLegacyFile(legacyFile, cwd);
  } catch (err) {
    throw new CommandError(
      `Failed to migrate legacy stack state${err instanceof Error ? `: ${err.message}` : ""}; run \`mg stack reset --force\` to clear it.`,
    );
  }
  return migrated;
}

export function emptyStackMeta(trunk: string): StackMeta {
  return {
    version: 2,
    trunk,
    stacks: [{ layers: [] }],
    active: 0,
  };
}

export function activeStack(meta: StackMeta): LocalStack {
  const stack = meta.stacks[meta.active];
  if (!stack) {
    throw new Error(
      "Stack authoring state has an out-of-range active stack; run `mg stack reset --force` to clear it.",
    );
  }
  return stack;
}

export function activeLayers(meta: StackMeta): StackLayerMeta[] {
  return activeStack(meta).layers;
}

export async function saveStackMeta(
  meta: StackMeta,
  cwd = process.cwd(),
  stacksRoot = cliStacksRoot(),
): Promise<void> {
  const file = stackMetaPath(cwd, stacksRoot);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const base = path.basename(file);
  for (const name of await readdir(dir)) {
    if (name.startsWith(`${base}.`) && name.endsWith(".tmp")) {
      await rm(path.join(dir, name), { force: true }).catch(() => {});
    }
  }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, file);
    await chmod(file, 0o600);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Explicit recovery. Does not touch branches, PRs, or registered server stacks. */
export async function resetStackMeta(
  cwd = process.cwd(),
  stacksRoot = cliStacksRoot(),
): Promise<void> {
  let stateFile: string;
  let legacyFile: string;
  try {
    stateFile = stackMetaPath(cwd, stacksRoot);
    legacyFile = legacyStackMetaPath(cwd);
  } catch (err) {
    // Outside a worktree / deleted main repo: reset is a no-op (nothing to clear).
    // Match on CommandError.code — do not treat it as a Node errno.
    if (isCommandErrorCode(err, "not_a_repo")) return;
    throw err;
  }
  await rm(stateFile, { force: true });
  try {
    await removeLegacyFile(legacyFile, cwd, true);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") throw err;
  }
}

export function appendLayer(meta: StackMeta, layer: StackLayerMeta): StackMeta {
  const current = activeLayers(meta);
  if (current.some((l) => l.branch === layer.branch)) {
    throw new Error(`branch already in stack: ${layer.branch}`);
  }
  for (let i = 0; i < meta.stacks.length; i++) {
    if (i === meta.active) continue;
    if (meta.stacks[i]!.layers.some((l) => l.branch === layer.branch)) {
      throw new Error(`branch already in another local stack: ${layer.branch}`);
    }
  }
  const stacks = meta.stacks.map((stack, index) =>
    index === meta.active
      ? { layers: [...stack.layers, layer] }
      : stack,
  );
  return { ...meta, stacks };
}

/**
 * Decide which local stack receives a new layer.
 * Onto trunk with a non-empty active stack → start a fresh local stack.
 */
export function selectStackForCreate(
  meta: StackMeta,
  parentBranch: string,
): StackMeta {
  const layers = activeLayers(meta);
  if (parentBranch === meta.trunk) {
    if (layers.length === 0) return meta;
    return {
      ...meta,
      stacks: [...meta.stacks, { layers: [] }],
      active: meta.stacks.length,
    };
  }

  if (layers.some((l) => l.branch === parentBranch)) {
    return meta;
  }

  if (layers.length === 0) {
    return meta;
  }

  for (let i = 0; i < meta.stacks.length; i++) {
    if (meta.stacks[i]!.layers.some((l) => l.branch === parentBranch)) {
      throw new Error(
        `Parent ${parentBranch} is a layer of a different local stack than the active one.`,
      );
    }
  }

  throw new Error(
    `Parent ${parentBranch} is not trunk (${meta.trunk}) or a stack layer.`,
  );
}

/** Drop the active stack after a successful submit. */
export function removeActiveStack(meta: StackMeta): StackMeta {
  if (meta.stacks.length <= 1) {
    return { ...meta, stacks: [{ layers: [] }], active: 0 };
  }
  const stacks = meta.stacks.filter((_, index) => index !== meta.active);
  const active = Math.min(meta.active, stacks.length - 1);
  return { ...meta, stacks, active };
}
