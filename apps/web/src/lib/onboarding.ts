import type { Machine } from "@xdev-hive/contracts";

/**
 * Các bước đưa một tổ chức mới cài tới lúc agent nhận việc đầu tiên. Thứ tự là thứ tự nên làm: dự án cần kết nối Git,
 * việc cần dự án, và run của đội (Leader, AI duyệt tài liệu, webhook) chỉ chạy trên máy dùng chung (ADR 0017).
 */
export type OnboardingStepId = "scm" | "project" | "machine" | "shared" | "task";

export const ONBOARDING_ORDER: readonly OnboardingStepId[] = ["scm", "project", "machine", "shared", "task"];

/** Bước nào phải xong trước; bấm bước sau khi bước trước chưa xong chỉ gặp hộp thoại báo thiếu. */
const PREREQUISITE: Partial<Record<OnboardingStepId, OnboardingStepId>> = {
  project: "scm",
  shared: "machine",
  task: "project",
};

export interface OnboardingInput {
  /** Người đang xem làm được bước nào. Chỉ để ẩn bước; hub vẫn kiểm quyền. */
  can: Record<OnboardingStepId, boolean>;
  connections: number;
  /** Hệ thống trong các đội mình quản trị: tạo dự án cần chọn một hệ thống. */
  ownSystems: number;
  projects: number;
  /** Máy của các đội mình quản trị. */
  machines: Pick<Machine, "kind" | "shared" | "status">[];
  tasks: number;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
  /** Bước phải làm trước mà chưa xong; null là làm được ngay. */
  waitingFor: OnboardingStepId | null;
}

const live = (m: Pick<Machine, "status">) => m.status !== "revoked";

/** Máy nhận được run của đội: máy dùng chung chưa thu hồi. Runner host luôn tính là dùng chung. */
export function hasSharedMachine(machines: Pick<Machine, "kind" | "shared" | "status">[]): boolean {
  return machines.some((m) => live(m) && (m.shared || m.kind === "host"));
}

/**
 * Máy nên gợi ý bật dùng chung: máy dev chưa thu hồi, ưu tiên máy đang trực tuyến, rồi máy không tạm dừng, rồi máy
 * có nhiều chỗ chạy. null khi không có máy nào bật được.
 */
export function shareCandidate<M extends Pick<Machine, "kind" | "shared" | "status" | "capacity">>(
  machines: M[],
): M | null {
  const rank = (m: M) => (m.status === "online" ? 0 : m.status === "offline" ? 1 : 2);
  const candidates = machines.filter((m) => m.kind === "worker" && !m.shared && live(m));
  return candidates.toSorted((a, b) => rank(a) - rank(b) || b.capacity - a.capacity)[0] ?? null;
}

/** Bước người đang xem làm được, theo thứ tự, kèm đã xong hay chưa. */
export function onboardingSteps(input: OnboardingInput): OnboardingStep[] {
  const done: Record<OnboardingStepId, boolean> = {
    scm: input.connections > 0,
    project: input.projects > 0,
    machine: input.machines.some(live),
    shared: hasSharedMachine(input.machines),
    task: input.tasks > 0,
  };
  return ONBOARDING_ORDER.filter((id) => input.can[id]).map((id) => {
    const before = PREREQUISITE[id];
    return { id, done: done[id], waitingFor: !done[id] && before && !done[before] ? before : null };
  });
}

/** Thẻ "Bắt đầu" chỉ hiện khi còn bước người đang xem làm được mà chưa xong. */
export const onboardingPending = (steps: OnboardingStep[]): boolean => steps.some((s) => !s.done);
