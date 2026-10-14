/**
 * Che chuỗi giống bí mật trong output trước khi lưu bản ghi và gửi tới trình duyệt. Worker đã che bí mật nó biết (token
 * MCP của phiên, token gói); hub che thêm theo mẫu vì agent có thể in token khác (đọc .env, in biến môi trường).
 * Mẫu chỉ có ký tự ASCII nên xử lý chuỗi latin1 giữ nguyên từng byte của UTF-8 quanh chỗ che.
 */
const PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9]{32,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bhive_pat_[A-Za-z0-9_-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

export const MASK = "***";

export function maskSecrets(data: Buffer, known: readonly string[] = []): Buffer {
  let text = data.toString("latin1");
  let changed = false;
  for (const secret of known) {
    if (secret.length < 8) continue;
    const raw = Buffer.from(secret, "utf8").toString("latin1");
    if (text.includes(raw)) {
      text = text.split(raw).join(MASK);
      changed = true;
    }
  }
  for (const pattern of PATTERNS) {
    const next = text.replace(pattern, MASK);
    if (next !== text) {
      text = next;
      changed = true;
    }
  }
  return changed ? Buffer.from(text, "latin1") : data;
}
