import type { ProjectTokenUsagePayload } from "@xdev-hive/contracts";
import { and, eq, gt, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { findProject } from "../catalog/index.ts";
import { ClientEventRejected, ForbiddenError, type Tx, withTenant } from "../platform/index.ts";
import { teamRoleOf } from "../tenancy/index.ts";
import { FleetError } from "./errors.ts";
import { machines, projectTokenUsage } from "./schema.ts";

/** Như điểm máy: máy gửi theo giờ, hub chặn ở 10 phút mỗi máy × dự án để máy lỗi không làm đầy bảng. */
export const PROJECT_USAGE_MIN_INTERVAL_MS = 10 * 60 * 1000;

interface UsageMachine {
  id: string;
  orgId: string;
}

/**
 * Ghi token theo dự án của một máy (sự kiện `project.token_usage`, spec 029). Số liệu đứng tên chủ máy nên chủ máy phải
 * có vai trò ở đội của dự án: máy không gắn được số của mình vào dự án người khác.
 */
export async function recordProjectUsage(
  tx: Tx,
  machine: UsageMachine,
  payload: ProjectTokenUsagePayload,
): Promise<void> {
  const [m] = await tx.select({ owner: machines.registeredBy }).from(machines).where(eq(machines.id, machine.id));
  const project = await findProject(tx, payload.projectId);
  const role = m?.owner && project ? await teamRoleOf(tx, m.owner, project.teamId) : null;
  if (!m?.owner || !project || !role)
    throw new ClientEventRejected(
      "NOT_PROJECT_MEMBER",
      "Chủ máy không phải thành viên của dự án nên không gửi được số token của dự án.",
    );
  // Khoá theo máy × dự án để hai lần gửi song song không cùng lọt qua giới hạn.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('project-usage'), hashtext(${`${machine.id}:${project.id}`}))`,
  );
  const since = new Date(Date.now() - PROJECT_USAGE_MIN_INTERVAL_MS);
  const [recent] = await tx
    .select({ id: projectTokenUsage.id })
    .from(projectTokenUsage)
    .where(
      and(
        eq(projectTokenUsage.machineId, machine.id),
        eq(projectTokenUsage.projectId, project.id),
        gt(projectTokenUsage.receivedAt, since),
      ),
    )
    .limit(1);
  if (recent)
    throw new ClientEventRejected(
      "RATE_LIMITED",
      "Máy vừa gửi số token của dự án này trong 10 phút qua; lần gửi kế sẽ được nhận.",
    );
  const values = {
    teamId: project.teamId,
    userId: m.owner,
    periodStart: new Date(payload.periodStart),
    tokens: payload.tokens,
    sessions: payload.sessions,
    score: payload.score,
    policyDrift: payload.policyDrift,
  };
  await tx
    .insert(projectTokenUsage)
    .values({
      ...values,
      orgId: machine.orgId,
      projectId: project.id,
      machineId: machine.id,
      periodEnd: new Date(payload.periodEnd),
    })
    .onConflictDoUpdate({
      target: [projectTokenUsage.machineId, projectTokenUsage.projectId, projectTokenUsage.periodEnd],
      set: { ...values, receivedAt: sql`now()` },
    });
}

/**
 * Chủ máy xoá mọi số token theo dự án máy đã gửi. Chỉ chủ máy: số liệu là của người dùng, quản trị đội không xoá thay
 * và cũng không cần (bảng tự dọn sau 90 ngày).
 */
export async function deleteMyProjectUsage(tx: Tx, userId: string, machineId: string): Promise<{ deleted: number }> {
  const [m] = await tx
    .select({ id: machines.id, name: machines.name, owner: machines.registeredBy })
    .from(machines)
    .where(eq(machines.id, machineId));
  if (!m) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  if (m.owner !== userId)
    throw new ForbiddenError("NOT_MACHINE_OWNER", "Chỉ người đăng ký máy mới xoá được số liệu máy đã gửi.");
  const rows = await tx
    .delete(projectTokenUsage)
    .where(eq(projectTokenUsage.machineId, m.id))
    .returning({ id: projectTokenUsage.id });
  await recordAudit(tx, {
    action: "machine.project_usage_delete",
    targetType: "machine",
    targetId: m.id,
    data: { name: m.name, deleted: rows.length },
  });
  return { deleted: rows.length };
}

/** Dọn dòng quá 90 ngày, chạy cùng job dọn điểm máy. */
export async function purgeProjectUsage(pool: pg.Pool): Promise<number> {
  return withTenant(pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ purged: string }>(sql`select hive.purge_project_token_usage() as purged`);
    return Number(rows[0]?.purged ?? 0);
  });
}
