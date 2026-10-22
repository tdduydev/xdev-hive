import { implement } from "@orpc/server";
import { contract, type ProjectTokenUsageRow } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import { NotFoundError, type RequestContext, type Tx } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares, teamRoleOf } from "../tenancy/index.ts";
import { addProjectMembers, listProjectMembers, myProjectMembership, removeProjectMember } from "./members.ts";
import { enqueueMergeAs, queueForUser, removeMergeAs } from "./merge-queue.ts";
import {
  type CatalogDeps,
  createProject,
  dryRunCreate,
  findProject,
  getProject,
  getProvision,
  listProjects,
  retryStep,
} from "./projects.ts";
import { updateProjectSettings } from "./settings.ts";

export function catalogRouter(deps: CatalogDeps & OrgDeps) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const os = implement(contract.projects).$context<RequestContext>().use(authed);
  return {
    // Chạy thử gọi ra GitHub/GitLab nên không giữ transaction (orgMember); tạo thật chỉ ghi database, job gửi
    // trong cùng transaction.
    create: os.create.use(orgMember).handler(({ context: { pool, user, orgId }, input }) => {
      const actor = { userId: user.id, orgId };
      return input.dryRun ? dryRunCreate(pool, deps, actor, input) : createProject(pool, deps, actor, input);
    }),
    list: os.list.use(inOrg).handler(({ context: { tx, user }, input }) => listProjects(tx, user.id, input.systemId)),
    get: os.get.use(inOrg).handler(({ context: { tx, user }, input }) => getProject(tx, user.id, input.id)),
    provision: os.provision
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => getProvision(tx, deps, user.id, input.id)),
    retryStep: os.retryStep
      .use(inOrg)
      .handler(({ context: { tx, user, orgId }, input }) =>
        retryStep(tx, deps, { userId: user.id, orgId }, input.id, input.stepId),
      ),
    mergeQueue: os.mergeQueue
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => queueForUser(tx, user.id, input.id)),
    enqueueMerge: os.enqueueMerge
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) =>
        enqueueMergeAs(tx, deps, user.id, { projectId: input.id, prNumber: input.prNumber }),
      ),
    removeMerge: os.removeMerge
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) =>
        removeMergeAs(tx, deps, user.id, { projectId: input.id, entryId: input.entryId }),
      ),
    updateSettings: os.updateSettings
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => updateProjectSettings(tx, user.id, input.key, input.settings)),
    tokenUsage: os.tokenUsage.use(inOrg).handler(async ({ context: { tx, user }, input }) => ({
      rows: await projectTokenUsage(tx, user.id, input.key, input.days),
    })),
  };
}

/**
 * Token theo người và máy của dự án (spec 029): dòng mới nhất của từng máy có kỳ kết thúc trong `days` ngày. Ai có vai
 * trò ở đội của dự án thì xem được, như xem dự án. Bảng thuộc fleet nhưng đọc bằng SQL: fleet đã phụ thuộc catalog
 * (qua knowledge), import ngược fleet sẽ thành vòng tròn.
 */
async function projectTokenUsage(tx: Tx, userId: string, key: string, days: number): Promise<ProjectTokenUsageRow[]> {
  const project = await findProject(tx, key);
  // Không có quyền xem thì báo như không tồn tại để không lộ dự án.
  if (!project || !(await teamRoleOf(tx, userId, project.teamId)))
    throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
  const { rows } = await tx.execute<{
    user_id: string;
    user_name: string | null;
    machine_id: string;
    machine_name: string;
    period_end: Date | string;
    tokens: Record<string, { weighted: number } | undefined>;
    sessions: number;
    score: number | null;
    policy_drift: ProjectTokenUsageRow["policyDrift"];
  }>(sql`
    select distinct on (u.machine_id)
           u.user_id, au.name as user_name, u.machine_id, m.name as machine_name, u.period_end, u.tokens, u.sessions,
           u.score, u.policy_drift
      from hive.project_token_usage u
      join hive.machines m on m.id = u.machine_id
      left join auth."user" au on au.id = u.user_id
     where u.project_id = ${project.id} and u.period_end > now() - make_interval(days => ${days})
     order by u.machine_id, u.period_end desc`);
  const out = rows.map((r) => ({
    userId: r.user_id,
    userName: r.user_name ?? "",
    machineId: r.machine_id,
    machineName: r.machine_name,
    periodEnd: new Date(r.period_end).toISOString(),
    // Token quy đổi (weighted) như điểm máy: cộng mọi CLI.
    tokens: Math.round(Object.values(r.tokens).reduce((sum, t) => sum + (t?.weighted ?? 0), 0)),
    sessions: r.sessions,
    score: r.score,
    policyDrift: r.policy_drift,
  }));
  return out.sort((x, y) => y.tokens - x.tokens);
}

export function projectMembersRouter(deps: CatalogDeps & OrgDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.projectMembers).$context<RequestContext>().use(authed);
  return {
    list: os.list.use(inOrg).handler(({ context: { tx, user }, input }) => listProjectMembers(tx, user.id, input.id)),
    add: os.add
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => addProjectMembers(tx, user.id, input.id, input.userIds)),
    remove: os.remove
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => removeProjectMember(tx, user.id, input.id, input.userId)),
    mine: os.mine.use(inOrg).handler(({ context: { tx, user } }) => myProjectMembership(tx, user.id)),
  };
}
