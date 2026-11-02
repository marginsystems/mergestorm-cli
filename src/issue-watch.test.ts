import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "./errors.js";
import { IssueReviewTimeoutError, type IssueReviewStatus, type IssueReviewWait } from "./api.js";
import { ISSUE_WATCH_EXIT, issueWatchLine, runIssueWatch } from "./issue-watch.js";

const CFG = { apiKey: "msk_live_test", apiBase: "https://api.example.test" };
const TARGET = { owner: "acme", repo: "widgets", number: 12 };

function wait(status: IssueReviewWait["status"], extra: Partial<IssueReviewWait> = {}): IssueReviewWait {
  return { status, reason: status, verdictRound: 1, verdictAt: null, answeredAt: null, retryAt: null, minutes: null, ...extra };
}

function review(w: IssueReviewWait, overrides: Partial<IssueReviewStatus> = {}): IssueReviewStatus {
  return {
    owner: "acme",
    repo: "widgets",
    number: 12,
    enabled: true,
    mode: "auto",
    state: "needs_answers",
    approvedBy: null,
    round: 1,
    maxRounds: 2,
    verdict: "needs_answers",
    summary: null,
    points: [],
    commentUrl: null,
    next: "",
    wait: w,
    ...overrides,
  };
}

function harness(script: Array<IssueReviewStatus | Error>) {
  let clock = 0;
  const lines: string[] = [];
  const markers: string[] = [];
  const polls: unknown[] = [];
  const opts = {
    write: (line: string) => lines.push(line),
    writeMarker: (line: string) => markers.push(line),
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    poll: async (_cfg: unknown, _target: unknown, pollOpts?: { timeoutMs?: number; afterRound?: number | null; waitingSince?: number }) => {
      polls.push({ afterRound: pollOpts?.afterRound, waitingSince: pollOpts?.waitingSince });
      const next = script.length > 1 ? script.shift()! : script[0]!;
      clock += Math.min(pollOpts?.timeoutMs ?? 0, 300_000);
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { opts, lines, markers, polls, clock: () => clock };
}

test("issue watch stays silent while the round runs and prints one READY line once approved", async () => {
  const pending = review(wait("answered_waiting_for_round"), { state: "pending" });
  const h = harness([
    new IssueReviewTimeoutError(pending),
    new IssueReviewTimeoutError(pending),
    review(wait("approved", { reason: "ready" }), { state: "approved", approvedBy: "vortex", verdict: "ready", next: "Open the PR with Fixes #12 in its body." }),
  ]);
  const result = await runIssueWatch(CFG, TARGET, { ...h.opts, afterRound: 1 });
  assert.equal(result.outcome, "ready");
  assert.equal(result.exitCode, ISSUE_WATCH_EXIT.ready);
  assert.equal(h.lines[0], "MS-ISSUE READY issue=12");
  assert.equal(h.lines.filter((line) => line.startsWith("MS-ISSUE")).length, 1);
  assert.deepEqual(h.polls, [
    { afterRound: 1, waitingSince: 0 },
    { afterRound: 1, waitingSince: 0 },
    { afterRound: 1, waitingSince: 0 },
  ]);
});

test("issue watch exits 3 with the POINTS line and the next watch command", async () => {
  const h = harness([review(wait("points", { verdictRound: 2 }), { round: 2 })]);
  const result = await runIssueWatch(CFG, TARGET, h.opts);
  assert.equal(result.exitCode, ISSUE_WATCH_EXIT.attention);
  assert.equal(h.lines[0], "MS-ISSUE POINTS issue=12 round=2");
  assert.match(h.lines.join("\n"), /`mergestorm issue watch 12 --repo acme\/widgets --after-round 2` once in the background/);
});

test("issue watch exits 3 with the STALLED line and its reason", async () => {
  const h = harness([review(wait("stalled", { reason: "unchanged", minutes: 11 }), { state: "pending" })]);
  const result = await runIssueWatch(CFG, TARGET, h.opts);
  assert.equal(result.outcome, "stalled");
  assert.equal(result.exitCode, ISSUE_WATCH_EXIT.attention);
  assert.equal(h.lines[0], "MS-ISSUE STALLED issue=12 round=1 minutes=11 reason=unchanged");
});

test("issue watch --json writes the marker to stderr and exactly one JSON document to stdout", async () => {
  const status = review(wait("points"));
  const h = harness([status]);
  await runIssueWatch(CFG, TARGET, { ...h.opts, json: true });
  assert.deepEqual(h.markers, ["MS-ISSUE POINTS issue=12 round=1"]);
  assert.equal(h.lines.length, 1);
  assert.deepEqual(JSON.parse(h.lines[0]!), status);
});

test("issue watch gives up after two permanent read failures", async () => {
  const h = harness([new CommandError("API key invalid", 1, "auth_invalid")]);
  const result = await runIssueWatch(CFG, TARGET, h.opts);
  assert.equal(result.outcome, "failed");
  assert.equal(result.exitCode, ISSUE_WATCH_EXIT.attention);
  assert.equal(h.polls.length, 2);
  assert.deepEqual(h.lines, ['MS-ISSUE ATTENTION failed issue=12 error="API key invalid"']);
});

test("issue watch rides out transient failures for 15 minutes, then reports them", async () => {
  const recovered = harness([new Error("fetch failed"), new Error("fetch failed"), review(wait("approved"), { state: "approved" })]);
  assert.equal((await runIssueWatch(CFG, TARGET, recovered.opts)).outcome, "ready");
  const down = harness([new Error("fetch failed")]);
  const result = await runIssueWatch(CFG, TARGET, down.opts);
  assert.equal(result.outcome, "failed");
  assert.ok(down.clock() >= 15 * 60_000);
  assert.match(down.lines[0]!, /^MS-ISSUE ATTENTION failed issue=12 error="No issue review read for 15 minutes: fetch failed"$/);
});

test("issue watch stops with TIMEOUT and exit 5 after --max", async () => {
  const h = harness([new IssueReviewTimeoutError(review(wait("round_running"), { state: "pending" }))]);
  const result = await runIssueWatch(CFG, TARGET, { ...h.opts, maxMs: 10 * 60_000 });
  assert.equal(result.exitCode, ISSUE_WATCH_EXIT.timeout);
  assert.deepEqual(h.lines, ["MS-ISSUE TIMEOUT issue=12 after=10m"]);
});

test("issueWatchLine is silent for the states that keep waiting", () => {
  assert.equal(issueWatchLine(review(wait("round_running"))), null);
  assert.equal(issueWatchLine(review(wait("answered_waiting_for_round"))), null);
});
