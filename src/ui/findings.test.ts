import assert from "node:assert/strict";
import { test } from "node:test";
import { renderFindings } from "./findings.js";

test("renderFindings prints inline and camelCase offDiff", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    renderFindings({
      inline: [
        {
          path: "a.ts",
          line: 3,
          severity: "warning",
          title: "nits",
          body: "tighten this",
        },
      ],
      offDiff: [{ path: "b.ts", severity: "info", body: "docs" }],
    });
    assert.ok(lines.some((l) => l.includes("[warning] a.ts:3 — nits")));
    assert.ok(lines.some((l) => l.includes("tighten this")));
    assert.ok(lines.some((l) => l.includes("[info] off-diff b.ts")));
    assert.ok(lines.some((l) => l.includes("docs")));
    assert.equal(lines.some((l) => l.includes("No findings.")), false);
  } finally {
    console.log = original;
  }
});

test("renderFindings prefers off_diff over offDiff and honors emptyMessage", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    renderFindings(
      {
        off_diff: [{ path: "snake.ts", severity: "error", body: "from snake" }],
        offDiff: [{ path: "camel.ts", severity: "error", body: "from camel" }],
      },
      { emptyMessage: true },
    );
    assert.ok(lines.some((l) => l.includes("off-diff snake.ts")));
    assert.equal(lines.some((l) => l.includes("camel.ts")), false);

    lines.length = 0;
    renderFindings({}, { emptyMessage: true });
    assert.ok(lines.some((l) => l.includes("No findings.")));

    lines.length = 0;
    renderFindings({}, { emptyMessage: false });
    assert.equal(lines.length, 0);
  } finally {
    console.log = original;
  }
});

test("renderFindings(null | undefined) prints empty message", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    renderFindings(null, { emptyMessage: true });
    assert.ok(lines.some((l) => l.includes("No findings.")));

    lines.length = 0;
    renderFindings(undefined, { emptyMessage: true });
    assert.ok(lines.some((l) => l.includes("No findings.")));
  } finally {
    console.log = original;
  }
});
