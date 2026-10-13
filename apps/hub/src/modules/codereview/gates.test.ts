import { type AiReviewerResult, type ReviewGate, reviewGate } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { aggregateAi, ciVerdict, evaluateRules, gateApplies, type ReviewerOutcome, type RuleContext } from "./gates.ts";

const gate = (over: Record<string, unknown>): ReviewGate =>
  reviewGate.parse({ id: "g", name: "Checkpoint", kind: "rule", rules: ["max-files"], ...over });

const stats = (over: Partial<{ addedLines: number; deletedLines: number; changedFiles: string[] }> = {}) => ({
  addedLines: 10,
  deletedLines: 2,
  changedFiles: ["src/a.ts", "src/b.ts", "README.md"],
  ...over,
});

const rctx = (over: Partial<RuleContext> = {}): RuleContext => ({
  taskType: "feature",
  stats: stats(),
  patches: [],
  hasAgentReport: true,
  commands: null,
  ...over,
});

describe("điều kiện checkpoint", () => {
  it("không điều kiện thì chạy", () => {
    expect(gateApplies(gate({}), { taskType: null, stats: stats() }).runs).toBe(true);
  });

  it("đường dẫn: bỏ qua khi diff không đụng, kèm lý do", () => {
    const g = gate({ conditions: { paths: ["src/payments/**"] } });
    const skipped = gateApplies(g, { taskType: null, stats: stats() });
    expect(skipped.runs).toBe(false);
    expect(skipped.reason).toContain("src/payments/**");
    expect(gateApplies(g, { taskType: null, stats: stats({ changedFiles: ["src/payments/x.ts"] }) }).runs).toBe(true);
  });

  it("loại task", () => {
    const g = gate({ conditions: { taskTypes: ["bug"] } });
    expect(gateApplies(g, { taskType: "feature", stats: stats() }).runs).toBe(false);
    expect(gateApplies(g, { taskType: null, stats: stats() }).runs).toBe(false);
    expect(gateApplies(g, { taskType: "bug", stats: stats() }).runs).toBe(true);
  });

  it("số dòng đổi tối thiểu", () => {
    const g = gate({ conditions: { minChangedLines: 200 } });
    const small = gateApplies(g, { taskType: null, stats: stats() });
    expect(small.runs).toBe(false);
    expect(small.reason).toContain("12 dòng");
    expect(gateApplies(g, { taskType: null, stats: stats({ addedLines: 200 }) }).runs).toBe(true);
  });

  it("thiếu số liệu diff thì vẫn chạy, trừ khi loại task đã loại", () => {
    const g = gate({ conditions: { paths: ["src/**"], minChangedLines: 50 } });
    expect(gateApplies(g, { taskType: null, stats: null }).runs).toBe(true);
    expect(gateApplies(gate({ conditions: { taskTypes: ["bug"] } }), { taskType: "feature", stats: null }).runs).toBe(
      false,
    );
  });
});

describe("quy tắc của quy trình code", () => {
  it("max-files", () => {
    const g = gate({ rules: ["max-files"], maxFiles: 2 });
    const v = evaluateRules(g, rctx());
    expect(v.status).toBe("failed");
    expect(v.checklist[0]).toMatchObject({ passed: false });
    expect(v.note).toContain("Đổi 3 file");
    expect(evaluateRules(gate({ rules: ["max-files"], maxFiles: 3 }), rctx()).status).toBe("passed");
  });

  it("deny-paths", () => {
    const g = gate({ rules: ["deny-paths"], denyPaths: ["infra/prod/**", "**/*.pem"] });
    expect(evaluateRules(g, rctx()).status).toBe("passed");
    const v = evaluateRules(g, rctx({ stats: stats({ changedFiles: ["infra/prod/main.tf", "src/a.ts"] }) }));
    expect(v.status).toBe("failed");
    expect(v.note).toContain("infra/prod/main.tf");
    expect(v.note).not.toContain("src/a.ts");
  });

  it("max-diff tính cả dòng thêm và xoá, mặc định 200 dòng", () => {
    const g = gate({ rules: ["max-diff"], maxDiffLines: 11 });
    expect(evaluateRules(g, rctx()).status).toBe("failed");
    expect(evaluateRules(gate({ rules: ["max-diff"], maxDiffLines: 12 }), rctx()).status).toBe("passed");
    const big = rctx({ stats: stats({ addedLines: 150, deletedLines: 60 }) });
    expect(evaluateRules(gate({ rules: ["max-diff"] }), big).status).toBe("failed");
  });

  it("thiếu số liệu diff thì chờ người xem, không tự đạt hay trượt", () => {
    const v = evaluateRules(gate({ rules: ["max-files", "max-diff"], maxFiles: 5 }), rctx({ stats: null }));
    expect(v.status).toBe("waiting");
    expect(v.checklist.every((c) => !c.passed)).toBe(true);
  });

  it("no-secrets chỉ quét dòng thêm của patch", () => {
    const token = `ghp_${"a1B2".repeat(9)}`;
    const g = gate({ rules: ["no-secrets"] });
    const leak = rctx({
      patches: [{ path: "src/config.ts", patch: `@@ -1,2 +1,3 @@\n context\n+const t = "${token}";\n-old` }],
    });
    const v = evaluateRules(g, leak);
    expect(v.status).toBe("failed");
    expect(v.note).toContain("token GitHub");
    expect(v.note).toContain("src/config.ts");
    const removed = rctx({
      patches: [{ path: "src/config.ts", patch: `@@ -1,2 +1,1 @@\n-const t = "${token}";\n ok` }],
    });
    expect(evaluateRules(g, removed).status).toBe("passed");
    const header = rctx({ patches: [{ path: "a", patch: `+++ b/${token}\n+ok` }] });
    expect(evaluateRules(g, header).status).toBe("passed");
  });

  it("no-secrets chờ người khi chưa có diff, và ghi chú file không có patch", () => {
    const g = gate({ rules: ["no-secrets"] });
    expect(evaluateRules(g, rctx({ patches: null })).status).toBe("waiting");
    const v = evaluateRules(g, rctx({ patches: [{ path: "logo.png", patch: null }] }));
    expect(v.status).toBe("passed");
    expect(v.checklist[0]?.note).toContain("1 file không có patch");
  });

  it("agent-report", () => {
    const g = gate({ rules: ["agent-report"] });
    expect(evaluateRules(g, rctx()).status).toBe("passed");
    const v = evaluateRules(g, rctx({ hasAgentReport: false }));
    expect(v.status).toBe("failed");
    expect(v.note).toContain("task_update");
  });

  it("command: thiếu report.commands thì chờ người", () => {
    const g = gate({ rules: ["command"], commands: [{ run: "pnpm test", timeoutSec: 600 }] });
    const v = evaluateRules(g, rctx({ commands: null }));
    expect(v.status).toBe("waiting");
    expect(v.note).toContain("Máy chưa hỗ trợ chạy lệnh kiểm; cần người xem.");
    // Worker mới nhưng không có kết quả của lệnh này cũng là thiếu bằng chứng.
    expect(evaluateRules(g, rctx({ commands: [] })).status).toBe("waiting");
  });

  it("command: mã thoát 0 đạt, khác 0 hoặc hết thời hạn không đạt", () => {
    const g = gate({
      rules: ["command"],
      commands: [
        { run: "pnpm lint", timeoutSec: 60 },
        { run: "pnpm test", timeoutSec: 600 },
      ],
    });
    const ok = { run: "pnpm lint", exit: 0, durationMs: 1000, tail: "" };
    expect(evaluateRules(g, rctx({ commands: [ok, { ...ok, run: "pnpm test" }] })).status).toBe("passed");
    const bad = evaluateRules(g, rctx({ commands: [ok, { ...ok, run: "pnpm test", exit: 1 }] }));
    expect(bad.status).toBe("failed");
    expect(bad.note).toContain("Mã thoát 1");
    const timeout = evaluateRules(g, rctx({ commands: [ok, { ...ok, run: "pnpm test", exit: null }] }));
    expect(timeout.note).toContain("Hết thời hạn 600 giây");
  });

  it("không đạt thắng chờ khi có cả hai", () => {
    const g = gate({
      rules: ["max-files", "command"],
      maxFiles: 1,
      commands: [{ run: "pnpm test", timeoutSec: 60 }],
    });
    expect(evaluateRules(g, rctx()).status).toBe("failed");
  });
});

describe("CI trên đầu PR", () => {
  const ci = (whenNone?: "pass" | "fail") => gate({ kind: "ext", rules: undefined, ext: { check: "ci", whenNone } });
  it("theo trạng thái nhà cung cấp", () => {
    expect(ciVerdict(ci(), "success").status).toBe("passed");
    expect(ciVerdict(ci(), "failure").status).toBe("failed");
    expect(ciVerdict(ci(), "pending").status).toBe("waiting");
  });
  it("repo không có CI theo whenNone, mặc định cho đạt", () => {
    expect(ciVerdict(ci(), "none").status).toBe("passed");
    expect(ciVerdict(ci("pass"), "none").status).toBe("passed");
    expect(ciVerdict(ci("fail"), "none").status).toBe("failed");
  });
});

describe("gộp kết quả AI", () => {
  type Ai = NonNullable<ReviewGate["ai"]>;
  const ai = (over: Partial<Ai> = {}): Ai => ({ checks: ["Đúng yêu cầu"], passScore: 8, ...over });
  const done = (cli: ReviewerOutcome["cli"], score: number, findings: AiReviewerResult["findings"] = []) =>
    ({ cli, state: "done", score, findings, error: null }) satisfies ReviewerOutcome;
  const finding = (severity: AiReviewerResult["findings"][number]["severity"], line: number | null = 12) => ({
    file: "src/refund.ts",
    line,
    severity,
    message: "Thiếu kiểm tra số tiền âm",
  });

  it("all: mọi reviewer phải đạt", () => {
    const v = aggregateAi(ai(), [done("claude", 9), done("codex", 6)]);
    expect(v.status).toBe("failed");
    expect(v.passed).toEqual([true, false]);
    expect(v.score).toBe(7.5);
    expect(v.note).toContain("codex chấm 6/10, dưới ngưỡng 8");
    expect(aggregateAi(ai(), [done("claude", 8), done("codex", 9)]).status).toBe("passed");
  });

  it("all là mặc định khi không khai cách gộp", () => {
    expect(aggregateAi(ai(), [done("claude", 10), done("codex", 5)]).status).toBe("failed");
  });

  it("avg: điểm trung bình đạt là đạt dù một reviewer thấp", () => {
    const v = aggregateAi(ai({ aggregate: "avg" }), [done("claude", 10), done("codex", 6)]);
    expect(v.status).toBe("passed");
    expect(v.passed).toEqual([true, false]);
    const low = aggregateAi(ai({ aggregate: "avg" }), [done("claude", 9), done("codex", 6)]);
    expect(low.status).toBe("failed");
    expect(low.note).toContain("Điểm trung bình 7.5/10");
  });

  it("blockOn: phát hiện mức chặn làm không đạt dù điểm cao", () => {
    const v = aggregateAi(ai({ blockOn: "major" }), [done("claude", 9, [finding("major")])]);
    expect(v.status).toBe("failed");
    expect(v.blocking).toMatchObject([{ cli: "claude", severity: "major", file: "src/refund.ts", line: 12 }]);
    expect(v.note).toContain("src/refund.ts:12");
    expect(v.note).toContain("Thiếu kiểm tra số tiền âm");
  });

  it("blockOn critical không chặn phát hiện major; null thì không chặn gì", () => {
    expect(aggregateAi(ai({ blockOn: "critical" }), [done("claude", 9, [finding("major")])]).status).toBe("passed");
    expect(aggregateAi(ai({ blockOn: "critical" }), [done("claude", 9, [finding("critical")])]).status).toBe("failed");
    expect(aggregateAi(ai({ blockOn: null }), [done("claude", 9, [finding("critical")])]).status).toBe("passed");
    expect(aggregateAi(ai({ blockOn: "major" }), [done("claude", 9, [finding("minor"), finding("info")])]).status).toBe(
      "passed",
    );
  });

  it("blockOn áp cả khi gộp avg", () => {
    const v = aggregateAi(ai({ aggregate: "avg", blockOn: "major" }), [
      done("claude", 10),
      done("codex", 10, [finding("critical", null)]),
    ]);
    expect(v.status).toBe("failed");
    expect(v.note).toContain("src/refund.ts: Thiếu kiểm tra số tiền âm");
  });

  it("chờ khi còn reviewer chưa xong, dù một reviewer đã chấm thấp", () => {
    const pending: ReviewerOutcome = { cli: "codex", state: "running", score: null, findings: [], error: null };
    const v = aggregateAi(ai(), [done("claude", 3), pending]);
    expect(v.status).toBe("waiting");
    expect(v.passed).toEqual([false, null]);
    expect(v.score).toBe(3);
  });

  it("máy dùng chung vắng: chờ và nói rõ CLI nào", () => {
    const v = aggregateAi(ai(), [
      done("claude", 9),
      { cli: "gemini", state: "waiting_machine", score: null, findings: [], error: null },
    ]);
    expect(v.status).toBe("waiting");
    expect(v.note).toBe("Chưa có máy dùng chung có gemini.");
  });

  it("một reviewer lỗi thì checkpoint không đạt, kèm lý do", () => {
    const v = aggregateAi(ai(), [
      done("claude", 9),
      { cli: "codex", state: "error", score: null, findings: [], error: "Run bị huỷ." },
    ]);
    expect(v.status).toBe("failed");
    expect(v.passed).toEqual([true, false]);
    expect(v.note).toContain("Run review của codex không có kết quả: Run bị huỷ.");
  });

  it("không có reviewer thì không đạt", () => {
    expect(aggregateAi(ai(), []).status).toBe("failed");
  });
});
