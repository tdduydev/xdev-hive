import type { DeployMethod as DeployMethodName, DeployStep, DeployVersion, TargetConfig } from "@xdev-hive/contracts";
import type { Tx } from "../../platform/index.ts";
import type { DeliveryDeps } from "../deps.ts";
import type { HealthResult } from "./health.ts";

/** Một lần triển khai như cách triển khai thấy: đủ để bắt đầu, đọc tiếp sau khi hub khởi động lại, huỷ. */
export interface DeployRun {
  orgId: string;
  deployId: string;
  targetId: string;
  config: TargetConfig;
  version: DeployVersion;
  /** Người bấm; thao tác trên Jenkins/GitLab mang tên người này. Null với lần do hệ thống tạo. */
  requestedBy: string | null;
  /** Trạng thái phía máy chủ đã lưu (`deploys.remote`), vd. thư mục, PID, vị trí log của ssh-script. */
  remote: Record<string, unknown> | null;
  /** Build/job/application ngoài đã lưu (`deploys.external`). */
  external: Record<string, unknown> | null;
  signal: AbortSignal;
}

export interface DeployMethodContext {
  /** Transaction của tổ chức, để đọc secret và ghi audit. Không giữ qua lời gọi mạng dài. */
  tx: Tx;
  deps: DeliveryDeps;
}

export interface DeployStarted {
  steps: DeployStep[];
  remote?: Record<string, unknown> | undefined;
  external?: Record<string, unknown> | undefined;
}

export interface DeployProgress {
  /** `failed_needs_review`: các bước xong nhưng health không đạt (FR-018). `canceled`: phía máy chủ đã dừng vì huỷ. */
  state: "running" | "succeeded" | "failed" | "failed_needs_review" | "canceled" | "unknown";
  steps: DeployStep[];
  remote?: Record<string, unknown> | undefined;
  external?: Record<string, unknown> | undefined;
  /** Log mới đọc được từ lần trước, chưa che bí mật. */
  log?: string | undefined;
  /** Kết quả health khi cách triển khai tự gọi health sau các bước (ssh-script). */
  health?: HealthResult | undefined;
}

/**
 * Một cách triển khai (ssh-script, jenkins-job, …). Orchestrator chỉ gọi qua giao diện này nên máy trạng thái, khoá đích
 * và duyệt dùng chung cho mọi cách.
 */
export interface DeployMethod {
  readonly method: DeployMethodName;
  start(ctx: DeployMethodContext, run: DeployRun): Promise<DeployStarted>;
  /** Đọc tiến độ từ vị trí đã lưu; gọi lặp tới khi trạng thái không còn `running`. */
  poll(ctx: DeployMethodContext, run: DeployRun): Promise<DeployProgress>;
  cancel(ctx: DeployMethodContext, run: DeployRun): Promise<void>;
  /** Phiên bản đang chạy ở đích, null khi không đọc được. */
  version(ctx: DeployMethodContext, target: { targetId: string; config: TargetConfig }): Promise<DeployVersion | null>;
  /** Cách nào quay về được bằng cơ chế riêng (Argo CD history, rollout undo) thì cài; còn lại triển khai lại bản cũ. */
  rollback?(ctx: DeployMethodContext, run: DeployRun, to: DeployVersion): Promise<DeployStarted>;
}

/** Cách triển khai chưa được làm. Lớp API đổi `code` thành lỗi cho người dùng. */
export class DeployMethodNotImplementedError extends Error {
  override readonly name = "DeployMethodNotImplementedError";
  readonly code = "NOT_IMPLEMENTED";

  readonly method: DeployMethodName;

  constructor(method: DeployMethodName) {
    super(`Cách triển khai ${method} chưa được làm.`);
    this.method = method;
  }
}

/** Cài tạm cho cách chưa làm: mọi thao tác báo NOT_IMPLEMENTED thay vì chạy dở. */
export function notImplementedMethod(method: DeployMethodName): DeployMethod {
  const fail = async (): Promise<never> => {
    throw new DeployMethodNotImplementedError(method);
  };
  return { method, start: fail, poll: fail, cancel: fail, version: fail };
}
