import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError, isCommandErrorCode } from "./errors.js";

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
