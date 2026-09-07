import assert from "node:assert/strict";
import { test } from "node:test";
import { humanSummary } from "./human-summary.js";

test("strips a fenced JSON tool payload", () => {
  assert.equal(
    humanSummary('Useful prose.\n```json\n{"name":"review","arguments":{"base":"main"}}\n```'),
    "Useful prose.",
  );
});

test("strips a bare tool object", () => {
  assert.equal(
    humanSummary('{"tool_calls":[{"function":{"name":"review","arguments":"{}"}}]}'),
    null,
  );
});

test("strips a standalone JSON array line", () => {
  assert.equal(humanSummary("Readable summary.\n[1,2,3]\nStill readable."), "Readable summary.\nStill readable.");
});

test("strips prose followed by a JSON payload", () => {
  assert.equal(
    humanSummary('Review completed successfully.\n{"verdict":"approve","comments":[]}'),
    "Review completed successfully.",
  );
});

test("strips a multi-line tool payload between prose", () => {
  assert.equal(
    humanSummary(
      'Review finished.\n{\n  "tool": "browser",\n  "arguments": "goto"\n}\nThanks!',
    ),
    "Review finished.\nThanks!",
  );
});

test("strips a multi-line Anthropic tool-use payload between prose", () => {
  assert.equal(
    humanSummary(
      'Reviewing now.\n{\n  "type": "tool_use",\n  "name": "view_file",\n  "input": {"path": "package.json"}\n}\nDone.',
    ),
    "Reviewing now.\nDone.",
  );
});

test("keeps a multi-line JSON example intact", () => {
  const summary = "Suggested:\n{\n  \"retries\": 3\n}\nOK?";
  assert.equal(humanSummary(summary), summary);
});

test("keeps a multi-line JSON example opened mid-line intact", () => {
  const summary = 'Suggested config: {\n  "retries": 3\n}\nOK?';
  assert.equal(humanSummary(summary), summary);
});

test("keeps an inline JSON example with a name intact", () => {
  const summary = 'The new config block {"name": "api", "version": 2} is fine.\nMore text.';
  assert.equal(humanSummary(summary), summary);
});

test("keeps a multi-line schema JSON example intact", () => {
  const summary = 'Suggested:\n{\n  "name": "user",\n  "arguments": "email"\n}\nOK?';
  assert.equal(humanSummary(summary), summary);
});

test("keeps nested JSON example elements intact", () => {
  const summary = 'Suggested:\n{\n  "x": [\n    {"a": 1}\n  ]\n}\nOK?';
  assert.equal(humanSummary(summary), summary);
});

test("strips leftover fence ticks and orphan braces", () => {
  assert.equal(humanSummary("Readable summary.\n```\n}\n{"), "Readable summary.");
});

test("keeps clean prose unchanged", () => {
  assert.equal(
    humanSummary("The implementation is clear.\nNo changes requested."),
    "The implementation is clear.\nNo changes requested.",
  );
});

test("keeps a TypeScript code example unchanged", () => {
  const summary = "Example:\n```ts\nconst result = { ok: true };\n```";
  assert.equal(humanSummary(summary), summary);
});

test("keeps brace-only lines inside fenced code unchanged", () => {
  const summary = "Example:\n```ts\nif (x) {\n  run();\n}\n```";
  assert.equal(humanSummary(summary), summary);
});

test("keeps brace-only lines inside an unlabeled fence unchanged", () => {
  const summary = "Example:\n```\n{\n}\n```";
  assert.equal(humanSummary(summary), summary);
});

test("keeps JSON values inside a code fence unchanged", () => {
  const summary = "Example:\n```\n{\"a\": 1}\n```";
  assert.equal(humanSummary(summary), summary);
});

test("keeps tool-shaped JSON inside a labeled code fence unchanged", () => {
  const summary = 'Example:\n```ts\nconst call = {"tool": "browser", "arguments": "goto"};\n```\nDone.';
  assert.equal(humanSummary(summary), summary);
});

test("keeps tool-shaped JSON inside an unlabeled code fence unchanged", () => {
  const summary = 'Example:\n```\n{"tool": "browser"}\n```';
  assert.equal(humanSummary(summary), summary);
});

test("returns null when nothing readable remains", () => {
  assert.equal(
    humanSummary('```json\n{"name":"review","arguments":{}}\n```\n```'),
    null,
  );
});
