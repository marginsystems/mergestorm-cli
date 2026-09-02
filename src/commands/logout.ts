import { clearConfig } from "../config.js";
import { CommandError } from "../errors.js";
import { present } from "../ui/present.js";

export async function cmdLogout(): Promise<void> {
  try {
    await clearConfig();
    await present("Logout", ["  Logged out. Removed stored API key."]);
  } catch (err) {
    throw new CommandError(
      `Could not remove config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
