import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor, type HiveEvent } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const runner: Actor = { name: "runner.duy-mbp@duy", role: "agent" };
const pm: Actor = { name: "pm", role: "viewer" };
const base = { project: "app", taskId: "T-1", taskTitle: "Login page", runId: "R-1fa9e2", profileId: "claude-1", role: "implement" as const };

describe("run notices", () => {
  it("turns a report into a webhook event with the machine, and cleans the error first", async () => {
    const events: HiveEvent[] = [];
    const hive = new SqliteHive(":memory:", { onEvent: (e) => events.push(e) });
    const zw = String.fromCodePoint(0x200b);
    const failed = await hive.call("runs.report", { kind: "failed", ...base, error: `npm ERR! code 1\nTypeError: boom${zw} at x.ts:3` }, runner);
    assert.equal(failed.error, "TypeError: boom at x.ts:3", "last line only, hidden characters removed");
    assert.equal(failed.machine, runner.name);
    const leaky = await hive.call("runs.report", { kind: "failed", ...base, error: `auth failed for ghp_${"a".repeat(36)}` }, runner);
    assert.equal(leaky.error, "(hidden: it looked like a secret)");
    await hive.call("runs.report", { kind: "mr", ...base, mrUrl: "https://gitlab.example.com/g/app/-/merge_requests/7", mrIid: 7 }, runner);
    assert.deepEqual(events.map((e) => e.type), ["run.failed", "run.failed", "mr.created"]);
  });

  it("needs to contribute to the project, and a real link", async () => {
    const hive = new SqliteHive(":memory:");
    await assert.rejects(hive.call("runs.report", { kind: "failed", ...base }, pm), (e: unknown) => e instanceof HiveError && e.code === "forbidden");
    await assert.rejects(
      hive.call("runs.report", { kind: "mr", ...base, mrUrl: "javascript:alert(1)", mrIid: 7 }, runner),
      (e: unknown) => e instanceof HiveError && e.code === "bad_request",
    );
  });
});
