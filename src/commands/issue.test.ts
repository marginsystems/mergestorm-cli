import assert from "node:assert/strict";
import { test } from "node:test";
import { IssueReviewTimeoutError, type IssueReviewStatus } from "../api.js";
import { CommandError, REVIEW_EXIT } from "../errors.js";
import { cmdIssue, parseIssueCreateArgs, parseIssueWaitArgs, parseIssueWatchArgs } from "./issue.js";

const CFG = { apiKey: "msk_live_test", apiBase: "https://api.example.test" };

async function capture(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test("parseIssueCreateArgs reads title, body, labels, repo and json", () => {
  assert.deepEqual(
    parseIssueCreateArgs(["--title", " Fix it ", "--body", "Details", "--label", "needs, design", "--label", "vortex", "--repo", "acme/widgets", "--json"]),
    { title: "Fix it", body: "Details", labels: ["needs, design", "vortex"], repo: { owner: "acme", repo: "widgets" }, json: true },
  );
  assert.deepEqual(parseIssueCreateArgs(["--title", "T", "--body-file", "body.md"], (path) => `from ${path}`), {
    title: "T",
    body: "from body.md",
    labels: [],
    json: false,
  });
});

test("parseIssueCreateArgs rejects a missing title, both body sources, a bad repo and unknown flags", () => {
  for (const args of [
    [],
    ["--title"],
    ["--title", "T", "--body", "a", "--body-file", "b"],
    ["--title", "T", "--repo", "widgets"],
    ["--title", "T", "--assignee", "me"],
  ]) {
    assert.throws(
      () => parseIssueCreateArgs(args, () => "x"),
      (err) => err instanceof CommandError && err.code === "usage" && /usage: mergestorm issue create/.test(err.message),
      args.join(" "),
    );
  }
});

test("issue create opens the issue on the origin repository through Mergestorm and prints the Fixes line", async () => {
  const sent: unknown[] = [];
  const lines = await capture(() =>
    cmdIssue(["create", "--title", "Fix it", "--body", "Details", "--label", "bug"], {
      loadConfig: async () => CFG,
      parseGithubOriginRepo: () => ({ owner: "acme", repo: "widgets" }),
      openStackIssue: async (input, cfg) => {
        sent.push({ cfg, input });
        return { number: 12, url: "https://github.com/acme/widgets/issues/12", created: true };
      },
    }),
  );
  assert.deepEqual(sent, [{ cfg: CFG, input: { owner: "acme", repo: "widgets", title: "Fix it", body: "Details", labels: ["bug"] } }]);
  assert.deepEqual(lines, [
    "Opened acme/widgets#12  https://github.com/acme/widgets/issues/12",
    "Put `Fixes #12` in the commit or pull request body.",
  ]);
});

test("issue create --json names the repository and whether the issue is new, and --repo wins over origin", async () => {
  const lines = await capture(() =>
    cmdIssue(["create", "--title", "Fix it", "--repo", "other/repo", "--json"], {
      loadConfig: async () => CFG,
      parseGithubOriginRepo: () => {
        throw new Error("origin must not be read when --repo is given");
      },
      openStackIssue: async () => ({ number: 12, url: "u", created: false }),
    }),
  );
  assert.deepEqual(JSON.parse(lines.join("\n")), { owner: "other", repo: "repo", number: 12, url: "u", created: false });
});

test("issue without a repository or with an unknown subcommand fails with a reason", async () => {
  await assert.rejects(
    () => cmdIssue(["create", "--title", "T"], { loadConfig: async () => CFG, parseGithubOriginRepo: () => null }),
    /Pass --repo <owner\/repo>/,
  );
  await assert.rejects(() => cmdIssue(["close", "12"]), /unknown issue subcommand: close/);
});

test("issue create --help prints the usage and opens nothing", async () => {
  for (const args of [["create", "--help"], ["create", "-h"], ["create", "--title", "T", "--help"], ["--help"], []]) {
    const lines = await capture(() =>
      cmdIssue(args, {
        loadConfig: async () => CFG,
        parseGithubOriginRepo: () => ({ owner: "acme", repo: "widgets" }),
        openStackIssue: async () => {
          throw new Error("no issue may be opened when help is asked for");
        },
      }),
    );
    assert.match(lines.join("\n"), /^usage: mergestorm issue create/, args.join(" "));
  }
});

function waitFor(state: IssueReviewStatus["state"], round: number | null): IssueReviewStatus["wait"] {
  const status = state === "needs_answers" ? "points" : state === "pending" || state === "unreviewed" ? "round_running" : "approved";
  return { status, reason: state, verdictRound: round, verdictAt: null, answeredAt: null, retryAt: null, minutes: null };
}

function review(overrides: Partial<IssueReviewStatus> = {}): IssueReviewStatus {
  return {
    owner: "acme",
    repo: "widgets",
    number: 12,
    enabled: true,
    mode: "auto",
    state: "needs_answers",
    approvedBy: null,
    round: 1,
    maxRounds: 4,
    verdict: "needs_answers",
    summary: null,
    points: [{ kind: "question", text: "Which repo?" }],
    commentUrl: "https://github.com/acme/widgets/issues/12#issuecomment-1",
    next: "Answer the point in a comment on #12.",
    wait: waitFor(overrides.state ?? "needs_answers", overrides.round === undefined ? 1 : overrides.round),
    ...overrides,
  };
}

const WAIT_DEPS = {
  loadConfig: async () => CFG,
  parseGithubOriginRepo: () => ({ owner: "acme", repo: "widgets" }),
};

test("parseIssueWaitArgs reads the number, repo, timeout and json, and refuses anything else", () => {
  assert.deepEqual(parseIssueWaitArgs(["#12", "--repo", "o/r", "--timeout", "30", "--json"]), {
    number: 12,
    repo: { owner: "o", repo: "r" },
    timeoutMs: 30_000,
    json: true,
  });
  assert.deepEqual(parseIssueWaitArgs(["7"]), { number: 7, timeoutMs: 900_000, json: false });
  assert.deepEqual(parseIssueWaitArgs(["7", "--after-round", "2"]), { number: 7, timeoutMs: 900_000, json: false, afterRound: 2 });
  assert.deepEqual(parseIssueWaitArgs(["7", "--after-round", "2", "--waiting-since", "1793944800000"]), {
    number: 7,
    timeoutMs: 900_000,
    json: false,
    afterRound: 2,
    waitingSince: 1793944800000,
  });
  for (const args of [[], ["x"], ["0"], ["7", "8"], ["7", "--timeout", "0"], ["7", "--wait"], ["7", "--after-round"], ["7", "--after-round", "0"], ["7", "--after-round", "x"], ["7", "--waiting-since"], ["7", "--waiting-since", "soon"], ["7", "--waiting-since", "0"]]) {
    assert.throws(() => parseIssueWaitArgs(args), (err) => err instanceof CommandError && err.code === "usage", args.join(" "));
  }
  assert.throws(() => parseIssueCreateArgs(["--title", "T", "--timeout", "5"]), /--timeout requires --wait/);
});

test("issue wait polls the origin repository's issue and exits 0 once it is approved", async () => {
  const polled: unknown[] = [];
  const lines = await capture(() =>
    cmdIssue(["wait", "12", "--timeout", "60"], {
      ...WAIT_DEPS,
      pollIssueReview: async (cfg, target, opts) => {
        polled.push({ cfg, target, timeoutMs: opts?.timeoutMs });
        return review({ state: "approved", approvedBy: "human", verdict: null, points: [], next: "Open the pull request with Fixes #12." });
      },
    }),
  );
  assert.deepEqual(polled, [{ cfg: CFG, target: { owner: "acme", repo: "widgets", number: 12 }, timeoutMs: 60_000 }]);
  assert.deepEqual(lines, [
    "Waiting for the next Vortex verdict on acme/widgets#12 …",
    "acme/widgets#12 is approved by a person.",
    "Open the pull request with Fixes #12.",
  ]);
});

test("issue wait exits 0 when the review failed, and says it does not hold the pull request back", async () => {
  const failed = review({ state: "approved", approvedBy: null, verdict: null, points: [], next: "Open the PR with Fixes #12 in its body." });
  const lines = await capture(() => cmdIssue(["wait", "12"], { ...WAIT_DEPS, pollIssueReview: async () => failed }));
  assert.deepEqual(lines, [
    "Waiting for the next Vortex verdict on acme/widgets#12 …",
    "The Vortex review of acme/widgets#12 failed, so it does not hold the pull request back.",
    "Open the PR with Fixes #12 in its body.",
  ]);
});

test("issue wait exits 0 when issue reviews are off and prints the endpoint JSON with --json", async () => {
  const body = review({ enabled: false, state: "off", verdict: null, points: [], commentUrl: null, round: null });
  const lines = await capture(() => cmdIssue(["wait", "12", "--json"], { ...WAIT_DEPS, pollIssueReview: async () => body }));
  assert.deepEqual(JSON.parse(lines.join("\n")), body);
});

test("issue wait in mention mode exits 0 for an issue no one has tagged Vortex on, and still fails on a blocking round", async () => {
  const unreviewed = review({ mode: "mention", state: "unreviewed", verdict: null, points: [], commentUrl: null, round: null, next: "Tag @mergestorm-vortex to review it." });
  const lines = await capture(() => cmdIssue(["wait", "12"], { ...WAIT_DEPS, pollIssueReview: async () => unreviewed }));
  assert.deepEqual(lines.slice(1), ["Issue reviews for acme/widgets run on mention; #12 needs no approval.", "Tag @mergestorm-vortex to review it."]);
  let thrown: unknown;
  await capture(async () => {
    try {
      await cmdIssue(["wait", "12"], { ...WAIT_DEPS, pollIssueReview: async () => review({ mode: "mention" }) });
    } catch (err) {
      thrown = err;
    }
  });
  assert.ok(thrown instanceof CommandError);
  assert.equal(thrown.code, "issue_not_approved");
});

test("issue wait lists the points to answer and exits with the findings code for every unapproved state", async () => {
  for (const state of ["needs_answers", "capped", "unreviewed"] as const) {
    let thrown: unknown;
    await capture(async () => {
      try {
        await cmdIssue(["wait", "12"], { ...WAIT_DEPS, pollIssueReview: async () => review({ state, wait: waitFor("needs_answers", 1) }) });
      } catch (err) {
        thrown = err;
      }
    });
    assert.ok(thrown instanceof CommandError, state);
    assert.equal(thrown.exitCode, REVIEW_EXIT.failed);
    assert.equal(thrown.code, "issue_not_approved");
    assert.equal(
      thrown.message,
      [
        "Vortex has not approved acme/widgets#12 yet.",
        `acme/widgets#12: ${state} (round 1 of 4)`,
        "  1. [question] Which repo?",
        "  Review: https://github.com/acme/widgets/issues/12#issuecomment-1",
        "  Next: Answer the point in a comment on #12.",
        state === "needs_answers"
          ? "  Reply once in a comment on #12, accepting each blocking point's suggested fix or saying why not; then run `mergestorm issue wait 12 --repo acme/widgets --after-round 1` once."
          : "  Run `mergestorm issue wait 12 --repo acme/widgets --after-round 1` once.",
      ].join("\n"),
    );
  }
});

test("issue wait --json prints the JSON and still exits with the findings code", async () => {
  let thrown: unknown;
  const lines = await capture(async () => {
    try {
      await cmdIssue(["wait", "12", "--json"], { ...WAIT_DEPS, pollIssueReview: async () => review() });
    } catch (err) {
      thrown = err;
    }
  });
  assert.deepEqual(JSON.parse(lines.join("\n")), review());
  assert.ok(thrown instanceof CommandError && thrown.exitCode === REVIEW_EXIT.failed);
});

test("issue wait passes the round cursor and wait start through and prints the next command with it", async () => {
  const cursors: unknown[] = [];
  let thrown: unknown;
  const lines = await capture(async () => {
    try {
      await cmdIssue(["wait", "12", "--after-round", "1", "--waiting-since", "1793944800000"], {
        ...WAIT_DEPS,
        pollIssueReview: async (_cfg, _target, opts) => {
          cursors.push(opts?.afterRound, opts?.waitingSince);
          return review({ round: 2 });
        },
      });
    } catch (err) {
      thrown = err;
    }
  });
  assert.deepEqual(cursors, [1, 1793944800000]);
  assert.equal(lines[0], "Waiting for the next Vortex verdict on acme/widgets#12 after round 1 …");
  assert.ok(thrown instanceof CommandError && thrown.exitCode === REVIEW_EXIT.failed);
  assert.match(thrown.message, /`mergestorm issue wait 12 --repo acme\/widgets --after-round 2` once\./);
});

test("issue wait exits with the stalled code and one MS-ISSUE STALLED line when no round started", async () => {
  const stalled = review({
    state: "pending",
    wait: { status: "stalled", reason: "unchanged", verdictRound: 1, verdictAt: null, answeredAt: "2026-11-02T06:24:54Z", retryAt: null, minutes: 14 },
  });
  let thrown: unknown;
  const lines = await capture(async () => {
    try {
      await cmdIssue(["wait", "12", "--after-round", "1"], { ...WAIT_DEPS, pollIssueReview: async () => stalled });
    } catch (err) {
      thrown = err;
    }
  });
  assert.ok(thrown instanceof CommandError && thrown.exitCode === REVIEW_EXIT.stalled && thrown.code === "issue_review_stalled");
  assert.match(thrown.message, /^MS-ISSUE STALLED issue=12 round=1 minutes=14 reason=unchanged\n/);
  assert.match(lines.join("\n"), /Stalled: no new round on #12 after 14 min \(reason: unchanged\)/);
});

test("issue wait keeps the timeout and auth exit codes and names a server without issue reviews", async () => {
  await assert.rejects(
    () => capture(() => cmdIssue(["wait", "12"], { ...WAIT_DEPS, pollIssueReview: async () => { throw new IssueReviewTimeoutError(review({ state: "pending" })); } })),
    (err) => err instanceof CommandError && err.exitCode === REVIEW_EXIT.timeout,
  );
  await assert.rejects(
    () => capture(() => cmdIssue(["wait", "12"], { ...WAIT_DEPS, pollIssueReview: async () => { throw new CommandError("API key invalid", 1, "auth_invalid"); } })),
    (err) => err instanceof CommandError && err.exitCode === REVIEW_EXIT.auth,
  );
  await assert.rejects(
    () => capture(() => cmdIssue(["wait", "12"], { ...WAIT_DEPS, pollIssueReview: async () => null })),
    (err) => err instanceof CommandError && err.code === "issue_review_unavailable",
  );
});

test("issue watch parses its cursor and --max, and refuses --timeout", () => {
  assert.deepEqual(parseIssueWatchArgs(["12", "--after-round", "1", "--max", "30"]), { number: 12, json: false, afterRound: 1, maxMs: 1_800_000 });
  assert.deepEqual(parseIssueWatchArgs(["#7", "--json"]), { number: 7, json: true });
  for (const args of [[], ["12", "--max", "0"], ["12", "--timeout", "5"], ["12", "--after-round", "x"]]) {
    assert.throws(() => parseIssueWatchArgs(args), (err) => err instanceof CommandError && err.code === "usage", args.join(" "));
  }
});

test("issue watch exits 0 on READY and with the watch exit code otherwise", async () => {
  await capture(() => cmdIssue(["watch", "12"], { ...WAIT_DEPS, runIssueWatch: async () => ({ outcome: "ready", exitCode: 0, status: null }) }));
  await assert.rejects(
    () => capture(() => cmdIssue(["watch", "12"], { ...WAIT_DEPS, runIssueWatch: async () => ({ outcome: "stalled", exitCode: 3, status: null }) })),
    (err) => err instanceof CommandError && err.exitCode === 3 && err.code === "issue_review_stalled",
  );
  await assert.rejects(
    () => capture(() => cmdIssue(["watch", "12", "--max", "1"], { ...WAIT_DEPS, runIssueWatch: async () => ({ outcome: "timeout", exitCode: 5, status: null }) })),
    (err) => err instanceof CommandError && err.exitCode === 5,
  );
});

test("issue watch prints an ATTENTION failed line when it cannot start", async () => {
  let thrown: unknown;
  const lines = await capture(async () => {
    try {
      await cmdIssue(["watch", "12", "--max", "-1"], WAIT_DEPS);
    } catch (err) {
      thrown = err;
    }
  });
  assert.ok(thrown instanceof CommandError && thrown.exitCode === REVIEW_EXIT.usage);
  assert.match(lines[0]!, /^MS-ISSUE ATTENTION failed issue=12 error=/);
});

test("issue create --wait waits for the review of the issue it opened", async () => {
  const targets: unknown[] = [];
  const lines = await capture(() =>
    cmdIssue(["create", "--title", "Fix it", "--wait", "--timeout", "30", "--json"], {
      ...WAIT_DEPS,
      openStackIssue: async () => ({ number: 12, url: "u", created: true }),
      pollIssueReview: async (_cfg, target, opts) => {
        targets.push({ target, timeoutMs: opts?.timeoutMs });
        return review({ state: "approved", approvedBy: "vortex", points: [] });
      },
    }),
  );
  assert.deepEqual(targets, [{ target: { owner: "acme", repo: "widgets", number: 12 }, timeoutMs: 30_000 }]);
  assert.deepEqual(JSON.parse(lines.join("\n")), {
    owner: "acme",
    repo: "widgets",
    number: 12,
    url: "u",
    created: true,
    review: review({ state: "approved", approvedBy: "vortex", points: [] }),
  });
});
