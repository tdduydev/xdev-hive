import { reviewGate } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
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
