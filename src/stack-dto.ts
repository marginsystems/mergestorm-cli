/**
 * Wire types returned by the stack list/enrich HTTP endpoints.
 *
 * `api/src/stacks.ts#loadStackDtos` is the producer. Keep this file
 * dependency-free and byte-for-byte aligned with the canonical wire contract.
 */

export type StackBranchState =
  | "clean"
  | "needs_restack"
  | "restacking"
  | "conflict"
  | "merged"
  | "closed";

export type StackCiStatus =
  | "success"
  | "pending"
  | "failure"
  | "neutral"
  | "none"
  | "unknown";

export type StackReviewStatus =
  | "approved"
  | "changes_requested"
  | "reviewed"
  | "failed"
  | "none"
  | "unknown";

/** `failed` is the newest Vortex `pr_reviews` row. Work paints Review failed. */
export type StackVortexStatus =
  | "reviewing"
  | "seam_pending"
  | "all_clear"
  | "findings"
  | "throttled"
  | "failed";

export type StackCycloneStatus = "patching" | "awaiting_fix";

export type StackTempestStatus = "reviewing" | "findings" | "clear" | "failed" | "stale";

export type StackAgentName = "vortex" | "cyclone" | "tempest";

/**
 * One live-or-resting agent run for a PR (#1119): a dumb projection of one
 * ledger row (webhook job / lease / review-state / pr_reviews). Two live
 * Vortex jobs on two SHAs → two runs → two chips. Carries only safe facts —
 * never job ids, holders, or error strings.
 */
export type StackAgentRun = {
  agent: StackAgentName;
  /** Agent-specific status, e.g. "reviewing" / "patching" / "all_clear". */
  status: string;
  /** Full SHA when known. UI shortens to 7. */
  sha: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  /**
   * Vortex in-flight sub-state from pr_reviews.phase (#1189): "fanout" while
   * Core + specialists run in parallel, "synthesizing" during consolidation.
   * Only on live `reviewing` runs; unknown values fall back to plain Reviewing.
   */
  phase?: string | null;
  /**
   * Actionable finding count from the latest `pr_reviews.findings` payload
   * (#1248). Info-only notes (Continue, Decision required) are excluded.
   * Only on resting Vortex `findings` runs.
   */
  findingCount?: number | null;
};

export type StackLayerChecks = {
  total: number;
  success: number;
  pending: number;
  failure: number;
  failingName: string | null;
};

/** Closing / Development-sidebar issue. Cap 3 on the wire. */
export type StackLinkedIssue = {
  number: number;
  title: string | null;
};

/** Cyclone merge-conflict specialist resolution for this PR (#973). */
export type StackLayerConflictResolution = {
  resolvedAt: string;
  /** Branch the conflicts were resolved against (stacks parent or GitHub base). */
  baseBranch: string | null;
  /** Conflicted paths the specialist resolved; the writer caps the list. */
  files: string[];
  /** Head commit of the pushed resolution, when known. */
  headSha: string | null;
  /**
   * Chat dispatch that triggered the run (#973). Traces a mark to the job that
   * pushed it; null when the row predates dispatch tracing (or had no job).
   */
  dispatchId: string | null;
};

export type StackLayerDto = {
  branch: string;
  parentBranch: string | null;
  prNumber: number;
  position: number;
  state: StackBranchState;
  title: string | null;
  htmlUrl: string | null;
  ciStatus: StackCiStatus;
  reviewStatus: StackReviewStatus;
  checks: StackLayerChecks | null;
  /** null on the fast list or when no Vortex/seam signal exists. */
  vortexStatus: StackVortexStatus | null;
  /** null on the fast list or when no Cyclone signal exists. */
  cycloneStatus: StackCycloneStatus | null;
  /** null when no Tempest signal exists. Fast list and enrich both paint this from pr_reviews (#876). */
  tempestStatus: StackTempestStatus | null;
  /**
   * Ledger-backed agent runs, one per live row (#1119). Fast list and enrich
   * both paint this from our tables only — never GitHub. The per-agent status
   * fields above stay as a rollup of the newest run for older clients.
   * Undefined = producer predates runs (clients fall back to the rollup).
   */
  agentRuns?: StackAgentRun[];
  conflictDetail: string | null;
  lastRestackedSha: string | null;
  /** GitHub PR mergeability from enrich; null when unknown. */
  mergeable: boolean | null;
  /** GitHub REST mergeable_state; null when unknown. */
  mergeableState: string | null;
  /**
   * Vortex-style linked issues (keywords + Development sidebar), cap 3.
   * null until first enrich finds any; kept on merged unit members (unlike CI).
   */
  linkedIssues?: StackLinkedIssue[] | null;
  /**
   * Specialist lanes Vortex launched on this PR (smart router / Manual).
   * Fast list and enrich both fill from vortex_pr_review_state (#896 / #915).
   * Durable after merge — terminal layers keep the last run so Work can grey
   * the marks on a done-growing unit member instead of dropping them (#1021).
   */
  specialistsRun?: string[] | null;
  /** Published invocation count per specialist lane. Frontend paint follows separately. */
  specialistRunCounts?: Record<string, number> | null;
  /** Number of published reviews Core participated in for this PR. */
  coreRuns?: number | null;
  /**
   * Cyclone's merge-conflict specialist resolved this PR (#973). Fast list and
   * enrich both paint from cyclone_conflict_resolutions; null on terminal
   * layers and when the specialist never ran.
   */
  conflictResolution?: StackLayerConflictResolution | null;
};

export type StackUnitMemberDto = {
  prNumber: number;
  branch: string;
  position: number;
  seamState: string;
  seamReviewedSha: string | null;
  promotedHeadSha: string | null;
  promotedAt: string;
  /**
   * GitHub PR title snapshotted at promote / enrich (#965).
   * Survives stack_branches dropping the open-chain row. null until first write.
   */
  title?: string | null;
  /**
   * Linked issues snapshotted onto the member at promote / enrich (#936).
   * Survives stack_branches dropping the open-chain row. null until first write.
   */
  linkedIssues?: StackLinkedIssue[] | null;
  /**
   * Vortex specialist lanes that ran on this PR (#1021). Painted from
   * vortex_pr_review_state on the fast list — the open layer is gone after
   * promote, so the member must carry the marks for the greyed-out row.
   */
  specialistsRun?: string[] | null;
  /** Published invocation count per specialist lane. */
  specialistRunCounts?: Record<string, number> | null;
  /** Number of published reviews Core participated in for this PR. */
  coreRuns?: number | null;
};

export type StackUnitDto = {
  id: string;
  uNumber: number;
  state: string;
  branch: string;
  landTarget: string;
  members: StackUnitMemberDto[];
  landPrNumber: number | null;
  tempestLandStatus: string | null;
  landingBlockReason: string | null;
  /**
   * Land-PR chrome. Fast list hydrates last-known CI/title/mergeable/issues from
   * `review_units` (#878 / #892) and may attach a tempest-only stub (#876). Enrich
   * refreshes GitHub and writes back. Null when the land PR is an open stack
   * layer (chips live on `layers`) or the unit has no land PR.
   */
  landPr: StackLayerDto | null;
};

export type StackDto = {
  id: string;
  owner: string;
  repo: string;
  trunkBranch: string;
  /** Real trunk the review unit eventually lands into. */
  landTarget: string;
  autoPromoteWhenGreen: boolean;
  /**
   * Dashboard-only archive (#963): set hides the stack from the active Work
   * list; GitHub PRs stay open. Only PATCH /stacks/:id toggles it.
   */
  archivedAt: string | null;
  layers: StackLayerDto[];
  /** Present when a review-unit row exists for this stack. */
  unit?: StackUnitDto;
};
