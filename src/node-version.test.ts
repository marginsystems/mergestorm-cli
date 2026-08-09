import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSupportedNode,
  nodeMajor,
  unsupportedNodeMessage,
} from "./node-version.js";

describe("node-version", () => {
  it("parses major from semver-ish strings", () => {
    assert.equal(nodeMajor("22.22.3"), 22);
    assert.equal(nodeMajor("20.18.0"), 20);
    assert.equal(nodeMajor("18.20.4"), 18);
  });

  it("accepts Node 22+", () => {
    assert.equal(isSupportedNode("22.0.0"), true);
    assert.equal(isSupportedNode("23.1.0"), true);
    assert.equal(isSupportedNode("20.18.0"), false);
  });

  it("builds a clear unsupported message", () => {
    const msg = unsupportedNodeMessage("20.18.0");
    assert.match(msg, /requires Node\.js 22\+/);
    assert.match(msg, /found v20\.18\.0/);
  });
});
