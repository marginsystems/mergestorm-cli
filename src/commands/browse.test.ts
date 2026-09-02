import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildStatusTabLines, openTabsBrowser } from "./browse.js";

const STRIP_ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(STRIP_ANSI, "");

let originalFetch: typeof globalThis.fetch | undefined;
let originalApiKey: string | undefined;
let originalApiUrl: string | undefined;

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
  if (originalApiKey === undefined) delete process.env.MERGESTORM_API_KEY;
  else process.env.MERGESTORM_API_KEY = originalApiKey;
  originalApiKey = undefined;
  if (originalApiUrl === undefined) delete process.env.MERGESTORM_API_URL;
  else process.env.MERGESTORM_API_URL = originalApiUrl;
  originalApiUrl = undefined;
});

test("buildStatusTabLines puts credits in the body, not a reachability bullet", () => {
  const lines = buildStatusTabLines({
    keyPrefix: "msk_live_abcd",
    keyName: "laptop",
    plan: "maelstrom",
    apiBase: "https://api.example.test",
    reachable: true,
    keyInvalid: false,
    used: 25,
    limit: 100,
    remaining: 75,
    resetsAt: "2026-09-05T10:53:00.000Z",
    now: new Date("2026-08-25T03:00:00.000Z"),
  });
  const text = stripAnsi(lines.join("\n"));
  assert.match(text, /25 \/ 100 used · 75 left/);
  assert.match(text, /11 days left/);
  assert.doesNotMatch(text, /API reachable/);
  assert.doesNotMatch(text, /●/);
});

test("buildStatusTabLines renders an invalid-key status line", () => {
  const lines = buildStatusTabLines({
    keyPrefix: "msk_live_dead",
    keyName: null,
    plan: null,
    apiBase: "https://api.example.test",
    reachable: false,
    keyInvalid: true,
  });
  const text = stripAnsi(lines.join("\n"));
  assert.match(text, /invalid or revoked/);
  assert.doesNotMatch(text, /unreachable/);
  assert.doesNotMatch(text, /●/);
});

test("openTabsBrowser surfaces a revoked key instead of claiming the API is unreachable", async () => {
  originalApiKey = process.env.MERGESTORM_API_KEY;
  process.env.MERGESTORM_API_KEY = "msk_live_dead_key";
  originalApiUrl = process.env.MERGESTORM_API_URL;
  process.env.MERGESTORM_API_URL = "https://api.example.test";
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/v1/me")) {
      return new Response(JSON.stringify({ error: "auth_invalid" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };

  const out: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  try {
    await openTabsBrowser("status");
  } finally {
    console.log = originalLog;
  }
  const text = stripAnsi(out.join("\n"));
  assert.match(text, /invalid or revoked/);
  assert.doesNotMatch(text, /API unreachable/);
});
