import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrBodyFromCommit } from "./pr-body.js";

test("subject-only commit", () => {
  const body = buildPrBodyFromCommit("feat(cli): add thing\n");
  assert.match(body, /^## Summary\n- feat\(cli\): add thing\n/);
  assert.match(body, /## Test plan\n- \[ \] CI green\n$/);
  assert.doesNotMatch(body, /Fixes #/);
});

test("body paragraphs become extra summary bullets", () => {
  const body = buildPrBodyFromCommit(
    "feat(cli): add thing\n\nFirst detail.\n\nSecond detail.\n",
  );
  assert.match(body, /- feat\(cli\): add thing\n/);
  assert.match(body, /- First detail\.\n/);
  assert.match(body, /- Second detail\.\n/);
});

test("Fixes trailer is preserved at end", () => {
  const body = buildPrBodyFromCommit(
    "feat(cli): add thing\n\nWhy it matters.\n\nFixes #217\n",
  );
  assert.match(body, /- Why it matters\.\n/);
  assert.doesNotMatch(body, /- Fixes #217/);
  assert.match(body, /\nFixes #217\n$/);
});

test("Closes and Resolves are normalized", () => {
  const body = buildPrBodyFromCommit("fix: x\n\ncloses #10\nResolves #11\n");
  assert.match(body, /\nCloses #10\nResolves #11\n$/);
});

test("duplicate trailers collapsed", () => {
  const body = buildPrBodyFromCommit("fix: x\n\nFixes #5\nfixes #5\n");
  assert.equal((body.match(/Fixes #5/g) ?? []).length, 1);
});
