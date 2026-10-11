import type { ProvisionStepKind } from "@xdev-hive/contracts";
import { type GitProviderKind, isGitProviderError } from "../scm/index.ts";
import type { StepError } from "./schema.ts";

/** Nhánh đưa file mẫu vào repo có sẵn qua PR, không commit thẳng vào nhánh chính. */
export const TEMPLATE_BRANCH = "hive/khoi-tao";

export interface PlanInput {
  mode: "new" | "existing";
  scmKind: GitProviderKind;
  owner: string;
  name: string;
  /** null khi repo có sẵn và chưa đọc được nhánh chính từ provider. */
  defaultBranch: string | null;
  visibility: "private" | "internal" | "public" | null;
  description?: string | undefined;
  protection: { protectDefault: boolean; requiredApprovals: number };
  webhook: boolean;
  webhookUrl: string;
  templateFileCount: number;
}

export interface PlannedStep {
  kind: ProvisionStepKind;
  target: string | null;
  title: string;
  params: Record<string, unknown>;
}

/** Danh sách bước của saga khởi tạo, theo thứ tự chạy. Dùng chung cho dryRun và lúc tạo thật. */
export function planSteps(p: PlanInput): PlannedStep[] {
  const repo = `${p.owner}/${p.name}`;
  const branch = p.defaultBranch ?? "nhánh chính";
  const steps: PlannedStep[] = [];
  if (p.mode === "new") {
    steps.push({ kind: "check-access", target: null, title: `Kiểm quyền của kết nối trên ${p.owner}`, params: {} });
    steps.push({
      kind: "create-repo",
      target: null,
      title: `Tạo repo ${repo} (${p.visibility ?? "private"})`,
      params: { visibility: p.visibility, defaultBranch: p.defaultBranch, description: p.description ?? null },
    });
    steps.push({
      kind: "commit-template",
      target: null,
      title: `Commit ${p.templateFileCount} file mẫu vào ${branch}`,
      params: {},
    });
  } else {
    steps.push({ kind: "link-repo", target: null, title: `Đọc repo có sẵn ${repo}`, params: {} });
    steps.push({
      kind: "commit-template",
      target: null,
      title: `Mở PR ${TEMPLATE_BRANCH} với ${p.templateFileCount} file mẫu`,
      params: { branch: TEMPLATE_BRANCH },
    });
  }
  if (p.protection.protectDefault) {
    const approvals = p.protection.requiredApprovals;
    steps.push({
      kind: "protect-branch",
      target: null,
      title: `Bảo vệ ${branch}: ${approvals > 0 ? `cần ${approvals} người duyệt` : "chỉ qua PR"}, cấm force push`,
      params: { requiredApprovals: approvals },
    });
  }
  if (p.webhook) {
    steps.push({
      kind: "add-webhook",
      target: null,
      title: `Thêm webhook về ${p.webhookUrl}`,
      params: { url: p.webhookUrl },
    });
  }
  return steps;
}

/** Lỗi nghiệp vụ của một bước (không phải lỗi gọi API), ví dụ kết nối không có quyền tạo repo. */
export class StepFailure extends Error {
  override readonly name = "StepFailure";
  readonly code: string;
  readonly fix: string | null;

  constructor(code: string, message: string, fix: string | null) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

const RETRY = "Sửa xong, bấm “Thử lại bước này”.";

function appSettings(kind: GitProviderKind, owner: string): string {
  return kind === "github"
    ? `Chủ sở hữu tổ chức ${owner} mở Settings → GitHub Apps → Configure ở app của Hive`
    : `Người quản trị group ${owner} trên GitLab kiểm lại token của kết nối`;
}

function forbiddenFix(step: ProvisionStepKind, kind: GitProviderKind, owner: string): string {
  if (kind === "github") {
    const perm: Partial<Record<ProvisionStepKind, string>> = {
      "create-repo": "Administration (ghi)",
      "protect-branch": "Administration (ghi)",
      "add-webhook": "Webhooks (ghi)",
      "commit-template": "Contents và Pull requests (ghi)",
      "link-repo": "Metadata (đọc) và thêm repo này vào danh sách repo của app",
    };
    return `${appSettings(kind, owner)}, cấp quyền ${perm[step] ?? "còn thiếu"} rồi chấp nhận yêu cầu quyền mới. ${RETRY}`;
  }
  const role = step === "commit-template" || step === "link-repo" ? "Developer" : "Maintainer";
  return `Token GitLab cần scope api và vai trò ${role} trở lên trong ${owner}. Cập nhật token trong Kết nối Git. ${RETRY}`;
}

/** Đổi lỗi của một bước thành thông báo tiếng Việt kèm cách sửa, lưu vào project_provision_steps.error. */
export function describeFailure(step: ProvisionStepKind, kind: GitProviderKind, owner: string, e: unknown): StepError {
  if (e instanceof StepFailure) return { code: e.code, message: e.message, fix: e.fix };
  if (isGitProviderError(e)) {
    const message = e.message;
    switch (e.code) {
      case "unauthorized":
        return {
          code: "SCM_UNAUTHORIZED",
          message,
          fix: `Kết nối Git không còn dùng được (token hết hạn, bị thu hồi hoặc app đã bị gỡ). Cập nhật kết nối trong Quản trị → Kết nối Git. ${RETRY}`,
        };
      case "forbidden":
        return { code: "SCM_FORBIDDEN", message, fix: forbiddenFix(step, kind, owner) };
      case "not_found":
        return {
          code: "SCM_NOT_FOUND",
          message,
          fix:
            step === "link-repo"
              ? `Kiểm lại URL repo và cho kết nối quyền đọc repo đó. ${RETRY}`
              : `Repo hoặc nhánh không còn trên ${kind === "github" ? "GitHub" : "GitLab"}, hoặc kết nối mất quyền thấy nó. ${RETRY}`,
        };
      case "conflict":
        return {
          code: "SCM_CONFLICT",
          message,
          fix:
            step === "create-repo"
              ? "Đã có repo trùng tên không do Hive tạo. Đổi tên hoặc xoá repo đó trên nhà cung cấp, hoặc tạo dự án với chế độ repo có sẵn."
              : `Dữ liệu trên nhà cung cấp vừa đổi giữa chừng. ${RETRY}`,
        };
      case "rate_limited":
      case "unavailable":
        return {
          code: "SCM_UNAVAILABLE",
          message,
          fix: "Lỗi tạm thời của nhà cung cấp. Đợi vài phút rồi bấm “Thử lại bước này”.",
        };
      case "invalid":
        return {
          code: "SCM_INVALID",
          message,
          fix: "Nhà cung cấp từ chối yêu cầu. Kiểm lại tên repo, nhánh và cài đặt của tổ chức trên nhà cung cấp.",
        };
    }
  }
  return {
    code: "INTERNAL",
    message: e instanceof Error ? e.message : String(e),
    fix: "Lỗi trong hub. Báo người quản trị hub kèm thời điểm lỗi; bấm “Thử lại bước này” sau khi đã xử lý.",
  };
}
