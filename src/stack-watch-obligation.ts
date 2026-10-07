import type { StackDto } from "./stack-dto.js";

export const STACK_WATCH_NOT_DONE_SENTENCE =
  "This stack is not landed. Your task is not done. Call stack_wait again with this cursor.";

export const STACK_WATCH_NOTIFY_PATTERN = "MS-WATCH (ATTENTION|LANDED)";

export function stackWatchBackgroundCommand(stackId: string): string {
  return `mg stack watch ${stackId}`;
}

export type StackWatchDoneReason = "landed" | "closed" | "archived" | "not_found";

export type StackWatchReason =
  | StackWatchDoneReason
  | "open"
  | "attention"
  | "unread"
  | "rate_limited"
  | "failed"
  | "landing_unconfirmed";

export type StackWatchNextArgs = {
  stack_id: string;
  enrolled_head_sha?: string | null;
  after_finished_at?: string | null;
  bounce_id?: string | null;
  timeout_s: 45;
};

export type StackWatchNext = {
  tool: "stack_wait";
  args: StackWatchNextArgs;
  command: string;
  background: string;
};

export type StackWatchObligation = {
  done: boolean;
  until: "landed";
  reason: StackWatchReason;
  next: StackWatchNext | null;
  message: string;
};

export type StackWatchObligationInput = {
  stackId: string;
  terminal: StackWatchDoneReason | null;
  cursor?: {
    enrolledHeadSha?: string | null;
    afterFinishedAt?: string | null;
    bounceId?: string | null;
  } | null;
  status?: string;
  attention?: { prNumber: number; blocker: string } | null;
  retryAfterSeconds?: number;
  unread?: boolean;
  freshCursor?: boolean;
};

const DONE_MESSAGES: Readonly<Record<StackWatchDoneReason, string>> = {
  landed: "This stack is landed. The watch is done; stop calling stack_wait for it.",
  closed:
    "Every PR in this stack is merged or closed and nothing is left to land, but not every PR landed. The watch is done; tell the human which PRs were closed without landing.",
  archived:
    "This stack is archived: the human took it back. The watch is done; stop calling stack_wait for it and do not push to its PRs.",
  not_found:
    "No stack with this id exists for this account. Mergestorm deletes a stack once none of its layers is open, which can mean merged or closed; a mistyped id or another account's stack reads the same. Landing is unconfirmed. The watch is done; confirm each PR is merged (gh pr view <n> --json state) before reporting it landed.",
};

export function stackTerminalReason(
  stack: Pick<StackDto, "archivedAt" | "layers" | "unit"> | null | undefined,
): StackWatchDoneReason | null {
  if (!stack) return "not_found";
  if (stack.archivedAt) return "archived";
  const layers = stack.layers;
  if (layers.some((layer) => layer.state !== "merged" && layer.state !== "closed")) return null;
  const unit = stack.unit;
  if (layers.length === 0 && !unit) return null;
  const landPr = unit?.landPr;
  if (landPr && landPr.prNumber > 0 && landPr.state !== "merged" && landPr.state !== "closed") return null;
  if (unit && unit.state !== "landed" && unit.state !== "abandoned") return null;
  const everyLayerMerged = layers.every((layer) => layer.state === "merged");
  return everyLayerMerged && (!unit || unit.state === "landed") ? "landed" : "closed";
}

export function stackWatchNextArgs(
  stackId: string,
  cursor: StackWatchObligationInput["cursor"],
): StackWatchNextArgs {
  return {
    stack_id: stackId,
    ...(cursor && cursor.enrolledHeadSha !== undefined ? { enrolled_head_sha: cursor.enrolledHeadSha } : {}),
    ...(cursor && cursor.afterFinishedAt !== undefined ? { after_finished_at: cursor.afterFinishedAt } : {}),
    ...(cursor && cursor.bounceId !== undefined ? { bounce_id: cursor.bounceId } : {}),
    timeout_s: 45,
  };
}

export function stackWatchObligation(input: StackWatchObligationInput): StackWatchObligation {
  if (input.terminal) {
    return {
      done: true,
      until: "landed",
      reason: input.terminal,
      next: null,
      message: DONE_MESSAGES[input.terminal],
    };
  }
  const args = stackWatchNextArgs(input.stackId, input.cursor);
  const reason: StackWatchReason = input.status === "rate_limited"
    ? "rate_limited"
    : input.status === "failed"
      ? "failed"
      : input.attention ? "attention" : input.unread ? "unread" : "open";
  const background = stackWatchBackgroundCommand(input.stackId);
  const parts = [
    STACK_WATCH_NOT_DONE_SENTENCE,
    `If your host has a confirmed notification that resumes this task, run \`${background}\` as a background command, notify on output matching ${STACK_WATCH_NOTIFY_PATTERN}, and end your turn. The command monitors the stack; it cannot wake an agent by itself, and a process left running is not a notification. Without a confirmed notification, keep using stack_wait with the returned cursor, or report that automatic follow-up is unavailable before ending the turn.`,
    `Watch stack ${input.stackId} as a whole until it lands or the human takes it back. A clean push, a submit, or one merged layer does not finish it: merging a lower layer can break a layer above it.`,
  ];
  if (reason === "rate_limited") {
    parts.push(`Wait ${input.retryAfterSeconds !== undefined ? `${input.retryAfterSeconds}s` : "retry_after_seconds"} first, then call stack_wait with the same cursor.`);
  } else if (reason === "failed") {
    parts.push(`This read failed, which does not end the task. Call stack_wait once more with the same cursor; if that fails too, tell the human that stack ${input.stackId} is not landed and is no longer being watched.`);
  } else if (reason === "attention" && input.attention) {
    parts.push(`First fix #${input.attention.prNumber} (${input.attention.blocker}); repair, when present, names the fix. Calling stack_wait again before fixing it returns the same attention. After your push, call stack_wait with this cursor and enrolled_head_sha set to the SHA you pushed, or start \`${background} --head <pushed-sha>\` in the background.`);
  } else if (reason === "unread") {
    parts.push("This tool did not read the stack's state; stack_wait will.");
  }
  parts.push(`Next call: stack_wait ${JSON.stringify(args)}.`);
  if (input.freshCursor) {
    parts.push("If you already hold a cursor from an earlier stack_wait on this stack, keep passing that cursor instead.");
  }
  return {
    done: false,
    until: "landed",
    reason,
    next: { tool: "stack_wait", args, command: `mg stack wait ${input.stackId} --json`, background },
    message: parts.join(" "),
  };
}
