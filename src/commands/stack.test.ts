import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "../errors.js";
import {
  parseAdoptTarget,
  parseStackCreateArgs,
  parseStackResetArgs,
  requireStackId,
} from "./stack.js";

test("parseStackCreateArgs parses name, onto, trunk, json", () => {
  assert.deepEqual(parseStackCreateArgs(["feat/foo", "--onto", "main", "--json"]), {
    name: "feat/foo",
    onto: "main",
    trunk: undefined,
    asJson: true,
  });
  assert.deepEqual(parseStackCreateArgs(["--onto=ms/a", "--trunk", "master"]), {
    name: undefined,
    onto: "ms/a",
    trunk: "master",
    asJson: false,
  });
});

test("parseStackCreateArgs rejects unknown flags", () => {
  assert.throws(() => parseStackCreateArgs(["--nope"]), CommandError);
});

test("stack reset requires the explicit --force guard", () => {
  assert.doesNotThrow(() => parseStackResetArgs(["--force"]));
  assert.throws(() => parseStackResetArgs([]), /stack reset --force/);
  assert.throws(() => parseStackResetArgs(["--json"]), /stack reset --force/);
  assert.throws(
    () => parseStackResetArgs(["--force", "extra"]),
    /stack reset --force/,
  );
});

test("parseAdoptTarget accepts owner/repo#pr", () => {
  assert.deepEqual(parseAdoptTarget(["acme/widgets#12"]), {
    owner: "acme",
    repo: "widgets",
    prNumber: 12,
  });
});

test("parseAdoptTarget accepts owner/repo and pr as separate args", () => {
  assert.deepEqual(parseAdoptTarget(["acme/widgets", "12"]), {
    owner: "acme",
    repo: "widgets",
    prNumber: 12,
  });
});

test("parseAdoptTarget rejects junk", () => {
  assert.throws(() => parseAdoptTarget(["nope"]), CommandError);
  assert.throws(() => parseAdoptTarget(["acme/widgets"]), CommandError);
});

test("requireStackId accepts a UUID", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(requireStackId(id, "usage"), id);
});

test("requireStackId rejects non-UUID", () => {
  assert.throws(() => requireStackId("not-a-uuid", "usage"), CommandError);
  assert.throws(() => requireStackId(undefined, "usage"), CommandError);
});
