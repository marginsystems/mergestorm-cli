/**
 * Build a GitHub PR body from a tip commit message.
 * Pure — no git / network.
 */

const TRAILER_RE = /^(fixes|closes|resolves)\s+#(\d+)\s*$/i;
const DROPPED_TRAILER_RE = /^(?:co-authored-by|signed-off-by):/i;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const MARKDOWN_LINE_RE = /^(?:\s|#{1,6}(?:\s|$)|[-*+]\s|\d+[.)]\s|>|\||<)/;
const HORIZONTAL_RULE_RE = /^([-*_])(?:\s*\1){2,}\s*$/;
const HARD_BREAK_RE = /(?: {2}|\\)$/;
const TEST_PLAN_HEADING_RE = /^ {0,3}#{1,6}\s+test\s+plan\s*[\p{P}]*\s*#*\s*$/iu;

/**
 * Turn `git log -1 --format=%B` output into a non-empty PR description.
 */
export function buildPrBodyFromCommit(fullMessage: string): string {
  const lines = fullMessage.replace(/\r\n/g, "\n").split("\n");
  const subject = (lines[0] ?? "").trim() || "Update";

  const trailers: string[] = [];
  const bodyLines = renderCommitBody(lines.slice(1), trailers);

  const summaryLines: string[] = [];
  const subjectTrailer = TRAILER_RE.exec(subject);
  if (subjectTrailer) {
    trailers.unshift(closingTrailer(subjectTrailer));
  }
  if (bodyLines.length > 0) {
    summaryLines.push(...bodyLines);
  } else if (!subjectTrailer) {
    summaryLines.push(`- ${subject}`);
  }

  const parts = summaryLines.length > 0 ? ["## Summary", ...summaryLines] : [];
  if (!hasTestPlanHeading(bodyLines)) {
    if (parts.length > 0) parts.push("");
    parts.push("## Test plan", "- [ ] CI green");
  }

  if (trailers.length > 0) {
    parts.push("", ...uniqueTrailers(trailers));
  }

  return parts.join("\n") + "\n";
}

function closingTrailer(match: RegExpExecArray): string {
  const verb = match[1]![0]!.toUpperCase() + match[1]!.slice(1).toLowerCase();
  return `${verb} #${match[2]}`;
}

function hasTestPlanHeading(lines: readonly string[]): boolean {
  let fence: string | null = null;
  for (const line of lines) {
    if (fence !== null) {
      if (isClosingFence(line, fence)) fence = null;
      continue;
    }
    const open = FENCE_RE.exec(line);
    if (open) {
      fence = open[1]!;
      continue;
    }
    if (TEST_PLAN_HEADING_RE.test(line)) return true;
  }
  return false;
}

function isMarkdownLine(line: string): boolean {
  return MARKDOWN_LINE_RE.test(line) || HORIZONTAL_RULE_RE.test(line);
}

function isClosingFence(line: string, fence: string): boolean {
  const match = FENCE_RE.exec(line);
  return !!match && match[1]![0] === fence[0] && match[1]!.length >= fence.length && line.trim() === match[1];
}

function renderCommitBody(lines: readonly string[], trailers: string[]): string[] {
  const out: string[] = [];
  let paragraph: string | null = null;
  let fence: string | null = null;

  const flush = () => {
    if (paragraph !== null) out.push(paragraph);
    paragraph = null;
  };

  for (const raw of lines) {
    if (fence !== null) {
      out.push(raw);
      if (isClosingFence(raw, fence)) fence = null;
      continue;
    }
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const closing = TRAILER_RE.exec(trimmed);
    if (closing) {
      trailers.push(closingTrailer(closing));
      flush();
      continue;
    }
    if (DROPPED_TRAILER_RE.test(trimmed)) {
      flush();
      continue;
    }
    const open = FENCE_RE.exec(line);
    if (open) {
      flush();
      fence = open[1]!;
      out.push(raw);
      continue;
    }
    const hardBreak = HARD_BREAK_RE.test(raw);
    if (isMarkdownLine(line)) {
      flush();
      out.push(hardBreak ? raw : line);
      continue;
    }
    const text = hardBreak ? raw : line;
    paragraph = paragraph === null ? text : `${paragraph} ${text}`;
    if (hardBreak) flush();
  }
  flush();
  if (fence !== null) {
    out.push(fence);
  } else {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
  }
  return out;
}

const LINKED_ISSUE_RE = /(?<![\w/#.-])(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s*:?\s+(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/gi;

export function linkedIssueNumbers(repo: { owner: string; repo: string }, ...texts: string[]): number[] {
  const numbers = new Set<number>();
  const same = `${repo.owner}/${repo.repo}`.toLowerCase();
  for (const text of texts) {
    for (const match of text.matchAll(LINKED_ISSUE_RE)) {
      if (match[1] && `${match[1]}/${match[2]}`.toLowerCase() !== same) continue;
      const n = Number(match[3]);
      if (Number.isSafeInteger(n) && n > 0) numbers.add(n);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

function uniqueTrailers(trailers: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of trailers) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
