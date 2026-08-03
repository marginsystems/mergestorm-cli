/** Window (ms) for a second Ctrl+C to confirm shell exit. */
export const CTRL_C_CONFIRM_MS = 1500;

/**
 * Tracks consecutive Ctrl+C presses. First press arms a confirm window;
 * a second press within {@link CTRL_C_CONFIRM_MS} means exit.
 */
export class CtrlCExitGate {
  private lastAt = 0;

  /** @returns true when the caller should exit the shell */
  press(now = Date.now()): boolean {
    if (this.lastAt > 0 && now - this.lastAt <= CTRL_C_CONFIRM_MS) {
      this.lastAt = 0;
      return true;
    }
    this.lastAt = now;
    return false;
  }

  reset(): void {
    this.lastAt = 0;
  }
}

export const CTRL_C_EXIT_HINT = "Press Ctrl+C again to exit";
