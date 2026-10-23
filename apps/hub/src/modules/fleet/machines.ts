import { type Machine, type MachineKind, machineLabels } from "@xdev-hive/contracts";
import type { WorkerAccountSummary } from "@xdev-hive/contracts/worker-protocol";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { notify } from "../notify/index.ts";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { allowWith, requireTeamRole, teams } from "../tenancy/index.ts";
import { FleetError } from "./errors.ts";
import { machines, machineTokens } from "./schema.ts";
import { latestTokenScores } from "./token-scores.ts";
import { hashToken, MACHINE_PREFIX, withTokenLookup } from "./tokens.ts";

export const toMachine = (m: typeof machines.$inferSelect): Machine => ({
  id: m.id,
  teamId: m.teamId,
  kind: m.kind,
  name: m.name,
  os: m.os,
  version: m.version,
  clis: m.clis,
  capacity: m.capacity,
  status: m.pausedAt ? "paused" : m.status,
  lastSeenAt: m.lastSeenAt?.toISOString() ?? null,
  createdAt: m.createdAt.toISOString(),
  shared: m.shared || m.kind === "host",
  registeredBy: m.registeredBy,
  labels: m.labels,
  labelsOnly: m.labelsOnly,
  capabilities: m.capabilities,
  accounts: m.accounts,
  accountsAt: m.accountsAt?.toISOString() ?? null,
  boundProjects: m.boundProjects,
  fullProjects: m.fullProjects,
});

/**
 * Như toMachine nhưng bỏ tóm tắt gói của máy cá nhân người khác: gói trên máy cá nhân là tài khoản riêng của chủ máy
 * (ADR 0017), quản trị đội không cần biết.
 */
export const toMachineFor = (m: typeof machines.$inferSelect, userId: string): Machine => {
  const out = toMachine(m);
  return m.shared || m.registeredBy === userId ? out : { ...out, accounts: null, accountsAt: null };
};

export async function listMachines(tx: Tx, userId: string, teamId: string): Promise<Machine[]> {
  await allowWith(tx, userId, "machines.read", () => requireTeamRole(tx, userId, teamId, "admin"), teamId);
  const rows = await tx.select().from(machines).where(eq(machines.teamId, teamId)).orderBy(asc(machines.name));
  const scores = await latestTokenScores(
    tx,
    rows.map((m) => m.id),
  );
  return rows.map((m) => ({ ...toMachineFor(m, userId), tokenScore: scores.get(m.id) ?? null }));
}

/**
 * Quản trị đội đặt nhãn máy và cờ "chỉ nhận run có nhãn" (specs/011 FR-041). Áp cho lần giao run kế; run đang chạy
 * không bị ảnh hưởng.
 */
export async function setMachineLabels(
  tx: Tx,
  userId: string,
  machineId: string,
  input: { labels: string[]; labelsOnly: boolean },
): Promise<Machine> {
  const [found] = await tx.select().from(machines).where(eq(machines.id, machineId));
  if (!found) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  await requireTeamRole(tx, userId, found.teamId, "admin");
  if (found.status === "revoked") throw new FleetError("conflict", "MACHINE_REVOKED", "Máy đã bị thu hồi.");
  const labels = machineLabels.parse(input.labels);
  const [row] = await tx
    .update(machines)
    .set({ labels, labelsOnly: input.labelsOnly })
    .where(eq(machines.id, machineId))
    .returning();
  if (!row) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  const same = found.labelsOnly === input.labelsOnly && found.labels.join(",") === labels.join(",");
  if (!same) {
    await recordAudit(tx, {
      action: "machine.labels",
      targetType: "machine",
      targetId: machineId,
      data: { name: row.name, teamId: row.teamId, from: found.labels, to: labels, labelsOnly: input.labelsOnly },
    });
  }
  return toMachineFor(row, userId);
}

/**
 * Thu hồi máy: xoá mọi machine token để lần nối sau bị từ chối, giữ dòng máy để còn lịch sử run. Kết nối WSS đang mở
 * do người gọi đóng (gateway có thể ở tiến trình khác; heartbeat kế tiếp cũng tự đóng khi thấy máy đã bị thu hồi).
 */
export async function revokeMachine(tx: Tx, userId: string, machineId: string): Promise<Machine> {
  const [found] = await tx.select().from(machines).where(eq(machines.id, machineId));
  if (!found) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  await allowWith(
    tx,
    userId,
    "machines.remove",
    () => requireTeamRole(tx, userId, found.teamId, "admin"),
    found.teamId,
  );
  await tx.delete(machineTokens).where(eq(machineTokens.machineId, machineId));
  const [row] = await tx
    .update(machines)
    .set({ status: "revoked", pausedAt: null, revokedAt: found.revokedAt ?? sql`now()` })
    .where(eq(machines.id, machineId))
    .returning();
  if (!row) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  await recordAudit(tx, {
    action: "machine.revoke",
    targetType: "machine",
    targetId: machineId,
    data: { name: row.name, teamId: row.teamId },
  });
  return toMachineFor(row, userId);
}

/**
 * Kiểm quyền và trạng thái trước khi gửi lệnh cập nhật: admin đội, máy chưa thu hồi và đang online. Router gửi gói
 * `update` sau khi commit, như thu hồi; worker tự chờ run đang chạy xong rồi mới cập nhật.
 */
export async function requestMachineUpdate(
  tx: Tx,
  userId: string,
  machineId: string,
  version: string | undefined,
): Promise<Machine> {
  const [found] = await tx.select().from(machines).where(eq(machines.id, machineId));
  if (!found) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  await requireTeamRole(tx, userId, found.teamId, "admin");
  if (found.status === "revoked") throw new FleetError("conflict", "MACHINE_REVOKED", "Máy đã bị thu hồi.");
  if (found.status !== "online")
    throw new FleetError(
      "conflict",
      "MACHINE_OFFLINE",
      "Máy đang mất kết nối. Cập nhật khi máy nối lại, hoặc chạy hive-worker update trên máy.",
    );
  await recordAudit(tx, {
    action: "machine.update",
    targetType: "machine",
    targetId: machineId,
    data: { name: found.name, teamId: found.teamId, from: found.version, to: version ?? "latest" },
  });
  return toMachineFor(found, userId);
}

async function setMachinePaused(tx: Tx, userId: string, machineId: string, paused: boolean): Promise<Machine> {
  const [found] = await tx.select().from(machines).where(eq(machines.id, machineId));
  if (!found) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  await requireTeamRole(tx, userId, found.teamId, "admin");
  if (found.status === "revoked") throw new FleetError("conflict", "MACHINE_REVOKED", "Máy đã bị thu hồi.");
  const [row] = await tx
    .update(machines)
    .set({ pausedAt: paused ? (found.pausedAt ?? sql`now()`) : null })
    .where(eq(machines.id, machineId))
    .returning();
  if (!row) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  if (Boolean(found.pausedAt) !== paused) {
    await recordAudit(tx, {
      action: paused ? "machine.pause" : "machine.resume",
      targetType: "machine",
      targetId: machineId,
      data: { name: row.name, teamId: row.teamId },
    });
  }
  return toMachineFor(row, userId);
}

export async function machineIsPaused(tx: Tx, machineId: string): Promise<boolean> {
  const [row] = await tx
    .select({ pausedAt: machines.pausedAt })
    .from(machines)
    .where(eq(machines.id, machineId))
    .for("update");
  return row?.pausedAt !== null && row?.pausedAt !== undefined;
}

/**
 * Quản trị đội bật dùng chung cho máy (máy chủ của đội), để máy nhận run của đội và của mọi thành viên. Máy cá nhân của
 * ai thì bật cũng là cho cả đội dùng tài khoản CLI trên máy đó, nên chỉ quản trị đội được bật (ADR 0017).
 */
export async function setMachineShared(tx: Tx, userId: string, machineId: string, shared: boolean): Promise<Machine> {
  const [found] = await tx.select().from(machines).where(eq(machines.id, machineId));
  if (!found) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  await requireTeamRole(tx, userId, found.teamId, "admin");
  if (found.status === "revoked") throw new FleetError("conflict", "MACHINE_REVOKED", "Máy đã bị thu hồi.");
  const [row] = await tx.update(machines).set({ shared }).where(eq(machines.id, machineId)).returning();
  if (!row) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  if (found.shared !== shared) {
    await recordAudit(tx, {
      action: shared ? "machine.share" : "machine.unshare",
      targetType: "machine",
      targetId: machineId,
      data: { name: row.name, teamId: row.teamId, registeredBy: row.registeredBy },
    });
  }
  return toMachineFor(row, userId);
}

export const pauseMachine = (tx: Tx, userId: string, machineId: string) =>
  setMachinePaused(tx, userId, machineId, true);

export const resumeMachine = (tx: Tx, userId: string, machineId: string) =>
  setMachinePaused(tx, userId, machineId, false);

/** Máy đã xác thực bằng machine token; gateway giữ thông tin này suốt phiên. */
export interface AuthedMachine {
  id: string;
  orgId: string;
  teamId: string;
  name: string;
  kind: MachineKind;
}

export const FLEET_OFFLINE_QUEUE = "fleet-offline-check";
export const fleetOfflineQueue = {
  name: FLEET_OFFLINE_QUEUE,
  // Giữ mọi lần offline đang chờ; stately sẽ bỏ lần mới nếu máy nối lại rồi mất kết nối trước hạn cũ.
  policy: "singleton",
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
} as const;
export interface FleetOfflineJob {
  orgId: string;
  machineId: string;
  offlineAt: string;
}

/** Tìm máy theo machine token. Trả null khi token sai, đã bị thu hồi, hoặc máy đã bị thu hồi. */
export async function authenticateMachine(pool: pg.Pool, token: string): Promise<AuthedMachine | null> {
  if (!token.startsWith(MACHINE_PREFIX)) return null;
  const hash = hashToken(token);
  const [found] = await withTokenLookup(pool, hash, (tx) =>
    tx
      .select({ machineId: machineTokens.machineId, orgId: machineTokens.orgId })
      .from(machineTokens)
      .where(eq(machineTokens.tokenHash, hash)),
  );
  if (!found) return null;
  const [row] = await withTenant(pool, { orgId: found.orgId }, (tx) =>
    tx
      .select({
        id: machines.id,
        orgId: machines.orgId,
        teamId: machines.teamId,
        name: machines.name,
        kind: machines.kind,
      })
      .from(machines)
      .where(and(eq(machines.id, found.machineId), isNull(machines.revokedAt))),
  );
  return row ?? null;
}

export interface MachineInfo {
  os: string;
  version: string;
  clis: string[];
  capacity: number;
  capabilities: string[];
}

/** Dự án máy đã gắn repo và dự án máy cho toàn quyền (ADR 0020). */
export interface MachineProjects {
  boundProjects: string[];
  fullProjects: string[];
}

/**
 * Ghi máy đang online. Trả null khi máy vừa bị thu hồi, để gateway đóng kết nối. Điều kiện revoked_at is null nằm
 * trong câu UPDATE nên không có khe giữa lúc kiểm và lúc ghi. `shared` để gateway báo cờ trong welcome.
 */
export async function markOnline(
  pool: pg.Pool,
  m: AuthedMachine,
  info?: Partial<MachineInfo & MachineProjects> & { accounts?: WorkerAccountSummary[] | undefined },
): Promise<{ shared: boolean; registeredBy: string | null; capabilities: string[] } | null> {
  const { accounts, ...rest } = info ?? {};
  const rows = await withTenant(pool, { orgId: m.orgId }, (tx) =>
    tx
      .update(machines)
      .set({
        ...rest,
        // Heartbeat thiếu accounts (worker cũ, runner host) thì giữ tóm tắt đã biết.
        ...(accounts ? { accounts, accountsAt: sql`now()` } : {}),
        status: "online",
        lastSeenAt: sql`now()`,
        offlineNotifiedAt: null,
      })
      .where(and(eq(machines.id, m.id), isNull(machines.revokedAt)))
      .returning({ shared: machines.shared, registeredBy: machines.registeredBy, capabilities: machines.capabilities }),
  );
  return rows[0] ?? null;
}

/** Ghi máy offline khi kết nối đóng. Không đụng máy đã bị thu hồi. */
export async function markOffline(
  pool: pg.Pool,
  m: AuthedMachine,
  opts: { jobs?: Jobs | undefined; notifyAfterSec?: number | undefined } = {},
): Promise<void> {
  await withTenant(pool, { orgId: m.orgId }, async (tx) => {
    const [row] = await tx
      .update(machines)
      // Payload JSON giữ mili giây; làm tròn timestamp để job không mất micro giây khi so sánh lúc xử lý.
      .set({
        status: "offline",
        lastSeenAt: sql`date_trunc('milliseconds', now())`,
        offlineNotifiedAt: null,
      })
      .where(and(eq(machines.id, m.id), eq(machines.status, "online"), isNull(machines.revokedAt)))
      .returning({ offlineAt: machines.lastSeenAt });
    if (!row?.offlineAt || !opts.jobs) return;
    const offlineAt = row.offlineAt.toISOString();
    await opts.jobs.enqueue<FleetOfflineJob>(
      FLEET_OFFLINE_QUEUE,
      { orgId: m.orgId, machineId: m.id, offlineAt },
      {
        tx,
        singletonKey: m.id,
        startAfter: new Date(row.offlineAt.getTime() + (opts.notifyAfterSec ?? 300) * 1000),
      },
    );
  });
}

export async function checkMachineOffline(
  pool: pg.Pool,
  publicUrl: string,
  job: FleetOfflineJob,
  opts: { jobs?: Jobs | undefined; notifyAfterSec?: number | undefined } = {},
): Promise<void> {
  const offlineAt = new Date(job.offlineAt);
  const delayMinutes = Math.max(1, Math.ceil((opts.notifyAfterSec ?? 300) / 60));
  await withTenant(pool, { orgId: job.orgId }, async (tx) => {
    const [row] = await tx
      .select({ name: machines.name, teamName: teams.name })
      .from(machines)
      .innerJoin(teams, eq(teams.id, machines.teamId))
      .where(
        and(
          eq(machines.id, job.machineId),
          eq(machines.status, "offline"),
          isNull(machines.revokedAt),
          lte(machines.lastSeenAt, offlineAt),
          isNull(machines.offlineNotifiedAt),
        ),
      );
    if (!row) return;
    const [claimed] = await tx
      .update(machines)
      .set({ offlineNotifiedAt: sql`now()` })
      .where(
        and(
          eq(machines.id, job.machineId),
          eq(machines.status, "offline"),
          isNull(machines.revokedAt),
          lte(machines.lastSeenAt, offlineAt),
          isNull(machines.offlineNotifiedAt),
        ),
      )
      .returning({ id: machines.id });
    if (!claimed) return;
    await notify(
      tx,
      {
        orgId: job.orgId,
        event: "machine.offline",
        eventKey: `${job.machineId}:${job.offlineAt}`,
        title: `Máy ${row.name} mất kết nối hơn ${delayMinutes} phút`,
        body: `Đội ${row.teamName}.`,
        link: `${publicUrl.replace(/\/+$/, "")}/admin/machines`,
      },
      { jobs: opts.jobs },
    );
  });
}

export async function registerFleetOfflineWorker(
  jobs: Jobs,
  deps: {
    pool: pg.Pool;
    publicUrl: string;
    notifyAfterSec?: number | undefined;
  },
): Promise<void> {
  await jobs.work<FleetOfflineJob>(FLEET_OFFLINE_QUEUE, (job) =>
    checkMachineOffline(deps.pool, deps.publicUrl, job.data, {
      jobs,
      notifyAfterSec: deps.notifyAfterSec,
    }),
  );
}

/** Máy đang online của đội, để module runs chọn máy giao job. Máy bị thu hồi không có mặt. */
export async function listOnlineMachines(
  tx: Tx,
  teamId: string,
  kind: MachineKind = "worker",
): Promise<
  Array<
    {
      id: string;
      name: string;
      clis: string[];
      capacity: number;
      capabilities: string[];
      shared: boolean;
      registeredBy: string | null;
      /** Nhãn do quản trị đặt (specs/011 D13); hub lọc run có `required_labels`, không qua giao thức worker. */
      labels: string[];
      labelsOnly: boolean;
    } & MachineProjects
  >
> {
  return tx
    .select({
      id: machines.id,
      name: machines.name,
      clis: machines.clis,
      capacity: machines.capacity,
      capabilities: machines.capabilities,
      shared: machines.shared,
      registeredBy: machines.registeredBy,
      labels: machines.labels,
      labelsOnly: machines.labelsOnly,
      boundProjects: machines.boundProjects,
      fullProjects: machines.fullProjects,
    })
    .from(machines)
    .where(
      and(
        eq(machines.teamId, teamId),
        eq(machines.kind, kind),
        eq(machines.status, "online"),
        isNull(machines.pausedAt),
        isNull(machines.revokedAt),
      ),
    )
    .orderBy(asc(machines.lastSeenAt));
}

/** Tên của các máy trong tổ chức của context (kể cả máy đã thu hồi), để hiện kèm run. */
export async function machineNames(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: machines.id, name: machines.name })
    .from(machines)
    .where(inArray(machines.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Máy worker người dùng đã đăng ký (chưa thu hồi), máy thấy gần nhất trước: trợ lý tài liệu chạy trên máy của chính họ. */
export async function machinesOfUser(tx: Tx, userId: string) {
  return tx
    .select({
      id: machines.id,
      teamId: machines.teamId,
      name: machines.name,
      clis: machines.clis,
      capabilities: machines.capabilities,
      online: sql<boolean>`${machines.status} = 'online' and ${machines.pausedAt} is null`,
    })
    .from(machines)
    .where(and(eq(machines.registeredBy, userId), eq(machines.kind, "worker"), isNull(machines.revokedAt)))
    .orderBy(desc(machines.lastSeenAt));
}

/**
 * Máy mà lần ghi của người dùng khai trong `X-Hive-Machine` (specs/027): chỉ nhận máy chính họ đăng ký và chưa thu hồi,
 * để không ai gắn lần ghi của mình vào máy người khác trong lịch sử task.
 */
export async function clientMachineOf(tx: Tx, userId: string, machineId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: machines.id })
    .from(machines)
    .where(and(eq(machines.id, machineId), eq(machines.registeredBy, userId), isNull(machines.revokedAt)));
  return row?.id ?? null;
}

/**
 * Quota tài khoản CLI trên máy của chính người dùng (ADR 0017: máy cá nhân chỉ chủ thấy tài khoản), cho lệnh /quota của
 * chat. Chỉ tóm tắt worker báo, không chứa token.
 */
export async function machineQuotas(tx: Tx, userId: string) {
  return tx
    .select({
      id: machines.id,
      name: machines.name,
      online: sql<boolean>`${machines.status} = 'online' and ${machines.pausedAt} is null`,
      accounts: machines.accounts,
      accountsAt: machines.accountsAt,
    })
    .from(machines)
    .where(and(eq(machines.registeredBy, userId), eq(machines.kind, "worker"), isNull(machines.revokedAt)))
    .orderBy(desc(machines.lastSeenAt));
}

/**
 * Máy dùng chung của đội cho terminal Leader (specs/010 lát đầu): máy worker chưa thu hồi, kèm trạng thái, capability,
 * dự án đã gắn và tóm tắt gói. Máy cá nhân không có ở đây: chưa mở được từ xa khi chưa có passkey (FR-012).
 */
export async function sharedWorkerMachines(tx: Tx, teamId: string) {
  return tx
    .select({
      id: machines.id,
      teamId: machines.teamId,
      name: machines.name,
      capabilities: machines.capabilities,
      boundProjects: machines.boundProjects,
      fullProjects: machines.fullProjects,
      accounts: machines.accounts,
      online: sql<boolean>`${machines.status} = 'online' and ${machines.pausedAt} is null`,
    })
    .from(machines)
    .where(
      and(
        eq(machines.teamId, teamId),
        eq(machines.kind, "worker"),
        eq(machines.shared, true),
        isNull(machines.revokedAt),
      ),
    )
    .orderBy(machines.name);
}

/** Máy trong tổ chức của context (kể cả offline), để kiểm máy người dùng chỉ định khi giao run. */
export async function findMachine(
  tx: Tx,
  id: string,
): Promise<
  | ({
      id: string;
      teamId: string;
      kind: MachineKind;
      revoked: boolean;
      shared: boolean;
      registeredBy: string | null;
    } & MachineProjects)
  | null
> {
  const [row] = await tx
    .select({
      id: machines.id,
      teamId: machines.teamId,
      kind: machines.kind,
      revokedAt: machines.revokedAt,
      shared: machines.shared,
      registeredBy: machines.registeredBy,
      boundProjects: machines.boundProjects,
      fullProjects: machines.fullProjects,
    })
    .from(machines)
    .where(eq(machines.id, id));
  return row
    ? {
        id: row.id,
        teamId: row.teamId,
        kind: row.kind,
        revoked: row.revokedAt !== null,
        shared: row.shared,
        registeredBy: row.registeredBy,
        boundProjects: row.boundProjects,
        fullProjects: row.fullProjects,
      }
    : null;
}

/**
 * Máy worker (chưa thu hồi, kể cả offline) của đội đã bật toàn quyền cho dự án tại máy, để kiểm lúc giao run
 * Antigravity khi dự án không cho toàn quyền (ADR 0020). Run vẫn chờ tới khi một máy như vậy online.
 */
export async function machinesGrantingFull(
  tx: Tx,
  teamId: string,
  projectId: string,
): Promise<Array<{ id: string; shared: boolean; registeredBy: string | null }>> {
  return tx
    .select({ id: machines.id, shared: machines.shared, registeredBy: machines.registeredBy })
    .from(machines)
    .where(
      and(
        eq(machines.teamId, teamId),
        eq(machines.kind, "worker"),
        isNull(machines.revokedAt),
        sql`${projectId} = any(${machines.fullProjects})`,
      ),
    );
}

/**
 * Máy theo id hoặc theo tên (worker gửi tên trong hello; app desktop chỉ biết cái nó đã đăng ký). Máy đã thu hồi vẫn
 * trả về để còn xem các run cũ của nó.
 */
export async function findMachineByRef(
  tx: Tx,
  ref: string,
): Promise<{ id: string; teamId: string; name: string } | null> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  const [row] = await tx
    .select({ id: machines.id, teamId: machines.teamId, name: machines.name })
    .from(machines)
    .where(uuid ? eq(machines.id, ref) : eq(machines.name, ref))
    .orderBy(desc(machines.lastSeenAt))
    .limit(1);
  return row ?? null;
}
