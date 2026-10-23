import { describe, expect, it } from "vitest";
import { parseTestCaseTable, qaTestReport } from "./qa.ts";
import { SDLC_PRESETS } from "./sdlc-presets/index.ts";

const table = (row = "TC-001 | Đăng nhập hợp lệ | P1 | automated | FR-001, AC-1.1 | tests/login.spec.ts | true") =>
  `| Mã | Tiêu đề | Ưu tiên | Loại | Yêu cầu | Script | Bắt buộc |\n|---|---|---|---|---|---|---|\n| ${row} |`;
const report = () => ({
  runner: "playwright",
  totals: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
  durationMs: 100,
  cases: [{ code: "TC-001", status: "passed", retries: 0, durationMs: 100 }],
  truncated: false,
});

describe("metadata QA", () => {
  it("đọc bảng TC và gắn FR/AC; mặc định bắt buộc", () => {
    const parsed = parseTestCaseTable(table());
    expect(parsed.ok).toBe(true);
    expect(parsed.cases[0]).toMatchObject({ code: "TC-001", requirementIds: ["FR-001", "AC-1.1"], required: true });
    expect(parseTestCaseTable(table().replace("| true |", "| false |")).cases[0]?.required).toBe(false);
    expect(parseTestCaseTable(table().replace("| true |", "| |")).cases[0]?.required).toBe(true);
  });
  it.each([
    table().replace("FR-001, AC-1.1", "không rõ"),
    table().replace("tests/login.spec.ts", "../secret"),
    table().replace("tests/login.spec.ts", ""),
    table().replace("true", "tuỳ ý"),
    `${table()}\n| TC-001 | Mã trùng | P2 | manual | FR-001 | | true |`,
    "```md\n" + table() + "\n```",
  ])("từ chối bảng sai mà không đồng bộ một phần", (md) => {
    expect(parseTestCaseTable(md).ok).toBe(false);
  });
  it("nhận bảng của preset và bật cả hai luật QA", () => {
    const mode = SDLC_PRESETS["qa-automation"];
    const cases = mode.phases.find((p) => p.id === "cases")?.artifacts[0];
    expect(parseTestCaseTable(cases?.template ?? "").ok).toBe(true);
    expect(mode.phases.find((p) => p.id === "verify")?.gate[0]?.gates[0]?.rules).toContain("qa-tests");
  });
  it("chấp nhận metadata thuần, loại log, code và trường tự do cả ở dòng con", () => {
    expect(qaTestReport.safeParse(report()).success).toBe(true);
    for (const field of ["log", "code", "url", "message", "environment", "attachments"])
      expect(qaTestReport.safeParse({ ...report(), [field]: "secret" }).success, field).toBe(false);
    expect(qaTestReport.safeParse({ ...report(), cases: [{ ...report().cases[0], message: "secret" }] }).success).toBe(
      false,
    );
  });
  it("từ chối tổng sai, mã trùng, thời gian âm và commit tuỳ ý", () => {
    expect(qaTestReport.safeParse({ ...report(), totals: { ...report().totals, total: 2 } }).success).toBe(false);
    expect(qaTestReport.safeParse({ ...report(), cases: [...report().cases, ...report().cases] }).success).toBe(false);
    expect(qaTestReport.safeParse({ ...report(), durationMs: -1 }).success).toBe(false);
    expect(qaTestReport.safeParse({ ...report(), commit: "https://private" }).success).toBe(false);
  });
});
