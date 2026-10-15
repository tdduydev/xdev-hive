import { REMOTE_LIMITS } from "@xdev-hive/contracts";
import { TERMINAL_CAPABILITY, type TermOrigin } from "@xdev-hive/contracts/worker-protocol";
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import type { AuthedMachine, TerminalHandlers, TerminalMessage } from "../fleet/index.ts";
import { loadPolicy } from "../governance/index.ts";
import { type Tx, withTenant } from "../platform/index.ts";
import { trackSession } from "./live.ts";
import { terminalEvents, terminalSessions } from "./schema.ts";

/**
 * Ghi phiên tương tác trên máy cá nhân (`hive chat` tại máy, mở từ điện thoại; specs/010 US1). Khác phiên Leader: worker
 * mở phiên trước rồi báo hub (`term_opened` có `origin`), hub không tạo trước dòng nào. Hub không bao giờ đóng PTY của
 * phiên này vì không ghi được: chỉ bỏ ghi và `term_ack` để worker thôi giữ đệm.
 */

type Opened = Extract<TerminalMessage, { type: "term_opened" }>;
type Event = Extract<TerminalMessage, { type: "term_event" }>;
type Welcome = Awaited<ReturnType<NonNullable<TerminalHandlers["welcome"]>>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = ["opening", "running"] as const;

export const isPersonalOrigin = (origin: TermOrigin | undefined): origin is "local" | "remote" =>
  origin === "local" || origin === "remote";

interface MachineOwner {
  shared: boolean;
  kind: string;
  ownerUserId: string | null;
}

/** Máy cá nhân và chủ máy theo hub (người đăng ký máy). Bảng máy thuộc fleet; chỉ đọc qua SQL như `joined()`. */
export async function machineOwner(tx: Tx, machineId: string): Promise<MachineOwner | null> {
  const { rows } = await tx.execute<{ shared: boolean; kind: string; registered_by: string | null }>(
    sql`select shared, kind, registered_by from hive.machines where id = ${machineId} and revoked_at is null`,
  );
  const m = rows[0];
  return m ? { shared: m.shared, kind: m.kind, ownerUserId: m.registered_by } : null;
}

export const personal = (m: MachineOwner | null): m is MachineOwner & { ownerUserId: string } =>
  m !== null && !m.shared && m.kind === "worker" && m.ownerUserId !== null;

/**
 * Task chỉ được gắn khi thuộc dự án của đội sở hữu máy (FR-030): token cá nhân của chủ máy không được dùng phiên trên máy
 * đội này để ghi vào dự án đội khác. Sai thì bỏ liên kết, vẫn ghi phiên.
 */
async function linkTask(
  tx: Tx,
  teamId: string,
  projectId: string | undefined,
  taskId: string | undefined,
): Promise<{ projectId: string | null; taskId: string | null }> {
  if (taskId && UUID.test(taskId)) {
    const { rows } = await tx.execute<{ project_id: string }>(
      sql`select t.project_id from hive.tasks t join hive.projects p on p.id = t.project_id
        where t.id = ${taskId} and p.team_id = ${teamId}`,
    );
    if (rows[0]) return { projectId: rows[0].project_id, taskId };
  }
  if (projectId && UUID.test(projectId)) {
    const { rows } = await tx.execute<{ id: string }>(
      sql`select id from hive.projects where id = ${projectId} and team_id = ${teamId}`,
    );
    if (rows[0]) return { projectId, taskId: null };
  }
  return { projectId: null, taskId: null };
}

/** Trả true khi hub ghi phiên này (đã có từ trước, như worker gửi lại sau khi nối lại, cũng tính). */
export async function recordOpened(pool: pg.Pool, machine: AuthedMachine, msg: Opened): Promise<boolean> {
  if (msg.record === false || !isPersonalOrigin(msg.origin)) return false;
  const origin = msg.origin;
  const row = await withTenant(pool, { orgId: machine.orgId }, async (tx) => {
    const owner = await machineOwner(tx, machine.id);
    if (!personal(owner)) return null;
    const [existing] = await tx
      .select({ id: terminalSessions.id, machineId: terminalSessions.machineId })
      .from(terminalSessions)
      .where(eq(terminalSessions.id, msg.sessionId));
    if (existing) return existing.machineId === machine.id ? { id: existing.id, owner: owner.ownerUserId } : null;
    const [active] = await tx
      .select({ n: count() })
      .from(terminalSessions)
      .where(
        and(
          eq(terminalSessions.machineId, machine.id),
          ne(terminalSessions.origin, "hub"),
          inArray(terminalSessions.state, [...ACTIVE]),
        ),
      );
    if ((active?.n ?? 0) >= REMOTE_LIMITS.recordedSessionsPerMachine) return null;
    const link = await linkTask(tx, machine.teamId, msg.projectId, msg.taskId);
    const [inserted] = await tx
      .insert(terminalSessions)
      .values({
        id: msg.sessionId,
        orgId: machine.orgId,
        teamId: machine.teamId,
        origin,
        machineId: machine.id,
        ownerUserId: owner.ownerUserId,
        cli: msg.cli ?? "claude",
        accountLabel: msg.accountLabel,
        permissions: msg.permissions,
        cwdLabel: msg.cwdLabel ?? null,
        remote: msg.remote ?? false,
        requestId: msg.requestId ?? null,
        ...link,
        state: "running",
        cols: msg.cols ?? 80,
        rows: msg.rows ?? 24,
      })
      .onConflictDoNothing()
      .returning({ id: terminalSessions.id });
    if (!inserted) return null;
    await recordAudit(tx, {
      action: "terminal.open",
      actorUserId: owner.ownerUserId,
      targetType: "terminal_session",
      targetId: inserted.id,
      data: {
        source: "machine",
        origin,
        machineId: machine.id,
        cli: msg.cli ?? "claude",
        cwdLabel: msg.cwdLabel ?? null,
        remote: msg.remote ?? false,
        ...link,
        ...(msg.requestId ? { requestId: msg.requestId } : {}),
      },
    });
    return { id: inserted.id, owner: owner.ownerUserId };
  });
  if (!row) return false;
  trackSession({
    id: row.id,
    orgId: machine.orgId,
    teamId: machine.teamId,
    machineId: machine.id,
    ownerUserId: row.owner,
    threadId: null,
  });
  return true;
}

/** Sự kiện worker (`attention`, `idle`, đổi người điều khiển…) vào dòng thời gian của phiên; không có phím gõ hay output. */
export async function recordEvent(pool: pg.Pool, machine: AuthedMachine, msg: Event): Promise<void> {
  await withTenant(pool, { orgId: machine.orgId }, async (tx) => {
    const [own] = await tx
      .select({ id: terminalSessions.id })
      .from(terminalSessions)
      .where(
        and(
          eq(terminalSessions.id, msg.sessionId),
          eq(terminalSessions.machineId, machine.id),
          ne(terminalSessions.origin, "hub"),
        ),
      );
    if (!own) return;
    await tx.insert(terminalEvents).values({
      orgId: machine.orgId,
      sessionId: msg.sessionId,
      seq: msg.seq,
      kind: msg.event,
      data: msg.data ?? {},
    });
  });
}

/**
 * Phần `welcome` cho phiên máy cá nhân: `terminal` chỉ khi máy cá nhân khai capability, `owner` để worker biết chủ máy
 * (đổi chủ thì xoá thiết bị đã ghép), `policy` để tổ chức tắt được TOTP. Máy dùng chung vẫn nhận `owner.shared` để worker
 * từ chối bật từ xa.
 */
export async function welcomeFor(
  pool: pg.Pool,
  machine: AuthedMachine,
  online: { shared: boolean; registeredBy: string | null; capabilities: string[] },
): Promise<Welcome> {
  if (machine.kind !== "worker" || !online.registeredBy) return {};
  const owner = { userId: online.registeredBy, shared: online.shared };
  if (online.shared || !online.capabilities.includes(TERMINAL_CAPABILITY)) return { owner };
  const policy = await withTenant(pool, { orgId: machine.orgId }, (tx) => loadPolicy(tx));
  return { features: ["terminal"], owner, policy: { totpFallback: policy.remote.totpFallback } };
}
