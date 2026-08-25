import { apiBase, loadConfig, resolveApiKey, type Config } from "./config.js";
import { CommandError, REVIEW_EXIT, rateLimitedMessage } from "./errors.js";
import type { StackDto } from "./stack-dto.js";

export type {
  StackBranchState,
  StackCiStatus,
  StackDto,
  StackLayerChecks,
  StackLayerDto,
  StackReviewStatus,
  StackTempestStatus,
  StackUnitDto,
  StackUnitMemberDto,
} from "./stack-dto.js";

/** Default per-request timeout so a hung API cannot stall the shell/CI forever. */
export const DEFAULT_API_TIMEOUT_MS = 30_000;

/** Message prefix of the CommandError thrown when a request exceeds its timeout. */
export const API_TIMEOUT_PREFIX = "Request timed out after";

export type ApiFetchInit = RequestInit & {
  json?: unknown;
  /** Override {@link DEFAULT_API_TIMEOUT_MS}. */
  timeoutMs?: number;
};

export type ApiFetchResult = {
  status: number;
  body: unknown;
  retryAfterSeconds?: number;
};

function asPositiveSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function parseRetryAfterHeader(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const asNumber = asPositiveSeconds(trimmed);
  if (asNumber !== undefined) return asNumber;
  const when = Date.parse(trimmed);
  if (!Number.isFinite(when)) return undefined;
  return Math.max(0, (when - Date.now()) / 1000);
}

/** Prefer the larger of `Retry-After` and JSON `retry_after_seconds`. */
export function parseRetryAfterSeconds(input: {
  header?: string | null;
  body?: unknown;
}): number | undefined {
  const fromBody =
    input.body && typeof input.body === "object"
      ? asPositiveSeconds((input.body as { retry_after_seconds?: unknown }).retry_after_seconds)
      : undefined;
  const fromHeader = parseRetryAfterHeader(input.header);
  if (fromBody === undefined) return fromHeader;
  if (fromHeader === undefined) return fromBody;
  return Math.max(fromBody, fromHeader);
}

function isAbortLike(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

/**
 * Combine an optional caller signal with a ref'd timeout.
 * (Built-in `AbortSignal.timeout` unrefs its timer, which can leave hung
 * fetches without a live timer in edge cases / tests.)
 */
function withRequestSignal(
  userSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  }, timeoutMs);

  const onUserAbort = () => {
    ac.abort(userSignal!.reason);
  };
  if (userSignal) {
    if (userSignal.aborted) onUserAbort();
    else userSignal.addEventListener("abort", onUserAbort, { once: true });
  }

  return {
    signal: ac.signal,
    dispose: () => {
      clearTimeout(timer);
      userSignal?.removeEventListener("abort", onUserAbort);
    },
  };
}

/** Map hung-request aborts to CommandError; preserve caller cancel (Ctrl+C detach). */
function rethrowFetchAbort(err: unknown, timeoutMs: number): never {
  if (isAbortLike(err)) {
    if (err.name === "AbortError") throw err;
    throw new CommandError(
      `${API_TIMEOUT_PREFIX} ${Math.round(timeoutMs / 1000)}s. Check network connectivity and API status.`,
      1,
      "api_timeout",
    );
  }
  throw err;
}

export async function apiFetch(
  cfg: Config,
  route: string,
  init: ApiFetchInit = {},
): Promise<ApiFetchResult> {
  const key = resolveApiKey(cfg);
  if (!key) {
    throw new CommandError(
      "No API key. Run `mergestorm login` or set MERGESTORM_API_KEY.",
      1,
      "missing_api_key",
    );
  }
  const { json, timeoutMs = DEFAULT_API_TIMEOUT_MS, signal: userSignal, ...rest } = init;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    ...(rest.headers as Record<string, string> | undefined),
  };
  let body = rest.body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const { signal, dispose } = withRequestSignal(userSignal, timeoutMs);
  let res: Response;
  let text = "";
  try {
    res = await fetch(`${apiBase(cfg)}${route}`, { ...rest, headers, body, signal });
    text = await res.text();
  } catch (err) {
    rethrowFetchAbort(err, timeoutMs);
  } finally {
    dispose();
  }
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep text
  }
  if (res.status === 401) {
    throw new CommandError(
      "API key invalid or revoked. Run `mergestorm login`.",
      1,
      "auth_invalid",
    );
  }
  const retryAfterSeconds = parseRetryAfterSeconds({
    header: res.headers.get("retry-after"),
    body: parsed,
  });
  return {
    status: res.status,
    body: parsed,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

export async function devicePost(
  base: string,
  route: string,
  json: unknown,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ status: number; body: any }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const { signal, dispose } = withRequestSignal(opts.signal, timeoutMs);
  let res: Response;
  let text = "";
  try {
    res = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(json),
      signal,
    });
    text = await res.text();
  } catch (err) {
    rethrowFetchAbort(err, timeoutMs);
  } finally {
    dispose();
  }
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
  /** When the current credit window ends (signup anniversary or Stripe period). Older APIs omit this. */
  resets_at?: string;
  usage: {
    standard: { used: number; limit: number | null; remaining: number | null };
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
  credits: { standard: number } | null;
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
export async function getMe(
  cfg?: Config,
  opts?: { timeoutMs?: number },
): Promise<MeResponse | null> {
  const resolved = cfg ?? (await loadConfig());
  try {
    const { status, body } = await apiFetch(resolved, "/api/v1/me", {
      timeoutMs: opts?.timeoutMs,
    });
    if (status === 404) return null;
    if (status !== 200) return null;
    return body as MeResponse;
  } catch (err) {
    // 401 (and missing-key) must surface — do not misdiagnose as offline/old API.
    // Timeouts degrade like other network failures (banner / soft probes).
    if (err instanceof CommandError) {
      if (err.code === "api_timeout") return null;
      throw err;
    }
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

/** Fetch one review job (Bearer GET /api/v1/reviews/:id). */
export async function getReview(
  jobId: string,
  cfg?: Config,
  opts?: { signal?: AbortSignal },
): Promise<unknown> {
  const resolved = cfg ?? (await loadConfig());
  const id = jobId.trim();
  if (!id) {
    throw new CommandError("job_id is required", 2, "usage");
  }
  const { status, body, retryAfterSeconds } = await apiFetch(
    resolved,
    `/api/v1/reviews/${encodeURIComponent(id)}`,
    { signal: opts?.signal },
  );
  if (status === 404) {
    throw new CommandError(`Review not found: ${id}`);
  }
  if (status === 429) {
    throw new CommandError(
      rateLimitedMessage(retryAfterSeconds),
      REVIEW_EXIT.rate_limited,
      "rate_limited",
      { retryAfterSeconds },
    );
  }
  if (status !== 200) {
    throw new CommandError(`Failed to get review (HTTP ${status}): ${JSON.stringify(body)}`);
  }
  return body;
}

/** List stacks (Bearer GET /api/v1/stacks). */
export async function listStacks(
  cfg?: Config,
  opts?: { timeoutMs?: number },
): Promise<StackDto[]> {
  const resolved = cfg ?? (await loadConfig());
  const { status, body } = await apiFetch(resolved, "/api/v1/stacks", {
    timeoutMs: opts?.timeoutMs,
  });
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

/** Mint or reuse the PR3+ park freeze (Bearer POST /api/v1/stacks/:id/ensure-upper-park). */
export async function ensureUpperPark(
  stackId: string,
  cfg?: Config,
): Promise<{ freezeBranch: string; created: boolean }> {
  const body = await stackMutation(
    stackId,
    "/ensure-upper-park",
    "POST",
    {},
    "Failed to ensure upper-park freeze",
    cfg,
  );
  if (typeof body !== "object" || body === null) {
    throw new CommandError("Unexpected response shape from ensure-upper-park");
  }
  const freezeBranch = (body as { freezeBranch?: unknown }).freezeBranch;
  if (typeof freezeBranch !== "string" || !freezeBranch.trim()) {
    throw new CommandError("ensure-upper-park did not return a freezeBranch");
  }
  return {
    freezeBranch: freezeBranch.trim(),
    created: (body as { created?: unknown }).created === true,
  };
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
