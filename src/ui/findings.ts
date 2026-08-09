/** Shared review-job findings payload (API may send snake or camel for off-diff). */
export type ReviewFindings = {
  inline?: {
    path: string;
    line: number;
    severity: string;
    body: string;
    title?: string;
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

/** Print inline + off-diff findings the same way for `review` and `status --pretty`. */
export function renderFindings(
  findings: ReviewFindings | null | undefined,
  opts: RenderFindingsOptions = {},
): void {
  const inline = findings?.inline ?? [];
  const off = findings?.off_diff ?? findings?.offDiff ?? [];
  for (const c of inline) {
    console.log(`\n[${c.severity}] ${c.path}:${c.line}${c.title ? ` — ${c.title}` : ""}`);
    console.log(c.body);
  }
  for (const c of off) {
    console.log(`\n[${c.severity}] off-diff ${c.path ?? ""}`);
    console.log(c.body);
  }
  if (opts.emptyMessage && inline.length === 0 && off.length === 0) {
    console.log("\nNo findings.");
  }
}
