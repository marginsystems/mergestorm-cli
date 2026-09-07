import { apiBase, loadConfig, resolveApiKey, type Config } from "./config.js";
import {
  BEARER_SETTINGS_KEYS as SETTINGS_WRITABLE_KEYS,
  type BearerSettingsKey as SettingsWritableKey,
} from "./automation-catalog.js";
import { CommandError, REVIEW_EXIT, rateLimitedMessage } from "./errors.js";
import type { MergeQueueEntryDto, StackDto } from "./stack-dto.js";

export type {
  MergeQueueBounceDetail,
  MergeQueueBounceKind,
  MergeQueueEnqueuedBy,
  MergeQueueEnqueuedVia,
  MergeQueueEntryDto,
  MergeQueueEntryState,
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
    /** Non-expiring credits spent after the monthly standard pool. */
    bonus?: { remaining: number };
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

export type PrReviewFinding = {
  path?: string;
  line?: number;
  severity: string;
  body: string;
  title?: string;
  specialist?: string;
};

export type PrReviewFindings = {
  specialists_run?: string[];
  inline?: PrReviewFinding[];
  off_diff?: PrReviewFinding[];
  offDiff?: PrReviewFinding[];
  patchPolicy?: unknown;
};

export type PrVortexReview = {
  schema: "mergestorm.pr_review/v1";
  id: string;
  owner: string;
  repo: string;
  pr_number: number;
  status: string;
  raw_status?: string;
  phase: string | null;
  verdict: string | null;
  summary?: string | null;
  head_sha: string | null;
  /** Attempt number on this head (#2027). Absent only from servers older than the pass column. */
  pass?: number;
  review_count: number;
  skip_reason: string | null;
  reviewed_at: string | null;
  finding_count: number;
  findings: PrReviewFindings | null;
  patch_policy: unknown | null;
};

/**
 * Pass selection on the DB-only PR review read (#2027). `pass` names one row;
 * `afterPass` asks for a later pass (`pass > afterPass`) on the SHA filter.
 */
export type PrReviewPassSelector = {
  pass?: number;
  afterPass?: number;
};

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** Append pass selection and SHA filter to a PR review query. */
export function applyPrReviewQuery(
  query: URLSearchParams,
  opts: PrReviewPassSelector & { afterSha?: string },
): void {
  if (opts.afterSha) query.set("after_sha", opts.afterSha);
  if (opts.pass !== undefined) query.set("pass", String(opts.pass));
  if (opts.afterPass !== undefined) query.set("after_pass", String(opts.afterPass));
}

/**
 * Bearer-writable settings keys, mirroring the `/api/v1/settings` allowlist.
 * The connected flags are read-only there and deliberately absent here.
 */
export { SETTINGS_WRITABLE_KEYS };
export type { SettingsWritableKey };

export type SettingsPatch = Partial<Record<SettingsWritableKey, boolean>>;

/** GET and PATCH `/api/v1/settings` both answer with this shape. */
export type SettingsResponse = Record<SettingsWritableKey, boolean> & {
  cyclone_connected: boolean;
  github_connected: boolean;
};

/**
 * Fetch Bearer /api/v1/settings; null on 404/network/timeouts so panels can
 * degrade (same contract as {@link getMe}), while 401 still surfaces.
 */
export async function getSettings(
  cfg?: Config,
  opts?: { timeoutMs?: number },
): Promise<SettingsResponse | null> {
  const resolved = cfg ?? (await loadConfig());
  try {
    const { status, body } = await apiFetch(resolved, "/api/v1/settings", {
      timeoutMs: opts?.timeoutMs,
    });
    if (status !== 200) return null;
    return body as SettingsResponse;
  } catch (err) {
    if (err instanceof CommandError) {
      if (err.code === "api_timeout") return null;
      throw err;
    }
    return null;
  }
}

/**
 * PATCH Bearer /api/v1/settings and return the stored result. Rejections
 * (unknown key, cyclone_not_connected, …) surface the API's own `message`
 * so the CLI never invents a reason.
 */
export async function patchSettings(
  patch: SettingsPatch,
  cfg?: Config,
  opts?: { timeoutMs?: number },
): Promise<SettingsResponse> {
  const resolved = cfg ?? (await loadConfig());
  if (Object.keys(patch).length === 0) {
    throw new CommandError("No settings to update.", 2, "usage");
  }
  const { status, body, retryAfterSeconds } = await apiFetch(resolved, "/api/v1/settings", {
    method: "PATCH",
    json: patch,
    timeoutMs: opts?.timeoutMs,
  });
  if (status === 404) {
    throw new CommandError(
      "Settings API is not available on this server yet. Deploy the API update or use the dashboard.",
    );
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
    const message = (body as { message?: unknown } | null)?.message;
    throw new CommandError(
      typeof message === "string" && message.trim()
        ? message
        : `Failed to update settings (HTTP ${status}): ${JSON.stringify(body)}`,
    );
  }
  return body as SettingsResponse;
}

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

export async function listJobs(
  limit = 10,
  cfg?: Config,
  opts?: { timeoutMs?: number },
): Promise<JobListItem[]> {
  const resolved = cfg ?? (await loadConfig());
  const capped = Math.min(Math.max(limit, 1), 50);
  const { status, body } = await apiFetch(resolved, `/api/v1/reviews?limit=${capped}`, {
    timeoutMs: opts?.timeoutMs,
  });
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
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<unknown> {
  const resolved = cfg ?? (await loadConfig());
  const id = jobId.trim();
  if (!id) {
    throw new CommandError("job_id is required", 2, "usage");
  }
  const { status, body, retryAfterSeconds } = await apiFetch(
    resolved,
    `/api/v1/reviews/${encodeURIComponent(id)}`,
    { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
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

/** Fetch the latest Vortex pass for one GitHub PR. */
export async function getPrVortexReview(
  owner: string,
  repo: string,
  prNumber: number,
  cfg?: Config,
  opts?: { signal?: AbortSignal; timeoutMs?: number; afterSha?: string } & PrReviewPassSelector,
): Promise<PrVortexReview> {
  const resolved = cfg ?? (await loadConfig());
  const cleanOwner = owner.trim();
  const cleanRepo = repo.trim();
  if (!cleanOwner || !cleanRepo || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new CommandError("owner, repo, and a positive pr_number are required", 2, "usage");
  }
  const query = new URLSearchParams({
    owner: cleanOwner,
    repo: cleanRepo,
    pr_number: String(prNumber),
  });
  applyPrReviewQuery(query, opts ?? {});
  const { status, body, retryAfterSeconds } = await apiFetch(
    resolved,
    `/api/v1/stacks/pr-review?${query.toString()}`,
    { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
  );
  if (status === 404) {
    throw new CommandError(
      `Vortex review not found: ${cleanOwner}/${cleanRepo}#${prNumber}`,
      REVIEW_EXIT.failed,
      "not_found",
    );
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
    throw new CommandError(
      `Failed to get PR review (HTTP ${status}): ${JSON.stringify(body)}`,
      REVIEW_EXIT.failed,
      "review_failed",
    );
  }
  return body as PrVortexReview;
}

/** List stacks (Bearer GET /api/v1/stacks). */
export async function listStacks(
  cfg?: Config,
  opts?: { timeoutMs?: number },
): Promise<StackDto[]> {
  const resolved = cfg ?? (await loadConfig());
  const { status, body, retryAfterSeconds } = await apiFetch(resolved, "/api/v1/stacks", {
    timeoutMs: opts?.timeoutMs,
  });
  if (status === 404) {
    throw new CommandError(
      "Stacks API is not available on this server yet. Deploy the API update or use the dashboard.",
    );
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
    throw new CommandError(`Failed to list stacks (HTTP ${status}): ${JSON.stringify(body)}`);
  }
  const stacks = (body as { stacks?: StackDto[] }).stacks;
  return Array.isArray(stacks) ? stacks : [];
}

/** Fetch one owned stack with enriched GitHub checks and agent state. */
export async function getEnrichedStack(
  stackId: string,
  cfg?: Config,
  opts?: { timeoutMs?: number },
): Promise<StackDto | null> {
  const resolved = cfg ?? (await loadConfig());
  const id = stackId.trim();
  if (!id) {
    throw new CommandError("stack_id is required", 2, "usage");
  }
  const { status, body, retryAfterSeconds } = await apiFetch(
    resolved,
    `/api/v1/stacks/enrich?stackId=${encodeURIComponent(id)}`,
    { timeoutMs: opts?.timeoutMs },
  );
  if (status === 404) {
    throw new CommandError(
      "Stack enrichment is not available on this server yet. Deploy the API update or use the dashboard.",
    );
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
    throw new CommandError(`Failed to get stack status (HTTP ${status}): ${JSON.stringify(body)}`);
  }
  const stacks = (body as { stacks?: StackDto[] }).stacks;
  if (!Array.isArray(stacks)) {
    throw new CommandError(`Failed to get stack status (HTTP 200): ${JSON.stringify(body)}`);
  }
  return stacks.find((stack) => stack?.id === id) ?? null;
}

/**
 * Per-stack automation policy. Auto land is a boolean; the review / patch
 * overrides are tri-state (`null` clears back to the account flag). Absent
 * keys are left untouched.
 */
export type StackPolicyPatch = {
  autoEnqueueWhenReady?: boolean;
  autoReviewOverride?: boolean | null;
  autoPatchOverride?: boolean | null;
};

/** Drop undefined keys so the wire body only carries what was requested. */
export function stackPolicyBody(policy: StackPolicyPatch | undefined): StackPolicyPatch {
  const body: StackPolicyPatch = {};
  if (typeof policy?.autoEnqueueWhenReady === "boolean") {
    body.autoEnqueueWhenReady = policy.autoEnqueueWhenReady;
  }
  if (policy?.autoReviewOverride !== undefined) {
    body.autoReviewOverride = policy.autoReviewOverride;
  }
  if (policy?.autoPatchOverride !== undefined) {
    body.autoPatchOverride = policy.autoPatchOverride;
  }
  return body;
}

/** Adopt an open PR chain (Bearer POST /api/v1/stacks/adopt). */
export async function adoptStack(
  owner: string,
  repo: string,
  prNumber: number,
  cfg?: Config,
  policy?: StackPolicyPatch,
): Promise<unknown> {
  const resolved = cfg ?? (await loadConfig());
  const { status, body, retryAfterSeconds } = await apiFetch(resolved, "/api/v1/stacks/adopt", {
    method: "POST",
    json: {
      owner,
      repo,
      prNumber,
      ...stackPolicyBody(policy),
    },
  });
  if (status === 404) {
    throw new CommandError(
      "Stacks API is not available on this server yet. Deploy the API update or use the dashboard.",
    );
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

/** Arm or disarm Auto land on one owned stack. */
export async function setStackAutoLand(
  stackId: string,
  enabled: boolean,
  cfg?: Config,
): Promise<unknown> {
  return setStackPolicy(stackId, { autoEnqueueWhenReady: enabled }, cfg);
}

/**
 * Patch any subset of one owned stack's automation policy
 * (Bearer PATCH /api/v1/stacks/:id). `null` clears an override.
 */
export async function setStackPolicy(
  stackId: string,
  policy: StackPolicyPatch,
  cfg?: Config,
): Promise<unknown> {
  const json = stackPolicyBody(policy);
  if (Object.keys(json).length === 0) {
    throw new CommandError("setStackPolicy needs at least one policy key");
  }
  return stackMutation(stackId, "", "PATCH", json, "Failed to set stack policy", cfg);
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

/** List the authenticated user's live merge-queue entries. */
export async function listMergeQueueEntries(
  cfg?: Config,
): Promise<MergeQueueEntryDto[]> {
  const resolved = cfg ?? (await loadConfig());
  const { status, body } = await apiFetch(resolved, "/api/v1/stacks/queue");
  if (status === 404) {
    throw new CommandError(
      "Merge queue API is not available on this server yet. Deploy the API update or use the dashboard.",
    );
  }
  if (status !== 200) {
    throw new CommandError(
      `Failed to list merge queue (HTTP ${status}): ${JSON.stringify(body)}`,
    );
  }
  const entries = (body as { entries?: MergeQueueEntryDto[] }).entries;
  if (!Array.isArray(entries)) {
    throw new CommandError(
      `Failed to list merge queue (HTTP 200): ${JSON.stringify(body)}`,
    );
  }
  return entries;
}

async function queueMutation(
  route: string,
  failLabel: string,
  cfg?: Config,
): Promise<unknown> {
  const resolved = cfg ?? (await loadConfig());
  const { status, body } = await apiFetch(resolved, route, {
    method: "POST",
    json: {},
  });
  if (status === 404) {
    const error = (body as { error?: unknown } | null)?.error;
    if (error === "stack_not_found") {
      throw new CommandError("Stack not found");
    }
    if (error === "entry_not_found") {
      throw new CommandError("Merge queue entry not found");
    }
    throw new CommandError(
      "Merge queue API is not available on this server yet. Deploy the API update or use the dashboard.",
    );
  }
  if (status < 200 || status >= 300) {
    throw new CommandError(`${failLabel} (HTTP ${status}): ${JSON.stringify(body)}`);
  }
  return body;
}

/** Enqueue a stack for verified landing. */
export async function enqueueStack(
  stackId: string,
  cfg?: Config,
): Promise<unknown> {
  return queueMutation(
    `/api/v1/stacks/${encodeURIComponent(stackId)}/enqueue`,
    "Failed to add stack to merge queue",
    cfg,
  );
}

/** Cancel a live merge-queue entry by entry id. */
export async function cancelMergeQueueEntry(
  entryId: string,
  cfg?: Config,
): Promise<unknown> {
  return queueMutation(
    `/api/v1/stacks/queue/${encodeURIComponent(entryId)}/cancel`,
    "Failed to remove merge queue entry",
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
