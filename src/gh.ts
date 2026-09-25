import { spawnSync } from "node:child_process";
import { CommandError } from "./errors.js";

export type GhResult =
  | { ok: true; stdout: string }
  | { ok: false; stderr: string; status: number | null; stdout?: string };

export type GhRunner = (args: string[], input?: string) => GhResult;

export type GithubApi = "graphql" | "rest";

export const GITHUB_API_ENV = "MERGESTORM_GITHUB_API";

export function githubApiFromEnv(env: NodeJS.ProcessEnv = process.env): GithubApi {
  return env[GITHUB_API_ENV]?.trim().toLowerCase() === "rest" ? "rest" : "graphql";
}

const GRAPHQL_UNAVAILABLE = /graphql\b[^\n]*\b(?:not available|unavailable|blocked|disabled)\b/i;
const GRAPHQL_CONTEXT = /\bgraphql\b/i;

export function isGraphqlEndpointBlocked(text: string): boolean {
  return GRAPHQL_UNAVAILABLE.test(text) || (/\bHTTP 403\b/.test(text) && GRAPHQL_CONTEXT.test(text));
}

export class GraphqlBlockedError extends CommandError {
  readonly opened: readonly number[];

  constructor(message: string, opened: readonly number[] = []) {
    super(message);
    this.name = "GraphqlBlockedError";
    this.opened = opened;
  }
}

type GhSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: "utf8"; input?: string },
) => {
  error?: Error;
  stdout?: string | null;
  stderr?: string | null;
  status: number | null;
};

export function runGh(
  args: string[],
  cwd = process.cwd(),
  input?: string,
  spawn: GhSpawn = spawnSync,
): GhResult {
  const result = spawn("gh", args, {
    cwd,
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
  if (result.error) {
    const msg = result.error.message || String(result.error);
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, stderr: "gh not found", status: null };
    }
    return { ok: false, stderr: msg, status: result.status };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      stderr: (result.stderr || result.stdout || `gh ${args.join(" ")} failed`).trim(),
      status: result.status,
      stdout: result.stdout ?? "",
    };
  }
  return { ok: true, stdout: result.stdout ?? "" };
}

export function ghReady(cwd = process.cwd(), gh: GhRunner = (args) => runGh(args, cwd)): boolean {
  return gh(["--version"]).ok && gh(["api", "user"]).ok;
}

/** Open PR number for `head` branch in owner/repo, or null. */
export function findOpenPrNumber(
  owner: string,
  repo: string,
  headBranch: string,
  cwd = process.cwd(),
  options: { api?: GithubApi; gh?: GhRunner } = {},
): number | null {
  const gh: GhRunner = options.gh ?? ((args, input) => runGh(args, cwd, input));
  if ((options.api ?? githubApiFromEnv()) === "rest") {
    return findOpenPrNumberViaRest(owner, repo, headBranch, gh);
  }
  try {
    return findOpenPrNumberViaGraphql(owner, repo, headBranch, gh);
  } catch (err) {
    if (err instanceof GraphqlBlockedError) {
      return findOpenPrNumberViaRest(owner, repo, headBranch, gh);
    }
    throw err;
  }
}

function findOpenPrNumberViaGraphql(
  owner: string,
  repo: string,
  headBranch: string,
  gh: GhRunner,
): number | null {
  const res = gh([
    "pr",
    "list",
    "--repo",
    `${owner}/${repo}`,
    "--head",
    headBranch,
    "--state",
    "open",
    "--json",
    "number",
    "--limit",
    "1",
  ]);
  if (!res.ok) {
    const message = `Failed to list PRs for ${headBranch}: ${res.stderr}`;
    if (isGraphqlEndpointBlocked(`${res.stderr}\n${res.stdout ?? ""}`)) {
      throw new GraphqlBlockedError(message);
    }
    throw new CommandError(message);
  }
  return firstPrNumber(res.stdout);
}

export function findOpenPrNumberViaRest(
  owner: string,
  repo: string,
  headBranch: string,
  gh: GhRunner,
): number | null {
  const res = gh([
    "api",
    "-X",
    "GET",
    `repos/${owner}/${repo}/pulls`,
    "-f",
    `head=${owner}:${headBranch}`,
    "-f",
    "state=open",
    "-f",
    "per_page=1",
  ]);
  if (!res.ok) {
    throw new CommandError(`Failed to list PRs for ${headBranch}: ${res.stderr}`);
  }
  return firstPrNumber(res.stdout);
}

function firstPrNumber(stdout: string): number | null {
  try {
    const rows = JSON.parse(stdout) as { number?: number }[];
    const n = rows[0]?.number;
    return typeof n === "number" && n > 0 ? n : null;
  } catch (e) {
    throw new CommandError(`Failed to parse PR list response: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type NewPr = {
  base: string;
  head: string;
  title: string;
  body: string;
};

export type GraphqlRequest = {
  query: string;
  variables: Record<string, unknown>;
};

export type GraphqlResponse = {
  data?: Record<string, unknown> | null;
  errors?: { message?: string }[];
};

export type GraphqlRunner = (request: GraphqlRequest) => GraphqlResponse;

type GraphqlSpawnResult = {
  error?: Error;
  stdout?: string | null;
  stderr?: string | null;
  status: number | null;
};

type GraphqlSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: "utf8"; input: string },
) => GraphqlSpawnResult;

export const CREATE_PR_BATCH_SIZE = 5;

export function ghGraphql(
  request: GraphqlRequest,
  cwd = process.cwd(),
  spawn: GraphqlSpawn = spawnSync,
): GraphqlResponse {
  const result = spawn("gh", ["api", "graphql", "--input", "-"], {
    cwd,
    encoding: "utf8",
    input: JSON.stringify(request),
  });
  if (result.error) {
    throw new CommandError(`gh api graphql failed: ${result.error.message || String(result.error)}`);
  }
  const stdout = (result.stdout ?? "").trim();
  if (result.status !== 0 && isGraphqlEndpointBlocked(result.stderr ?? "")) {
    return failGraphql(result.stderr ?? null, stdout, result.status, true);
  }
  try {
    const parsed = JSON.parse(stdout) as GraphqlResponse;
    if (parsed && typeof parsed === "object" && ("data" in parsed || "errors" in parsed)) {
      return parsed;
    }
  } catch {
    return failGraphql(result.stderr ?? null, stdout, result.status, isGraphqlEndpointBlocked(stdout));
  }
  return failGraphql(result.stderr ?? null, stdout, result.status, isGraphqlEndpointBlocked(stdout));
}

function failGraphql(
  stderr: string | null,
  stdout: string,
  status: number | null,
  blocked: boolean,
): never {
  const message = `gh api graphql failed: ${(stderr || stdout || `exit ${status}`).trim()}`;
  throw blocked ? new GraphqlBlockedError(message) : new CommandError(message);
}

export function chunkCreatePrs<T>(items: readonly T[], size = CREATE_PR_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function buildCreatePrsMutation(
  repositoryId: string,
  prs: readonly NewPr[],
): GraphqlRequest {
  const params = prs.map((_, i) => `$in${i}: CreatePullRequestInput!`).join(", ");
  const fields = prs
    .map((_, i) => `  pr${i}: createPullRequest(input: $in${i}) { pullRequest { number } }`)
    .join("\n");
  const variables: Record<string, unknown> = {};
  prs.forEach((pr, i) => {
    variables[`in${i}`] = {
      repositoryId,
      baseRefName: pr.base,
      headRefName: pr.head,
      title: pr.title,
      body: pr.body,
    };
  });
  return { query: `mutation MgStackSubmit(${params}) {\n${fields}\n}`, variables };
}

function graphqlErrorText(errors: readonly { message?: string }[]): string {
  const messages = errors.map((e) => e.message?.trim()).filter((m): m is string => !!m);
  return messages.length > 0 ? messages.join("; ") : "unknown GraphQL error";
}

export function fetchRepositoryId(owner: string, repo: string, graphql: GraphqlRunner): string {
  const res = graphql({
    query: "query MgRepositoryId($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }",
    variables: { owner, name: repo },
  });
  const repository = res.data?.repository as { id?: unknown } | null | undefined;
  if (res.errors?.length || typeof repository?.id !== "string" || !repository.id) {
    throw new CommandError(
      `Could not look up GitHub repository ${owner}/${repo}: ${graphqlErrorText(res.errors ?? [])}`,
    );
  }
  return repository.id;
}

export function createPrsOnRepository(
  repositoryId: string,
  prs: readonly NewPr[],
  graphql: GraphqlRunner,
): number[] {
  const numbers: number[] = [];
  const openedSoFar = (): string[] =>
    numbers.map((n, i) => `#${n} (${prs[i]!.head})`);
  for (const chunk of chunkCreatePrs(prs)) {
    let res: GraphqlResponse;
    try {
      res = graphql(buildCreatePrsMutation(repositoryId, chunk));
    } catch (err) {
      if (err instanceof GraphqlBlockedError) throw new GraphqlBlockedError(err.message, [...numbers]);
      throw err;
    }
    const chunkNumbers = chunk.map((_, i) => {
      const row = res.data?.[`pr${i}`] as { pullRequest?: { number?: unknown } } | null | undefined;
      const n = row?.pullRequest?.number;
      return typeof n === "number" && n > 0 ? n : null;
    });
    const failed = (res.errors?.length ?? 0) > 0 || chunkNumbers.some((n) => n == null);
    if (failed) {
      const partial = chunk
        .map((pr, i) => (chunkNumbers[i] != null ? `#${chunkNumbers[i]} (${pr.head})` : null))
        .filter((s): s is string => s != null);
      const opened = [...openedSoFar(), ...partial];
      const heads = chunk.map((pr) => `${pr.head} → ${pr.base}`).join(", ");
      throw new CommandError(
        `Failed to open PRs ${heads}: ${graphqlErrorText(res.errors ?? [])}` +
          (opened.length > 0
            ? `\nGitHub did open ${opened.join(", ")}; retry \`mg stack submit\` to reuse them.`
            : ""),
      );
    }
    numbers.push(...(chunkNumbers as number[]));
  }
  return numbers;
}

const repositoryIds = new Map<string, string>();

function restErrorText(res: { stderr: string; stdout?: string }): string {
  let body: { message?: unknown; errors?: unknown };
  try {
    body = JSON.parse(res.stdout ?? "") as { message?: unknown; errors?: unknown };
  } catch {
    return res.stderr;
  }
  const details = (Array.isArray(body?.errors) ? body.errors : [])
    .map((e: { message?: unknown } | null) => (typeof e?.message === "string" ? e.message.trim() : ""))
    .filter((m: string) => m.length > 0);
  if (details.length > 0) return details.join("; ");
  if (typeof body?.message === "string" && body.message.trim()) return body.message.trim();
  return res.stderr;
}

export function createPrsViaRest(
  owner: string,
  repo: string,
  prs: readonly NewPr[],
  gh: GhRunner,
  opened: readonly number[] = [],
): number[] {
  const numbers = [...opened];
  for (const pr of prs.slice(numbers.length)) {
    const res = gh(
      ["api", "-X", "POST", `repos/${owner}/${repo}/pulls`, "--input", "-"],
      JSON.stringify({ title: pr.title, head: pr.head, base: pr.base, body: pr.body }),
    );
    let n: unknown = null;
    if (res.ok) {
      try {
        n = (JSON.parse(res.stdout) as { number?: unknown }).number;
      } catch {
        n = null;
      }
    }
    if (typeof n !== "number" || n <= 0) {
      const reason = res.ok ? "GitHub returned no pull request number" : restErrorText(res);
      const openedSoFar = numbers.map((num, i) => `#${num} (${prs[i]!.head})`);
      throw new CommandError(
        `Failed to open PRs ${pr.head} → ${pr.base}: ${reason}` +
          (openedSoFar.length > 0
            ? `\nGitHub did open ${openedSoFar.join(", ")}; retry \`mg stack submit\` to reuse them.`
            : ""),
      );
    }
    numbers.push(n);
  }
  return numbers;
}

export function createPrs(input: {
  owner: string;
  repo: string;
  prs: readonly NewPr[];
  cwd?: string;
  api?: GithubApi;
  graphql?: GraphqlRunner;
  gh?: GhRunner;
}): number[] {
  if (input.prs.length === 0) return [];
  const cwd = input.cwd ?? process.cwd();
  const gh: GhRunner = input.gh ?? ((args, stdin) => runGh(args, cwd, stdin));
  if ((input.api ?? githubApiFromEnv()) === "rest") {
    return createPrsViaRest(input.owner, input.repo, input.prs, gh);
  }
  const graphql: GraphqlRunner = input.graphql ?? ((request) => ghGraphql(request, cwd));
  try {
    const key = `${input.owner}/${input.repo}`.toLowerCase();
    let repositoryId = repositoryIds.get(key);
    if (!repositoryId) {
      repositoryId = fetchRepositoryId(input.owner, input.repo, graphql);
      repositoryIds.set(key, repositoryId);
    }
    return createPrsOnRepository(repositoryId, input.prs, graphql);
  } catch (err) {
    if (err instanceof GraphqlBlockedError) {
      return createPrsViaRest(input.owner, input.repo, input.prs, gh, err.opened);
    }
    throw err;
  }
}
