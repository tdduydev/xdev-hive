import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

/** Ai đang gọi và trong tổ chức nào. RLS đọc các giá trị này qua hàm hive.ctx_*(). */
export interface TenantContext {
  userId?: string | undefined;
  orgId?: string | undefined;
  /** Chỉ dùng khi nhận lời mời: người nhận chưa thuộc tổ chức nên phải tìm lời mời theo mã. */
  inviteTokenHash?: string | undefined;
}

/** `$client` là kết nối đang giữ transaction; thư viện khác (pg-boss) dùng nó để ghi chung transaction. */
export type Tx = NodePgDatabase & { $client: pg.PoolClient };

export function createPool(url: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: url, max });
}

/**
 * Chạy fn trong một transaction có tenant context. set_config(..., true) chỉ sống trong transaction,
 * nên context không rò sang request khác khi kết nối quay lại pool.
 */
export async function withTenant<T>(pool: pg.Pool, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.user_id', $1, true), set_config('app.org_id', $2, true), set_config('app.invite_token_hash', $3, true)",
      [ctx.userId ?? "", ctx.orgId ?? "", ctx.inviteTokenHash ?? ""],
    );
    const result = await fn(drizzle(client));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
