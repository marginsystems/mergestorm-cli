import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrBodyFromCommit, linkedIssueNumbers } from "./pr-body.js";

test("linkedIssueNumbers reads same-repo closing keywords from every text, once each, in order", () => {
  assert.deepEqual(
    linkedIssueNumbers(
      { owner: "acme", repo: "widgets" },
      "Fix the gate\n\nFixes #12\ncloses #3",
      "## Summary\n- Resolves #12 too\n- Fix: #40 and resolved #7",
    ),
    [3, 7, 12, 40],
  );
});

test("linkedIssueNumbers ignores mentions, other repositories and words that only contain a keyword", () => {
  assert.deepEqual(
    linkedIssueNumbers(
      { owner: "acme", repo: "widgets" },
      "See #5\nFixes acme/other#6\nFixes https://github.com/acme/widgets/issues/8\nprefixes #9\nPart of #10",
    ),
    [],
  );
});

test("subject-only commit", () => {
  const body = buildPrBodyFromCommit("feat(cli): add thing\n");
  assert.match(body, /^## Summary\n- feat\(cli\): add thing\n/);
  assert.match(body, /## Test plan\n- \[ \] CI green\n$/);
  assert.doesNotMatch(body, /Fixes #/);
});

test("body paragraphs stay paragraphs and the subject is not repeated", () => {
  const body = buildPrBodyFromCommit(
    "feat(cli): add thing\n\nFirst detail.\n\nSecond detail.\n",
  );
  assert.equal(body, "## Summary\nFirst detail.\n\nSecond detail.\n\n## Test plan\n- [ ] CI green\n");
});

test("Fixes trailer is preserved at end", () => {
  const body = buildPrBodyFromCommit(
    "feat(cli): add thing\n\nWhy it matters.\n\nFixes #217\n",
  );
  assert.match(body, /^## Summary\nWhy it matters\.\n\n## Test plan\n/);
  assert.doesNotMatch(body, /- Fixes #217/);
  assert.match(body, /\nFixes #217\n$/);
});

test("hard-wrapped lines of a paragraph are joined with a space", () => {
  const body = buildPrBodyFromCommit(
    [
      "Give the reviewer's starting prompt one budget so large passes keep room to trace code",
      "",
      "On a large PR about one reviewer loop in eight started at 60K to 90K",
      "tokens and was stopped by the 100K prompt ceiling after one to three",
      "tool results.",
      "",
      "Each reviewer loop logs one line with the chars of shared context,",
      "patches and source, the padding used and the budget.",
      "",
      "Fixes #7363",
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
      "",
    ].join("\n"),
  );
  assert.equal(
    body,
    [
      "## Summary",
      "On a large PR about one reviewer loop in eight started at 60K to 90K tokens and was stopped by the 100K prompt ceiling after one to three tool results.",
      "",
      "Each reviewer loop logs one line with the chars of shared context, patches and source, the padding used and the budget.",
      "",
      "## Test plan",
      "- [ ] CI green",
      "",
      "Fixes #7363",
      "",
    ].join("\n"),
  );
});

test("Markdown in the body passes through and trailers other than closing keywords are dropped", () => {
  const body = buildPrBodyFromCommit(
    [
      "Add Mac app and iOS app tabs to the admin panel",
      "",
      "The admin panel showed nothing about who uses the Mac and iOS apps.",
      "",
      "## What changes",
      "- New table `public.app_usage_events` (service_role only). The API writes",
      "  one `active` row per user.",
      "* Failed chat turns now carry the app's platform and version.",
      "+ A plus item.",
      "1. A numbered item.",
      "> A quote.",
      "| a | b |",
      "|---|---|",
      "<details>",
      "---",
      "Line with a hard break  ",
      "next line\\",
      "last line",
      "",
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
      "signed-off-by: Someone <someone@example.com>",
      "",
      "Fixes #7042",
    ].join("\n"),
  );
  assert.equal(
    body,
    [
      "## Summary",
      "The admin panel showed nothing about who uses the Mac and iOS apps.",
      "",
      "## What changes",
      "- New table `public.app_usage_events` (service_role only). The API writes",
      "  one `active` row per user.",
      "* Failed chat turns now carry the app's platform and version.",
      "+ A plus item.",
      "1. A numbered item.",
      "> A quote.",
      "| a | b |",
      "|---|---|",
      "<details>",
      "---",
      "Line with a hard break  ",
      "next line\\",
      "last line",
      "",
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      "",
      "## Test plan",
      "- [ ] CI green",
      "",
      "Fixes #7042",
      "",
    ].join("\n"),
  );
});

test("a fenced block is kept verbatim, including blank lines and trailer-like lines", () => {
  const body = buildPrBodyFromCommit(
    [
      "fix: x",
      "",
      "Before the fence",
      "wrapped.",
      "```ts",
      "const a = 1;",
      "",
      "Co-Authored-By: not a trailer",
      "Fixes #99",
      "```",
      "After the fence.",
    ].join("\n"),
  );
  assert.equal(
    body,
    [
      "## Summary",
      "Before the fence wrapped.",
      "```ts",
      "const a = 1;",
      "",
      "Co-Authored-By: not a trailer",
      "Fixes #99",
      "```",
      "After the fence.",
      "",
      "## Test plan",
      "- [ ] CI green",
      "",
    ].join("\n"),
  );
});

test("an empty body keeps the subject as a one-line summary", () => {
  const body = buildPrBodyFromCommit("fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\nFixes #3\n");
  assert.equal(body, "## Summary\n- fix: x\n\n## Test plan\n- [ ] CI green\n\nFixes #3\n");
});

test("a subject-only closing keyword appears once, as the trailer", () => {
  const body = buildPrBodyFromCommit("Fixes #5\n");
  assert.equal((body.match(/fixes #5/gi) ?? []).length, 1);
  assert.equal(body, "## Test plan\n- [ ] CI green\n\nFixes #5\n");
});

test("CRLF input renders like LF input", () => {
  const message = "fix: x\n\nFirst line\nwrapped.\n\nFixes #8\nCo-Authored-By: Claude <noreply@anthropic.com>\n";
  assert.equal(buildPrBodyFromCommit(message.replace(/\n/g, "\r\n")), buildPrBodyFromCommit(message));
  assert.match(buildPrBodyFromCommit(message), /^## Summary\nFirst line wrapped\.\n\n/);
});

test("Closes and Resolves are normalized", () => {
  const body = buildPrBodyFromCommit("fix: x\n\ncloses #10\nResolves #11\n");
  assert.match(body, /\nCloses #10\nResolves #11\n$/);
});

test("duplicate trailers collapsed", () => {
  const body = buildPrBodyFromCommit("fix: x\n\nFixes #5\nfixes #5\n");
  assert.equal((body.match(/fixes #5/gi) ?? []).length, 1);
});

test("a body with its own Test plan section gets no second Test plan and keeps the trailer last", () => {
  const body = buildPrBodyFromCommit(
    "feat(cli): add thing\n\nWhy it matters.\n\n## Test plan\n- npm test\n\nFixes #7441\n",
  );
  assert.equal(body, "## Summary\nWhy it matters.\n\n## Test plan\n- npm test\n\nFixes #7441\n");
});

test("a Test plan heading of another level counts as the body's own Test plan", () => {
  const body = buildPrBodyFromCommit("feat(cli): add thing\n\nWhy.\n\n### Test plan\n- ran it\n");
  assert.equal(body, "## Summary\nWhy.\n\n### Test plan\n- ran it\n");
});

test("a Test plan heading matches case-insensitively with a trailing colon", () => {
  const body = buildPrBodyFromCommit("feat(cli): add thing\n\nWhy.\n\n## Test Plan:\n- ran it\n");
  assert.equal(body, "## Summary\nWhy.\n\n## Test Plan:\n- ran it\n");
});

test("a Test plan heading inside a fenced code block still gets the stub", () => {
  const body = buildPrBodyFromCommit(
    "feat(cli): add thing\n\nExample body:\n\n```md\n## Test plan\n- x\n```\n",
  );
  assert.equal(body, "## Summary\nExample body:\n\n```md\n## Test plan\n- x\n```\n\n## Test plan\n- [ ] CI green\n");
});

test("a body without a Test plan heading still gets the stub", () => {
  const body = buildPrBodyFromCommit("feat(cli): add thing\n\nThe test plan is CI.\n");
  assert.equal(body, "## Summary\nThe test plan is CI.\n\n## Test plan\n- [ ] CI green\n");
});
