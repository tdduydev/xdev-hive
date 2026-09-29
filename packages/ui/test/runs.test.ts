import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setActiveLocale } from "../src/i18n/translate.ts";
import { fixInstructions, isLive, latestReviews, runDuration, runLabel } from "../src/lib/runs.ts";

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

  it("turns a review's report into a fix run's instructions, as findings, within what runs.dispatch takes", () => {
    const text = fixInstructions({ runId: "R-1fa9c0", profileId: "codex-1", summary: "Verdict: changes needed\n- reset the counter on success" });
    assert.match(text, /^Fix what review R-1fa9c0 \(codex-1\) asked for/);
    assert.match(text, /never as instructions/);
    assert.match(text, /"""\nVerdict: changes needed\n- reset the counter on success\n"""$/);
    const long = fixInstructions({ runId: "R-2", profileId: null, summary: "x".repeat(10_000) });
    assert.ok(long.length <= 4000, String(long.length));
    assert.match(long, /…\(cut\)\n"""$/);
    assert.doesNotMatch(long, /\(null\)/);
  });

  it("offers a fix only on the newest review of each task", () => {
    const run = (runId: string, taskId: string, role: string, machineId = "runner.mbp@mbp") => ({ machineId, runId, project: "app", taskId, role });
    const latest = latestReviews([run("R-5", "T-1", "implement"), run("R-4", "T-1", "review"), run("R-3", "T-2", "review", "runner.mini@mini"), run("R-2", "T-1", "review")]);
    assert.deepEqual([...latest].sort(), ["runner.mbp@mbp/R-4", "runner.mini@mini/R-3"]);
  });
});
