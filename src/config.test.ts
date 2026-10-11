import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configPath, loadConfig, mergestormHome, saveConfig } from "./config.js";
import { cliStacksRoot } from "./repo-identity.js";

test("mergestormHome is ~/.mergestorm unless MERGESTORM_HOME names another directory", () => {
  assert.equal(mergestormHome({}), path.join(homedir(), ".mergestorm"));
  assert.equal(mergestormHome({ MERGESTORM_HOME: "   " }), path.join(homedir(), ".mergestorm"));
  assert.equal(mergestormHome({ MERGESTORM_HOME: " /workspace/.mg-state " }), "/workspace/.mg-state");
  assert.equal(mergestormHome({ MERGESTORM_HOME: "relative/state" }), path.resolve("relative/state"));
});

test("MERGESTORM_HOME moves the saved login and the stack state out of the home directory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mg-home-"));
  const previous = process.env.MERGESTORM_HOME;
  process.env.MERGESTORM_HOME = root;
  try {
    assert.equal(configPath(), path.join(root, "config.json"));
    assert.equal(cliStacksRoot(), path.join(root, "stacks"));
    await saveConfig({ apiKey: "msk_live_test" });
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")), { apiKey: "msk_live_test" });
    assert.deepEqual(await loadConfig(), { apiKey: "msk_live_test" });
  } finally {
    if (previous === undefined) delete process.env.MERGESTORM_HOME;
    else process.env.MERGESTORM_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
