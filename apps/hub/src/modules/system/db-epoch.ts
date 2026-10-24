import type pg from "pg";
import { withTenant } from "../platform/index.ts";
import { dbEpoch } from "./schema.ts";

export type DbEpochInfo = { dbEpoch: string; dbRestoredTo: string | null };
type Source = () => Promise<DbEpochInfo | undefined>;

export const DB_EPOCH_TTL_MS = 60_000;

export function readDbEpoch(pool: pg.Pool): Source {
  return async () => {
    // Bảng hệ thống không thuộc tổ chức; policy cho hive_app đọc không cần context.
    const [row] = await withTenant(pool, {}, (tx) => tx.select().from(dbEpoch).limit(1));
    return row && { dbEpoch: row.epoch, dbRestoredTo: row.restoredTo?.toISOString() ?? null };
  };
}

/**
 * Mốc database cho /api/v1/health. Worker và healthcheck gọi health liên tục nên giữ bản đọc một phút; khôi phục luôn
 * tái tạo container hub nên mốc mới có ngay sau khôi phục.
 */
export class DbEpochCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private source: Source | undefined;
  private cached: { at: number; value: Promise<DbEpochInfo | undefined> } | undefined;

  constructor(ttlMs = DB_EPOCH_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  provide(source: Source): void {
    this.source = source;
    this.cached = undefined;
  }

  /** Lỗi database không làm health hỏng: trả rỗng như hub cũ, worker giữ mốc đã thấy. */
  async current(): Promise<Partial<DbEpochInfo>> {
    if (!this.source) return {};
    const at = this.now();
    if (!this.cached || at - this.cached.at >= this.ttlMs) {
      const value = this.source().catch(() => undefined);
      this.cached = { at, value };
      // Không giữ lỗi suốt một phút: lần gọi sau đọc lại.
      void value.then((v) => {
        if (v === undefined && this.cached?.value === value) this.cached = undefined;
      });
    }
    return (await this.cached.value) ?? {};
  }
}

/** Một instance cho cả tiến trình: router `system` do app.ts dựng đọc nó, main.ts nối pool vào. */
export const dbEpochCache = new DbEpochCache();
