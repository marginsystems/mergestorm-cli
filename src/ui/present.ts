import { showLinePanel } from "./line-tabs.js";

/**
 * The only way a shell command may show a result and return to home.
 * TTY: hold-to-read panel (q). Pipe: print the lines.
 *
 * Do not `console.log` then return from a shell command — the next
 * askLine homes + ED 0 and wipes it. Live waits (login poll, review
 * progress) may still write; the *final* result goes through here
 * or through `openTabsBrowser`.
 */
export async function present(title: string, lines: string[]): Promise<void> {
  await showLinePanel(title, lines);
}
