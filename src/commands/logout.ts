import { clearConfig } from "../config.js";
import { CommandError } from "../errors.js";

export async function cmdLogout(): Promise<void> {
  try {
    await clearConfig();
    console.log("Logged out. Removed stored API key.");
  } catch (err) {
    throw new CommandError(
      `Could not remove config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
