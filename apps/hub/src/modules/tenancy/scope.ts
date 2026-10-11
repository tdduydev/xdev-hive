import { ORPCError, os } from "@orpc/server";
import type pg from "pg";
import type { Auth } from "../identity/index.ts";
import { type RequestContext, withTenant } from "../platform/index.ts";
import { type OrgRole, requireOrgRole } from "./permissions.ts";

export const ORG_HEADER = "x-hive-org";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OrgScopeDeps {
  auth?: Auth | undefined;
  /** Pool của role hive_app. Không có khi chạy test đơn vị không cần database. */
  pool?: pg.Pool | undefined;
}

/** Người gọi trong tổ chức đang chọn. Module dùng để mở withTenant() của riêng mình. */
export interface OrgActor {
  userId: string;
  orgId: string;
  orgRole: OrgRole;
}

/**
 * Middleware oRPC cho procedure trong một tổ chức: cần đăng nhập, tổ chức lấy từ header, người gọi phải là thành
 * viên đang hoạt động. RLS chỉ giới hạn theo tổ chức trong context chứ không theo tư cách thành viên (ai cũng đặt
 * được header), nên mọi procedure trong tổ chức phải qua bước này, kể cả procedure chỉ đọc.
 *
 * Khác với việc bọc cả handler trong một transaction: handler tự mở transaction ngắn, vì có handler gọi ra
 * GitHub/GitLab và không nên giữ kết nối database trong lúc chờ mạng.
 */
export function orgScope(deps: OrgScopeDeps) {
  return os.$context<RequestContext>().middleware(async ({ context, next }) => {
    const session = deps.auth ? await deps.auth.api.getSession({ headers: context.headers }) : null;
    if (!session) throw new ORPCError("UNAUTHORIZED", { message: "Chưa đăng nhập." });
    const pool = deps.pool;
    if (!pool) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Hub chưa cấu hình HIVE_DATABASE_URL." });
    const orgId = context.headers.get(ORG_HEADER);
    if (!orgId) throw new ORPCError("BAD_REQUEST", { message: `Chưa chọn tổ chức (header ${ORG_HEADER}).` });
    if (!UUID.test(orgId)) throw new ORPCError("BAD_REQUEST", { message: "Mã tổ chức không hợp lệ." });
    const userId = session.user.id;
    const orgRole = await withTenant(pool, { userId, orgId }, (tx) => requireOrgRole(tx, userId, "member"));
    return next({ context: { pool, actor: { userId, orgId, orgRole } satisfies OrgActor } });
  });
}
