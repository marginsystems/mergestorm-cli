import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { CommandError, REVIEW_EXIT } from "../errors.js";
import { StackWatchError, StackWatchTimeoutError, type StackWatchEnvelope } from "../stack-watch.js";
import { cmdStack, cmdStackWait } from "./stack.js";

const stackId = "11111111-1111-4111-8111-111111111111";
const envelope: StackWatchEnvelope = {
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
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [[`Stack ${stackId} · attention · Conflict`]]);
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

test("cmdStack routes wait and validates arguments", async () => {
  for (const args of [[], [stackId, "extra"], [stackId, "--other"], [stackId, "--timeout"],
    ...["-1", "301", "NaN", "Infinity", ""].map(value => [stackId, "--timeout", value])]) {
    await assert.rejects(() => cmdStack(["wait", ...args]), /usage: mergestorm stack wait/);
  }
});

test("CLI stack wait timeout actually exits 5 with a JSON waiting envelope", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx/esm",
    new URL("../cli.ts", import.meta.url).pathname,
    "stack", "wait", stackId, "--json", "--timeout", "0"], {
    encoding: "utf8", env: { ...process.env, MERGESTORM_API_KEY: "test" },
  });
  assert.equal(result.status, 5, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.schema, "mergestorm.stack_watch/v1");
  assert.equal(data.status, "waiting");
  assert.equal(data.stackId, stackId);
});
