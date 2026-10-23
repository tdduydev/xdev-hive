import {
  DEPLOY_ACTIVE_STATES,
  type DeliveryPerson,
  type Deploy,
  type DeployBoard,
  type DeployListInput,
} from "@xdev-hive/contracts";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { findProject, listProjects } from "../../catalog/index.ts";
import { machineNames } from "../../fleet/index.ts";
import { BadRequestError, NotFoundError, type Tx } from "../../platform/index.ts";
import { effectivePermissions } from "../../tenancy/index.ts";
import { listEnvironments, peopleOf, requireTeamPermission } from "../environments.ts";
import { deliveryJobs, deployApprovals, deployEnvironments, deploys, deployTargets } from "../schema.ts";

// Đọc lần triển khai: một lần, lịch sử có lọc, bảng "đang chạy" của hệ thống (FR-020). Quyền theo `ci.view` của đội sở
// hữu môi trường; lần của đội không xem được thì như không có.

export type DeployRow = typeof deploys.$inferSelect;

/** Lần triển khai kèm chỗ của nó (dự án, môi trường, hệ thống, đội) để trả về và kiểm quyền. */
export interface LocatedDeploy {
  deploy: DeployRow;
  projectId: string;
  environmentId: string;
  systemId: string;
  teamId: string;
}

export const deployNotFound = () => new NotFoundError("NOT_FOUND", "Không tìm thấy lần triển khai.");

const locatedColumns = {
  deploy: deploys,
  projectId: deployTargets.projectId,
  environmentId: deployTargets.environmentId,
  systemId: deployEnvironments.systemId,
  teamId: deployEnvironments.teamId,
};

export const locatedDeploys = (tx: Tx, where: SQL | undefined) =>
  tx
    .select(locatedColumns)
    .from(deploys)
    .innerJoin(deployTargets, eq(deployTargets.id, deploys.targetId))
    .innerJoin(deployEnvironments, eq(deployEnvironments.id, deployTargets.environmentId))
    .where(where);

export async function loadLocatedDeploy(tx: Tx, id: string): Promise<LocatedDeploy | null> {
  const [row] = await locatedDeploys(tx, eq(deploys.id, id));
  return row ?? null;
}

// ---- Hiển thị -------------------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Cách triển khai lưu `external` tuỳ ý; API chỉ trả nhãn và link khi có. */
function viewExternal(external: Record<string, unknown> | null): Deploy["external"] {
  if (!external || typeof external.label !== "string") return null;
  return { label: external.label, url: typeof external.url === "string" ? external.url : null };
}

function viewHealth(health: Record<string, unknown> | null): Deploy["health"] {
  if (!isRecord(health) || typeof health.ok !== "boolean" || typeof health.at !== "string") return null;
  return {
    ok: health.ok,
    at: health.at,
    status: typeof health.status === "number" ? health.status : null,
    message: typeof health.message === "string" ? health.message : "",
  };
}

type ApprovalRow = typeof deployApprovals.$inferSelect;
type JobRow = typeof deliveryJobs.$inferSelect;

/** Việc mới nhất của mỗi lần triển khai, cho phần "Máy chạy". */
async function latestJobs(tx: Tx, deployIds: string[]): Promise<Map<string, JobRow>> {
  if (deployIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(deliveryJobs)
    .where(inArray(deliveryJobs.deployId, deployIds))
    .orderBy(desc(deliveryJobs.createdAt));
  const out = new Map<string, JobRow>();
  for (const r of rows) if (r.deployId && !out.has(r.deployId)) out.set(r.deployId, r);
  return out;
}

/** Ai chạy lần này: máy đã báo bắt đầu, hoặc máy đang giữ việc; việc đang chờ máy thì kèm lý do. */
function viewRunner(d: DeployRow, job: JobRow | undefined, names: Map<string, string>): Deploy["runner"] {
  if (d.origin !== "hive") return null;
  if (d.ranLegacy) return { mode: "legacy", machine: null, waiting: null };
  const machineId = d.ranOnWorkerId ?? job?.workerId ?? null;
  return {
    mode: "worker",
    machine: machineId ? { id: machineId, name: names.get(machineId) ?? machineId } : null,
    waiting: job?.state === "waiting" ? job.waitReason : null,
  };
}

function view(
  r: LocatedDeploy,
  people: Map<string, DeliveryPerson>,
  approvals: ApprovalRow[],
  runner: Deploy["runner"],
): Deploy {
  const d = r.deploy;
  const person = (id: string | null) => (id ? (people.get(id) ?? { userId: id, name: id }) : null);
  return {
    id: d.id,
    targetId: d.targetId,
    projectId: r.projectId,
    environmentId: r.environmentId,
    systemId: r.systemId,
    method: d.method as Deploy["method"],
    origin: d.origin as Deploy["origin"],
    state: d.state as Deploy["state"],
    version: d.version,
    requestedBy: person(d.requestedBy),
    triggeredBy: d.triggeredBy,
    steps: d.steps,
    configVersion: d.configVersion,
    rollbackOf: d.rollbackOf,
    skipBackup: d.skipBackupReason !== null ? { reason: d.skipBackupReason } : null,
    external: viewExternal(d.external),
    health: viewHealth(d.health),
    approval:
      d.approvalsRequired > 0 && d.approvalExpiresAt
        ? {
            required: d.approvalsRequired,
            expiresAt: d.approvalExpiresAt.toISOString(),
            decisions: approvals.map((a) => ({
              by: person(a.userId) as DeliveryPerson,
              decision: a.decision as "approve" | "reject",
              reason: a.reason,
              at: a.createdAt.toISOString(),
            })),
          }
        : null,
    runner,
    createdAt: d.createdAt.toISOString(),
    startedAt: d.startedAt?.toISOString() ?? null,
    finishedAt: d.finishedAt?.toISOString() ?? null,
  };
}

export async function deployViews(tx: Tx, rows: LocatedDeploy[]): Promise<Deploy[]> {
  const withApproval = rows.filter((r) => r.deploy.approvalsRequired > 0).map((r) => r.deploy.id);
  const approvals = withApproval.length
    ? await tx
        .select()
        .from(deployApprovals)
        .where(inArray(deployApprovals.deployId, withApproval))
        .orderBy(asc(deployApprovals.createdAt))
    : [];
  const people = await peopleOf(tx, [...rows.map((r) => r.deploy.requestedBy), ...approvals.map((a) => a.userId)]);
  const onWorker = rows.filter((r) => r.deploy.origin === "hive" && !r.deploy.ranLegacy).map((r) => r.deploy);
  const jobs = await latestJobs(
    tx,
    onWorker.map((d) => d.id),
  );
  const machineIds = onWorker.flatMap((d) => {
    const id = d.ranOnWorkerId ?? jobs.get(d.id)?.workerId;
    return id ? [id] : [];
  });
  const names = await machineNames(tx, [...new Set(machineIds)]);
  return rows.map((r) =>
    view(
      r,
      people,
      approvals.filter((a) => a.deployId === r.deploy.id),
      viewRunner(r.deploy, jobs.get(r.deploy.id), names),
    ),
  );
}

export async function deployView(tx: Tx, row: LocatedDeploy): Promise<Deploy> {
  return (await deployViews(tx, [row]))[0] as Deploy;
}

// ---- Đọc ------------------------------------------------------------------------------------------------------------

export async function getDeploy(tx: Tx, userId: string, id: string): Promise<Deploy> {
  const row = await loadLocatedDeploy(tx, id);
  if (!row) throw deployNotFound();
  await requireTeamPermission(tx, userId, row.teamId, "ci.view", deployNotFound);
  return deployView(tx, row);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lịch sử, mới nhất trước. Con trỏ là id của lần cuối trang trước; trang sau lấy các lần tạo trước nó. */
export async function listDeploys(
  tx: Tx,
  userId: string,
  input: DeployListInput,
): Promise<{ items: Deploy[]; nextCursor: string | null }> {
  if (input.cursor !== undefined && !UUID.test(input.cursor))
    throw new BadRequestError("INVALID_CURSOR", "Con trỏ trang không hợp lệ. Tải lại danh sách.");
  // Lọc theo đội ngay trong truy vấn để trang luôn đủ `limit` dòng nhìn thấy được.
  const teams = await tx.selectDistinct({ teamId: deployEnvironments.teamId }).from(deployEnvironments);
  const visible: string[] = [];
  for (const { teamId } of teams)
    if ((await effectivePermissions(tx, userId, teamId)).has("ci.view")) visible.push(teamId);
  if (visible.length === 0) return { items: [], nextCursor: null };

  const rows = await locatedDeploys(
    tx,
    and(
      inArray(deployEnvironments.teamId, visible),
      input.systemId ? eq(deployEnvironments.systemId, input.systemId) : undefined,
      input.projectId ? eq(deployTargets.projectId, input.projectId) : undefined,
      input.environmentId ? eq(deployTargets.environmentId, input.environmentId) : undefined,
      input.targetId ? eq(deploys.targetId, input.targetId) : undefined,
      input.state ? eq(deploys.state, input.state) : undefined,
      input.origin ? eq(deploys.origin, input.origin) : undefined,
      input.cursor
        ? sql`(${deploys.createdAt}, ${deploys.id}) < (select d.created_at, d.id from hive.deploys d where d.id = ${input.cursor})`
        : undefined,
    ),
  )
    .orderBy(desc(deploys.createdAt), desc(deploys.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  return {
    items: await deployViews(tx, page),
    nextCursor: rows.length > input.limit ? (page.at(-1)?.deploy.id ?? null) : null,
  };
}

/**
 * Bảng "đang chạy" (FR-020): dòng là dự án, cột là môi trường. Ô là lần thành công gần nhất của đích (kể cả "ngoài
 * Hive", vì đó là bản đang chạy thật) và lần do Hive tạo đang đi nếu có.
 */
export async function deployBoard(tx: Tx, userId: string, systemId: string): Promise<DeployBoard> {
  const environments = await listEnvironments(tx, userId, systemId);
  const targets = await tx
    .select({
      id: deployTargets.id,
      projectId: deployTargets.projectId,
      environmentId: deployTargets.environmentId,
      method: deployTargets.method,
    })
    .from(deployTargets)
    .innerJoin(deployEnvironments, eq(deployEnvironments.id, deployTargets.environmentId))
    .where(eq(deployEnvironments.systemId, systemId));
  const targetIds = targets.map((t) => t.id);

  const current = targetIds.length
    ? await tx
        .selectDistinctOn([deploys.targetId], locatedColumns)
        .from(deploys)
        .innerJoin(deployTargets, eq(deployTargets.id, deploys.targetId))
        .innerJoin(deployEnvironments, eq(deployEnvironments.id, deployTargets.environmentId))
        .where(and(inArray(deploys.targetId, targetIds), eq(deploys.state, "succeeded")))
        .orderBy(
          deploys.targetId,
          desc(sql`coalesce(${deploys.finishedAt}, ${deploys.createdAt})`),
          desc(deploys.createdAt),
        )
    : [];
  const active = targetIds.length
    ? await locatedDeploys(
        tx,
        and(
          inArray(deploys.targetId, targetIds),
          eq(deploys.origin, "hive"),
          inArray(deploys.state, [...DEPLOY_ACTIVE_STATES]),
        ),
      )
    : [];
  const views = await deployViews(tx, [...current, ...active]);
  const currentOf = new Map(views.slice(0, current.length).map((d) => [d.targetId, d]));
  const activeOf = new Map(views.slice(current.length).map((d) => [d.targetId, d]));

  // [Suy luận] Dự án của hệ thống mà người xem có vai trò, cộng dự án đã có đích (người có `ci.view` nhờ vai trò tự tạo
  // vẫn thấy dòng của đích).
  const projects = new Map((await listProjects(tx, userId, systemId)).map((p) => [p.id, p.name]));
  for (const t of targets) {
    if (projects.has(t.projectId)) continue;
    const p = await findProject(tx, t.projectId);
    if (p) projects.set(p.id, p.name);
  }
  const rows = [...projects.entries()]
    .sort(([, a], [, b]) => a.localeCompare(b, "vi"))
    .map(([projectId, projectName]) => ({
      projectId,
      projectName,
      cells: environments.map((env) => {
        const target = targets.find((t) => t.projectId === projectId && t.environmentId === env.id);
        return {
          environmentId: env.id,
          targetId: target?.id ?? null,
          method: (target?.method ?? null) as Deploy["method"] | null,
          current: target ? (currentOf.get(target.id) ?? null) : null,
          active: target ? (activeOf.get(target.id) ?? null) : null,
        };
      }),
    }));
  return { environments, rows };
}
