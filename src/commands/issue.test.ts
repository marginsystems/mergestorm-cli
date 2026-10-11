import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "../errors.js";
import { cmdIssue, parseIssueCreateArgs } from "./issue.js";

const CFG = { apiKey: "msk_live_test", apiBase: "https://api.example.test" };

async function capture(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test("parseIssueCreateArgs reads title, body, labels, repo and json", () => {
  assert.deepEqual(
    parseIssueCreateArgs(["--title", " Fix it ", "--body", "Details", "--label", "needs, design", "--label", "vortex", "--repo", "acme/widgets", "--json"]),
    { title: "Fix it", body: "Details", labels: ["needs, design", "vortex"], repo: { owner: "acme", repo: "widgets" }, json: true },
  );
  assert.deepEqual(parseIssueCreateArgs(["--title", "T", "--body-file", "body.md"], (path) => `from ${path}`), {
    title: "T",
    body: "from body.md",
    labels: [],
    json: false,
  });
});

test("parseIssueCreateArgs rejects a missing title, both body sources, a bad repo and unknown flags", () => {
  for (const args of [
    [],
    ["--title"],
    ["--title", "T", "--body", "a", "--body-file", "b"],
    ["--title", "T", "--repo", "widgets"],
    ["--title", "T", "--assignee", "me"],
  ]) {
    assert.throws(
      () => parseIssueCreateArgs(args, () => "x"),
      (err) => err instanceof CommandError && err.code === "usage" && /usage: mergestorm issue create/.test(err.message),
      args.join(" "),
    );
  }
});

test("issue create opens the issue on the origin repository through Mergestorm and prints the Fixes line", async () => {
  const sent: unknown[] = [];
  const lines = await capture(() =>
    cmdIssue(["create", "--title", "Fix it", "--body", "Details", "--label", "bug"], {
      loadConfig: async () => CFG,
      parseGithubOriginRepo: () => ({ owner: "acme", repo: "widgets" }),
      openStackIssue: async (input, cfg) => {
        sent.push({ cfg, input });
        return { number: 12, url: "https://github.com/acme/widgets/issues/12", created: true };
      },
    }),
  );
  assert.deepEqual(sent, [{ cfg: CFG, input: { owner: "acme", repo: "widgets", title: "Fix it", body: "Details", labels: ["bug"] } }]);
  assert.deepEqual(lines, [
    "Opened acme/widgets#12  https://github.com/acme/widgets/issues/12",
    "Put `Fixes #12` in the commit or pull request body.",
  ]);
});

test("issue create --json names the repository and whether the issue is new, and --repo wins over origin", async () => {
  const lines = await capture(() =>
    cmdIssue(["create", "--title", "Fix it", "--repo", "other/repo", "--json"], {
      loadConfig: async () => CFG,
      parseGithubOriginRepo: () => {
        throw new Error("origin must not be read when --repo is given");
      },
      openStackIssue: async () => ({ number: 12, url: "u", created: false }),
    }),
  );
  assert.deepEqual(JSON.parse(lines.join("\n")), { owner: "other", repo: "repo", number: 12, url: "u", created: false });
});

test("issue without a repository or with an unknown subcommand fails with a reason", async () => {
  await assert.rejects(
    () => cmdIssue(["create", "--title", "T"], { loadConfig: async () => CFG, parseGithubOriginRepo: () => null }),
    /Pass --repo <owner\/repo>/,
  );
  await assert.rejects(() => cmdIssue(["close", "12"]), /unknown issue subcommand: close/);
});
