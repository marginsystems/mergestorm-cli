import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, parseLine } from "./shell.js";
import { matchSlashCommands } from "./ui/prompt.js";

test("parseLine strips a leading slash", () => {
  assert.deepEqual(parseLine("/review main head"), {
    cmd: "review",
    args: ["main", "head"],
  });
  assert.deepEqual(parseLine("review main head"), {
    cmd: "review",
    args: ["main", "head"],
  });
});

test("parseLine trims whitespace, lowercases the command, and rejects empty input", () => {
  assert.deepEqual(parseLine("  Status  123  "), { cmd: "status", args: ["123"] });
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("   "), null);
  assert.equal(parseLine("/"), null);
  assert.equal(parseLine("/  "), null);
});

test("COMMANDS has no duplicate names and every entry has a summary", () => {
  const names = COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  for (const c of COMMANDS) {
    assert.ok(c.summary.length > 0, `${c.name} should have a summary`);
  }
});

test("COMMANDS filters by prefix like the shell dropdown does", () => {
  const hits = matchSlashCommands("/lo", COMMANDS).map((c) => c.name);
  assert.deepEqual(hits.sort(), ["login", "logout"].sort());

  assert.equal(matchSlashCommands("/zzz", COMMANDS).length, 0);
  assert.equal(matchSlashCommands("/", COMMANDS).length, COMMANDS.length);
  assert.equal(matchSlashCommands("/us", COMMANDS)[0]?.name, "credits");
  assert.equal(matchSlashCommands("/q", COMMANDS)[0]?.name, "exit");
});
