import { randomUUID } from "node:crypto";
import type { ScmConnectionCreateInput } from "@xdev-hive/contracts";
import { asc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import {
  ConflictError,
  decryptSecret,
  encryptSecret,
  type MasterKey,
  NotFoundError,
  type Tx,
} from "../platform/index.ts";
import { requireOrgRole } from "../tenancy/index.ts";
import { GitProviderError } from "./errors.ts";
import { createGitHubProvider } from "./github.ts";
import { createGitLabProvider } from "./gitlab.ts";
import { createLocalProvider, isLocalConnection, type LocalProviderOptions, localProviderFromEnv } from "./local.ts";
import { scmConnections } from "./schema.ts";
import type { FetchLike, GitProvider, GitProviderKind } from "./types.ts";

export type ScmAuthMode = "app" | "token";

export interface ScmConnectionRecord {
  id: string;
  kind: GitProviderKind;
  name: string;
  baseUrl: string | null;
  defaultOwner: string | null;
  authMode: ScmAuthMode;
  appId: string | null;
  installationId: number | null;
  createdAt: Date;
}

type Secret = { privateKey: string } | { token: string };

/** Kết nối kèm secret đã giải mã. Chỉ sống trong bộ nhớ, đủ lâu để dựng GitProvider. */
export interface ResolvedConnection extends ScmConnectionRecord {
  secret: Secret;
}

/** Dựng GitProvider từ một kết nối. Test thay bằng provider giả. */
export type ProviderFactory = (conn: ResolvedConnection) => GitProvider;

/**
 * `fetch` cho test (MockAgent) hoặc proxy ra ngoài; mặc định dùng fetch có sẵn. `local` bật provider chỉ để thử của
 * scripts/e2e-smoke.ts cho kết nối trỏ vào host `hive-e2e.invalid`.
 */
export function createProviderFactory(
  opts: { fetch?: FetchLike; local?: LocalProviderOptions | undefined } = {},
): ProviderFactory {
  const extra = opts.fetch ? { fetch: opts.fetch } : {};
  return (conn) => {
    if (opts.local && isLocalConnection(conn)) return createLocalProvider(conn.kind, opts.local);
    if (conn.kind === "github" && conn.authMode === "token") {
      if (!("token" in conn.secret)) throw new GitProviderError("invalid", "GitHub: kết nối thiếu token");
      return createGitHubProvider({
        token: conn.secret.token,
        ...(conn.baseUrl ? { baseUrl: conn.baseUrl } : {}),
        ...extra,
      });
    }
    if (conn.kind === "github") {
      if (!("privateKey" in conn.secret) || !conn.appId || !conn.installationId) {
        throw new GitProviderError("invalid", "GitHub: kết nối thiếu App ID, installation ID hoặc khoá riêng");
      }
      return createGitHubProvider({
        appId: conn.appId,
        privateKey: conn.secret.privateKey,
        installationId: conn.installationId,
        ...(conn.baseUrl ? { baseUrl: conn.baseUrl } : {}),
        ...extra,
      });
    }
    if (!("token" in conn.secret)) throw new GitProviderError("invalid", "GitLab: kết nối thiếu token");
    return createGitLabProvider({ url: conn.baseUrl ?? "https://gitlab.com", token: conn.secret.token, ...extra });
  };
}

// Provider local chỉ có khi hub chạy với HIVE_E2E=1 và HIVE_E2E_GIT_ROOT (scripts/e2e-smoke.ts).
export const defaultProviderFactory: ProviderFactory = createProviderFactory({ local: localProviderFromEnv() });

// Ngữ cảnh mã hoá gắn với id dòng: chép secret_enc sang dòng khác sẽ không giải mã được.
const secretContext = (id: string) => `scm_connections:${id}`;

const columns = {
  id: scmConnections.id,
  kind: scmConnections.kind,
  name: scmConnections.name,
  baseUrl: scmConnections.baseUrl,
  defaultOwner: scmConnections.defaultOwner,
  // Dòng GitLab có trước cột auth_mode mang giá trị mặc định "app"; GitLab chỉ có token nên đọc ra luôn là "token".
  authMode: sql<ScmAuthMode>`case when ${scmConnections.kind} = 'gitlab' then 'token' else ${scmConnections.authMode}::text end`,
  appId: scmConnections.appId,
  installationId: scmConnections.installationId,
  createdAt: scmConnections.createdAt,
};

const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
// ON DELETE RESTRICT báo restrict_violation thay vì foreign_key_violation.
const RESTRICT_VIOLATION = "23001";
/** Drizzle bọc lỗi của pg trong `cause`. */
const pgCode = (e: unknown) => (((e as { cause?: unknown }).cause ?? e) as { code?: string }).code;

const notFound = () => new NotFoundError("SCM_CONNECTION_NOT_FOUND", "Không tìm thấy kết nối Git trong tổ chức.");

export function listConnections(tx: Tx): Promise<ScmConnectionRecord[]> {
  return tx.select(columns).from(scmConnections).orderBy(asc(scmConnections.name));
}

export async function createConnection(
  tx: Tx,
  master: MasterKey,
  userId: string,
  input: ScmConnectionCreateInput,
): Promise<ScmConnectionRecord> {
  await requireOrgRole(tx, userId, "admin");
  // Sinh id trước để buộc nó vào bản mã của secret.
  const id = randomUUID();
  const app = input.kind === "github" && input.authMode !== "token" ? input : null;
  const secret: Secret = "privateKey" in input ? { privateKey: input.privateKey } : { token: input.token };
  let row: ScmConnectionRecord | undefined;
  try {
    [row] = await tx
      .insert(scmConnections)
      .values({
        id,
        orgId: sql`hive.ctx_org()`,
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl ?? (input.kind === "gitlab" ? "https://gitlab.com" : null),
        defaultOwner: input.defaultOwner ?? null,
        authMode: app ? "app" : "token",
        appId: app?.appId ?? null,
        installationId: app?.installationId ?? null,
        secretEnc: encryptSecret(master, JSON.stringify(secret), secretContext(id)),
        createdBy: userId,
      })
      .returning(columns);
  } catch (e) {
    if (pgCode(e) === UNIQUE_VIOLATION) {
      throw new ConflictError("SCM_CONNECTION_NAME_TAKEN", `Tổ chức đã có kết nối Git tên "${input.name}".`);
    }
    throw e;
  }
  if (!row) throw new Error("Không tạo được kết nối Git.");
  await recordAudit(tx, {
    action: "scm_connection.create",
    targetType: "scm_connection",
    targetId: id,
    // Không ghi secret vào nhật ký.
    data: {
      kind: row.kind,
      authMode: row.authMode,
      name: row.name,
      baseUrl: row.baseUrl,
      defaultOwner: row.defaultOwner,
    },
  });
  return row;
}

/** Kết nối kèm secret đã giải mã, hoặc null nếu không có trong tổ chức của context. */
export async function loadConnection(tx: Tx, master: MasterKey, id: string): Promise<ResolvedConnection | null> {
  const [row] = await tx
    .select({ ...columns, secretEnc: scmConnections.secretEnc })
    .from(scmConnections)
    .where(eq(scmConnections.id, id));
  if (!row) return null;
  const { secretEnc, ...rest } = row;
  return { ...rest, secret: JSON.parse(decryptSecret(master, secretEnc, secretContext(id))) as Secret };
}

/** Như loadConnection nhưng báo NOT_FOUND, và đòi quyền quản trị tổ chức (để kiểm hay xoá). */
export async function loadConnectionForAdmin(
  tx: Tx,
  master: MasterKey,
  userId: string,
  id: string,
): Promise<ResolvedConnection> {
  await requireOrgRole(tx, userId, "admin");
  const conn = await loadConnection(tx, master, id);
  if (!conn) throw notFound();
  return conn;
}

export async function removeConnection(tx: Tx, userId: string, id: string): Promise<void> {
  await requireOrgRole(tx, userId, "admin");
  let deleted: Array<{ id: string; name: string }>;
  try {
    deleted = await tx
      .delete(scmConnections)
      .where(eq(scmConnections.id, id))
      .returning({ id: scmConnections.id, name: scmConnections.name });
  } catch (e) {
    // projects trỏ tới kết nối bằng khoá ngoại RESTRICT: xoá thì dự án mất đường gọi GitHub/GitLab.
    if (pgCode(e) === FK_VIOLATION || pgCode(e) === RESTRICT_VIOLATION) {
      throw new ConflictError("SCM_CONNECTION_IN_USE", "Kết nối Git đang được dự án dùng, không xoá được.");
    }
    throw e;
  }
  const [row] = deleted;
  if (!row) throw notFound();
  await recordAudit(tx, {
    action: "scm_connection.remove",
    targetType: "scm_connection",
    targetId: id,
    data: { name: row.name },
  });
}
