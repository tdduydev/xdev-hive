import type {
  CiRunStatus,
  CiSource,
  DeployMethod,
  DeployOrigin,
  DeployState,
  DeployStepState,
  RollbackInfo,
} from "@xdev-hive/contracts";
import type { Tone } from "@/lib/run-view.ts";

/*
 * Nhãn tiếng Việt của CI/CD và triển khai (specs/020). Có đủ một lần ở đây; trang của các task sau chỉ đọc. Mã trạng
 * thái trong DB và hợp đồng là tiếng Anh, giao diện dịch ở đây.
 */

export const DEPLOY_STATE_LABEL: Record<DeployState, string> = {
  pending_approval: "Chờ duyệt",
  queued: "Đang chờ chạy",
  running: "Đang triển khai",
  succeeded: "Thành công",
  failed: "Lỗi",
  failed_needs_review: "Lỗi, cần người xem",
  unknown: "Chưa rõ kết quả",
  canceled: "Đã huỷ",
  rejected: "Bị từ chối",
  expired: "Hết hạn duyệt",
};

export const DEPLOY_STATE_TONE: Record<DeployState, Tone> = {
  pending_approval: "warn",
  queued: "neutral",
  running: "sel",
  succeeded: "ok",
  failed: "bad",
  failed_needs_review: "bad",
  unknown: "warn",
  canceled: "neutral",
  rejected: "bad",
  expired: "neutral",
};

/** Lần đang đi: còn huỷ được và còn chặn lần triển khai khác lên cùng đích (FR-015). */
export function isDeployActive(state: DeployState): boolean {
  return state === "pending_approval" || state === "queued" || state === "running";
}

export const DEPLOY_STEP_STATE_LABEL: Record<DeployStepState, string> = {
  pending: "Chưa chạy",
  running: "Đang chạy",
  succeeded: "Xong",
  failed: "Lỗi",
  skipped: "Bỏ qua",
  canceled: "Đã huỷ",
};

export const DEPLOY_STEP_STATE_TONE: Record<DeployStepState, Tone> = {
  pending: "neutral",
  running: "sel",
  succeeded: "ok",
  failed: "bad",
  skipped: "neutral",
  canceled: "neutral",
};

const DEPLOY_STEP_LABEL: Record<string, string> = {
  precheck: "Kiểm trước khi chạy",
  backup: "Sao lưu",
  upload: "Tải mã lên máy chủ",
  deploy: "Triển khai",
  health: "Kiểm sức khoẻ",
  build: "Build trên Jenkins",
  sync: "Đồng bộ Argo CD",
  rollout: "Chờ rollout",
  approval: "Duyệt",
};

/** Bước của cách triển khai mới mà bảng này chưa biết thì hiện nguyên khoá, không làm vỡ màn. */
export function deployStepLabel(key: string): string {
  return DEPLOY_STEP_LABEL[key] ?? key;
}

export const DEPLOY_METHOD_LABEL: Record<DeployMethod, string> = {
  "ssh-script": "Chạy lệnh qua SSH",
  "jenkins-job": "Job Jenkins",
  "gitlab-manual": "Job tay trên GitLab",
  argocd: "Argo CD",
  kubectl: "Kubernetes (kubectl)",
};

export const DEPLOY_ORIGIN_LABEL: Record<DeployOrigin, string> = {
  hive: "Từ Hive",
  external: "Ngoài Hive",
};

export const CI_SOURCE_LABEL: Record<CiSource, string> = {
  gitlab: "GitLab",
  github: "GitHub",
  jenkins: "Jenkins",
};

export const CI_STATUS_LABEL: Record<CiRunStatus, string> = {
  queued: "Đang chờ",
  running: "Đang chạy",
  waiting: "Chờ người",
  success: "Thành công",
  failed: "Lỗi",
  unstable: "Không ổn định",
  canceled: "Đã huỷ",
  skipped: "Bỏ qua",
};

export const CI_STATUS_TONE: Record<CiRunStatus, Tone> = {
  queued: "neutral",
  running: "sel",
  waiting: "warn",
  success: "ok",
  failed: "bad",
  unstable: "warn",
  canceled: "neutral",
  skipped: "neutral",
};

/** Lý do nút "Quay về bản trước" tắt (US7 scenario 2). */
export const ROLLBACK_BLOCKED_LABEL: Record<NonNullable<RollbackInfo["reason"]>, string> = {
  no_previous_success: "Đích này chưa có bản thành công trước đó để quay về.",
  promote_without_rollback_job: "Đích này đẩy từ môi trường khác và chưa khai job quay về.",
  env_locked: "Môi trường đang khoá.",
  in_progress: "Đích này đang có một lần triển khai chưa xong.",
};

/**
 * Nhãn ngắn cho mã lỗi nghiệp vụ của hợp đồng (`DELIVERY_ERRORS`), dùng làm tiêu đề thẻ hay huy hiệu. Câu đầy đủ do
 * hub trả; `apiErrorMessage` đã dùng nguyên văn câu đó.
 */
export const DELIVERY_ERROR_LABEL: Record<string, string> = {
  JENKINS_NO_TOKEN: "Chưa có token Jenkins",
  JENKINS_UNAUTHORIZED: "Jenkins không nhận token",
  JENKINS_FORBIDDEN: "Không đủ quyền trên Jenkins",
  JENKINS_NOT_FOUND: "Không thấy job hoặc build",
  JENKINS_UNAVAILABLE: "Jenkins không trả lời",
  SSH_UNREACHABLE: "Không kết nối được máy chủ",
  SSH_AUTH_FAILED: "Máy chủ không nhận khoá SSH",
  SSH_HOSTKEY_CHANGED: "Host key đã đổi",
  DEPLOY_IN_PROGRESS: "Đang có lần triển khai",
  ENV_LOCKED: "Môi trường đang khoá",
  SELF_APPROVAL: "Không tự duyệt được",
  APPROVAL_EXPIRED: "Yêu cầu duyệt đã hết hạn",
  TARGET_VERSION_CONFLICT: "Cấu hình đã bị sửa",
  ROLLBACK_UNAVAILABLE: "Không quay về được",
};

export function deliveryErrorLabel(code: string | undefined): string | undefined {
  return code === undefined ? undefined : DELIVERY_ERROR_LABEL[code];
}

/** Nhãn trạng thái của một nguồn CI trong danh sách gộp (`ciFeedSource.state`). */
export const CI_FEED_STATE_LABEL = {
  ok: "Đọc được",
  stale: "Dữ liệu cũ",
  no_token: "Chưa có token để đọc Jenkins",
  error: "Không đọc được",
} as const;
