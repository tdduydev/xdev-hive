import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { type Tx, withTenant } from "../platform/index.ts";

/** Tiền tố giúp nhận ra token bị lộ (secret scanner) và từ chối sớm token sai loại mà không cần hỏi database. */
export const REGISTRATION_PREFIX = "hwr_";
export const MACHINE_PREFIX = "hwm_";

/** 32 byte ngẫu nhiên: đủ để không đoán được, nên endpoint đăng ký không cần giới hạn số lần thử. */
export function newToken(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** Token có độ ngẫu nhiên cao nên SHA-256 không muối là đủ, và tra được bằng index thay vì so từng dòng. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Transaction không có tổ chức, chỉ thấy dòng machine_tokens/registration_tokens có đúng băm này (policy dùng
 * hive.ctx_fleet_token()). Dùng để biết token thuộc tổ chức nào rồi mới mở transaction có tenant để ghi.
 */
export function withTokenLookup<T>(pool: pg.Pool, tokenHash: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(pool, {}, async (tx) => {
    await tx.execute(sql`select set_config('app.fleet_token_hash', ${tokenHash}, true)`);
    return fn(tx);
  });
}
