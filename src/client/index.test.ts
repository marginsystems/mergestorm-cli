import assert from "node:assert/strict";
import { test } from "node:test";
import * as client from "./index.js";

test("mergestorm/client exports machine helpers and not TUI renderers", () => {
  assert.equal(typeof client.loadConfig, "function");
  assert.equal(typeof client.apiFetch, "function");
  assert.equal(typeof client.getReview, "function");
  assert.equal(typeof client.submitReview, "function");
  assert.equal(typeof client.pollReview, "function");
  assert.equal(typeof client.loadReviewContext, "function");
  assert.equal(typeof client.collectReviewInput, "function");
  assert.equal(typeof client.toReviewJobEnvelope, "function");
  assert.equal(typeof client.parseRetryAfterSeconds, "function");
  assert.equal(typeof client.transientRetryWaitMs, "function");
  assert.equal(client.REVIEW_EXIT.rate_limited, 7);
  assert.equal("renderFindings" in client, false);
  assert.equal("printWordmark" in client, false);
});
