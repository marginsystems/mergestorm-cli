---
name: mergestorm-bounce-watch
description: Watch stacks explicitly named by the human while Auto land is on, and patch the current blocker after a bounce. Use for an ongoing stack watch, without taking over Cyclone or landing the stack.
---

# Mergestorm bounce watch

Use only these shipped Mergestorm MCP tools: `stack_wait`, `stack_status`, `queue_status`. Use local checkout, test, and Git operations to make the patch. Auto land owns landing.

## Scope and enrollment

Watch only stacks the human named. If no unambiguous stack ID is available, ask the human to identify it; do not discover and enroll other stacks. Keep a separate cursor for each named stack.

Call `stack_status` with `stack_id`. Require that stack's `autoEnqueueWhenReady` is `true` (Auto land on). If Auto land is off, missing, or cannot be verified, stop and tell the human. Never enable it yourself. Recheck this condition between wait slices and before patching or pushing. If Auto land is off when you recheck, call `queue_status` with the same `stack_id` and report the newest bounce (kind, PR, head, `finishedAt`) before stopping: `merge_failed`, `gh_error`, and `ci_timeout` can disarm Auto land. Stop when the stack is archived or its PRs are all merged or closed.

## Watch and patch

1. Call `stack_wait` with the named `stack_id` and `timeout_s: 45`. On initial enrollment, omit the cursor selectors. Save the returned `cursor`: map `cursor.enrolledHeadSha` to `enrolled_head_sha`, `cursor.afterFinishedAt` to `after_finished_at`, and `cursor.bounceId` to `bounce_id` (omit only absent fields; preserve explicit nulls). Keep `bounce_id` alongside `after_finished_at`; never pass one without the other when the returned cursor has both. The shipped tool accepts these selectors, not a nested cursor argument.
2. Keep the same cursor across retries. An unread deadline times out as `failed`; stop and report. Timeout `waiting` or `in_progress` after a snapshot is not failure — call `stack_wait` again in 45s slices with the same cursor after inspecting `issues[]`. Inspect `issues[]` on `in_progress` too: a live queue does not erase upstack hard blocks. `waiting` with issues is not idle. If `assessment` is `unavailable`, do not infer that the stack is issue-free; refresh `stack_status`, whose `attention`, `issues`, and `currentCandidate` come from the same blocker rules as `stack_wait`. Do not replace the enrolled head with a newer snapshot head or advance the timestamp just because a wait timed out. On a surfaced `rate_limited` error, honor the retry delay and retain the cursor; on `failed` or an unrecoverable tool error, stop and report the reason. `queue_status` returning `queue_entry_not_found` is not a failure: an empty queue for the stack is a normal wait.
3. On `attention`, fix the named PR: `prNumber` and `headSha` identify the blocked PR, while `currentCandidate` identifies the promote candidate. The gate covers the bottom and its direct child only when the child has current-head DIRTY on the live bottom branch. A GitHub DIRTY whose `parentBranch` starts with `mg-park-` is not that gate. Refresh `stack_status`; use `queue_status` with the same `stack_id` when bounce details are needed. Verify the blocker still applies to the current PR head. Never treat `verifyHeadSha` as the current head: it is a queue verification SHA and can be stale or synthetic. Compare the live PR branch head, the current stack layer head, and the checkout before editing. Read the live PR head with `git ls-remote origin refs/heads/<branch>` or `gh api repos/OWNER/REPO/pulls/N --jq .head.sha`. If you need CI logs, use `gh run list --branch <branch>`, `gh run view <run-id> --log-failed`, or `gh api repos/OWNER/REPO/commits/SHA/check-runs`. Read GitHub only through git and these REST calls; do not use other `gh pr` subcommands. Restack `clean` does not mean mergeable or CI-green. Attention is a diagnosis, not permission to mutate stack or queue policy.
4. Use a clean worktree on that named PR's head branch and record the remote starting SHA. Fix the current blocker with the smallest patch, and run the relevant checks. For conflicts, the live parent is the sibling PR head or the unit branch — not the DTO `parentBranch` when that field starts with `mg-park-*`. If `parentBranch` is `mg-park-*`, never merge or rebase onto it; if the real live parent is unknown, stop. Otherwise prefer merging that live parent into the PR branch, resolving locally, then an ordinary push. Never use Dashboard Continue. When the live parent is a sibling, never rebase onto trunk or `mg-stack-N` instead. Parked-freeze DIRTY alone needs no conflict patch.
5. CI-only fixes may run while Cyclone auto-patch is still on for the stack. When the gate is clean, inspect `issues[]` and fix a live upstack CI failure one PR at a time, refreshing the gate before the next PR. Do not use higher-layer bounce history as a patch target. Do not fight Cyclone: if the remote head moved, stop and tell the human. Do not take over Cyclone's review-finding work while it is active; if the blocker requires that or a policy/queue action rather than a concrete patch, stop and explain what needs human attention.
6. Recheck Auto land and the remote PR head (`git ls-remote origin refs/heads/<branch>`) immediately before pushing. Commit the patch and push the PR head with an ordinary push. A rebase onto that same live parent followed by force-with-lease is allowed only if the remote is still exactly the SHA you started from and Cyclone did not move it; use an explicit lease bound to that starting SHA. This exception never permits rebasing onto a parked freeze or substituting trunk / the unit for a sibling parent. If the remote head moved or the push is rejected because it moved, stop; do not rebase and retry.
7. After your successful push, leave a clean worktree and keep watching the named stack. Start a new watch cycle with `enrolled_head_sha` set to the SHA you pushed. If you handled a bounce, retain the returned `cursor.afterFinishedAt` as `after_finished_at` and `cursor.bounceId` as `bounce_id` so that attempt is not handled again. Keep these selectors unchanged across subsequent retries. Continue watching; do not enqueue or re-arm anything. If further progress requires re-arming, stop and tell the human.

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

- Do not land, merge PRs, enqueue, run `mg queue add`, `stack land`, or `land-unit`, or call `queue_enqueue` (not a shipped tool).
- Do not call `settings_set`, change account auto-patch settings, or turn account auto-patch off.
- Do not set `auto_patch: true` on a stack.
- Do not replace Cyclone or change stack auto-patch policy to take over its work.
- Do not auto re-arm Auto land or a bounced queue entry.
- Do not force-push except the same-live-parent rebase with the explicit starting-SHA lease above. Never rebase and retry after the remote head moved.
- Do not push any branch other than the named blocker's PR head (or the one selected live CI issue after the gate is clean).
