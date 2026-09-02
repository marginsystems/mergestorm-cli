import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { MergeQueueEntryDto } from "../api.js";
import { CommandError } from "../errors.js";
import {
  initialLineTabsState,
  layoutLineTabs,
  type LineTab,
} from "../ui/line-tabs.js";
import { visibleWidth } from "../ui/width.js";
import {
  buildQueueListLines,
  cmdQueue,
  resolveQueueEntryId,
} from "./queue.js";
import { cmdStack } from "./stack.js";

const stackId = "11111111-1111-4111-8111-111111111111";
const entryId = "22222222-2222-4222-8222-222222222222";
const entry: MergeQueueEntryDto = {
  id: entryId,
  stackId,
  owner: "acme",
  repo: "widgets",
  state: "waiting",
  position: 1,
  waitReason: "ci_pending on #42",
  bounceReason: null,
  bounceDetail: null,
  enqueuedBy: "human",
  enqueuedVia: "cli",
  enqueuedAt: "2026-08-25T10:00:00Z",
  attempts: 1,
  landedPrNumbers: [],
  verifyHeadSha: null,
  verifyBaseSha: null,
  finishedAt: null,
};

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalApiKey = process.env.MERGESTORM_API_KEY;
const originalApiUrl = process.env.MERGESTORM_API_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  if (originalApiKey === undefined) delete process.env.MERGESTORM_API_KEY;
  else process.env.MERGESTORM_API_KEY = originalApiKey;
  if (originalApiUrl === undefined) delete process.env.MERGESTORM_API_URL;
  else process.env.MERGESTORM_API_URL = originalApiUrl;
});

function configureApi(): void {
  process.env.MERGESTORM_API_KEY = "msk_live_queue_test";
  process.env.MERGESTORM_API_URL = "https://api.example.test";
}

async function captureJson(run: () => Promise<void>): Promise<unknown> {
  const output: string[] = [];
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
  await run();
  assert.equal(output.length, 1);
  return JSON.parse(output[0]!);
}

async function captureLines(run: () => Promise<void>): Promise<string> {
  const output: string[] = [];
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
  await run();
  return output.join("\n");
}

const STRIP_ANSI = /\u001b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(STRIP_ANSI, "");

describe("queue commands", { concurrency: false }, () => {
  test("mg queue --json lists live entries", async () => {
    configureApi();
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
      });
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer msk_live_queue_test",
      );
      return Response.json({ entries: [entry] });
    };

    const body = await captureJson(() => cmdQueue(["--json"]));
    assert.deepEqual(body, { entries: [entry] });
    assert.deepEqual(calls, [
      {
        url: "https://api.example.test/api/v1/stacks/queue",
        method: "GET",
      },
    ]);
  });

  test("mg queue add posts the stack and preserves the JSON envelope", async () => {
    configureApi();
    let requestBody: unknown;
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        `https://api.example.test/api/v1/stacks/${stackId}/enqueue`,
      );
      assert.equal(init?.method, "POST");
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ entry, duplicate: false }, { status: 202 });
    };

    const body = await captureJson(() =>
      cmdQueue(["add", stackId, "--json"]),
    );
    assert.deepEqual(requestBody, {});
    assert.deepEqual(body, { entry, duplicate: false });
  });

  test("mg queue rm resolves a stack id to its live entry id", async () => {
    configureApi();
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (init?.method !== "POST") {
        return Response.json({ entries: [entry] });
      }
      assert.equal(
        url,
        `https://api.example.test/api/v1/stacks/queue/${entryId}/cancel`,
      );
      return Response.json({
        entry: { ...entry, state: "cancelled", finishedAt: "2026-08-25T10:01:00Z" },
      });
    };

    const body = await captureJson(() =>
      cmdQueue(["rm", stackId, "--json"]),
    ) as { entry: MergeQueueEntryDto };
    assert.equal(body.entry.id, entryId);
    assert.equal(body.entry.state, "cancelled");
    assert.deepEqual(urls, [
      "https://api.example.test/api/v1/stacks/queue",
      `https://api.example.test/api/v1/stacks/queue/${entryId}/cancel`,
    ]);
  });

  test("mg queue add maps a 404 stack_not_found error", async () => {
    configureApi();
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        `https://api.example.test/api/v1/stacks/${stackId}/enqueue`,
      );
      assert.equal(init?.method, "POST");
      return Response.json({ error: "stack_not_found" }, { status: 404 });
    };
    await assert.rejects(
      () => cmdQueue(["add", stackId, "--json"]),
      (err: unknown) =>
        err instanceof CommandError && err.message === "Stack not found",
    );
  });

  test("mg queue rm maps a 404 entry_not_found error", async () => {
    configureApi();
    globalThis.fetch = async (input, init) => {
      if (init?.method !== "POST") {
        return Response.json({ entries: [entry] });
      }
      assert.equal(
        String(input),
        `https://api.example.test/api/v1/stacks/queue/${entryId}/cancel`,
      );
      return Response.json({ error: "entry_not_found" }, { status: 404 });
    };
    await assert.rejects(
      () => cmdQueue(["rm", stackId, "--json"]),
      (err: unknown) =>
        err instanceof CommandError &&
        err.message === "Merge queue entry not found",
    );
  });

  test("mg queue list maps a generic 404 to the not-available message", async () => {
    configureApi();
    globalThis.fetch = async () =>
      Response.json({ error: "entry_not_found" }, { status: 404 });
    await assert.rejects(
      () => cmdQueue(["--json"]),
      (err: unknown) =>
        err instanceof CommandError &&
        err.message ===
          "Merge queue API is not available on this server yet. Deploy the API update or use the dashboard.",
    );
  });

  test("mg queue rm surfaces a 409 already_finished cancel", async () => {
    configureApi();
    globalThis.fetch = async (input, init) => {
      if (init?.method !== "POST") {
        return Response.json({ entries: [entry] });
      }
      return Response.json(
        { error: "already_finished", entry: { ...entry, state: "landed" } },
        { status: 409 },
      );
    };
    await assert.rejects(
      () => cmdQueue(["rm", stackId, "--json"]),
      (err: unknown) =>
        err instanceof CommandError &&
        err.message.startsWith("Failed to remove merge queue entry (HTTP 409)"),
    );
  });

  test("mg queue add prints Already queued for a duplicate without --json", async () => {
    configureApi();
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        `https://api.example.test/api/v1/stacks/${stackId}/enqueue`,
      );
      assert.equal(init?.method, "POST");
      return Response.json({ duplicate: true }, { status: 202 });
    };

    const out = strip(await captureLines(() => cmdQueue(["add", stackId])));
    assert.match(out, /Already queued/);
  });

  test("mg queue add prints Queued with the position for a fresh enqueue without --json", async () => {
    configureApi();
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        `https://api.example.test/api/v1/stacks/${stackId}/enqueue`,
      );
      assert.equal(init?.method, "POST");
      return Response.json({ entry, duplicate: false }, { status: 202 });
    };

    const out = strip(await captureLines(() => cmdQueue(["add", stackId])));
    assert.match(out, new RegExp(`Queued ${stackId} at position 1`));
  });

  test("mg queue rm prints the removed entry id without --json", async () => {
    configureApi();
    globalThis.fetch = async (input, init) => {
      if (init?.method !== "POST") {
        return Response.json({ entries: [entry] });
      }
      assert.equal(
        String(input),
        `https://api.example.test/api/v1/stacks/queue/${entryId}/cancel`,
      );
      return Response.json({ entry: { ...entry, state: "cancelled" } });
    };

    const out = strip(await captureLines(() => cmdQueue(["rm", stackId])));
    assert.match(out, new RegExp(`Removed ${entryId} from the merge queue`));
  });

  test("buildQueueListLines renders the empty-queue hint", () => {
    const lines = buildQueueListLines([]);
    assert.match(strip(lines.join("\n")), /Nothing queued/);
    assert.ok(lines.some((line) => line.includes("queue add")));
  });

  test("buildQueueListLines renders waitReason and falls back to bounceReason", () => {
    const withWait = strip(buildQueueListLines([entry]).join("\n"));
    assert.match(withWait, /ci_pending on #42/);
    assert.match(withWait, /◐\s+waiting/);
    assert.match(withWait, /acme\/widgets/);
    assert.match(withWait, /11111111/);
    assert.match(withWait, /by human/);
    const bounced = {
      ...entry,
      state: "bounced" as const,
      waitReason: null,
      bounceReason: "unit broke",
    };
    const withBounce = strip(buildQueueListLines([bounced]).join("\n"));
    assert.match(withBounce, /unit broke/);
    assert.match(withBounce, /×\s+bounced/);
  });

  test("mg queue list opens the Queue tabs browser when canBrowse", async () => {
    configureApi();
    globalThis.fetch = async () => Response.json({ entries: [entry] });
    let tabs: LineTab[] | undefined;
    await cmdQueue([], {
      canBrowse: () => true,
      runLineTabsBrowser: async (opts) => {
        tabs = opts.tabs;
      },
    });
    assert.equal(tabs?.length, 1);
    assert.equal(tabs?.[0]?.id, "queue");
    assert.equal(tabs?.[0]?.label, "Queue");
    const text = strip((tabs?.[0]?.lines ?? []).join("\n"));
    assert.match(text, /◐\s+waiting/);
    assert.match(text, /ci_pending on #42/);
    assert.match(text, /11111111/);
    assert.doesNotMatch(text, new RegExp(stackId));
  });

  test("mg queue list presents lines when not a TTY", async () => {
    configureApi();
    globalThis.fetch = async () => Response.json({ entries: [entry] });
    const out = strip(
      await captureLines(() =>
        cmdQueue([], { canBrowse: () => false }),
      ),
    );
    assert.match(out, /◐\s+waiting/);
    assert.match(out, /ci_pending on #42/);
    assert.match(out, new RegExp(stackId));
    assert.doesNotMatch(out, /"entries"/);
  });

  test("queue TUI layout fits rows within the boxed content width with state glyphs", () => {
    const longReason = "ci_pending on #42 please";
    const rows: MergeQueueEntryDto[] = [
      entry,
      { ...entry, id: "q2", state: "queued", waitReason: null, position: 2 },
      { ...entry, id: "q3", state: "running", waitReason: null, position: 3 },
      {
        ...entry,
        id: "q4",
        state: "bounced",
        waitReason: null,
        bounceReason: "ci_failure",
        position: 4,
      },
      { ...entry, id: "q5", waitReason: longReason, position: 5 },
    ];
    const lines = buildQueueListLines(rows);
    const text = strip(lines.join("\n"));
    assert.match(text, /○\s+queued/);
    assert.match(text, /●\s+running/);
    assert.match(text, /◐\s+waiting/);
    assert.match(text, /×\s+bounced/);
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= 75,
        `queue row is ${visibleWidth(line)} cells (content is 75 at 80 cols): ${strip(line)}`,
      );
    }
    const layout = layoutLineTabs(
      [{ id: "queue", label: "Queue", lines }],
      initialLineTabsState(1),
      80,
      16,
      false,
    );
    assert.match(strip(layout.lines.join("\n")), /\[Queue\]/);
    assert.match(strip(layout.lines.join("\n")), new RegExp(longReason));
    for (const row of layout.lines) {
      assert.ok(visibleWidth(row) <= 79, `layout row is ${visibleWidth(row)} cells`);
    }
  });

  test("entry id wins over a colliding stack id", () => {
    const collision = {
      ...entry,
      id: stackId,
      stackId: "33333333-3333-4333-8333-333333333333",
    };
    assert.equal(resolveQueueEntryId(stackId, [entry, collision]), stackId);
  });

  test("mg stack auto-promote is an unknown subcommand (#1505)", async () => {
    configureApi();
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return Response.json({});
    };
    await assert.rejects(
      () => cmdStack(["auto-promote", "on", stackId, "--json"]),
      /unknown stack subcommand: auto-promote/,
    );
    assert.equal(fetchCalled, false);
  });
});
