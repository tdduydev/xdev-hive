import { randomBytes, randomUUID } from "node:crypto";
import {
  defaultProjectSettings,
  type Project,
  type ProjectCreateRequest,
  type ProjectCreateResult,
  type ProvisionStep,
  type ProvisionView,
  parseRepoUrl,
} from "@xdev-hive/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { loadPolicy } from "../governance/index.ts";
import {
  ConflictError,
  encryptSecret,
  type Jobs,
  type MasterKey,
  NotFoundError,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import {
  type GitProvider,
  isGitProviderError,
  loadConnection,
  type ProviderFactory,
  type ResolvedConnection,
} from "../scm/index.ts";
import { allowWith, findSystem, requireTeamRole, type TeamRole, teamRoleOf } from "../tenancy/index.ts";
import { projectProvisionSteps, projects } from "./schema.ts";
import { type PlannedStep, planSteps } from "./steps.ts";
import { renderTemplate } from "./template.ts";

export const PROVISION_QUEUE = "catalog-provision";

/** Payload của job khởi tạo. Chỉ mang id; job đọc lại mọi thứ từ database trong tenant của tổ chức. */
export interface ProvisionJob {
  orgId: string;
  projectId: string;
}

export interface CatalogDeps {
  masterKey?: MasterKey | undefined;
  providerFactory: ProviderFactory;
  /** HIVE_PUBLIC_URL: dựng URL webhook và cấu hình MCP trong file mẫu. */
  publicUrl: string;
  jobs?: Jobs | undefined;
}

export interface Actor {
  userId: string;
  orgId: string;
}

export type ProjectRow = typeof projects.$inferSelect;
type StepRow = typeof projectProvisionSteps.$inferSelect;

/** Mỗi dự án một URL: hub biết ngay dự án (và secret để kiểm chữ ký) từ đường dẫn, không phải đoán từ payload. */
export const webhookUrl = (publicUrl: string, projectId: string | null) =>
  `${publicUrl.replace(/\/+$/, "")}/hooks/git/${projectId ?? "<id dự án>"}`;
export const webhookSecretContext = (projectId: string) => `projects:${projectId}:webhook`;
export const repoMarker = (projectId: string) => `xdev-hive:${projectId}`;

const notFound = () => new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
const UNIQUE_VIOLATION = "23505";
const pgError = (e: unknown) => ((e as { cause?: unknown }).cause ?? e) as { code?: string; constraint?: string };

function needKey(deps: CatalogDeps): MasterKey {
  if (!deps.masterKey) {
    throw new ConflictError("MASTER_KEY_MISSING", "Hub chưa cấu hình HIVE_MASTER_KEY nên chưa dùng được kết nối Git.");
  }
  return deps.masterKey;
}

const templateFileCount = renderTemplate({
  projectKey: "x",
  projectName: "x",
  publicUrl: "http://x",
  defaultBranch: "main",
  systemName: "x",
}).length;

function planFor(
  project: ProjectRow,
  deps: Pick<CatalogDeps, "publicUrl">,
  opts: Pick<PlanOpts, "protection" | "webhook">,
) {
  return planSteps({
    mode: project.repoMode,
    scmKind: project.scmKind,
    owner: project.repoOwner,
    name: project.repoName,
    defaultBranch: project.defaultBranch,
    visibility: project.repoVisibility,
    protection: opts.protection,
    webhook: opts.webhook,
    webhookUrl: webhookUrl(deps.publicUrl, project.id),
    templateFileCount,
  });
}

interface PlanOpts {
  protection: { protectDefault: boolean; requiredApprovals: number };
  webhook: boolean;
}

/** Tiêu đề bước tính lại từ dự án hiện tại, để nhánh chính đọc được sau bước link-repo hiện đúng tên. */
function titles(project: ProjectRow, steps: StepRow[], deps: Pick<CatalogDeps, "publicUrl">): Map<string, string> {
  const protect = steps.find((s) => s.kind === "protect-branch");
  const plan = planFor(project, deps, {
    protection: {
      protectDefault: protect !== undefined,
      requiredApprovals: Number(protect?.params.requiredApprovals ?? 0),
    },
    webhook: steps.some((s) => s.kind === "add-webhook"),
  });
  return new Map(plan.map((p) => [p.kind, p.title]));
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function projectView(p: ProjectRow): Project {
  return {
    id: p.id,
    systemId: p.systemId,
    teamId: p.teamId,
    key: p.key,
    name: p.name,
    state: p.state,
    repo: {
      mode: p.repoMode,
      connectionId: p.scmConnectionId,
      kind: p.scmKind,
      owner: p.repoOwner,
      name: p.repoName,
      defaultBranch: p.defaultBranch,
      visibility: p.repoVisibility,
      httpUrl: p.repoHttpUrl,
      sshUrl: p.repoSshUrl,
      webUrl: p.repoWebUrl,
    },
    settings: p.settings,
    createdBy: p.createdBy,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function stepViews(project: ProjectRow, steps: StepRow[], deps: Pick<CatalogDeps, "publicUrl">): ProvisionStep[] {
  const t = titles(project, steps, deps);
  return steps.map((s) => ({
    id: s.id,
    kind: s.kind,
    target: s.target,
    title: t.get(s.kind) ?? s.kind,
    position: s.position,
    state: s.state,
    error: s.error,
    result: s.result,
    attempts: s.attempts,
    startedAt: iso(s.startedAt),
    finishedAt: iso(s.finishedAt),
  }));
}

export async function loadProject(tx: Tx, id: string): Promise<ProjectRow | null> {
  const [row] = await tx.select().from(projects).where(eq(projects.id, id));
  return row ?? null;
}

export interface ProjectRef {
  id: string;
  key: string;
  name: string;
  teamId: string;
  systemId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dự án theo id hoặc project key trong tổ chức của context; RLS lọc tổ chức khác. Không kiểm quyền: module gọi tự
 * kiểm theo đội sở hữu. Agent biết key (từ AGENTS.md), web biết id, nên nhận cả hai.
 */
export async function findProject(tx: Tx, ref: string): Promise<ProjectRef | null> {
  const [row] = await tx
    .select({
      id: projects.id,
      key: projects.key,
      name: projects.name,
      teamId: projects.teamId,
      systemId: projects.systemId,
    })
    .from(projects)
    .where(UUID.test(ref) ? eq(projects.id, ref) : eq(projects.key, ref));
  return row ?? null;
}

export function loadSteps(tx: Tx, projectId: string): Promise<StepRow[]> {
  return tx
    .select()
    .from(projectProvisionSteps)
    .where(eq(projectProvisionSteps.projectId, projectId))
    .orderBy(asc(projectProvisionSteps.position));
}

/** Dự án mà người dùng có ít nhất vai trò `min` trong đội sở hữu; không đủ quyền thì báo như không tồn tại. */
export async function projectFor(tx: Tx, userId: string, id: string, min: TeamRole): Promise<ProjectRow> {
  const project = await loadProject(tx, id);
  // Không có quyền xem thì trả NOT_FOUND để không lộ dự án có tồn tại.
  if (!project || !(await teamRoleOf(tx, userId, project.teamId))) throw notFound();
  await requireTeamRole(tx, userId, project.teamId, min);
  return project;
}

// ---------------------------------------------------------------------------------------------------------------
// projects.create

interface Prepared {
  system: { id: string; teamId: string; name: string };
  conn: ResolvedConnection;
  repo: { owner: string; name: string; host: string | null };
  keyTaken: boolean;
}

/** Phần đọc database của projects.create: kiểm quyền, hệ thống, kết nối. Dùng chung cho dryRun và chạy thật. */
async function prepare(tx: Tx, deps: CatalogDeps, actor: Actor, input: ProjectCreateRequest): Promise<Prepared> {
  const system = await findSystem(tx, input.systemId);
  if (!system) throw new NotFoundError("SYSTEM_NOT_FOUND", "Không tìm thấy hệ thống trong tổ chức.");
  await allowWith(
    tx,
    actor.userId,
    "projects.create",
    () => requireTeamRole(tx, actor.userId, system.teamId, "admin"),
    system.teamId,
  );
  const conn = await loadConnection(tx, needKey(deps), input.repo.connectionId);
  if (!conn) throw new NotFoundError("SCM_CONNECTION_NOT_FOUND", "Không tìm thấy kết nối Git trong tổ chức.");
  let repo: Prepared["repo"];
  if (input.repo.mode === "new") {
    repo = { owner: input.repo.owner, name: input.repo.name, host: null };
  } else {
    // Contract đã kiểm URL; parse lại để lấy owner/name.
    const parsed = parseRepoUrl(input.repo.url);
    if (!parsed) throw new ConflictError("REPO_URL_INVALID", "URL repo không hợp lệ.");
    repo = parsed;
  }
  const [taken] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.key, input.key)).limit(1);
  return { system, conn, repo, keyTaken: taken !== undefined };
}

function plan(deps: CatalogDeps, input: ProjectCreateRequest, p: Prepared, projectId: string | null): PlannedStep[] {
  return planSteps({
    mode: input.repo.mode,
    scmKind: p.conn.kind,
    owner: p.repo.owner,
    name: p.repo.name,
    defaultBranch: input.repo.mode === "new" ? input.repo.defaultBranch : null,
    visibility: input.repo.mode === "new" ? input.repo.visibility : null,
    description: input.repo.mode === "new" ? input.repo.description : undefined,
    protection: input.protection,
    webhook: input.webhook,
    webhookUrl: webhookUrl(deps.publicUrl, projectId),
    templateFileCount,
  });
}

type Warning = ProjectCreateResult["warnings"][number];

/** Hỏi nhà cung cấp như saga sẽ làm, nhưng chỉ đọc. Lỗi gọi API thành cảnh báo để người dùng vẫn xem được kế hoạch. */
async function checkWithProvider(provider: GitProvider, input: ProjectCreateRequest, p: Prepared): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const ref = { owner: p.repo.owner, name: p.repo.name };
  try {
    if (input.repo.mode === "new") {
      const access = await provider.checkAccess(ref.owner);
      if (!access.canCreate) {
        warnings.push({
          code: "ACCESS_MISSING",
          message: `Kết nối chưa tạo được repo trong ${ref.owner}${
            access.missingScopes.length ? `: thiếu ${access.missingScopes.join(", ")}` : ""
          }. Bước kiểm quyền sẽ lỗi cho tới khi cấp đủ quyền.`,
        });
      } else if (access.missingScopes.length) {
        warnings.push({ code: "SCOPES_MISSING", message: `Kết nối thiếu quyền: ${access.missingScopes.join(", ")}.` });
      }
      if (access.unverifiedScopes?.length) {
        warnings.push({
          code: "SCOPES_UNVERIFIED",
          message: `Token không cho đọc quyền của nó nên chưa kiểm trước được: ${access.unverifiedScopes.join(
            ", ",
          )}. Thiếu quyền nào thì bước tương ứng sẽ lỗi và báo rõ.`,
        });
      }
      if (await provider.getRepo(ref)) {
        warnings.push({
          code: "REPO_EXISTS",
          message: `Đã có repo ${ref.owner}/${ref.name}. Đổi tên repo, hoặc chọn chế độ repo có sẵn.`,
        });
      }
    } else {
      const repo = await provider.getRepo(ref);
      if (!repo) {
        warnings.push({
          code: "REPO_NOT_FOUND",
          message: `Kết nối không thấy repo ${ref.owner}/${ref.name}. Kiểm URL và quyền của kết nối trên repo.`,
        });
      } else if (input.protection.protectDefault) {
        warnings.push({
          code: "PROTECTION_OVERWRITE",
          message: `Bảo vệ nhánh ${repo.defaultBranch} sẽ thay quy tắc đang có của nhánh này (nếu có).`,
        });
      }
    }
  } catch (e) {
    if (!isGitProviderError(e)) throw e;
    warnings.push({ code: "SCM_ERROR", message: `Không kiểm được với nhà cung cấp: ${e.message}` });
  }
  return warnings;
}

function localWarnings(deps: CatalogDeps, input: ProjectCreateRequest, p: Prepared): Warning[] {
  const warnings: Warning[] = [];
  if (p.keyTaken) {
    warnings.push({ code: "KEY_TAKEN", message: `Project key "${input.key}" đã có trong tổ chức. Chọn key khác.` });
  }
  if (p.repo.host && p.conn.baseUrl) {
    const connHost = new URL(p.conn.baseUrl).host.toLowerCase();
    if (!connHost.endsWith(p.repo.host) && !p.repo.host.endsWith(connHost.replace(/^api\./, ""))) {
      warnings.push({
        code: "REPO_HOST_MISMATCH",
        message: `Repo ở ${p.repo.host} nhưng kết nối trỏ tới ${connHost}. Kiểm lại kết nối đã chọn.`,
      });
    }
  }
  if (input.webhook && /^https?:\/\/(localhost|127\.|\[::1\])/.test(deps.publicUrl)) {
    warnings.push({
      code: "WEBHOOK_UNREACHABLE",
      message: `HIVE_PUBLIC_URL là ${deps.publicUrl}: GitHub/GitLab không gọi được webhook về địa chỉ này.`,
    });
  }
  return warnings;
}

const plannedView = (steps: PlannedStep[]) => steps.map(({ kind, target, title }) => ({ kind, target, title }));

export async function dryRunCreate(
  pool: pg.Pool,
  deps: CatalogDeps,
  actor: Actor,
  input: ProjectCreateRequest,
): Promise<ProjectCreateResult> {
  // Đọc database trong transaction ngắn, gọi nhà cung cấp sau khi đã trả kết nối.
  const p = await withTenant(pool, actor, (tx) => prepare(tx, deps, actor, input));
  const warnings = [
    ...localWarnings(deps, input, p),
    ...(await checkWithProvider(deps.providerFactory(p.conn), input, p)),
  ];
  return { dryRun: true, projectId: null, state: "planned", steps: plannedView(plan(deps, input, p, null)), warnings };
}

async function existingByIdempotencyKey(
  tx: Tx,
  deps: CatalogDeps,
  actor: Actor,
  key: string,
): Promise<ProjectCreateResult | null> {
  const [project] = await tx.select().from(projects).where(eq(projects.idempotencyKey, key));
  if (!project) return null;
  // Khoá chống trùng không phải bí mật đủ mạnh để thay quyền: người gửi lại vẫn phải quản trị đội của dự án.
  await requireTeamRole(tx, actor.userId, project.teamId, "admin");
  const steps = stepViews(project, await loadSteps(tx, project.id), deps);
  return {
    dryRun: false,
    projectId: project.id,
    state: project.state,
    steps: steps.map(({ kind, target, title }) => ({ kind, target, title })),
    warnings: [],
  };
}

/** Settings của dự án mới: quyền CLI mặc định theo Chính sách agent của tổ chức. */
async function initialSettings(tx: Tx, requiredApprovals: number) {
  const settings = defaultProjectSettings(requiredApprovals);
  const policy = await loadPolicy(tx);
  if (policy.defaultPermissionMode === "full" && policy.allowFullPermission) settings.runPermissions = { mode: "full" };
  return settings;
}

/**
 * Tạo dự án thật: một transaction gồm dự án (provisioning), các bước, job khởi tạo và audit. Job gửi trong cùng
 * transaction nên không có dự án mắc kẹt ở provisioning vì job bị mất, cũng không có job chạy cho dự án đã rollback.
 */
export async function createProject(
  pool: pg.Pool,
  deps: CatalogDeps,
  actor: Actor,
  input: ProjectCreateRequest,
): Promise<ProjectCreateResult> {
  const jobs = deps.jobs;
  if (!jobs) {
    throw new ConflictError("JOBS_DISABLED", "Hub chưa bật hàng đợi (HIVE_DATABASE_JOBS_URL) nên chưa tạo được dự án.");
  }
  const key = needKey(deps);
  return withTenant(pool, actor, async (tx) => {
    // Kiểm khoá chống trùng trước khi kiểm quyền: lần gửi lại sau khi đã tạo vẫn nhận đúng dự án cũ.
    const again = await existingByIdempotencyKey(tx, deps, actor, input.idempotencyKey);
    if (again) return again;
    // Không chặn sớm theo p.keyTaken: lần gửi trùng chạy song song có thể thấy dự án vừa commit ở đây. Để INSERT
    // quyết định, vì ON CONFLICT theo khoá chống trùng được xét trước ràng buộc key.
    const p = await prepare(tx, deps, actor, input);
    const id = randomUUID();
    const isNew = input.repo.mode === "new";
    let inserted: Array<{ id: string }>;
    try {
      inserted = await tx
        .insert(projects)
        .values({
          id,
          orgId: sql`hive.ctx_org()`,
          teamId: p.system.teamId,
          systemId: p.system.id,
          key: input.key,
          name: input.name,
          scmConnectionId: p.conn.id,
          scmKind: p.conn.kind,
          repoMode: input.repo.mode,
          repoOwner: p.repo.owner,
          repoName: p.repo.name,
          repoVisibility: input.repo.mode === "new" ? input.repo.visibility : null,
          defaultBranch: input.repo.mode === "new" ? input.repo.defaultBranch : null,
          settings: await initialSettings(tx, input.protection.protectDefault ? input.protection.requiredApprovals : 0),
          idempotencyKey: input.idempotencyKey,
          webhookSecretEnc: input.webhook
            ? encryptSecret(key, randomBytes(32).toString("hex"), webhookSecretContext(id))
            : null,
          createdBy: actor.userId,
        })
        // Hai lần gửi cùng khoá chạy song song: bên tới sau chờ bên trước commit rồi không chèn gì.
        .onConflictDoNothing({ target: [projects.orgId, projects.idempotencyKey] })
        .returning({ id: projects.id });
    } catch (e) {
      const err = pgError(e);
      if (err.code === UNIQUE_VIOLATION && err.constraint === "projects_org_key") {
        throw new ConflictError("KEY_TAKEN", `Project key "${input.key}" đã có trong tổ chức.`);
      }
      if (err.code === UNIQUE_VIOLATION && err.constraint === "projects_repo") {
        throw new ConflictError("REPO_TAKEN", `Repo ${p.repo.owner}/${p.repo.name} đã thuộc một dự án khác.`);
      }
      throw e;
    }
    if (inserted.length === 0) {
      const raced = await existingByIdempotencyKey(tx, deps, actor, input.idempotencyKey);
      if (raced) return raced;
      throw new Error("Không tạo được dự án.");
    }
    const steps = plan(deps, input, p, id);
    await tx.insert(projectProvisionSteps).values(
      steps.map((s, i) => ({
        orgId: sql`hive.ctx_org()`,
        projectId: id,
        position: i + 1,
        kind: s.kind,
        target: s.target,
        params: s.params,
      })),
    );
    const jobId = await jobs.enqueue<ProvisionJob>(
      PROVISION_QUEUE,
      { orgId: actor.orgId, projectId: id },
      { tx, singletonKey: id },
    );
    await recordAudit(tx, {
      action: "project.create",
      targetType: "project",
      targetId: id,
      data: {
        key: input.key,
        systemId: p.system.id,
        connectionId: p.conn.id,
        repo: { mode: input.repo.mode, owner: p.repo.owner, name: p.repo.name },
        protection: input.protection,
        webhook: input.webhook,
        jobId,
        newRepo: isNew,
      },
    });
    return { dryRun: false, projectId: id, state: "provisioning", steps: plannedView(steps), warnings: [] };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Đọc

export async function listProjects(tx: Tx, userId: string, systemId?: string): Promise<Project[]> {
  const rows = await tx
    .select()
    .from(projects)
    .where(systemId ? eq(projects.systemId, systemId) : undefined)
    .orderBy(asc(projects.name));
  // Lọc theo đội mình có vai trò. Số đội trong một tổ chức nhỏ, hỏi từng đội một lần là đủ.
  const roles = new Map<string, TeamRole | null>();
  for (const teamId of new Set(rows.map((r) => r.teamId))) roles.set(teamId, await teamRoleOf(tx, userId, teamId));
  return rows.filter((r) => roles.get(r.teamId)).map(projectView);
}

export async function getProject(tx: Tx, userId: string, id: string): Promise<Project> {
  return projectView(await projectFor(tx, userId, id, "viewer"));
}

export async function getProvision(
  tx: Tx,
  deps: Pick<CatalogDeps, "publicUrl">,
  userId: string,
  id: string,
): Promise<ProvisionView> {
  const project = await projectFor(tx, userId, id, "viewer");
  return { project: projectView(project), steps: stepViews(project, await loadSteps(tx, id), deps) };
}

/**
 * Đưa bước lỗi về pending và gửi lại job; saga bỏ qua các bước đã xong nên chỉ chạy lại từ bước này. Cùng một
 * transaction với job như lúc tạo.
 */
export async function retryStep(
  tx: Tx,
  deps: CatalogDeps,
  actor: Actor,
  id: string,
  stepId: string,
): Promise<ProvisionView> {
  const jobs = deps.jobs;
  if (!jobs) {
    throw new ConflictError("JOBS_DISABLED", "Hub chưa bật hàng đợi (HIVE_DATABASE_JOBS_URL) nên chưa chạy lại được.");
  }
  const project = await projectFor(tx, actor.userId, id, "admin");
  const reset = await tx
    .update(projectProvisionSteps)
    .set({ state: "pending", error: null, startedAt: null, finishedAt: null })
    .where(
      and(
        eq(projectProvisionSteps.id, stepId),
        eq(projectProvisionSteps.projectId, id),
        inArray(projectProvisionSteps.state, ["failed"]),
      ),
    )
    .returning({ kind: projectProvisionSteps.kind });
  const [step] = reset;
  if (!step) {
    const exists = (await loadSteps(tx, id)).some((s) => s.id === stepId);
    if (!exists) throw new NotFoundError("STEP_NOT_FOUND", "Không tìm thấy bước khởi tạo này.");
    throw new ConflictError("STEP_NOT_FAILED", "Chỉ chạy lại được bước đang lỗi.");
  }
  await tx.update(projects).set({ state: "provisioning", updatedAt: sql`now()` }).where(eq(projects.id, id));
  const jobId = await jobs.enqueue<ProvisionJob>(
    PROVISION_QUEUE,
    { orgId: actor.orgId, projectId: id },
    { tx, singletonKey: id },
  );
  await recordAudit(tx, {
    action: "project.provision.retry",
    targetType: "project",
    targetId: id,
    data: { stepId, kind: step.kind, jobId, previousState: project.state },
  });
  const updated = (await loadProject(tx, id)) as ProjectRow;
  return { project: projectView(updated), steps: stepViews(updated, await loadSteps(tx, id), deps) };
}
