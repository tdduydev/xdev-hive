import { ORPCError } from "@orpc/client";
import { docSecretErrorData, SECRET_KIND_LABELS } from "@xdev-hive/contracts";
import { errorText } from "@/lib/tauri.ts";

/** Mã lỗi nghiệp vụ của hub (`data.code`), nếu có. */
export function hubErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ORPCError)) return undefined;
  const data: unknown = error.data;
  return typeof data === "object" && data !== null && "code" in data && typeof data.code === "string"
    ? data.code
    : undefined;
}

/** Dấu hiệu bí mật hub tìm thấy khi lưu (DOC_SECRET_FOUND), để màn hỏi người dùng xác nhận. */
export function secretFindings(error: unknown) {
  const parsed = error instanceof ORPCError ? docSecretErrorData.safeParse(error.data) : null;
  return parsed?.success ? parsed.data.findings : null;
}

/** Câu báo lỗi cho người dùng: hub trả sẵn tiếng Việt trong `message`; lỗi Rust là chuỗi. */
export function hubErrorText(error: unknown): string {
  const findings = secretFindings(error);
  if (findings) {
    return `Có dấu hiệu bí mật: ${findings.map((f) => `${SECRET_KIND_LABELS[f.kind]}, dòng ${f.line}`).join("; ")}.`;
  }
  return errorText(error);
}
