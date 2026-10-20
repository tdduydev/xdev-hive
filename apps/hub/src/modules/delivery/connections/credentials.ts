import { DELIVERY_ERRORS, type InfraConnectionKind } from "@xdev-hive/contracts";
import { and, eq } from "drizzle-orm";
import { auditByData, recordAudit } from "../../audit/index.ts";
import { decryptSecret, ForbiddenError, type MasterKey, NotFoundError, type Tx } from "../../platform/index.ts";
import { ciJenkinsConnections, ciJenkinsUserTokens, deployConnections } from "../schema.ts";

// Giải mã token chỉ ở đây và chỉ trong bộ nhớ: không trả ra API, không ghi log. Mỗi lần dùng để lại dấu audit
// `delivery.secret_used` (plan.md mục 9).

export const jenkinsTokenContext = (id: string) => `ci_jenkins_user_tokens:${id}`;
export const infraTokenContext = (id: string) => `deploy_connections:${id}`;

export const SECRET_USED_ACTION = "delivery.secret_used";

export interface SecretUse {
  /** Việc cần secret, ghi vào audit (vd. `ci.retry`, `deploy.start`, `ci.poll`). */
  reason: string;
  /**
   * Gom các lần dùng cùng secret trong một nhóm thành một dòng audit, vd. `deploy:<id>` cho mọi lần đọc trong một lần
   * triển khai, để job theo dõi chạy 2 giây một lần không làm phình audit. Bỏ trống thì mỗi lần dùng một dòng.
   */
  group?: string | undefined;
}

export interface JenkinsAuth {
  connectionId: string;
  baseUrl: string;
  user: string;
  token: string;
  /** Người sở hữu token; thao tác ghi trên Jenkins mang tên người này. */
  userId: string;
}

export interface JenkinsAuthInput extends SecretUse {
  connectionId: string;
  /**
   * Id người bấm: chỉ lấy token của chính người đó, không mượn token người khác. `"watcher"` là token của người theo
   * dõi kết nối, chỉ dùng cho đọc theo lịch.
   */
  userId: string | "watcher";
}

/** Lấy user và token Jenkins để gọi API. Không có token phù hợp thì `JENKINS_NO_TOKEN`. */
export async function jenkinsAuth(tx: Tx, masterKey: MasterKey, input: JenkinsAuthInput): Promise<JenkinsAuth> {
  const [conn] = await tx
    .select({ url: ciJenkinsConnections.url, watcherUserId: ciJenkinsConnections.watcherUserId })
    .from(ciJenkinsConnections)
    .where(eq(ciJenkinsConnections.id, input.connectionId));
  if (!conn) throw new NotFoundError("NOT_FOUND", "Không tìm thấy kết nối Jenkins.");
  const ownerId = input.userId === "watcher" ? conn.watcherUserId : input.userId;
  if (!ownerId) throw noToken();
  const [row] = await tx
    .select({
      id: ciJenkinsUserTokens.id,
      jenkinsUser: ciJenkinsUserTokens.jenkinsUser,
      tokenEnc: ciJenkinsUserTokens.tokenEnc,
    })
    .from(ciJenkinsUserTokens)
    .where(and(eq(ciJenkinsUserTokens.connectionId, input.connectionId), eq(ciJenkinsUserTokens.userId, ownerId)));
  if (!row) throw noToken();
  const token = decryptSecret(masterKey, row.tokenEnc, jenkinsTokenContext(row.id));
  await auditSecretUse(tx, { kind: "jenkins_token", id: row.id, ...input });
  return { connectionId: input.connectionId, baseUrl: conn.url, user: row.jenkinsUser, token, userId: ownerId };
}

export interface InfraAuth {
  connectionId: string;
  kind: InfraConnectionKind;
  url: string;
  caPem: string | null;
  token: string;
}

/** Token của kết nối Argo CD hoặc Kubernetes. */
export async function infraAuth(
  tx: Tx,
  masterKey: MasterKey,
  connectionId: string,
  use: SecretUse,
): Promise<InfraAuth> {
  const [row] = await tx
    .select({
      kind: deployConnections.kind,
      url: deployConnections.url,
      caPem: deployConnections.caPem,
      tokenEnc: deployConnections.tokenEnc,
    })
    .from(deployConnections)
    .where(eq(deployConnections.id, connectionId));
  if (!row) throw new NotFoundError("NOT_FOUND", "Không tìm thấy kết nối Argo CD hoặc Kubernetes.");
  const token = decryptSecret(masterKey, row.tokenEnc, infraTokenContext(connectionId));
  await auditSecretUse(tx, { kind: "infra_token", id: connectionId, ...use });
  return { connectionId, kind: row.kind as InfraConnectionKind, url: row.url, caPem: row.caPem, token };
}

function noToken(): ForbiddenError {
  return new ForbiddenError("JENKINS_NO_TOKEN", DELIVERY_ERRORS.JENKINS_NO_TOKEN.message);
}

/** Ghi dấu dùng secret; trong một nhóm thì chỉ lần đầu với mỗi secret. Khoá SSH của máy chủ cũng ghi qua đây. */
export async function auditSecretUse(
  tx: Tx,
  use: SecretUse & { kind: "jenkins_token" | "infra_token" | "ssh_key"; id: string },
): Promise<void> {
  if (use.group) {
    const seen = await auditByData(tx, { actionLike: SECRET_USED_ACTION, key: "group", value: use.group, limit: 100 });
    if (seen.some((r) => r.data.kind === use.kind && r.data.id === use.id)) return;
  }
  await recordAudit(tx, {
    action: SECRET_USED_ACTION,
    targetType: use.kind,
    targetId: use.id,
    data: { kind: use.kind, id: use.id, reason: use.reason, ...(use.group ? { group: use.group } : {}) },
  });
}
