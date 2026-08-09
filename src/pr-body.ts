/**
 * Build a GitHub PR body from a tip commit message.
 * Pure — no git / network.
 */

const TRAILER_RE = /^(fixes|closes|resolves)\s+#(\d+)\s*$/i;

/**
 * Turn `git log -1 --format=%B` output into a non-empty PR description.
 */
export function buildPrBodyFromCommit(fullMessage: string): string {
  const lines = fullMessage.replace(/\r\n/g, "\n").split("\n");
  const subject = (lines[0] ?? "").trim() || "Update";

  const trailers: string[] = [];
  const bodyLines: string[] = [];

  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const m = TRAILER_RE.exec(line);
    if (m) {
      const verb = m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase();
      trailers.push(`${verb} #${m[2]}`);
      continue;
    }
    bodyLines.push(line);
  }

  // Also pick trailers that appear as the whole subject (unusual but cheap).
  const subjectTrailer = TRAILER_RE.exec(subject);
  const summaryBullets: string[] = [];
  if (subjectTrailer) {
    const verb =
      subjectTrailer[1]![0]!.toUpperCase() + subjectTrailer[1]!.slice(1).toLowerCase();
    trailers.unshift(`${verb} #${subjectTrailer[2]}`);
    summaryBullets.push(`- ${subject}`);
  } else {
    summaryBullets.push(`- ${subject}`);
  }
  for (const para of bodyLines) {
    summaryBullets.push(`- ${para}`);
  }

  const parts = [
    "## Summary",
    ...summaryBullets,
    "",
    "## Test plan",
    "- [ ] CI green",
  ];

  if (trailers.length > 0) {
    parts.push("", ...uniqueTrailers(trailers));
  }

  return parts.join("\n") + "\n";
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
