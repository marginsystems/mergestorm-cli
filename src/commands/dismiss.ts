import {
  dismissPrFindings,
  type PrFindingDismissInput,
  type PrFindingDismissOutcome,
  type PrFindingDismissResult,
} from "../api.js";
import { loadConfig, type Config } from "../config.js";
import { CommandError, REVIEW_EXIT } from "../errors.js";
import { stackWatchObligation, type StackWatchObligation } from "../stack-watch-obligation.js";
import { parseAdoptTarget, withWatch } from "./stack.js";

export const DISMISS_USAGE = [
  "usage: mergestorm dismiss <owner/repo>#<n> --head <sha> --review <id>",
  "         (--finding <id> [--finding <id>…] | --all) --reason <text> [--evidence <url>] [--json]",
  "       mergestorm dismiss <owner/repo>#<n> --head <sha> --review <id> --preview [--json]",
].join("\n");

export type ParsedDismissArgs = PrFindingDismissInput & { json: boolean };

function usage(message?: string): CommandError {
  return new CommandError(message ? `${message}\n${DISMISS_USAGE}` : DISMISS_USAGE, REVIEW_EXIT.usage, "usage");
}

export function parseDismissArgs(args: string[]): ParsedDismissArgs {
  const target: string[] = [];
  const findingIds: string[] = [];
  let headSha = "";
  let reviewId: number | undefined;
  let reason: string | undefined;
  let evidenceUrl: string | undefined;
  let all = false;
  let preview = false;
  let json = false;
  const value = (flag: string, raw: string | undefined): string => {
    if (raw === undefined || raw.startsWith("--")) throw usage(`${flag} needs a value`);
    return raw;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--head") headSha = value(arg, args[++i]).trim().toLowerCase();
    else if (arg === "--review") {
      const raw = value(arg, args[++i]).trim();
      if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw usage("--review needs the numeric GitHub review id");
      reviewId = Number(raw);
    } else if (arg === "--finding") findingIds.push(...value(arg, args[++i]).split(",").map((id) => id.trim()).filter(Boolean));
    else if (arg === "--all") all = true;
    else if (arg === "--reason") reason = value(arg, args[++i]);
    else if (arg === "--evidence") evidenceUrl = value(arg, args[++i]).trim();
    else if (arg === "--preview") preview = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("--")) throw usage(`unknown flag ${arg}`);
    else target.push(arg);
  }
  let parsedTarget: { owner: string; repo: string; prNumber: number };
  try {
    parsedTarget = parseAdoptTarget(target);
  } catch {
    throw usage("name the PR as <owner/repo>#<n>");
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw usage("--head needs the full 40-character PR head SHA");
  if (reviewId === undefined) throw usage("--review is required");
  if (!preview) {
    if (all && findingIds.length > 0) throw usage("pass --finding or --all, not both");
    if (!all && findingIds.length === 0) throw usage("pass --finding <id> for each finding, or --all for the whole review");
    if (!reason?.trim()) throw usage("--reason is required: say why the finding is wrong or not actionable");
  }
  return {
    ...parsedTarget,
    headSha,
    reviewId,
    findingIds: all ? [] : findingIds,
    scope: all ? "review" : "findings",
    ...(reason !== undefined ? { reason } : {}),
    ...(evidenceUrl ? { evidenceUrl } : {}),
    preview,
    json,
  };
}

export function dismissWatch(result: PrFindingDismissResult): StackWatchObligation | null {
  if (!result.stack_id) return null;
  return stackWatchObligation({ stackId: result.stack_id, terminal: null, unread: true, freshCursor: true });
}

function findingLine(finding: { finding_id: string; path: string | null; line: number | null; title: string }): string {
  const where = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ""}` : "review body";
  return `  ${finding.finding_id}  ${where}  ${finding.title}`;
}

export function formatDismissResult(result: PrFindingDismissResult, watch: StackWatchObligation | null): string {
  const lines: string[] = [];
  const pr = `${result.owner}/${result.repo}#${result.pr_number}`;
  const kind = result.review_kind === "seam" ? "seam review" : "Vortex review";
  if (result.status === "preview") {
    lines.push(`${pr} ${kind} ${result.review_id} at ${result.head_sha.slice(0, 7)}: ${result.remaining.length} open finding(s)`);
    lines.push(...result.remaining.map(findingLine));
  } else {
    lines.push(`${pr} ${kind} ${result.review_id} at ${result.head_sha.slice(0, 7)}`);
    if (result.dismissed.length) lines.push("Dismissed:", ...result.dismissed.map(findingLine));
    if (result.already_dismissed.length) {
      lines.push(
        "Already dismissed:",
        ...result.already_dismissed.map((f) => `${findingLine(f)}  (by @${f.actor_login})`),
      );
    }
    if (result.remaining.length) lines.push("Still open:", ...result.remaining.map(findingLine));
  }
  const seam = result.gate.seam;
  if (seam) {
    lines.push(
      seam.cleared
        ? "Seam gate: cleared (approved at this head). CI, other reviews and Auto land policy still apply."
        : seam.blocking
          ? `Seam gate: still blocking (seam_state=${seam.state}).`
          : `Seam gate: not blocking (seam_state=${seam.state}).`,
    );
  }
  if (watch?.next) lines.push(`Next: ${watch.next.command}`);
  return lines.join("\n");
}

export type DismissDeps = {
  loadConfig?: () => Promise<Config>;
  dismiss?: (input: PrFindingDismissInput, cfg: Config) => Promise<PrFindingDismissOutcome>;
};

export async function cmdDismiss(args: string[], deps: DismissDeps = {}): Promise<void> {
  const parsed = parseDismissArgs(args);
  const cfg = await (deps.loadConfig ?? loadConfig)();
  const { json, ...input } = parsed;
  const outcome = await (deps.dismiss ?? ((i, c) => dismissPrFindings(i, c)))(input, cfg);
  if (!outcome.ok) {
    if (json) {
      console.log(JSON.stringify({ error: { code: outcome.error, message: outcome.message } }, null, 2));
      process.exitCode = REVIEW_EXIT.failed;
      return;
    }
    throw new CommandError(`Dismissal refused (${outcome.error}): ${outcome.message}`, REVIEW_EXIT.failed, "review_failed");
  }
  const watch = dismissWatch(outcome.result);
  if (json) {
    console.log(JSON.stringify(withWatch(outcome.result, watch), null, 2));
    return;
  }
  console.log(formatDismissResult(outcome.result, watch));
}
