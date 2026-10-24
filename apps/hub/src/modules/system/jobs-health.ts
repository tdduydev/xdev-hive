import type { Jobs } from "../platform/index.ts";

/**
 * Nhịp của vai trò `jobs` đi qua chính pg-boss: lịch cron tạo job, tiến trình jobs nhận và xử lý. Nhịp đều nghĩa là lịch,
 * lấy job và xử lý job đều còn chạy, không chỉ là tiến trình còn sống (specs/027 FR-043).
 */
export const JOBS_HEARTBEAT_QUEUE = "system-jobs-heartbeat";
export const jobsHeartbeatQueue = {
  name: JOBS_HEARTBEAT_QUEUE,
  // Tiến trình jobs treo thì lịch vẫn tạo job mỗi phút; stately giữ hàng chờ tối đa một job thay vì dồn hàng nghìn.
  policy: "stately",
  retryLimit: 0,
  expireInSeconds: 60,
} as const;
export const JOBS_HEARTBEAT_CRON = "* * * * *";
/** Lịch cron của pg-boss chạy theo phút và kiểm lịch mỗi ~30 giây, nên ba phút không có nhịp mới là jobs đã kẹt. */
export const JOBS_HEARTBEAT_STALE_MS = 3 * 60_000;

export class JobsHeartbeat {
  private readonly now: () => Date;
  private registeredAt: Date | null = null;
  private lastTickAt: Date | null = null;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** Đăng ký ở tiến trình có vai trò `jobs`; tiến trình chỉ có `api` không gọi nên health jobs luôn báo không chạy. */
  async register(jobs: Jobs): Promise<void> {
    await jobs.work(JOBS_HEARTBEAT_QUEUE, async () => this.tick());
    await jobs.schedule(JOBS_HEARTBEAT_QUEUE, JOBS_HEARTBEAT_CRON);
    this.registeredAt = this.now();
  }

  tick(): void {
    this.lastTickAt = this.now();
  }

  status(): { ok: true; lastTickAt: string | null } | { ok: false; lastTickAt: string | null; reason: string } {
    const lastTickAt = this.lastTickAt?.toISOString() ?? null;
    if (!this.registeredAt) return { ok: false, lastTickAt, reason: "Tiến trình này không chạy vai trò jobs." };
    // Vừa khởi động thì chưa tới nhịp đầu; tính từ lúc khởi động để healthcheck không báo hỏng oan.
    const since = this.lastTickAt ?? this.registeredAt;
    if (this.now().getTime() - since.getTime() > JOBS_HEARTBEAT_STALE_MS)
      return { ok: false, lastTickAt, reason: "Vai trò jobs không nhận được nhịp từ hàng đợi quá ba phút." };
    return { ok: true, lastTickAt };
  }
}

/** Một instance cho cả tiến trình: router `system` do app.ts dựng đọc nó, main.ts đăng ký nhịp khi có vai trò jobs. */
export const jobsHeartbeat = new JobsHeartbeat();
