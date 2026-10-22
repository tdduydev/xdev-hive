import { randomUUID } from "node:crypto";
import type { ConnectionTestResult, JenkinsConnection, JenkinsTokenItem } from "@xdev-hive/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../../audit/index.ts";
import { authUser } from "../../identity/index.ts";
import {
  BadRequestError,
  ConflictError,
  encryptSecret,
  ForbiddenError,
  type MasterKey,
  NotFoundError,
  type Tx,
} from "../../platform/index.ts";
import { allowWith, orgRoleOf, requireOrgRole } from "../../tenancy/index.ts";
import { createJenkinsClient, type FetchLike, JenkinsError } from "../clients/jenkins.ts";
import { ciJenkinsConnections, ciJenkinsUserTokens } from "../schema.ts";
import { jenkinsAuth, jenkinsTokenContext } from "./credentials.ts";

// Kết nối Jenkins của tổ chức và token Jenkins của từng người (plan.md mục 2, Q3). Token chỉ ghi: nhận vào, mã hoá rồi
// lưu; đọc ra chỉ qua `credentials.ts`. Không hàm nào ở đây trả hay log giá trị token.

export interface JenkinsDeps {
  masterKey?: MasterKey | undefined;
  fetch?: FetchLike | undefined;
}

/** Client Jenkins của một kết nối; test thay `fetch` bằng máy chủ giả. */
export function jenkinsClient(deps: JenkinsDeps, auth: { baseUrl: string; user: string; token: string }) {
  const { baseUrl, user, token } = auth;
  return createJenkinsClient({ baseUrl, user, token, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
}

const UNIQUE_VIOLATION = "23505";
/** Drizzle bọc lỗi của pg trong `cause`. */
export const pgCode = (e: unknown) => (((e as { cause?: unknown }).cause ?? e) as { code?: string }).code;

const notFound = () => new NotFoundError("NOT_FOUND", "Không tìm thấy kết nối Jenkins.");
const nameTaken = (name: string) =>
  new ConflictError("CONNECTION_NAME_TAKEN", `Tổ chức đã có kết nối tên "${name}". Chọn tên khác.`);

export function requireMasterKey(deps: { masterKey?: MasterKey | undefined }): MasterKey {
  if (!deps.masterKey)
    throw new ConflictError(
      "MASTER_KEY_MISSING",
      "Hub chưa cấu hình HIVE_MASTER_KEY nên chưa lưu hay dùng được token.",
    );
  return deps.masterKey;
}

/** Kết nối Jenkins, Argo CD, Kubernetes giữ token vào hệ thống của cả tổ chức: quản trị tổ chức hoặc vai trò tự tạo. */
export async function requireConnectionsManage(tx: Tx, userId: string): Promise<void> {
  await allowWith(tx, userId, "ci.connections.manage", () => requireOrgRole(tx, userId, "admin"));
}

/**
 * Lỗi của client Jenkins thành lỗi nghiệp vụ theo mã của hợp đồng. Câu báo của client đã nói rõ cách sửa và không chứa
 * token, nên giữ nguyên.
 */
export function jenkinsDomainError(e: unknown, connectionId: string): unknown {
  if (!(e instanceof JenkinsError)) return e;
  switch (e.code) {
    case "UNAUTHORIZED":
      return new ForbiddenError("JENKINS_UNAUTHORIZED", e.message);
    case "FORBIDDEN":
    case "CRUMB_REQUIRED":
      return new ForbiddenError("JENKINS_FORBIDDEN", e.message);
    case "NOT_FOUND":
      return new NotFoundError("JENKINS_NOT_FOUND", e.message);
    case "BAD_REQUEST":
      return new BadRequestError("JENKINS_BAD_REQUEST", e.message);
    default:
      return new ConflictError("JENKINS_UNAVAILABLE", e.message, { connectionId });
  }
}

/** Câu báo cho nút "Kiểm": lỗi đã biết thành `ok: false` kèm cách sửa, lỗi lạ vẫn ném. */
function failedTest(e: unknown): ConnectionTestResult {
  if (e instanceof JenkinsError) return { ok: false, message: e.message, version: null, user: null };
  if (e instanceof ForbiddenError && e.code === "JENKINS_NO_TOKEN")
    return { ok: false, message: e.message, version: null, user: null };
  throw e;
}

// ---- Kết nối ----------------------------------------------------------------------------------------------------

type ConnectionRow = typeof ciJenkinsConnections.$inferSelect;

async function viewsOf(tx: Tx, rows: ConnectionRow[]): Promise<JenkinsConnection[]> {
  const watcherIds = [...new Set(rows.flatMap((r) => (r.watcherUserId ? [r.watcherUserId] : [])))];
  const names = watcherIds.length
    ? new Map(
        (
          await tx
            .select({ id: authUser.id, name: authUser.name })
            .from(authUser)
            .where(inArray(authUser.id, watcherIds))
        ).map((u) => [u.id, u.name]),
      )
    : new Map<string, string>();
  const withToken = rows.length
    ? new Set(
        (
          await tx
            .select({ connectionId: ciJenkinsUserTokens.connectionId, userId: ciJenkinsUserTokens.userId })
            .from(ciJenkinsUserTokens)
            .where(
              inArray(
                ciJenkinsUserTokens.connectionId,
                rows.map((r) => r.id),
              ),
            )
        ).map((t) => `${t.connectionId}:${t.userId}`),
      )
    : new Set<string>();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    watcher: r.watcherUserId ? { userId: r.watcherUserId, name: names.get(r.watcherUserId) ?? r.watcherUserId } : null,
    watcherHasToken: r.watcherUserId !== null && withToken.has(`${r.id}:${r.watcherUserId}`),
    lastPollAt: r.lastPollAt?.toISOString() ?? null,
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

async function connectionRow(tx: Tx, id: string): Promise<ConnectionRow> {
  const [row] = await tx.select().from(ciJenkinsConnections).where(eq(ciJenkinsConnections.id, id));
  if (!row) throw notFound();
  return row;
}

/** Mọi thành viên xem được: không có bí mật, và người gắn job, thêm token cần biết có kết nối nào. */
export async function listJenkinsConnections(tx: Tx): Promise<JenkinsConnection[]> {
  return viewsOf(tx, await tx.select().from(ciJenkinsConnections).orderBy(ciJenkinsConnections.name));
}

export async function createJenkinsConnection(
  tx: Tx,
  userId: string,
  input: { name: string; url: string },
): Promise<JenkinsConnection> {
  await requireConnectionsManage(tx, userId);
  let row: ConnectionRow | undefined;
  try {
    [row] = await tx
      .insert(ciJenkinsConnections)
      .values({
        orgId: sql`hive.ctx_org()`,
        name: input.name,
        url: input.url,
        watcherUserId: userId,
        createdBy: userId,
      })
      .returning();
  } catch (e) {
    if (pgCode(e) === UNIQUE_VIOLATION) throw nameTaken(input.name);
    throw e;
  }
  if (!row) throw new Error("Không tạo được kết nối Jenkins.");
  await recordAudit(tx, {
    action: "delivery.ci_connection.create",
    targetType: "ci_jenkins_connection",
    targetId: row.id,
    data: { name: row.name, url: row.url },
  });
  const [view] = await viewsOf(tx, [row]);
  return view as JenkinsConnection;
}

export async function updateJenkinsConnection(
  tx: Tx,
  userId: string,
  input: { id: string; name?: string | undefined; url?: string | undefined },
): Promise<JenkinsConnection> {
  await requireConnectionsManage(tx, userId);
  const current = await connectionRow(tx, input.id);
  let row: ConnectionRow | undefined;
  try {
    [row] = await tx
      .update(ciJenkinsConnections)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.url === undefined ? {} : { url: input.url }),
        updatedAt: new Date(),
      })
      .where(eq(ciJenkinsConnections.id, input.id))
      .returning();
  } catch (e) {
    if (pgCode(e) === UNIQUE_VIOLATION) throw nameTaken(input.name ?? current.name);
    throw e;
  }
  if (!row) throw notFound();
  await recordAudit(tx, {
    action: "delivery.ci_connection.update",
    targetType: "ci_jenkins_connection",
    targetId: row.id,
    data: {
      ...(input.name !== undefined && input.name !== current.name
        ? { name: { from: current.name, to: row.name } }
        : {}),
      ...(input.url !== undefined && input.url !== current.url ? { url: { from: current.url, to: row.url } } : {}),
    },
  });
  const [view] = await viewsOf(tx, [row]);
  return view as JenkinsConnection;
}

/** Xoá kết nối; khoá ngoại xoá theo token của mọi người và job đã gắn với dự án. */
export async function removeJenkinsConnection(tx: Tx, userId: string, id: string): Promise<{ id: string }> {
  await requireConnectionsManage(tx, userId);
  const current = await connectionRow(tx, id);
  const [tokens] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(ciJenkinsUserTokens)
    .where(eq(ciJenkinsUserTokens.connectionId, id));
  await tx.delete(ciJenkinsConnections).where(eq(ciJenkinsConnections.id, id));
  await recordAudit(tx, {
    action: "delivery.ci_connection.remove",
    targetType: "ci_jenkins_connection",
    targetId: id,
    data: { name: current.name, url: current.url, tokensRemoved: tokens?.n ?? 0 },
  });
  return { id };
}

/** Kiểm bằng token của người theo dõi, vì đó là token hub dùng để đọc theo lịch. */
export async function testJenkinsConnection(
  tx: Tx,
  deps: JenkinsDeps,
  userId: string,
  id: string,
): Promise<ConnectionTestResult> {
  await requireConnectionsManage(tx, userId);
  await connectionRow(tx, id);
  const masterKey = requireMasterKey(deps);
  try {
    const auth = await jenkinsAuth(tx, masterKey, {
      connectionId: id,
      userId: "watcher",
      reason: "ci.connection.test",
    });
    const me = await jenkinsClient(deps, auth).me();
    return {
      ok: true,
      message: `Đọc được Jenkins bằng token của người theo dõi (${me.id}).`,
      version: null,
      user: me.id,
    };
  } catch (e) {
    return failedTest(e);
  }
}

/** Người theo dõi mới phải còn trong tổ chức và đã có token cho kết nối, nếu không đọc theo lịch sẽ dừng ngay. */
export async function setJenkinsWatcher(
  tx: Tx,
  userId: string,
  input: { id: string; userId: string },
): Promise<JenkinsConnection> {
  await requireConnectionsManage(tx, userId);
  const current = await connectionRow(tx, input.id);
  if (!(await orgRoleOf(tx, input.userId)))
    throw new BadRequestError(
      "WATCHER_NOT_MEMBER",
      "Người được chọn không phải thành viên đang hoạt động của tổ chức.",
    );
  const [token] = await tx
    .select({ id: ciJenkinsUserTokens.id })
    .from(ciJenkinsUserTokens)
    .where(and(eq(ciJenkinsUserTokens.connectionId, input.id), eq(ciJenkinsUserTokens.userId, input.userId)));
  if (!token)
    throw new ConflictError(
      "WATCHER_NO_TOKEN",
      "Người được chọn chưa thêm token Jenkins cho kết nối này. Nhờ họ thêm ở Cài đặt cá nhân → Token Jenkins rồi chọn lại.",
      { connectionId: input.id },
    );
  const [row] = await tx
    .update(ciJenkinsConnections)
    .set({ watcherUserId: input.userId, updatedAt: new Date() })
    .where(eq(ciJenkinsConnections.id, input.id))
    .returning();
  if (!row) throw notFound();
  await recordAudit(tx, {
    action: "delivery.ci_connection.watcher",
    targetType: "ci_jenkins_connection",
    targetId: row.id,
    data: { from: current.watcherUserId, to: input.userId },
  });
  const [view] = await viewsOf(tx, [row]);
  return view as JenkinsConnection;
}

// ---- Token của chính người gọi ----------------------------------------------------------------------------------

type TokenRow = Pick<
  typeof ciJenkinsUserTokens.$inferSelect,
  "jenkinsUser" | "updatedAt" | "lastCheckedAt" | "lastCheckOk"
>;

function tokenItem(conn: Pick<ConnectionRow, "id" | "name" | "url">, token: TokenRow | null): JenkinsTokenItem {
  return {
    connectionId: conn.id,
    connectionName: conn.name,
    url: conn.url,
    token: token
      ? {
          jenkinsUser: token.jenkinsUser,
          updatedAt: token.updatedAt.toISOString(),
          lastCheckedAt: token.lastCheckedAt?.toISOString() ?? null,
          lastCheckOk: token.lastCheckOk,
        }
      : null,
  };
}

const tokenColumns = {
  id: ciJenkinsUserTokens.id,
  jenkinsUser: ciJenkinsUserTokens.jenkinsUser,
  updatedAt: ciJenkinsUserTokens.updatedAt,
  lastCheckedAt: ciJenkinsUserTokens.lastCheckedAt,
  lastCheckOk: ciJenkinsUserTokens.lastCheckOk,
};

async function myToken(tx: Tx, userId: string, connectionId: string) {
  const [row] = await tx
    .select(tokenColumns)
    .from(ciJenkinsUserTokens)
    .where(and(eq(ciJenkinsUserTokens.connectionId, connectionId), eq(ciJenkinsUserTokens.userId, userId)));
  return row ?? null;
}

/** Một dòng mỗi kết nối; chỉ token của chính người gọi, kể cả với quản trị. */
export async function listMyJenkinsTokens(tx: Tx, userId: string): Promise<JenkinsTokenItem[]> {
  const rows = await tx
    .select({
      id: ciJenkinsConnections.id,
      name: ciJenkinsConnections.name,
      url: ciJenkinsConnections.url,
      jenkinsUser: ciJenkinsUserTokens.jenkinsUser,
      updatedAt: ciJenkinsUserTokens.updatedAt,
      lastCheckedAt: ciJenkinsUserTokens.lastCheckedAt,
      lastCheckOk: ciJenkinsUserTokens.lastCheckOk,
    })
    .from(ciJenkinsConnections)
    .leftJoin(
      ciJenkinsUserTokens,
      and(eq(ciJenkinsUserTokens.connectionId, ciJenkinsConnections.id), eq(ciJenkinsUserTokens.userId, userId)),
    )
    .orderBy(ciJenkinsConnections.name);
  return rows.map((r) =>
    tokenItem(
      r,
      r.jenkinsUser !== null && r.updatedAt !== null
        ? {
            jenkinsUser: r.jenkinsUser,
            updatedAt: r.updatedAt,
            lastCheckedAt: r.lastCheckedAt,
            lastCheckOk: r.lastCheckOk,
          }
        : null,
    ),
  );
}

/** Kiểm `/me/api/json` trước khi lưu: token sai thì báo ngay, không để lần bấm build đầu tiên mới lộ ra. */
export async function upsertMyJenkinsToken(
  tx: Tx,
  deps: JenkinsDeps,
  userId: string,
  input: { connectionId: string; jenkinsUser: string; token: string },
): Promise<JenkinsTokenItem> {
  const masterKey = requireMasterKey(deps);
  const conn = await connectionRow(tx, input.connectionId);
  try {
    await jenkinsClient(deps, { baseUrl: conn.url, user: input.jenkinsUser, token: input.token }).me();
  } catch (e) {
    throw jenkinsDomainError(e, conn.id);
  }
  const existing = await myToken(tx, userId, conn.id);
  const id = existing?.id ?? randomUUID();
  const tokenEnc = encryptSecret(masterKey, input.token, jenkinsTokenContext(id));
  const now = new Date();
  const [row] = existing
    ? await tx
        .update(ciJenkinsUserTokens)
        .set({ jenkinsUser: input.jenkinsUser, tokenEnc, lastCheckedAt: now, lastCheckOk: true, updatedAt: now })
        .where(eq(ciJenkinsUserTokens.id, id))
        .returning(tokenColumns)
    : await tx
        .insert(ciJenkinsUserTokens)
        .values({
          id,
          orgId: sql`hive.ctx_org()`,
          connectionId: conn.id,
          userId,
          jenkinsUser: input.jenkinsUser,
          tokenEnc,
          lastCheckedAt: now,
          lastCheckOk: true,
        })
        .returning(tokenColumns);
  if (!row) throw new Error("Không lưu được token Jenkins.");
  await recordAudit(tx, {
    action: existing ? "delivery.ci_token.replace" : "delivery.ci_token.create",
    targetType: "ci_jenkins_user_token",
    targetId: id,
    data: { connectionId: conn.id, jenkinsUser: input.jenkinsUser },
  });
  return tokenItem(conn, row);
}

export async function testMyJenkinsToken(
  tx: Tx,
  deps: JenkinsDeps,
  userId: string,
  connectionId: string,
): Promise<ConnectionTestResult> {
  const masterKey = requireMasterKey(deps);
  await connectionRow(tx, connectionId);
  let result: ConnectionTestResult;
  try {
    const auth = await jenkinsAuth(tx, masterKey, { connectionId, userId, reason: "ci.token.test" });
    const me = await jenkinsClient(deps, auth).me();
    result = { ok: true, message: `Token đăng nhập được Jenkins với user ${me.id}.`, version: null, user: me.id };
  } catch (e) {
    result = failedTest(e);
  }
  await tx
    .update(ciJenkinsUserTokens)
    .set({ lastCheckedAt: new Date(), lastCheckOk: result.ok })
    .where(and(eq(ciJenkinsUserTokens.connectionId, connectionId), eq(ciJenkinsUserTokens.userId, userId)));
  return result;
}

/** Xoá token của mình. Người đang là người theo dõi thì kết nối báo "Chưa có token để đọc Jenkins" tới khi đổi. */
export async function removeMyJenkinsToken(tx: Tx, userId: string, connectionId: string): Promise<{ ok: true }> {
  await connectionRow(tx, connectionId);
  const removed = await tx
    .delete(ciJenkinsUserTokens)
    .where(and(eq(ciJenkinsUserTokens.connectionId, connectionId), eq(ciJenkinsUserTokens.userId, userId)))
    .returning({ id: ciJenkinsUserTokens.id });
  const [row] = removed;
  if (row)
    await recordAudit(tx, {
      action: "delivery.ci_token.remove",
      targetType: "ci_jenkins_user_token",
      targetId: row.id,
      data: { connectionId },
    });
  return { ok: true };
}
