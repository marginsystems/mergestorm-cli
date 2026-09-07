import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "../errors.js";
import { cmdWhoami } from "./whoami.js";

test("machine whoami requires live account details", async (t) => {
  const me = {
    key: { prefix: "msk_live_verified", name: "test" },
    plan_key: "starter",
    plan_label_key: "Starter",
    usage: { standard: { used: 1, limit: 10, remaining: 9 } },
  };
  const originalKey = process.env.MERGESTORM_API_KEY;
  const originalUrl = process.env.MERGESTORM_API_URL;
  process.env.MERGESTORM_API_KEY = "msk_live_cached_test";
  process.env.MERGESTORM_API_URL = "https://api.example.test";
  t.after(() => {
    if (originalKey === undefined) delete process.env.MERGESTORM_API_KEY;
    else process.env.MERGESTORM_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.MERGESTORM_API_URL;
    else process.env.MERGESTORM_API_URL = originalUrl;
  });
  for (const mode of ["live", "404", "network", "timeout", "401"] as const) {
    await t.test(mode, async (t) => {
      t.mock.method(globalThis, "fetch", async () => {
        if (mode === "network") throw new TypeError("fetch failed");
        if (mode === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
        return new Response(JSON.stringify(me), { status: mode === "live" ? 200 : Number(mode) });
      });
      const output: string[] = [];
      t.mock.method(console, "log", (text: string) => output.push(text));
      if (mode === "live") {
        await cmdWhoami(["--json"]);
        assert.equal(output.length, 1);
        const payload = JSON.parse(output[0]!);
        assert.equal(payload.key_prefix, me.key.prefix);
        assert.deepEqual(payload.usage, me.usage);
      } else {
        for (const args of [["--json"], []]) {
          await assert.rejects(() => cmdWhoami(args), (err: unknown) => {
            assert.ok(err instanceof CommandError);
            assert.notEqual(err.exitCode, 0);
            if (mode === "401") assert.equal(err.code, "auth_invalid");
            else assert.match(err.message, /Live account details unavailable/);
            return true;
          });
        }
        assert.deepEqual(output, []);
      }
    });
  }
});
