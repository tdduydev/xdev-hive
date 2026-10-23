import type { DeliveryMethod } from "@xdev-hive/contracts";

// Chọn "máy chạy deploy" (specs/032 FR-013). Hàm thuần để logic thứ tự, nhãn, khả năng dễ test mà không cần Docker.
// Một máy có thể đăng ký với nhiều tổ chức (FR-104), nên mỗi ứng viên mang `orgId` của đăng ký và chỉ ứng viên thuộc
// đúng tổ chức của lần triển khai mới được xét (FR-105).

/** Nhãn admin gắn cho máy được phép chạy môi trường đòi nhãn (FR-012). */
export const DEPLOY_RUNNER_LABEL = "deploy-runner";

export type RunnerCandidate = {
  machineId: string;
  /** Tổ chức của đăng ký mà máy này đang báo khả năng. */
  orgId: string;
  online: boolean;
  labels: readonly string[];
  /** Khả năng đã báo ở hello/heartbeat của đăng ký này. */
  methods: readonly DeliveryMethod[];
  /** Tên (không phải giá trị) credential delivery đang có trong kho của đăng ký này. */
  credentials: readonly string[];
};

export type RunnerNeeds = {
  orgId: string;
  method: DeliveryMethod;
  /** Tham chiếu credential của đích; null nếu cách chạy không cần. */
  credential: string | null;
  requireLabel: boolean;
};

export type RunnerWaitReason = "no_machines" | "offline" | "no_capability" | "no_label" | "missing_credential";

export type RunnerSelection =
  | { ok: true; machineId: string }
  | { ok: false; reason: RunnerWaitReason; message: string };

const MESSAGES: Record<RunnerWaitReason, string> = {
  no_machines: "Môi trường chưa có máy chạy deploy. Thêm máy ở cấu hình môi trường.",
  offline: "Không có máy chạy deploy nào đang trực tuyến.",
  no_capability:
    "Máy chạy deploy trực tuyến chưa hỗ trợ cách triển khai này. Cập nhật worker hoặc đổi cách triển khai.",
  no_label: "Môi trường đòi nhãn runner triển khai nhưng máy trực tuyến chưa được gắn nhãn đó.",
  missing_credential: "Máy chạy deploy trực tuyến chưa có credential cần cho đích này. Thêm credential trên máy đó.",
};

// Thứ tự lọc quyết định lý do hiển thị: lý do là bước lọc xa nhất mà còn ít nhất một máy vượt qua.
const STAGES = ["offline", "no_capability", "no_label", "missing_credential"] as const;

/**
 * Trả máy đầu tiên trong `machines` (thứ tự admin đặt) thoả đủ: cùng tổ chức, trực tuyến, có khả năng, có nhãn nếu đòi,
 * có đủ credential. Không có máy nào thì trả lý do chờ để ghi vào lần triển khai (FR-013).
 */
export function selectRunner(
  candidates: readonly RunnerCandidate[],
  machines: readonly string[],
  needs: RunnerNeeds,
): RunnerSelection {
  const byId = new Map<string, RunnerCandidate>();
  for (const c of candidates) {
    if (c.orgId === needs.orgId) byId.set(c.machineId, c);
  }
  let pool = machines.flatMap((id) => {
    const c = byId.get(id);
    return c ? [c] : [];
  });
  if (pool.length === 0) return { ok: false, reason: "no_machines", message: MESSAGES.no_machines };

  const checks: Record<(typeof STAGES)[number], (c: RunnerCandidate) => boolean> = {
    offline: (c) => c.online,
    no_capability: (c) => c.methods.includes(needs.method),
    no_label: (c) => !needs.requireLabel || c.labels.includes(DEPLOY_RUNNER_LABEL),
    missing_credential: (c) => needs.credential === null || c.credentials.includes(needs.credential),
  };
  for (const stage of STAGES) {
    const next = pool.filter(checks[stage]);
    if (next.length === 0) return { ok: false, reason: stage, message: MESSAGES[stage] };
    pool = next;
  }
  // `pool` giữ nguyên thứ tự của `machines`, nên phần tử đầu là máy ưu tiên cao nhất.
  return { ok: true, machineId: (pool[0] as RunnerCandidate).machineId };
}
