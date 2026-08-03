import { getMe } from "../api.js";
import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { ansi } from "../ui/ansi.js";
import { formatResetLabel, usageBar } from "../ui/usage.js";

export async function cmdCredits(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const cfg = await loadConfig();
  const me = await getMe(cfg);
  if (!me) {
    throw new CommandError(
      "Credits are not available (not logged in, offline, or API too old). " +
        "Try `mergestorm login` or open https://mergestorm.ai/billing",
    );
  }
  if (asJson) {
    console.log(JSON.stringify({ usage: me.usage, resets_at: me.resets_at ?? null }, null, 2));
    return;
  }
  const s = me.usage.standard;
  const p = me.usage.premium;

  // Claude Usage tab layout: label → long bar + "N% used" → Resets line.
  console.log(`  ${ansi.bold("Standard")}`);
  console.log(`  ${usageBar(s.used, s.limit)}`);
  console.log("");
  console.log(`  ${ansi.bold("Premium")}`);
  console.log(`  ${usageBar(p.used, p.limit)}`);
  console.log("");
  console.log(`  ${ansi.dim(formatResetLabel(me.resets_at))}`);
}
