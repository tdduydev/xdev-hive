import { implement, ORPCError, os } from "@orpc/server";
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

/** Phần TenancyDeps mà middleware chọn tổ chức cần; module khác (scm, catalog) chỉ cần truyền chừng này. */
export type OrgDeps = Pick<TenancyDeps, "auth" | "pool">;

/**
 * Middleware chọn tổ chức, không gắn với hợp đồng nào để router của module khác dùng chung. `authed` chỉ cần đăng
 * nhập; `inOrg` chạy cả handler trong một transaction withTenant của tổ chức đang chọn, nên handler và recordAudit
 * cùng commit hoặc cùng rollback; `orgMember` chỉ kiểm tư cách thành viên trong transaction ngắn rồi để handler tự
 * mở transaction, dành cho handler gọi ra GitHub/GitLab: không giữ kết nối database trong lúc chờ mạng.
 */
export function orgMiddlewares(deps: OrgDeps) {
  const authed = os.$context<RequestContext>().middleware(async ({ context, next }) => {
    const session = deps.auth ? await deps.auth.api.getSession({ headers: context.headers }) : null;
    if (!session) throw new ORPCError("UNAUTHORIZED", { message: "Chưa đăng nhập." });
    if (!deps.pool) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Hub chưa cấu hình HIVE_DATABASE_URL." });
    const { id, name, email } = session.user;
    return next({ context: { user: { id, name, email } satisfies SessionUser, pool: deps.pool } });
  });

  const authedContext = os.$context<RequestContext & { user: SessionUser; pool: pg.Pool }>();

  const inOrg = authedContext.middleware(async ({ context, next }, input: unknown) => {
    const orgId = selectedOrg(context.headers, input);
    const { user, pool } = context;
    return withTenant(pool, { userId: user.id, orgId }, async (tx) => {
      // RLS chỉ giới hạn theo tổ chức trong context, không theo tư cách thành viên: ai cũng đặt được header. Vì vậy
      // mọi procedure trong tổ chức phải qua bước này trước, kể cả procedure chỉ đọc.
      const orgRole = await requireOrgRole(tx, user.id, "member");
      return next({ context: { tx, orgId, orgRole } });
    });
  });

  const orgMember = authedContext.middleware(async ({ context, next }, input: unknown) => {
    const orgId = selectedOrg(context.headers, input);
    const { user, pool } = context;
    const orgRole = await withTenant(pool, { userId: user.id, orgId }, (tx) => requireOrgRole(tx, user.id, "member"));
    return next({ context: { orgId, orgRole } });
  });

  return { authed, inOrg, orgMember };
}

function selectedOrg(headers: Headers, input: unknown): string {
  // Tham số orgId (đường dẫn /v1/orgs/{orgId}) thắng header, vì URL nói rõ người gọi muốn tổ chức nào.
  const fromInput = (input as { orgId?: unknown } | undefined)?.orgId;
  const orgId = typeof fromInput === "string" ? fromInput : headers.get(ORG_HEADER);
  if (!orgId) throw new ORPCError("BAD_REQUEST", { message: `Chưa chọn tổ chức (header ${ORG_HEADER}).` });
  if (!UUID.test(orgId)) throw new ORPCError("BAD_REQUEST", { message: "Mã tổ chức không hợp lệ." });
  return orgId;
}

/**
 * Procedure của hợp đồng tenancy, dựng từ cùng middleware chọn tổ chức. Thêm tầng `base` không cần đăng nhập (xem
 * lời mời); `authed` dùng cho cả nhận lời mời.
 */
export function procedures(deps: TenancyDeps) {
  const m = orgMiddlewares(deps);
  const base = implement(tenancyContract).$context<RequestContext>();
  const authed = base.use(m.authed);
  const inOrg = authed.use(m.inOrg);
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
