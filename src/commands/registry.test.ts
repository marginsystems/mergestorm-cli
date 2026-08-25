import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMAND_REGISTRY,
  dispatchCommand,
  findCommand,
  formatUsageBody,
  shellCommandSpecs,
} from "./registry.js";

test("COMMAND_REGISTRY names are unique", () => {
  const names = COMMAND_REGISTRY.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
});

test("aliases resolve to the same command as the primary name", () => {
  assert.equal(findCommand("usage")?.name, "credits");
  assert.equal(findCommand("chains")?.name, "branches");
  assert.equal(findCommand("CREDITS")?.name, "credits");
});

test("shellCommandSpecs folds aliases onto primaries and omits oneshot-only shell", () => {
  const specs = shellCommandSpecs();
  const names = specs.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("help"));
  assert.ok(names.includes("clear"));
  assert.ok(names.includes("exit"));
  assert.ok(!names.includes("usage"));
  assert.ok(!names.includes("chains"));
  assert.ok(!names.includes("quit"));
  assert.ok(!names.includes("shell"));
  assert.deepEqual(specs.find((c) => c.name === "credits")?.aliases, ["usage"]);
  assert.deepEqual(specs.find((c) => c.name === "branches")?.aliases, ["chains"]);
  assert.deepEqual(specs.find((c) => c.name === "exit")?.aliases, ["quit"]);
  for (const c of specs) {
    assert.ok(c.summary.length > 0, `${c.name} needs a summary`);
  }
});

test("formatUsageBody lists every registry usage line", () => {
  const body = formatUsageBody();
  assert.match(body, /Interactive shell/);
  assert.match(body, /MERGESTORM_API_KEY/);
  for (const c of COMMAND_REGISTRY) {
    for (const line of c.usage) {
      assert.ok(body.includes(line), `usage missing: ${line}`);
    }
  }
});

test("dispatchCommand returns false for unknown names", async () => {
  assert.equal(await dispatchCommand("definitely-not-a-command", [], { mode: "oneshot" }), false);
});
