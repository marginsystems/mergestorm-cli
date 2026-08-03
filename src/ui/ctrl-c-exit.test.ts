import assert from "node:assert/strict";
import { test } from "node:test";
import { CTRL_C_CONFIRM_MS, CtrlCExitGate } from "./ctrl-c-exit.js";

test("CtrlCExitGate: first press arms, second within window exits", () => {
  const gate = new CtrlCExitGate();
  assert.equal(gate.press(1000), false);
  assert.equal(gate.press(1000 + CTRL_C_CONFIRM_MS), true);
});

test("CtrlCExitGate: second press after window expires re-arms", () => {
  const gate = new CtrlCExitGate();
  assert.equal(gate.press(1000), false);
  assert.equal(gate.press(1000 + CTRL_C_CONFIRM_MS + 1), false);
  assert.equal(gate.press(1000 + CTRL_C_CONFIRM_MS + 1 + 100), true);
});

test("CtrlCExitGate: reset clears the confirm window", () => {
  const gate = new CtrlCExitGate();
  assert.equal(gate.press(1000), false);
  gate.reset();
  assert.equal(gate.press(1100), false);
  assert.equal(gate.press(1200), true);
});
