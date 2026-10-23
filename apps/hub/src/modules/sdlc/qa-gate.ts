import { createHash } from "node:crypto";
import { type QaCaseDefinition, type QaTestReport, qaCaseDefinition } from "@xdev-hive/contracts";

export type GateCase = {
  definition: QaCaseDefinition;
  revision?: number;
  retired: boolean;
  waivedBy: string | null;
  waiverReason: string | null;
};

export function qaFingerprint(cases: readonly GateCase[]): string {
  const definitions = cases
    .filter((c) => !c.retired)
    .map((c) => ({ ...qaCaseDefinition.parse(c.definition), revision: c.revision ?? 1 }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
}

/** Cả lần chạy mới đang lỗi/đang chạy cũng thay bằng chứng cũ; chỉ pass thuần mới đủ điều kiện. */
export function qaChecks(cases: readonly GateCase[], evidence: { report: QaTestReport; current: boolean } | null) {
  const statusName = { passed: "đạt", failed: "không đạt", skipped: "bỏ qua", flaky: "chập chờn" };
  const required = cases.filter((c) => !c.retired && c.definition.required);
  if (!required.length) return [{ code: "QA", passed: false, note: "Chưa có TC bắt buộc đã duyệt." }];
  return required.map((c) => {
    if (c.waivedBy && c.waiverReason)
      return { code: c.definition.code, passed: true, note: `Đã miễn: ${c.waiverReason}` };
    const status = evidence?.current ? evidence.report.cases.find((r) => r.code === c.definition.code)?.status : null;
    return {
      code: c.definition.code,
      passed: status === "passed",
      note:
        status === "passed"
          ? "Đạt."
          : status
            ? `Kết quả: ${statusName[status]}.`
            : "Thiếu kết quả hợp lệ cho phiên bản TC hiện tại.",
    };
  });
}
