/**
 * Che bí mật trong log triển khai theo từng đoạn (specs/020 FR-019, plan.md mục 7): giá trị biến bí mật của đích cộng
 * bộ mẫu của `secret-scan.ts`. Khác `redactSecrets` (che một chuỗi trọn vẹn) ở chỗ bí mật cắt ngang hai đoạn vẫn bị che,
 * nên phải giữ lại đuôi của đoạn trước tới khi ghép được.
 */
export interface Redactor {
  /** Nhận một đoạn log, trả phần đã che chắc chắn; phần đuôi có thể là đầu của một bí mật thì giữ lại. */
  push(chunk: string): string;
  /** Hết log: trả phần còn giữ, đã che. */
  flush(): string;
}

/** Khung của T009 (specs/020); T009 làm thật, dùng lại `secretSpans`/`SECRET_MASK` của `secret-scan.ts`. */
export function createRedactor(_secrets: readonly string[]): Redactor {
  throw new Error("createRedactor chưa được cài đặt (specs/020 T009).");
}
