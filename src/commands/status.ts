import { apiFetch } from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { ansi } from "../ui/ansi.js";

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
    findings?: {
      inline?: { path: string; line: number; severity: string; body: string; title?: string }[];
      off_diff?: { path?: string; severity: string; body: string }[];
      offDiff?: { path?: string; severity: string; body: string }[];
    } | null;
  };

  console.log(`Status:  ${row.status}`);
  if (row.verdict) console.log(`Verdict: ${ansi.bold(row.verdict)}`);
  if (row.summary) console.log(row.summary);
  if (row.error) console.log(ansi.red(`Error: ${row.error}`));
  const inline = row.findings?.inline ?? [];
  const off = row.findings?.off_diff ?? row.findings?.offDiff ?? [];
  for (const c of inline) {
    console.log(`\n[${c.severity}] ${c.path}:${c.line}${c.title ? ` — ${c.title}` : ""}`);
    console.log(c.body);
  }
  for (const c of off) {
    console.log(`\n[${c.severity}] off-diff ${c.path ?? ""}`);
    console.log(c.body);
  }
  if (inline.length === 0 && off.length === 0 && row.status === "completed") {
    console.log("\nNo findings.");
  }
}
