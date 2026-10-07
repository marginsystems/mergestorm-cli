import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runStackWatch,
  STACK_WATCH_EXIT,
  STACK_WATCH_SLICE_MS,
  type RunStackWatchOptions,
} from "./stack-watch-loop.js";
import {
  StackWatchError,
  StackWatchTimeoutError,
  type PollStackWatchOptions,
  type StackWatchCursor,
  type StackWatchEnvelope,
} from "./stack-watch.js";
import { stackWatchObligation } from "./stack-watch-obligation.js";

const stackId = "11111111-1111-4111-8111-111111111111";
const headA = "a".repeat(40);
const headB = "b".repeat(40);

function envelope(overrides: Partial<StackWatchEnvelope> = {}, terminal: "landed" | "closed" | "archived" | "not_found" | null = null): StackWatchEnvelope {
  const cursor: StackWatchCursor = overrides.cursor ?? { stackId, enrolledHeadSha: headA };
  const base: StackWatchEnvelope = {
    schema: "mergestorm.stack_watch/v1", status: "waiting", stackId, blocker: null, bounceKind: null,
    prNumber: 12, headSha: headA, cursor, issues: [], currentCandidate: null, assessment: "available",
    busy: [], actAfter: null, waitingOn: [], agents: null, repair: null, landGatePending: null,
    watch: stackWatchObligation({ stackId, terminal, cursor }),
  };
  return { ...base, ...overrides, cursor };
}

function attention(blocker: string, overrides: Partial<StackWatchEnvelope> = {}): StackWatchEnvelope {
  return envelope({ status: "attention", blocker, ...overrides });
}

type Step = StackWatchEnvelope | Error;

function harness(steps: Step[], opts: Partial<RunStackWatchOptions> = {}) {
  let clock = 0;
  const lines: string[] = [];
  const calls: PollStackWatchOptions[] = [];
  const sleeps: number[] = [];
  const run = runStackWatch({}, stackId, {
    write: (line) => lines.push(line),
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    poll: async (_cfg, id, pollOpts = {}) => {
      assert.equal(id, stackId);
      calls.push(pollOpts);
      const step = steps.shift();
      if (!step) throw new Error("poll called more often than scripted");
      clock += 1_000;
      if (step instanceof Error) throw step;
      return step;
    },
    ...opts,
  });
  return { run, lines, calls, sleeps };
}

test("stack watch stays silent across timeouts and exits 3 with one line on attention", async () => {
  const waiting = envelope({ status: "in_progress", busy: [{ prNumber: 12, headSha: headA, agent: "cyclone", blocker: "Conflict" }] });
  const repair = { kind: "restack_conflict" as const, prNumber: 12, headSha: headB, branch: "feat/a", liveParent: "mg-stack-9",
    files: ["a.ts"], steps: "Merge mg-stack-9" };
  const { run, lines, calls } = harness([
    new StackWatchTimeoutError(waiting),
    new StackWatchTimeoutError(envelope({ status: "waiting", actAfter: "agents_idle" })),
    attention("Conflict", { headSha: headB, repair }),
  ]);
  const result = await run;
  assert.equal(result.outcome, "attention");
  assert.equal(result.exitCode, STACK_WATCH_EXIT.attention);
  assert.equal(result.exitCode, 3);
  assert.deepEqual(lines, [`MS-WATCH ATTENTION pr=12 head=${headB} blocker="Conflict" repair=restack_conflict`]);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.timeoutMs, STACK_WATCH_SLICE_MS);
  assert.ok(STACK_WATCH_SLICE_MS <= 300_000);
});

test("stack watch carries the cursor from each slice into the next call", async () => {
  const first: StackWatchCursor = { stackId, enrolledHeadSha: headA };
  const second: StackWatchCursor = { stackId, enrolledHeadSha: headA, afterFinishedAt: "2026-09-30T10:00:00.000Z", bounceId: "bounce-1" };
  const { run, calls } = harness([
    new StackWatchTimeoutError(envelope({ cursor: first })),
    new StackWatchTimeoutError(envelope({ cursor: second })),
    envelope({ cursor: second }, "landed"),
  ], { cursor: { stackId, enrolledHeadSha: headB } });
  await run;
  assert.deepEqual(calls.map((call) => call.cursor), [{ stackId, enrolledHeadSha: headB }, first, second]);
});

test("stack watch omits the cursor on the first call when none was given", async () => {
  const { run, calls } = harness([envelope({}, "landed")]);
  await run;
  assert.equal(calls[0]!.cursor, undefined);
});

test("stack watch prints MS-WATCH LANDED and exits 0 when the watch is done", async () => {
  const { run, lines } = harness([new StackWatchTimeoutError(envelope()), envelope({}, "landed")]);
  const result = await run;
  assert.equal(result.outcome, "landed");
  assert.equal(result.exitCode, 0);
  assert.equal(lines[0], `MS-WATCH LANDED stack=${stackId} reason=landed`);
  assert.match(lines[1]!, /This stack is landed/);
  assert.equal(lines.length, 2);
});

for (const terminal of ["not_found", "closed", "archived"] as const) {
  for (const throws of [false, true]) {
    test(`stack watch exits with attention for ${terminal} from ${throws ? "an error" : "a snapshot"}`, async () => {
      const done = envelope({ status: "failed", assessment: "unavailable" }, terminal);
      const step = throws ? new StackWatchError("Terminal stack", done) : done;
      const { run, lines, calls, sleeps } = harness([step], {
        until: "landed",
        ignore: [terminal],
        readLanded: async () => null,
      });
      const result = await run;
      assert.equal(result.outcome, "attention");
      assert.equal(result.exitCode, STACK_WATCH_EXIT.attention);
      assert.equal(result.envelope, done);
      assert.deepEqual(lines, [`MS-WATCH ATTENTION stack=${stackId} reason=${terminal}`, done.watch.message]);
      assert.equal(calls.length, 1);
      assert.deepEqual(sleeps, []);
    });
  }
}

test("stack watch retries one failed read, then keeps watching silently", async () => {
  const failed = envelope({ status: "failed", assessment: "unavailable" });
  const { run, lines, calls } = harness([
    new StackWatchError("Stack snapshot missing or invalid", failed),
    new StackWatchTimeoutError(envelope()),
    new StackWatchError("Stack snapshot missing or invalid", failed),
    envelope({}, "landed"),
  ]);
  const result = await run;
  assert.equal(result.outcome, "landed");
  assert.equal(calls.length, 4);
  assert.deepEqual(lines.filter((line) => line.includes("failed")), []);
});

test("stack watch exits 3 with MS-WATCH ATTENTION failed after a failed read and a failed retry", async () => {
  const failed = envelope({ status: "failed", assessment: "unavailable" });
  const { run, lines, calls, sleeps } = harness([
    new StackWatchError("Stack poll failed (HTTP 401)", failed),
    new StackWatchError("Stack poll failed (HTTP 403)", failed),
  ]);
  const result = await run;
  assert.equal(result.outcome, "failed");
  assert.equal(result.exitCode, 3);
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1);
  assert.deepEqual(lines, [`MS-WATCH ATTENTION failed stack=${stackId} error="Stack poll failed (HTTP 403)"`]);
});

test("stack watch rides out timeouts and 5xx reads, backing off, and keeps watching", async () => {
  const failed = envelope({ status: "failed", assessment: "unavailable" });
  const { run, lines, sleeps } = harness([
    new Error("Request timed out after 30s. Check network connectivity and API status."),
    new StackWatchError("Stack poll failed (HTTP 500)", failed),
    new Error("socket hang up"),
    new StackWatchError("Stack poll failed (HTTP 502)", failed),
    new Error("Request timed out after 30s. Check network connectivity and API status."),
    envelope({}, "landed"),
  ]);
  const result = await run;
  assert.equal(result.outcome, "landed");
  assert.deepEqual(lines.filter((line) => line.includes("failed")), []);
  assert.deepEqual(sleeps, [15_000, 30_000, 60_000, 60_000, 60_000]);
});

test("stack watch reports a failed read once transient failures have lasted fifteen minutes", async () => {
  const steps: Step[] = Array.from({ length: 40 }, () => new Error("Request timed out after 30s. Check network connectivity and API status."));
  const { run, lines } = harness(steps);
  const result = await run;
  assert.equal(result.outcome, "failed");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^MS-WATCH ATTENTION failed /);
});

test("stack watch confirms a landing when the stack is gone but its merge queue entry landed", async () => {
  const { run, lines } = harness([envelope({ prNumber: 4119 }, "not_found")], {
    readLanded: async () => ({ state: "landed", finishedAt: "2026-10-07T19:03:58Z", landedPrNumbers: [4119] }) as never,
  });
  const result = await run;
  assert.equal(result.outcome, "landed");
  assert.equal(result.exitCode, STACK_WATCH_EXIT.landed);
  assert.equal(lines[0], `MS-WATCH LANDED stack=${stackId} reason=landed`);
  assert.match(lines[1]!, /merge queue landed #4119/);
});

test("stack watch confirms only a landed entry for a PR it saw, and names a failed confirmation", async () => {
  for (const [readLanded, expectedOutcome, expectedReason] of [
    [async () => null, "attention", "not_found"],
    [async () => ({ state: "landed", finishedAt: "1969-12-31T23:00:00Z", landedPrNumbers: [12] }) as never, "landed", "landed"],
    [async () => ({ state: "landed", finishedAt: "2026-10-07T19:03:58Z", landedPrNumbers: [1] }) as never, "attention", "not_found"],
    [async () => { throw new Error("queue read failed"); }, "attention", "landing_unconfirmed"],
  ] as const) {
    const { run, lines } = harness([envelope({}, "not_found")], { readLanded });
    const result = await run;
    assert.equal(result.outcome, expectedOutcome);
    assert.equal(
      lines[0],
      `MS-WATCH ${expectedOutcome === "landed" ? "LANDED" : "ATTENTION"} stack=${stackId} reason=${expectedReason}`,
    );
  }
});

test("stack watch confirms a landing by the enrolled head when the stack vanished within its first slice", async () => {
  const gone = envelope({ prNumber: null, headSha: null, cursor: { stackId, enrolledHeadSha: headA } }, "not_found");
  for (const [verifyHeadSha, expected] of [[headA, "landed"], [headB, "attention"]] as const) {
    const { run } = harness([new StackWatchError("Stack not found or not owned by the current user", gone)], {
      readLanded: async () => ({ state: "landed", finishedAt: "2026-10-07T19:03:58Z", landedPrNumbers: [99], verifyHeadSha }) as never,
    });
    assert.equal((await run).outcome, expected);
  }
});

test("stack watch remembers a PR from an earlier slice when the stack is later gone", async () => {
  const { run, lines } = harness([
    new StackWatchTimeoutError(envelope({ prNumber: 77 })),
    envelope({ prNumber: null }, "not_found"),
  ], {
    readLanded: async () => ({ state: "landed", finishedAt: "2026-10-07T19:03:58Z", landedPrNumbers: [77] }) as never,
  });
  const result = await run;
  assert.equal(result.outcome, "landed");
  assert.equal(lines[0], `MS-WATCH LANDED stack=${stackId} reason=landed`);
});

test("stack watch --json writes one fallback outcome document after two failed reads", async () => {
  const markers: string[] = [];
  const { run, lines } = harness([
    new Error("first read failed"),
    new Error("second read failed"),
  ], { json: true, writeMarker: (line) => markers.push(line) });
  assert.equal((await run).outcome, "failed");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines.join("\n")), { stackId, outcome: "failed" });
  assert.equal(markers.length, 1);
});

test("stack watch --json writes the last envelope after a failed retry", async () => {
  const failed = envelope({ status: "failed", assessment: "unavailable" });
  const markers: string[] = [];
  const { run, lines } = harness([
    new Error("first read failed"),
    new StackWatchError("second read failed", failed),
  ], { json: true, writeMarker: (line) => markers.push(line) });
  assert.equal((await run).outcome, "failed");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines.join("\n")), failed);
  assert.equal(markers.length, 1);
});

test("stack watch waits out a rate limit without counting it as a failure", async () => {
  const limited = envelope({ status: "rate_limited" });
  const failed = envelope({ status: "failed" });
  const { run, sleeps, lines } = harness([
    new StackWatchError("Stack poll failed (HTTP 500)", failed),
    new StackWatchError("Stack poll failed (HTTP 429)", limited, undefined, 12),
    envelope({}, "landed"),
  ]);
  const result = await run;
  assert.equal(result.outcome, "landed");
  assert.ok(sleeps.includes(12_000));
  assert.equal(lines[0], `MS-WATCH LANDED stack=${stackId} reason=landed`);
});

test("stack watch --ignore stays silent on the handed-off blocker until it changes", async () => {
  const { run, lines, calls } = harness([
    attention("Seam findings"),
    attention("Seam findings"),
    new StackWatchTimeoutError(envelope()),
    attention("Seam findings"),
    attention("CI failed — lint"),
  ], { ignore: ["seam"] });
  const result = await run;
  assert.equal(result.outcome, "attention");
  assert.equal(calls.length, 5);
  assert.deepEqual(lines, [`MS-WATCH ATTENTION pr=12 head=${headA} blocker="CI failed — lint" repair=none`]);
});

test("stack watch --ignore keeps a timed blocker silent as its elapsed minutes grow", async () => {
  const pending = (minutes: number) =>
    attention(`CI pending for ${minutes}m — a check on this head has not finished, so Auto land will not queue it`);
  const { run, lines } = harness([pending(46), pending(48), pending(51), envelope({}, "landed")], { ignore: ["CI pending for"] });
  const result = await run;
  assert.equal(result.outcome, "landed");
  assert.deepEqual(lines, [`MS-WATCH LANDED stack=${stackId} reason=landed`, "This stack is landed. The watch is done; stop calling stack_wait for it."]);
});

test("stack watch --until landed reports a timed blocker once while its elapsed minutes grow", async () => {
  const pending = (minutes: number) => attention(`No green Vortex review for ${minutes}m — Auto land is waiting for an approving Vortex review at this head`);
  const { run, lines } = harness([pending(30), pending(31), envelope({}, "landed")], { until: "landed" });
  await run;
  assert.equal(lines.filter((line) => line.startsWith("MS-WATCH ATTENTION")).length, 1);
});

test("stack watch --ignore silences a distinct blocker for each repeated flag", async () => {
  const { run, lines } = harness([
    attention("Seam findings"),
    attention("Draft PR", { prNumber: 13 }),
    envelope({}, "landed"),
  ], { ignore: ["Seam", "Draft"] });
  const result = await run;
  assert.equal(result.outcome, "landed");
  assert.deepEqual(lines, [`MS-WATCH LANDED stack=${stackId} reason=landed`, "This stack is landed. The watch is done; stop calling stack_wait for it."]);
});

test("stack watch --ignore stops ignoring once the same blocker moves to a new head", async () => {
  const { run, lines } = harness([
    attention("Conflict"),
    attention("Conflict", { headSha: headB }),
  ], { ignore: ["Conflict"] });
  const result = await run;
  assert.equal(result.exitCode, 3);
  assert.deepEqual(lines, [`MS-WATCH ATTENTION pr=12 head=${headB} blocker="Conflict" repair=none`]);
});

test("stack watch pauses between polls while an ignored attention persists", async () => {
  const { run, sleeps } = harness([attention("Draft PR"), attention("Draft PR"), envelope({}, "landed")], { ignore: ["draft"] });
  await run;
  assert.equal(sleeps.length, 2);
  for (const ms of sleeps) assert.ok(ms >= 30_000);
});

test("stack watch --until landed prints each new attention once and exits 0 on landed", async () => {
  const { run, lines } = harness([
    attention("Conflict"),
    attention("Conflict"),
    attention("CI failed"),
    envelope({}, "landed"),
  ], { until: "landed" });
  const result = await run;
  assert.equal(result.exitCode, 0);
  assert.deepEqual(lines.filter((line) => line.startsWith("MS-WATCH")), [
    `MS-WATCH ATTENTION pr=12 head=${headA} blocker="Conflict" repair=none`,
    `MS-WATCH ATTENTION pr=12 head=${headA} blocker="CI failed" repair=none`,
    `MS-WATCH LANDED stack=${stackId} reason=landed`,
  ]);
});

test("stack watch --json writes only the envelope to stdout and the marker to the marker stream", async () => {
  const attn = attention("Conflict");
  const markers: string[] = [];
  const { run, lines } = harness([attn], { json: true, writeMarker: (line) => markers.push(line) });
  await run;
  assert.deepEqual(JSON.parse(lines.join("\n")), attn);
  assert.equal(markers.length, 1);
  assert.match(markers[0]!, /^MS-WATCH ATTENTION pr=12 /);
});

test("stack watch --json --until landed writes one JSON document for the landed envelope", async () => {
  const done = envelope({}, "landed");
  const markers: string[] = [];
  const { run, lines } = harness([attention("Conflict"), attention("CI failed"), done],
    { json: true, until: "landed", writeMarker: (line) => markers.push(line) });
  assert.equal((await run).exitCode, 0);
  assert.deepEqual(JSON.parse(lines.join("\n")), done);
  assert.deepEqual(markers, [
    `MS-WATCH ATTENTION pr=12 head=${headA} blocker="Conflict" repair=none`,
    `MS-WATCH ATTENTION pr=12 head=${headA} blocker="CI failed" repair=none`,
    `MS-WATCH LANDED stack=${stackId} reason=landed`,
  ]);
});

test("stack watch --json --max writes one outcome document on timeout", async () => {
  const markers: string[] = [];
  const { run, lines } = harness([new StackWatchTimeoutError(envelope()), new StackWatchTimeoutError(envelope())],
    { json: true, maxMs: 1_500, writeMarker: (line) => markers.push(line) });
  assert.equal((await run).exitCode, 5);
  assert.deepEqual(JSON.parse(lines.join("\n")), { stackId, outcome: "timeout" });
  assert.deepEqual(markers, [`MS-WATCH TIMEOUT stack=${stackId} after=0m`]);
});

test("stack watch --max stops with MS-WATCH TIMEOUT and exit 5", async () => {
  const { run, lines, calls } = harness([
    new StackWatchTimeoutError(envelope()),
    new StackWatchTimeoutError(envelope()),
  ], { maxMs: 1_500 });
  const result = await run;
  assert.equal(result.outcome, "timeout");
  assert.equal(result.exitCode, 5);
  assert.equal(calls[0]!.timeoutMs, 1_500);
  assert.deepEqual(lines, [`MS-WATCH TIMEOUT stack=${stackId} after=0m`]);
});

test("stack watch --max clamps a failed-read retry to the remaining time", async () => {
  const failed = envelope({ status: "failed", assessment: "unavailable" });
  const { run, lines, sleeps } = harness([
    new StackWatchError("Stack poll failed (HTTP 500)", failed),
  ], { maxMs: 10_000 });
  const result = await run;
  assert.equal(result.outcome, "timeout");
  assert.equal(result.exitCode, 5);
  assert.deepEqual(sleeps, [9_000]);
  assert.deepEqual(lines, [`MS-WATCH TIMEOUT stack=${stackId} after=0m`]);
});

test("stack watch --json writes one outcome document when aborted", async () => {
  const controller = new AbortController();
  const lines: string[] = [];
  const result = await runStackWatch({}, stackId, {
    signal: controller.signal,
    json: true,
    write: (line) => lines.push(line),
    poll: async () => {
      controller.abort();
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    },
  });
  assert.equal(result.outcome, "aborted");
  assert.deepEqual(JSON.parse(lines.join("\n")), { stackId, outcome: "aborted" });
  assert.equal(lines.length, 1);
});
