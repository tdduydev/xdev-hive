import type { QaCaseDefinition, QaTestReport } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { type GateCase, qaChecks, qaFingerprint } from "./qa-gate.ts";

const definition: QaCaseDefinition = {
  code: "TC-001",
  title: "Kiểm đăng nhập",
  priority: "P1",
  automation: "automated",
  requirementIds: ["FR-001", "AC-1.1"],
  scriptPath: "tests/login.ts",
  testKey: null,
  required: true,
};
const tc = (over: Partial<GateCase> = {}): GateCase => ({
  definition,
  retired: false,
  waivedBy: null,
  waiverReason: null,
  ...over,
});
const report: QaTestReport = {
  runner: "playwright",
  totals: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
  durationMs: 10,
  cases: [{ code: "TC-001", status: "passed", durationMs: 10, retries: 0 }],
  truncated: false,
};

describe("cổng QA", () => {
  it("chỉ cho qua TC bắt buộc pass từ lần chạy hợp lệ", () => {
    expect(qaChecks([tc()], { report, current: true }).every((c) => c.passed)).toBe(true);
    expect(qaChecks([tc()], { report, current: false }).every((c) => c.passed)).toBe(false);
    expect(qaChecks([tc()], null).every((c) => c.passed)).toBe(false);
    for (const status of ["failed", "skipped", "flaky"] as const)
      expect(
        qaChecks([tc()], { report: { ...report, cases: [{ ...report.cases[0]!, status }] }, current: true })[0]?.passed,
      ).toBe(false);
  });
  it("thiếu, cắt bớt, toàn retired hoặc không có TC bắt buộc đều chặn", () => {
    expect(qaChecks([], null)[0]?.passed).toBe(false);
    expect(qaChecks([tc({ retired: true })], null)[0]?.passed).toBe(false);
    expect(qaChecks([tc({ definition: { ...definition, required: false } })], null)[0]?.passed).toBe(false);
    expect(qaChecks([tc()], { report: { ...report, truncated: true, cases: [] }, current: true })[0]?.passed).toBe(
      false,
    );
  });
  it("miễn từng TC có người và lý do, không ảnh hưởng TC khác", () => {
    expect(qaChecks([tc({ waivedBy: "admin", waiverReason: "Chấp nhận rủi ro" })], null)[0]?.passed).toBe(true);
    expect(qaChecks([tc({ waivedBy: "admin" })], null)[0]?.passed).toBe(false);
  });
  it("fingerprint đổi theo nội dung, không theo thứ tự hay quyết định miễn", () => {
    const a = tc();
    const b = tc({ definition: { ...definition, code: "TC-002" } });
    expect(qaFingerprint([a, b])).toBe(qaFingerprint([b, a]));
    expect(qaFingerprint([a])).toBe(qaFingerprint([tc({ waivedBy: "admin", waiverReason: "Lý do" })]));
    expect(qaFingerprint([a])).not.toBe(
      qaFingerprint([tc({ definition: { ...definition, requirementIds: ["FR-002"] } })]),
    );
    expect(qaFingerprint([a])).not.toBe(qaFingerprint([tc({ revision: 2 })]));
  });
});
