import { describe, expect, it } from "vitest";
import {
  CODE_WORKFLOW_PRESETS,
  presetSubject,
  type ReviewGateInput,
  reviewGate,
  reviewPhase,
  reviewWorkflow,
  WORKFLOW_PRESETS,
  type WorkflowInput,
  workflowInput,
  workflowListInput,
  workflowsContract,
} from "./workflows.ts";

const docWorkflow = (over: Partial<WorkflowInput> = {}): WorkflowInput => ({
  name: "PRD",
  preset: "aidlc",
  teamId: null,
  docPrefixes: ["project/payment-api/prd"],
  phases: WORKFLOW_PRESETS.aidlc,
  enabled: true,
  ...over,
});

const codeWorkflow = (gates: ReviewGateInput[], over: Partial<WorkflowInput> = {}): WorkflowInput => ({
  name: "Review code payment-api",
  preset: "custom",
  subject: "code",
  teamId: null,
  docPrefixes: [],
  code: { projects: ["payment-api"], baseBranches: ["main"] },
  phases: [{ name: "Kiểm", gates }],
  enabled: true,
  ...over,
});

const messages = (w: WorkflowInput) => {
  const r = workflowInput.safeParse(w);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("quy trình tài liệu đã có", () => {
  it("parse như trước, mặc định là tài liệu", () => {
    const w = workflowInput.parse(docWorkflow());
    expect(w.subject).toBe("doc");
    expect(w.code).toBeNull();
    expect(w.docPrefixes).toEqual(["project/payment-api/prd"]);
  });

  it("checkpoint tài liệu đã lưu không có trường mới sau khi parse", () => {
    // Bản lưu ở hub so sánh cả khối phases; thêm trường mặc định sẽ làm mọi quy trình cũ trông như vừa bị sửa.
    const gate = reviewGate.parse({ id: "ai-prd", name: "AI", kind: "ai", ai: { checks: ["Đủ mục"], passScore: 7 } });
    expect(Object.keys(gate.ai ?? {}).sort()).toEqual(["checks", "passScore"]);
    expect(Object.keys(gate.conditions).sort()).toEqual([
      "docTypes",
      "keywords",
      "minChangedLines",
      "skipFormattingOnly",
    ]);
    expect(gate.reviewers).toBeUndefined();
  });

  it("vẫn bắt buộc tiền tố tài liệu", () => {
    expect(messages(docWorkflow({ docPrefixes: [] }))).toContain("Cần ít nhất một tiền tố tài liệu.");
  });

  it("từ chối quy tắc và cấu hình chỉ dùng cho code", () => {
    const phases = [
      {
        name: "Kiểm",
        gates: [{ id: "r", name: "Quy tắc", kind: "rule" as const, rules: ["command" as const] }],
      },
    ];
    expect(messages(docWorkflow({ phases }))).toContain("Quy tắc này chỉ dùng cho code.");
    expect(messages(docWorkflow({ preset: "code-basic" }))).toContain("Khung mẫu này dành cho quy trình code.");
  });

  it("đầu ra của hub chưa có cột subject vẫn hợp lệ", () => {
    const w = reviewWorkflow.parse({
      id: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
      name: "PRD",
      preset: "aidlc",
      teamId: null,
      docPrefixes: ["org/"],
      phases: [],
      enabled: true,
      updatedAt: "2026-10-13T00:00:00.000Z",
      updatedBy: null,
      inFlight: 0,
    });
    expect(w.subject).toBe("doc");
    expect(w.code).toBeNull();
  });
});

describe("quy trình code", () => {
  const rules: ReviewGateInput = {
    id: "rules",
    name: "Quy tắc",
    kind: "rule",
    rules: ["command", "max-files", "deny-paths", "max-diff", "no-secrets", "agent-report"],
    commands: [{ run: "pnpm test", timeoutSec: 900 }],
    maxFiles: 50,
    denyPaths: ["infra/prod/**"],
    maxDiffLines: 1000,
  };
  const aiConfig: NonNullable<ReviewGateInput["ai"]> = {
    checks: ["Có test", "Không lộ bí mật", "Đúng yêu cầu", "Dễ đọc"],
    passScore: 8,
    reviewers: [{ cli: "claude" }, { cli: "codex", model: "gpt-5.5" }],
    aggregate: "all",
    blockOn: "critical",
    runner: "team",
  };
  const ai: ReviewGateInput = {
    id: "ai",
    name: "Review AI",
    kind: "ai",
    ai: aiConfig,
    conditions: { paths: ["src/payments/**"], taskTypes: ["feature"], minChangedLines: 10 },
  };
  const human: ReviewGateInput = {
    id: "dev",
    name: "Dev duyệt",
    kind: "human",
    reviewers: { users: ["bob"], roles: [], quorum: 1, allowRequester: true },
    slaHours: 24,
  };
  const ci: ReviewGateInput = { id: "ci", name: "CI", kind: "ext", ext: { check: "ci", whenNone: "fail" } };

  it("lưu được với mọi loại checkpoint và điền mặc định phạm vi, tuỳ chọn", () => {
    const w = workflowInput.parse(codeWorkflow([rules, ai, ci, human]));
    expect(w.docPrefixes).toEqual([]);
    expect(w.code).toEqual({
      projects: ["payment-api"],
      baseBranches: ["main"],
      taskTypes: [],
      paths: [],
      merge: "project",
      maxAgentRevisions: 2,
      dismissStaleApprovals: false,
    });
  });

  it("cần phạm vi và không dùng tiền tố tài liệu", () => {
    expect(messages(codeWorkflow([rules], { code: null }))).toContain("Quy trình code cần phạm vi kích hoạt.");
    expect(messages(codeWorkflow([rules], { docPrefixes: ["org/"] }))).toContain(
      "Quy trình code không dùng tiền tố tài liệu.",
    );
    expect(messages(codeWorkflow([rules], { preset: "aidlc" }))).toContain("Khung mẫu này dành cho tài liệu.");
  });

  it("từ chối quy tắc tài liệu", () => {
    for (const r of ["sections", "requirements"] as const) {
      expect(messages(codeWorkflow([{ ...rules, rules: [r] }]))).toContain("Quy tắc này chỉ dùng cho tài liệu.");
    }
  });

  it("quy tắc code cần cấu hình đi kèm", () => {
    const bare: ReviewGateInput = { id: "r", name: "R", kind: "rule", rules: ["command", "max-files", "deny-paths"] };
    expect(messages(codeWorkflow([bare]))).toEqual([
      "Checkpoint “R” cần lệnh kiểm.",
      "Checkpoint “R” cần số file tối đa.",
      "Checkpoint “R” cần đường dẫn cấm.",
    ]);
  });

  it("checkpoint AI cần reviewer, model chọn theo reviewer", () => {
    const noReviewers: ReviewGateInput = { ...ai, ai: { checks: ["Có test"], passScore: 7 } };
    expect(messages(codeWorkflow([noReviewers]))).toContain("Checkpoint “Review AI” cần 1–3 reviewer AI.");
    const withModel: ReviewGateInput = { ...ai, ai: { ...aiConfig, model: "opus" } };
    expect(messages(codeWorkflow([withModel]))).toContain("Chọn model theo từng reviewer.");
    const four: ReviewGateInput = {
      ...ai,
      ai: { ...aiConfig, reviewers: [{ cli: "claude" }, { cli: "codex" }, { cli: "gemini" }, { cli: "claude" }] },
    };
    expect(workflowInput.safeParse(codeWorkflow([four])).success).toBe(false);
  });

  it("từ chối điều kiện và hành động khi đạt chỉ dùng cho tài liệu", () => {
    const kw: ReviewGateInput = { ...human, conditions: { keywords: ["phí"] } };
    expect(messages(codeWorkflow([kw]))).toContain(
      "Điều kiện loại tài liệu, từ khoá, định dạng chỉ dùng cho tài liệu.",
    );
    const baseline: ReviewGateInput = { ...human, onPass: "baseline" };
    expect(messages(codeWorkflow([baseline]))).toContain(
      "Checkpoint của quy trình code chỉ sang checkpoint kế khi đạt.",
    );
  });

  it("giới hạn lệnh kiểm và số lượt agent sửa", () => {
    const six = Array.from({ length: 6 }, () => ({ run: "make", timeoutSec: 60 }));
    expect(workflowInput.safeParse(codeWorkflow([{ ...rules, commands: six }])).success).toBe(false);
    expect(
      workflowInput.safeParse(codeWorkflow([rules], { code: { projects: [], maxAgentRevisions: 6 } })).success,
    ).toBe(false);
  });
});

describe("khung mẫu", () => {
  it.each(Object.keys(CODE_WORKFLOW_PRESETS) as (keyof typeof CODE_WORKFLOW_PRESETS)[])("%s hợp lệ", (preset) => {
    expect(presetSubject(preset)).toBe("code");
    const w = codeWorkflow([], { preset, phases: CODE_WORKFLOW_PRESETS[preset] });
    expect(messages(w)).toEqual([]);
  });

  it("code-basic có ba giai đoạn: quy tắc, AI điểm 7, người duyệt SLA 24 giờ", () => {
    const phases = CODE_WORKFLOW_PRESETS["code-basic"].map((p) => reviewPhase.parse(p));
    expect(phases.map((p) => p.gates.map((g) => g.kind))).toEqual([["rule"], ["ai"], ["human"]]);
    expect(phases[1]?.gates[0]?.ai?.reviewers).toHaveLength(1);
    expect(phases[1]?.gates[0]?.ai?.passScore).toBe(7);
    expect(phases[2]?.gates[0]?.slaHours).toBe(24);
  });

  it("khung tài liệu vẫn hợp lệ và tra được qua WORKFLOW_PRESETS", () => {
    for (const preset of ["aidlc", "speckit", "bmad"] as const) {
      expect(presetSubject(preset)).toBe("doc");
      expect(messages(docWorkflow({ preset, phases: WORKFLOW_PRESETS[preset] }))).toEqual([]);
    }
    expect(WORKFLOW_PRESETS["code-fast"]).toBe(CODE_WORKFLOW_PRESETS["code-fast"]);
    expect(presetSubject("custom")).toBeNull();
  });
});

describe("route", () => {
  it("list lọc theo loại và vẫn gọi được không có tham số", () => {
    expect(workflowsContract.list["~orpc"].inputSchema).toBe(workflowListInput);
    expect(workflowListInput.safeParse(undefined).success).toBe(true);
    expect(workflowListInput.safeParse({ subject: "code" }).success).toBe(true);
    expect(workflowListInput.safeParse({ subject: "pr" }).success).toBe(false);
  });
});
