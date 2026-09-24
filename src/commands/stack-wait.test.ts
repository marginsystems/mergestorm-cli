import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { CommandError, REVIEW_EXIT } from "../errors.js";
import { StackWatchError, StackWatchTimeoutError, type StackWatchEnvelope } from "../stack-watch.js";
import { cmdStack, cmdStackWait } from "./stack.js";

const stackId = "11111111-1111-4111-8111-111111111111";
const envelope: StackWatchEnvelope = {
  issues: [], currentCandidate: null, assessment: "available",
  schema: "mergestorm.stack_watch/v1", status: "attention", stackId,
  blocker: "Conflict", bounceKind: null, prNumber: 12, headSha: "head",
  cursor: { stackId, enrolledHeadSha: "enrolled" },
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
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [[`Stack ${stackId} · attention · blocked: #12 Conflict`]]);
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
