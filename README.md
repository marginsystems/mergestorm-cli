# Mergestorm CLI

Review a local git diff with Mergestorm without opening a GitHub PR — for local loops and CI. Diffs are reviewed by the same engine as PR reviews and each review consumes one standard credit.

Requires **Node.js 22+**.

## Install

Recommended — install from npm (same package the one-liner uses):

```bash
npm install -g mergestorm
mergestorm --version   # confirm install
mergestorm login
# or the short alias (same binary):
mg login
```

Optional curl installer (checks Node 22+, then runs `npm install -g mergestorm`):

```bash
curl -fsSL https://mergestorm.ai/install.sh | bash
mergestorm login
```

After install, both `mergestorm` and `mg` invoke the same CLI.

## Source

This repository is the public source for the [`mergestorm`](https://www.npmjs.com/package/mergestorm) npm package (MIT). Tags match npm versions (`v0.3.9`, …).

```bash
git clone https://github.com/marginsystems/mergestorm-cli.git
cd mergestorm-cli
npm install
npm run build
node dist/cli.js --help
# optional local global link:
npm link
mergestorm
```

Development without a build step: `npm run dev`.

## Interactive shell

On a TTY, bare `mergestorm` (or `mergestorm shell`) opens a branded REPL: a **full-width** welcome panel (logo + status on the left, tips / what's new on the right) and a **full-width** bordered input box with a live `/` slash-command dropdown. Non-TTY (CI/pipes) prints usage instead — no hanging prompt.

```
╭─ mergestorm v0.3.9 ──────────────────────────────────────────────────────────╮
│      ▟██████████▛       Tips for getting started                             │
│       ▜████████▛          review      review origin/HEAD or main             │
│        ▝▜████▛▘           stack       create → submit → restack → land       │
│          ▜██▛             /help       list all commands                      │
│           ██                                                                 │
│           ▝▘            What's new in v0.3.9                                 │
│  ● msk…  ·  maelstrom     • MIT license + public source (mergestorm-cli)       │
│  [████░░░░░░░░░░] 12% used                                                   │
╰──────────────────────────────────────────────────────────────────────────────╯
mergestorm
╭──────────────────────────────────────────────────────────────────────────────╮
│ › /re                                                                        │
╰──────────────────────────────────────────────────────────────────────────────╯
  /review       Review git diff (default origin/HEAD or main or master)

mergestorm> credits
mergestorm> branches
mergestorm> chain
mergestorm> exit
```

Bare command names still work exactly as before (`review`, `help`, `exit`, …) — typing `/` at the start of a line just opens the live autocomplete dropdown (filtered as you type, navigate with Up/Down, accept with Tab/Enter/Right). Arrow-key history, Ctrl+A/E, Ctrl+U/K work as in a regular shell. At the idle prompt, **Ctrl+C twice** (within ~1.5s) exits the shell; a single Ctrl+C clears the line and shows a confirm hint. While `review` / `status` is waiting, Ctrl+C detaches or aborts that wait (job may keep running) — it does not exit the shell. Ctrl+D on an empty line, or `exit` / `quit`, also leave the shell. On a dumb terminal, without color, or when piped, the box falls back to plain ASCII borders (or no shell at all for non-TTY input).

`credits` / `usage` print a usage meter — long bar + `N% used`, then `Resets … (UTC)` — for standard and premium. `branches` (alias `chains`) lists recently reviewed branches; on a TTY you arrow-select one to open its review-chain timeline. `chain [slug]` shows that timeline directly (defaults to `local/<current-git-branch>`).

## Commands

One-shot subcommands work the same inside the shell and from argv (scripts/CI):

```
mergestorm                      Interactive shell (TTY only)
mergestorm shell                Explicit shell entry
mergestorm login                Sign in via browser; stores an API key in ~/.mergestorm/config.json
mergestorm login --key          Paste an existing API key instead (headless/CI)
mergestorm logout               Remove the stored API key
mergestorm review [base] [head] Review git diff base...head (default: origin/HEAD or main or master)
mergestorm status <job_id>      Fetch a review job and print JSON (one shot)
mergestorm credits [--json]     Standard + premium credit balance (usage bars)
mergestorm jobs [n] [--json]    Recent review jobs (default 10, max 50)
mergestorm branches [n]         Recently reviewed branches (arrow-pick on TTY)
mergestorm chain [slug]         Branch review-chain timeline (default: current branch)
mergestorm whoami [--json]      Key prefix, plan, API base, config path
mergestorm thread <slug>        Jobs in a review thread
mergestorm stack create [name]  New local stack layer (optional `--onto` / `--trunk`)
mergestorm stack submit         Push layers, open chained PRs (`gh`), register via adopt
mergestorm stack list [--json]  List registered stacks
mergestorm stack adopt <owner/repo>#<pr>  Import an existing open PR chain
mergestorm stack restack <stack-id>  Restack descendants
mergestorm stack land <stack-id>     Land / promote (into review unit when present)
mergestorm stack auto-promote on|off <stack-id>  Toggle auto-promote when green
mergestorm stack reset --force  Clear local authoring state (not branches/PRs)
```

`mg` is a short alias for `mergestorm` (same binary), e.g. `mg stack create`. Happy path: **create → commit → submit → restack → land**. On review-unit stacks, `stack land` **promotes** the tip into the unit (same gates as the dashboard); otherwise it lands the bottom open PR. `stack auto-promote` turns on land-when-green for a registered stack (`auto-land` remains a deprecated alias). `stack adopt` is for importing a chain that already exists on GitHub (legacy / Graphite). Restack/land use the same login key (`/api/v1/stacks`).

`stack create` is local-only: it checks out a new branch from the current tip (or `--onto <branch>`), discovers trunk (`main` / `master` / `origin/HEAD`, overridable with `--trunk`), and records `{ branch, parentBranch }` in CLI-managed state under **`~/.mergestorm/stacks/<repo-id>/stack.json`**. The CLI updates this automatically; never edit it. Linked worktrees share state, while independent clones remain isolated. Creating onto trunk with a non-empty active stack starts a new one. No repository file, GitHub call, or API call is made.

`stack submit` walks the **active** local stack: `git push -u origin` each layer, opens a PR with `gh` (`--base` = parent or trunk; skips heads that already have an open PR; body from the tip commit — Summary + Test plan, preserving Fixes/Closes/Resolves), registers the stack with `POST /api/v1/stacks/adopt` internally (Mergestorm API key), then drops that local stack entry so the next create onto trunk is clean. Push/PR auth is your local `git` + `gh auth` — not a GitHub App installation token.

Legacy repo-local `.mergestorm/stack.json` state migrates automatically on the next stack command. If local authoring state is stale or malformed, use `mg stack reset --force`; this clears only pre-submit CLI state and never deletes branches, PRs, or registered stacks.

### `login`

Runs a browser device-authorization flow: prints a short code, opens `https://mergestorm.ai/cli/auth`, and — once you approve — mints and stores an API key in `~/.mergestorm/config.json` (mode `600`). No key copy/paste needed.

For headless or CI environments, use `mergestorm login --key` to paste an existing `msk_live_…` key (create one on the dashboard [Settings → API](https://mergestorm.ai/settings#api)). On a TTY the paste is hidden (not echoed); the CLI verifies the key with the API before saving.

### `logout`

Removes `~/.mergestorm/config.json` so the stored key is no longer used.

### `review [base] [head]`

Collects `git diff base...head` (default: discovered trunk — `origin/HEAD`, `main`, or `master`), attaches the changed file contents (up to 40 files, skipping files > 400 KB), submits the job, and polls until it finishes (~3 min max). The thread slug is derived from the current branch (`local/<branch>`), so repeated runs on the same branch chain their findings. Programmatic callers can provide explicit review context through the Review Jobs API.

```bash
mergestorm review              # discovered trunk (origin/HEAD, main, or master)...HEAD
mergestorm review develop      # develop...HEAD
mergestorm review main feat/x  # main...feat/x
```

Exit code is non-zero on quota limit (402), submission failure, a `failed`/`quota_exceeded` job, or a poll timeout. In the interactive shell, Ctrl+C during the wait detaches (job keeps running) — use `status <job_id>` later.

### `status <job_id>`

Fetches a job by id and prints the raw JSON (status, verdict, summary, findings). In the shell, output is formatted for reading.

### `credits` / `jobs` / `whoami`

Require a logged-in key and API support for `GET /api/v1/me` and `GET /api/v1/reviews`. Older API deployments degrade gracefully (banner shows local key only).

### `branches` / `chain`

`branches` calls `GET /api/v1/threads` for recently active review threads (branches). On a TTY it opens an arrow-key selector; Enter loads that thread's job timeline. `chain [slug]` is the direct timeline view — omit the slug to use `local/<current-git-branch>` (same slug `review` stamps).

## Environment

| Variable | Purpose | Default |
|----------|---------|---------|
| `MERGESTORM_API_KEY` | API key (overrides the stored config) | — |
| `MERGESTORM_API_URL` | API base URL | `https://api.mergestorm.ai` |
| `NO_COLOR` | Disable ANSI colors | — |

## See also

- [Public source — mergestorm-cli](https://github.com/marginsystems/mergestorm-cli)
- [Docs — Review Jobs API & CLI](https://mergestorm.ai/docs#review-jobs-api) — product docs on the site.
- [npm — mergestorm](https://www.npmjs.com/package/mergestorm)
