import { describe, expect, it } from "vitest";
import {
  codeDryRunInput,
  codeReviewDecideInput,
  codeReviewListInput,
  codeReviewOverrideInput,
  codeReviewsContract,
  outcomeToCodeWorkflow,
} from "./code-reviews.ts";
import { contract } from "./index.ts";
import { defaultProjectSettings, type ProjectSettings } from "./projects.ts";
import { WORKFLOW_PRESETS, workflowInput } from "./workflows.ts";

const id = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const headSha = "a".repeat(40);
const errors = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : (r.error?.issues.map((i) => i.message) ?? []);

describe("đầu vào phiên review code", () => {
  it("trả lại phải có góp ý, duyệt thì không", () => {
    expect(codeReviewDecideInput.safeParse({ id, headSha, decision: "approve" }).success).toBe(true);
    expect(errors(codeReviewDecideInput.safeParse({ id, headSha, decision: "changes" }))).toEqual([
      "Ghi góp ý khi trả lại.",
    ]);
    expect(
      codeReviewDecideInput.safeParse({ id, headSha, decision: "changes", note: "Thiếu test", route: "agent" }).success,
    ).toBe(true);
  });

  it("quyết định phải kèm headSha hợp lệ", () => {
    expect(codeReviewDecideInput.safeParse({ id, decision: "approve" }).success).toBe(false);
    expect(errors(codeReviewDecideInput.safeParse({ id, headSha: "main", decision: "approve" }))).toEqual([
      "SHA commit không hợp lệ.",
    ]);
  });

  it("quyết thay bắt buộc ghi lý do", () => {
    const msg = "Ghi lý do khi quyết thay checkpoint tự động.";
    expect(errors(codeReviewOverrideInput.safeParse({ id, headSha, passed: true }))).toEqual([msg]);
    expect(errors(codeReviewOverrideInput.safeParse({ id, headSha, passed: true, note: "   " }))).toEqual([msg]);
    expect(codeReviewOverrideInput.parse({ id, headSha, passed: false, note: " CI treo " }).note).toBe("CI treo");
  });

  it("danh sách mặc định là của tôi, lọc SLA không nhận `none`", () => {
    expect(codeReviewListInput.parse({})).toEqual({ scope: "mine", limit: 50 });
    expect(codeReviewListInput.safeParse({ sla: "overdue", projectId: id }).success).toBe(true);
    expect(codeReviewListInput.safeParse({ sla: "none" }).success).toBe(false);
  });

  it("chạy thử chỉ nhận quy trình code", () => {
    const doc = {
      name: "PRD",
      preset: "aidlc" as const,
      teamId: null,
      docPrefixes: ["org/"],
      phases: WORKFLOW_PRESETS.aidlc,
      enabled: true,
    };
    expect(errors(codeDryRunInput.safeParse({ workflow: doc, runId: id }))).toEqual([
      "Chạy thử ở đây chỉ dành cho quy trình code.",
    ]);
    const code = {
      ...doc,
      preset: "code-basic" as const,
      subject: "code" as const,
      docPrefixes: [],
      code: {},
      phases: WORKFLOW_PRESETS["code-basic"],
    };
    expect(codeDryRunInput.safeParse({ workflow: code, runId: id }).success).toBe(true);
  });

  it("gắn vào hợp đồng chung", () => {
    expect(contract.codeReviews).toBe(codeReviewsContract);
    expect(Object.keys(codeReviewsContract).sort()).toEqual([
      "count",
      "decide",
      "dryRun",
      "enqueue",
      "files",
      "get",
      "list",
      "override",
      "recheck",
      "workflowFromProject",
    ]);
  });
});

describe("outcomeToCodeWorkflow", () => {
  const settings = (patch: (s: ProjectSettings) => void): ProjectSettings => {
    const s = defaultProjectSettings(0);
    patch(s);
    return s;
  };

  it("review chéo, CI bắt buộc, hai người duyệt → ba checkpoint", () => {
    const w = outcomeToCodeWorkflow(
      settings((s) => {
        s.features.crossReview = true;
        s.merge.requireCi = true;
        s.merge.requiredApprovals = 2;
        s.outcome.default.push({
          check: "review",
          required: true,
          by: "codex",
          minScore: 8,
          when: { paths: ["src/**"] },
        });
      }),
      "payment-api",
    );
    expect(w.subject).toBe("code");
    expect(w.code?.projects).toEqual(["payment-api"]);
    expect(w.code?.taskTypes).toEqual([]);
    const gates = w.phases.flatMap((p) => p.gates);
    expect(gates.map((g) => g.kind)).toEqual(["ai", "ext", "human"]);
    expect(gates[0]?.ai).toMatchObject({ passScore: 8, reviewers: [{ cli: "codex" }] });
    expect(gates[0]?.conditions.paths).toEqual(["src/**"]);
    expect(gates[1]?.ext).toEqual({ check: "ci", whenNone: "fail" });
    expect(gates[2]?.reviewers?.quorum).toBe(2);
    expect(workflowInput.safeParse(w).success).toBe(true);
  });

  it("review chéo tắt thì không có checkpoint AI", () => {
    const w = outcomeToCodeWorkflow(
      settings((s) => {
        s.merge.requiredApprovals = 1;
        s.outcome.default.push({ check: "review", required: true, by: "claude", minScore: 7 });
      }),
      "web",
    );
    expect(w.phases.flatMap((p) => p.gates).map((g) => g.kind)).toEqual(["human"]);
  });

  it("review chỉ ở vài loại task thì phạm vi theo các loại đó", () => {
    const w = outcomeToCodeWorkflow(
      settings((s) => {
        s.features.crossReview = true;
        s.outcome.byType.feature = [{ check: "review", required: false, by: "gemini", minScore: 6 }];
      }),
      "web",
    );
    expect(w.code?.taskTypes).toEqual(["feature"]);
    expect(w.phases.flatMap((p) => p.gates)[0]?.ai?.reviewers).toEqual([{ cli: "gemini" }]);
  });

  it("điều kiện số dòng HOẶC đường dẫn không chép được thành điều kiện VÀ: bỏ điều kiện", () => {
    const w = outcomeToCodeWorkflow(
      settings((s) => {
        s.features.crossReview = true;
        s.outcome.default.push({
          check: "review",
          required: true,
          by: "claude",
          minScore: 7,
          when: { minChangedLines: 50, paths: ["src/**"] },
        });
      }),
      "web",
    );
    const ai = w.phases[0]?.gates[0];
    expect(ai?.conditions.minChangedLines).toBeNull();
    expect(ai?.conditions.paths).toBeUndefined();
  });

  it("dự án không review, không CI, không cần người duyệt vẫn ra quy trình hợp lệ", () => {
    const w = outcomeToCodeWorkflow(defaultProjectSettings(0), "web");
    expect(w.phases).toHaveLength(1);
    expect(w.phases[0]?.gates[0]?.rules).toEqual(["no-secrets"]);
  });
});
