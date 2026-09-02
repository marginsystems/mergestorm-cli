/** Shared review-job findings payload (API may send snake or camel for off-diff). */
export type ReviewFindings = {
  specialists_run?: string[];
  inline?: {
    path: string;
    line: number;
    severity: string;
    body: string;
    title?: string;
    specialist?: string;
  }[];
  off_diff?: {
    path?: string;
    line?: number;
    severity: string;
    body: string;
  }[];
  offDiff?: {
    path?: string;
    line?: number;
    severity: string;
    body: string;
  }[];
};

export type RenderFindingsOptions = {
  /** When true and both lists are empty, print the empty message. */
  emptyMessage?: boolean;
};

export function formatFindingsLines(
  findings: ReviewFindings | null | undefined,
  opts: RenderFindingsOptions = {},
): string[] {
  const lines: string[] = [];
  const inline = findings?.inline ?? [];
  const off = findings?.off_diff ?? findings?.offDiff ?? [];
  for (const c of inline) {
    const lane = c.specialist ? `[${c.specialist}]` : "";
    lines.push(
      `[${c.severity}]${lane} ${c.path}:${c.line}${c.title ? ` — ${c.title}` : ""}`,
    );
    lines.push(c.body);
  }
  for (const c of off) {
    lines.push(`[${c.severity}] off-diff ${c.path ?? ""}`);
    lines.push(c.body);
  }
  if (opts.emptyMessage && inline.length === 0 && off.length === 0) {
    lines.push("No findings.");
  }
  return lines;
}

/** Print inline + off-diff findings the same way for oneshot `review` / `status --pretty`. */
export function renderFindings(
  findings: ReviewFindings | null | undefined,
  opts: RenderFindingsOptions = {},
): void {
  for (const line of formatFindingsLines(findings, opts)) console.log(line);
}
