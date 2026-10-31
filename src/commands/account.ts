import { revokeOwnKey } from "../api.js";
import {
  ACCOUNT_LIMIT,
  apiBase,
  configFor,
  listAccounts,
  readStore,
  removeAccount,
  useAccount,
} from "../config.js";
import { CommandError } from "../errors.js";
import { ansi } from "../ui/ansi.js";
import { present } from "../ui/present.js";

export const ACCOUNT_USAGE = "usage: mergestorm account list [--json] | use <name> | remove <name>";

export async function logoutAccount(name: string): Promise<string[]> {
  const store = await readStore();
  const cfg = configFor(store, Object.hasOwn(store.accounts, name) ? name : undefined);
  if (!cfg.account) await removeAccount(name);
  cfg.apiBase = apiBase(cfg);
  cfg.ignoreEnv = true;
  const revoked = await revokeOwnKey(cfg, { timeoutMs: 8_000 });
  const after = await removeAccount(name);
  const lines = [
    revoked
      ? `  Logged out ${name}. Its API key is revoked.`
      : `  Logged out ${name}. Its API key could not be revoked; revoke it at https://mergestorm.ai/settings#api if it should not stay valid.`,
  ];
  if (after.activeAccount) lines.push(`  Active account: ${after.activeAccount}`);
  else lines.push("  No accounts left. Run `mergestorm login` to sign in.");
  return lines;
}

async function accountList(asJson: boolean): Promise<void> {
  const accounts = await listAccounts();
  if (asJson) {
    console.log(
      JSON.stringify(
        { active: accounts.find((a) => a.active)?.name ?? null, limit: ACCOUNT_LIMIT, accounts },
        null,
        2,
      ),
    );
    return;
  }
  if (accounts.length === 0) {
    await present("Accounts", ["  No accounts. Run `mergestorm login` to sign in."]);
    return;
  }
  const width = Math.max(...accounts.map((a) => a.name.length));
  const lines = accounts.map((a) => {
    const mark = a.active ? ansi.brightGreen("●") : ansi.dim("○");
    const name = a.active ? ansi.bold(a.name.padEnd(width)) : a.name.padEnd(width);
    return `  ${mark} ${name}  ${ansi.dim(a.keyPrefix)}  ${ansi.dim(a.apiBase)}`;
  });
  lines.push(
    "",
    `  ${ansi.dim(`${accounts.length} of ${ACCOUNT_LIMIT} · account use <name> switches · --account <name> runs one command as another`)}`,
  );
  await present("Accounts", lines);
}

function nameArg(rest: string[], verb: string): string {
  const name = rest.find((arg) => !arg.startsWith("-"));
  if (!name) {
    throw new CommandError(`mergestorm account ${verb} needs an account name.\n${ACCOUNT_USAGE}`, 1, "usage");
  }
  return name;
}

export async function cmdAccount(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const [sub = "list", ...rest] = args.filter((arg) => arg !== "--json");
  if (sub === "list") {
    await accountList(asJson);
    return;
  }
  if (sub === "use") {
    const name = nameArg(rest, "use");
    await useAccount(name);
    await present("Account", [`  Active account: ${name}`]);
    return;
  }
  if (sub === "remove") {
    await present("Account", await logoutAccount(nameArg(rest, "remove")));
    return;
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log(ACCOUNT_USAGE);
    return;
  }
  throw new CommandError(`unknown account subcommand: ${sub}\n${ACCOUNT_USAGE}`, 1, "usage");
}
