import { implement, ORPCError } from "@orpc/server";
import { tenancyContract } from "@xdev-hive/contracts";
import type pg from "pg";
import type { Auth } from "../identity/index.ts";
import { ConflictError, type RequestContext, withTenant } from "../platform/index.ts";
import { requireOrgRole } from "./permissions.ts";

export interface TenancyDeps {
  auth?: Auth | undefined;
  /** Pool của role hive_app. Không có khi chạy test đơn vị không cần database. */
  pool?: pg.Pool | undefined;
  /** Email (chữ thường) được tạo thêm tổ chức sau tổ chức đầu tiên. */
  orgCreators?: string[] | undefined;
  /** Địa chỉ web mà người được mời mở link; link mời là `${publicUrl}/moi/<mã>`. */
  publicUrl?: string | undefined;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

export const ORG_HEADER = "x-hive-org";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ba tầng procedure: `base` không cần đăng nhập (xem lời mời), `authed` chỉ cần đăng nhập (chọn hoặc tạo tổ chức,
 * nhận lời mời), `inOrg` chạy cả handler trong một transaction withTenant của tổ chức đang chọn. Handler và
 * recordAudit dùng chung transaction đó, nên thao tác và nhật ký cùng commit hoặc cùng rollback.
 */
export function procedures(deps: TenancyDeps) {
  const base = implement(tenancyContract).$context<RequestContext>();

  const authed = base.use(async ({ context, next }) => {
    const session = deps.auth ? await deps.auth.api.getSession({ headers: context.headers }) : null;
    if (!session) throw new ORPCError("UNAUTHORIZED", { message: "Chưa đăng nhập." });
    if (!deps.pool) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Hub chưa cấu hình HIVE_DATABASE_URL." });
    const { id, name, email } = session.user;
    return next({ context: { user: { id, name, email } satisfies SessionUser, pool: deps.pool } });
  });

  const inOrg = authed.use(async ({ context, next }, input) => {
    // Tham số orgId (đường dẫn /v1/orgs/{orgId}) thắng header, vì URL nói rõ người gọi muốn tổ chức nào.
    const fromInput = (input as { orgId?: unknown } | undefined)?.orgId;
    const orgId = typeof fromInput === "string" ? fromInput : context.headers.get(ORG_HEADER);
    if (!orgId) throw new ORPCError("BAD_REQUEST", { message: `Chưa chọn tổ chức (header ${ORG_HEADER}).` });
    if (!UUID.test(orgId)) throw new ORPCError("BAD_REQUEST", { message: "Mã tổ chức không hợp lệ." });
    const { user, pool } = context;
    return withTenant(pool, { userId: user.id, orgId }, async (tx) => {
      // RLS chỉ giới hạn theo tổ chức trong context, không theo tư cách thành viên: ai cũng đặt được header. Vì vậy
      // mọi procedure trong tổ chức phải qua bước này trước, kể cả procedure chỉ đọc.
      const orgRole = await requireOrgRole(tx, user.id, "member");
      return next({ context: { tx, orgId, orgRole } });
    });
  });

  return { base, authed, inOrg };
}

export type Procedures = ReturnType<typeof procedures>;
const UNIQUE_VIOLATION = "23505";

/**
 * Đổi lỗi trùng khoá duy nhất thành ConflictError theo tên ràng buộc. Bắt lỗi thay vì kiểm tra trước vì kiểm tra
 * trước vẫn hở khi hai người tạo cùng lúc. Lỗi làm hỏng transaction, nên luôn ném tiếp để withTenant rollback.
 */
export async function onUnique<T>(run: () => Promise<T>, byConstraint: Record<string, ConflictError>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Drizzle bọc lỗi của pg trong `cause`.
    const pgError = ((error as { cause?: unknown }).cause ?? error) as { code?: string; constraint?: string };
    const mapped = pgError.code === UNIQUE_VIOLATION && pgError.constraint && byConstraint[pgError.constraint];
    throw mapped || error;
  }
}

export const slugTaken = (constraint: string, what: string, slug: string) => ({
  [constraint]: new ConflictError("SLUG_TAKEN", `Định danh "${slug}" đã được ${what} khác dùng.`),
});

export const iso = (d: Date) => d.toISOString();
