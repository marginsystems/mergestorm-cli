import { ansi } from "../ui/ansi.js";
import { runLineTabsBrowser, type LineTab } from "../ui/line-tabs.js";
import { canBrowse } from "./browse.js";

const cmd = (name: string, blurb: string): string =>
  `  ${ansi.brightGreen(name.padEnd(26))}${blurb}`;

const rule = (label: string): string => `  ${ansi.bold(label)}`;

/** Tabbed `/help` pages. Short rows only — no paragraphs. */
export function buildHelpTabs(): LineTab[] {
  return [
    {
      id: "start",
      label: "Start",
      lines: [
        rule("What this is"),
        "  mg is the Mergestorm terminal — local reviews + stacked PRs.",
        "  Same account as mergestorm.ai. The dashboard is the other half.",
        "",
        rule("The loop"),
        cmd("review", "send a diff → job on the API"),
        cmd("usage", "credits, jobs, who you are"),
        cmd("stack create → submit", "author a stack, then open PRs"),
        "",
        rule("Now"),
        cmd("/", "slash menu at the prompt"),
        cmd("login", "if the header says not logged in"),
      ],
    },
    {
      id: "commands",
      label: "Commands",
      lines: [
        rule("Every day"),
        cmd("review [base] [head]", "diff vs origin/HEAD, main, or master"),
        cmd("usage", "Status / Usage / Jobs tabs"),
        cmd("status <job>", "one job, same as the Jobs tab"),
        cmd("jobs", "recent reviews"),
        "",
        rule("Around a branch"),
        cmd("branches", "pick a recently reviewed branch"),
        cmd("chain [slug]", "timeline for that branch"),
        cmd("thread <slug>", "jobs in a review thread"),
        "",
        rule("Account"),
        cmd("login", "browser sign-in (or login --key)"),
        cmd("whoami", "key · plan · API"),
        cmd("settings", "automation toggles · Config tab"),
        cmd("logout", "forget the stored key"),
        cmd("clear / exit", "reprint home · leave the shell"),
      ],
    },
    {
      id: "stacks",
      label: "Stacks",
      lines: [
        rule("New mg stack"),
        cmd("stack create", "new layer on this branch"),
        "  commit your work",
        cmd("stack submit", "push + open PRs from tip commits"),
        "",
        rule("Single stack (from trunk)"),
        cmd("stack create --onto main", "fresh stack, not on an existing one"),
        cmd("stack list", "what's registered for this repo"),
        cmd("queue [add <stack-id>]", "list entries · queue verified landing"),
        cmd("stack land <id>", "land now · skips queue verification"),
        "",
        rule("Existing PR stack"),
        cmd("stack adopt org/repo#12", "import an open GitHub chain"),
        cmd("stack restack <id>", "rewrite descendants after a change"),
        "",
        rule("Notes"),
        "  Happy path: create → submit → restack → land.",
        "  Adopt is import-only. Growing a submitted stack needs --extend.",
      ],
    },
  ];
}

export function helpTabIndex(id: string): number {
  const tabs = buildHelpTabs();
  const i = tabs.findIndex((t) => t.id === id);
  return i >= 0 ? i : 0;
}

export async function openHelpBrowser(initial?: string): Promise<void> {
  const tabs = buildHelpTabs();
  if (!canBrowse()) {
    for (const tab of tabs) {
      console.log(`  ${tab.label}`);
      for (const line of tab.lines) console.log(line);
      console.log("");
    }
    return;
  }
  await runLineTabsBrowser({ tabs, initial: initial ? helpTabIndex(initial) : 0 });
}
