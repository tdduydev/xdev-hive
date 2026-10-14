/**
 * Chữ đi ra chat chỉ là tóm tắt và đường dẫn, không phải code hay bí mật: Telegram/Slack lưu tin ngoài tầm kiểm soát
 * của tổ chức. Thứ tự: bỏ code trước (bí mật nằm trong code cũng mất theo), rồi che mẫu bí mật còn sót, rồi cắt.
 */

const CODE_POINTER = "[đoạn code đã ẩn, xem trên web]";

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Token bot Telegram: <số>:<chuỗi>.
  /\b\d{6,}:[\w-]{30,}\b/g,
  /\bxox[abprso]-[\w-]{8,}/g,
  /\bhwm_[\w-]{8,}/g,
  /\bhive_pat_[\w-]{8,}/g,
  /\bsk-[\w-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[\w]{20,}/g,
  /\bglpat-[\w-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[\w.~+/=-]{16,}/gi,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
  // `password: abc`, `API_KEY=abc`, `"token": "abc"`, `GITHUB_TOKEN=abc` (nên không dùng \b: `_` là ký tự chữ).
  /(?<![A-Za-z])(password|passwd|secret|token|api[_-]?key|private[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, name?: unknown, sep?: unknown) =>
      typeof name === "string" && typeof sep === "string" ? `${name}${sep}***` : "***",
    );
  }
  return out;
}

export function stripCode(text: string): string {
  return (
    text
      // Khối rào ``` (kể cả khối chưa đóng: lấy tới hết chuỗi).
      .replace(/```[\s\S]*?(?:```|$)/g, CODE_POINTER)
      // Diff thô dán nguyên văn.
      .replace(/^diff --git[\s\S]*$/m, CODE_POINTER)
  );
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Độ dài tối đa của phần thân tin chat; đủ để đọc trên điện thoại, còn lại xem trên web. */
export const CHAT_BODY_MAX = 700;
export const CHAT_REPLY_MAX = 1500;

export function forChat(text: string, max = CHAT_BODY_MAX): string {
  const cleaned = redactSecrets(stripCode(text))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clip(cleaned, max);
}
