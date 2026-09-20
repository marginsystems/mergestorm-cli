---
name: mergestorm-bounce-watch
description: Watch stacks explicitly named by the human while Auto land is on, and patch the current blocker after a bounce. Use for an ongoing stack watch, without taking over Cyclone or landing the stack.
---

# Mergestorm bounce watch

Use only these shipped Mergestorm MCP tools: `stack_wait`, `stack_status`, `queue_status`. Use local checkout, test, and Git operations to make the patch. Auto land owns landing.

## Scope and enrollment

Watch only stacks the human named. If no unambiguous stack ID is available, ask the human to identify it; do not discover and enroll other stacks. Keep a separate cursor for each named stack.

Call `stack_status` with `stack_id`. Require that stack's `autoEnqueueWhenReady` is `true` (Auto land on). If Auto land is off, missing, or cannot be verified, stop and tell the human. Never enable it yourself. Recheck this condition between wait slices and before patching or pushing. Stop when the stack is archived or its PRs are all merged or closed.

## Watch and patch

1. Call `stack_wait` with the named `stack_id` and `timeout_s: 45`. On initial enrollment, omit the cursor selectors. Save the returned `cursor`: map `cursor.enrolledHeadSha` to `enrolled_head_sha`, `cursor.afterFinishedAt` to `after_finished_at`, and `cursor.bounceId` to `bounce_id` (omit only absent fields; preserve explicit nulls). The shipped tool accepts these selectors, not a nested cursor argument.
2. Keep the same cursor across retries. Timeout `waiting` is not failure — call `stack_wait` again in 45s slices with the same cursor. Do the same for `in_progress`. Do not replace the enrolled head with a newer snapshot head or advance the timestamp just because a wait timed out. On a surfaced `rate_limited` error, honor the retry delay and retain the cursor; on `failed` or an unrecoverable tool error, stop and report the reason.
3. On `attention`, inspect the current `blocker`, `prNumber`, `headSha`, and `bounceKind`. Refresh `stack_status`; use `queue_status` with the same `stack_id` when bounce details are needed. Verify the blocker still applies to the current PR head. Never treat `verifyHeadSha` as the current head: it is a queue verification SHA and can be stale or synthetic. Compare the live PR branch head, the current stack layer head, and the checkout before editing.
4. Fix the current blocker with the smallest patch on that PR's head branch, and run the relevant checks. CI-only fixes may run while Cyclone auto-patch is still on for the stack. Do not fight Cyclone: if the remote head moved, stop and tell the human. Do not take over Cyclone's review-finding work while it is active; if the blocker requires that or a policy/queue action rather than a concrete patch, stop and explain what needs human attention.
5. Recheck Auto land and the remote PR head immediately before pushing. Commit the patch and push the PR head with an ordinary push. If the remote head moved or the push is rejected because it moved, stop. Do not rebase and retry or force-push.
6. After your successful push, start a new watch cycle for that named stack with `enrolled_head_sha` set to the SHA you pushed. If you handled a bounce, retain its `finishedAt` as `after_finished_at` so that attempt is not handled again. Keep these selectors unchanged across subsequent retries. Continue watching; do not enqueue or re-arm anything. If further progress requires re-arming, stop and tell the human.

## Bounce kinds

The kind list is exactly `MERGE_QUEUE_BOUNCE_KINDS` from stack-dto:

- `ci_failure`
- `ci_timeout`
- `head_moved`
- `tempest_findings`
- `seam_findings`
- `restack_conflict`
- `pr_draft`
- `must_consolidate`
- `merge_failed`
- `gh_error`

A kind is context, not permission to mutate queue or stack policy. Diagnose the current blocker rather than blindly retrying its old bounce. A head-moved bounce requires stopping if another actor moved the PR head; a timeout alone does not justify a code change. If there is no concrete patch within this scope, report the blocker and stop.

## Never

- Do not land, merge, enqueue, run `mg queue add`, `stack land`, or `land-unit`, or call `queue_enqueue` (not a shipped tool).
- Do not call `settings_set`, change account auto-patch settings, or turn account auto-patch off.
- Do not set `auto_patch: true` on a stack.
- Do not replace Cyclone or change stack auto-patch policy to take over its work.
- Do not auto re-arm Auto land or a bounced queue entry.
- Do not force-push (including force-with-lease), or rebase and retry after the remote head moved.
- Do not push any branch other than the current blocker's PR head.
