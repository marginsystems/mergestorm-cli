import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "../errors.js";
import type { StackMeta } from "../stack-meta.js";
import {
  assertMayParentOntoRegistered,
  buildStackListLines,
  cmdStackCreate,
  cmdStackSet,
  cmdStackSubmit,
  findRegisteredParent,
  openPolicyPatch,
  parseAdoptTarget,
  parseStackAdoptArgs,
  parseStackCreateArgs,
  parseStackResetArgs,
  parseStackSetArgs,
  parseStackSubmitArgs,
  requireStackId,
  stackPolicyLabels,
  stackSetSummary,
  type StackSubmitDeps,
  type StackCreateDeps,
} from "./stack.js";
import type { StackDto } from "../api.js";

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
  createPrBases: string[];
  adoptCalls: number;
  /** PR numbers passed to adoptStack, in call order. */
  adoptPrs: number[];
  adoptPolicies: Array<{ autoEnqueueWhenReady?: boolean } | undefined>;
  /** Stack ids returned by adoptStack, in call order. */
  adoptStackIds: string[];
  ensureParkCalls: number;
  pushCalls: string[];
};

function makeSubmitHarness(overrides: Partial<StackSubmitDeps> = {}): SubmitHarness {
  const saved: StackMeta[] = [];
  const pushCalls: string[] = [];
  const createPrBases: string[] = [];
  const adoptPrs: number[] = [];
  const adoptPolicies: Array<{ autoEnqueueWhenReady?: boolean } | undefined> = [];
  const adoptStackIds: string[] = [];
  let createPrCalls = 0;
  let adoptCalls = 0;
  let ensureParkCalls = 0;
  const {
    ensureUpperPark: ensureUpperParkOverride,
    createPr: createPrOverride,
    adoptStack: adoptStackOverride,
    ...rest
  } = overrides;
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
    fetchRemoteBranch: () => {},
    pushBranch: (branch) => {
      pushCalls.push(branch);
    },
    findOpenPrNumber: () => null,
    commitsAheadOf: () => 1,
    tipCommitSubject: () => "feat: layer one",
    tipCommitMessage: () => "feat: layer one\n\nBody.\n",
    buildPrBodyFromCommit: () => "## Summary\n- feat: layer one\n",
    createPr: (input) => {
      createPrCalls += 1;
      createPrBases.push(input.base);
      if (createPrOverride) return createPrOverride(input);
      return 40 + createPrCalls;
    },
    loadConfig: async () => ({ apiKey: "msk_live_test", apiBase: "https://api.example.test" }),
    listStacks: async () => [],
    adoptStack: async (owner, repo, prNumber, cfg, policy) => {
      adoptCalls += 1;
      adoptPrs.push(prNumber);
      adoptPolicies.push(policy);
      const result = adoptStackOverride
        ? await adoptStackOverride(owner, repo, prNumber, cfg, policy)
        : {
            stack: { id: "11111111-1111-4111-8111-111111111111", trunkBranch: "main" },
            chain: [],
          };
      const adoptData = result as { stack?: { id?: unknown } | null };
      adoptStackIds.push(
        adoptData && typeof adoptData.stack?.id === "string"
          ? adoptData.stack.id
          : "",
      );
      return result;
    },
    ensureUpperPark: async (stackId, cfg) => {
      ensureParkCalls += 1;
      if (ensureUpperParkOverride) return ensureUpperParkOverride(stackId, cfg);
      throw new Error("ensureUpperPark should not run");
    },
    ...rest,
  };
  return {
    deps,
    saved,
    get createPrCalls() {
      return createPrCalls;
    },
    createPrBases,
    get adoptCalls() {
      return adoptCalls;
    },
    adoptPrs,
    adoptPolicies,
    adoptStackIds,
    get ensureParkCalls() {
      return ensureParkCalls;
    },
    pushCalls,
  };
}

async function captureStackOutput(
  fn: () => Promise<void>,
): Promise<{ stdout: string[]; stderr: string[]; error: unknown }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  try {
    await fn();
    return { stdout, stderr, error: null };
  } catch (error) {
    return { stdout, stderr, error };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("parseStackCreateArgs parses name, onto, trunk, extend, json", () => {
  assert.deepEqual(parseStackCreateArgs(["feat/foo", "--onto", "main", "--json"]), {
    name: "feat/foo",
    onto: "main",
    trunk: undefined,
    extend: false,
    autoLand: undefined,
    autoReview: undefined,
    autoPatch: undefined,
    asJson: true,
  });
  assert.deepEqual(parseStackCreateArgs(["--onto=ms/a", "--trunk", "master", "--extend"]), {
    name: undefined,
    onto: "ms/a",
    trunk: "master",
    extend: true,
    autoLand: undefined,
    autoReview: undefined,
    autoPatch: undefined,
    asJson: false,
  });
  assert.equal(parseStackCreateArgs(["--auto-land", "on"]).autoLand, true);
  assert.equal(parseStackCreateArgs(["--auto-land=off"]).autoLand, false);
});

test("parseStackCreateArgs reads --auto-review / --auto-patch as on|off only", () => {
  const parsed = parseStackCreateArgs(["--auto-review", "off", "--auto-patch=on"]);
  assert.equal(parsed.autoReview, false);
  assert.equal(parsed.autoPatch, true);
  assert.equal(parsed.autoLand, undefined);
  // Absent means "follow the account flag"; there is no `default` at open.
  assert.equal(parseStackCreateArgs([]).autoReview, undefined);
  assert.throws(() => parseStackCreateArgs(["--auto-patch", "default"]), /--auto-patch on\|off/);
});

test("cmdStackCreate persists --auto-review / --auto-patch in the saved stack metadata", async () => {
  const saved: StackMeta[] = [];
  const deps: StackCreateDeps = {
    cwd: "/tmp/fake-repo",
    gitTopLevel: () => "/tmp/fake-repo",
    worktreeDirty: () => false,
    currentBranch: () => "main",
    branchExists: (branch) => branch === "main",
    defaultLayerBranchName: () => "feat/new",
    createBranchFromHead: () => {},
    deleteBranch: () => {},
    discoverTrunk: () => "main",
    loadStackMeta: async () => null,
    saveStackMeta: async (meta) => {
      saved.push(structuredClone(meta));
    },
    parseGithubOriginRepo: () => null,
  };

  await cmdStackCreate(["--auto-patch", "off", "--json"], deps);

  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.stacks[0]!.autoPatchOverride, false);
  assert.equal(saved[0]!.stacks[0]!.autoReviewOverride, undefined);
  assert.equal(saved[0]!.stacks[0]!.autoEnqueueWhenReady, undefined);
});

test("parseStackCreateArgs rejects unknown flags", () => {
  assert.throws(() => parseStackCreateArgs(["--nope"]), CommandError);
});

test("cmdStackCreate persists --auto-land in the saved stack metadata", async () => {
  const saved: StackMeta[] = [];
  const deps: StackCreateDeps = {
    cwd: "/tmp/fake-repo",
    gitTopLevel: () => "/tmp/fake-repo",
    worktreeDirty: () => false,
    currentBranch: () => "main",
    branchExists: (branch) => branch === "main",
    defaultLayerBranchName: () => "feat/new",
    createBranchFromHead: () => {},
    deleteBranch: () => {},
    discoverTrunk: () => "main",
    loadStackMeta: async () => null,
    saveStackMeta: async (meta) => {
      saved.push(structuredClone(meta));
    },
    parseGithubOriginRepo: () => null,
  };

  await cmdStackCreate(["--auto-land", "on", "--json"], deps);

  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.stacks[0]!.autoEnqueueWhenReady, true);
  assert.deepEqual(saved[0]!.stacks[0]!.layers, [
    { branch: "feat/new", parentBranch: "main" },
  ]);
});

test("parseStackSubmitArgs accepts --extend and --json", () => {
  assert.deepEqual(parseStackSubmitArgs(["--extend", "--json"]), {
    extend: true,
    autoLand: undefined,
    autoReview: undefined,
    autoPatch: undefined,
    asJson: true,
  });
  assert.deepEqual(parseStackSubmitArgs([]), {
    extend: false,
    autoLand: undefined,
    autoReview: undefined,
    autoPatch: undefined,
    asJson: false,
  });
  assert.equal(parseStackSubmitArgs(["--auto-land", "on"]).autoLand, true);
  assert.equal(parseStackSubmitArgs(["--auto-land=off"]).autoLand, false);
  assert.equal(parseStackSubmitArgs(["--auto-review", "on"]).autoReview, true);
  assert.equal(parseStackSubmitArgs(["--auto-patch=off"]).autoPatch, false);
  assert.throws(() => parseStackSubmitArgs(["--auto-review", "default"]), /--auto-review on\|off/);
});

test("parseStackSubmitArgs rejects unknown flags", () => {
  assert.throws(() => parseStackSubmitArgs(["--force"]), /stack submit/);
});

test("parseStackSetArgs requires a stack id and at least one policy flag", () => {
  const stackId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(parseStackSetArgs([stackId, "--auto-land", "on", "--json"]), {
    stackId,
    autoLand: true,
    asJson: true,
  });
  assert.equal(
    parseStackSetArgs(["--auto-land=off", stackId]).autoLand,
    false,
  );
  assert.throws(() => parseStackSetArgs([stackId]), /stack set/);
});

test("parseStackSetArgs reads tri-state overrides where default writes null", () => {
  const stackId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(
    parseStackSetArgs([stackId, "--auto-review", "off", "--auto-patch=default"]),
    { stackId, autoReview: false, autoPatch: null, asJson: false },
  );
  assert.deepEqual(parseStackSetArgs([stackId, "--auto-patch", "on"]), {
    stackId,
    autoPatch: true,
    asJson: false,
  });
  // Auto land stays boolean-only: no `default` on the account-seeded flag.
  assert.throws(() => parseStackSetArgs([stackId, "--auto-land", "default"]), /on\|off/);
  assert.throws(() => parseStackSetArgs([stackId, "--auto-review", "maybe"]), /on\|off\|default/);
});

test("cmdStackSet writes Auto land and prints the API JSON response", async () => {
  const stackId = "11111111-1111-4111-8111-111111111111";
  let call: { stackId: string; policy: unknown } | undefined;
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
  try {
    await cmdStackSet([stackId, "--auto-land", "on", "--json"], {
      loadConfig: async () => ({
        apiKey: "msk_live_test",
        apiBase: "https://api.example.test",
      }),
      setStackPolicy: async (seenId, policy) => {
        call = { stackId: seenId, policy };
        return { autoEnqueueWhenReady: policy.autoEnqueueWhenReady };
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(call, { stackId, policy: { autoEnqueueWhenReady: true } });
  assert.deepEqual(JSON.parse(output.join("\n")), {
    autoEnqueueWhenReady: true,
  });
});

test("cmdStackSet sends only the override keys given, with default as null", async () => {
  const stackId = "11111111-1111-4111-8111-111111111111";
  let call: { stackId: string; policy: unknown } | undefined;
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
  try {
    await cmdStackSet([stackId, "--auto-patch", "off", "--auto-review", "default", "--json"], {
      loadConfig: async () => ({
        apiKey: "msk_live_test",
        apiBase: "https://api.example.test",
      }),
      setStackPolicy: async (seenId, policy) => {
        call = { stackId: seenId, policy };
        return { autoReviewOverride: null, autoPatchOverride: false };
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(call, {
    stackId,
    policy: { autoReviewOverride: null, autoPatchOverride: false },
  });
  assert.deepEqual(JSON.parse(output.join("\n")), {
    autoReviewOverride: null,
    autoPatchOverride: false,
  });
});

test("stackSetSummary names each flag written", () => {
  assert.deepEqual(
    stackSetSummary({
      stackId: "x",
      autoLand: true,
      autoReview: null,
      autoPatch: false,
      asJson: false,
    }),
    ["Auto land on", "Auto-review default (account setting)", "Auto-patch off"],
  );
});

test("stackPolicyLabels prints only pinned overrides next to Auto land", () => {
  assert.deepEqual(stackPolicyLabels({ autoEnqueueWhenReady: false }), []);
  assert.deepEqual(
    stackPolicyLabels({
      autoEnqueueWhenReady: true,
      autoReviewOverride: false,
      autoPatchOverride: null,
    }),
    ["auto-land on", "auto-review off"],
  );
  assert.deepEqual(
    stackPolicyLabels({ autoPatchOverride: true }),
    ["auto-patch on"],
  );
});

const REGISTERED: StackDto[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    owner: "acme",
    repo: "widgets",
    trunkBranch: "mg-stack-1",
    landTarget: "main",
    archivedAt: null,
    layers: [
      {
        branch: "fix/existing-tip",
        parentBranch: "mg-stack-1",
        prNumber: 99,
        openedAt: null,
        mergedAt: null,
        closedAt: null,
        additions: null,
        deletions: null,
        openAdditions: null,
        openDeletions: null,
        position: 1,
        state: "clean",
        title: "existing",
        htmlUrl: null,
        ciStatus: "unknown",
        reviewStatus: "none",
        checks: null,
        vortexStatus: null,
        cycloneStatus: null,
        tempestStatus: null,
        conflictDetail: null,
        lastRestackedSha: null,
        mergeable: null,
        mergeableState: null,
      },
    ],
  },
];

test("findRegisteredParent matches a registered layer branch", () => {
  const hit = findRegisteredParent(REGISTERED, "fix/existing-tip");
  assert.ok(hit);
  assert.equal(hit!.stackId, REGISTERED[0]!.id);
  assert.equal(hit!.prNumber, 99);
  assert.equal(findRegisteredParent(REGISTERED, "main"), null);
});

test("findRegisteredParent scopes the match to the given owner/repo", () => {
  assert.ok(findRegisteredParent(REGISTERED, "fix/existing-tip", "acme", "widgets"));
  assert.equal(
    findRegisteredParent(REGISTERED, "fix/existing-tip", "other", "repo"),
    null,
  );
});

test("assertMayParentOntoRegistered refuses without --extend", () => {
  assert.throws(
    () => assertMayParentOntoRegistered("fix/existing-tip", REGISTERED, false, "create"),
    /--extend/,
  );
});

test("assertMayParentOntoRegistered allows with --extend", () => {
  const hit = assertMayParentOntoRegistered(
    "fix/existing-tip",
    REGISTERED,
    true,
    "submit",
  );
  assert.ok(hit);
  assert.equal(hit!.prNumber, 99);
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

test("parseStackAdoptArgs parses Auto land without consuming the target", () => {
  assert.deepEqual(
    parseStackAdoptArgs(["acme/widgets#12", "--auto-land", "on", "--json"]),
    {
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
      autoLand: true,
      autoReview: undefined,
      autoPatch: undefined,
      asJson: true,
    },
  );
  assert.equal(
    parseStackAdoptArgs(["--auto-land=off", "acme/widgets", "12"]).autoLand,
    false,
  );
  assert.throws(
    () => parseStackAdoptArgs(["acme/widgets#12", "--auto-land", "default"]),
    /on\|off/,
  );
  assert.deepEqual(
    parseStackAdoptArgs(["acme/widgets#12", "--auto-review=off", "--auto-patch", "on"]),
    {
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
      autoLand: undefined,
      autoReview: false,
      autoPatch: true,
      asJson: false,
    },
  );
  assert.throws(
    () => parseStackAdoptArgs(["acme/widgets#12", "--auto-patch", "default"]),
    /--auto-patch on\|off/,
  );
});

test("openPolicyPatch maps on|off flags to the wire policy and drops absent keys", () => {
  assert.equal(openPolicyPatch({}), undefined);
  assert.deepEqual(openPolicyPatch({ autoLand: true }), { autoEnqueueWhenReady: true });
  assert.deepEqual(
    openPolicyPatch({ autoReview: false, autoPatch: true }),
    { autoReviewOverride: false, autoPatchOverride: true },
  );
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
  assert.deepEqual(h.adoptPolicies, [undefined]);
  assert.equal(h.saved.length, 1);
  // Active stack cleared — no layers left to submit.
  assert.equal(h.saved[0]!.stacks[0]!.layers.length, 0);
});

test("cmdStackSubmit carries create-time Auto land metadata into a new stack", async () => {
  const meta: StackMeta = {
    ...structuredClone(SAMPLE_META),
    stacks: [
      {
        ...structuredClone(SAMPLE_META.stacks[0]!),
        autoEnqueueWhenReady: true,
      },
    ],
  };
  const h = makeSubmitHarness({
    loadStackMeta: async () => structuredClone(meta),
  });
  await cmdStackSubmit([], h.deps);
  assert.deepEqual(h.adoptPolicies, [{ autoEnqueueWhenReady: true }]);
});

test("cmdStackSubmit explicit Auto land flag beats metadata", async () => {
  const meta: StackMeta = {
    ...structuredClone(SAMPLE_META),
    stacks: [
      {
        ...structuredClone(SAMPLE_META.stacks[0]!),
        autoEnqueueWhenReady: true,
      },
    ],
  };
  const h = makeSubmitHarness({
    loadStackMeta: async () => structuredClone(meta),
  });
  await cmdStackSubmit(["--auto-land", "off"], h.deps);
  assert.deepEqual(h.adoptPolicies, [{ autoEnqueueWhenReady: false }]);
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

test("cmdStackSubmit refuses parenting onto a registered tip without --extend", async () => {
  const meta: StackMeta = {
    version: 2,
    trunk: "main",
    stacks: [
      {
        layers: [
          {
            branch: "feat/extra",
            parentBranch: "fix/existing-tip",
          },
        ],
      },
    ],
    active: 0,
  };
  const h = makeSubmitHarness({
    loadStackMeta: async () => structuredClone(meta),
    listStacks: async () => structuredClone(REGISTERED),
  });
  await assert.rejects(() => cmdStackSubmit([], h.deps), /--extend/);
  assert.equal(h.createPrCalls, 0);
  assert.equal(h.adoptCalls, 0);
});

test("cmdStackSubmit refuses a registered tip masquerading as meta.trunk", async () => {
  const meta: StackMeta = {
    version: 2,
    trunk: "fix/existing-tip",
    stacks: [
      {
        layers: [
          {
            branch: "feat/extra",
            parentBranch: "fix/existing-tip",
          },
        ],
      },
    ],
    active: 0,
  };
  const h = makeSubmitHarness({
    loadStackMeta: async () => structuredClone(meta),
    listStacks: async () => structuredClone(REGISTERED),
  });
  await assert.rejects(() => cmdStackSubmit([], h.deps), /--extend/);
  assert.equal(h.createPrCalls, 0);
  assert.equal(h.adoptCalls, 0);
});

test("cmdStackSubmit allows registered tip parent with --extend", async () => {
  const meta: StackMeta = {
    version: 2,
    trunk: "main",
    stacks: [
      {
        autoEnqueueWhenReady: true,
        layers: [
          {
            branch: "feat/extra",
            parentBranch: "fix/existing-tip",
          },
        ],
      },
    ],
    active: 0,
  };
  const h = makeSubmitHarness({
    loadStackMeta: async () => structuredClone(meta),
    listStacks: async () => structuredClone(REGISTERED),
  });
  await cmdStackSubmit(["--extend"], h.deps);
  assert.equal(h.createPrCalls, 1);
  assert.equal(h.adoptCalls, 1);
  assert.deepEqual(h.adoptPolicies, [undefined]);
});

test("cmdStackSubmit refuses a mid-stack layer that parents onto a registered tip", async () => {
  const meta: StackMeta = {
    version: 2,
    trunk: "main",
    stacks: [
      {
        layers: [
          { branch: "feat/a", parentBranch: "main" },
          { branch: "feat/b", parentBranch: "fix/existing-tip" },
        ],
      },
    ],
    active: 0,
  };
  const h = makeSubmitHarness({
    loadStackMeta: async () => structuredClone(meta),
    listStacks: async () => structuredClone(REGISTERED),
  });
  await assert.rejects(() => cmdStackSubmit([], h.deps), /--extend/);
  assert.equal(h.createPrCalls, 0);
  assert.equal(h.adoptCalls, 0);
});

test("cmdStackSubmit fails closed when registered stacks cannot be listed", async () => {
  const meta: StackMeta = {
    version: 2,
    trunk: "main",
    stacks: [
      {
        layers: [{ branch: "feat/extra", parentBranch: "feat/base" }],
      },
    ],
    active: 0,
  };
  const h = makeSubmitHarness({
    loadStackMeta: async () => structuredClone(meta),
    listStacks: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(() => cmdStackSubmit([], h.deps), /registered stacks/);
  assert.equal(h.createPrCalls, 0);
  assert.equal(h.adoptCalls, 0);
});

function extraLayer(
  branch: string,
  parentBranch: string | null,
  position: number,
): StackDto["layers"][number] {
  return {
    ...REGISTERED[0]!.layers[0]!,
    branch,
    parentBranch,
    position,
    prNumber: 90 + position,
    title: branch,
  };
}

test("cmdStackSubmit opens a 3-layer stack onto the park freeze for PR3", async () => {
  const meta: StackMeta = {
    version: 2,
    trunk: "main",
    stacks: [
      {
        layers: [
          { branch: "feat/a", parentBranch: "main" },
          { branch: "feat/b", parentBranch: "feat/a" },
          { branch: "feat/c", parentBranch: "feat/b" },
        ],
      },
    ],
    active: 0,
  };
  const STACK_A = "11111111-1111-4111-8111-111111111111";
  const h = makeSubmitHarness({
    loadStackMeta: async () => structuredClone(meta),
    ensureUpperPark: async () => ({ freezeBranch: "mg-park-1-g1", created: true }),
    adoptStack: async (owner, repo, prNumber) => ({
      // Simulate the fixed server: the re-adopt of the freeze-based PR rejoins
      // the same stack instead of insertStack-ing a separate unit-less stack.
      stack: { id: STACK_A, trunkBranch: "main" },
      chain: prNumber === 43 ? [{ branch: "feat/c", parentBranch: "mg-park-1-g1", prNumber: 43, position: 3 }] : [],
    }),
  });
  await cmdStackSubmit(["--json", "--auto-land", "on"], h.deps);
  assert.deepEqual(h.pushCalls, ["feat/a", "feat/b", "feat/c"]);
  assert.deepEqual(h.createPrBases, ["main", "feat/a", "mg-park-1-g1"]);
  assert.equal(h.ensureParkCalls, 1);
  assert.equal(h.adoptCalls, 2);
  assert.equal(h.createPrCalls, 3);
  // First adopt registers PR1/PR2; the second adopts the park-based PR3 and
  // must land it in the same stack that owns PR1/PR2 — not an orphan stack.
  assert.deepEqual(h.adoptPrs, [41, 43]);
  assert.deepEqual(h.adoptPolicies, [
    { autoEnqueueWhenReady: true },
    { autoEnqueueWhenReady: true },
  ]);
  assert.deepEqual(h.adoptStackIds, [STACK_A, STACK_A]);
});

test("cmdStackSubmit --json stdout is one JSON value without park/push progress (#2036)", async () => {
  const meta: StackMeta = {
    version: 2,
    trunk: "main",
    stacks: [
      {
        layers: [
          { branch: "feat/a", parentBranch: "main" },
          { branch: "feat/b", parentBranch: "feat/a" },
          { branch: "feat/c", parentBranch: "feat/b" },
        ],
      },
    ],
    active: 0,
  };
  const STACK_A = "11111111-1111-4111-8111-111111111111";
  const h = makeSubmitHarness({
    loadStackMeta: async () => structuredClone(meta),
    ensureUpperPark: async () => ({ freezeBranch: "mg-park-1-g1", created: true }),
    adoptStack: async (_owner, _repo, prNumber) => ({
      stack: { id: STACK_A, trunkBranch: "main" },
      chain: prNumber === 43
        ? [{ branch: "feat/c", parentBranch: "mg-park-1-g1", prNumber: 43, position: 3 }]
        : [],
    }),
  });
  const captured = await captureStackOutput(() => cmdStackSubmit(["--json"], h.deps));
  assert.equal(captured.error, null);
  const stdout = captured.stdout.join("\n");
  assert.doesNotMatch(stdout, /Pushing /);
  assert.doesNotMatch(stdout, /Ensuring upper-park/);
  assert.doesNotMatch(stdout, /Opening PR /);
  assert.doesNotMatch(stdout, /Registering stack/);
  const body = JSON.parse(stdout);
  assert.equal(body.owner, "acme");
  assert.equal(body.repo, "widgets");
  assert.equal(body.stackId, STACK_A);
  assert.equal(body.trunk, "main");
  assert.match(captured.stderr.join("\n"), /Pushing /);
  assert.match(captured.stderr.join("\n"), /Ensuring upper-park/);
});

test("cmdStackSubmit --extend onto a 2-layer tip mints park then opens onto it", async () => {
  const registered: StackDto[] = [
    {
      ...REGISTERED[0]!,
      layers: [
        extraLayer("feat/a", "mg-stack-1", 1),
        extraLayer("feat/b", "feat/a", 2),
      ],
    },
  ];
  const meta: StackMeta = {
    version: 2,
    trunk: "main",
    stacks: [{ layers: [{ branch: "feat/c", parentBranch: "feat/b" }] }],
    active: 0,
  };
  const h = makeSubmitHarness({
    loadStackMeta: async () => structuredClone(meta),
    listStacks: async () => structuredClone(registered),
    ensureUpperPark: async () => ({ freezeBranch: "mg-park-1-g1", created: true }),
  });
  await cmdStackSubmit(["--extend"], h.deps);
  assert.deepEqual(h.createPrBases, ["mg-park-1-g1"]);
  assert.equal(h.ensureParkCalls, 1);
  assert.equal(h.adoptCalls, 1);
});

test("cmdStackSubmit --extend onto a parked tip reuses the freeze without minting", async () => {
  const registered: StackDto[] = [
    {
      ...REGISTERED[0]!,
      layers: [
        extraLayer("feat/a", "mg-stack-1", 1),
        extraLayer("feat/b", "feat/a", 2),
        extraLayer("feat/c", "mg-park-1-g1", 3),
      ],
    },
  ];
  const meta: StackMeta = {
    version: 2,
    trunk: "main",
    stacks: [{ layers: [{ branch: "feat/d", parentBranch: "feat/c" }] }],
    active: 0,
  };
  const h = makeSubmitHarness({
    loadStackMeta: async () => structuredClone(meta),
    listStacks: async () => structuredClone(registered),
  });
  await cmdStackSubmit(["--extend"], h.deps);
  assert.deepEqual(h.createPrBases, ["mg-park-1-g1"]);
  assert.equal(h.ensureParkCalls, 0);
  assert.equal(h.adoptCalls, 1);
});

const STRIP = /\u001b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(STRIP, "");

test("buildStackListLines empty state tells you how to start", () => {
  const text = strip(buildStackListLines([]).join("\n"));
  assert.match(text, /None yet/);
  assert.match(text, /stack create/);
  assert.match(text, /stack adopt/);
});

test("buildStackListLines lists a registered stack", () => {
  const text = strip(
    buildStackListLines([
      { ...REGISTERED[0]!, autoEnqueueWhenReady: true },
    ]).join("\n"),
  );
  assert.match(text, /acme\/widgets/);
  assert.match(text, /#99/);
  assert.match(text, /auto-land on/);
  assert.doesNotMatch(text, /None yet/);
});
