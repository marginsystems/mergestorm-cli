/**
 * GitHub PR base for `stack submit` (#1104).
 *
 * Git parent stays the previous layer (local rebase / `--onto`). Position 3+
 * must open onto the review-unit park freeze so adopt does not retarget after
 * `opened` and double-wake Vortex.
 */
import type { StackDto } from "./api.js";

function registeredParentHit(
  stacks: readonly StackDto[],
  parentBranch: string,
  owner: string,
  repo: string,
): { stackId: string; position: number } | null {
  const want = parentBranch.trim();
  if (!want) return null;
  for (const stack of stacks) {
    if (stack.owner !== owner || stack.repo !== repo) continue;
    for (const layer of stack.layers) {
      if (layer.branch === want) {
        return { stackId: stack.id, position: layer.position };
      }
    }
  }
  return null;
}

export const MG_PARK_PREFIX = "mg-park-";

export function isMgParkBranch(branch: string): boolean {
  return branch.trim().toLowerCase().startsWith(MG_PARK_PREFIX);
}

/** Live freeze already used as a GitHub base on this stack, if any. */
export function parkFreezeBranchFromStack(stack: StackDto): string | null {
  for (const layer of stack.layers) {
    const parent = layer.parentBranch?.trim() ?? "";
    if (isMgParkBranch(parent)) return parent;
  }
  return null;
}

export type SubmitLayerPlan = {
  branch: string;
  gitParent: string;
  position: number;
  /** GitHub `--base` when known. `null` means mint the freeze first. */
  githubBase: string | null;
  needsPark: boolean;
  stackId: string | null;
};

export function planSubmitLayerBases(input: {
  layers: readonly { branch: string; parentBranch: string }[];
  trunk: string;
  registered: readonly StackDto[];
  owner: string;
  repo: string;
}): SubmitLayerPlan[] {
  const { layers, trunk, registered, owner, repo } = input;
  const localIndex = new Map(layers.map((layer, i) => [layer.branch, i]));
  const plans: SubmitLayerPlan[] = [];

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const gitParent = layer.parentBranch.trim() || trunk;
    const priorLocal = localIndex.get(gitParent);
    let position: number;
    let stackId: string | null = null;
    if (priorLocal !== undefined && plans[priorLocal]) {
      position = plans[priorLocal]!.position + 1;
      stackId = plans[priorLocal]!.stackId;
    } else {
      const hit = registeredParentHit(registered, gitParent, owner, repo);
      if (hit) {
        position = hit.position + 1;
        stackId = hit.stackId;
      } else {
        position = 1;
      }
    }

    const stack = stackId
      ? registered.find((row) => row.id === stackId) ?? null
      : null;
    const existingPark = stack ? parkFreezeBranchFromStack(stack) : null;
    const needsPark = position >= 3;
    const githubBase = needsPark ? existingPark : gitParent;

    plans.push({
      branch: layer.branch,
      gitParent,
      position,
      githubBase,
      needsPark,
      stackId,
    });
  }

  return plans;
}
