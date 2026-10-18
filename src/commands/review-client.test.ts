import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { submitReview, type ReviewInput } from "./review-client.js";

const cfg = { apiKey: "msk_test", apiBase: "http://127.0.0.1:9" };
const input: ReviewInput = {
  thread: "feature",
  branch: "feature",
  baseLabel: "main",
  headLabel: "HEAD",
  diff: "diff --git a/a.txt b/a.txt\n-one\n+two\n",
  files: [{ path: "a.txt", content: "two\n" }],
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockPosts(responses: { status: number; body: unknown }[]): Record<string, unknown>[] {
  const posts: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    posts.push(JSON.parse(String(init?.body)));
    const response = responses[Math.min(posts.length - 1, responses.length - 1)]!;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return posts;
}

test("submitReview sends the same derived idempotency key when a timed out submit is rerun", async () => {
  const posts = mockPosts([{ status: 202, body: { job_id: "job-1", status: "queued" } }]);
  await submitReview(cfg, input, { routerMode: "standard", context: "why" });
  await submitReview(cfg, input, { routerMode: "standard", context: "why" });
  await submitReview(cfg, { ...input, diff: `${input.diff}+three\n` }, { routerMode: "standard", context: "why" });
  await submitReview(cfg, input, { routerMode: "max", context: "why" });
  await submitReview(cfg, input, { routerMode: "standard", context: "why", idempotencyKey: "caller-key" });
  const keys = posts.map((post) => post.idempotency_key);
  assert.match(String(keys[0]), /^mg-auto-[0-9a-f]{64}$/);
  assert.ok(String(keys[0]).length <= 128);
  assert.equal(keys[1], keys[0]);
  assert.notEqual(keys[2], keys[0]);
  assert.notEqual(keys[3], keys[0]);
  assert.equal(keys[4], "caller-key");
});

test("submitReview resubmits past a replayed failed job and returns a replayed live job", async () => {
  const posts = mockPosts([
    { status: 200, body: { job_id: "job-failed", status: "failed" } },
    { status: 202, body: { job_id: "job-2", status: "queued" } },
  ]);
  const submitted = await submitReview(cfg, input);
  assert.equal(submitted.status, 202);
  assert.equal(submitted.row.job_id, "job-2");
  assert.equal(posts.length, 2);
  assert.notEqual(posts[1]!.idempotency_key, posts[0]!.idempotency_key);

  const replayed = mockPosts([{ status: 200, body: { job_id: "job-1", status: "completed" } }]);
  const done = await submitReview(cfg, input);
  assert.equal(done.row.job_id, "job-1");
  assert.equal(replayed.length, 1);

  const explicit = mockPosts([{ status: 200, body: { job_id: "job-failed", status: "failed" } }]);
  const kept = await submitReview(cfg, input, { idempotencyKey: "caller-key" });
  assert.equal(kept.row.status, "failed");
  assert.equal(explicit.length, 1);
});
