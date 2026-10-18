import assert from "node:assert/strict";
import { test } from "node:test";
import { stackWatchBackgroundCommand, stackWatchObligation } from "./stack-watch-obligation.js";

const stackId = "11111111-1111-4111-8111-111111111111";

test("stack watch background command carries the bounce cursor so a restart skips a handled bounce", () => {
  assert.equal(stackWatchBackgroundCommand(stackId), `mg stack watch ${stackId}`);
  assert.equal(stackWatchBackgroundCommand(stackId, { bounceId: null, afterFinishedAt: null }), `mg stack watch ${stackId}`);
  const cursor = { enrolledHeadSha: "a".repeat(40), bounceId: "bounce-1", afterFinishedAt: "2026-10-18T10:00:00.000Z" };
  const restart = `mg stack watch ${stackId} --bounce-id bounce-1 --after-finished-at 2026-10-18T10:00:00.000Z`;
  assert.equal(stackWatchBackgroundCommand(stackId, cursor), restart);
  const watch = stackWatchObligation({
    stackId, terminal: null, cursor, attention: { prNumber: 7, blocker: "Auto land off after merge_failed bounce" },
  });
  assert.equal(watch.next?.background, restart);
  assert.ok(watch.message.includes(`start \`${restart} --head <pushed-sha>\``));
  assert.ok(watch.message.includes(`If you handle it without a push (for example by turning Auto land back on), start \`${restart}\``));
});
