import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, saveAccount, useAccount } from "../config.js";
import { CommandError } from "../errors.js";
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
  assert.ok(names.includes("queue"));
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
  assert.match(body, /MERGESTORM_ACCOUNT/);
  assert.match(body, /--account <name>/);
  assert.match(body, /mergestorm account use <name>/);
  for (const c of COMMAND_REGISTRY) {
    for (const line of c.usage) {
      assert.ok(body.includes(line), `usage missing: ${line}`);
    }
  }
});

test("dispatchCommand returns false for unknown names", async () => {
  assert.equal(await dispatchCommand("definitely-not-a-command", [], { mode: "oneshot" }), false);
});

test("dispatchCommand runs a command as the --account named anywhere in its args, then restores the active account", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mg-registry-"));
  const previousHome = process.env.MERGESTORM_HOME;
  const previousAccount = process.env.MERGESTORM_ACCOUNT;
  process.env.MERGESTORM_HOME = root;
  delete process.env.MERGESTORM_ACCOUNT;
  t.after(() => {
    if (previousHome === undefined) delete process.env.MERGESTORM_HOME;
    else process.env.MERGESTORM_HOME = previousHome;
    if (previousAccount === undefined) delete process.env.MERGESTORM_ACCOUNT;
    else process.env.MERGESTORM_ACCOUNT = previousAccount;
    rmSync(root, { recursive: true, force: true });
  });
  await saveAccount("a", { apiKey: "msk_live_a1" });
  await saveAccount("b", { apiKey: "msk_live_b1" });
  await useAccount("a");
  const seen: { args: string[]; account: string | undefined }[] = [];
  COMMAND_REGISTRY.push({
    name: "probe-account",
    summary: "test",
    usage: [],
    async run(args) {
      seen.push({ args, account: (await loadConfig()).account });
    },
  });
  t.after(() => {
    COMMAND_REGISTRY.splice(COMMAND_REGISTRY.findIndex((c) => c.name === "probe-account"), 1);
  });
  assert.equal(await dispatchCommand("probe-account", ["x", "--account", "b", "--json"], { mode: "shell" }), true);
  assert.equal(await dispatchCommand("probe-account", ["--account=b"], { mode: "oneshot" }), true);
  assert.equal(await dispatchCommand("probe-account", ["y"], { mode: "oneshot", account: "b" }), true);
  assert.equal(await dispatchCommand("probe-account", [], { mode: "oneshot" }), true);
  assert.deepEqual(seen, [
    { args: ["x", "--json"], account: "b" },
    { args: [], account: "b" },
    { args: ["y"], account: "b" },
    { args: [], account: "a" },
  ]);
  await assert.rejects(
    () => dispatchCommand("probe-account", ["--account", "zz"], { mode: "oneshot" }),
    (err: unknown) => err instanceof CommandError && /No account named "zz". Accounts: a, b./.test(err.message),
  );
  assert.equal((await loadConfig()).account, "a");
});
