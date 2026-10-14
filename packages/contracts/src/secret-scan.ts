import { z } from "zod";

/**
 * Bộ quét bí mật dùng chung cho artifact (specs/012 D12, C11): hub chạy khi lưu phiên bản, khi xem trước và khi tạo link
 * công khai; mẫu khớp `worker/internal/runner/checks.go` qua fixture chung `fixtures/secret-scan.json`. Chỉ trả dòng và
 * loại, không bao giờ trả chuỗi bí mật, để lỗi trả về client hay ghi audit không làm lộ chính bí mật đó.
 */
export const SECRET_KINDS = [
  "private_key",
  "github_token",
  "gitlab_token",
  "aws_access_key",
  "slack_token",
  "anthropic_key",
  "openai_key",
  "hive_pat",
  "jwt",
  "credential_assignment",
] as const;
export const secretKind = z.enum(SECRET_KINDS);
export type SecretKind = z.output<typeof secretKind>;

/** Tên loại hiện trong thông báo "Có chuỗi giống bí mật ở dòng 12 (GitHub token)." */
export const SECRET_KIND_LABELS: Record<SecretKind, string> = {
  private_key: "khoá riêng PEM",
  github_token: "GitHub token",
  gitlab_token: "GitLab token",
  aws_access_key: "AWS access key",
  slack_token: "Slack token",
  anthropic_key: "Anthropic API key",
  openai_key: "OpenAI API key",
  hive_pat: "Hive token",
  jwt: "JWT",
  credential_assignment: "mật khẩu hoặc token",
};

export const secretFinding = z.object({
  /** Dòng đầu tiên của chuỗi bị nghi, đếm từ 1. */
  line: z.int().min(1),
  kind: secretKind,
});
export type SecretFinding = z.output<typeof secretFinding>;

interface TokenPattern {
  kind: SecretKind;
  re: RegExp;
  accept?: (token: string) => boolean;
}

// Mẫu có dạng đặc trưng xét trước mẫu gán giá trị: `GITHUB_TOKEN=ghp_…` chỉ báo một lần với loại cụ thể. Độ dài tối thiểu
// chặt hơn `checks.go` (worker chỉ che log nên được phép bắt thừa; ở đây bắt thừa là chặn lưu của người dùng).
const TOKEN_PATTERNS: TokenPattern[] = [
  { kind: "private_key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  // Khoá OpenAI là chuỗi ngẫu nhiên nên luôn có chữ số; tên kebab-case bắt đầu bằng `sk-` thì không.
  { kind: "openai_key", re: /\bsk-(?!ant-)[A-Za-z0-9_-]{32,}/g, accept: (t) => /\d/.test(t) },
  { kind: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: "gitlab_token", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "hive_pat", re: /\bhive_pat_[A-Za-z0-9_-]{20,}/g },
  // Phần thân JWT cũng là JSON nên bắt đầu bằng `eyJ`; JWT không chữ ký (`alg: none`) không mở được gì nên bỏ qua.
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g },
];

// Tên phải kết thúc ở từ khoá (cho phép đuôi `key`, `secretKey`) để `tokenizer`, `max_tokens`, `passwordPolicy` không bị
// coi là bí mật. `==`, `===`, `=>` là so sánh hay hàm, không phải gán.
const ASSIGNMENT =
  /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]*?(?:token|secret|passw(?:or)?d|api[_-]?key|credentials?|private[_-]?key|access[_-]?key)(?:[_-]?key)?["']?[ \t]*(:=|[:=](?![=>]))[ \t]*(?:"([^"\s]*)"|'([^'\s]*)'|`([^`\s]*)`|([^\s"'`,;(){}[\]<>]+))/gi;

const MIN_VALUE = 8;
const PLACEHOLDER =
  /^(?:\$|%|\{\{|<)|process\.env|os\.environ|getenv|your|example|placeholder|changeme|change_me|redacted|xxxx|\*\*\*\*|\.\.\./i;
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** Giá trị gán có giống bí mật thật không, hay chỉ là tham chiếu biến, chỗ trống, số, URL. */
function secretValue(value: string, quoted: boolean, wholeLine: boolean, op: string): boolean {
  if (value.length < MIN_VALUE || PLACEHOLDER.test(value) || /^(.)\1*$/.test(value)) return false;
  if (/^\d+$/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (quoted || !IDENTIFIER.test(value)) return true;
  // Giá trị trần dạng tên biến (`password = newPassword`) là code. Chỉ tính khi cả dòng là cấu hình: `.env`/shell viết
  // `KEY=value` không dấu cách, còn YAML `password: hunter2abc` thì giá trị có chữ số mới giống mật khẩu hơn tên biến.
  return wholeLine && (op === "=" || /\d/.test(value));
}

/** Phát hiện theo thứ tự dòng; rỗng là không có gì giống bí mật. */
export function scanSecrets(text: string): SecretFinding[] {
  const hits: { index: number; kind: SecretKind }[] = [];
  const taken: [number, number][] = [];
  const overlaps = (start: number, end: number) => taken.some(([s, e]) => start < e && s < end);

  for (const { kind, re, accept } of TOKEN_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const end = m.index + m[0].length;
      if ((accept && !accept(m[0])) || overlaps(m.index, end)) continue;
      taken.push([m.index, end]);
      hits.push({ index: m.index, kind });
    }
  }

  for (const m of text.matchAll(ASSIGNMENT)) {
    const op = m[1] ?? "";
    const quotedValue = m[2] ?? m[3] ?? m[4];
    const value = quotedValue ?? m[5] ?? "";
    const end = m.index + m[0].length;
    const valueStart = end - value.length - (quotedValue === undefined ? 0 : 2);
    if (overlaps(valueStart, end)) continue;
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const lineEnd = text.indexOf("\n", end);
    const wholeLine =
      /^[ \t]*(?:export[ \t]+|-[ \t]+)?["']?$/.test(text.slice(lineStart, m.index)) &&
      /^[ \t\r]*$/.test(text.slice(end, lineEnd === -1 ? undefined : lineEnd));
    if (!secretValue(value, quotedValue !== undefined, wholeLine, op)) continue;
    taken.push([valueStart, end]);
    hits.push({ index: m.index, kind: "credential_assignment" });
  }

  hits.sort((a, b) => a.index - b.index);
  const lineOf = lineCounter(text);
  const seen = new Set<string>();
  const findings: SecretFinding[] = [];
  for (const { index, kind } of hits) {
    const line = lineOf(index);
    const key = `${line}:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ line, kind });
  }
  return findings;
}

/** Đổi vị trí ký tự sang số dòng; vị trí gọi theo thứ tự tăng nên chỉ quét văn bản một lần. */
function lineCounter(text: string): (index: number) => number {
  let line = 1;
  let at = 0;
  return (index) => {
    for (let nl = text.indexOf("\n", at); nl !== -1 && nl < index; nl = text.indexOf("\n", nl + 1)) {
      line++;
      at = nl + 1;
    }
    return line;
  };
}
