import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isSupportedNode } from "./node-version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliTs = path.join(here, "cli.ts");

/** Node binary that satisfies engines.node >= 22 (skip suite if none available). */
function resolveNode22(): string | null {
  const candidates = [
    process.execPath,
    process.env.NPM_NODE_EXEC_PATH,
    // Prefer a local nvm install when PATH points at an older Node.
    path.join(process.env.HOME ?? "", ".nvm/versions/node/v22.22.3/bin/node"),
  ].filter((p): p is string => Boolean(p));
  for (const bin of candidates) {
    if (!fs.existsSync(bin)) continue;
    const v = spawnSync(bin, ["-p", "process.versions.node"], { encoding: "utf8" });
    if (v.status === 0 && isSupportedNode((v.stdout ?? "").trim())) return bin;
  }
  return null;
}

const nodeBin = resolveNode22();

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  assert.ok(nodeBin, "Node 22+ required to smoke-test CLI help exits");
  const r = spawnSync(nodeBin, ["--import", "tsx/esm", cliTs, ...args], {
    encoding: "utf8",
    env: { ...process.env, MERGESTORM_API_KEY: "" },
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

describe("CLI help exits", { skip: !nodeBin }, () => {
  it("mergestorm --help exits 0 with usage on stdout", () => {
    const r = runCli(["--help"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stdout, /--router/);
    assert.equal(r.stderr.trim(), "");
  });

  it("mergestorm help exits 0", () => {
    const r = runCli(["help"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage:/);
  });

  it("mergestorm stack --help exits 0", () => {
    const r = runCli(["stack", "--help"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /auto-promote/);
    assert.doesNotMatch(r.stdout, /unknown stack subcommand/);
  });

  it("mergestorm stack help exits 0", () => {
    const r = runCli(["stack", "help"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /auto-promote/);
    assert.doesNotMatch(r.stdout, /unknown stack subcommand/);
  });

  it("unknown command still exits non-zero", () => {
    const r = runCli(["definitely-not-a-command"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /unknown command/);
  });
});
