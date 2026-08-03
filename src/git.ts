import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export function git(args: string[], cwd = process.cwd()): string {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `git ${args.join(" ")} failed`);
    }
    return result.stdout;
  } catch (err) {
    throw new Error(`git ${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function collectChangedFiles(
  base: string,
  head: string,
): Promise<{ path: string; content: string }[]> {
  const names = git(["diff", "--name-only", "--diff-filter=ACMR", `${base}...${head}`])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const files: { path: string; content: string }[] = [];
  for (const name of names.slice(0, 40)) {
    try {
      const st = await stat(path.join(process.cwd(), name));
      if (!st.isFile() || st.size > 400_000) continue;
      const content = await readFile(path.join(process.cwd(), name), "utf8");
      files.push({ path: name, content });
    } catch {
      // deleted or unreadable
    }
  }
  return files;
}
