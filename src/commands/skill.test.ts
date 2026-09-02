import assert from "node:assert/strict";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CommandError } from "../errors.js";
import {
  cmdSkill,
  parseSkillArgs,
  PR_LOOP_SKILL_NAME,
  resolveBundledSkillPath,
  SKILL_NAME,
  SKILL_NAMES,
  skillDestination,
  skillInstallRoot,
  writeSkillCopies,
} from "./skill.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mg-skill-"));
  tmpDirs.push(dir);
  return dir;
}

async function capture(fn: () => Promise<void>): Promise<string> {
  const stdout: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  try {
    await fn();
    return stdout.join("\n");
  } finally {
    console.log = originalLog;
  }
}

test("parseSkillArgs treats bare skill / help as usage", () => {
  assert.deepEqual(parseSkillArgs([]), { help: true, json: false, targets: [] });
  assert.deepEqual(parseSkillArgs(["--help"]), { help: true, json: false, targets: [] });
  assert.deepEqual(parseSkillArgs(["help"]), { help: true, json: false, targets: [] });
  assert.deepEqual(parseSkillArgs(["install", "--help"]), {
    help: true,
    json: false,
    targets: [],
  });
});

test("parseSkillArgs requires install plus --claude and/or --cursor", () => {
  assert.deepEqual(parseSkillArgs(["install", "--claude"]), {
    help: false,
    json: false,
    targets: ["claude"],
  });
  assert.deepEqual(parseSkillArgs(["install", "--cursor", "--claude", "--json"]), {
    help: false,
    json: true,
    targets: ["cursor", "claude"],
  });
  assert.throws(() => parseSkillArgs(["install"]), CommandError);
  assert.throws(() => parseSkillArgs(["publish"]), CommandError);
  assert.throws(() => parseSkillArgs(["install", "--global"]), CommandError);
});

test("skillInstallRoot falls back to cwd when not a git repo", async () => {
  const dir = await tmp();
  assert.equal(skillInstallRoot(dir), path.resolve(dir));
});

test("resolveBundledSkillPath finds mergestorm-review with expected frontmatter", async () => {
  const source = resolveBundledSkillPath();
  const body = await readFile(source, "utf8");
  assert.match(body, /^---\nname: mergestorm-review/m);
  assert.match(body, /review_submit/);
  const monorepo = path.resolve(
    path.dirname(source),
    "..",
    "..",
    "skills",
    SKILL_NAME,
    "SKILL.md",
  );
  // Monorepo: source is skills/…; public tree: source is skill/SKILL.md.
  if (source.endsWith(path.join("skills", SKILL_NAME, "SKILL.md"))) {
    assert.equal(source, monorepo);
  }
});

test("bundled pr-loop skill has its own frontmatter and never names the local submit tool", async () => {
  const source = resolveBundledSkillPath(undefined, PR_LOOP_SKILL_NAME);
  const body = await readFile(source, "utf8");
  assert.match(body, /^---\nname: mergestorm-pr-loop/m);
  assert.match(body, /review_wait_pr/);
  assert.equal(body.includes("review_submit"), false);
});

test("resolveBundledSkillPath resolves skill/SKILL.md in an installed package layout", async () => {
  const dir = await tmp();
  const pkgRoot = path.join(dir, "node_modules", "mergestorm");
  const skillFile = path.join(pkgRoot, "skill", "SKILL.md");
  await mkdir(path.dirname(skillFile), { recursive: true });
  await copyFile(resolveBundledSkillPath(), skillFile);
  const installedFrom = path.join(pkgRoot, "dist", "commands", "skill.js");
  assert.equal(resolveBundledSkillPath(pathToFileURL(installedFrom).href), skillFile);
});

test("resolveBundledSkillPath resolves the pr-loop skill in an installed package layout", async () => {
  const dir = await tmp();
  const pkgRoot = path.join(dir, "node_modules", "mergestorm");
  const skillFile = path.join(pkgRoot, "skill", PR_LOOP_SKILL_NAME, "SKILL.md");
  await mkdir(path.dirname(skillFile), { recursive: true });
  await copyFile(resolveBundledSkillPath(undefined, PR_LOOP_SKILL_NAME), skillFile);
  const installedFrom = path.join(pkgRoot, "dist", "commands", "skill.js");
  assert.equal(
    resolveBundledSkillPath(pathToFileURL(installedFrom).href, PR_LOOP_SKILL_NAME),
    skillFile,
  );
});

test("writeSkillCopies refuses to write through a symlinked destination", async () => {
  const dir = await tmp();
  const victim = path.join(dir, "victim.md");
  await writeFile(victim, "do not touch");
  const destDir = path.join(dir, ".claude", "skills", SKILL_NAME);
  await mkdir(destDir, { recursive: true });
  await symlink(victim, path.join(destDir, "SKILL.md"));
  await assert.rejects(
    writeSkillCopies(resolveBundledSkillPath(), [path.join(destDir, "SKILL.md")]),
    CommandError,
  );
  assert.equal(await readFile(victim, "utf8"), "do not touch");
});

test("writeSkillCopies refuses a symlinked .claude ancestor", async () => {
  const dir = await tmp();
  await symlink(dir, path.join(dir, ".claude"));
  await assert.rejects(
    writeSkillCopies(resolveBundledSkillPath(), [
      path.join(dir, ".claude", "skills", SKILL_NAME, "SKILL.md"),
    ]),
    CommandError,
  );
});

test("cmdSkill refuses a symlinked pr-loop destination", async () => {
  const dir = await tmp();
  const victim = path.join(dir, "victim.md");
  await writeFile(victim, "do not touch");
  const destDir = path.join(dir, ".claude", "skills", PR_LOOP_SKILL_NAME);
  await mkdir(destDir, { recursive: true });
  await symlink(victim, path.join(destDir, "SKILL.md"));
  await assert.rejects(cmdSkill(["install", "--claude"], { cwd: dir }), CommandError);
  assert.equal(await readFile(victim, "utf8"), "do not touch");
});

test("writeSkillCopies installs claude and cursor paths", async () => {
  const dir = await tmp();
  const source = resolveBundledSkillPath();
  const written = await writeSkillCopies(source, [
    skillDestination(dir, "claude"),
    skillDestination(dir, "cursor"),
  ]);
  const expected = await readFile(source, "utf8");
  assert.equal(await readFile(written[0]!, "utf8"), expected);
  assert.equal(await readFile(written[1]!, "utf8"), expected);
  assert.ok(written[0]!.endsWith(path.join(".claude", "skills", SKILL_NAME, "SKILL.md")));
  assert.ok(written[1]!.endsWith(path.join(".cursor", "skills", SKILL_NAME, "SKILL.md")));
});

test("cmdSkill --claude installs both skills", async () => {
  const dir = await tmp();
  await capture(() => cmdSkill(["install", "--claude"], { cwd: dir }));
  for (const name of SKILL_NAMES) {
    const dest = skillDestination(dir, "claude", name);
    const expected = await readFile(
      resolveBundledSkillPath(undefined, name),
      "utf8",
    );
    assert.equal(await readFile(dest, "utf8"), expected);
  }
});

test("cmdSkill --json writes all four copies and lists both names", async () => {
  const dir = await tmp();
  const out = await capture(() =>
    cmdSkill(["install", "--claude", "--cursor", "--json"], { cwd: dir }),
  );
  const payload = JSON.parse(out) as {
    names: string[];
    sources: Record<string, string>;
    written: string[];
  };
  assert.deepEqual(payload.names, [SKILL_NAME, PR_LOOP_SKILL_NAME]);
  assert.equal(payload.written.length, 4);
  for (const name of payload.names) {
    const expected = await readFile(payload.sources[name]!, "utf8");
    const copies = payload.written.filter((dest) =>
      dest.includes(path.join("skills", name, "SKILL.md")),
    );
    assert.equal(copies.length, 2);
    for (const dest of copies) {
      assert.equal(await readFile(dest, "utf8"), expected);
    }
  }
});

test("publish-cli.yml packs both skills into the npm tarball", async () => {
  const repoRoot = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
  const workflowPath = path.join(repoRoot, ".github/workflows/publish-cli.yml");
  if (!(await access(workflowPath).then(() => true, () => false))) return;
  const workflow = await readFile(
    workflowPath,
    "utf8",
  );
  assert.match(workflow, /skills\/mergestorm-review\/SKILL\.md/);
  assert.match(workflow, /skills\/mergestorm-pr-loop\/SKILL\.md/);
  assert.match(workflow, /skill\/mergestorm-pr-loop\/SKILL\.md/);
});
