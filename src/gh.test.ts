import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "./errors.js";
import { requireGh, runGh } from "./gh.js";

test("runGh returns structured failure for unknown subcommand", () => {
  const res = runGh(["this-subcommand-does-not-exist-xyz"]);
  // gh may be missing in CI; either ENOENT-style or non-zero is fine
  if (res.ok) {
    assert.fail("expected unknown gh subcommand to fail");
  }
  assert.ok(typeof res.stderr === "string");
});

test("requireGh throws CommandError when gh is unusable", () => {
  // Smoke: if gh works in this environment, requireGh should not throw.
  // If gh is missing, it must throw CommandError (not a raw Error).
  try {
    requireGh();
  } catch (err) {
    assert.ok(err instanceof CommandError);
    assert.match(err.message, /gh/i);
  }
});
