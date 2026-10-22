import type { CiProjectJob } from "@xdev-hive/contracts";
import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit/index.ts";
import { findProject, type ProjectRef } from "../../catalog/index.ts";
import { ConflictError, ForbiddenError, NotFoundError, type Tx } from "../../platform/index.ts";
import { allowWith, requireTeamRole, type TeamRole } from "../../tenancy/index.ts";
import { jobUrlPath } from "../clients/jenkins.ts";
import { type JenkinsAuth, jenkinsAuth } from "../connections/credentials.ts";
import {
  type JenkinsDeps,
  jenkinsClient,
  jenkinsDomainError,
  pgCode,
  requireMasterKey,
} from "../connections/jenkins.ts";
import { ciJenkinsConnections, ciProjectJobs } from "../schema.ts";

// Job Jenkins gắn với dự án (FR-002). Gắn, gỡ cần `servers.manage` của đội sở hữu dự án (spec FR-030).

const projectNotFound = () => new NotFoundError("NOT_FOUND", "Không tìm thấy dự án.");

/** Người ngoài đội thì báo như dự án không tồn tại, giống `projectFor` của catalog. */
async function projectWith(
  tx: Tx,
  userId: string,
  projectId: string,
  permission: string,
  min: TeamRole,
): Promise<ProjectRef> {
  const project = await findProject(tx, projectId);
  if (!project) throw projectNotFound();
  try {
    await allowWith(tx, userId, permission, () => requireTeamRole(tx, userId, project.teamId, min), project.teamId);
  } catch (e) {
    if (e instanceof ForbiddenError && e.code === "NOT_TEAM_MEMBER") throw projectNotFound();
    throw e;
  }
  return project;
}

function jobUrl(baseUrl: string, jobPath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${jobUrlPath(jobPath)}/`;
}

const jobColumns = {
  id: ciProjectJobs.id,
  projectId: ciProjectJobs.projectId,
  connectionId: ciProjectJobs.connectionId,
  connectionName: ciJenkinsConnections.name,
  connectionUrl: ciJenkinsConnections.url,
  jobPath: ciProjectJobs.jobPath,
  createdAt: ciProjectJobs.createdAt,
};

function view(r: JobRow): CiProjectJob {
  return {
    id: r.id,
    projectId: r.projectId,
    connectionId: r.connectionId,
    connectionName: r.connectionName,
    jobPath: r.jobPath,
    url: jobUrl(r.connectionUrl, r.jobPath),
    createdAt: r.createdAt.toISOString(),
  };
}

function selectJobs(tx: Tx) {
  return tx
    .select(jobColumns)
    .from(ciProjectJobs)
    .innerJoin(ciJenkinsConnections, eq(ciJenkinsConnections.id, ciProjectJobs.connectionId));
}

type JobRow = Awaited<ReturnType<typeof selectJobs>>[number];

export async function listProjectJobs(tx: Tx, userId: string, projectId: string): Promise<CiProjectJob[]> {
  const project = await projectWith(tx, userId, projectId, "ci.view", "viewer");
  const rows = await selectJobs(tx)
    .where(eq(ciProjectJobs.projectId, project.id))
    .orderBy(ciJenkinsConnections.name, ciProjectJobs.jobPath);
  return rows.map(view);
}

/** Token của người gọi; chưa có thì mượn token người theo dõi, chỉ để đọc xem job có tồn tại. */
async function readAuth(tx: Tx, deps: JenkinsDeps, userId: string, connectionId: string): Promise<JenkinsAuth> {
  const masterKey = requireMasterKey(deps);
  try {
    return await jenkinsAuth(tx, masterKey, { connectionId, userId, reason: "ci.job.add" });
  } catch (e) {
    if (!(e instanceof ForbiddenError && e.code === "JENKINS_NO_TOKEN")) throw e;
    return jenkinsAuth(tx, masterKey, { connectionId, userId: "watcher", reason: "ci.job.add" });
  }
}

export async function addProjectJob(
  tx: Tx,
  deps: JenkinsDeps,
  userId: string,
  input: { projectId: string; connectionId: string; jobPath: string },
): Promise<CiProjectJob> {
  const project = await projectWith(tx, userId, input.projectId, "servers.manage", "admin");
  const [conn] = await tx
    .select({ id: ciJenkinsConnections.id })
    .from(ciJenkinsConnections)
    .where(eq(ciJenkinsConnections.id, input.connectionId));
  if (!conn) throw new NotFoundError("NOT_FOUND", "Không tìm thấy kết nối Jenkins.");

  const auth = await readAuth(tx, deps, userId, input.connectionId);
  try {
    await jenkinsClient(deps, auth).job(input.jobPath);
  } catch (e) {
    throw jenkinsDomainError(e, input.connectionId);
  }

  let inserted: { id: string } | undefined;
  try {
    [inserted] = await tx
      .insert(ciProjectJobs)
      .values({
        orgId: sql`hive.ctx_org()`,
        projectId: project.id,
        connectionId: input.connectionId,
        jobPath: input.jobPath,
        createdBy: userId,
      })
      .returning({ id: ciProjectJobs.id });
  } catch (e) {
    if (pgCode(e) === "23505") throw new ConflictError("CI_JOB_EXISTS", "Job này đã gắn với dự án.");
    throw e;
  }
  if (!inserted) throw new Error("Không gắn được job Jenkins.");
  const { id } = inserted;
  await recordAudit(tx, {
    action: "delivery.ci_job.add",
    targetType: "ci_project_job",
    targetId: id,
    data: { projectId: project.id, connectionId: input.connectionId, jobPath: input.jobPath },
  });
  const [row] = await selectJobs(tx).where(eq(ciProjectJobs.id, id));
  if (!row) throw new Error("Không đọc lại được job Jenkins vừa gắn.");
  return view(row);
}

export async function removeProjectJob(
  tx: Tx,
  userId: string,
  input: { projectId: string; jobId: string },
): Promise<{ ok: true }> {
  const project = await projectWith(tx, userId, input.projectId, "servers.manage", "admin");
  const [row] = await tx
    .delete(ciProjectJobs)
    .where(and(eq(ciProjectJobs.id, input.jobId), eq(ciProjectJobs.projectId, project.id)))
    .returning({ connectionId: ciProjectJobs.connectionId, jobPath: ciProjectJobs.jobPath });
  if (!row) throw new NotFoundError("NOT_FOUND", "Không tìm thấy job Jenkins của dự án.");
  await recordAudit(tx, {
    action: "delivery.ci_job.remove",
    targetType: "ci_project_job",
    targetId: input.jobId,
    data: { projectId: project.id, connectionId: row.connectionId, jobPath: row.jobPath },
  });
  return { ok: true };
}
