import type { ReviewFindings } from "./findings.js";

export const REVIEW_JOB_ENVELOPE_SCHEMA = "mergestorm.review_job/v1" as const;

export type ReviewJobRow = {
  job_id?: string | null;
  id?: string | null;
  status?: string | null;
  thread_slug?: string | null;
  thread_job_number?: number | null;
  base_label?: string | null;
  head_label?: string | null;
  router_mode?: string | null;
  specialists_requested?: string[] | null;
  specialists_run?: string[] | null;
  verdict?: string | null;
  summary?: string | null;
  findings?: ReviewFindings | null;
  truncated?: boolean | null;
  error?: string | null;
  credits?: { standard: number } | null;
  webhook_secret?: string | null;
  created_at?: string | null;
  finished_at?: string | null;
  retry_after_seconds?: number | null;
};

export type ReviewJobEnvelope = {
  schema: typeof REVIEW_JOB_ENVELOPE_SCHEMA;
  job_id: string | null;
  status: string;
  thread: { slug: string; job_number: number | null } | null;
  base_label: string | null;
  head_label: string | null;
  router_mode: string | null;
  specialists_requested: string[];
  specialists_run: string[];
  verdict: string | null;
  summary: string | null;
  findings: ReviewFindings | null;
  truncated: boolean;
  error: string | null;
  credits: { standard: number } | null;
  webhook_secret: string | null;
  created_at: string | null;
  finished_at: string | null;
  retry_after_seconds?: number;
};

export type ReviewEnvelopeFallbacks = {
  jobId?: string | null;
  status?: string;
  threadSlug?: string | null;
  baseLabel?: string | null;
  headLabel?: string | null;
  routerMode?: string | null;
  specialistsRequested?: string[];
  error?: string | null;
  retryAfterSeconds?: number | null;
};

/**
 * Stable machine envelope shared by submit and terminal review output.
 * Fields added by the API-envelope work are nullable until that API lands.
 */
export function toReviewJobEnvelope(
  row: ReviewJobRow | null | undefined,
  fallback: ReviewEnvelopeFallbacks = {},
): ReviewJobEnvelope {
  const slug = row?.thread_slug ?? fallback.threadSlug ?? null;
  const findings = row?.findings ?? null;
  const retryAfter =
    fallback.retryAfterSeconds ?? row?.retry_after_seconds ?? undefined;
  return {
    schema: REVIEW_JOB_ENVELOPE_SCHEMA,
    job_id: row?.job_id ?? row?.id ?? fallback.jobId ?? null,
    status: row?.status ?? fallback.status ?? "failed",
    thread: slug
      ? { slug, job_number: row?.thread_job_number ?? null }
      : null,
    base_label: row?.base_label ?? fallback.baseLabel ?? null,
    head_label: row?.head_label ?? fallback.headLabel ?? null,
    router_mode: row?.router_mode ?? fallback.routerMode ?? null,
    specialists_requested:
      row?.specialists_requested ?? fallback.specialistsRequested ?? [],
    specialists_run:
      row?.specialists_run ?? findings?.specialists_run ?? [],
    verdict: row?.verdict ?? null,
    summary: row?.summary ?? null,
    findings,
    truncated: row?.truncated ?? false,
    error: fallback.error !== undefined ? fallback.error : (row?.error ?? null),
    credits: row?.credits ?? null,
    webhook_secret: row?.webhook_secret ?? null,
    created_at: row?.created_at ?? null,
    finished_at: row?.finished_at ?? null,
    ...(retryAfter != null && Number.isFinite(retryAfter)
      ? { retry_after_seconds: retryAfter }
      : {}),
  };
}
