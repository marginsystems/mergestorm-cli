import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandError, isCommandErrorCode } from "../errors.js";
import { gitTopLevel } from "../repo-identity.js";
import { present } from "../ui/present.js";

export const SKILL_NAME = "mergestorm-review";
export const PR_LOOP_SKILL_NAME = "mergestorm-pr-loop";
export const SKILL_NAMES = [SKILL_NAME, PR_LOOP_SKILL_NAME] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

export const SKILL_USAGE = `usage:
  mergestorm skill install --claude|--cursor [--json]

  Copies mergestorm-review and mergestorm-pr-loop into this repo (git toplevel, else cwd):
    --claude  .claude/skills/<name>/SKILL.md
    --cursor  .cursor/skills/<name>/SKILL.md
  Pass both flags to write both trees. Overwrites existing copies.`;

export type SkillTarget = "claude" | "cursor";

export type SkillInstallRequest = {
  help: boolean;
  json: boolean;
  targets: SkillTarget[];
};

export function parseSkillArgs(args: string[]): SkillInstallRequest {
  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    return { help: true, json: false, targets: [] };
  }
  if (sub !== "install") {
    throw new CommandError(`${SKILL_USAGE}\nunknown skill subcommand: ${sub}`, 1, "usage");
  }
  let json = false;
  const targets: SkillTarget[] = [];
  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--claude") {
      if (!targets.includes("claude")) targets.push("claude");
      continue;
    }
    if (arg === "--cursor") {
      if (!targets.includes("cursor")) targets.push("cursor");
      continue;
    }
    if (arg === "-h" || arg === "--help" || arg === "help") {
      return { help: true, json: false, targets: [] };
    }
    throw new CommandError(`${SKILL_USAGE}\nunknown flag: ${arg}`, 1, "usage");
  }
  if (targets.length === 0) {
    throw new CommandError(`${SKILL_USAGE}\npass --claude and/or --cursor`, 1, "usage");
  }
  return { help: false, json, targets };
}

/** Prefer the git repo root so `mg skill install` from a subdir still lands in-project. */
export function skillInstallRoot(cwd = process.cwd()): string {
  try {
    return gitTopLevel(cwd);
  } catch (err) {
    if (isCommandErrorCode(err, "not_a_repo")) return path.resolve(cwd);
    throw err;
  }
}

export function skillDestination(
  root: string,
  target: SkillTarget,
  name: SkillName = SKILL_NAME,
): string {
  if (target === "claude") {
    return path.join(root, ".claude", "skills", name, "SKILL.md");
  }
  return path.join(root, ".cursor", "skills", name, "SKILL.md");
}

export function resolveBundledSkillPath(
  fromFile = import.meta.url,
  name: SkillName = SKILL_NAME,
): string {
  const here = path.dirname(fileURLToPath(fromFile));
  const packageRoot = path.resolve(here, "..", "..");
  // The published package ships the review skill at skill/SKILL.md; extra
  // skills sit beside it in per-name directories. The monorepo keeps every
  // skill under skills/<name>/SKILL.md.
  const candidates =
    name === SKILL_NAME
      ? [
          path.join(packageRoot, "skill", "SKILL.md"),
          path.join(packageRoot, "..", "..", "skills", name, "SKILL.md"),
        ]
      : [
          path.join(packageRoot, "skill", name, "SKILL.md"),
          path.join(packageRoot, "..", "..", "skills", name, "SKILL.md"),
        ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new CommandError(
    `${name} skill is missing (looked in ${candidates.join(" and ")})`,
  );
}

async function assertNoSymlink(dest: string): Promise<void> {
  const parts = dest.split(path.sep);
  const marker = parts.findIndex((p) => p === ".claude" || p === ".cursor");
  const first = marker === -1 ? parts.length - 1 : marker;
  for (let i = first; i < parts.length; i++) {
    const candidate = parts.slice(0, i + 1).join(path.sep);
    let stat;
    try {
      stat = await lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new CommandError(`refusing to write skill through symlink: ${candidate}`);
    }
  }
}

export async function writeSkillCopies(
  sourcePath: string,
  destinations: string[],
): Promise<string[]> {
  const body = readFileSync(sourcePath, "utf8");
  const written: string[] = [];
  for (const dest of destinations) {
    await assertNoSymlink(dest);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, body, "utf8");
    written.push(dest);
  }
  return written;
}

export async function cmdSkill(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<void> {
  const req = parseSkillArgs(args);
  if (req.help) {
    await present("Skill", SKILL_USAGE.split("\n"));
    return;
  }
  const root = skillInstallRoot(opts.cwd);
  const sources: Record<string, string> = {};
  const written: string[] = [];
  for (const name of SKILL_NAMES) {
    const source = resolveBundledSkillPath(undefined, name);
    sources[name] = source;
    const destinations = req.targets.map((t) => skillDestination(root, t, name));
    written.push(...(await writeSkillCopies(source, destinations)));
  }
  if (req.json) {
    await present(
      "Skill",
      JSON.stringify({ names: SKILL_NAMES, sources, written }, null, 2).split("\n"),
    );
    return;
  }
  await present("Skill", [
    `  Installed ${SKILL_NAMES.join(" and ")}`,
    ...written.map((dest) => `  ${dest}`),
  ]);
}
