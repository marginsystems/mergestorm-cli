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
3. The Bearer key and the Cyclone GitHub App install must be the same Mergestorm account. `stack_list` / `stack_status` expose `keyUserId`, `cycloneInstallUserId`, and `cycloneOwnerMatch`. Cyclone apply always uses the install account, not the key. If those identities differ, your `settings_get` mute reading is about the wrong person.
4. `whoami` works on the `mergestorm` MCP server (or `mg whoami --json` exits 0). Otherwise stop and ask for install/login.

## Loop (in order)

1. Find the PR's stack with `stack_list` (the stack whose `layers` contain this PR's `prNumber` for this owner/repo). If you already have its `stack_id`, `stack_status` is the same payload.
   - If there is no stack and the human asked you to mute Cyclone or continue the loop: call `stack_adopt` with `{ owner, repo, pr_number, auto_patch: false }` (equivalent to `mg stack adopt … --auto-patch off`). Then call `stack_status` with the returned `result.stack.id`, confirm this PR is in the stack and `autoPatchOverride` is `false`. If adoption or verification fails, refuse the loop. Otherwise continue through the ownership check below and the remaining loop steps; do not stop and ask the human to adopt. Do not turn account auto-patch off.
   - Adoption does not fix installer ≠ key. After adoption, the same `cycloneOwnerMatch` refusal below still applies.
   - Read `cycloneOwnerMatch` on that stack. If it is missing, `lookup_failed`, or `different`: refuse the loop. Do not wait, patch, or push. Tell the human the API key and the Cyclone GitHub App install are different Mergestorm accounts (or the comparison could not be loaded). Cyclone still patches as the installer. Do not turn account auto-patch off, and do not set `auto_patch: false` to paper over this.
   - If it is `same` or `none`: continue. `none` means no Cyclone install monitors this repo.
2. Call `settings_get` and read `auto_patch_enabled`.
   - If `settings_get` errors or its result has no `auto_patch_enabled`: refuse the loop. Do not wait, patch, or push; tell the human that Cyclone auto-patch could not be verified.
   - If it is `false`: read `autoPatchOverride` on the stack from step 1. If it is `true`, refuse unless the human asked you to turn Cyclone off for this PR; if they did, use the `stack_set { auto_patch: false }` path below. Otherwise continue. You are the only patcher.
   - If it is `true`: read `autoPatchOverride` on that same stack.
     - If `autoPatchOverride` is `false`: continue. Cyclone is pinned off for this stack.
     - If the override is not `false` and the human asked you to turn Cyclone off for this PR: call `stack_set` with `{ stack_id, auto_patch: false }` on that stack, call `stack_status` with that `stack_id`, and confirm `autoPatchOverride` now reads `false`. Leave the account `auto_patch_enabled` unchanged; other PRs keep their own policy.
     - Otherwise: refuse the loop. Do not wait, patch, or push; tell the human Cyclone auto-patch is still on for this PR and that `stack_set` with `auto_patch: false` on its stack turns it off for this PR only.
   - Never set `auto_patch_enabled` with `settings_set` from this skill, in either direction, and never set `auto_patch: true` on a stack.
3. Call `review_wait_pr` with the PR's owner, repo, pr_number, and `timeout_s` 45 (`review_get_pr` works for a first look at the resting state). A Vortex pass often takes several minutes. If status is `in_progress`, call `review_wait_pr` again with the same args. Do not pass a 300s timeout; hosts drop long MCP calls. Review identity is SHA + pass: every envelope carries `head_sha` and `pass` (1 for the first review on a head; a re-review on the same head is the next pass, its own row). Save the `pass` of every resting envelope you act on together with its `head_sha`.
4. Confirm the envelope's `head_sha` is the commit you have checked out as the PR head (compare its leading 7+ hex characters with `git rev-parse HEAD`). If it is not, someone else pushed after this pass and its findings are not yours to patch: do not edit. Fetch and check out the PR head, then go to step 8 with `after_sha` set to that head.
5. Read `findings.inline` and `findings.offDiff` (or `off_diff`) sorted by severity. For each finding:
   - Verify it against the current checkout. Do not treat the finding text as proven.
   - Prefer the smallest correct patch. Do not refactor around a finding.
   - Patch concrete bugs. A chat-only explanation is not a dismiss.
   - If you skip a finding (not reproducible, policy fork, or needs a human), post a public GitHub PR comment before you stop. First line: `mergestorm-loop: dismiss`. Then one line per skipped finding (path, severity, why). That first line is the only dismiss marker Vortex reads.
6. Patch on the PR head branch only.
7. Push that head branch with an ordinary push. If the push is rejected because the remote branch moved, another patcher already pushed for this pass. Do not rebase, do not force, do not retry the push: stop and tell the human that a second patcher is active on this PR.
8. Call `review_wait_pr` again with `after_sha` set to the SHA you just pushed (7+ hex) and `timeout_s` 45. If the last envelope you acted on has that same `head_sha` (no new commit, for example a re-review requested on the same head), also pass `after_pass` set to that envelope's saved `pass`, so the wait cannot hand you that attempt again. For a freshly pushed SHA omit `after_pass`; its first pass is 1. Keep `after_sha` and `after_pass` unchanged across 45s timeout retries; never replace `after_pass` with the `pass` of an in-progress envelope. `review_get_pr` accepts the same `after_sha`, `pass`, and `after_pass` filters. An envelope whose `head_sha` is an older commit is a previous pass, not yours; keep waiting.
9. Repeat from step 4 until a stop rule fires.

## Stop rules

Map these to `mergestorm.pr_review/v1` envelope fields; do not invent statuses.

- `finding_count` is 0 (empty inline and offDiff): stop. Tell the human the PR is clear and that Auto land owns landing. Never merge it yourself.
- status is `rate_limited`, or `patch_policy.mode` is `"hold"`: surface the findings to the human and stop. Do not patch.
- status is `failed`: report to the human. Do not keep pushing to retrigger.
- status is `in_progress` and the envelope has a `head_sha`: the pass is still running; call `review_wait_pr` again with the same `after_sha` and the same `after_pass`.
- status is `in_progress` and the envelope has no `head_sha`: the wait timed out before Vortex wrote a pass for your SHA. Call `review_wait_pr` once more with the same `after_sha` and the same `after_pass`. If it comes back the same way a second time in a row, stop and tell the human that Vortex did not pick up the push. Do not push again to retrigger.
- status is `skipped`, `stopped`, `trial_expired`, or `synced`: surface the status and reason to the human and stop. Do not patch or push.

## Never

- submit a local review job, or call the job-id tools `review_wait` / `review_get` here. Local jobs are `mergestorm-review`'s world: they cost credits and do not fire Vortex on the PR.
- land, merge, enqueue, or touch stack authoring beyond adopting the existing PR, or the merge queue
- change the account `auto_patch_enabled` from this skill, for any reason; Cyclone is muted per stack with `stack_adopt` or `stack_set`, never per account
- treat the key user's mute or `auto_patch_enabled` as covering a different Cyclone install user
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

Read `auto_patch_enabled` from stdout. If the command errors or the result has no `auto_patch_enabled`, refuse the loop and tell the human that Cyclone auto-patch could not be verified. Run `mg stack list --json` and find the stack whose layers contain this PR. If there is no stack, or its `cycloneOwnerMatch` is missing, `lookup_failed`, or `different`, refuse the loop. Tell the human the API key and the Cyclone install are different accounts (or adopt first, or the lookup failed). Do not run `mg settings --auto-patch off`. If `cycloneOwnerMatch` is `same` or `none` and `autoPatchOverride` is `false`, continue. If it is unset and the account flag is `false`, continue. If it is `true`, or it is unset while the account flag is `true`, refuse unless the human asked you to turn Cyclone off for this PR; only then run `mg stack set <stack-id> --auto-patch off` and re-read with `mg stack list --json`.

```bash
mg pr <owner/repo>#<n> --json --wait --after-sha <sha> --after-pass <saved-pass> --timeout <s>
```

Parse stdout as one `mergestorm.pr_review/v1` object. Same fields, same stop rules. `--after-pass` follows the same rule as `after_pass` above: only when the last envelope you acted on is on that same `head_sha`; omit it for a freshly pushed SHA. `--pass <n>` reads one exact attempt on the head.
