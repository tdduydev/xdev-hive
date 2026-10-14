import { and, desc, like, sql } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { auditLog } from "./schema.ts";

/**
 * Dòng audit mới nhất có `data->>key = value` trong nhóm action (LIKE). Trả nguyên `data` nên người gọi chỉ được đưa
 * ra ngoài trường đã biết kiểu: tham số tool MCP có thể chứa bí mật dưới khoá bất kỳ.
 */
export async function auditByData(
  tx: Tx,
  opts: { actionLike: string; key: string; value: string; limit: number },
): Promise<Array<{ id: string; action: string; data: Record<string, unknown>; createdAt: Date }>> {
  return tx
    .select({ id: auditLog.id, action: auditLog.action, data: auditLog.data, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(like(auditLog.action, opts.actionLike), sql`${auditLog.data}->>${opts.key} = ${opts.value}`))
    .orderBy(desc(auditLog.createdAt))
    .limit(opts.limit);
}
