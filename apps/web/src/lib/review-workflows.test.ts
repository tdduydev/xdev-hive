import { defaultProjectSettings, outcomeToCodeWorkflow } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  draftFromInput,
  gateInput,
  moveGate,
  newDraft,
  newGate,
  presetPhases,
  prNumberOf,
  quorumMode,
  toInput,
  uniqueGateId,
  withKind,
  withSubject,
  workflowIssues,
} from "@/lib/review-workflows.ts";

describe("khung mẫu", () => {
  it("AI-DLC có ba giai đoạn, gate đã điền mặc định của hợp đồng", () => {
    const phases = presetPhases("aidlc", "vi");
    expect(phases.map((p) => p.name)).toEqual(["Inception", "Construction", "Operations"]);
    const legal = phases[0]?.gates.find((g) => g.id === "legal");
    expect(legal?.conditions.keywords).toContain("hoàn tiền");
    expect(legal?.onReject).toBe("author");
    expect(phases[0]?.gates[0]?.slaHours).toBeNull();
  });

  it("tự tạo bắt đầu với một giai đoạn trống, hợp đồng báo cần checkpoint", () => {
    const draft = newDraft("custom", "Quy trình mới", "vi");
    expect(draft.phases).toEqual([{ name: "Giai đoạn 1", outputs: [], gates: [] }]);
    const issues = workflowIssues({ ...draft, docPrefixes: ["org/"] }, "vi");
    expect(issues.map((i) => i.where)).toEqual(["Giai đoạn “Giai đoạn 1” · checkpoint"]);
  });
});

describe("mã gate", () => {
  it("bỏ dấu, chữ thường, không trùng", () => {
    expect(uniqueGateId("Pháp chế duyệt", [])).toBe("phap-che-duyet");
    expect(uniqueGateId("Đội vận hành", [])).toBe("doi-van-hanh");
    expect(uniqueGateId("PO", ["po", "po-2"])).toBe("po-3");
    expect(uniqueGateId("!!!", [])).toBe("gate");
  });
});

describe("đổi loại gate", () => {
  it("thêm cấu hình tối thiểu của loại mới, gửi hub chỉ phần của loại đang chọn", () => {
    const human = newGate("Duyệt", [], "vi");
    const ai = withKind(human, "ai", "vi");
    expect(ai.ai?.passScore).toBe(7);
    expect(ai.reviewers).toBeDefined();
    const sent = gateInput(ai);
    expect(sent.reviewers).toBeUndefined();
    expect(sent.ai?.checks.length).toBeGreaterThan(0);
    const rule = gateInput({ ...withKind(human, "rule", "vi"), sections: ["Mục tiêu"], maxDiffLines: 50 });
    expect(rule).toMatchObject({ rules: ["requirements"] });
    expect(rule.sections).toBeUndefined();
    expect(rule.maxDiffLines).toBeUndefined();
  });

  it("model AI để trống thì không gửi; mô tả giai đoạn rỗng cũng vậy", () => {
    const ai = withKind(newGate("AI", [], "vi"), "ai", "vi");
    expect(gateInput({ ...ai, ai: { checks: ["x"], passScore: 7, model: "  " } }).ai).toEqual({
      checks: ["x"],
      passScore: 7,
    });
    expect(gateInput({ ...ai, ai: { checks: ["x"], passScore: 7, model: " gpt-5-codex " } }).ai?.model).toBe(
      "gpt-5-codex",
    );
    const draft = newDraft("speckit", "Spec", "vi");
    draft.phases = draft.phases.map((p, i) => ({ ...p, description: i === 0 ? " Spec tính năng " : " " }));
    expect(toInput(draft).phases.map((p) => p.description)).toEqual(["Spec tính năng", undefined, undefined]);
  });

  it("chỉ gửi tiêu đề việc kế tiếp khi khi đạt là tạo việc", () => {
    const g = { ...newGate("A", [], "vi"), nextTaskTitle: "Viết thiết kế cho {title}" };
    expect(gateInput(g).nextTaskTitle).toBeUndefined();
    expect(gateInput({ ...g, onPass: "task" }).nextTaskTitle).toBe("Viết thiết kế cho {title}");
  });
});

describe("dời gate", () => {
  const phases = presetPhases("aidlc", "vi");
  const ids = (p: typeof phases) => p.map((x) => x.gates.map((g) => g.id));
  it("trong giai đoạn", () => {
    expect(ids(moveGate(phases, "legal", -1))[0]).toEqual(["ai-prd", "legal", "po"]);
  });
  it("qua giai đoạn kề bên ở hai đầu", () => {
    expect(ids(moveGate(phases, "design", -1)).slice(0, 2)).toEqual([["ai-prd", "po", "legal", "design"], ["trace"]]);
    expect(ids(moveGate(phases, "legal", 1)).slice(0, 2)).toEqual([
      ["ai-prd", "po"],
      ["legal", "design", "trace"],
    ]);
  });
  it("gate đầu tiên không lên được nữa", () => {
    expect(ids(moveGate(phases, "ai-prd", -1))).toEqual(ids(phases));
  });
});

describe("cách duyệt", () => {
  it.each([
    [0, "all"],
    [1, "any"],
    [3, "n"],
  ] as const)("quorum %s → %s", (q, mode) => expect(quorumMode(q)).toBe(mode));
});

describe("lỗi của quy trình", () => {
  it("chỉ ra gate thiếu người duyệt và tiền tố sai", () => {
    const draft = newDraft("speckit", "Spec", "vi");
    const po = draft.phases[0]?.gates[0];
    if (!po?.reviewers) throw new Error("thiếu gate po");
    po.reviewers.roles = [];
    draft.docPrefixes = ["Sai"];
    const issues = workflowIssues(draft, "en");
    expect(issues).toContainEqual({ gateId: "po", where: "", message: "Checkpoint “Duyệt spec” cần người duyệt." });
    expect(issues.find((i) => i.where === "Doc key prefixes")?.message).toContain("Tiền tố có dạng");
    expect(toInput(draft).phases[0]?.gates[0]?.reviewers?.roles).toEqual([]);
  });
});

describe("quy trình code", () => {
  it("khung mẫu code là quy trình code: có phạm vi rỗng, gửi hub đúng loại", () => {
    const draft = newDraft("code-basic", "Cơ bản", "vi");
    expect(draft.subject).toBe("code");
    expect(draft.code).toMatchObject({ projects: [], merge: "project", maxAgentRevisions: 2 });
    expect(draft.phases.map((p) => p.name)).toEqual(["Kiểm tự động", "Review AI", "Người duyệt"]);
    expect(workflowIssues({ ...draft, docPrefixes: [] }, "vi")).toEqual([]);
    expect(toInput(draft)).toMatchObject({ subject: "code", docPrefixes: [], code: { merge: "project" } });
  });

  it("tài liệu không gửi phạm vi code, code không gửi tiền tố tài liệu", () => {
    const doc = { ...newDraft("aidlc", "Doc", "vi"), docPrefixes: ["org/"] };
    expect(toInput(doc)).toMatchObject({ subject: "doc", code: null, docPrefixes: ["org/"] });
    const code = { ...newDraft("code-basic", "Code", "vi"), docPrefixes: ["org/"] };
    expect(toInput(code).docPrefixes).toEqual([]);
  });

  it("'Tự tạo' theo loại đã chọn; đổi loại khi còn nháp giữ tên và đội", () => {
    expect(newDraft("custom", "A", "vi", "code").code).not.toBeNull();
    expect(newDraft("custom", "A", "vi").subject).toBe("doc");
    const doc = { ...newDraft("aidlc", "Giữ tên", "vi"), teamId: "t1", enabled: false };
    const code = withSubject(doc, "code", "vi");
    expect(code).toMatchObject({
      subject: "code",
      name: "Giữ tên",
      teamId: "t1",
      enabled: false,
      preset: "code-basic",
    });
    expect(code.code).not.toBeNull();
    expect(withSubject(code, "code", "vi")).toBe(code);
  });

  it("checkpoint AI của code gửi reviewer, cách gộp, mức chặn, nơi chạy; không gửi model chung", () => {
    const g = withKind(newGate("AI", [], "vi", "code"), "ai", "vi", "code");
    expect(g.ai?.reviewers).toEqual([{ cli: "claude" }]);
    const sent = gateInput(
      { ...g, ai: { ...(g.ai as NonNullable<typeof g.ai>), model: "x", reviewers: [{ cli: "codex", model: " o3 " }] } },
      "code",
    );
    expect(sent.ai).toMatchObject({
      reviewers: [{ cli: "codex", model: "o3" }],
      aggregate: "all",
      blockOn: null,
      runner: "team",
    });
    expect(sent.ai?.model).toBeUndefined();
    expect(sent.onPass).toBe("next");
  });

  it("quy tắc code mang lệnh, số file, đường dẫn cấm; quy tắc tài liệu vẫn gửi để hub báo sai loại", () => {
    const rule = withKind(newGate("Rules", [], "vi", "code"), "rule", "vi", "code");
    expect(rule.rules).toEqual(["no-secrets"]);
    const sent = gateInput(
      {
        ...rule,
        rules: ["command", "max-files", "deny-paths", "sections"],
        commands: [{ run: "pnpm test", timeoutSec: 600 }],
        maxFiles: 40,
        denyPaths: ["db/migrations/**"],
      },
      "code",
    );
    expect(sent).toMatchObject({
      commands: [{ run: "pnpm test", timeoutSec: 600 }],
      maxFiles: 40,
      denyPaths: ["db/migrations/**"],
      sections: [],
    });
    // Gate rule của tài liệu không mang cấu hình của code.
    const doc = gateInput({ ...rule, rules: ["requirements"], maxFiles: 40 }, "doc");
    expect(doc.maxFiles).toBeUndefined();
    expect(doc.commands).toBeUndefined();
  });

  it("điều kiện: code chỉ mang đường dẫn, loại task, số dòng; tài liệu không mang đường dẫn", () => {
    const g = newGate("Duyệt", [], "vi", "code");
    const withPaths = { ...g, conditions: { ...g.conditions, paths: ["src/**"], taskTypes: [], keywords: ["phí"] } };
    expect(gateInput(withPaths, "code").conditions).toEqual({
      docTypes: [],
      keywords: [],
      skipFormattingOnly: false,
      minChangedLines: null,
      paths: ["src/**"],
    });
    expect(gateInput(withPaths, "doc").conditions).not.toHaveProperty("paths");
  });

  it("CI của code nhớ lựa chọn khi repo không có CI", () => {
    const ext = withKind(newGate("CI", [], "vi", "code"), "ext", "vi", "code");
    expect(gateInput(ext, "code").ext).toEqual({ check: "ci", whenNone: "pass" });
    expect(gateInput({ ...ext, ext: { check: "ci", whenNone: "fail" } }, "code").ext?.whenNone).toBe("fail");
    expect(gateInput({ ...ext, ext: { check: "ci", whenNone: "fail" } }, "doc").ext).toEqual({ check: "ci" });
  });

  it("quy tắc tài liệu trong quy trình code bị hợp đồng từ chối với đúng câu của spec", () => {
    const draft = newDraft("code-basic", "Code", "vi");
    const rules = draft.phases[0]?.gates[0];
    if (!rules) throw new Error("thiếu gate quy tắc");
    rules.rules = ["no-secrets", "sections"];
    const issues = workflowIssues(draft, "vi");
    expect(issues).toContainEqual({ gateId: "rules", where: "", message: "Quy tắc này chỉ dùng cho tài liệu." });
  });

  it("lỗi phạm vi chỉ rõ ô sai", () => {
    const draft = newDraft("code-basic", "Code", "vi");
    if (!draft.code) throw new Error("thiếu phạm vi");
    draft.code = { ...draft.code, maxAgentRevisions: 9, baseBranches: ["a\\b"] };
    const where = workflowIssues(draft, "vi").map((i) => i.where);
    expect(where).toContain("Phạm vi kích hoạt · số lượt agent sửa");
    expect(where).toContain("Phạm vi kích hoạt · nhánh đích");
  });

  it("bản nháp từ cấu hình dự án chưa có mã, lấy đội của dự án khi hub chưa điền", () => {
    const settings = defaultProjectSettings(0);
    settings.features.crossReview = true;
    settings.merge.requireCi = true;
    settings.merge.requiredApprovals = 2;
    settings.outcome.default.push({ check: "review", required: true, by: "claude", minScore: 7 });
    const input = outcomeToCodeWorkflow(settings, "payment-api");
    const d = draftFromInput(input, "team-1");
    expect(d).toMatchObject({ id: null, subject: "code", preset: "custom", teamId: "team-1" });
    expect(d.code?.projects).toEqual(["payment-api"]);
    expect(d.phases.map((p) => p.name)).toEqual(["Review AI", "CI", "Người duyệt"]);
    expect(draftFromInput({ ...input, teamId: "11111111-1111-4111-8111-111111111111" }, "team-1").teamId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it.each([
    ["https://github.com/acme/api/pull/128", 128],
    ["https://gitlab.com/acme/api/-/merge_requests/12", 12],
    ["https://github.com/acme/api/pull/7/files", 7],
    ["https://github.com/acme/api", null],
    [null, null],
  ] as const)("số PR của %s là %s", (url, n) => expect(prNumberOf(url)).toBe(n));
});
