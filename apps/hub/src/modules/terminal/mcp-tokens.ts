import { and, eq, inArray } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { sendToMachine } from "../fleet/index.ts";
import type { McpPrincipal, RunTokenVerifier } from "../mcp/index.ts";
import { type Tx, withTenant } from "../platform/index.ts";
import { canOpenTerminal } from "./access.ts";
import { liveSessions } from "./live.ts";
import { terminalSessions } from "./schema.ts";
import { endSession, loadSession, notifyEnded } from "./service.ts";
import { verifyTerminalToken } from "./token.ts";

export const ROLE_LOST = "Người mở không còn vai trò mở terminal Leader nên phiên đã đóng.";

/**
 * Cài token của phiên terminal vào cổng MCP (cùng chỗ run token). Ngoài chữ ký và hạn: phiên phải còn chạy và người
 * mở phải còn quyền `leader.terminal` trên đội; mất quyền thì đóng phiên luôn, không chờ lượt quét định kỳ.
 */
export function createTerminalTokenVerifier(opts: {
  pool: pg.Pool;
  key: Buffer;
  publicUrl: string;
  now?: () => number;
}): RunTokenVerifier {
  return {
    async verify(token): Promise<McpPrincipal | null> {
      const claims = verifyTerminalToken(opts.key, opts.publicUrl, token, opts.now?.());
      if (!claims) return null;
      type Checked =
        | { kind: "ok"; session: typeof terminalSessions.$inferSelect }
        | { kind: "lost"; id: string; machineId: string };
      const result = await withTenant(
        opts.pool,
        { orgId: claims.org_id, userId: claims.user_id },
        async (tx): Promise<Checked | null> => {
          const [s] = await tx
            .select()
            .from(terminalSessions)
            .where(
              and(eq(terminalSessions.id, claims.session_id), inArray(terminalSessions.state, ["opening", "running"])),
            );
          if (!s || s.ownerUserId !== claims.user_id) return null;
          if (!(await canOpenTerminal(tx, s.ownerUserId, s.teamId))) {
            return (await closeForRoleLoss(tx, s.id)) ? { kind: "lost", id: s.id, machineId: s.machineId } : null;
          }
          return { kind: "ok", session: s };
        },
      );
      if (!result) return null;
      if (result.kind === "lost") {
        sendToMachine(result.machineId, { type: "term_close", sessionId: result.id, reason: ROLE_LOST });
        const row = await withTenant(opts.pool, { orgId: claims.org_id }, (tx) => loadSession(tx, result.id));
        if (row) notifyEnded(row.id, row);
        return null;
      }
      const s = result.session;
      return {
        kind: "user",
        userId: s.ownerUserId,
        orgId: s.orgId,
        clientId: "terminal-leader",
        scopes: [],
        terminal: { sessionId: s.id, mode: s.mode, threadId: s.threadId, projectId: s.projectId },
      };
    },
  };
}

async function closeForRoleLoss(tx: Tx, id: string): Promise<boolean> {
  if (!(await endSession(tx, id, "closed", ROLE_LOST))) return false;
  await recordAudit(tx, {
    action: "terminal.close",
    actorUserId: null,
    targetType: "terminal_session",
    targetId: id,
    data: { by: "system", reason: "role_lost" },
  });
  return true;
}

/** Nhiều nguồn token cho cổng MCP: thử lần lượt, nguồn đầu nhận ra token thì dùng. */
export function chainVerifiers(...verifiers: Array<RunTokenVerifier | undefined>): RunTokenVerifier {
  return {
    async verify(token) {
      for (const v of verifiers) {
        const principal = await v?.verify(token);
        if (principal) return principal;
      }
      return null;
    },
  };
}

/**
 * Quét phiên đang chạy trong tiến trình này: người mở mất vai trò (bị gỡ khỏi đội, đổi vai trò) thì đóng phiên ngay cả
 * khi Leader không gọi MCP. Trả hàm dừng.
 */
export function startRoleSweep(pool: pg.Pool, everyMs = 60_000): () => void {
  const timer = setInterval(() => {
    void sweepOnce(pool).catch((error: unknown) => console.error("Không quét được quyền phiên terminal", error));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function sweepOnce(pool: pg.Pool): Promise<number> {
  let closed = 0;
  for (const live of liveSessions()) {
    const row = await withTenant(pool, { orgId: live.orgId }, async (tx) => {
      const [s] = await tx
        .select()
        .from(terminalSessions)
        .where(and(eq(terminalSessions.id, live.id), inArray(terminalSessions.state, ["opening", "running"])));
      if (!s || (await canOpenTerminal(tx, s.ownerUserId, s.teamId))) return null;
      if (!(await closeForRoleLoss(tx, s.id))) return null;
      return loadSession(tx, s.id);
    });
    if (row) {
      sendToMachine(row.machineId, { type: "term_close", sessionId: row.id, reason: ROLE_LOST });
      notifyEnded(row.id, row);
      closed++;
    }
  }
  return closed;
}
