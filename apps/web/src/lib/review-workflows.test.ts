import { describe, expect, it } from "vitest";
import {
  gateInput,
  moveGate,
  newDraft,
  newGate,
  presetPhases,
  quorumMode,
  toInput,
  uniqueGateId,
  withKind,
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
    expect(issues.find((i) => i.where === "Applies to")?.message).toContain("Tiền tố có dạng");
    expect(toInput(draft).phases[0]?.gates[0]?.reviewers?.roles).toEqual([]);
  });
});
