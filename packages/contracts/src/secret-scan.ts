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

/** Phát hiện theo thứ tự dòng; rỗng là không có gì giống bí mật. */
export function scanSecrets(_text: string): SecretFinding[] {
  throw new Error("scanSecrets chưa có thân (specs/012 T002).");
}
