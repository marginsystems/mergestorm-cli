import assert from "node:assert/strict";
import { test } from "node:test";
import type { StackDto, StackLayerDto } from "./api.js";
import {
  isMgParkBranch,
  parkFreezeBranchFromStack,
  planSubmitLayerBases,
} from "./submit-pr-base.js";

function layer(partial: Partial<StackLayerDto> & Pick<StackLayerDto, "branch" | "position">): StackLayerDto {
  return {
    parentBranch: null,
    prNumber: partial.position,
    openedAt: null,
    mergedAt: null,
    closedAt: null,
    additions: null,
    deletions: null,
    openAdditions: null,
    openDeletions: null,
    state: "clean",
    title: partial.branch,
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
    ...partial,
  };
}

function stack(layers: StackLayerDto[]): StackDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    owner: "acme",
    repo: "widgets",
    trunkBranch: "mg-stack-1",
    landTarget: "main",
    archivedAt: null,
    layers,
  };
}

test("isMgParkBranch matches the freeze prefix", () => {
  assert.equal(isMgParkBranch("mg-park-18-g1"), true);
  assert.equal(isMgParkBranch("ms/suggest-close"), false);
});

test("planSubmitLayerBases keeps 1–2 layer stacks on the git parent", () => {
  const plans = planSubmitLayerBases({
    layers: [
      { branch: "feat/a", parentBranch: "main" },
      { branch: "feat/b", parentBranch: "feat/a" },
    ],
    trunk: "main",
    registered: [],
    owner: "acme",
    repo: "widgets",
  });
  assert.deepEqual(
    plans.map((p) => ({ pos: p.position, base: p.githubBase, park: p.needsPark })),
    [
      { pos: 1, base: "main", park: false },
      { pos: 2, base: "feat/a", park: false },
    ],
  );
});

test("planSubmitLayerBases defers PR3+ until a park freeze exists", () => {
  const plans = planSubmitLayerBases({
    layers: [
      { branch: "feat/a", parentBranch: "main" },
      { branch: "feat/b", parentBranch: "feat/a" },
      { branch: "feat/c", parentBranch: "feat/b" },
    ],
    trunk: "main",
    registered: [],
    owner: "acme",
    repo: "widgets",
  });
  assert.equal(plans[2]!.position, 3);
  assert.equal(plans[2]!.needsPark, true);
  assert.equal(plans[2]!.githubBase, null);
});

test("planSubmitLayerBases reuses an existing park when extending a parked stack", () => {
  const registered = [
    stack([
      layer({ branch: "feat/a", position: 1, parentBranch: "mg-stack-1" }),
      layer({ branch: "feat/b", position: 2, parentBranch: "feat/a" }),
      layer({ branch: "feat/c", position: 3, parentBranch: "mg-park-1-g1" }),
    ]),
  ];
  assert.equal(parkFreezeBranchFromStack(registered[0]!), "mg-park-1-g1");
  const plans = planSubmitLayerBases({
    layers: [{ branch: "feat/d", parentBranch: "feat/c" }],
    trunk: "main",
    registered,
    owner: "acme",
    repo: "widgets",
  });
  assert.equal(plans[0]!.position, 4);
  assert.equal(plans[0]!.githubBase, "mg-park-1-g1");
  assert.equal(plans[0]!.stackId, registered[0]!.id);
  assert.equal(plans[0]!.needsPark, true);
});

test("planSubmitLayerBases marks first PR3 on a 2-layer stack as needing a mint", () => {
  const registered = [
    stack([
      layer({ branch: "feat/a", position: 1, parentBranch: "mg-stack-1" }),
      layer({ branch: "feat/b", position: 2, parentBranch: "feat/a" }),
    ]),
  ];
  const plans = planSubmitLayerBases({
    layers: [{ branch: "feat/c", parentBranch: "feat/b" }],
    trunk: "main",
    registered,
    owner: "acme",
    repo: "widgets",
  });
  assert.equal(plans[0]!.position, 3);
  assert.equal(plans[0]!.githubBase, null);
  assert.equal(plans[0]!.stackId, registered[0]!.id);
});
