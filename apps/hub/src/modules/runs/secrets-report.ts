import { reportSecretsInjected } from "@xdev-hive/contracts/worker-protocol";

/**
 * Hub chỉ cần biết run dùng bao nhiêu bí mật tại máy (specs/031). Báo cáo của worker là bản ghi tự do và hub lưu
 * nguyên văn, nên bỏ mọi khoá nhắc tới "secret" ngoài số lượng hợp lệ: worker lỗi hay độc hại có gửi tên hay giá trị
 * bí mật cũng không vào được cơ sở dữ liệu, sự kiện SSE hay kết quả run.
 */
export function sanitizeSecretsReport(report: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!report) return report;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(report)) {
    if (key === "secretsInjected") continue;
    if (!/secret/i.test(key)) out[key] = value;
  }
  const count = reportSecretsInjected.safeParse(report.secretsInjected);
  if (count.success) out.secretsInjected = count.data;
  return out;
}

/** Số bí mật đã đưa vào agent, đọc từ báo cáo đã lưu; undefined khi worker cũ không báo hay số không hợp lệ. */
export function secretsInjectedOf(report: Record<string, unknown> | null | undefined): number | undefined {
  const count = reportSecretsInjected.safeParse(report?.secretsInjected);
  return count.success ? count.data : undefined;
}
