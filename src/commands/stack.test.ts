import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "../errors.js";
import type { StackMeta } from "../stack-meta.js";
import {
  cmdStackSubmit,
  parseAdoptTarget,
  parseStackCreateArgs,
  parseStackResetArgs,
  requireStackId,
  type StackSubmitDeps,
} from "./stack.js";

const SAMPLE_META: StackMeta = {
  version: 2,
  trunk: "main",
  stacks: [
    {
      layers: [
        {
          branch: "feat/layer-1",
          parentBranch: "main",
        },
      ],
    },
  ],
  active: 0,
};

type SubmitHarness = {
  deps: StackSubmitDeps;
  saved: StackMeta[];
  createPrCalls: number;
  adoptCalls: number;
  pushCalls: string[];
};

function makeSubmitHarness(overrides: Partial<StackSubmitDeps> = {}): SubmitHarness {
  const saved: StackMeta[] = [];
  const pushCalls: string[] = [];
  let createPrCalls = 0;
  let adoptCalls = 0;
  const deps: StackSubmitDeps = {
    cwd: "/tmp/fake-repo",
    gitTopLevel: () => "/tmp/fake-repo",
    loadStackMeta: async (cwd?: string, stacksRoot?: string) =>
      structuredClone(SAMPLE_META),
    saveStackMeta: async (meta, cwd?: string, stacksRoot?: string) => {
      saved.push(structuredClone(meta));
    },
    parseGithubOriginRepo: () => ({ owner: "acme", repo: "widgets" }),
    requireGh: () => {},
    branchExists: () => true,
    pushBranch: (branch) => {
      pushCalls.push(branch);
    },
    findOpenPrNumber: () => null,
    commitsAheadOf: () => 1,
    tipCommitSubject: () => "feat: layer one",
    tipCommitMessage: () => "feat: layer one\n\nBody.\n",
    buildPrBodyFromCommit: () => "## Summary\n- feat: layer one\n",
    createPr: () => {
      createPrCalls += 1;
      return 42;
    },
    loadConfig: async () => ({ apiKey: "msk_live_test", apiBase: "https://api.example.test" }),
    adoptStack: async () => {
      adoptCalls += 1;
      return {
        stack: { id: "11111111-1111-4111-8111-111111111111", trunkBranch: "main" },
        chain: [],
      };
    },
    ...overrides,
  };
  return {
    deps,
    saved,
    get createPrCalls() {
      return createPrCalls;
    },
    get adoptCalls() {
      return adoptCalls;
    },
    pushCalls,
  };
}

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

test("cmdStackSubmit happy path pushes, creates PR, adopts, clears local state", async () => {
  const h = makeSubmitHarness();
  await cmdStackSubmit(["--json"], h.deps);
  assert.deepEqual(h.pushCalls, ["feat/layer-1"]);
  assert.equal(h.createPrCalls, 1);
  assert.equal(h.adoptCalls, 1);
  assert.equal(h.saved.length, 1);
  // Active stack cleared — no layers left to submit.
  assert.equal(h.saved[0]!.stacks[0]!.layers.length, 0);
});

test("cmdStackSubmit keeps local state when adopt fails", async () => {
  const h = makeSubmitHarness({
    adoptStack: async () => {
      throw new CommandError("Failed to import stack (HTTP 500): {\"error\":\"boom\"}");
    },
  });
  await assert.rejects(() => cmdStackSubmit([], h.deps), CommandError);
  assert.equal(h.createPrCalls, 1);
  assert.equal(h.saved.length, 0);
});

test("cmdStackSubmit skips createPr when an open PR already exists", async () => {
  const h = makeSubmitHarness({
    findOpenPrNumber: () => 99,
  });
  await cmdStackSubmit([], h.deps);
  assert.equal(h.createPrCalls, 0);
  assert.equal(h.adoptCalls, 1);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0]!.stacks[0]!.layers.length, 0);
});
