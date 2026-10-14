import { and, eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { type AuthedMachine, sendToMachine, type TerminalMessage } from "../fleet/index.ts";
import { withTenant } from "../platform/index.ts";
import { liveSession, pushOutput, trackSession } from "./live.ts";
import { maskSecrets } from "./mask.ts";
import { terminalChunks, terminalSessions } from "./schema.ts";
import { broadcastState, endSession, loadSession, notifyEnded } from "./service.ts";

const EXIT_TEXT: Record<string, string> = {
  exit: "Claude đã thoát.",
  closed: "Phiên đã đóng.",
  idle: "Phiên không hoạt động quá 30 phút nên đã đóng.",
  denied: "Máy từ chối mở phiên.",
  error: "Máy không mở được phiên.",
};

/**
 * Gói terminal từ worker. Phiên phải thuộc đúng máy gửi gói: máy khác cùng tổ chức không ghi được vào phiên của máy
 * này. Phiên lạ (đã xoá, của tiến trình hub trước) thì bảo worker đóng để không còn PTY mồ côi.
 */
export function createTerminalHandlers(pool: pg.Pool) {
  async function onMessage(machine: AuthedMachine, msg: TerminalMessage): Promise<void> {
    const tenant = { orgId: machine.orgId };
    if (msg.type === "term_output") {
      const data = maskSecrets(Buffer.from(msg.data, "base64"));
      const stored = await withTenant(pool, tenant, async (tx) => {
        const [row] = await tx
          .select({
            state: terminalSessions.state,
            threadId: terminalSessions.threadId,
            teamId: terminalSessions.teamId,
            owner: terminalSessions.ownerUserId,
          })
          .from(terminalSessions)
          .where(and(eq(terminalSessions.id, msg.sessionId), eq(terminalSessions.machineId, machine.id)));
        if (!row) return null;
        if (row.state !== "opening" && row.state !== "running") return { ...row, ended: true };
        // Worker gửi lại gói chưa chắc đã tới (nối lại): khoá chính (session, seq) bỏ bản trùng.
        const inserted = await tx
          .insert(terminalChunks)
          .values({ orgId: machine.orgId, sessionId: msg.sessionId, seq: msg.seq, data })
          .onConflictDoNothing()
          .returning({ seq: terminalChunks.seq });
        if (inserted.length > 0) {
          await tx
            .update(terminalSessions)
            .set({
              bytes: sql`${terminalSessions.bytes} + ${data.length}`,
              nextSeq: sql`greatest(${terminalSessions.nextSeq}, ${msg.seq + 1})`,
              lastActiveAt: new Date(),
            })
            .where(eq(terminalSessions.id, msg.sessionId));
        }
        return { ...row, ended: false, fresh: inserted.length > 0 };
      });
      if (!stored) return orphan(machine, msg.sessionId);
      if (stored.ended) {
        // Hub đã kết thúc phiên mà worker còn gửi: nhắc đóng lần nữa (gói term_close trước có thể đã mất).
        sendToMachine(machine.id, { type: "term_close", sessionId: msg.sessionId, reason: "Phiên đã kết thúc." });
        return;
      }
      if (!("fresh" in stored) || !stored.fresh) return;
      const live = trackSession({
        id: msg.sessionId,
        orgId: machine.orgId,
        teamId: stored.teamId,
        machineId: machine.id,
        ownerUserId: stored.owner,
        threadId: stored.threadId,
      });
      pushOutput(live, msg.seq, data);
      return;
    }
    if (msg.type === "term_opened") {
      const row = await withTenant(pool, tenant, async (tx) => {
        const [updated] = await tx
          .update(terminalSessions)
          .set({
            state: "running",
            accountLabel: msg.accountLabel,
            permissions: msg.permissions,
            lastActiveAt: new Date(),
          })
          .where(
            and(
              eq(terminalSessions.id, msg.sessionId),
              eq(terminalSessions.machineId, machine.id),
              inArray(terminalSessions.state, ["opening", "running"]),
            ),
          )
          .returning({ id: terminalSessions.id });
        return updated ? loadSession(tx, msg.sessionId) : null;
      });
      if (!row) return orphan(machine, msg.sessionId);
      trackSession({
        id: row.id,
        orgId: row.orgId,
        teamId: row.teamId,
        machineId: row.machineId,
        ownerUserId: row.ownerUserId,
        threadId: row.threadId,
      });
      broadcastState(row);
      return;
    }
    // term_exit
    const row = await withTenant(pool, tenant, async (tx) => {
      const [own] = await tx
        .select({ id: terminalSessions.id })
        .from(terminalSessions)
        .where(and(eq(terminalSessions.id, msg.sessionId), eq(terminalSessions.machineId, machine.id)));
      if (!own) return null;
      const failed = msg.reason === "denied" || msg.reason === "error";
      const reason = msg.message ?? EXIT_TEXT[msg.reason] ?? "Phiên đã kết thúc.";
      const ended = await endSession(tx, msg.sessionId, failed ? "failed" : "closed", reason, msg.exitCode);
      if (ended) {
        await recordAudit(tx, {
          action: "terminal.exit",
          actorUserId: null,
          targetType: "terminal_session",
          targetId: msg.sessionId,
          data: { reason: msg.reason, exitCode: msg.exitCode, machineId: machine.id },
        });
      } else if (msg.exitCode !== null) {
        // Hub đã đóng phiên trước (người dùng bấm Đóng): chỉ ghi thêm mã thoát thật.
        await tx.update(terminalSessions).set({ exitCode: msg.exitCode }).where(eq(terminalSessions.id, msg.sessionId));
      }
      return loadSession(tx, msg.sessionId);
    });
    if (row) notifyEnded(row.id, row);
  }

  /** Máy mất kết nối: phiên của máy không còn đường tới PTY (worker cũng tự đóng phiên khi mất hub). */
  async function onDisconnected(machine: AuthedMachine): Promise<void> {
    const rows = await withTenant(pool, { orgId: machine.orgId }, async (tx) => {
      const active = await tx
        .select({ id: terminalSessions.id })
        .from(terminalSessions)
        .where(
          and(eq(terminalSessions.machineId, machine.id), inArray(terminalSessions.state, ["opening", "running"])),
        );
      const out = [];
      for (const s of active) {
        if (await endSession(tx, s.id, "failed", "Máy mất kết nối với hub nên phiên đã dừng.")) {
          await recordAudit(tx, {
            action: "terminal.exit",
            actorUserId: null,
            targetType: "terminal_session",
            targetId: s.id,
            data: { reason: "disconnected", machineId: machine.id },
          });
          const row = await loadSession(tx, s.id);
          if (row) out.push(row);
        }
      }
      return out;
    });
    for (const row of rows) notifyEnded(row.id, row);
  }

  return { onMessage, onDisconnected };
}

function orphan(machine: AuthedMachine, sessionId: string): void {
  if (liveSession(sessionId)) return;
  sendToMachine(machine.id, { type: "term_close", sessionId, reason: "Hub không còn phiên này." });
}
