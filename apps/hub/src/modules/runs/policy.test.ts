import { outcomeCheck } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { evaluatePlanRun, evaluatePolicy, evaluateReviewRun, matchGlob } from "./policy.ts";

const policy = (...checks: unknown[]) => checks.map((c) => outcomeCheck.parse(c));
const sha = "a".repeat(40);
const ok = { exit: 0, headSha: sha, report: { commitCount: 2, changedFiles: ["src/a.ts"] }, hasAgentReport: false };

describe("evaluatePolicy", () => {
  it("có commit, đạt changes → succeeded", () => {
    const r = evaluatePolicy(policy({ check: "changes" }), ok);
    expect(r.outcome).toBe("succeeded");
    expect(r.hasChanges).toBe(true);
    expect(r.checks[0]?.passed).toBe(true);
  });

  it("không có commit → no_changes", () => {
    const r = evaluatePolicy(policy({ check: "changes" }), { ...ok, headSha: null, report: { commitCount: 0 } });
    expect(r.outcome).toBe("no_changes");
  });

  it("agent thoát lỗi → failed kèm lý do", () => {
    const r = evaluatePolicy(policy({ check: "changes" }), { ...ok, exit: 2, report: { error: "hết giờ" } });
    expect(r.outcome).toBe("failed");
    expect(r.reasons[0]).toContain("hết giờ");
  });

  it("vượt maxFiles hoặc đụng đường dẫn cấm: bắt buộc → failed, mềm → needs_review", () => {
    const report = { commitCount: 1, changedFiles: ["infra/prod/main.tf", "a.ts"] };
    const hard = evaluatePolicy(policy({ check: "changes", deny: ["infra/prod/**"] }), { ...ok, report });
    expect(hard.outcome).toBe("failed");
    expect(hard.reasons[0]).toContain("infra/prod/main.tf");
    const soft = evaluatePolicy(policy({ check: "changes", required: false, maxFiles: 1 }), { ...ok, report });
    expect(soft.outcome).toBe("needs_review");
  });

  it("agentReport dựa vào sự kiện agent_report", () => {
    const p = policy({ check: "changes" }, { check: "agentReport" });
    expect(evaluatePolicy(p, ok).outcome).toBe("failed");
    expect(evaluatePolicy(p, { ...ok, hasAgentReport: true }).outcome).toBe("succeeded");
  });

  it("task nghiên cứu: chỉ agentReport, không commit vẫn succeeded", () => {
    const r = evaluatePolicy(policy({ check: "agentReport" }), {
      ...ok,
      headSha: null,
      report: null,
      hasAgentReport: true,
    });
    expect(r).toMatchObject({ outcome: "succeeded", hasChanges: false });
  });

  it("kiểm tra chưa hỗ trợ → needs_review kèm lý do", () => {
    const r = evaluatePolicy(policy({ check: "changes" }, { check: "command", run: "npm test" }, { check: "ci" }), ok);
    expect(r.outcome).toBe("needs_review");
    expect(r.reasons).toHaveLength(2);
    expect(r.checks.filter((c) => c.passed === null)).toHaveLength(2);
  });
});

describe("evaluatePolicy với lệnh kiểm", () => {
  const command = { run: "pnpm test", exit: 0, durationMs: 1200, tail: "ok" };
  const hard = policy({ check: "changes" }, { check: "command", run: "pnpm test" });
  const soft = policy({ check: "changes" }, { check: "command", run: "pnpm test", required: false });
  const evidence = (commands: unknown) => ({ ...ok, report: { ...ok.report, commands } });

  it("khớp theo lệnh, không theo vị trí; mọi lệnh đạt thì succeeded", () => {
    const r = evaluatePolicy(hard, evidence([{ ...command, run: "pnpm lint", exit: 1 }, command]));
    expect(r).toMatchObject({ outcome: "succeeded", reasons: [] });
    expect(r.checks[1]).toMatchObject({ passed: true, message: expect.stringContaining("mã thoát 0") });
    expect(evaluatePolicy(policy({ check: "command", run: " pnpm test " }), evidence([command])).outcome).toBe(
      "succeeded",
    );
  });

  it.each([1, 2, -1, null])("mã thoát %s: bắt buộc → failed, mềm → needs_review", (exit) => {
    const ev = evidence([{ ...command, exit }]);
    expect(evaluatePolicy(hard, ev).outcome).toBe("failed");
    expect(evaluatePolicy(soft, ev).outcome).toBe("needs_review");
    expect(evaluatePolicy(hard, ev).checks[1]?.passed).toBe(false);
  });

  it.each([
    undefined,
    null,
    {},
    [],
    [{ ...command, run: "pnpm lint" }],
    [{ ...command, exit: "0" }],
    [{ run: "pnpm test", exit: 0 }],
  ])("thiếu hoặc sai bằng chứng %j → như worker cũ, chờ người xem", (commands) => {
    const r = evaluatePolicy(hard, evidence(commands));
    expect(r).toMatchObject({ outcome: "needs_review", awaitingReview: false });
    expect(r.checks[1]).toMatchObject({ passed: null, message: expect.stringContaining("chưa hỗ trợ") });
  });

  it("nhiều lệnh được đánh giá riêng; một kết quả đạt không che lần chạy lỗi của cùng lệnh", () => {
    const r = evaluatePolicy(
      [...hard, ...policy({ check: "command", run: "pnpm lint" })],
      evidence([command, { ...command, run: "pnpm lint", exit: 1 }]),
    );
    expect(r.outcome).toBe("failed");
    expect(r.checks.map((c) => c.passed)).toEqual([true, true, false]);
    expect(evaluatePolicy(hard, evidence([command, { ...command, exit: 1 }])).outcome).toBe("failed");
  });

  it("lệnh bắt buộc lỗi chặn review chéo; lệnh đạt cho phép chờ review", () => {
    const p = [...hard, ...policy({ check: "review", by: "codex" })];
    expect(evaluatePolicy(p, { ...evidence([{ ...command, exit: 1 }]), review: { status: "pending" } })).toMatchObject({
      outcome: "failed",
      awaitingReview: false,
    });
    expect(evaluatePolicy(p, { ...evidence([command]), review: { status: "pending" } })).toMatchObject({
      outcome: "needs_review",
      awaitingReview: true,
    });
  });
});

describe("evaluatePolicy với review chéo", () => {
  const hard = policy({ check: "changes" }, { check: "review", by: "codex", minScore: 7 });
  const soft = policy({ check: "changes" }, { check: "review", required: false, by: "codex", minScore: 7 });

  it("chưa có run review → chờ review, chưa kết luận", () => {
    const r = evaluatePolicy(hard, { ...ok, review: { status: "pending" } });
    expect(r.awaitingReview).toBe(true);
    expect(r.checks[1]).toMatchObject({ check: "review", passed: null });
  });

  it("kiểm tra khác đã không đạt hoặc không có commit → không chờ review", () => {
    const empty = evaluatePolicy(hard, {
      ...ok,
      headSha: null,
      report: { commitCount: 0 },
      review: { status: "pending" },
    });
    expect(empty).toMatchObject({ outcome: "no_changes", awaitingReview: false });
    expect(empty.checks[1]?.message).toContain("Bỏ qua");
  });

  it("điểm đạt ngưỡng → succeeded; điểm thấp: bắt buộc → failed, mềm → needs_review", () => {
    const good = evaluatePolicy(hard, { ...ok, review: { status: "done", score: 8, by: "codex" } });
    expect(good).toMatchObject({ outcome: "succeeded", awaitingReview: false });
    expect(good.checks[1]).toMatchObject({ passed: true, message: expect.stringContaining("8/10") });
    const low = { ...ok, review: { status: "done", score: 4, by: "codex" } as const };
    expect(evaluatePolicy(hard, low).outcome).toBe("failed");
    expect(evaluatePolicy(soft, low).outcome).toBe("needs_review");
  });

  it("run review lỗi → kiểm tra review không đạt", () => {
    const failed = { ...ok, review: { status: "failed", reason: "hết lượt thử" } as const };
    const r = evaluatePolicy(hard, failed);
    expect(r.outcome).toBe("failed");
    expect(r.reasons[0]).toContain("hết lượt thử");
    expect(evaluatePolicy(soft, failed).outcome).toBe("needs_review");
  });

  it("tắt tính năng (không có review) → như cũ: cần người xem", () => {
    const r = evaluatePolicy(hard, ok);
    expect(r).toMatchObject({ outcome: "needs_review", awaitingReview: false });
    expect(r.checks[1]?.passed).toBeNull();
  });
});

describe("điều kiện review", () => {
  const conditional = (when: { minChangedLines?: number; paths?: string[] }) =>
    policy({ check: "changes" }, { check: "review", by: "codex", when });
  const small = {
    ...ok,
    diffStats: { addedLines: 7, deletedLines: 5, changedFiles: ["src/a.ts"] },
    review: { status: "pending" } as const,
  };

  it("review bắt buộc được bỏ qua, không chờ và không chặn thành công", () => {
    const r = evaluatePolicy(conditional({ minChangedLines: 100, paths: ["**/schema.ts"] }), small);
    expect(r).toMatchObject({ outcome: "succeeded", awaitingReview: false, reasons: [] });
    expect(r.checks[1]).toMatchObject({
      skipped: true,
      passed: null,
      required: true,
      message: expect.stringContaining("diff 12 dòng"),
    });
  });

  it.each([
    [{ minChangedLines: 12 }, true],
    [{ minChangedLines: 13 }, false],
    [{ minChangedLines: 0 }, true],
    [{ paths: ["src/**"] }, true],
    [{ paths: ["**/schema.ts"] }, false],
  ])("ngưỡng và đường dẫn độc lập: %j", (when, review) => {
    expect(evaluatePolicy(conditional(when), small).awaitingReview).toBe(review);
  });

  it("worker cũ không gửi số liệu thì luôn chờ review", () => {
    expect(
      evaluatePolicy(conditional({ minChangedLines: 100 }), { ...ok, review: { status: "pending" } }).awaitingReview,
    ).toBe(true);
  });

  it("bỏ qua một kiểm tra vẫn chạy kiểm tra review khác khớp điều kiện", () => {
    const p = policy(
      { check: "review", by: "codex", when: { minChangedLines: 100 } },
      { check: "review", by: "codex", when: { paths: ["src/**"] } },
    );
    const r = evaluatePolicy(p, small);
    expect(r.awaitingReview).toBe(true);
    expect(r.checks[0]?.skipped).toBe(true);
    expect(r.checks[1]?.skipped).not.toBe(true);
  });

  it("bỏ qua review không che kiểm tra khác không đạt", () => {
    expect(
      evaluatePolicy([...conditional({ minChangedLines: 100 }), ...policy({ check: "agentReport" })], small).outcome,
    ).toBe("failed");
    expect(evaluatePolicy([...conditional({ minChangedLines: 100 }), ...policy({ check: "ci" })], small).outcome).toBe(
      "needs_review",
    );
  });
});

describe("evaluateReviewRun", () => {
  it("đã nộp review → succeeded; chưa nộp hoặc thoát lỗi → failed", () => {
    expect(evaluateReviewRun({ exit: 0, report: null, score: 6 }).outcome).toBe("succeeded");
    expect(evaluateReviewRun({ exit: 0, report: null, score: null }).outcome).toBe("failed");
    expect(evaluateReviewRun({ exit: 1, report: { error: "x" }, score: 9 }).outcome).toBe("failed");
  });
});

describe("evaluatePlanRun", () => {
  it("đã nộp kế hoạch → succeeded; chưa nộp, hết giờ hay thoát lỗi → failed kèm lý do", () => {
    const ok = evaluatePlanRun({ exit: 0, report: null, steps: 3 });
    expect(ok).toMatchObject({ outcome: "succeeded", reasons: [], hasChanges: false });
    expect(ok.checks).toEqual([
      { check: "planReport", required: true, passed: true, message: "Agent đã nộp kế hoạch 3 bước." },
    ]);
    expect(evaluatePlanRun({ exit: 0, report: null, steps: null })).toMatchObject({
      outcome: "failed",
      reasons: ["Agent lập kế hoạch chưa gọi plan_submit."],
    });
    expect(evaluatePlanRun({ exit: 1, report: { error: "timeout" }, steps: 2 })).toMatchObject({
      outcome: "failed",
      reasons: ["Agent lập kế hoạch kết thúc với mã lỗi 1: timeout."],
    });
  });
});

describe("matchGlob", () => {
  it.each([
    ["infra/prod/**", "infra/prod/a/b.tf", true],
    ["infra/prod/**", "infra/staging/a.tf", false],
    ["infra/prod", "infra/prod/x", true],
    ["*.env", ".env", true],
    ["*.env", "a/b.env", false],
    ["**/*.pem", "a/b/c.pem", true],
    ["**/*.pem", "c.pem", true],
    ["src/?.ts", "src/a.ts", true],
  ])("%s ~ %s → %s", (g, p, want) => expect(matchGlob(g, p)).toBe(want));
});
