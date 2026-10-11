import { outcomeCheck } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { evaluatePolicy, matchGlob } from "./policy.ts";

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
