import {
  getMe,
  getReview,
  getSettings,
  listJobs,
  patchSettings,
  SETTINGS_WRITABLE_KEYS,
  type JobListItem,
  type MeResponse,
  type SettingsPatch,
  type SettingsResponse,
} from "../api.js";
import { BEARER_SETTINGS_LABELS } from "../automation-catalog.js";
import { apiBase, keyDisplay, loadConfig, resolveApiKey } from "../config.js";
import { CommandError } from "../errors.js";
import { ansi } from "../ui/ansi.js";
import {
  toReviewJobEnvelope,
  type ReviewJobRow,
} from "../ui/job-envelope.js";
import {
  runTabsBrowser,
  type TabId,
  type TabsConfigRow,
  type TabsData,
  type TabsJob,
} from "../ui/tabs.js";
import { formatDaysLeft, formatResetLabel, type UsagePanelJob } from "../ui/usage.js";
import { relativeWhen } from "./jobs.js";

/** The tabbed browser needs a real terminal on both ends. */
export function canBrowse(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Shared job row mapper for the Usage tab and the static `credits` panel. */
export function toPanelJob(job: JobListItem): UsagePanelJob {
  return {
    job: job.job_id.slice(0, 8),
    verdict: job.verdict ?? job.status ?? "-",
    thread: job.thread_slug ?? "-",
    credits: job.credits ? String(job.credits.standard) : "-",
    when: relativeWhen(job.created_at),
  };
}

export type StatusTabInput = {
  keyPrefix: string;
  keyName: string | null;
  plan: string | null;
  apiBase: string;
  reachable: boolean;
  /** getMe surfaced a 401: the key is invalid/revoked, not the API down. */
  keyInvalid: boolean;
  used?: number;
  limit?: number | null;
  remaining?: number | null;
  resetsAt?: string | null;
  now?: Date;
};

/** Short chrome note — lives on the hint row, not in the Status body. */
export function statusReachabilityNote(
  input: Pick<StatusTabInput, "reachable" | "keyInvalid">,
): string {
  if (input.keyInvalid) return "key revoked";
  if (!input.reachable) return "API offline";
  return "API reachable";
}

function field(label: string, value: string): string {
  return `  ${label.padEnd(8)}${value}`;
}

function creditsValue(input: StatusTabInput): string {
  if (input.keyInvalid) return "unavailable (invalid or revoked key)";
  if (!input.reachable) return "unavailable";
  if (input.limit == null && input.used == null) return "unavailable";
  if (input.limit == null) return "unlimited";
  if (input.limit === 0) return "not included";
  const used = input.used ?? 0;
  const left =
    input.remaining != null ? input.remaining : Math.max(0, input.limit - used);
  return `${used} / ${input.limit} used · ${left} left`;
}

/** Status tab body: whoami + credits from `/me`. Reachability is the footer. */
export function buildStatusTabLines(input: StatusTabInput): string[] {
  const lines = [
    field("Key", `${ansi.bold(input.keyPrefix)}${input.keyName ? ` (${input.keyName})` : ""}`),
  ];
  if (input.plan) lines.push(field("Plan", input.plan));
  lines.push(field("API", input.apiBase));
  lines.push(field("Credits", creditsValue(input)));
  if (input.reachable && !input.keyInvalid && (input.resetsAt || input.limit != null)) {
    const when = formatResetLabel(input.resetsAt, input.now);
    const left = formatDaysLeft(input.resetsAt, input.now);
    lines.push(field("Resets", left ? `${when} · ${left}` : when));
  }
  if (input.keyInvalid) {
    lines.push(`  ${ansi.dim("run")} ${ansi.brightGreen("login")} ${ansi.dim("to sign in again")}`);
  }
  return lines;
}

/** In-place job detail for the Jobs tab (same envelope as `status <id>`). */
export function formatJobDetailLines(row: ReviewJobRow): string[] {
  const e = toReviewJobEnvelope(row);
  const lines: string[] = [];
  lines.push(`  Job      ${e.job_id ?? "?"}`);
  lines.push(`  Status   ${e.status}`);
  if (e.verdict) lines.push(`  Verdict  ${ansi.bold(e.verdict)}`);
  if (e.thread) {
    const n = e.thread.job_number != null ? ` · #${e.thread.job_number}` : "";
    lines.push(`  Thread   ${e.thread.slug}${n}`);
  }
  if (e.router_mode) lines.push(`  Router   ${e.router_mode}`);
  if (e.specialists_requested.length > 0) {
    lines.push(`  Asked    ${e.specialists_requested.join(", ")}`);
  }
  if (e.specialists_run.length > 0) {
    lines.push(`  Run      ${e.specialists_run.join(", ")}`);
  }
  if (e.credits) lines.push(`  Credits  ${e.credits.standard} standard`);
  if (e.error) lines.push(ansi.red(`  Error    ${e.error}`));
  if (e.summary) {
    lines.push("");
    for (const l of e.summary.split("\n")) lines.push(`  ${l}`);
  }
  const inline = e.findings?.inline ?? [];
  const off = e.findings?.off_diff ?? e.findings?.offDiff ?? [];
  for (const c of inline) {
    lines.push("");
    const lane = c.specialist ? `[${c.specialist}]` : "";
    const title = c.title ? ` · ${c.title}` : "";
    lines.push(`  [${c.severity}]${lane} ${c.path}:${c.line}${title}`);
    for (const l of c.body.split("\n")) lines.push(`  ${l}`);
  }
  for (const c of off) {
    lines.push("");
    lines.push(`  [${c.severity}] off-diff ${c.path ?? ""}`);
    for (const l of c.body.split("\n")) lines.push(`  ${l}`);
  }
  if (inline.length === 0 && off.length === 0 && e.status === "completed") {
    lines.push("");
    lines.push("  No findings.");
  }
  return lines;
}

/** Human labels for the Config tab and the static `settings` printout. */
export const SETTINGS_LABELS = BEARER_SETTINGS_LABELS;

/** Config rows in a stable order: writable toggles, then connected flags. */
export function buildConfigRows(settings: SettingsResponse): TabsConfigRow[] {
  return [
    ...SETTINGS_WRITABLE_KEYS.map((key) => ({
      key,
      label: SETTINGS_LABELS[key],
      value: settings[key] === true,
      writable: true,
    })),
    {
      key: "cyclone_connected",
      label: "Cyclone",
      value: settings.cyclone_connected === true,
      writable: false,
    },
    {
      key: "github_connected",
      label: "GitHub",
      value: settings.github_connected === true,
      writable: false,
    },
  ];
}

function toTabsJob(job: JobListItem): TabsJob {
  return {
    id: job.job_id,
    cells: {
      job: job.job_id.slice(0, 8),
      status: job.status,
      verdict: job.verdict ?? "-",
      thread: (job.thread_slug ?? "-").slice(0, 24),
      when: relativeWhen(job.created_at),
    },
  };
}

/**
 * Data + entry for the tabbed Status / Usage / Jobs / Config browser (F-9).
 * Degrades honestly: a null `/me` marks the API unreachable and the Usage
 * tab says so, and a failed settings GET leaves the Config tab reporting
 * itself unavailable instead of drawing toggles we do not have.
 */
export async function openTabsBrowser(initial: TabId): Promise<void> {
  const cfg = await loadConfig();
  const key = resolveApiKey(cfg);
  if (!key) {
    throw new CommandError("Not logged in. Run `mergestorm login`.");
  }
  let me: MeResponse | null = null;
  let keyInvalid = false;
  try {
    me = await getMe(cfg, { timeoutMs: 8_000 });
  } catch (err) {
    if (err instanceof CommandError) {
      keyInvalid = true;
    } else {
      throw err;
    }
  }
  let jobs: JobListItem[] = [];
  let jobsError: string | null = null;
  try {
    jobs = await listJobs(10, cfg, { timeoutMs: 8_000 });
  } catch (err) {
    jobsError = err instanceof Error ? err.message : String(err);
  }
  // Bearer /api/v1/settings for the Config tab. A revoked key already threw
  // above; anything else degrades to an honest "unavailable" body.
  let settings: SettingsResponse | null = null;
  if (!keyInvalid) {
    try {
      settings = await getSettings(cfg, { timeoutMs: 8_000 });
    } catch {
      settings = null;
    }
  }

  const data: TabsData = {
    statusLines: buildStatusTabLines({
      keyPrefix: me?.key.prefix ?? keyDisplay(key) ?? "msk_live_…",
      keyName: me?.key.name ?? null,
      plan: me ? (me.plan_label_key ?? me.plan_key) : null,
      apiBase: apiBase(cfg),
      reachable: me !== null,
      keyInvalid,
      used: me?.usage.standard.used,
      limit: me?.usage.standard.limit,
      remaining: me?.usage.standard.remaining,
      resetsAt: me?.resets_at,
    }),
    footerNote: statusReachabilityNote({ reachable: me !== null, keyInvalid }),
    usage: me
      ? {
          keyPrefix: me.key.prefix,
          plan: me.plan_label_key ?? me.plan_key,
          used: me.usage.standard.used,
          limit: me.usage.standard.limit,
          resetsAt: me.resets_at,
          jobs: jobs.slice(0, 5).map(toPanelJob),
          jobsError: jobsError ?? undefined,
        }
      : null,
    ...(keyInvalid
      ? { usageEmptyText: "Usage unavailable (invalid or revoked key)." }
      : {}),
    jobs: jobs.map(toTabsJob),
    ...(jobsError ? { jobsEmptyText: `Jobs unavailable: ${jobsError}` } : {}),
    config: settings ? buildConfigRows(settings) : null,
    ...(keyInvalid
      ? { configEmptyText: "Settings unavailable (invalid or revoked key)." }
      : {}),
    color: ansi.enabled,
  };

  await runTabsBrowser({
    initial,
    data,
    toggleSetting: async (key, value) => {
      const next = await patchSettings(
        { [key]: value } as SettingsPatch,
        cfg,
        { timeoutMs: 8_000 },
      );
      return buildConfigRows(next);
    },
    loadJobDetail: async (jobId) => {
      const body = await getReview(jobId, cfg, { timeoutMs: 8_000 });
      const row =
        body && typeof body === "object"
          ? { ...(body as ReviewJobRow), job_id: (body as ReviewJobRow).job_id ?? jobId }
          : { job_id: jobId, status: "failed", error: "Invalid review response" };
      return formatJobDetailLines(row);
    },
  });
}
