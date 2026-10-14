import { and, eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { type AuthedMachine, sendToMachine, type TerminalHandlers, type TerminalMessage } from "../fleet/index.ts";
import { withTenant } from "../platform/index.ts";
import { liveSession, pushOutput, trackSession, untrackSession } from "./live.ts";
import { maskSecrets } from "./mask.ts";
import { onPairResult } from "./pairing.ts";
import { isPersonalOrigin, machineOwner, recordEvent, recordOpened, welcomeFor } from "./record.ts";
import { terminalChunks, terminalSessions } from "./schema.ts";
import { broadcastState, endSession, loadSession, notifyEnded } from "./service.ts";
import { recordState } from "./state.ts";

const PERSONAL_EXIT_TEXT: Record<string, string> = {
  exit: "CLI đã thoát.",
  closed: "Phiên đã đóng.",
  idle: "Phiên không hoạt động quá lâu nên đã đóng.",
  denied: "Máy từ chối mở phiên.",
  error: "Máy không mở được phiên.",
};

const EXIT_TEXT: Record<string, string> = {
  exit: "Claude đã thoát.",
  closed: "Phiên đã đóng.",
  idle: "Phiên không hoạt động quá 30 phút nên đã đóng.",
  denied: "Máy từ chối mở phiên.",
  error: "Máy không mở được phiên.",
};

/**
 * Gói terminal từ worker. Phiên phải thuộc đúng máy gửi gói: máy khác cùng tổ chức không ghi được vào phiên của máy
 * này. Phiên Leader lạ (đã xoá, của tiến trình hub trước) thì bảo worker đóng để không còn PTY mồ côi; phiên máy cá nhân
 * thì không bao giờ đóng (người dùng đang gõ tại máy), chỉ `term_ack` để worker bỏ đệm.
 */
export function createTerminalHandlers(pool: pg.Pool): Required<TerminalHandlers> {
  const ack = (machine: AuthedMachine, sessionId: string, upto: number) =>
    sendToMachine(machine.id, { type: "term_ack", sessionId, upto });

  async function onMessage(machine: AuthedMachine, msg: TerminalMessage): Promise<void> {
    const tenant = { orgId: machine.orgId };
    if (msg.type === "term_event") return recordEvent(pool, machine, msg);
    if (msg.type === "term_state") return recordState(pool, machine, msg);
    if (msg.type === "term_pair_result") return onPairResult(machine, msg);
    if (msg.type === "term_opened" && isPersonalOrigin(msg.origin)) {
      await recordOpened(pool, machine, msg);
      return;
    }
    if (msg.type === "term_output") {
      const data = maskSecrets(Buffer.from(msg.data, "base64"));
      const stored = await withTenant(pool, tenant, async (tx) => {
        const [row] = await tx
          .select({
            state: terminalSessions.state,
            origin: terminalSessions.origin,
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
      if (!stored) return orphan(machine, msg.sessionId, msg.seq);
      if (stored.origin !== "hub") ack(machine, msg.sessionId, msg.seq);
      else if (stored.ended) {
        // Hub đã kết thúc phiên mà worker còn gửi: nhắc đóng lần nữa (gói term_close trước có thể đã mất).
        sendToMachine(machine.id, { type: "term_close", sessionId: msg.sessionId, reason: "Phiên đã kết thúc." });
        return;
      }
      if (stored.ended || !("fresh" in stored) || !stored.fresh) return;
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
    const done = await withTenant(pool, tenant, async (tx) => {
      const [own] = await tx
        .select({ id: terminalSessions.id, origin: terminalSessions.origin })
        .from(terminalSessions)
        .where(and(eq(terminalSessions.id, msg.sessionId), eq(terminalSessions.machineId, machine.id)));
      if (!own) return null;
      const failed = msg.reason === "denied" || msg.reason === "error";
      const text = own.origin === "hub" ? EXIT_TEXT[msg.reason] : PERSONAL_EXIT_TEXT[msg.reason];
      const reason = msg.message ?? text ?? "Phiên đã kết thúc.";
      const ended = await endSession(tx, msg.sessionId, failed ? "failed" : "closed", reason, msg.exitCode);
      if (ended) {
        await recordAudit(tx, {
          action: "terminal.exit",
          actorUserId: null,
          targetType: "terminal_session",
          targetId: msg.sessionId,
          data: {
            reason: msg.reason,
            exitCode: msg.exitCode,
            machineId: machine.id,
            ...(msg.by ? { by: msg.by } : {}),
          },
        });
      } else if (msg.exitCode !== null) {
        // Hub đã đóng phiên trước (người dùng bấm Đóng): chỉ ghi thêm mã thoát thật.
        await tx.update(terminalSessions).set({ exitCode: msg.exitCode }).where(eq(terminalSessions.id, msg.sessionId));
      }
      // loadSession chỉ đọc phiên Leader; phiên máy cá nhân chưa có người xem trực tiếp (T030) nên chỉ bỏ theo dõi.
      return { leader: await loadSession(tx, msg.sessionId) };
    });
    if (!done) return;
    if (done.leader) notifyEnded(done.leader.id, done.leader);
    else untrackSession(msg.sessionId);
  }

  /**
   * Máy mất kết nối: phiên Leader không còn đường tới PTY (worker cũng tự đóng phiên khi mất hub). Phiên máy cá nhân vẫn
   * chạy tại máy; worker giữ output trong đệm `pending` và gửi bù khi nối lại.
   */
  async function onDisconnected(machine: AuthedMachine): Promise<void> {
    const rows = await withTenant(pool, { orgId: machine.orgId }, async (tx) => {
      const active = await tx
        .select({ id: terminalSessions.id })
        .from(terminalSessions)
        .where(
          and(
            eq(terminalSessions.machineId, machine.id),
            eq(terminalSessions.origin, "hub"),
            inArray(terminalSessions.state, ["opening", "running"]),
          ),
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

  return {
    onMessage,
    onDisconnected,
    welcome: (machine, online) => welcomeFor(pool, machine, online),
  };

  /** Không có phiên: máy cá nhân là phiên hub không ghi (đủ số phiên, `--no-record`) nên chỉ ack. */
  async function orphan(machine: AuthedMachine, sessionId: string, seq?: number): Promise<void> {
    if (seq !== undefined) {
      const owner = await withTenant(pool, { orgId: machine.orgId }, (tx) => machineOwner(tx, machine.id));
      if (owner && !owner.shared) {
        ack(machine, sessionId, seq);
        return;
      }
    }
    if (liveSession(sessionId)) return;
    sendToMachine(machine.id, { type: "term_close", sessionId, reason: "Hub không còn phiên này." });
  }
}
