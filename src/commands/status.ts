import { apiFetch } from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { ansi } from "../ui/ansi.js";
import { renderFindings, type ReviewFindings } from "../ui/findings.js";

export type StatusOptions = {
  format?: "json" | "pretty";
  signal?: AbortSignal;
};

export async function cmdStatus(jobId: string, opts: StatusOptions = {}): Promise<void> {
  const format = opts.format ?? "json";
  const cfg = await loadConfig();
  const { status, body } = await apiFetch(cfg, `/api/v1/reviews/${jobId}`, {
    signal: opts.signal,
  });
  if (status !== 200) {
    throw new CommandError(JSON.stringify(body, null, 2));
  }
  if (format === "json") {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const row = body as {
    status: string;
    summary?: string | null;
    verdict?: string | null;
    error?: string | null;
    findings?: ReviewFindings | null;
  };

  console.log(`Status:  ${row.status}`);
  if (row.verdict) console.log(`Verdict: ${ansi.bold(row.verdict)}`);
  if (row.summary) console.log(row.summary);
  if (row.error) console.log(ansi.red(`Error: ${row.error}`));
  renderFindings(row.findings, { emptyMessage: row.status === "completed" });
}
