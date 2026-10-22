import type { ClientEventResult, Machine, MachineEventInput, MachineTokenScore } from "@xdev-hive/contracts";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import { proposeFromMachine } from "../knowledge/index.ts";
import { ClientEventRejected, type Jobs, type Tx, withClientEvent, withTenant } from "../platform/index.ts";
import { allowWith, requireTeamRole } from "../tenancy/index.ts";
import { FleetError } from "./errors.ts";
import { purgeProjectUsage, recordProjectUsage } from "./project-usage.ts";
import { machines, machineTokenScores } from "./schema.ts";

/** Máy đã xác thực (cùng hình với AuthedMachine). Khai riêng vì machines.ts import file này: tránh vòng phụ thuộc. */
interface ScoringMachine {
  id: string;
  orgId: string;
  teamId: string;
}

/** Máy gửi tối đa một lần mỗi giờ (ADR 0036); hub chặn ở 10 phút để máy lỗi không làm đầy bảng. */
export const TOKEN_SCORE_MIN_INTERVAL_MS = 10 * 60 * 1000;
const HISTORY_DAYS = 90;

/**
 * Nhận sự kiện của máy (ADR 0036). Danh tính là máy đã xác thực bằng token: tổ chức, đội, máy lấy từ đó, không lấy từ
 * body. Gửi lại cùng khoá thì trả `duplicate` mà không ghi thêm.
 */
export async function receiveMachineEvent(
  pool: pg.Pool,
  machine: ScoringMachine,
  input: MachineEventInput,
): Promise<ClientEventResult> {
  const result = await withClientEvent(
    pool,
    { orgId: machine.orgId },
    {
      key: input.key,
      source: "worker",
      kind: input.kind,
      machineId: machine.id,
      targetType: "machine",
      targetId: machine.id,
      clientCreatedAt: new Date(input.createdAt),
    },
    async (tx) => {
      if (input.kind === "memory.propose") {
        const [m] = await tx.select({ owner: machines.registeredBy }).from(machines).where(eq(machines.id, machine.id));
        await proposeFromMachine(tx, { id: machine.id, ownerUserId: m?.owner ?? null }, input.payload);
        return null;
      }
      if (input.kind === "project.token_usage") {
        await recordProjectUsage(tx, machine, input.payload);
        return null;
      }
      const since = new Date(Date.now() - TOKEN_SCORE_MIN_INTERVAL_MS);
      const [recent] = await tx
        .select({ id: machineTokenScores.id })
        .from(machineTokenScores)
        .where(and(eq(machineTokenScores.machineId, machine.id), gt(machineTokenScores.reportedAt, since)))
        .limit(1);
      if (recent)
        throw new ClientEventRejected(
          "TOKEN_SCORE_TOO_FREQUENT",
          "Máy vừa gửi điểm token trong 10 phút qua; lần gửi kế sẽ được nhận.",
        );
      const report = input.payload;
      await tx.insert(machineTokenScores).values({
        orgId: machine.orgId,
        teamId: machine.teamId,
        machineId: machine.id,
        score: report.machine.score,
        coverage: report.machine.coverage,
        scoreVersion: report.scoreVersion,
        report,
        generatedAt: new Date(report.generatedAt),
      });
      return null;
    },
  );
  const { response: _response, ...out } = result;
  return out;
}

/** Điểm mới nhất của từng máy, cho cột "Điểm token" ở danh sách máy. */
export async function latestTokenScores(tx: Tx, machineIds: string[]): Promise<Map<string, Machine["tokenScore"]>> {
  if (machineIds.length === 0) return new Map();
  const rows = await tx
    .selectDistinctOn([machineTokenScores.machineId], {
      machineId: machineTokenScores.machineId,
      report: machineTokenScores.report,
      reportedAt: machineTokenScores.reportedAt,
    })
    .from(machineTokenScores)
    .where(inArray(machineTokenScores.machineId, machineIds))
    .orderBy(machineTokenScores.machineId, desc(machineTokenScores.reportedAt));
  return new Map(
    rows.map((r) => [
      r.machineId,
      {
        score: r.report.machine.score,
        level: r.report.machine.level,
        coverage: r.report.machine.coverage,
        provisional: r.report.machine.provisional,
        reportedAt: r.reportedAt.toISOString(),
      },
    ]),
  );
}

/** Chi tiết điểm của một máy. Cùng quyền với danh sách máy (quản trị đội của máy, quản trị tổ chức). */
export async function getMachineTokenScore(tx: Tx, userId: string, machineId: string): Promise<MachineTokenScore> {
  const [m] = await tx
    .select({ id: machines.id, teamId: machines.teamId })
    .from(machines)
    .where(eq(machines.id, machineId));
  if (!m) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  await allowWith(tx, userId, "machines.read", () => requireTeamRole(tx, userId, m.teamId, "admin"), m.teamId);
  const rows = await tx
    .select({
      score: machineTokenScores.score,
      coverage: machineTokenScores.coverage,
      report: machineTokenScores.report,
      reportedAt: machineTokenScores.reportedAt,
    })
    .from(machineTokenScores)
    .where(
      and(
        eq(machineTokenScores.machineId, m.id),
        gt(machineTokenScores.reportedAt, sql`now() - make_interval(days => ${HISTORY_DAYS})`),
      ),
    )
    .orderBy(desc(machineTokenScores.reportedAt));
  const [latest] = rows;
  return {
    machineId: m.id,
    latest: latest ? { reportedAt: latest.reportedAt.toISOString(), report: latest.report } : null,
    history: rows
      .map((r) => ({ reportedAt: r.reportedAt.toISOString(), score: r.score, coverage: r.coverage }))
      .reverse(),
  };
}

export const TOKEN_SCORE_RETENTION_QUEUE = "fleet-token-score-retention";
export const tokenScoreRetentionQueue = {
  name: TOKEN_SCORE_RETENTION_QUEUE,
  policy: "singleton",
  retryLimit: 3,
  retryDelay: 300,
} as const;
/** Mỗi ngày một lần, giờ ít người dùng (UTC), lệch giờ với job dọn log run. */
export const TOKEN_SCORE_RETENTION_CRON = "53 19 * * *";

export async function purgeTokenScores(pool: pg.Pool): Promise<number> {
  return withTenant(pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ purged: string }>(sql`select hive.purge_machine_token_scores() as purged`);
    return Number(rows[0]?.purged ?? 0);
  });
}

export async function registerTokenScoreRetentionWorker(jobs: Jobs, pool: pg.Pool): Promise<void> {
  await jobs.work(TOKEN_SCORE_RETENTION_QUEUE, async () => {
    const purged = await purgeTokenScores(pool);
    if (purged > 0) console.info(`Đã xoá ${purged} điểm token máy quá 90 ngày.`);
    const usage = await purgeProjectUsage(pool);
    if (usage > 0) console.info(`Đã xoá ${usage} dòng token theo dự án quá 90 ngày.`);
  });
  await jobs.schedule(TOKEN_SCORE_RETENTION_QUEUE, TOKEN_SCORE_RETENTION_CRON);
}
