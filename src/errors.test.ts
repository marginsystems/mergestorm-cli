import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CommandError,
  REVIEW_EXIT,
  isCommandErrorCode,
  rateLimitedMessage,
} from "./errors.js";

test("CommandError keeps optional code and default exitCode", () => {
  const plain = new CommandError("boom");
  assert.equal(plain.exitCode, 1);
  assert.equal(plain.code, undefined);

  const coded = new CommandError("timed out", 1, "api_timeout");
  assert.equal(coded.code, "api_timeout");
  assert.equal(coded.exitCode, 1);
});

test("isCommandErrorCode matches code only", () => {
  const err = new CommandError("API key invalid or revoked. Run login.", 1, "auth_invalid");
  assert.equal(isCommandErrorCode(err, "auth_invalid"), true);
  assert.equal(isCommandErrorCode(err, "api_timeout"), false);
  assert.equal(isCommandErrorCode(new Error("API key invalid or revoked"), "auth_invalid"), false);
  // Rewording the message must not affect the match.
  const reworded = new CommandError("That key is dead. Get a new one.", 1, "auth_invalid");
  assert.equal(isCommandErrorCode(reworded, "auth_invalid"), true);
});

test("REVIEW_EXIT.rate_limited is 7 and CommandError keeps retryAfterSeconds", () => {
  assert.equal(REVIEW_EXIT.rate_limited, 7);
  const err = new CommandError(
    rateLimitedMessage(30),
    REVIEW_EXIT.rate_limited,
    "rate_limited",
    { retryAfterSeconds: 30 },
  );
  assert.equal(err.code, "rate_limited");
  assert.equal(err.exitCode, 7);
  assert.equal(err.retryAfterSeconds, 30);
  assert.match(err.message, /Retry after 30s/);
});
