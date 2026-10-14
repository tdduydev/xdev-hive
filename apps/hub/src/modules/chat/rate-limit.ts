/**
 * Giới hạn tốc độ cửa sổ trượt trong bộ nhớ. Chạy trước mọi truy vấn database, nên một tài khoản chat gửi dồn dập
 * (hoặc dò mã liên kết) không tốn gì ngoài vài phép so sánh. Mỗi tiến trình api giữ bộ đếm riêng: đủ cho mục đích chặn
 * lạm dụng, không phải hạn mức nghiệp vụ (hạn mức lượt Leader nằm trong database, bảng chat_usage).
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Ghi một lần gọi; false nếu vượt giới hạn (lần gọi bị từ chối không tính vào cửa sổ). */
  allow(key: string): boolean {
    const t = this.now();
    this.sweep(t);
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  /** Xoá hết bộ đếm; test dùng để các kịch bản không ăn hạn mức của nhau. */
  reset(): void {
    this.hits.clear();
  }

  /** Xoá khoá cũ để Map không phình khi có nhiều tài khoản lạ. */
  private sweep(t: number): void {
    if (t - this.lastSweep < this.windowMs) return;
    this.lastSweep = t;
    for (const [key, list] of this.hits) {
      if (list.every((at) => t - at >= this.windowMs)) this.hits.delete(key);
    }
  }
}

/** 20 tin mỗi phút cho mỗi tài khoản chat. */
export const messageLimiter = new RateLimiter(20, 60_000);
/** 5 lần nhập mã liên kết sai mỗi 10 phút cho mỗi tài khoản chat: mã 40 bit, dò không nổi trong ngần ấy. */
export const linkAttemptLimiter = new RateLimiter(5, 600_000);
