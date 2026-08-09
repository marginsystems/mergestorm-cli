import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CommandError } from "../errors.js";

/**
 * Read a single line without echoing characters (TTY).
 * Non-TTY (piped CI) falls back to a normal readline question.
 */
export async function readSecretLine(prompt: string): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const rl = createInterface({ input, output });
    try {
      return (await rl.question(prompt)).trim();
    } finally {
      rl.close();
    }
  }

  output.write(prompt);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();

  return await new Promise<string>((resolve, reject) => {
    const chars: string[] = [];

    const cleanup = (): void => {
      input.off("data", onData);
      input.off("error", onError);
      input.off("close", onClose);
      try {
        input.setRawMode(wasRaw ?? false);
      } catch {
        // ignore
      }
    };

    const onData = (buf: Buffer | string): void => {
      const s = typeof buf === "string" ? buf : buf.toString("utf8");
      for (const ch of s) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          output.write("\n");
          resolve(chars.join("").trim());
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new CommandError("Login cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          chars.pop();
          continue;
        }
        // Ignore other control chars; accept printable.
        if (ch >= " ") chars.push(ch);
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      output.write("\n");
      reject(err);
    };

    const onClose = (): void => {
      cleanup();
      output.write("\n");
      reject(new CommandError("Login cancelled."));
    };

    input.on("data", onData);
    input.on("error", onError);
    input.on("close", onClose);
  });
}
