import type { Machine } from "@xdev-hive/contracts";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { notify } from "../notify/index.ts";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { requireTeamRole, teams } from "../tenancy/index.ts";
import { FleetError } from "./errors.ts";
import { machines, machineTokens } from "./schema.ts";
import { hashToken, MACHINE_PREFIX, withTokenLookup } from "./tokens.ts";

export const toMachine = (m: typeof machines.$inferSelect): Machine => ({
  id: m.id,
  teamId: m.teamId,
  name: m.name,
  os: m.os,
  version: m.version,
  clis: m.clis,
  capacity: m.capacity,
  status: m.status,
  lastSeenAt: m.lastSeenAt?.toISOString() ?? null,
  createdAt: m.createdAt.toISOString(),
});

export async function listMachines(tx: Tx, userId: string, teamId: string): Promise<Machine[]> {
  await requireTeamRole(tx, userId, teamId, "admin");
  const rows = await tx.select().from(machines).where(eq(machines.teamId, teamId)).orderBy(asc(machines.name));
  return rows.map(toMachine);
}

/**
 * Thu hồi máy: xoá mọi machine token để lần nối sau bị từ chối, giữ dòng máy để còn lịch sử run. Kết nối WSS đang mở
 * do người gọi đóng (gateway có thể ở tiến trình khác; heartbeat kế tiếp cũng tự đóng khi thấy máy đã bị thu hồi).
 */
export async function revokeMachine(tx: Tx, userId: string, machineId: string): Promise<Machine> {
  const [found] = await tx.select().from(machines).where(eq(machines.id, machineId));
  if (!found) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  await requireTeamRole(tx, userId, found.teamId, "admin");
  await tx.delete(machineTokens).where(eq(machineTokens.machineId, machineId));
  const [row] = await tx
    .update(machines)
    .set({ status: "revoked", revokedAt: found.revokedAt ?? sql`now()` })
    .where(eq(machines.id, machineId))
    .returning();
  if (!row) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  await recordAudit(tx, {
    action: "machine.revoke",
    targetType: "machine",
    targetId: machineId,
    data: { name: row.name, teamId: row.teamId },
  });
  return toMachine(row);
}

/** Máy đã xác thực bằng machine token; gateway giữ thông tin này suốt phiên. */
export interface AuthedMachine {
  id: string;
  orgId: string;
  teamId: string;
  name: string;
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
      .select({ id: machines.id, orgId: machines.orgId, teamId: machines.teamId, name: machines.name })
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
}

/**
 * Ghi máy đang online. Trả false khi máy vừa bị thu hồi, để gateway đóng kết nối. Điều kiện revoked_at is null nằm
 * trong câu UPDATE nên không có khe giữa lúc kiểm và lúc ghi.
 */
export async function markOnline(pool: pg.Pool, m: AuthedMachine, info?: MachineInfo): Promise<boolean> {
  const rows = await withTenant(pool, { orgId: m.orgId }, (tx) =>
    tx
      .update(machines)
      .set({ ...info, status: "online", lastSeenAt: sql`now()`, offlineNotifiedAt: null })
      .where(and(eq(machines.id, m.id), isNull(machines.revokedAt)))
      .returning({ id: machines.id }),
  );
  return rows.length > 0;
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
      .set({ status: "offline", lastSeenAt: sql`date_trunc('milliseconds', now())`, offlineNotifiedAt: null })
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
): Promise<Array<{ id: string; name: string; clis: string[]; capacity: number }>> {
  return tx
    .select({ id: machines.id, name: machines.name, clis: machines.clis, capacity: machines.capacity })
    .from(machines)
    .where(and(eq(machines.teamId, teamId), eq(machines.status, "online"), isNull(machines.revokedAt)))
    .orderBy(asc(machines.lastSeenAt));
}

/** Máy trong tổ chức của context (kể cả offline), để kiểm máy người dùng chỉ định khi giao run. */
export async function findMachine(
  tx: Tx,
  id: string,
): Promise<{ id: string; teamId: string; revoked: boolean } | null> {
  const [row] = await tx
    .select({ id: machines.id, teamId: machines.teamId, revokedAt: machines.revokedAt })
    .from(machines)
    .where(eq(machines.id, id));
  return row ? { id: row.id, teamId: row.teamId, revoked: row.revokedAt !== null } : null;
}
