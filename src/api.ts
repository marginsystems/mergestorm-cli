import { apiBase, loadConfig, resolveApiKey, resolveChatId, type Config } from "./config.js";
import {
  BEARER_SETTINGS_KEYS as SETTINGS_WRITABLE_KEYS,
} from "./automation-catalog.js";
import {
  CommandError,
  REVIEW_EXIT,
  rateLimitedMessage,
  type CommandErrorCode,
  plainServerText,
} from "./errors.js";
import type { MergeQueueEntryDto, StackDto } from "./stack-dto.js";

export type {
  MergeQueueBounceDetail,
  MergeQueueBounceKind,
  MergeQueueEnqueuedBy,
  MergeQueueEnqueuedVia,
  MergeQueueEntryDto,
  MergeQueueEntryState,
  StackDto,
  StackLayerDto,
} from "./stack-dto.js";

/** Default per-request timeout so a hung API cannot stall the shell/CI forever. */
export const DEFAULT_API_TIMEOUT_MS = 30_000;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
  }, Math.min(timeoutMs, MAX_TIMER_DELAY_MS));

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
      "No API key. Run `mergestorm login` (agents: `mergestorm login --start`, then `--finish`) or set MERGESTORM_API_KEY.",
      1,
      "missing_api_key",
    );
  }
  const { json, timeoutMs = DEFAULT_API_TIMEOUT_MS, signal: userSignal, ...rest } = init;
  const chatId = resolveChatId(cfg);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    ...(chatId ? { "x-mergestorm-chat-id": chatId } : {}),
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
      "API key invalid or revoked. Run `mergestorm login` (agents: `mergestorm login --start`, then `--finish`).",
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

type SurgeUsage = {
  includedMinutes: number;
  usedMinutes: number;
  walletMinutes: number;
  windowStart: string;
  pricePerMinuteUsd: number;
};

export type AccountIdentity = { github_login: string | null; email: string | null };

export function accountLabel(account: AccountIdentity | null | undefined): string | null {
  const login = account?.github_login?.trim();
  if (login) return login;
  const email = account?.email?.trim();
  return email || null;
}

export type MeResponse = {
  account?: AccountIdentity;
  key: { prefix: string; name: string; created_at: string; last_used_at: string | null };
  plan_key: string;
  plan_label_key?: string;
  /** When the current credit window ends (signup anniversary or Stripe period). Older APIs omit this. */
  resets_at?: string;
  usage: {
    standard: { used: number; limit: number | null; remaining: number | null };
    /** Non-expiring credits spent after the monthly standard pool. */
    bonus?: { remaining: number };
    surge?: SurgeUsage;
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
  dismissed_findings?: Array<{
    path: string;
    line: number;
    title: string;
    severity: string;
    finding_key: string;
    github_comment_id: number | null;
  }>;
  patch_policy: unknown | null;
  /**
   * MS-01: True when the returned row is a resting completion but a newer
   * attempt is in flight (active lease). The CLI must continue polling.
   */
  newer_pass_pending?: boolean;
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

export type SettingsPatch = Partial<import("./automation-catalog.js").BearerSettingsValues>;

/** GET and PATCH `/api/v1/settings` both answer with this shape. */
export type SettingsResponse = import("./automation-catalog.js").BearerSettingsValues & {
  cyclone_connected: boolean;
  github_connected: boolean;
  stacks_ready?: boolean;
};

export const REPO_SETTINGS_SWITCH_KEYS = [
  "auto_patch_enabled",
  "auto_review_enabled",
  "auto_land_default",
  "merge_queue_batch_enabled",
  "merge_queue_overdrive",
  "issue_review_enabled",
  "issue_auto_review_enabled",
] as const;

export const REPO_SETTINGS_KEYS = [...REPO_SETTINGS_SWITCH_KEYS, "merge_queue_batch_size", "merge_queue_lands_alone_paths"] as const;

export type RepoSettingsKey = (typeof REPO_SETTINGS_KEYS)[number];

type RepoSettingsValues = Record<(typeof REPO_SETTINGS_SWITCH_KEYS)[number], boolean | null> & {
  merge_queue_batch_size: number | null;
  merge_queue_lands_alone_paths: string[] | null;
};

export type RepoSettings = { owner: string; repo: string } & RepoSettingsValues;

export type RepoSettingsPatch = Partial<RepoSettingsValues>;

function repoSettingsFailure(status: number, body: unknown, retryAfterSeconds: number | undefined, action: string): CommandError {
  if (status === 429) {
    return new CommandError(rateLimitedMessage(retryAfterSeconds), REVIEW_EXIT.rate_limited, "rate_limited", {
      retryAfterSeconds,
    });
  }
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.trim()) return new CommandError(message);
  if (status === 404) {
    return new CommandError(
      "Repository settings are not available on this server yet. Deploy the API update or use the dashboard.",
    );
  }
  return new CommandError(`Failed to ${action} repository settings (HTTP ${status}): ${JSON.stringify(body)}`);
}

export async function listRepoSettings(cfg?: Config, opts?: { timeoutMs?: number }): Promise<RepoSettings[]> {
  const resolved = cfg ?? (await loadConfig());
  const { status, body, retryAfterSeconds } = await apiFetch(resolved, "/api/v1/settings/repos", {
    timeoutMs: opts?.timeoutMs,
  });
  if (status !== 200) throw repoSettingsFailure(status, body, retryAfterSeconds, "load");
  const repos = (body as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(repos)) {
    throw new CommandError(`Repository settings came back in an unexpected shape: ${JSON.stringify(body)}`);
  }
  return repos as RepoSettings[];
}

export async function patchRepoSettings(
  owner: string,
  repo: string,
  patch: RepoSettingsPatch,
  cfg?: Config,
  opts?: { timeoutMs?: number },
): Promise<RepoSettings> {
  const resolved = cfg ?? (await loadConfig());
  if (Object.keys(patch).length === 0) {
    throw new CommandError("No repository settings to update.", 2, "usage");
  }
  const { status, body, retryAfterSeconds } = await apiFetch(
    resolved,
    `/api/v1/settings/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { method: "PATCH", json: patch, timeoutMs: opts?.timeoutMs },
  );
  if (status !== 200) throw repoSettingsFailure(status, body, retryAfterSeconds, "update");
  return body as RepoSettings;
}

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

export async function revokeOwnKey(
  cfg: Config,
  opts?: { timeoutMs?: number },
): Promise<boolean> {
  try {
    const { status } = await apiFetch(cfg, "/api/v1/me/key", {
      method: "DELETE",
      timeoutMs: opts?.timeoutMs,
    });
    return status === 200;
  } catch (err) {
    if (err instanceof CommandError) return err.code === "auth_invalid";
    return false;
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
  return stacks.find((stack) => typeof stack?.id === "string" && stack.id.trim().toLowerCase() === id.toLowerCase()) ?? null;
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
  autoResolveConflictsOverride?: boolean | null;
  autoFixCiOverride?: boolean | null;
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
  if (policy?.autoResolveConflictsOverride !== undefined) {
    body.autoResolveConflictsOverride = policy.autoResolveConflictsOverride;
  }
  if (policy?.autoFixCiOverride !== undefined) {
    body.autoFixCiOverride = policy.autoFixCiOverride;
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
  const issueRefusal = issueNotApprovedRefusal(status, body, owner, repo);
  if (issueRefusal) throw issueRefusal;
  if (status !== 200) {
    const error =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : undefined;
    const message =
      body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : undefined;
    const code: CommandErrorCode | undefined =
      error === "cyclone_not_installed" ||
      error === "pr_merged" ||
      error === "pr_closed" ||
      error === "not_stacked" ||
      error === "draft" ||
      error === "reserved_branch" ||
      error === "supabase_unconfigured" ||
      error === "cyclone_not_connected" ||
      error === "busy" ||
      error === "adopt_failed"
        ? error
        : undefined;
    const fallbackMessage =
      code === "not_stacked"
        ? "This pull request is not part of a stack."
        : code === "supabase_unconfigured"
          ? "Stacks are not configured on this server."
          : undefined;
    const surge = surgeRefusal(body);
    if (surge) throw surge;
    throw new CommandError(
      message?.trim()
        ? message
        : fallbackMessage ?? `Failed to import stack (HTTP ${status}): ${JSON.stringify(body)}`,
      1,
      code,
    );
  }
  return body;
}

const INFRASTRUCTURE_REFUSAL_CODES = [
  "cyclone_not_connected",
  "cyclone_not_installed",
  "cyclone_permission_missing",
  "surge_other_account",
] as const;

function refusalReason(body: unknown): string | undefined {
  const reason = (body && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined);
  return typeof reason === "string" && plainServerText(reason).trim() ? plainServerText(reason).trim() : undefined;
}

const SURGE_REFUSAL_FALLBACK =
  "Mergestorm Surge is not installed or not ready on this repository. Install it from Agents.";

function surgeRefusal(body: unknown): CommandError | null {
  if (!body || typeof body !== "object") return null;
  const refusal = body as { error?: unknown; message?: unknown; installUrl?: unknown };
  const reason = refusalReason(body);
  if (!reason?.startsWith("surge_")) return null;
  const error = INFRASTRUCTURE_REFUSAL_CODES.find((code) => code === refusal.error);
  if (!error) return null;
  const message = serverMessage(refusal.message) ?? SURGE_REFUSAL_FALLBACK;
  const installUrl = githubAppInstallUrl(refusal.installUrl) ?? "";
  return new CommandError(
    installUrl && !message.includes(installUrl) ? `${message} (${installUrl})` : message,
    1,
    error,
    { reason },
  );
}

const GITHUB_UNREADABLE_MESSAGE = "GitHub could not be read just now; try again.";

function serverMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const plain = plainServerText(message).trim();
  return plain ? plain : null;
}

const GITHUB_APP_INSTALL_URL = /https:\/\/github\.com\/apps\/[^\s)]+\/installations\/new/;

function githubAppInstallUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = GITHUB_APP_INSTALL_URL.exec(plainServerText(value).trim());
  return match && match.index === 0 ? match[0] : null;
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

const SURGE_INSTALL_URL = "https://github.com/apps/mergestorm-surge/installations/new";

function surgeNotInstalledMessage(owner: string, repo: string, installUrl = SURGE_INSTALL_URL): string {
  return (
    `Opening PRs needs either the GitHub CLI (gh auth login) or Mergestorm Surge installed on ` +
    `${owner}/${repo} (${installUrl}).`
  );
}

function installUrlFrom(message: unknown): string {
  if (typeof message !== "string") return SURGE_INSTALL_URL;
  return message.match(GITHUB_APP_INSTALL_URL)?.[0] ?? SURGE_INSTALL_URL;
}

function stackPullFailure(
  status: number,
  body: unknown,
  owner: string,
  repo: string,
  failLabel: string,
): CommandError {
  const rejection = (body && typeof body === "object" ? body : {}) as {
    error?: unknown;
    message?: unknown;
  };
  const surge = surgeRefusal(body);
  if (surge) return surge;
  const issueRefusal = issueNotApprovedRefusal(status, body, owner, repo);
  if (issueRefusal) return issueRefusal;
  const text = `${String(rejection.error ?? "")} ${String(rejection.message ?? "")}`;
  if (
    rejection.error === "cyclone_not_installed" ||
    /not installed|installation[^\n]*not found/i.test(text)
  ) {
    return new CommandError(
      surgeNotInstalledMessage(owner, repo, installUrlFrom(rejection.message)),
      1,
      "cyclone_not_installed",
    );
  }
  if (status === 404) {
    return new CommandError(
      "Stacks API cannot open PRs on this server yet. Install the GitHub CLI (gh auth login) and retry.",
    );
  }
  const detail = typeof rejection.message === "string" ? rejection.message : JSON.stringify(body);
  return new CommandError(`${failLabel} (HTTP ${status}): ${detail}`);
}

export class LandedQueueReadError extends CommandError {
  constructor(public readonly status: number, public readonly retryAfterSeconds?: number) {
    super(`Failed to read the landed merge queue entry (HTTP ${status})`);
  }
}

export async function readLandedQueueEntry(
  cfg: Config,
  stackId: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MergeQueueEntryDto | null> {
  const { status, body, retryAfterSeconds } = await apiFetch(cfg, `/api/v1/stacks/queue?stackId=${encodeURIComponent(stackId)}&landed=1`, opts);
  if (status !== 200) throw new LandedQueueReadError(status, retryAfterSeconds);
  const landed = (body as { landed?: MergeQueueEntryDto | null } | null)?.landed;
  return landed && landed.state === "landed" ? landed : null;
}

export async function findStackPull(
  cfg: Config,
  input: { owner: string; repo: string; head: string },
): Promise<number | null> {
  const query = new URLSearchParams(input).toString();
  const { status, body } = await apiFetch(cfg, `/api/v1/stacks/pulls?${query}`);
  if (status !== 200) {
    throw stackPullFailure(status, body, input.owner, input.repo, `Failed to look up the PR for ${input.head}`);
  }
  const n = (body as { number?: unknown } | null)?.number;
  return typeof n === "number" && n > 0 ? n : null;
}

export async function claimStackPulls(
  cfg: Config,
  input: { owner: string; repo: string; heads: string[] },
): Promise<void> {
  const { status, body } = await apiFetch(cfg, "/api/v1/stacks/pull-claims", {
    method: "POST",
    json: input,
  });
  if (status !== 200) {
    const detail = (body as { error?: unknown; message?: unknown } | null)?.message
      ?? (body as { error?: unknown } | null)?.error
      ?? `HTTP ${status}`;
    throw new CommandError(`Could not claim ${input.heads.join(", ")}: ${String(detail)}`);
  }
}

export async function openStackPull(
  cfg: Config,
  input: { owner: string; repo: string; head: string; base: string; title: string; body: string },
): Promise<{ number: number; url: string; created: boolean }> {
  const { status, body } = await apiFetch(cfg, "/api/v1/stacks/pulls", {
    method: "POST",
    json: input,
  });
  if (status !== 200 && status !== 201) {
    throw stackPullFailure(status, body, input.owner, input.repo, `Failed to open PR ${input.head} → ${input.base}`);
  }
  const row = (body ?? {}) as { number?: unknown; url?: unknown; created?: unknown };
  if (typeof row.number !== "number" || row.number <= 0) {
    throw new CommandError(`Failed to open PR ${input.head} → ${input.base}: no pull request number returned`);
  }
  return {
    number: row.number,
    url: typeof row.url === "string" ? row.url : "",
    created: row.created === true,
  };
}

export type StackPublicationIdentity = { name: string; email: string; date: string };

export type StackPublicationChange =
  | { path: string; deleted: true }
  | { path: string; mode: "100644" | "100755" | "120000"; sha: string; content: string };

export type StackPublicationCommit = {
  message: string;
  author: StackPublicationIdentity;
  committer: StackPublicationIdentity;
  tree: string;
  changes: StackPublicationChange[];
};

export type StackPublicationRequest = {
  owner: string;
  repo: string;
  branch: string;
  base: { branch: string; sha: string };
  expectedHead: string | null;
  onto: "base" | "head";
  commits: StackPublicationCommit[];
  pr: { title: string; body: string };
  autoLand?: boolean;
};

type StackPublicationStack = { id: string; autoPatchOverride: boolean | null; autoLand: boolean };

export type StackPublicationStatus = {
  state: "absent" | "pushed" | "opened" | "registered";
  owner: string;
  repo: string;
  branch: string;
  head: { sha: string; tree: string | null } | null;
  pr: { number: number; url: string; base: string } | null;
  stack: StackPublicationStack | null;
};

export type StackPublication = {
  state: "registered";
  owner: string;
  repo: string;
  branch: string;
  base: { branch: string; sha: string };
  head: { sha: string; tree: string };
  commits: Array<{ sha: string; tree: string }>;
  branchCreated: boolean;
  branchUpdated: boolean;
  pr: { number: number; url: string; created: boolean };
  stack: StackPublicationStack;
};

const STACK_PUBLICATION_TIMEOUT_MS = 180_000;

const PUBLICATION_ERROR_CODES: readonly CommandErrorCode[] = [
  "head_changed",
  "base_changed",
  "tree_mismatch",
  "protected_branch",
  "payload_too_large",
  "rate_limited",
];

function stackPublicationFailure(
  status: number,
  body: unknown,
  owner: string,
  repo: string,
  failLabel: string,
  retryAfterSeconds?: number,
): CommandError {
  const rejection = (body && typeof body === "object" ? body : {}) as { error?: unknown; state?: unknown };
  if (status === 404) {
    return new CommandError(
      "This Mergestorm server does not publish branches server-side yet.",
      1,
      "publication_failed",
    );
  }
  const code = PUBLICATION_ERROR_CODES.find((known) => known === rejection.error);
  if (!code) {
    const failure = stackPullFailure(status, body, owner, repo, failLabel);
    if (failure.code) return failure;
    const reached = typeof rejection.state === "string" ? ` Reached state: ${rejection.state}. Run the same command again to resume.` : "";
    return new CommandError(`${failure.message}${reached}`, 1, "publication_failed");
  }
  const message = serverMessage((body as { message?: unknown }).message) ?? `${failLabel} (HTTP ${status})`;
  return new CommandError(message, 1, code, retryAfterSeconds !== undefined ? { retryAfterSeconds } : undefined);
}

export async function getStackPublication(
  cfg: Config,
  input: { owner: string; repo: string; branch: string },
): Promise<StackPublicationStatus> {
  const query = new URLSearchParams(input).toString();
  const { status, body, retryAfterSeconds } = await apiFetch(cfg, `/api/v1/stacks/publications?${query}`);
  if (status !== 200) {
    throw stackPublicationFailure(status, body, input.owner, input.repo, `Failed to read the publication of ${input.branch}`, retryAfterSeconds);
  }
  return body as StackPublicationStatus;
}

export async function submitStackPublication(
  cfg: Config,
  request: StackPublicationRequest,
): Promise<StackPublication> {
  const { status, body, retryAfterSeconds } = await apiFetch(cfg, "/api/v1/stacks/publications", {
    method: "POST",
    json: request,
    timeoutMs: STACK_PUBLICATION_TIMEOUT_MS,
  });
  const publication = body as Partial<StackPublication> | null;
  if ((status !== 200 && status !== 201) || publication?.state !== "registered" || !publication.head || !publication.pr || !publication.stack) {
    throw stackPublicationFailure(status, body, request.owner, request.repo, `Failed to publish ${request.branch}`, retryAfterSeconds);
  }
  return publication as StackPublication;
}

export async function openStackIssue(
  input: { owner: string; repo: string; title: string; body: string; labels: string[] },
  cfg?: Config,
): Promise<{ number: number; url: string; created: boolean }> {
  const { status, body, retryAfterSeconds } = await apiFetch(cfg ?? (await loadConfig()), "/api/v1/stacks/issues", { method: "POST", json: input });
  const row = (body ?? {}) as { number?: unknown; url?: unknown; created?: unknown; error?: unknown; message?: unknown };
  if ((status !== 200 && status !== 201) || typeof row.number !== "number" || row.number <= 0) {
    if (status === 404) {
      throw new CommandError("This Mergestorm server does not open issues yet.", 1, "publication_failed");
    }
    if (status === 429 || row.error === "rate_limited") {
      throw new CommandError(rateLimitedMessage(retryAfterSeconds), REVIEW_EXIT.rate_limited, "rate_limited", retryAfterSeconds !== undefined ? { retryAfterSeconds } : undefined);
    }
    if (row.error === "unknown_label") {
      throw new CommandError(typeof row.message === "string" ? row.message : "Unknown label", 1, "unknown_label");
    }
    throw stackPullFailure(status, body, input.owner, input.repo, `Failed to open the issue on ${input.owner}/${input.repo}`);
  }
  return { number: row.number, url: typeof row.url === "string" ? row.url : "", created: row.created === true };
}

export const ISSUE_REVIEW_STATES = ["approved", "needs_answers", "pending", "unreviewed", "capped", "off"] as const;

export type IssueReviewState = (typeof ISSUE_REVIEW_STATES)[number];

export type IssueReviewPoint = { kind: string; text: string; blocking?: boolean };

export const ISSUE_REVIEW_MODES = ["off", "mention", "auto"] as const;

export type IssueReviewMode = (typeof ISSUE_REVIEW_MODES)[number];

export const ISSUE_REVIEW_TAG = "@mergestorm-vortex";

export type IssueReviewStatus = {
  owner: string;
  repo: string;
  number: number;
  enabled: boolean;
  mode: IssueReviewMode;
  state: IssueReviewState;
  approvedBy: "vortex" | "human" | null;
  round: number | null;
  maxRounds: number;
  verdict: "ready" | "ready_with_notes" | "needs_answers" | null;
  summary: string | null;
  points: IssueReviewPoint[];
  commentUrl: string | null;
  next: string;
  wait: IssueReviewWait;
};

export const ISSUE_REVIEW_WAIT_STATUSES = ["answered_waiting_for_round", "round_running", "points", "approved", "stalled"] as const;

export type IssueReviewWaitStatus = (typeof ISSUE_REVIEW_WAIT_STATUSES)[number];

export type IssueReviewWait = {
  status: IssueReviewWaitStatus;
  reason: string;
  verdictRound: number | null;
  verdictAt: string | null;
  answeredAt: string | null;
  retryAt: string | null;
  minutes: number | null;
};

export type IssueReviewTarget = { owner: string; repo: string; number: number };

export const ISSUE_REVIEW_POLL_INTERVAL_MS = 10_000;
export const ISSUE_REVIEW_DEFAULT_TIMEOUT_MS = 900_000;
export const ISSUE_REVIEW_STALL_MS = 10 * 60_000;
const ISSUE_REVIEW_MAX_POINTS = 8;
const ISSUE_REVIEW_DEFAULT_MAX_ROUNDS = 2;

function issueReviewText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const plain = plainServerText(value).trim();
  return plain ? plain : null;
}

function nullableIso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function legacyIssueReviewWait(state: IssueReviewState, mode: IssueReviewMode, round: number | null, verdict: IssueReviewStatus["verdict"]): IssueReviewWait {
  const status: IssueReviewWaitStatus =
    state === "approved" || state === "off" || (state === "unreviewed" && mode !== "auto")
      ? "approved"
      : state === "needs_answers"
        ? "points"
        : state === "unreviewed" || state === "capped"
          ? "stalled"
          : "round_running";
  return { status, reason: status === "stalled" && state === "unreviewed" ? "no_review_started" : state, verdictRound: verdict ? round : null, verdictAt: null, answeredAt: null, retryAt: null, minutes: null };
}

export function parseIssueReviewWait(raw: unknown): IssueReviewWait | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const status = ISSUE_REVIEW_WAIT_STATUSES.find((known) => known === row.status);
  if (!status) return null;
  return {
    status,
    reason: issueReviewText(row.reason) ?? status,
    verdictRound: isPositiveInteger(row.verdictRound) ? row.verdictRound : null,
    verdictAt: nullableIso(row.verdictAt),
    answeredAt: nullableIso(row.answeredAt),
    retryAt: nullableIso(row.retryAt),
    minutes: typeof row.minutes === "number" && Number.isInteger(row.minutes) && row.minutes >= 0 ? row.minutes : null,
  };
}

export function parseIssueReviewStatus(body: unknown, target: IssueReviewTarget): IssueReviewStatus | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  const state = ISSUE_REVIEW_STATES.find((known) => known === row.state);
  if (!state) return null;
  const points = Array.isArray(row.points)
    ? row.points
      .flatMap((point): IssueReviewPoint[] => {
        const text = issueReviewText((point as { text?: unknown } | null)?.text);
        if (!text) return [];
        return [{ kind: issueReviewText((point as { kind?: unknown }).kind) ?? "note", text, blocking: (point as { blocking?: unknown }).blocking !== false }];
      })
      .slice(0, ISSUE_REVIEW_MAX_POINTS)
    : [];
  const verdict = row.verdict === "ready" || row.verdict === "ready_with_notes" || row.verdict === "needs_answers" ? row.verdict : null;
  const mode = ISSUE_REVIEW_MODES.find((known) => known === row.mode) ?? (row.enabled === true ? "auto" : "off");
  const round = isPositiveInteger(row.round) ? row.round : null;
  return {
    owner: typeof row.owner === "string" && row.owner ? row.owner : target.owner,
    repo: typeof row.repo === "string" && row.repo ? row.repo : target.repo,
    number: isPositiveInteger(row.number) ? row.number : target.number,
    enabled: row.enabled === true,
    mode,
    state,
    approvedBy: row.approvedBy === "vortex" || row.approvedBy === "human" ? row.approvedBy : null,
    round,
    maxRounds: isPositiveInteger(row.maxRounds) ? row.maxRounds : ISSUE_REVIEW_DEFAULT_MAX_ROUNDS,
    verdict,
    summary: issueReviewText(row.summary),
    points,
    commentUrl: issueReviewText(row.commentUrl),
    next: issueReviewText(row.next) ?? "",
    wait: parseIssueReviewWait(row.wait) ?? legacyIssueReviewWait(state, mode, round, verdict),
  };
}

export const ISSUE_REVIEW_ANSWER_GRACE_MS = 2 * 60_000;

export type IssueReviewCursor = { afterRound?: number | null; waitedMs: number; nowMs?: number };

export function issueReviewWaitAfter(status: IssueReviewStatus, cursor: IssueReviewCursor): IssueReviewWait {
  const wait = status.wait;
  if (wait.status === "stalled" && wait.reason === "no_review_started") {
    if (cursor.waitedMs < ISSUE_REVIEW_STALL_MS) return { ...wait, status: "round_running", reason: "first_round_not_queued" };
    return { ...wait, minutes: Math.floor(cursor.waitedMs / 60_000) };
  }
  if (wait.status !== "points" || cursor.afterRound == null) return wait;
  if ((wait.verdictRound ?? status.round ?? 0) > cursor.afterRound) return wait;
  const verdictAt = Date.parse(wait.verdictAt ?? "");
  const sinceVerdict = Number.isFinite(verdictAt) && cursor.nowMs !== undefined ? cursor.nowMs - verdictAt : cursor.waitedMs;
  const minutes = Math.max(0, Math.floor(sinceVerdict / 60_000));
  if (cursor.waitedMs >= ISSUE_REVIEW_ANSWER_GRACE_MS && sinceVerdict >= ISSUE_REVIEW_STALL_MS) return { ...wait, status: "stalled", reason: "no_answer_seen", minutes };
  return { ...wait, status: "answered_waiting_for_round", reason: "answer_not_seen", minutes };
}

export function issueReviewWaitSettled(wait: IssueReviewWait): boolean {
  return wait.status === "approved" || wait.status === "points" || wait.status === "stalled";
}

export async function getIssueReview(
  cfg: Config,
  target: IssueReviewTarget,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<IssueReviewStatus | null> {
  const query = new URLSearchParams({ owner: target.owner, repo: target.repo }).toString();
  const { status, body, retryAfterSeconds } = await apiFetch(
    cfg,
    `/api/v1/stacks/issues/${encodeURIComponent(String(target.number))}/review?${query}`,
    opts,
  );
  if (status === 404) {
    const message = serverMessage((body as { message?: unknown } | null)?.message);
    if (!message) return null;
    throw new CommandError(`${message} Connect it in Mergestorm, then try again.`, 1, "not_found");
  }
  if (status === 429) {
    throw new CommandError(
      rateLimitedMessage(retryAfterSeconds),
      REVIEW_EXIT.rate_limited,
      "rate_limited",
      retryAfterSeconds !== undefined ? { retryAfterSeconds } : undefined,
    );
  }
  const parsed = status === 200 ? parseIssueReviewStatus(body, target) : null;
  if (!parsed) {
    const message = serverMessage((body as { message?: unknown } | null)?.message);
    throw new CommandError(
      message ?? `Failed to read the issue review of ${target.owner}/${target.repo}#${target.number} (HTTP ${status})`,
      1,
      status >= 500 ? "issue_review_unavailable" : undefined,
    );
  }
  return parsed;
}

export async function getIssueReviewMode(
  cfg: Config,
  target: { owner: string; repo: string },
  opts: { timeoutMs?: number } = {},
): Promise<IssueReviewMode | null> {
  const query = new URLSearchParams({ owner: target.owner, repo: target.repo }).toString();
  const { status, body, retryAfterSeconds } = await apiFetch(cfg, `/api/v1/stacks/issues/review-mode?${query}`, opts);
  if (status === 404) return null;
  if (status === 429) {
    throw new CommandError(
      rateLimitedMessage(retryAfterSeconds),
      REVIEW_EXIT.rate_limited,
      "rate_limited",
      retryAfterSeconds !== undefined ? { retryAfterSeconds } : undefined,
    );
  }
  const mode = status === 200 ? ISSUE_REVIEW_MODES.find((known) => known === (body as { mode?: unknown } | null)?.mode) : undefined;
  if (!mode) {
    const message = serverMessage((body as { message?: unknown } | null)?.message);
    throw new CommandError(message ?? `Failed to read the issue review mode of ${target.owner}/${target.repo} (HTTP ${status})`);
  }
  return mode;
}

export function issueReviewBlocksPr(status: IssueReviewStatus): boolean {
  return status.mode === "auto" && status.state !== "approved" && status.state !== "off";
}

export class IssueReviewTimeoutError extends CommandError {
  readonly lastStatus: IssueReviewStatus;

  constructor(lastStatus: IssueReviewStatus, waitingSince?: number) {
    super(
      `Timed out waiting for the Vortex review of ${lastStatus.owner}/${lastStatus.repo}#${lastStatus.number}. Run \`${issueReviewWaitCommand(lastStatus, waitingSince)}\` once more; do not poll GitHub meanwhile.`,
      REVIEW_EXIT.timeout,
      "review_timeout",
    );
    this.name = "IssueReviewTimeoutError";
    this.lastStatus = lastStatus;
  }
}

export type PollIssueReviewOptions = {
  afterRound?: number | null;
  waitingSince?: number;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onTick?: (status: IssueReviewStatus | null) => void;
};

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortError = () => Object.assign(new Error("Aborted"), { name: "AbortError" });
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isTransientIssueReviewError(err: unknown): boolean {
  if (!(err instanceof Error) || err.name === "AbortError") return false;
  if (err instanceof CommandError) {
    return err.code === "api_timeout" || err.code === "issue_review_unavailable" || err.code === "rate_limited";
  }
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(err.message);
}

export async function pollIssueReview(
  cfg: Config,
  target: IssueReviewTarget,
  opts: PollIssueReviewOptions = {},
): Promise<IssueReviewStatus | null> {
  const timeoutMs = opts.timeoutMs ?? ISSUE_REVIEW_DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? ISSUE_REVIEW_POLL_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? abortableSleep;
  const deadline = now() + timeoutMs;
  const started = Math.min(opts.waitingSince ?? now(), now());
  let last: IssueReviewStatus | null = null;
  let failure: unknown = null;
  for (;;) {
    try {
      const read = await getIssueReview(cfg, target, { signal: opts.signal, timeoutMs: Math.max(1, deadline - now()) });
      if (!read) return read;
      const status = { ...read, wait: issueReviewWaitAfter(read, { afterRound: opts.afterRound, waitedMs: now() - started, nowMs: now() }) };
      if (issueReviewWaitSettled(status.wait)) return status;
      last = status;
      opts.onTick?.(status);
    } catch (err) {
      if (!isTransientIssueReviewError(err)) throw err;
      failure = err;
      opts.onTick?.(null);
    }
    if (now() >= deadline) {
      if (last) throw new IssueReviewTimeoutError(last, started);
      throw failure;
    }
    await wait(Math.min(intervalMs, deadline - now()), opts.signal);
  }
}

export function issueReviewWaitCommand(status: IssueReviewStatus, waitingSince?: number): string {
  const after = status.wait.verdictRound ?? (status.verdict ? status.round : null);
  const since = waitingSince !== undefined ? ` --waiting-since ${Math.floor(waitingSince)}` : "";
  return `mergestorm issue wait ${status.number} --repo ${status.owner}/${status.repo}${after ? ` --after-round ${after}` : ""}${since}`;
}

export function issueReviewWaitLine(status: IssueReviewStatus): string | null {
  const wait = status.wait;
  const issue = `#${status.number}`;
  const since = wait.minutes !== null ? ` ${wait.minutes} min` : "";
  switch (wait.status) {
    case "answered_waiting_for_round":
      return wait.reason === "answer_not_seen"
        ? `Waiting for the round after round ${wait.verdictRound ?? status.round}; Vortex has not seen an answer yet.`
        : `Vortex has the answer on ${issue}; the next round starts${wait.retryAt ? ` at ${wait.retryAt}` : " shortly"}.`;
    case "round_running":
      return `Vortex is running a round on ${issue}${since ? ` (started${since} ago)` : ""}.`;
    case "stalled":
      return `Stalled: no new round on ${issue}${since ? ` after${since}` : ""} (reason: ${wait.reason}). ${issueReviewStallAdvice(wait.reason, status.mode)}`;
    default:
      return null;
  }
}

export function issueReviewStallAdvice(reason: string, mode?: IssueReviewMode): string {
  switch (reason) {
    case "no_answer_seen":
      return `Vortex saw no answer after the last verdict. Reply in one comment on the issue${mode === "mention" ? ` that tags ${ISSUE_REVIEW_TAG}` : ""}, then wait once more; do not poll.`;
    case "commenter_not_allowed":
      return `The answer came from someone who is neither the issue author nor a maintainer, so it starts no round. Tell the human.`;
    case "unchanged":
      return `Vortex found nothing new since its last round. Answer each blocking point in one comment, then wait once more.`;
    default:
      return `Tag ${ISSUE_REVIEW_TAG} once in a comment on the issue, or tell the human; do not poll.`;
  }
}

export function issueReviewLines(status: IssueReviewStatus): string[] {
  const round = status.round ? ` (round ${status.round} of ${status.maxRounds})` : "";
  const lines = [`${status.owner}/${status.repo}#${status.number}: ${status.state}${round}`];
  const waitLine = issueReviewWaitLine(status);
  if (waitLine) lines.push(`  ${waitLine}`);
  if (status.summary) lines.push(`  ${status.summary}`);
  status.points.forEach((point, i) => lines.push(`  ${i + 1}. [${point.blocking === false ? "note: " : ""}${point.kind}] ${point.text}`));
  if (status.commentUrl) lines.push(`  Review: ${status.commentUrl}`);
  if (status.next) lines.push(`  Next: ${status.next}`);
  return lines;
}

export function issueNotApprovedError(issues: IssueReviewStatus[], message?: string | null): CommandError {
  const lines = [message?.trim() || "Vortex has not approved the linked issue yet; refusing to open the pull request."];
  for (const issue of issues) {
    lines.push(...issueReviewLines(issue));
    const reply = issue.state === "needs_answers" ? `Reply once in a comment on #${issue.number}, accepting each blocking point's suggested fix or saying why not; then run` : "Run";
    lines.push(`  ${reply} \`${issueReviewWaitCommand(issue)}\` once.`);
  }
  return new CommandError(lines.join("\n"), REVIEW_EXIT.failed, "issue_not_approved", issues.length === 0 ? { reason: NO_LINKED_ISSUE } : undefined);
}

export const NO_LINKED_ISSUE = "no_linked_issue";

export function issueNotApprovedRefusal(status: number, body: unknown, owner: string, repo: string): CommandError | null {
  if (status !== 409 || !body || typeof body !== "object") return null;
  const refusal = body as { error?: unknown; message?: unknown; issues?: unknown };
  if (refusal.error !== "issue_not_approved") return null;
  const issues = Array.isArray(refusal.issues)
    ? refusal.issues.flatMap((issue): IssueReviewStatus[] => {
      const n = (issue as { number?: unknown } | null)?.number;
      const parsed = parseIssueReviewStatus(issue, { owner, repo, number: isPositiveInteger(n) ? n : 0 });
      return parsed ? [parsed] : [];
    })
    : [];
  return issueNotApprovedError(issues, serverMessage(refusal.message));
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
    const surge = surgeRefusal(body);
    if (surge) throw surge;
    const rejection = body as { error?: string; message?: unknown } | null;
    if (method === "PATCH" && rejection?.error === "cyclone_not_connected") {
      throw new CommandError(
        typeof rejection.message === "string" ? rejection.message : rejection.error,
        1,
        "cyclone_not_connected",
      );
    }
    throw new CommandError(`${failLabel} (HTTP ${status}): ${JSON.stringify(body)}`);
  }
  return body;
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
): Promise<unknown> {
  return stackMutation(stackId, "/land-next", "POST", {}, "Failed to land next", cfg);
}

/** List the authenticated user's live merge-queue entries. */
export async function listMergeQueueEntries(
  cfg?: Config,
  opts?: { stackId?: string },
): Promise<MergeQueueEntryDto[]> {
  const resolved = cfg ?? (await loadConfig());
  const stackId = opts?.stackId?.trim();
  const { status, body, retryAfterSeconds } = await apiFetch(
    resolved,
    stackId ? `/api/v1/stacks/queue?stackId=${encodeURIComponent(stackId)}` : "/api/v1/stacks/queue",
  );
  if (status === 404) {
    throw new CommandError(
      "Merge queue API is not available on this server yet. Deploy the API update or use the dashboard.",
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
  opts: { githubUnreadableRefusal?: boolean } = {},
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
  if (status === 409) {
    const refusal = body as { error?: unknown; message?: unknown } | null;
    if (
      (refusal?.error === "conflict_unchanged" || refusal?.error === "ci_failed") &&
      typeof refusal.message === "string"
    ) {
      throw new CommandError(refusal.message);
    }
  }
  if (
    opts.githubUnreadableRefusal &&
    status === 503 &&
    (body as { error?: unknown } | null)?.error === "github_unreadable"
  ) {
    throw new CommandError(
      serverMessage((body as { message?: unknown }).message) ?? GITHUB_UNREADABLE_MESSAGE,
      1,
      "github_unreadable",
    );
  }
  if (status < 200 || status >= 300) {
    const surge = surgeRefusal(body);
    if (surge) throw surge;
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
    { githubUnreadableRefusal: true },
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

export type PrFindingDismissInput = {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  reviewId: number;
  findingIds?: string[];
  scope?: "findings" | "review";
  reason?: string;
  evidenceUrl?: string;
  preview?: boolean;
};

export type PrDismissedFinding = {
  finding_id: string;
  finding_key: string;
  path: string | null;
  line: number | null;
  title: string;
};

export type PrFindingDismissResult = {
  status: "dismissed" | "preview";
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  review_id: number;
  review_kind: "seam" | "core";
  scope: "findings" | "review";
  dismissed: PrDismissedFinding[];
  already_dismissed: Array<PrDismissedFinding & { actor_login: string; dismissed_at: string }>;
  remaining: PrDismissedFinding[];
  all_dismissed: boolean;
  gate: {
    seam: {
      state: string;
      reviewed_sha: string | null;
      review_id: number | null;
      cleared: boolean;
      blocking: boolean;
    } | null;
    vortex?: { cleared: boolean; reason?: string | null; message?: string } | null;
    other_gates: "unchanged";
  };
  stack_id: string | null;
  threads?: Array<{ finding_id: string; state: "resolved" | "already_resolved" | "not_found" | "failed" }>;
};

export function dismissThreadsLine(result: Pick<PrFindingDismissResult, "threads">): string | null {
  const threads = result.threads ?? [];
  if (threads.length === 0) return null;
  const closed = threads.filter((thread) => thread.state === "resolved" || thread.state === "already_resolved").length;
  const failed = threads.filter((thread) => thread.state === "failed").map((thread) => thread.finding_id);
  const missing = threads.filter((thread) => thread.state === "not_found").map((thread) => thread.finding_id);
  return [
    `GitHub threads: ${closed} of ${threads.length} resolved.`,
    ...(failed.length ? [`Could not resolve ${failed.join(", ")}; run the same dismissal again to retry.`] : []),
    ...(missing.length ? [`No thread found for ${missing.join(", ")}.`] : []),
  ].join(" ");
}

export type PrFindingDismissOutcome =
  | { ok: true; result: PrFindingDismissResult }
  | { ok: false; status: number; error: string; message: string };

export async function dismissPrFindings(
  input: PrFindingDismissInput,
  cfg?: Config,
  opts?: { signal?: AbortSignal },
): Promise<PrFindingDismissOutcome> {
  const resolved = cfg ?? (await loadConfig());
  const json: Record<string, unknown> = {
    owner: input.owner.trim(),
    repo: input.repo.trim(),
    pr_number: input.prNumber,
    head_sha: input.headSha.trim(),
    review_id: input.reviewId,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.findingIds && input.findingIds.length > 0 ? { finding_ids: input.findingIds } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.evidenceUrl ? { evidence_url: input.evidenceUrl } : {}),
    ...(input.preview ? { preview: true } : {}),
  };
  const { status, body, retryAfterSeconds } = await apiFetch(resolved, "/api/v1/stacks/pr-review/dismiss", {
    method: "POST",
    json,
    signal: opts?.signal,
  });
  if (status === 429) {
    throw new CommandError(rateLimitedMessage(retryAfterSeconds), REVIEW_EXIT.rate_limited, "rate_limited", {
      retryAfterSeconds,
    });
  }
  if (status === 200) return { ok: true, result: body as PrFindingDismissResult };
  const rejection = (body ?? {}) as { error?: unknown; message?: unknown };
  if (status === 404 && typeof rejection.error !== "string") {
    throw new CommandError(
      "Finding dismissal is not available on this server yet. Deploy the API update.",
      REVIEW_EXIT.failed,
      "not_found",
    );
  }
  if (typeof rejection.error === "string") {
    return {
      ok: false,
      status,
      error: rejection.error,
      message: typeof rejection.message === "string" ? rejection.message : rejection.error,
    };
  }
  throw new CommandError(
    `Failed to dismiss findings (HTTP ${status}): ${JSON.stringify(body)}`,
    REVIEW_EXIT.failed,
    "review_failed",
  );
}
