import { apiBase, loadConfig, resolveApiKey, type Config } from "./config.js";
import { CommandError } from "./errors.js";

export async function apiFetch(
  cfg: Config,
  route: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const key = resolveApiKey(cfg);
  if (!key) {
    throw new CommandError("No API key. Run `mergestorm login` or set MERGESTORM_API_KEY.");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    ...(init.headers as Record<string, string> | undefined),
  };
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${apiBase(cfg)}${route}`, { ...init, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: res.status, body: parsed };
}

export async function devicePost(
  base: string,
  route: string,
  json: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(json),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: res.status, body: parsed };
}

export type MeResponse = {
  key: { prefix: string; name: string; created_at: string; last_used_at: string | null };
  plan_key: string;
  plan_label_key?: string;
  /** Start of next UTC month (usage meters reset). Older APIs omit this. */
  resets_at?: string;
  usage: {
    standard: { used: number; limit: number | null; remaining: number | null };
    premium: { used: number; limit: number | null; remaining: number | null };
  };
};

export type JobListItem = {
  job_id: string;
  thread_slug: string | null;
  status: string;
  verdict: string | null;
  summary: string | null;
  base_label: string | null;
  head_label: string | null;
  created_at: string;
  finished_at: string | null;
  credits: number;
};

export type ThreadListItem = {
  slug: string;
  branch: string | null;
  owner: string | null;
  repo: string | null;
  pr_number: number | null;
  status: string;
  job_count: number;
  last_verdict: string | null;
  last_activity_at: string;
};

export type ThreadDetail = {
  thread_id: string;
  slug: string;
  source?: string;
  branch: string | null;
  owner: string | null;
  repo: string | null;
  pr_number: number | null;
  status: string;
  pr_linked_at: string | null;
  job_count: number;
  created_at: string;
  jobs: {
    job_id: string;
    status: string;
    summary?: string | null;
    verdict?: string | null;
    thread_job_number?: number | null;
    created_at: string;
    finished_at?: string | null;
  }[];
};

/** Fetch /api/v1/me; returns null on 404/network so callers can degrade. */
export async function getMe(cfg?: Config): Promise<MeResponse | null> {
  const resolved = cfg ?? (await loadConfig());
  try {
    const { status, body } = await apiFetch(resolved, "/api/v1/me");
    if (status === 404) return null;
    if (status !== 200) return null;
    return body as MeResponse;
  } catch {
    return null;
  }
}

export async function listJobs(limit = 10, cfg?: Config): Promise<JobListItem[]> {
  const resolved = cfg ?? (await loadConfig());
  const capped = Math.min(Math.max(limit, 1), 50);
  const { status, body } = await apiFetch(resolved, `/api/v1/reviews?limit=${capped}`);
  if (status === 404) {
    throw new CommandError("Job list is not available on this server yet. Update the API or use the dashboard.");
  }
  if (status !== 200) {
    throw new CommandError(`Failed to list jobs (HTTP ${status}): ${JSON.stringify(body)}`);
  }
  const items = (body as { items?: JobListItem[] }).items;
  return Array.isArray(items) ? items : [];
}

export type StackLayerDto = {
  branch: string;
  parentBranch: string | null;
  prNumber: number;
  position: number;
  state: string;
  title: string | null;
  htmlUrl: string | null;
  ciStatus: string;
  reviewStatus: string;
  checks: {
    total: number;
    success: number;
    pending: number;
    failure: number;
    failingName: string | null;
  } | null;
  conflictDetail: string | null;
  lastRestackedSha: string | null;
};

export type StackDto = {
  id: string;
  owner: string;
  repo: string;
  trunkBranch: string;
  autoPromoteWhenGreen: boolean;
  layers: StackLayerDto[];
};

/** List stacks (Bearer GET /api/v1/stacks). */
export async function listStacks(cfg?: Config): Promise<StackDto[]> {
  const resolved = cfg ?? (await loadConfig());
  const { status, body } = await apiFetch(resolved, "/api/v1/stacks");
  if (status === 404) {
    throw new CommandError(
      "Stacks API is not available on this server yet. Deploy the API update or use the dashboard.",
    );
  }
  if (status !== 200) {
    throw new CommandError(`Failed to list stacks (HTTP ${status}): ${JSON.stringify(body)}`);
  }
  const stacks = (body as { stacks?: StackDto[] }).stacks;
  return Array.isArray(stacks) ? stacks : [];
}

/** Adopt an open PR chain (Bearer POST /api/v1/stacks/adopt). */
export async function adoptStack(
  owner: string,
  repo: string,
  prNumber: number,
  cfg?: Config,
): Promise<unknown> {
  const resolved = cfg ?? (await loadConfig());
  const { status, body } = await apiFetch(resolved, "/api/v1/stacks/adopt", {
    method: "POST",
    json: { owner, repo, prNumber },
  });
  if (status === 404) {
    throw new CommandError(
      "Stacks API is not available on this server yet. Deploy the API update or use the dashboard.",
    );
  }
  if (status !== 200) {
    throw new CommandError(`Failed to import stack (HTTP ${status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function stackMutation(
  stackId: string,
  pathSuffix: string,
  method: "POST" | "PATCH",
  json: unknown | undefined,
  failLabel: string,
  cfg?: Config,
): Promise<unknown> {
  const resolved = cfg ?? (await loadConfig());
  const { status, body } = await apiFetch(
    resolved,
    `/api/v1/stacks/${encodeURIComponent(stackId)}${pathSuffix}`,
    method === "PATCH"
      ? { method, json }
      : { method, json: json ?? {} },
  );
  if (status === 404) {
    const err = (body as { error?: string } | null)?.error;
    if (err === "stack_not_found") {
      throw new CommandError(`Stack not found: ${stackId}`);
    }
    throw new CommandError(
      "Stacks API is not available on this server yet. Deploy the API update or use the dashboard.",
    );
  }
  if (status !== 200) {
    throw new CommandError(`${failLabel} (HTTP ${status}): ${JSON.stringify(body)}`);
  }
  return body;
}

/** Restack descendants (Bearer POST /api/v1/stacks/:id/restack). */
export async function restackStack(stackId: string, cfg?: Config): Promise<unknown> {
  return stackMutation(stackId, "/restack", "POST", {}, "Failed to restack", cfg);
}

/** Land the bottom open layer (Bearer POST /api/v1/stacks/:id/land-next). */
export async function landNextStack(
  stackId: string,
  cfg?: Config,
  opts?: { prNumber?: number },
): Promise<unknown> {
  const json =
    opts?.prNumber != null && Number.isInteger(opts.prNumber) && opts.prNumber > 0
      ? { prNumber: opts.prNumber }
      : {};
  return stackMutation(stackId, "/land-next", "POST", json, "Failed to land next", cfg);
}

/** Toggle auto-promote when green (Bearer PATCH /api/v1/stacks/:id). */
export async function setStackAutoPromote(
  stackId: string,
  autoPromoteWhenGreen: boolean,
  cfg?: Config,
): Promise<unknown> {
  return stackMutation(
    stackId,
    "",
    "PATCH",
    { autoPromoteWhenGreen },
    "Failed to update auto-promote",
    cfg,
  );
}

/** Recently reviewed branches/threads (Bearer GET /api/v1/threads). */
export async function listThreads(limit = 20, cfg?: Config): Promise<ThreadListItem[]> {
  const resolved = cfg ?? (await loadConfig());
  const capped = Math.min(Math.max(limit, 1), 50);
  const { status, body } = await apiFetch(resolved, `/api/v1/threads?limit=${capped}`);
  if (status === 404) {
    throw new CommandError(
      "Branch list is not available on this server yet. Deploy the API update or use the dashboard.",
    );
  }
  if (status !== 200) {
    throw new CommandError(`Failed to list branches (HTTP ${status}): ${JSON.stringify(body)}`);
  }
  const items = (body as { items?: ThreadListItem[] }).items;
  return Array.isArray(items) ? items : [];
}
