import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setActiveLocale } from "../src/i18n/translate.ts";
import { isLive, runDuration, runLabel } from "../src/lib/runs.ts";

describe("run helpers", () => {
  it("measures a run from its start, to its end or to now", () => {
    const now = new Date("2026-09-29T10:05:00Z");
    assert.equal(runDuration({ startedAt: null, finishedAt: null }, now), "");
    assert.equal(runDuration({ startedAt: "2026-09-29T10:04:18Z", finishedAt: null }, now), "42s");
    assert.equal(runDuration({ startedAt: "2026-09-29T10:00:00Z", finishedAt: "2026-09-29T10:03:05Z" }, now), "3m05");
    // A clock a little behind on the machine never shows a negative time.
    assert.equal(runDuration({ startedAt: "2026-09-29T10:05:03Z", finishedAt: null }, now), "0s");
  });

  it("follows queued and running runs only", () => {
    assert.deepEqual(
      ["queued", "running", "succeeded", "failed", "rate_limited", "cancelled"].filter((status) => isLive({ status })),
      ["queued", "running"],
    );
  });

  it("names statuses and roles in the viewer's language, unknown ones as they came", () => {
    setActiveLocale("en");
    try {
      assert.equal(runLabel("runStatus", "rate_limited"), "Out of quota");
      assert.equal(runLabel("agentRole", "review"), "Review");
      assert.equal(runLabel("runStatus", "paused"), "paused");
      assert.equal(runLabel("agentRole", "deploy"), "deploy");
    } finally {
      setActiveLocale("vi");
    }
    assert.equal(runLabel("runStatus", "running"), "Đang chạy");
  });
});
