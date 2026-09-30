import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { CommandError, REVIEW_EXIT } from "../errors.js";
import { StackWatchError, StackWatchTimeoutError, type StackWatchEnvelope } from "../stack-watch.js";
import { STACK_WATCH_NOT_DONE_SENTENCE, stackWatchObligation } from "../stack-watch-obligation.js";
import { cmdStack, cmdStackWait } from "./stack.js";

const stackId = "11111111-1111-4111-8111-111111111111";
const envelope: StackWatchEnvelope = {
  issues: [], currentCandidate: null, assessment: "available", busy: [], actAfter: null, waitingOn: [], agents: null,
  schema: "mergestorm.stack_watch/v1", status: "attention", stackId,
  blocker: "Conflict", bounceKind: null, prNumber: 12, headSha: "head",
  cursor: { stackId, enrolledHeadSha: "enrolled" },
  repair: {
    kind: "restack_conflict", prNumber: 12, headSha: "head", branch: "feat/c", liveParent: "mg-stack-79",
    files: ["src/a.ts"], steps: "Merge mg-stack-79 into feat/c",
  },
  landGatePending: null,
  watch: stackWatchObligation({ stackId, terminal: null, cursor: { enrolledHeadSha: "enrolled" }, status: "attention" }),
};

test("stack wait prints one human summary and defaults to 45 seconds", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const signal = new AbortController().signal;
  await cmdStackWait([stackId], { loadConfig: async () => ({}), pollStackWatch: async (_cfg, id, opts) => {
    assert.equal(id, stackId);
    assert.equal(opts?.timeoutMs, 45_000);
    assert.equal(opts?.signal, signal);
    return envelope;
  }, signal });
  assert.equal(log.mock.calls.length, 1);
  const lines = String(log.mock.calls[0]!.arguments[0]).split("\n");
  assert.equal(lines[0], `Stack ${stackId} · attention · blocked: #12 Conflict`);
  assert.equal(lines[1], "Repair #12 restack_conflict (files: src/a.ts): Merge mg-stack-79 into feat/c");
  assert.equal(lines[2], `Next: mg stack watch ${stackId} as a background command (notify on MS-WATCH (ATTENTION|LANDED), then end your turn)`);
  assert.equal(lines[3], `Or poll: mg stack wait ${stackId} --json (MCP: stack_wait {"stack_id":"${stackId}","enrolled_head_sha":"enrolled","timeout_s":45})`);
  assert.equal(lines.at(-1), STACK_WATCH_NOT_DONE_SENTENCE);
});

test("stack wait text for a landed stack ends with the done message, not the obligation", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const landed = { ...envelope, status: "waiting" as const, blocker: null, repair: null,
    watch: stackWatchObligation({ stackId, terminal: "landed" }) };
  await cmdStackWait([stackId], { loadConfig: async () => ({}), pollStackWatch: async () => landed });
  const lines = String(log.mock.calls[0]!.arguments[0]).split("\n");
  assert.equal(lines.at(-1), landed.watch.message);
  assert.doesNotMatch(lines.join("\n"), /Your task is not done/);
});

test("stack wait --json prints the envelope and forwards timeout", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  await cmdStackWait(["--timeout", "12", stackId, "--json"], { loadConfig: async () => ({}), pollStackWatch: async (_cfg, _id, opts) => {
    assert.equal(opts?.timeoutMs, 12_000);
    return envelope;
  } });
  assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]), envelope);
});

test("stack wait accepts an equals-form timeout", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  await cmdStackWait([stackId, "--timeout=12"], {
    loadConfig: async () => ({}),
    pollStackWatch: async (_cfg, _id, opts) => {
      assert.equal(opts?.timeoutMs, 12_000);
      return envelope;
    },
  });
  assert.match(log.mock.calls[0].arguments[0], /attention/);
});

test("stack wait timeout prints waiting envelope and throws review_timeout exit 5", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const last = { ...envelope, status: "waiting" as const, blocker: null };
  await assert.rejects(() => cmdStackWait([stackId, "--json"], {
    loadConfig: async () => ({}),
    pollStackWatch: async () => { throw new StackWatchTimeoutError(last); },
  }), (err: unknown) => err instanceof CommandError && err.exitCode === REVIEW_EXIT.timeout && err.code === "review_timeout");
  assert.equal(REVIEW_EXIT.timeout, 5);
  assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]), last);
});

test("stack wait maps exhausted 429 retries to exit 7 with a rate-limited envelope", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const last = { ...envelope, status: "rate_limited" as const, blocker: null };
  await assert.rejects(() => cmdStackWait([stackId, "--json"], {
    loadConfig: async () => ({}),
    pollStackWatch: async () => { throw new StackWatchError("Stack poll failed (HTTP 429)", last, undefined, 12); },
  }), (err: unknown) => err instanceof CommandError &&
    err.exitCode === REVIEW_EXIT.rate_limited && err.code === "rate_limited" &&
    err.retryAfterSeconds === 12);
  const printed = JSON.parse(log.mock.calls[0].arguments[0]);
  assert.equal(printed.status, "rate_limited");
  assert.equal(printed.retry_after_seconds, 12);
});

test("stack wait prints a failed envelope before rethrowing the poll error", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const issues = [{ prNumber: 12, headSha: null, blocker: "Conflict", bounceKind: null }];
  const last = { ...envelope, status: "failed" as const, assessment: "unavailable" as const, issues };
  const error = new StackWatchError("Stack poll failed", last);
  await assert.rejects(() => cmdStackWait([stackId, "--json"], {
    loadConfig: async () => ({}),
    pollStackWatch: async () => { throw error; },
  }), (err: unknown) => err === error);
  assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]), last);
});

test("cmdStack routes wait and validates arguments", async () => {
  for (const args of [[], [stackId, "extra"], [stackId, "--other"], [stackId, "--timeout"],
    ...["-1", "301", "NaN", "Infinity", ""].map(value => [stackId, "--timeout", value])]) {
    await assert.rejects(() => cmdStack(["wait", ...args]), /usage: mergestorm stack wait/);
  }
});

test("CLI zero timeout reads one snapshot and exits successfully", async (t) => {
  const routes: string[] = [];
  const server = createServer((request, response) => {
    routes.push(request.url!);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url!.includes("/queue") ? { entries: [] } : { stacks: [{ id: stackId, layers: [] }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, ["--import", "tsx/esm",
    new URL("../cli.ts", import.meta.url).pathname,
    "stack", "wait", stackId, "--json", "--timeout", "0"], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, MERGESTORM_API_KEY: "test", MERGESTORM_API_URL: `http://127.0.0.1:${address.port}` },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  assert.equal(status, 0, stderr);
  const data = JSON.parse(stdout);
  assert.equal(data.schema, "mergestorm.stack_watch/v1");
  assert.equal(data.status, "waiting");
  assert.equal(data.assessment, "available");
  assert.deepEqual(data.issues, []);
  assert.equal(data.stackId, stackId);
  assert.deepEqual(routes, [`/api/v1/stacks/enrich?stackId=${stackId}`, `/api/v1/stacks/queue?stackId=${stackId}`]);
});

async function runCli(port: number, args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx/esm",
    new URL("../cli.ts", import.meta.url).pathname, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, MERGESTORM_API_KEY: "test", MERGESTORM_API_URL: `http://127.0.0.1:${port}` },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  return { status, stdout, stderr };
}

async function serve(t: { after: (fn: () => void) => void }, body: (url: string) => unknown) {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body(request.url!)));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

const openLayer = {
  branch: "feat/a", parentBranch: "main", prNumber: 7, position: 1, state: "clean", headSha: "a".repeat(40),
  ciStatus: "success", reviewStatus: "none", checks: null, vortexStatus: null, cycloneStatus: null, tempestStatus: null,
  conflictDetail: null, lastRestackedSha: null, mergeable: true, mergeableState: "clean", mergeableHeadSha: "a".repeat(40),
};

test("CLI --json writes exactly one JSON document to stdout when the wait times out; the reason goes to stderr", async (t) => {
  const port = await serve(t, url => url.includes("/queue")
    ? { entries: [] }
    : { stacks: [{ id: stackId, trunkBranch: "main", archivedAt: null, layers: [openLayer] }] });
  const { status, stdout, stderr } = await runCli(port, ["stack", "wait", stackId, "--json", "--timeout", "1"]);
  assert.equal(status, REVIEW_EXIT.timeout);
  const data = JSON.parse(stdout);
  assert.equal(data.status, "waiting");
  assert.equal(data.watch.done, false);
  assert.equal(data.watch.reason, "open");
  assert.deepEqual(data.watch.next.args, { stack_id: stackId, enrolled_head_sha: "a".repeat(40), timeout_s: 45 });
  assert.match(data.watch.message, /^This stack is not landed\. Your task is not done\. Call stack_wait again with this cursor\./);
  assert.match(stderr, /Timed out waiting for stack/);
  assert.doesNotMatch(stdout, /Timed out/);
});

test("CLI --json reports a vanished stack as one JSON document with watch done: not_found", async (t) => {
  const port = await serve(t, url => url.includes("/queue") ? { entries: [] } : { stacks: [] });
  const { status, stdout, stderr } = await runCli(port, ["stack", "wait", stackId, "--json", "--timeout", "0"]);
  assert.equal(status, 1);
  const data = JSON.parse(stdout);
  assert.equal(data.status, "failed");
  assert.deepEqual({ done: data.watch.done, reason: data.watch.reason, next: data.watch.next },
    { done: true, reason: "not_found", next: null });
  assert.match(stderr, /Stack not found or not owned by the current user/);
});

test("CLI text wait on an open stack prints the not-done sentence last", async (t) => {
  const port = await serve(t, url => url.includes("/queue")
    ? { entries: [] }
    : { stacks: [{ id: stackId, trunkBranch: "main", archivedAt: null, layers: [openLayer] }] });
  const { status, stdout } = await runCli(port, ["stack", "wait", stackId, "--timeout", "0"]);
  assert.equal(status, 0);
  assert.equal(stdout.trimEnd().split("\n").at(-1), STACK_WATCH_NOT_DONE_SENTENCE);
});
