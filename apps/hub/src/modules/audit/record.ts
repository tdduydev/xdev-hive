import { sql } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { auditLog } from "./schema.ts";

export interface AuditEntry {
  /** Dạng `<đối tượng>.<động từ>`, ví dụ `team.create`. */
  action: string;
  /** Bỏ trống thì lấy người dùng trong context; null là thao tác của hệ thống (job, webhook). */
  actorUserId?: string | null | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  data?: Record<string, unknown> | undefined;
}

/**
 * Ghi một dòng audit trong transaction của thao tác được ghi, để thao tác và nhật ký cùng commit hoặc cùng
 * rollback. org_id lấy từ tenant context chứ không nhận từ người gọi, nên không ghi nhầm sang tổ chức khác;
 * thiếu context thì RLS từ chối và cả transaction hỏng, thay vì lặng lẽ mất nhật ký.
 */
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<string> {
  const [row] = await tx
    .insert(auditLog)
    .values({
      orgId: sql`hive.ctx_org()`,
      actorUserId: entry.actorUserId === undefined ? sql`hive.ctx_user()` : entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      data: entry.data ?? {},
    })
    .returning({ id: auditLog.id });
  if (!row) throw new Error("Không ghi được nhật ký audit.");
  return row.id;
}
