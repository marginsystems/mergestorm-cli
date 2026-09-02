---
name: mergestorm-review
description: Review a local branch with Mergestorm Vortex specialists before opening a PR, then apply the findings yourself.
---

# Mergestorm review

Use this skill to review a local git branch with Mergestorm, then apply the findings yourself.

## When to use

Before opening a PR; after a large refactor; when the user says review, audit, second opinion, or "is this safe to merge".

Not for merging, landing, or pushing. For a PR that is already open on GitHub, use the `mergestorm-pr-loop` skill instead.

## Install (Claude Code / Cursor)

```bash
mg skill install --claude
mg skill install --cursor
# or both: mg skill install --claude --cursor
```

That writes `.claude/skills/mergestorm-review/SKILL.md` and/or `.cursor/skills/mergestorm-review/SKILL.md` in the current repo.

Hand-copy still works: Claude Code project skill `.claude/skills/mergestorm-review/SKILL.md` (or `~/.claude/skills/mergestorm-review/SKILL.md`). Cursor: the same file under `.cursor/skills/mergestorm-review/SKILL.md`; otherwise a rule at `.cursor/rules/mergestorm-review.mdc` with this description and `alwaysApply: false`.

MCP server:

```bash
curl -fsSL https://mergestorm.ai/install.sh | bash -s -- --mcp
# or: npm i -g mergestorm mergestorm-mcp
claude mcp add mergestorm -- npx -y mergestorm-mcp
```

Cursor `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mergestorm": {
      "command": "npx",
      "args": ["-y", "mergestorm-mcp"]
    }
  }
}
```

## Preconditions

1. Prefer the `mergestorm` MCP server. Call `whoami`. If MCP is missing, require `mg` on PATH with `mg whoami --json` exit 0. If neither is available, stop and print the install one-liner above.
2. Call `credits` (or `mg credits --json`). If remaining standard credits are 0, say so and stop.

## Hire policy

Default: omit `router` (account setting).

- `router: "off"` for tiny diffs or docs-only
- `manual` with pins when the change is clearly one domain: `security` (auth/crypto/input), `frontend` (components), `data` (migrations), `api` (route contracts), `tests` (mostly tests), `performance` (hot paths), `architecture` (cross-module moves)
- `max` only when the user asks for a full pass
- Never request `governance` or `seam`. Neither exists for local reviews. Seam runs automatically during Mergestorm stack promotes and is controlled by the Agents settings toggle (default on).

## Submit

Call `review_submit` on the repo cwd (git collect when `diff` is omitted). Pass one or two sentences of intent in `context`. Pass an ADR or spec as `context_files` when one exists in the repo under review — never from outside it. Do not paste the diff into context.

Optional: `thread`, `idempotency_key`, `wait`, `timeout_s`. Default wait is 300s; on timeout the tool returns `status: in_progress` and the job id — then call `review_wait`.

Use `review_get` or `review_list` to resume a known job.

Status handling:

- status is `no_changes`: success. The branch matches the selected base, no review job was submitted, and no review credit was used. Stop unless the user expected a different base.
- status is `rate_limited`: wait `retry_after_seconds`. Use `review_list`, `review_get`, or `review_wait` for an existing in-flight job before resubmitting. Do not immediately resubmit the same diff.

## Apply findings

Read `findings.inline` (and `off_diff` / `offDiff`) sorted by severity. Fix or explain each. Never silence a finding by deleting the test. Then submit again on the same branch so the thread chains, with `context` stating what was addressed.

## Never

- land, merge, push, or open a PR
- call stack authoring or land commands
- wrap the CLI in a shell escape hatch
- claim a finding is fixed without a diff that touches its path
- resubmit an identical failing diff (that burns a credit)
- treat `no_changes` or `rate_limited` as a failed review that needs an immediate resubmit
- pass `--context-file` or `--context` contents from outside the repo under review

## Fallback (no MCP)

```bash
mg review --json --context "…"
# optional: --router … --specialists … --context-file … --thread … --wait / --no-wait --timeout
# context files must live inside the repo under review
```

Parse stdout as one JSON object (`mergestorm.review_job/v1`). Exit 0 includes `no_changes`. Exit 5 means detach and poll with `mg status <id> --json --wait`. Exit 7 means `rate_limited`: wait `retry_after_seconds` before trying again.
