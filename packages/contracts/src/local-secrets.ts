/**
 * Tên bí mật tại máy (specs/031-local-secrets FR-003, FR-004). Hub không bao giờ nhận tên hay giá trị bí mật; module này
 * chỉ để web và hub dùng chung quy tắc tên với worker Go (fixtures/local-secrets.json), vd. khi hiển thị danh sách tên
 * dành riêng hoặc kiểm tên trong tài liệu hướng dẫn.
 */

export const SECRET_NAME_MAX_LENGTH = 64;

/** Biến môi trường mà bí mật không được ghi đè: chiếm quyền môi trường của agent hay của CLI. */
export const RESERVED_SECRET_NAMES = {
  exact: [
    "PATH",
    "HOME",
    "USER",
    "USERNAME",
    "USERPROFILE",
    "SHELL",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "PATHEXT",
    "NODE_OPTIONS",
  ],
  prefixes: ["HIVE_", "LD_", "DYLD_", "GIT_", "SSH_", "ANTHROPIC_", "OPENAI_", "CLAUDE_", "CODEX_", "GEMINI_"],
} as const;

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Windows không phân biệt hoa thường ở tên biến, nên tên được chuẩn hoá in hoa trước khi kiểm và lưu. */
export function normalizeSecretName(name: string): string {
  return name.trim().toUpperCase();
}

/** Kiểm cú pháp của tên đã chuẩn hoá; không kiểm tên dành riêng (xem `isReservedSecretName`). */
export function isValidSecretName(name: string): boolean {
  return name.length <= SECRET_NAME_MAX_LENGTH && SECRET_NAME.test(name);
}

export function isReservedSecretName(name: string): boolean {
  const n = normalizeSecretName(name);
  return (
    (RESERVED_SECRET_NAMES.exact as readonly string[]).includes(n) ||
    RESERVED_SECRET_NAMES.prefixes.some((prefix) => n.startsWith(prefix))
  );
}
