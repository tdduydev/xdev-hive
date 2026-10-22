import { randomUUID } from "node:crypto";
import type {
  ConnectionTestResult,
  InfraConnection,
  InfraConnectionCreateInput,
  InfraConnectionKind,
} from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit/index.ts";
import { BadRequestError, ConflictError, encryptSecret, NotFoundError, type Tx } from "../../platform/index.ts";
import { ArgoCdError, createArgoCdClient } from "../clients/argocd.ts";
import { createKubeClient, KubeError } from "../clients/kube.ts";
import { deployConnections, deployTargets } from "../schema.ts";
import { infraAuth, infraTokenContext } from "./credentials.ts";
import { type JenkinsDeps, pgCode, requireConnectionsManage, requireMasterKey } from "./jenkins.ts";

// Kết nối Argo CD và Kubernetes: một token chung của tổ chức mỗi kết nối (plan.md "Quyết định của người viết"). Token
// mã hoá theo id của dòng; CA không phải bí mật nên trả lại được.

export type InfraDeps = JenkinsDeps;

const notFound = () => new NotFoundError("NOT_FOUND", "Không tìm thấy kết nối Argo CD hoặc Kubernetes.");
const nameTaken = (name: string) =>
  new ConflictError("CONNECTION_NAME_TAKEN", `Tổ chức đã có kết nối tên "${name}". Chọn tên khác.`);

type Row = typeof deployConnections.$inferSelect;

function view(r: Row): InfraConnection {
  return {
    id: r.id,
    kind: r.kind as InfraConnectionKind,
    name: r.name,
    url: r.url,
    caPem: r.caPem,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function rowOf(tx: Tx, id: string): Promise<Row> {
  const [row] = await tx.select().from(deployConnections).where(eq(deployConnections.id, id));
  if (!row) throw notFound();
  return row;
}

/** Mọi thành viên xem được (không có token): người khai báo đích cần chọn kết nối. */
export async function listInfraConnections(tx: Tx): Promise<InfraConnection[]> {
  return (await tx.select().from(deployConnections).orderBy(deployConnections.name)).map(view);
}

export async function createInfraConnection(
  tx: Tx,
  deps: InfraDeps,
  userId: string,
  input: InfraConnectionCreateInput,
): Promise<InfraConnection> {
  await requireConnectionsManage(tx, userId);
  const masterKey = requireMasterKey(deps);
  const id = randomUUID();
  let row: Row | undefined;
  try {
    [row] = await tx
      .insert(deployConnections)
      .values({
        id,
        orgId: sql`hive.ctx_org()`,
        kind: input.kind,
        name: input.name,
        url: input.url,
        caPem: input.kind === "kubernetes" ? (input.caPem ?? null) : null,
        tokenEnc: encryptSecret(masterKey, input.token, infraTokenContext(id)),
        createdBy: userId,
      })
      .returning();
  } catch (e) {
    if (pgCode(e) === "23505") throw nameTaken(input.name);
    throw e;
  }
  if (!row) throw new Error("Không tạo được kết nối.");
  await recordAudit(tx, {
    action: "delivery.infra_connection.create",
    targetType: "deploy_connection",
    targetId: id,
    data: { kind: row.kind, name: row.name, url: row.url, hasCa: row.caPem !== null },
  });
  return view(row);
}

export async function updateInfraConnection(
  tx: Tx,
  deps: InfraDeps,
  userId: string,
  input: {
    id: string;
    name?: string | undefined;
    url?: string | undefined;
    caPem?: string | null | undefined;
    token?: string | undefined;
  },
): Promise<InfraConnection> {
  await requireConnectionsManage(tx, userId);
  const current = await rowOf(tx, input.id);
  // Client Argo CD dùng kho CA của hệ điều hành; nhận CA rồi lặng lẽ bỏ qua sẽ làm người dùng tưởng đã cấu hình.
  if (current.kind === "argocd" && typeof input.caPem === "string")
    throw new BadRequestError("CA_NOT_SUPPORTED", "Kết nối Argo CD không dùng CA riêng. Bỏ trống ô CA.");
  const tokenEnc =
    input.token === undefined
      ? undefined
      : encryptSecret(requireMasterKey(deps), input.token, infraTokenContext(current.id));
  let row: Row | undefined;
  try {
    [row] = await tx
      .update(deployConnections)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.caPem === undefined ? {} : { caPem: input.caPem }),
        ...(tokenEnc === undefined ? {} : { tokenEnc }),
        updatedAt: new Date(),
      })
      .where(eq(deployConnections.id, input.id))
      .returning();
  } catch (e) {
    if (pgCode(e) === "23505") throw nameTaken(input.name ?? current.name);
    throw e;
  }
  if (!row) throw notFound();
  await recordAudit(tx, {
    action: "delivery.infra_connection.update",
    targetType: "deploy_connection",
    targetId: row.id,
    // Chỉ ghi có thay token và CA hay không, không ghi giá trị.
    data: {
      kind: row.kind,
      ...(input.name !== undefined && input.name !== current.name
        ? { name: { from: current.name, to: row.name } }
        : {}),
      ...(input.url !== undefined && input.url !== current.url ? { url: { from: current.url, to: row.url } } : {}),
      caChanged: input.caPem !== undefined && input.caPem !== current.caPem,
      tokenReplaced: input.token !== undefined,
    },
  });
  return view(row);
}

/** Đích còn dùng kết nối thì không xoá: xoá ngầm làm đích hỏng mà không ai biết (khoá ngoại cũng chặn). */
export async function removeInfraConnection(tx: Tx, userId: string, id: string): Promise<{ id: string }> {
  await requireConnectionsManage(tx, userId);
  const current = await rowOf(tx, id);
  const [used] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(deployTargets)
    .where(eq(deployTargets.connectionId, id));
  if (used && used.n > 0)
    throw new ConflictError(
      "CONNECTION_IN_USE",
      `Còn ${used.n} đích triển khai dùng kết nối này. Đổi hoặc xoá các đích đó trước.`,
    );
  await tx.delete(deployConnections).where(eq(deployConnections.id, id));
  await recordAudit(tx, {
    action: "delivery.infra_connection.remove",
    targetType: "deploy_connection",
    targetId: id,
    data: { kind: current.kind, name: current.name, url: current.url },
  });
  return { id };
}

/** Một lệnh đọc: Argo CD liệt kê một ứng dụng (cần token đúng), Kubernetes đọc `/version` (chứng minh nối được, tin CA). */
export async function testInfraConnection(
  tx: Tx,
  deps: InfraDeps,
  userId: string,
  id: string,
): Promise<ConnectionTestResult> {
  await requireConnectionsManage(tx, userId);
  await rowOf(tx, id);
  const auth = await infraAuth(tx, requireMasterKey(deps), id, { reason: "infra.connection.test" });
  try {
    if (auth.kind === "argocd") {
      const argo = createArgoCdClient({
        baseUrl: auth.url,
        token: auth.token,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      const apps = await argo.listApplications(1);
      const version = await argo
        .version()
        .then((v) => v.version || null)
        .catch(() => null);
      return { ok: true, message: `Đọc được Argo CD: token thấy ${apps.total} ứng dụng.`, version };
    }
    const kube = createKubeClient({ baseUrl: auth.url, token: auth.token, ...(auth.caPem ? { ca: auth.caPem } : {}) });
    const v = await kube.version();
    return {
      ok: true,
      message: "Nối được API Kubernetes và tin chứng chỉ. Quyền của token được kiểm khi khai báo đích.",
      version: v.gitVersion || null,
    };
  } catch (e) {
    if (e instanceof ArgoCdError || e instanceof KubeError) return { ok: false, message: e.message, version: null };
    // URL sai dạng: lỗi của dữ liệu đã lưu, báo tại chỗ như các lỗi khác.
    if (e instanceof TypeError)
      return { ok: false, message: `Địa chỉ kết nối không hợp lệ: ${e.message}`, version: null };
    throw e;
  }
}
