import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { dismissPrFindings, type PrFindingDismissResult } from "../api.js";
import type { Config } from "../config.js";
import { CommandError } from "../errors.js";
import { cmdDismiss, formatDismissResult, parseDismissArgs } from "./dismiss.js";

const HEAD = "55ec0485921e7221a3dc107055166ef4a31f7d2a";
const cfg: Config = { apiKey: "msk_live_test", apiBase: "https://api.example.test" };

const result: PrFindingDismissResult = {
  status: "dismissed",
  owner: "marginsystems",
  repo: "mergestorm",
  pr_number: 2930,
  head_sha: HEAD,
  review_id: 5333776289,
  review_kind: "seam",
  scope: "findings",
  dismissed: [{ finding_id: "4118393726", finding_key: "D-0123456789ab", path: "torture/adapter.ts", line: null, title: "Driver subprocess misses TMPDIR" }],
  already_dismissed: [],
  remaining: [],
  all_dismissed: true,
  gate: { seam: { state: "approved", reviewed_sha: HEAD, review_id: 5333776289, cleared: true, blocking: false }, other_gates: "unchanged" },
  stack_id: "66352490-093e-428c-800b-ca4f447610ad",
};

let originalFetch: typeof globalThis.fetch | undefined;
afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
  process.exitCode = undefined;
});

test("parseDismissArgs reads the PR, exact identity, findings and reason", () => {
  const parsed = parseDismissArgs([
    "marginsystems/mergestorm#2930",
    "--head", HEAD.toUpperCase(),
    "--review", "5333776289",
    "--finding", "4118393726,offdiff-1",
    "--reason", "driverEnv already supplies TMPDIR",
    "--evidence", "https://github.com/acme/widgets/pull/12#issuecomment-345",
    "--json",
  ]);
  assert.deepEqual(parsed, {
    owner: "marginsystems",
    repo: "mergestorm",
    prNumber: 2930,
    headSha: HEAD,
    reviewId: 5333776289,
    findingIds: ["4118393726", "offdiff-1"],
    scope: "findings",
    reason: "driverEnv already supplies TMPDIR",
    evidenceUrl: "https://github.com/acme/widgets/pull/12#issuecomment-345",
    preview: false,
    json: true,
  });
});

test("parseDismissArgs requires the full head, a review, a scope and a reason", () => {
  const base = ["o/r#1", "--head", HEAD, "--review", "5"];
  const rejects = (args: string[], pattern: RegExp) =>
    assert.throws(() => parseDismissArgs(args), (err: unknown) => err instanceof CommandError && err.code === "usage" && pattern.test(err.message));
  rejects(["o/r#1", "--head", "55ec048", "--review", "5", "--all", "--reason", "x"], /40-character/);
  rejects(["o/r#1", "--head", HEAD, "--all", "--reason", "x"], /--review is required/);
  rejects([...base, "--reason", "x"], /--finding <id>/);
  rejects([...base, "--all", "--finding", "1", "--reason", "x"], /not both/);
  rejects([...base, "--all"], /--reason is required/);
  assert.equal(parseDismissArgs([...base, "--preview"]).preview, true);
  assert.equal(parseDismissArgs([...base, "--all", "--reason", "x"]).scope, "review");
});

test("dismissPrFindings posts the exact identity to the stacks API", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.example.test/api/v1/stacks/pr-review/dismiss");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      owner: "marginsystems",
      repo: "mergestorm",
      pr_number: 2930,
      head_sha: HEAD,
      review_id: 5333776289,
      scope: "findings",
      finding_ids: ["4118393726"],
      reason: "driverEnv already supplies TMPDIR",
    });
    return Response.json(result);
  };
  const outcome = await dismissPrFindings(
    { owner: "marginsystems", repo: "mergestorm", prNumber: 2930, headSha: HEAD, reviewId: 5333776289, scope: "findings", findingIds: ["4118393726"], reason: "driverEnv already supplies TMPDIR" },
    cfg,
  );
  assert.ok(outcome.ok);
  assert.equal(outcome.result.gate.seam?.cleared, true);
});

test("dismissPrFindings returns a server refusal with its code", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "stale_head", message: "PR #2930 head moved" }, { status: 409 });
  const outcome = await dismissPrFindings(
    { owner: "o", repo: "r", prNumber: 1, headSha: HEAD, reviewId: 5, scope: "review", reason: "long enough reason here" },
    cfg,
  );
  assert.deepEqual(outcome, { ok: false, status: 409, error: "stale_head", message: "PR #2930 head moved" });
});

test("cmdDismiss --json prints the result with the next stack_wait call", async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (line: string) => logs.push(line);
  try {
    await cmdDismiss(
      ["marginsystems/mergestorm#2930", "--head", HEAD, "--review", "5333776289", "--finding", "4118393726", "--reason", "driverEnv already supplies TMPDIR", "--json"],
      { loadConfig: async () => cfg, dismiss: async () => ({ ok: true, result }) },
    );
  } finally {
    console.log = original;
  }
  const printed = JSON.parse(logs[0]!) as { watch: { next: { tool: string; args: { stack_id: string } } } };
  assert.equal(printed.watch.next.tool, "stack_wait");
  assert.equal(printed.watch.next.args.stack_id, "66352490-093e-428c-800b-ca4f447610ad");
});

test("cmdDismiss surfaces a refusal as a failed exit", async () => {
  await assert.rejects(
    () =>
      cmdDismiss(["o/r#1", "--head", HEAD, "--review", "5", "--all", "--reason", "a long enough reason"], {
        loadConfig: async () => cfg,
        dismiss: async () => ({ ok: false, status: 403, error: "forbidden", message: "@bob does not have write access to o/r." }),
      }),
    (err: unknown) => err instanceof CommandError && err.exitCode === 4 && /forbidden/.test(err.message),
  );
});

test("formatDismissResult names the gate and the next command", () => {
  const text = formatDismissResult(result, {
    done: false,
    until: "landed",
    reason: "unread",
    message: "",
    next: { tool: "stack_wait", args: { stack_id: "s", timeout_s: 45 }, command: "mg stack wait s --json" },
  });
  assert.match(text, /Seam gate: cleared/);
  assert.match(text, /Next: mg stack wait s --json/);
});
