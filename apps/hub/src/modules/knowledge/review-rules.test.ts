import { parseBreakdown, reviewGate } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  type BreakdownRuleInput,
  diffCounts,
  docTypeOf,
  formattingOnly,
  gateApplies,
  requiredApprovals,
  requirementsOf,
  ruleChecklist,
  slaOf,
  typeMatches,
} from "./review-rules.ts";

const gate = (over: Record<string, unknown>) =>
  reviewGate.parse({ id: "g", name: "Gate", kind: "rule", rules: ["requirements"], ...over });

describe("quy tắc của quy trình duyệt", () => {
  it("loại tài liệu theo đoạn cuối của key", () => {
    expect(docTypeOf("project/pay/prd-refund.md")).toBe("prd-refund");
    expect(typeMatches("prd-refund", ["prd"])).toBe(true);
    expect(typeMatches("adr-12", ["prd", "design"])).toBe(false);
    expect(typeMatches("anything", [])).toBe(true);
  });

  it("đếm dòng thêm, xoá và nhận ra thay đổi chỉ về định dạng", () => {
    expect(diffCounts("a\nb\nc", "a\nB\nc\nd")).toEqual({ added: 2, deleted: 1 });
    expect(formattingOnly("Hoàn tiền trong 7 ngày.", "**Hoàn tiền** trong 7 ngày")).toBe(true);
    expect(formattingOnly("Hoàn tiền 7 ngày", "Hoàn tiền 10 ngày")).toBe(false);
  });

  it("yêu cầu R-n và tiêu chí chấp nhận trong khối của nó", () => {
    const reqs = requirementsOf(
      "## Yêu cầu\n- **R-1**: Hoàn tiền\n  - Tiêu chí: duyệt trong 7 ngày\n- R-2. Có phí\n## Ghi chú\nAC: không thuộc R-2\n### R-3 Báo cáo\nGiven đơn hoàn\nThen có báo cáo\n",
    );
    expect(reqs.map((r) => [r.id, r.acceptance.length])).toEqual([
      ["R-1", 1],
      ["R-2", 0],
      ["R-3", 2],
    ]);
  });

  it("điều kiện chạy: loại, từ khoá, ngưỡng dòng, bỏ qua sửa định dạng", () => {
    const ctx = { docType: "prd", content: "Phí hoàn tiền 2%\nmới", base: "Phí hoàn tiền 2%" };
    const cond = (c: Record<string, unknown>) =>
      gate({ conditions: { docTypes: [], keywords: [], minChangedLines: null, skipFormattingOnly: false, ...c } });
    expect(gateApplies(cond({ docTypes: ["adr"] }), ctx).runs).toBe(false);
    expect(gateApplies(cond({ keywords: ["PHÍ"] }), ctx).runs).toBe(true);
    expect(gateApplies(cond({ keywords: ["thuế"] }), ctx)).toMatchObject({
      runs: false,
      reason: "Không nhắc tới thuế.",
    });
    expect(gateApplies(cond({ minChangedLines: 5 }), ctx).runs).toBe(false);
    expect(gateApplies(cond({ skipFormattingOnly: true }), { ...ctx, content: "**Phí** hoàn tiền 2%" }).runs).toBe(
      false,
    );
  });

  it("quy tắc: mục bắt buộc, dữ liệu nhạy cảm, giới hạn số dòng", () => {
    const ctx = { docType: "prd", content: "# PRD\n## Mục tiêu\nghp_0123456789abcdefghijklmnopqrstuvwxyz\n", base: "" };
    const checks = ruleChecklist(
      gate({ rules: ["sections", "no-secrets", "max-diff"], sections: ["Mục tiêu", "Rủi ro"], maxDiffLines: 2 }),
      ctx,
    );
    expect(checks.map((c) => [c.label, c.passed])).toEqual([
      ["Có mục “Mục tiêu”", true],
      ["Có mục “Rủi ro”", false],
      ["Không có dữ liệu nhạy cảm", false],
      ["Thay đổi không quá 2 dòng", false],
    ]);
    expect(checks[2]?.note).toContain("token GitHub");
  });

  it("hạn duyệt và số người cần duyệt", () => {
    const start = new Date("2026-10-12T00:00:00Z");
    const due = new Date("2026-10-13T00:00:00Z");
    expect(slaOf(null, start)).toBe("none");
    expect(slaOf(due, start, Date.parse("2026-10-12T06:00:00Z"))).toBe("on-time");
    expect(slaOf(due, start, Date.parse("2026-10-12T20:00:00Z"))).toBe("due-soon");
    expect(slaOf(due, start, Date.parse("2026-10-13T01:00:00Z"))).toBe("overdue");
    expect(requiredApprovals(gate({ kind: "human", reviewers: { users: ["a", "b"], roles: [], quorum: 0 } }))).toBe(2);
    expect(requiredApprovals(gate({ kind: "human", reviewers: { users: [], roles: ["team-admin"], quorum: 0 } }))).toBe(
      1,
    );
  });
});

// Bộ đọc bản tách là việc của spec 011 T003; khung hiện tại ném lỗi. Các ca cần bộ đọc thật tự bật khi T003 vào.
const parserReady = (() => {
  try {
    parseBreakdown(
      "",
      { parser: "hive-tasks", granularity: "item", requirementId: "R-\\d+", maxTasks: 30, maxChecklist: 20 },
      {
        homeProject: "pay",
        projects: [],
      },
    );
    return true;
  } catch {
    return false;
  }
})();

const sdlcCtx = (content: string, extra: Record<string, unknown> = {}) => ({
  docType: "tasks",
  content,
  base: "",
  ...extra,
});
const breakdownInput = (requirements: string[]): BreakdownRuleInput => ({
  decomposition: {
    parser: "hive-tasks",
    granularity: "item",
    requirementId: "FR-\\d{3}",
    maxTasks: 30,
    maxChecklist: 20,
  },
  context: { homeProject: "pay", projects: [] },
  requirements,
});
const TASKS_MD = [
  "# Tasks",
  "- [ ] T001 Cổng hoàn tiền (FR-001)",
  "  - **Phụ thuộc**: không",
  "- [ ] T002 Màn hoàn tiền (FR-002)",
  "  - **Phụ thuộc**: T001",
  "",
].join("\n");

describe("quy tắc của tài liệu hạng mục AI SDLC", () => {
  it("requirementsOf nhận mẫu mã riêng của chế độ và vẫn dùng R-n khi không đưa mẫu", () => {
    const md =
      "## Yêu cầu\n- **FR-001**: Hoàn tiền\n  - Tiêu chí: 7 ngày\n- FR-002. Có phí\n- R-9: không phải mã của chế độ\n";
    expect(requirementsOf(md, "FR-\\d{3}").map((r) => [r.id, r.acceptance.length])).toEqual([
      ["FR-001", 1],
      ["FR-002", 0],
    ]);
    expect(requirementsOf(md, /FR-\d{3}/).map((r) => r.id)).toEqual(["FR-001", "FR-002"]);
    expect(requirementsOf(md).map((r) => r.id)).toEqual(["R-9"]);
    // Mẫu có nhóm riêng không làm lệch mã và nội dung.
    expect(requirementsOf("- FR-001: Hoàn tiền", "(FR)-\\d{3}")[0]).toMatchObject({ id: "FR-001", text: "Hoàn tiền" });
  });

  it("no-open-questions: dấu [NEEDS CLARIFICATION còn lại và câu hỏi mở của hạng mục", () => {
    const g = gate({ rules: ["no-open-questions"] });
    const clean = ruleChecklist(g, sdlcCtx("# Spec\nĐã rõ.\n", { openQuestions: 0 }));
    expect(clean.map((c) => [c.label, c.passed])).toEqual([
      ["Không còn dấu [NEEDS CLARIFICATION]", true],
      ["Không còn câu hỏi mở của hạng mục", true],
    ]);
    const dirty = ruleChecklist(
      g,
      sdlcCtx("# Spec\n- FR-001 [NEEDS CLARIFICATION: hạn mức?]\nđủ\n- FR-002 [needs clarification: phí?]\n", {
        openQuestions: 2,
      }),
    );
    expect(dirty.map((c) => c.passed)).toEqual([false, false]);
    expect(dirty[0]?.note).toContain("dòng 2, 4");
    expect(dirty[1]?.note).toContain("2 câu hỏi");
    // Tài liệu ngoài hạng mục không có số câu hỏi: chỉ kiểm dấu trong văn bản.
    expect(ruleChecklist(g, sdlcCtx("# Spec\n"))).toHaveLength(1);
  });

  it("breakdown và coverage không đạt khi tài liệu không thuộc hạng mục", () => {
    for (const rule of ["breakdown", "coverage"] as const) {
      const [item] = ruleChecklist(gate({ rules: [rule] }), sdlcCtx(TASKS_MD));
      expect(item).toMatchObject({ passed: false });
      expect(item?.note).toContain("không thuộc hạng mục");
    }
  });

  it.skipIf(!parserReady)("breakdown: bản tách đọc được thì đạt, lỗi thì báo dòng", () => {
    const g = gate({ rules: ["breakdown"] });
    const ok = ruleChecklist(g, sdlcCtx(TASKS_MD, { breakdown: breakdownInput([]) }));
    expect(ok.map((c) => [c.label, c.passed])).toEqual([
      ["Bản tách task đọc được", true],
      ["Có ít nhất một task", true],
    ]);
    const bad = ruleChecklist(
      g,
      sdlcCtx(TASKS_MD.replace("**Phụ thuộc**: T001", "**Phụ thuộc**: T099"), { breakdown: breakdownInput([]) }),
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ label: "Bản tách task đọc được", passed: false });
    expect(bad[0]?.note).toContain("T099");
    const none = ruleChecklist(g, sdlcCtx("# Tasks\nchưa có gì\n", { breakdown: breakdownInput([]) }));
    expect(none[0]?.passed).toBe(false);
  });

  it.skipIf(!parserReady)("coverage: requirement chưa có task thì liệt kê, đủ thì đạt", () => {
    const g = gate({ rules: ["coverage"] });
    const full = ruleChecklist(g, sdlcCtx(TASKS_MD, { breakdown: breakdownInput(["FR-001", "FR-002"]) }));
    expect(full).toEqual([{ label: "Mọi requirement đều có task", passed: true, note: null }]);
    const gap = ruleChecklist(g, sdlcCtx(TASKS_MD, { breakdown: breakdownInput(["FR-001", "FR-002", "FR-003"]) }));
    expect(gap[0]).toMatchObject({ passed: false });
    expect(gap[0]?.note).toContain("FR-003");
    const empty = ruleChecklist(g, sdlcCtx(TASKS_MD, { breakdown: breakdownInput([]) }));
    expect(empty[0]).toMatchObject({ passed: false, note: expect.stringContaining("Không thấy requirement") });
    const unreadable = ruleChecklist(g, sdlcCtx("# Tasks\n", { breakdown: breakdownInput(["FR-001"]) }));
    expect(unreadable[0]?.note).toContain("chưa đọc được");
  });

  it("ears: tiêu chí chấp nhận theo mẫu WHEN … SHALL, câu thường thì báo dòng", () => {
    const g = gate({ rules: ["ears"] });
    const md = [
      "# Requirements",
      "### Requirement 1",
      "**User Story:** As a khách, I want hoàn tiền",
      "#### Acceptance Criteria",
      "1. WHEN khách gửi yêu cầu THEN THE SYSTEM SHALL tạo phiếu hoàn",
      "2. **1.2** IF số tiền vượt hạn mức THEN hệ thống PHẢI chờ duyệt",
      "- KHI phiếu được duyệt, HỆ THỐNG PHẢI gửi thông báo",
      "#### Ghi chú",
      "- hệ thống nên gửi email khi xong",
    ].join("\n");
    expect(ruleChecklist(g, sdlcCtx(md))).toEqual([
      { label: "Tiêu chí chấp nhận viết theo EARS", passed: true, note: null },
    ]);
    const bad = ruleChecklist(
      g,
      sdlcCtx(`${md}\n#### Tiêu chí chấp nhận\n- hệ thống phải gửi email\n- THE SYSTEM hiển thị số dư`),
    );
    expect(bad[0]).toMatchObject({ passed: false, note: expect.stringContaining("Dòng 11, 12") });
    expect(ruleChecklist(g, sdlcCtx("# Requirements\n- WHEN a THE SYSTEM SHALL b\n"))[0]?.note).toContain(
      "Không thấy tiêu chí",
    );
  });
});
