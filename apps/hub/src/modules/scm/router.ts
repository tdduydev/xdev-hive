import { implement, ORPCError } from "@orpc/server";
import { contract, type ScmConnectionTestResult } from "@xdev-hive/contracts";
import { type MasterKey, type RequestContext, withTenant } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import {
  createConnection,
  defaultProviderFactory,
  listConnections,
  loadConnectionForAdmin,
  type ProviderFactory,
  removeConnection,
  type ScmConnectionRecord,
} from "./connections.ts";
import { isGitProviderError } from "./errors.ts";
import type { GitProvider } from "./types.ts";

export interface ScmDeps extends OrgDeps {
  masterKey?: MasterKey | undefined;
  providerFactory?: ProviderFactory | undefined;
}

const view = (c: ScmConnectionRecord) => ({ ...c, createdAt: c.createdAt.toISOString() });

function needKey(deps: ScmDeps): MasterKey {
  if (!deps.masterKey) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Hub chưa cấu hình HIVE_MASTER_KEY nên chưa lưu được secret.",
    });
  }
  return deps.masterKey;
}

/** Gọi ra GitHub/GitLab ngoài transaction, lỗi của provider thành kết quả để người quản trị đọc được. */
export async function checkConnection(provider: GitProvider, owner: string | null): Promise<ScmConnectionTestResult> {
  if (!owner) {
    return {
      ok: false,
      owner,
      canCreate: false,
      missingScopes: [],
      unverifiedScopes: [],
      message: "Chưa có owner để kiểm: nhập owner.",
    };
  }
  try {
    const access = await provider.checkAccess(owner);
    const unverifiedScopes = access.unverifiedScopes ?? [];
    let message = access.canCreate
      ? `Kết nối dùng được, tạo được repo trong ${owner}.`
      : `Kết nối dùng được nhưng chưa tạo được repo trong ${owner}${
          access.missingScopes.length ? `: thiếu ${access.missingScopes.join(", ")}` : ""
        }.`;
    if (unverifiedScopes.length) {
      message += ` Token không cho đọc quyền của nó, nên chưa kiểm trước được: ${unverifiedScopes.join(", ")}. Hãy chắc token đã được cấp các quyền này.`;
    }
    return {
      ok: true,
      owner,
      canCreate: access.canCreate,
      missingScopes: access.missingScopes,
      unverifiedScopes,
      message,
    };
  } catch (e) {
    if (!isGitProviderError(e)) throw e;
    return {
      ok: false,
      owner,
      canCreate: false,
      missingScopes: e.missingScopes,
      unverifiedScopes: [],
      message: e.message,
    };
  }
}

export function scmRouter(deps: ScmDeps) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const os = implement(contract.scmConnections).$context<RequestContext>().use(authed);
  const factory = deps.providerFactory ?? defaultProviderFactory;

  return {
    // Mọi thành viên xem được (không có secret), vì quản trị đội cần chọn kết nối khi tạo dự án.
    list: os.list.use(inOrg).handler(async ({ context: { tx } }) => (await listConnections(tx)).map(view)),
    create: os.create
      .use(inOrg)
      .handler(async ({ context: { tx, user }, input }) =>
        view(await createConnection(tx, needKey(deps), user.id, input)),
      ),
    // Gọi ra nhà cung cấp nên không dùng inOrg: đọc kết nối trong transaction ngắn rồi trả kết nối database.
    test: os.test.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
      const key = needKey(deps);
      const conn = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
        loadConnectionForAdmin(tx, key, user.id, input.id),
      );
      return checkConnection(factory(conn), input.owner ?? conn.defaultOwner);
    }),
    remove: os.remove.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
      await removeConnection(tx, user.id, input.id);
      return { id: input.id };
    }),
  };
}
