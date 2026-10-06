import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { CommandError, REVIEW_EXIT } from "../errors.js";
import type { RunStackWatchOptions, StackWatchLoopResult } from "../stack-watch-loop.js";
import { cmdStack, cmdStackWatch } from "./stack.js";

const stackId = "11111111-1111-4111-8111-111111111111";

function fakeRun(result: Partial<StackWatchLoopResult>, seen: RunStackWatchOptions[] = []) {
  return async (_cfg: unknown, id: string, opts: RunStackWatchOptions = {}) => {
    assert.equal(id, stackId);
    seen.push(opts);
    return { outcome: "landed", exitCode: 0, envelope: null, ...result } as StackWatchLoopResult;
  };
}

test("stack watch passes until, every ignore, max, head, and json to the watcher", async () => {
  const seen: RunStackWatchOptions[] = [];
  await cmdStackWatch([stackId, "--until", "landed", "--ignore", "Seam", "--ignore=Draft", "--max", "90",
    "--head", "ABCDEF1", "--json"], { loadConfig: async () => ({}), runStackWatch: fakeRun({}, seen) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.until, "landed");
  assert.deepEqual(seen[0]!.ignore, ["Seam", "Draft"]);
  assert.equal(seen[0]!.maxMs, 90 * 60_000);
  assert.equal(seen[0]!.json, true);
  assert.deepEqual(seen[0]!.cursor, { stackId, enrolledHeadSha: "abcdef1" });
});

test("stack watch defaults to until attention with no cursor and no limit", async () => {
  const seen: RunStackWatchOptions[] = [];
  await cmdStackWatch([stackId], { loadConfig: async () => ({}), runStackWatch: fakeRun({}, seen) });
  assert.equal(seen[0]!.until, "attention");
  assert.deepEqual(seen[0]!.ignore, []);
  assert.equal(seen[0]!.maxMs, undefined);
  assert.equal(seen[0]!.cursor, undefined);
  assert.equal(seen[0]!.json, false);
});

test("stack watch maps attention and repeated failure to exit 3", async () => {
  for (const outcome of ["attention", "failed"] as const) {
    await assert.rejects(() => cmdStackWatch([stackId], {
      loadConfig: async () => ({}), runStackWatch: fakeRun({ outcome, exitCode: 3 }),
    }), (err: unknown) => err instanceof CommandError && err.exitCode === 3 && err.code === "stack_attention");
  }
});

test("stack watch maps --max expiry to exit 5", async () => {
  await assert.rejects(() => cmdStackWatch([stackId, "--max", "1"], {
    loadConfig: async () => ({}), runStackWatch: fakeRun({ outcome: "timeout", exitCode: 5 }),
  }), (err: unknown) => err instanceof CommandError && err.exitCode === REVIEW_EXIT.timeout && err.code === "review_timeout");
});

test("cmdStack routes watch and validates arguments", async () => {
  for (const args of [[], [stackId, "extra"], [stackId, "--other"], [stackId, "--until"], [stackId, "--until", "forever"],
    [stackId, "--ignore"], [stackId, "--ignore", " "], [stackId, "--max", "0"], [stackId, "--max", "NaN"],
    [stackId, "--head", "not-a-sha"], ["not-a-stack-id"]]) {
    await assert.rejects(() => cmdStack(["watch", ...args]), /usage: mergestorm stack watch/);
  }
});

test("CLI stack watch prints one MS-WATCH ATTENTION line and exits 3 on a conflicted layer", async (t) => {
  const head = "a".repeat(40);
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url!.includes("/queue") ? { entries: [] } : { stacks: [{
      id: stackId, trunkBranch: "main", archivedAt: null, layers: [{
        branch: "feat/a", parentBranch: "main", prNumber: 7, position: 1, state: "conflict", headSha: head,
        ciStatus: "success", reviewStatus: "none", checks: null, vortexStatus: null, cycloneStatus: null,
        conflictDetail: null, lastRestackedSha: null, mergeable: false, mergeableState: "dirty", mergeableHeadSha: head,
      }],
    }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, ["--import", "tsx/esm", new URL("../cli.ts", import.meta.url).pathname,
    "stack", "watch", stackId], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MERGESTORM_API_KEY: "test", MERGESTORM_API_URL: `http://127.0.0.1:${address.port}` },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  assert.equal(status, 3, stderr);
  assert.equal(stdout, `MS-WATCH ATTENTION pr=7 head=${head} blocker="Conflict" repair=restack_conflict\n`);
  assert.match(stderr, /needs attention; it is not landed/);
});

test("CLI stack watch --json writes exactly one JSON document to stdout and the marker to stderr", async (t) => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url!.includes("/queue") ? { entries: [] } : { stacks: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, ["--import", "tsx/esm", new URL("../cli.ts", import.meta.url).pathname,
    "stack", "watch", stackId, "--json"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MERGESTORM_API_KEY: "test", MERGESTORM_API_URL: `http://127.0.0.1:${address.port}` },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  assert.equal(status, 3, stderr);
  const document = JSON.parse(stdout);
  assert.equal(document.stackId, stackId);
  assert.equal(document.watch.done, true);
  assert.equal(document.watch.reason, "not_found");
  assert.doesNotMatch(stdout, /MS-WATCH/);
  assert.doesNotMatch(stderr, /MS-WATCH LANDED/);
  assert.match(stderr, /landing is unconfirmed/);
  assert.match(stderr, new RegExp(`^MS-WATCH ATTENTION stack=${stackId} reason=not_found$`, "m"));
});
