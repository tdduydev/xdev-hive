import type { WorkerToHub } from "@xdev-hive/contracts/worker-protocol";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import type { AuthedMachine } from "../fleet/index.ts";
import { type Tx, withTenant } from "../platform/index.ts";
import { closeMachineViewers } from "./close.ts";
import { liveSession, untrackSession } from "./live.ts";
import { machineOwner, personal } from "./record.ts";
import { machineRemoteState, remoteDevices, terminalSessions } from "./schema.ts";
import { endSession } from "./service.ts";
import { auditTotpState } from "./totp.ts";

/**
 * Bản sao trên hub của trạng thái từ xa tại máy (`term_state`, specs/010 T021). Nguồn thật là `remote.json` trên máy;
 * hub chỉ giữ để điện thoại thấy khi máy offline và ghi audit những gì chủ máy làm tại máy (`data.source = "machine"`).
 */

type State = Extract<WorkerToHub, { type: "term_state" }>;

/** Khoá TOTP mà worker không báo hạn (worker cũ): coi như khoá tới mức trần (1 giờ) để web không mời nhập mã. */
const LOCK_FALLBACK_MS = 60 * 60 * 1000;

export async function recordState(pool: pg.Pool, machine: AuthedMachine, msg: State): Promise<void> {
  const { ended, disabled } = await withTenant(pool, { orgId: machine.orgId }, async (tx) => {
    const owner = await machineOwner(tx, machine.id);
    // Máy dùng chung không có phần từ xa (worker cũng từ chối bật): bỏ qua thay vì lưu trạng thái giả.
    if (!personal(owner)) return { ended: [], disabled: false };
    const actor = owner.ownerUserId;
    const [prev] = await tx.select().from(machineRemoteState).where(eq(machineRemoteState.machineId, machine.id));
    const now = new Date();
    const lockedUntil = msg.totp.locked
      ? msg.totp.lockedUntil
        ? new Date(msg.totp.lockedUntil)
        : new Date(now.getTime() + LOCK_FALLBACK_MS)
      : null;
    const values = {
      enabled: msg.enabled,
      roots: msg.roots,
      clis: msg.clis,
      accounts: msg.accounts,
      totpEnabled: msg.totp.enabled,
      totpLockedUntil: lockedUntil,
      confirmOnMachine: msg.confirmOnMachine,
      updatedAt: now,
    };
    await tx
      .insert(machineRemoteState)
      .values({ machineId: machine.id, orgId: machine.orgId, ...values })
      .onConflictDoUpdate({ target: machineRemoteState.machineId, set: values });

    const audit = (action: string, data: Record<string, unknown>) =>
      recordAudit(tx, {
        action,
        actorUserId: actor,
        targetType: "machine",
        targetId: machine.id,
        data: { source: "machine", ...data },
      });
    if ((prev?.enabled ?? false) !== msg.enabled) {
      await audit(msg.enabled ? "terminal.remote_enable" : "terminal.remote_disable", {});
    }
    const before = new Map((prev?.roots ?? []).map((r) => [r.id, r.label]));
    const after = new Set(msg.roots.map((r) => r.id));
    for (const r of msg.roots)
      if (!before.has(r.id)) await audit("terminal.root_add", { rootId: r.id, label: r.label });
    for (const [id, label] of before) if (!after.has(id)) await audit("terminal.root_remove", { rootId: id, label });
    await auditTotpState(
      prev ? { enabled: prev.totpEnabled, lockedUntil: prev.totpLockedUntil } : null,
      { enabled: msg.totp.enabled, lockedUntil },
      now,
      audit,
    );

    await syncDevices(tx, machine, msg.devices, audit);
    return {
      ended: await endMissingSessions(tx, machine, new Set(msg.sessions.map((s) => s.id))),
      disabled: (prev?.enabled ?? false) && !msg.enabled,
    };
  });
  for (const id of ended) untrackSession(id);
  // Tắt tại máy (app, khay, `hive remote off`): worker không biết người xem trên hub nên hub đóng họ (FR-022).
  if (disabled) closeMachineViewers(machine.id);
  for (const s of msg.sessions) {
    const live = liveSession(s.id);
    if (live && live.machineId === machine.id) live.remote.controller = s.controller;
  }
}

async function syncDevices(
  tx: Tx,
  machine: AuthedMachine,
  devices: State["devices"],
  audit: (action: string, data: Record<string, unknown>) => Promise<string>,
): Promise<void> {
  const known = await tx
    .select({ id: remoteDevices.id, revokedAt: remoteDevices.revokedAt })
    .from(remoteDevices)
    .where(eq(remoteDevices.machineId, machine.id));
  const listed = new Set(devices.map((d) => d.id));
  for (const d of devices) {
    // Máy còn liệt kê là còn quyền, kể cả khi hub đã ghi gỡ (gói gỡ chưa tới máy): hiện đúng như máy.
    await tx
      .insert(remoteDevices)
      .values({ orgId: machine.orgId, machineId: machine.id, ...d, createdAt: new Date() })
      .onConflictDoUpdate({
        target: [remoteDevices.machineId, remoteDevices.id],
        set: { userId: d.userId, label: d.label, synced: d.synced, revokedAt: null },
      });
  }
  const gone = known.filter((k) => !listed.has(k.id) && k.revokedAt === null).map((k) => k.id);
  if (gone.length === 0) return;
  await tx
    .update(remoteDevices)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(remoteDevices.machineId, machine.id), inArray(remoteDevices.id, gone), isNull(remoteDevices.revokedAt)),
    );
  for (const deviceId of gone) await audit("terminal.device_revoke", { deviceId });
}

/**
 * Phiên hub còn ghi "đang chạy" mà máy không còn giữ (worker khởi động lại, mất phiên không kịp gửi `term_exit`): kết
 * thúc để trang phiên không treo mãi. `term_exit` tới sau vẫn ghi được mã thoát (gateway cập nhật phiên đã kết thúc).
 */
async function endMissingSessions(tx: Tx, machine: AuthedMachine, live: Set<string>): Promise<string[]> {
  const active = await tx
    .select({ id: terminalSessions.id, owner: terminalSessions.ownerUserId })
    .from(terminalSessions)
    .where(
      and(
        eq(terminalSessions.machineId, machine.id),
        ne(terminalSessions.origin, "hub"),
        inArray(terminalSessions.state, ["opening", "running"]),
      ),
    );
  const ended: string[] = [];
  for (const s of active) {
    if (live.has(s.id)) continue;
    if (!(await endSession(tx, s.id, "failed", "Máy không còn giữ phiên này (hive-worker đã khởi động lại).")))
      continue;
    await recordAudit(tx, {
      action: "terminal.exit",
      actorUserId: null,
      targetType: "terminal_session",
      targetId: s.id,
      data: { reason: "lost", machineId: machine.id },
    });
    ended.push(s.id);
  }
  return ended;
}
