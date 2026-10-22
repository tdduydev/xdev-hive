import { randomUUID } from "node:crypto";
import { DELIVERY_ERRORS, type DeployServer, type ServerTestResult } from "@xdev-hive/contracts";
import { and, eq, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import {
  ConflictError,
  decryptSecret,
  encryptSecret,
  ForbiddenError,
  type Jobs,
  type MasterKey,
  NotFoundError,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import { effectivePermissions, teamMemberIds } from "../tenancy/index.ts";
import { requirePool } from "./ci/feed.ts";
import {
  connectSsh,
  generateServerKey,
  installCommand,
  probeHostKeys,
  SshError,
  type SshTarget,
} from "./clients/ssh.ts";
import { auditSecretUse, type SecretUse } from "./connections/credentials.ts";
import { pgCode, requireMasterKey } from "./connections/jenkins.ts";
import { emitDeliveryEvent } from "./notifications.ts";
import { deployServers, deployTargets, type HostKey } from "./schema.ts";

// Máy chủ SSH của đội (US3, FR-010, FR-011, plan.md mục 5 "Khoá", "Kết nối"). Hub sinh và giữ khoá riêng ed25519, mã
// hoá theo id của dòng; không route nào trả khoá riêng. Mọi lần gọi SSH nằm ngoài transaction: máy chủ chậm 10 giây
// không được giữ kết nối pool. Hàm có SSH tự mở transaction ngắn trước và sau (như ci/actions.ts).

export interface ServersDeps {
  pool?: pg.Pool | undefined;
  masterKey?: MasterKey | undefined;
  jobs?: Jobs | undefined;
  /** Test rút ngắn thời gian chờ bắt tay. */
  sshReadyTimeoutMs?: number | undefined;
}

export interface ServerActor {
  orgId: string;
  userId: string;
}

type Row = typeof deployServers.$inferSelect;

/** Ngữ cảnh mã hoá khoá riêng, cả khoá đang dùng lẫn khoá chờ đổi: bản mã chép sang dòng khác không giải được. */
export const serverKeyContext = (id: string) => `deploy_servers:${id}:key`;

const notFound = () => new NotFoundError("NOT_FOUND", "Không tìm thấy máy chủ.");
const nameTaken = (name: string) =>
  new ConflictError("SERVER_NAME_TAKEN", `Đội đã có máy chủ tên "${name}". Chọn tên khác.`);

function view(r: Row): DeployServer {
  return {
    id: r.id,
    teamId: r.teamId,
    name: r.name,
    host: r.host,
    port: r.port,
    user: r.sshUser,
    labels: r.labels,
    publicKey: r.publicKey,
    installCommand: installCommand(r.publicKey),
    hostKeyFingerprints: r.hostKeys.map((k) => k.fingerprint),
    pendingKey:
      r.pendingPublicKey && r.pendingKeyCreatedAt
        ? {
            publicKey: r.pendingPublicKey,
            installCommand: installCommand(r.pendingPublicKey),
            createdAt: r.pendingKeyCreatedAt.toISOString(),
          }
        : null,
    lastTest: r.lastTestAt
      ? { at: r.lastTestAt.toISOString(), ok: r.lastTestOk ?? false, message: r.lastTestMessage ?? "" }
      : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ---- Quyền ----------------------------------------------------------------------------------------------------------

/** Thiếu `servers.manage`: người xem được (`ci.view`) thì nói rõ thiếu quyền, người không xem được thì như không có. */
async function requireManage(tx: Tx, userId: string, teamId: string): Promise<void> {
  const perms = await effectivePermissions(tx, userId, teamId);
  if (perms.has("servers.manage")) return;
  if (perms.has("ci.view"))
    throw new ForbiddenError("FORBIDDEN", "Cần quyền quản lý máy chủ (servers.manage) của đội để làm việc này.");
  throw notFound();
}

async function rowOf(tx: Tx, id: string): Promise<Row> {
  const [row] = await tx.select().from(deployServers).where(eq(deployServers.id, id));
  if (!row) throw notFound();
  return row;
}

async function manageable(tx: Tx, userId: string, id: string): Promise<Row> {
  const row = await rowOf(tx, id);
  await requireManage(tx, userId, row.teamId);
  return row;
}

// ---- Thêm, sửa, xoá -------------------------------------------------------------------------------------------------

/** Máy chủ của các đội người dùng xem được (`ci.view` hoặc `servers.manage`). */
export async function listServers(
  tx: Tx,
  userId: string,
  input: { teamId?: string | undefined },
): Promise<DeployServer[]> {
  const rows = await tx
    .select()
    .from(deployServers)
    .where(input.teamId ? eq(deployServers.teamId, input.teamId) : undefined)
    .orderBy(deployServers.name);
  const allowed = new Map<string, boolean>();
  for (const teamId of new Set(rows.map((r) => r.teamId))) {
    const perms = await effectivePermissions(tx, userId, teamId);
    allowed.set(teamId, perms.has("ci.view") || perms.has("servers.manage"));
  }
  return rows.filter((r) => allowed.get(r.teamId)).map(view);
}

export interface ServerCreate {
  teamId: string;
  name: string;
  host: string;
  port?: number | undefined;
  user: string;
  labels?: string[] | undefined;
}

export async function createServer(
  tx: Tx,
  deps: ServersDeps,
  userId: string,
  input: ServerCreate,
): Promise<DeployServer> {
  await requireManage(tx, userId, input.teamId);
  const masterKey = requireMasterKey(deps);
  const id = randomUUID();
  const key = generateServerKey();
  let row: Row | undefined;
  try {
    [row] = await tx
      .insert(deployServers)
      .values({
        id,
        orgId: sql`hive.ctx_org()`,
        teamId: input.teamId,
        name: input.name,
        host: input.host,
        port: input.port ?? 22,
        sshUser: input.user,
        labels: [...new Set(input.labels ?? [])],
        // Mã hoá ngay: chuỗi khoá riêng không rời hàm này ở dạng rõ.
        privateKeyEnc: encryptSecret(masterKey, key.privateKey, serverKeyContext(id)),
        publicKey: key.publicKey,
        createdBy: userId,
      })
      .returning();
  } catch (e) {
    if (pgCode(e) === "23505") throw nameTaken(input.name);
    throw e;
  }
  if (!row) throw new Error("Không tạo được máy chủ.");
  await recordAudit(tx, {
    action: "delivery.server.create",
    targetType: "deploy_server",
    targetId: id,
    data: { teamId: row.teamId, name: row.name, host: row.host, port: row.port, user: row.sshUser },
  });
  return view(row);
}

export interface ServerUpdate {
  id: string;
  name?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  user?: string | undefined;
  labels?: string[] | undefined;
}

/** Đổi địa chỉ hay cổng là máy khác: xoá host key đã xác nhận và kết quả kiểm cũ, phải kiểm và xác nhận lại. */
export async function updateServer(tx: Tx, userId: string, input: ServerUpdate): Promise<DeployServer> {
  const current = await manageable(tx, userId, input.id);
  const moved =
    (input.host !== undefined && input.host !== current.host) ||
    (input.port !== undefined && input.port !== current.port);
  let row: Row | undefined;
  try {
    [row] = await tx
      .update(deployServers)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.host === undefined ? {} : { host: input.host }),
        ...(input.port === undefined ? {} : { port: input.port }),
        ...(input.user === undefined ? {} : { sshUser: input.user }),
        ...(input.labels === undefined ? {} : { labels: [...new Set(input.labels)] }),
        ...(moved ? { hostKeys: [], lastTestAt: null, lastTestOk: null, lastTestMessage: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(deployServers.id, input.id))
      .returning();
  } catch (e) {
    if (pgCode(e) === "23505") throw nameTaken(input.name ?? current.name);
    throw e;
  }
  if (!row) throw notFound();
  const changed = (["name", "host", "port", "sshUser"] as const).filter((k) => row[k] !== current[k]);
  await recordAudit(tx, {
    action: "delivery.server.update",
    targetType: "deploy_server",
    targetId: row.id,
    data: {
      ...Object.fromEntries(changed.map((k) => [k, { from: current[k], to: row[k] }])),
      ...(input.labels === undefined ? {} : { labels: row.labels }),
      hostKeysCleared: moved && current.hostKeys.length > 0,
    },
  });
  return view(row);
}

/** Đích còn dùng máy chủ thì không xoá (khoá ngoại cũng chặn): xoá ngầm làm đích hỏng mà không ai biết. */
export async function removeServer(tx: Tx, userId: string, id: string): Promise<{ id: string }> {
  const current = await manageable(tx, userId, id);
  const [used] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(deployTargets)
    .where(eq(deployTargets.serverId, id));
  if (used && used.n > 0)
    throw new ConflictError(
      "SERVER_IN_USE",
      `Còn ${used.n} đích triển khai dùng máy chủ này. Đổi hoặc xoá các đích đó trước.`,
    );
  await tx.delete(deployServers).where(eq(deployServers.id, id));
  await recordAudit(tx, {
    action: "delivery.server.remove",
    targetType: "deploy_server",
    targetId: id,
    data: { teamId: current.teamId, name: current.name, host: current.host, port: current.port },
  });
  return { id };
}

/** Khoá mới vào `pending_*`; khoá cũ vẫn dùng tới khi khoá mới kiểm thành công (US3 bước 4). Bấm lại thì thay khoá chờ. */
export async function rotateServerKey(tx: Tx, deps: ServersDeps, userId: string, id: string): Promise<DeployServer> {
  const current = await manageable(tx, userId, id);
  const masterKey = requireMasterKey(deps);
  const key = generateServerKey();
  const [row] = await tx
    .update(deployServers)
    .set({
      pendingPrivateKeyEnc: encryptSecret(masterKey, key.privateKey, serverKeyContext(id)),
      pendingPublicKey: key.publicKey,
      pendingKeyCreatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(deployServers.id, id))
    .returning();
  if (!row) throw notFound();
  await recordAudit(tx, {
    action: "delivery.server.rotate_key",
    targetType: "deploy_server",
    targetId: id,
    data: { name: row.name, replacedPending: current.pendingPublicKey !== null },
  });
  return view(row);
}

// ---- SSH ------------------------------------------------------------------------------------------------------------

function decryptKey(masterKey: MasterKey, row: Row, which: "current" | "pending"): string {
  const envelope = which === "current" ? row.privateKeyEnc : row.pendingPrivateKeyEnc;
  if (!envelope) throw new ConflictError("NO_PENDING_KEY", "Máy chủ không có khoá mới đang chờ. Bấm Đổi khoá trước.");
  return decryptSecret(masterKey, envelope, serverKeyContext(row.id));
}

function targetOf(row: Row, privateKey: string): SshTarget {
  return { host: row.host, port: row.port, user: row.sshUser, privateKey, hostKeys: row.hostKeys };
}

/**
 * Đích SSH của máy chủ với khoá đang dùng, cho job triển khai. Người gọi đã kiểm quyền; mỗi lần giải mã có audit
 * (gom theo `use.group`).
 */
export async function serverSshTarget(tx: Tx, deps: ServersDeps, serverId: string, use: SecretUse): Promise<SshTarget> {
  const row = await rowOf(tx, serverId);
  const privateKey = decryptKey(requireMasterKey(deps), row, "current");
  await auditSecretUse(tx, { kind: "ssh_key", id: row.id, ...use });
  return targetOf(row, privateKey);
}

/** Host key máy chủ trình ra khác bản đã xác nhận: audit và báo quản trị đội. Host key đã lưu giữ nguyên. */
export async function reportHostKeyChanged(
  tx: Tx,
  deps: ServersDeps,
  orgId: string,
  serverId: string,
  presented: HostKey,
): Promise<void> {
  const [row] = await tx.select().from(deployServers).where(eq(deployServers.id, serverId));
  if (!row) return;
  await recordAudit(tx, {
    action: "delivery.server.hostkey_changed",
    targetType: "deploy_server",
    targetId: row.id,
    data: {
      name: row.name,
      host: row.host,
      port: row.port,
      expected: row.hostKeys.map((k) => k.fingerprint),
      presented: presented.fingerprint,
      algorithm: presented.algorithm,
    },
  });
  await emitDeliveryEvent(
    tx,
    {
      orgId,
      event: "server.hostkey_changed",
      title: `Host key của máy chủ ${row.name} đã đổi`,
      body: `${row.host}:${row.port} trình host key ${presented.fingerprint}, khác dấu vân tay đã xác nhận. Hub dừng mọi lệnh tới máy chủ này cho tới khi quản trị kiểm và xác nhận lại.`,
      // Mỗi dấu vân tay lạ báo một lần, kiểm lại nhiều lần không báo lặp.
      eventKey: `server:${row.id}:hostkey:${presented.fingerprint}`,
      recipientIds: await teamMemberIds(tx, row.teamId, "admin"),
    },
    deps.jobs,
  );
}

const sshCode = (e: SshError) =>
  e.kind === "auth"
    ? "SSH_AUTH_FAILED"
    : e.kind === "hostkey_changed" || e.kind === "hostkey_unconfirmed"
      ? "SSH_HOSTKEY_CHANGED"
      : "SSH_UNREACHABLE";

function sshConflict(e: SshError): ConflictError {
  const code = sshCode(e);
  return new ConflictError(
    code,
    DELIVERY_ERRORS[code].message,
    e.hostKey ? { fingerprint: e.hostKey.fingerprint } : undefined,
  );
}

function sshFailure(e: SshError): Extract<ServerTestResult, { result: "error" }> {
  const code = sshCode(e);
  return {
    result: "error",
    kind: code === "SSH_AUTH_FAILED" ? "auth" : code === "SSH_HOSTKEY_CHANGED" ? "hostkey_changed" : "network",
    // Lỗi mạng giữ câu cụ thể (ECONNREFUSED, hết giờ…) để quản trị biết chặn ở đâu.
    message:
      code === "SSH_UNREACHABLE" ? `${e.message} ${DELIVERY_ERRORS[code].message}` : DELIVERY_ERRORS[code].message,
    ...(e.hostKey ? { fingerprint: e.hostKey.fingerprint } : {}),
  };
}

/** Một lệnh đọc, in `khoá=giá trị` từng dòng. Thiếu Docker hay Compose thì dòng đó rỗng chứ không làm hỏng cả lệnh. */
const INFO_COMMAND = [
  `printf 'os=%s\\n' "$( (. /etc/os-release && printf %s "$PRETTY_NAME") 2>/dev/null || uname -sr)"`,
  `printf 'docker=%s\\n' "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"`,
  `printf 'compose=%s\\n' "$(docker compose version --short 2>/dev/null)"`,
  `printf 'disk=%s\\n' "$(df -Pk ~ 2>/dev/null | awk 'NR==2{print $4}')"`,
].join("; ");

function parseInfo(stdout: string) {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const text = (k: string) => values.get(k) || null;
  const kb = Number(values.get("disk"));
  return {
    os: text("os"),
    docker: text("docker"),
    compose: text("compose"),
    diskFreeBytes: values.get("disk") && Number.isSafeInteger(kb) && kb >= 0 ? kb * 1024 : null,
  };
}

/** Kết nối, chạy lệnh đọc thông tin máy. Trả kết quả lỗi thay vì ném để màn máy chủ hiện đúng loại lỗi. */
async function probeServer(
  deps: ServersDeps,
  target: SshTarget,
  key: "current" | "pending",
): Promise<ServerTestResult> {
  const conn = await connectSsh(target, { readyTimeoutMs: deps.sshReadyTimeoutMs });
  try {
    const out = await conn.exec(INFO_COMMAND, { timeoutMs: 20_000, maxOutputBytes: 64 * 1024 });
    return { result: "ok", fingerprint: conn.hostKey?.fingerprint ?? "", key, ...parseInfo(out.stdout) };
  } finally {
    await conn.close();
  }
}

function testMessage(r: ServerTestResult): string {
  if (r.result === "error") return r.message;
  if (r.result === "hostkey_unconfirmed") return "Chờ quản trị xác nhận dấu vân tay host key.";
  const parts = [
    r.os ?? "không rõ hệ điều hành",
    r.docker ? `Docker ${r.docker}` : "chưa thấy Docker",
    r.compose ? `Compose ${r.compose}` : "chưa thấy Docker Compose",
  ];
  return `Kết nối được: ${parts.join(", ")}.`;
}

async function recordTest(tx: Tx, id: string, r: ServerTestResult): Promise<void> {
  await tx
    .update(deployServers)
    .set({ lastTestAt: new Date(), lastTestOk: r.result === "ok", lastTestMessage: testMessage(r) })
    .where(eq(deployServers.id, id));
}

/**
 * "Kiểm kết nối". Chưa có host key: chỉ dò host key (không gửi khoá, không chạy lệnh), trả dấu vân tay chờ xác nhận.
 * Có rồi: kết nối bằng khoá đang dùng, đọc hệ điều hành, Docker, Compose, đĩa trống.
 */
export async function testServer(
  deps: ServersDeps,
  actor: ServerActor,
  input: { id: string },
): Promise<ServerTestResult> {
  const pool = requirePool(deps);
  const prep = await withTenant(pool, actor, async (tx) => {
    const row = await manageable(tx, actor.userId, input.id);
    if (!row.hostKeys.length) return { row, target: undefined };
    const privateKey = decryptKey(requireMasterKey(deps), row, "current");
    await auditSecretUse(tx, { kind: "ssh_key", id: row.id, reason: "server.test" });
    return { row, target: targetOf(row, privateKey) };
  });

  let result: ServerTestResult;
  let changed: HostKey | undefined;
  try {
    if (!prep.target) {
      const keys = await probeHostKeys(prep.row, { readyTimeoutMs: deps.sshReadyTimeoutMs });
      result = { result: "hostkey_unconfirmed", fingerprints: keys.map((k) => k.fingerprint) };
    } else {
      result = await probeServer(deps, prep.target, "current");
    }
  } catch (e) {
    if (!(e instanceof SshError)) throw e;
    if (e.kind === "hostkey_changed" && e.hostKey) changed = e.hostKey;
    result = sshFailure(e);
  }

  await withTenant(pool, actor, async (tx) => {
    await recordTest(tx, prep.row.id, result);
    if (changed) await reportHostKeyChanged(tx, deps, actor.orgId, prep.row.id, changed);
  });
  return result;
}

/**
 * Lưu dấu vân tay quản trị đã đối chiếu, sau khi dò lại máy chủ: chỉ nhận dấu vân tay máy chủ đang trình ra, kèm thuật
 * toán để lần sau ép đúng loại khoá.
 */
export async function confirmServerHostKey(
  deps: ServersDeps,
  actor: ServerActor,
  input: { id: string; fingerprint: string },
): Promise<DeployServer> {
  const pool = requirePool(deps);
  const before = await withTenant(pool, actor, (tx) => manageable(tx, actor.userId, input.id));
  let keys: HostKey[];
  try {
    keys = await probeHostKeys(before, { readyTimeoutMs: deps.sshReadyTimeoutMs });
  } catch (e) {
    if (e instanceof SshError) throw sshConflict(e);
    throw e;
  }
  const match = keys.find((k) => k.fingerprint === input.fingerprint);
  if (!match)
    throw new ConflictError(
      "SSH_HOSTKEY_CHANGED",
      "Máy chủ không trình dấu vân tay này. Kiểm lại kết nối rồi đối chiếu với `ssh-keygen -lf` trên máy chủ.",
      keys[0] ? { fingerprint: keys[0].fingerprint } : undefined,
    );

  return withTenant(pool, actor, async (tx) => {
    const current = await manageable(tx, actor.userId, input.id);
    // Địa chỉ đổi trong lúc dò: dấu vân tay vừa dò là của máy cũ.
    if (current.host !== before.host || current.port !== before.port)
      throw new ConflictError("SERVER_CHANGED", "Địa chỉ máy chủ vừa được sửa. Kiểm kết nối lại.");
    const [row] = await tx
      .update(deployServers)
      .set({ hostKeys: [match], updatedAt: new Date() })
      .where(eq(deployServers.id, input.id))
      .returning();
    if (!row) throw notFound();
    await recordAudit(tx, {
      action: "delivery.server.confirm_hostkey",
      targetType: "deploy_server",
      targetId: row.id,
      data: {
        fingerprint: match.fingerprint,
        algorithm: match.algorithm,
        previous: current.hostKeys.map((k) => k.fingerprint),
      },
    });
    return view(row);
  });
}

/**
 * Kiểm khoá chờ rồi thay khoá cũ. Kiểm hỏng thì giữ nguyên khoá cũ và báo lỗi: đổi khoá giữa chừng không làm mất đường
 * vào máy chủ.
 */
export async function confirmServerRotation(
  deps: ServersDeps,
  actor: ServerActor,
  input: { id: string },
): Promise<DeployServer> {
  const pool = requirePool(deps);
  const prep = await withTenant(pool, actor, async (tx) => {
    const row = await manageable(tx, actor.userId, input.id);
    if (!row.pendingPrivateKeyEnc)
      throw new ConflictError("NO_PENDING_KEY", "Máy chủ không có khoá mới đang chờ. Bấm Đổi khoá trước.");
    if (!row.hostKeys.length)
      throw new ConflictError(
        "HOSTKEY_UNCONFIRMED",
        "Kiểm kết nối và xác nhận dấu vân tay máy chủ trước khi đổi khoá.",
      );
    const privateKey = decryptKey(requireMasterKey(deps), row, "pending");
    await auditSecretUse(tx, { kind: "ssh_key", id: row.id, reason: "server.rotate_key_confirm" });
    return { row, pendingEnc: row.pendingPrivateKeyEnc, target: targetOf(row, privateKey) };
  });

  let result: ServerTestResult;
  let failure: SshError | undefined;
  try {
    result = await probeServer(deps, prep.target, "pending");
  } catch (e) {
    if (!(e instanceof SshError)) throw e;
    failure = e;
    result = sshFailure(e);
  }

  if (failure) {
    // Không ghi vào "kiểm lần cuối": kết quả đó nói về khoá đang dùng, khoá đang dùng vẫn chạy.
    const hostKey = failure.kind === "hostkey_changed" ? failure.hostKey : undefined;
    if (hostKey)
      await withTenant(pool, actor, (tx) => reportHostKeyChanged(tx, deps, actor.orgId, prep.row.id, hostKey));
    throw sshConflict(failure);
  }

  return withTenant(pool, actor, async (tx) => {
    await recordTest(tx, prep.row.id, result);
    await requireManage(tx, actor.userId, prep.row.teamId);
    // Chỉ thay đúng khoá chờ vừa kiểm: ai bấm "Đổi khoá" lần nữa trong lúc kiểm thì khoá chờ mới chưa được kiểm.
    const [row] = await tx
      .update(deployServers)
      .set({
        privateKeyEnc: sql`${deployServers.pendingPrivateKeyEnc}`,
        publicKey: sql`${deployServers.pendingPublicKey}`,
        pendingPrivateKeyEnc: null,
        pendingPublicKey: null,
        pendingKeyCreatedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(deployServers.id, input.id), eq(deployServers.pendingPrivateKeyEnc, prep.pendingEnc)))
      .returning();
    if (!row) throw new ConflictError("PENDING_KEY_CHANGED", "Khoá chờ vừa được tạo lại. Kiểm và xác nhận lại.");
    await recordAudit(tx, {
      action: "delivery.server.rotate_key_confirm",
      targetType: "deploy_server",
      targetId: row.id,
      data: { name: row.name, oldPublicKey: prep.row.publicKey, newPublicKey: row.publicKey },
    });
    return view(row);
  });
}
