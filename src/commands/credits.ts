import { getMe, listJobs, type JobListItem } from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { ansi } from "../ui/ansi.js";
import { formatUsagePanel } from "../ui/usage.js";
import { canBrowse, openTabsBrowser, toPanelJob } from "./browse.js";

export async function cmdCredits(args: string[]): Promise<void> {
  const asJson = args.includes("--json");

  // TTY: the tabbed Status / Usage / Jobs browser, opened on Usage.
  // `--json` and pipes keep the machine/static output exactly as before.
  if (!asJson && canBrowse()) {
    await openTabsBrowser("usage");
    return;
  }

  const cfg = await loadConfig();
  const me = await getMe(cfg);
  if (!me) {
    throw new CommandError(
      "Credits are not available (not logged in, offline, or API too old). " +
        "Try `mergestorm login` or open https://mergestorm.ai/billing",
    );
  }

  let recentJobs: JobListItem[] = [];
  try {
    recentJobs = await listJobs(5, cfg);
  } catch {
    recentJobs = [];
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        { usage: me.usage, resets_at: me.resets_at ?? null, recent_jobs: recentJobs },
        null,
        2,
      ),
    );
    return;
  }

  const s = me.usage.standard;
  const columns = process.stdout.columns || 80;
  const lines = formatUsagePanel({
    keyPrefix: me.key.prefix,
    plan: me.plan_label_key ?? me.plan_key,
    used: s.used,
    limit: s.limit,
    bonusRemaining: me.usage.bonus?.remaining,
    resetsAt: me.resets_at,
    jobs: recentJobs.map(toPanelJob),
    columns,
    color: ansi.enabled,
  });
  for (const line of lines) console.log(line);
}
