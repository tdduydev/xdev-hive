import { implement, ORPCError } from "@orpc/server";
import { contract, type ScmConnectionTestResult } from "@xdev-hive/contracts";
import { type MasterKey, type RequestContext, withTenant } from "../platform/index.ts";
import { type OrgScopeDeps, orgScope } from "../tenancy/index.ts";
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

export interface ScmDeps extends OrgScopeDeps {
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
    return { ok: false, owner, canCreate: false, missingScopes: [], message: "Chưa có owner để kiểm: nhập owner." };
  }
  try {
    const access = await provider.checkAccess(owner);
    const message = access.canCreate
      ? `Kết nối dùng được, tạo được repo trong ${owner}.`
      : `Kết nối dùng được nhưng chưa tạo được repo trong ${owner}${
          access.missingScopes.length ? `: thiếu ${access.missingScopes.join(", ")}` : ""
        }.`;
    return { ok: true, owner, canCreate: access.canCreate, missingScopes: access.missingScopes, message };
  } catch (e) {
    if (!isGitProviderError(e)) throw e;
    return { ok: false, owner, canCreate: false, missingScopes: e.missingScopes, message: e.message };
  }
}

export function scmRouter(deps: ScmDeps) {
  const os = implement(contract.scmConnections).$context<RequestContext>().use(orgScope(deps));
  const factory = deps.providerFactory ?? defaultProviderFactory;

  return {
    // Mọi thành viên xem được (không có secret), vì quản trị đội cần chọn kết nối khi tạo dự án.
    list: os.list.handler(async ({ context: { pool, actor } }) =>
      (await withTenant(pool, actor, (tx) => listConnections(tx))).map(view),
    ),
    create: os.create.handler(async ({ context: { pool, actor }, input }) => {
      const key = needKey(deps);
      return view(await withTenant(pool, actor, (tx) => createConnection(tx, key, actor.userId, input)));
    }),
    test: os.test.handler(async ({ context: { pool, actor }, input }) => {
      const key = needKey(deps);
      const conn = await withTenant(pool, actor, (tx) => loadConnectionForAdmin(tx, key, actor.userId, input.id));
      return checkConnection(factory(conn), input.owner ?? conn.defaultOwner);
    }),
    remove: os.remove.handler(async ({ context: { pool, actor }, input }) => {
      await withTenant(pool, actor, (tx) => removeConnection(tx, actor.userId, input.id));
      return { id: input.id };
    }),
  };
}
