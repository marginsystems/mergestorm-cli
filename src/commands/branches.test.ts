import assert from "node:assert/strict";
import { test } from "node:test";
import { formatThreadTimeline } from "./jobs.js";
import { formatBranchRow } from "./branches.js";
import type { ThreadDetail, ThreadListItem } from "../api.js";

test("formatBranchRow prefers branch name and includes job/verdict/when", () => {
  const item: ThreadListItem = {
    slug: "local/feat/x",
    branch: "feat/x",
    owner: "acme",
    repo: "app",
    pr_number: 12,
    status: "active",
    job_count: 3,
    last_verdict: "comment",
    last_activity_at: new Date().toISOString(),
  };
  const line = formatBranchRow(item);
  assert.match(line, /feat\/x/);
  assert.match(line, /3 jobs/);
  assert.match(line, /comment/);
  assert.match(line, /PR #12/);
});

test("formatBranchRow falls back to slug when branch is null", () => {
  const item: ThreadListItem = {
    slug: "local/orphan",
    branch: null,
    owner: null,
    repo: null,
    pr_number: null,
    status: "closed",
    job_count: 1,
    last_verdict: null,
    last_activity_at: "2026-07-01T00:00:00Z",
  };
  const line = formatBranchRow(item);
  assert.match(line, /local\/orphan/);
  assert.match(line, /1 job\b/);
  assert.match(line, /closed/);
});

test("formatThreadTimeline numbers jobs and shows branch/PR meta", () => {
  const data: ThreadDetail = {
    thread_id: "t1",
    slug: "local/feat/x",
    branch: "feat/x",
    owner: "acme",
    repo: "app",
    pr_number: 9,
    status: "active",
    pr_linked_at: null,
    job_count: 2,
    created_at: "2026-07-01T00:00:00Z",
    jobs: [
      {
        job_id: "aaaaaaaa-1111-2222-3333-444444444444",
        status: "completed",
        verdict: "approve",
        thread_job_number: 2,
        created_at: "2026-07-02T00:00:00Z",
      },
      {
        job_id: "bbbbbbbb-1111-2222-3333-444444444444",
        status: "completed",
        verdict: "comment",
        thread_job_number: 1,
        created_at: "2026-07-01T12:00:00Z",
      },
    ],
  };
  const lines = formatThreadTimeline(data);
  const plain = lines.join("\n");
  assert.match(plain, /feat\/x/);
  assert.match(plain, /pull\/9/);
  assert.match(plain, /#1\b/);
  assert.match(plain, /#2\b/);
  // Chronological by thread_job_number
  const i1 = plain.indexOf("#1");
  const i2 = plain.indexOf("#2");
  assert.ok(i1 >= 0 && i2 > i1);
});
