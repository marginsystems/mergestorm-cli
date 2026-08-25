import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "../errors.js";
import type { StackMeta } from "../stack-meta.js";
import {
  assertMayParentOntoRegistered,
  cmdStackSubmit,
  findRegisteredParent,
  parseAdoptTarget,
  parseStackCreateArgs,
  parseStackResetArgs,
  parseStackSubmitArgs,
  requireStackId,
  type StackSubmitDeps,
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
    adoptStack: async (owner, repo, prNumber) => {
      adoptCalls += 1;
      adoptPrs.push(prNumber);
      const result = adoptStackOverride
        ? await adoptStackOverride(owner, repo, prNumber)
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
    adoptStackIds,
    get ensureParkCalls() {
      return ensureParkCalls;
    },
    pushCalls,
  };
}

test("parseStackCreateArgs parses name, onto, trunk, extend, json", () => {
  assert.deepEqual(parseStackCreateArgs(["feat/foo", "--onto", "main", "--json"]), {
    name: "feat/foo",
    onto: "main",
    trunk: undefined,
    extend: false,
    asJson: true,
  });
  assert.deepEqual(parseStackCreateArgs(["--onto=ms/a", "--trunk", "master", "--extend"]), {
    name: undefined,
    onto: "ms/a",
    trunk: "master",
    extend: true,
    asJson: false,
  });
});

test("parseStackCreateArgs rejects unknown flags", () => {
  assert.throws(() => parseStackCreateArgs(["--nope"]), CommandError);
});

test("parseStackSubmitArgs accepts --extend and --json", () => {
  assert.deepEqual(parseStackSubmitArgs(["--extend", "--json"]), {
    extend: true,
    asJson: true,
  });
  assert.deepEqual(parseStackSubmitArgs([]), { extend: false, asJson: false });
});

test("parseStackSubmitArgs rejects unknown flags", () => {
  assert.throws(() => parseStackSubmitArgs(["--force"]), /stack submit/);
});

const REGISTERED: StackDto[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    owner: "acme",
    repo: "widgets",
    trunkBranch: "mg-stack-1",
    landTarget: "main",
    autoPromoteWhenGreen: false,
    archivedAt: null,
    layers: [
      {
        branch: "fix/existing-tip",
        parentBranch: "mg-stack-1",
        prNumber: 99,
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
  await cmdStackSubmit(["--json"], h.deps);
  assert.deepEqual(h.pushCalls, ["feat/a", "feat/b", "feat/c"]);
  assert.deepEqual(h.createPrBases, ["main", "feat/a", "mg-park-1-g1"]);
  assert.equal(h.ensureParkCalls, 1);
  assert.equal(h.adoptCalls, 2);
  assert.equal(h.createPrCalls, 3);
  // First adopt registers PR1/PR2; the second adopts the park-based PR3 and
  // must land it in the same stack that owns PR1/PR2 — not an orphan stack.
  assert.deepEqual(h.adoptPrs, [41, 43]);
  assert.deepEqual(h.adoptStackIds, [STACK_A, STACK_A]);
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
