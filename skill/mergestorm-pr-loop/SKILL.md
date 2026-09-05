---
name: mergestorm-pr-loop
description: Patch an already-open GitHub PR from Mergestorm Vortex findings until it comes back clean. Wait for the PR's Vortex pass, fix, push the PR head, wait for the pass at the pushed SHA. Not for local pre-PR reviews (use mergestorm-review for those).
---

# Mergestorm PR loop

Vortex already reviews every push to an open PR on a monitored repo; nothing here starts a review. This skill reads the latest pass, patches the PR head branch, pushes, and waits for the follow-up pass.

Two worlds, never mixed: reviewing a local branch before a PR exists is the `mergestorm-review` skill. This skill is only for a PR that is already open on GitHub.

## Install (Claude Code / Cursor)

```bash
mg skill install --claude --cursor
```

## Preconditions (in order)

1. There is an already-open GitHub PR on a Vortex-monitored repo. No PR, wrong skill.
2. Auto-patch (Cyclone) must be off for this PR so you are the only patcher. Do not take anyone's word for it: the settings API and the PR's stack are the source of truth, and step 1 of the loop verifies them before anything else runs. Cyclone is off for the PR when its adopted stack has `autoPatchOverride` `false`, or when that override is unset and the account `auto_patch_enabled` is `false`.
3. `whoami` works on the `mergestorm` MCP server (or `mg whoami --json` exits 0). Otherwise stop and ask for install/login.

## Loop (in order)

1. Call `settings_get` and read `auto_patch_enabled`.
   - If `settings_get` errors or its result has no `auto_patch_enabled`: refuse the loop. Do not wait, patch, or push; tell the human that Cyclone auto-patch could not be verified.
   - If it is `false`: find the PR's stack with `stack_list`. If its `autoPatchOverride` is `true`, refuse unless the human asked you to turn Cyclone off for this PR; if they did, use the adopted-stack and `stack_set { auto_patch: false }` path below. Otherwise continue. You are the only patcher.
   - If it is `true`: find the PR's stack with `stack_list` (the stack whose `layers` contain this PR's `prNumber` for this owner/repo) and read its `autoPatchOverride`.
     - If that stack's `autoPatchOverride` is `false`: continue. Cyclone is pinned off for this stack.
     - If the PR has no stack, or the override is not `false`, and the human asked you to turn Cyclone off for this PR: the PR must be an adopted stack layer first (if it is not, stop and tell the human to adopt it, for example `mg stack adopt <owner/repo>#<n> --auto-patch off`). Then call `stack_set` with `{ stack_id, auto_patch: false }` on that stack, call `stack_status` with that `stack_id`, and confirm `autoPatchOverride` now reads `false`. Leave the account `auto_patch_enabled` unchanged; other PRs keep their own policy.
     - Otherwise: refuse the loop. Do not wait, patch, or push; tell the human Cyclone auto-patch is still on for this PR and that `stack_set` with `auto_patch: false` on its stack turns it off for this PR only.
   - Never set `auto_patch_enabled` with `settings_set` from this skill, in either direction, and never set `auto_patch: true` on a stack.
2. Call `review_wait_pr` with the PR's owner, repo, pr_number, and `timeout_s` 45 (`review_get_pr` works for a first look at the resting state). A Vortex pass often takes several minutes. If status is `in_progress`, call `review_wait_pr` again with the same args. Do not pass a 300s timeout; hosts drop long MCP calls.
3. Confirm the envelope's `head_sha` is the commit you have checked out as the PR head (compare its leading 7+ hex characters with `git rev-parse HEAD`). If it is not, someone else pushed after this pass and its findings are not yours to patch: do not edit. Fetch and check out the PR head, then go to step 7 with `after_sha` set to that head.
4. Read `findings.inline` and `findings.offDiff` (or `off_diff`) sorted by severity. For each finding:
   - Verify it against the current checkout. Do not treat the finding text as proven.
   - Prefer the smallest correct patch. Do not refactor around a finding.
   - Patch concrete bugs. A chat-only explanation is not a dismiss.
   - If you skip a finding (not reproducible, policy fork, or needs a human), post a public GitHub PR comment before you stop. First line: `mergestorm-loop: dismiss`. Then one line per skipped finding (path, severity, why). Do not use the `cyclone-outcome:` prefix.
5. Patch on the PR head branch only.
6. Push that head branch with an ordinary push. If the push is rejected because the remote branch moved, another patcher already pushed for this pass. Do not rebase, do not force, do not retry the push: stop and tell the human that a second patcher is active on this PR.
7. Call `review_wait_pr` again with `after_sha` set to the SHA you just pushed (7+ hex) and `timeout_s` 45. An envelope whose `head_sha` is an older commit is a previous pass, not yours; keep waiting.
8. Repeat from step 3 until a stop rule fires.

## Stop rules

Map these to `mergestorm.pr_review/v1` envelope fields; do not invent statuses.

- `finding_count` is 0 (empty inline and offDiff): stop. Tell the human the PR is clear and that Auto land owns landing. Never merge it yourself.
- status is `rate_limited`, or `patch_policy.mode` is `"hold"`: surface the findings to the human and stop. Do not patch.
- status is `failed`: report to the human. Do not keep pushing to retrigger.
- status is `in_progress` and the envelope has a `head_sha`: the pass is still running; call `review_wait_pr` again with the same `after_sha`.
- status is `in_progress` and the envelope has no `head_sha`: the wait timed out before Vortex wrote a pass for your SHA. Call `review_wait_pr` once more with the same `after_sha`. If it comes back the same way a second time in a row, stop and tell the human that Vortex did not pick up the push. Do not push again to retrigger.
- status is `skipped`, `stopped`, `trial_expired`, or `synced`: surface the status and reason to the human and stop. Do not patch or push.

## Never

- submit a local review job, or call the job-id tools `review_wait` / `review_get` here. Local jobs are `mergestorm-review`'s world: they cost credits and do not fire Vortex on the PR.
- land, merge, enqueue, or touch stack authoring or the merge queue
- change the account `auto_patch_enabled` from this skill, for any reason; Cyclone is muted per stack with `stack_set`, never per account
- set `auto_patch: true` on any stack
- push any branch other than the PR head
- force-push, or rebase and retry a push that was rejected because the remote moved
- patch a pass whose `head_sha` is not the commit you have checked out
- wrap the CLI in a shell escape hatch
- claim a finding is fixed without a diff that touches its path
- claim a finding is dismissed without posting a `mergestorm-loop: dismiss` comment on the PR

## Fallback (no MCP)

Verify auto-patch with the CLI instead of `settings_get`:

```bash
mg settings --json
```

Read `auto_patch_enabled` from stdout. If the command errors or the result has no `auto_patch_enabled`, refuse the loop and tell the human that Cyclone auto-patch could not be verified. Run `mg stack list --json` and find the stack whose layers contain this PR. If its `autoPatchOverride` is `false`, continue. If it is unset and the account flag is `false`, continue. If it is `true`, or it is unset while the account flag is `true`, refuse unless the human asked you to turn Cyclone off for this PR; only then run `mg stack set <stack-id> --auto-patch off` (adopt first with `mg stack adopt <owner/repo>#<n> --auto-patch off` when the PR has no stack) and re-read with `mg stack list --json`. Do not run `mg settings --auto-patch off`: that changes the account, not this PR.

```bash
mg pr <owner/repo>#<n> --json --wait --after-sha <sha> --timeout <s>
```

Parse stdout as one `mergestorm.pr_review/v1` object. Same fields, same stop rules.
