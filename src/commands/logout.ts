import { loadConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { present } from "../ui/present.js";
import { logoutAccount } from "./account.js";

export async function cmdLogout(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.account) {
    throw new CommandError("Not logged in. Nothing to log out of.");
  }
  await present("Logout", await logoutAccount(cfg.account));
}
