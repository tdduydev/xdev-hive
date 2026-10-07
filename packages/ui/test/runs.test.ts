import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setActiveLocale } from "#ui/i18n/translate.ts";
import { canRedispatch, fixInstructions, handoffSections, isLive, latestReviews, mrLabel, runDuration, runGroup, runLabel, runLink, runOutcome, waitingReason } from "#ui/lib/runs.ts";

describe("run helpers", () => {
  it("offers redispatch only for ended failures, cancellations and quota limits", () => {
    for (const status of ["failed", "cancelled", "rate_limited"]) assert.equal(canRedispatch({ status }), true);
    for (const status of ["queued", "running", "succeeded", "unknown"]) assert.equal(canRedispatch({ status }), false);
  });
  it("opens the exact machine's run from a task chain", () => {
    assert.equal(runLink("runner@one", "R-1"), "#/runs?run=runner%40one%2FR-1");
    assert.notEqual(runLink("runner@one", "R-1"), runLink("runner@two", "R-1"));
  });

  it("shows waiting only for a reported quota, failed CI or an explicit question", () => {
    assert.equal(waitingReason({ status: "rate_limited" }), "quota");
    assert.equal(waitingReason({ status: "succeeded", mr: { pipeline: "failed" } }), "ci");
    assert.equal(waitingReason({ status: "succeeded", summary: "Cần bạn xác nhận cách xử lý." }), "question");
    assert.equal(waitingReason({ status: "failed", error: "TypeError: boom" }), null);
  });

  it("reads a structured handoff in its specified order", () => {
    assert.deepEqual(handoffSections("ĐÃ LÀM: Sửa form\nCHƯA LÀM: Không\nCÁCH KIỂM: npm test\nRỦI RO: Máy cũ"), [
      { id: "done", text: "Sửa form" }, { id: "left", text: "Không" }, { id: "verify", text: "npm test" }, { id: "risk", text: "Máy cũ" },
    ]);
    assert.deepEqual(handoffSections("Completed the task."), []);
  });
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

  it("puts every run under one of the three quick filters, a status it does not know included", () => {
    const of = (status: string) => runGroup(status);
    assert.deepEqual(["queued", "running"].map(of), ["live", "live"]);
    assert.equal(of("succeeded"), "done");
    // Nothing ends outside the three: cancelled and a status from a newer machine read as a problem.
    assert.deepEqual(["failed", "rate_limited", "cancelled", "paused"].map(of), ["bad", "bad", "bad", "bad"]);
  });

  it("names a merge request by its host: GitLab by !iid, GitHub by #iid", () => {
    assert.equal(mrLabel({ mrUrl: "https://gitlab.example/g/p/-/merge_requests/12", iid: 12 }), "MR !12");
    assert.equal(mrLabel({ mrUrl: "https://github.com/g/p/pull/7", iid: 7 }), "PR #7");
    assert.equal(mrLabel({ mrUrl: null, iid: null }), "MR !?");
  });

  it("says in words what came of a run", () => {
    const run = (extra: Record<string, unknown>) => ({ status: "succeeded", commits: 0, ...extra });
    assert.equal(runOutcome(run({ commits: 1, mrUrl: "https://gitlab.example/g/p/-/merge_requests/12", mrIid: 12 })), "Xong · 1 commit · MR !12");
    assert.equal(runOutcome(run({ commits: 2 })), "Xong · 2 commit");
    // The hub's record keeps the number under mr, this machine's run under mrIid.
    assert.equal(runOutcome(run({ mr: { iid: 3 }, mrUrl: "https://gitlab.example/g/p/-/merge_requests/3" })), "Xong · MR !3");
    assert.equal(runOutcome(run({ status: "failed", error: "TypeError: boom\nat run()" })), "Lỗi: TypeError: boom");
    assert.equal(runOutcome(run({ status: "cancelled" })), "Đã huỷ");
    // A row has no log, so a live run says what the agent last reported doing, on one line.
    assert.equal(runOutcome(run({ status: "running", activity: "Viết test\nvà chạy" })), "Đang chạy · Viết test");
    assert.equal(runOutcome(run({ status: "running" })), "Đang chạy");
    assert.equal(runOutcome(run({ status: "running", activity: "x".repeat(200) })), `Đang chạy · ${"x".repeat(79)}…`);
    setActiveLocale("en");
    try {
      assert.equal(runOutcome(run({ status: "failed", error: "boom" })), "Failed: boom");
    } finally {
      setActiveLocale("vi");
    }
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
