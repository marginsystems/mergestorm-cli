/** Mergestorm CLI requires Node 22+ (matches package.json engines). */
export const MIN_NODE_MAJOR = 22;

/** Parse major version from a Node version string (e.g. "22.22.3" → 22). */
export function nodeMajor(version = process.versions.node): number {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}

/**
 * Fatal message when the runtime is too old. Kept pure for unit tests —
 * callers print + exit.
 */
export function unsupportedNodeMessage(
  version = process.versions.node,
  minMajor = MIN_NODE_MAJOR,
): string {
  return (
    `mergestorm requires Node.js ${minMajor}+ (found v${version}). ` +
    `Upgrade Node, then re-run: https://nodejs.org/`
  );
}

/** True when this process may run the CLI. */
export function isSupportedNode(
  version = process.versions.node,
  minMajor = MIN_NODE_MAJOR,
): boolean {
  return nodeMajor(version) >= minMajor;
}
