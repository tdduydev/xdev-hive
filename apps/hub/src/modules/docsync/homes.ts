import { randomBytes, randomUUID } from "node:crypto";
import {
  type DocHome,
  docHome,
  docHomeConfigureOrgInput,
  type ProjectDocsSettings,
  projectDocsSettings,
} from "@xdev-hive/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { findProject, loadProject, type ProjectRow } from "../catalog/index.ts";
import {
  BadRequestError,
  ConflictError,
  encryptSecret,
  ForbiddenError,
  NotFoundError,
  type Tx,
} from "../platform/index.ts";
import { defaultProviderFactory, type GitProvider, isGitProviderError, loadConnection } from "../scm/index.ts";
import { sdlcManagedPaths } from "../sdlc/index.ts";
import { allowWith, requireOrgRole, requireTeamRole, teamRoleOf } from "../tenancy/index.ts";
import { queuePull, queuePush } from "./jobs.ts";
import { overlaps } from "./paths.ts";
import type { DocSyncDeps } from "./routes/deps.ts";
import { docHomes, docRepoFiles, docSyncBatches } from "./schema.ts";

export type HomeRow = typeof docHomes.$inferSelect;
type OrgInput = z.input<typeof docHomeConfigureOrgInput>;
type Actor = { userId: string; orgId: string };
export const homeSecretContext = (homeId: string) => `doc_homes:${homeId}:webhook`;

export function homeView(row: HomeRow, deps: Pick<DocSyncDeps, "publicUrl">): DocHome {
  return docHome.parse({
    ...row,
    webhookUrl: row.webhookId && deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}/hooks/docs/${row.id}` : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function homeById(tx: Tx, homeId: string): Promise<HomeRow> {
  const [row] = await tx.select().from(docHomes).where(eq(docHomes.id, homeId));
  if (!row) throw new NotFoundError("DOCSYNC_HOME_NOT_FOUND", "Không tìm thấy nhà tài liệu trong tổ chức.");
  return row;
}

async function projectAccess(tx: Tx, userId: string, ref: string, manage: boolean): Promise<ProjectRow> {
  const found = await findProject(tx, ref);
  if (!found || !(await teamRoleOf(tx, userId, found.teamId)))
    throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
  if (manage)
    await allowWith(
      tx,
      userId,
      "projects.settings",
      () => requireTeamRole(tx, userId, found.teamId, "admin"),
      found.teamId,
    );
  const project = await loadProject(tx, found.id);
  if (!project) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
  return project;
}

async function requireHomeManage(tx: Tx, userId: string, row: HomeRow) {
  if (row.projectId) return projectAccess(tx, userId, row.projectId, true);
  await requireOrgRole(tx, userId, "admin");
  return null;
}

export async function getHome(tx: Tx, userId: string, project?: string): Promise<HomeRow | null> {
  await requireOrgRole(tx, userId, "member");
  const p = project ? await projectAccess(tx, userId, project, false) : null;
  const [row] = await tx
    .select()
    .from(docHomes)
    .where(p ? eq(docHomes.projectId, p.id) : eq(docHomes.scope, "org"));
  return row ?? null;
}

export async function homeProvider(tx: Tx, deps: DocSyncDeps, connectionId: string): Promise<GitProvider> {
  if (!deps.masterKey) throw new BadRequestError("MASTER_KEY_MISSING", "Hub chưa cấu hình HIVE_MASTER_KEY.");
  const conn = await loadConnection(tx, deps.masterKey, connectionId);
  if (!conn) throw new NotFoundError("SCM_CONNECTION_NOT_FOUND", "Không tìm thấy kết nối Git trong tổ chức.");
  return (deps.providerFactory ?? defaultProviderFactory)(conn);
}

const noAccess = () => new ForbiddenError("DOCSYNC_NO_ACCESS", "Kết nối không có quyền đọc và ghi repo tài liệu.");

async function checkedRepo(provider: GitProvider, ref: { owner: string; name: string }, create = false) {
  try {
    const access = await provider.checkAccess(ref.owner);
    if (access.missingScopes.length || (create && !access.canCreate)) throw noAccess();
    const repo = await provider.getRepo(ref);
    if (!repo && !create) throw noAccess();
    return repo;
  } catch (error) {
    if (
      isGitProviderError(error, "unauthorized") ||
      isGitProviderError(error, "forbidden") ||
      isGitProviderError(error, "not_found")
    )
      throw noAccess();
    throw error;
  }
}

/** Khoá theo tổ chức để hai cấu hình đồng thời không cùng vượt qua kiểm tra chồng thư mục. */
async function lockHomes(tx: Tx, orgId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`docsync-homes:${orgId}`}, 0))`);
}

async function checkOverlap(
  tx: Tx,
  input: { connectionId: string; owner: string; name: string; root: string },
  homeId: string,
) {
  // So host và loại provider, không chỉ connectionId: hai token có thể cùng trỏ một repo.
  const { rows } = await tx.execute<{
    id: string;
    connection_id: string;
    owner: string;
    name: string;
    root: string;
    project_id: string | null;
    kind: string;
    base_url: string | null;
    source: string;
  }>(sql`
    select h.id, h.connection_id, h.owner, h.name, h.root, h.project_id, c.kind, c.base_url, 'home' as source
      from hive.doc_homes h join hive.scm_connections c on c.id = h.connection_id
    union all
    select s.id, s.connection_id, s.owner, s.name, '', null::uuid, c.kind, c.base_url, 'skill'
      from hive.skill_repos s join hive.scm_connections c on c.id = s.connection_id
    union all
    select p.id, p.scm_connection_id, p.repo_owner, p.repo_name, '', p.id, c.kind, c.base_url, 'project'
      from hive.projects p join hive.scm_connections c on c.id = p.scm_connection_id
  `);
  const { rows: connections } = await tx.execute<{ kind: string; base_url: string | null }>(
    sql`select kind, base_url from hive.scm_connections where id = ${input.connectionId}`,
  );
  const conn = connections[0];
  if (!conn) throw noAccess();
  const host = (kind: string, base: string | null) =>
    (base ?? (kind === "github" ? "https://api.github.com" : "https://gitlab.com")).replace(/\/+$/, "").toLowerCase();
  const conflict = () =>
    new ConflictError("DOCSYNC_HOME_OVERLAP", "Thư mục chồng với kho tài liệu, SDLC hoặc kho skill khác.");
  for (const row of rows) {
    if (
      row.kind !== conn.kind ||
      host(row.kind, row.base_url) !== host(conn.kind, conn.base_url) ||
      row.owner.toLowerCase() !== input.owner.toLowerCase() ||
      row.name.toLowerCase() !== input.name.toLowerCase()
    )
      continue;
    if (row.source === "skill") throw conflict();
    if (row.source === "home" && row.id !== homeId && overlaps(row.root, input.root)) throw conflict();
    if (row.source === "project" && row.project_id)
      for (const path of await sdlcManagedPaths(tx, row.project_id)) if (overlaps(path, input.root)) throw conflict();
  }
}

async function preserveMappings(
  tx: Tx,
  old: HomeRow | null,
  values: { connectionId: string; owner: string; name: string; root: string },
) {
  if (
    !old ||
    (old.connectionId === values.connectionId &&
      old.owner === values.owner &&
      old.name === values.name &&
      !overlapsChanged(old.root, values.root))
  )
    return;
  const [mapped] = await tx
    .select({ id: docRepoFiles.id })
    .from(docRepoFiles)
    .where(eq(docRepoFiles.homeId, old.id))
    .limit(1);
  if (mapped)
    throw new ConflictError(
      "DOCSYNC_HOME_OVERLAP",
      "Nhà đã có tài liệu. Hãy di chuyển file hoặc gỡ nhà trước khi đổi repo hay thư mục.",
    );
}
const overlapsChanged = (a: string, b: string) => a.replace(/\/+$/, "") !== b.replace(/\/+$/, "");

async function writeProjectSettings(tx: Tx, projectId: string, settings: ProjectDocsSettings) {
  await tx.execute(
    sql`update hive.projects set settings = jsonb_set(settings, '{docs}', ${JSON.stringify(settings)}::jsonb), updated_at = now() where id = ${projectId}`,
  );
}

export async function configureProjectHome(
  tx: Tx,
  deps: DocSyncDeps,
  actor: Actor,
  input: { project: string; settings: ProjectDocsSettings },
): Promise<HomeRow> {
  await lockHomes(tx, actor.orgId);
  const project = await projectAccess(tx, actor.userId, input.project, true);
  if (project.state !== "active")
    throw new ConflictError("PROJECT_NOT_READY", "Dự án chưa hoạt động hoặc đã được lưu trữ.");
  const settings = projectDocsSettings.parse(input.settings);
  const [old] = await tx.select().from(docHomes).where(eq(docHomes.projectId, project.id));
  const id = old?.id ?? randomUUID();
  const values = {
    connectionId: project.scmConnectionId,
    owner: project.repoOwner,
    name: project.repoName,
    root: settings.root,
  };
  const provider = await homeProvider(tx, deps, values.connectionId);
  const repo = await checkedRepo(provider, values);
  const branch = old?.branch ?? project.defaultBranch ?? repo?.defaultBranch;
  if (!branch || !(await provider.branchHead(values, branch))) throw noAccess();
  if (settings.enabled) await checkOverlap(tx, values, id);
  await preserveMappings(tx, old ?? null, values);
  const data = {
    ...values,
    branch,
    assetsDir: settings.assetsDir,
    mode: settings.enabled ? settings.repoSync : "off",
    include: settings.include,
    exclude: settings.exclude,
    repoChangesNeedReview: settings.repoChangesNeedReview,
    status: settings.enabled ? (old?.status ?? "active") : "paused",
    statusReason: settings.enabled
      ? old?.statusReason === "disabled"
        ? null
        : (old?.statusReason ?? null)
      : "disabled",
    configuredBy: actor.userId,
    updatedAt: new Date(),
  };
  if (settings.enabled && old?.statusReason === "disabled") data.status = "active";
  const [saved] = old
    ? await tx.update(docHomes).set(data).where(eq(docHomes.id, id)).returning()
    : await tx
        .insert(docHomes)
        .values({ ...data, id, orgId: actor.orgId, scope: "project", projectId: project.id })
        .returning();
  await writeProjectSettings(tx, project.id, settings);
  await recordAudit(tx, {
    action: "doc.home_configure",
    targetType: "doc_home",
    targetId: id,
    data: { scope: "project", projectId: project.id, settings },
  });
  return saved as HomeRow;
}

export async function configureOrgHome(tx: Tx, deps: DocSyncDeps, actor: Actor, raw: OrgInput): Promise<HomeRow> {
  await requireOrgRole(tx, actor.userId, "admin");
  await lockHomes(tx, actor.orgId);
  const input = docHomeConfigureOrgInput.parse(raw);
  const [old] = await tx.select().from(docHomes).where(eq(docHomes.scope, "org"));
  const id = old?.id ?? randomUUID();
  await checkOverlap(tx, input, id);
  await preserveMappings(tx, old ?? null, input);
  const provider = await homeProvider(tx, deps, input.connectionId);
  let repo = await checkedRepo(provider, input, input.create);
  if (input.create) {
    repo = await provider.createRepo({
      owner: input.owner,
      name: input.name,
      visibility: "private",
      defaultBranch: input.branch ?? "main",
      marker: `xdev-hive:docs:${id}`,
      description: "Kho tài liệu tổ chức xDev Hive",
    });
    if (
      !(await provider.readFile(
        input,
        "README.md",
        (await provider.branchHead(input, repo.defaultBranch)) ?? repo.defaultBranch,
      )) ||
      !old
    )
      await provider.commitFiles(input, {
        branch: repo.defaultBranch,
        message: "Khởi tạo kho tài liệu tổ chức",
        files: [
          {
            path: "README.md",
            content:
              "# Tài liệu tổ chức\n\n- `org/`: tài liệu của tổ chức.\n- `teams/<slug>/`: tài liệu của từng đội.\n",
          },
        ],
      });
  }
  const branch = input.branch ?? repo?.defaultBranch;
  if (!branch || !(await provider.branchHead(input, branch))) throw noAccess();
  const changedRepo =
    old && (old.connectionId !== input.connectionId || old.owner !== input.owner || old.name !== input.name);
  if (changedRepo && old.webhookId) await removeWebhook(tx, deps, old);
  const secret = randomBytes(32).toString("hex");
  let webhookId: string | null = null;
  let warning: string | null = null;
  if (deps.publicUrl) {
    try {
      webhookId = (
        await provider.addWebhook(input, {
          url: `${deps.publicUrl.replace(/\/+$/, "")}/hooks/docs/${id}`,
          secret,
          events: ["push"],
        })
      ).id;
    } catch {
      warning = "Không gắn được webhook. Đồng bộ sẽ dùng lịch quét định kỳ.";
    }
  }
  const data = {
    connectionId: input.connectionId,
    owner: input.owner,
    name: input.name,
    branch,
    root: input.root,
    assetsDir: input.assetsDir,
    mode: input.mode,
    include: input.include,
    exclude: input.exclude,
    repoChangesNeedReview: input.repoChangesNeedReview,
    webhookId,
    webhookSecretEnc: encryptSecret(
      deps.masterKey as NonNullable<DocSyncDeps["masterKey"]>,
      secret,
      homeSecretContext(id),
    ),
    status: "active",
    statusReason: null,
    error: warning,
    configuredBy: actor.userId,
    updatedAt: new Date(),
    ...(changedRepo ? { lastCommit: null, prNumber: null, prUrl: null } : {}),
  };
  const [saved] = old
    ? await tx.update(docHomes).set(data).where(eq(docHomes.id, id)).returning()
    : await tx
        .insert(docHomes)
        .values({ ...data, id, orgId: actor.orgId, scope: "org" })
        .returning();
  await recordAudit(tx, {
    action: "doc.home_configure",
    targetType: "doc_home",
    targetId: id,
    data: {
      scope: "org",
      connectionId: input.connectionId,
      owner: input.owner,
      name: input.name,
      branch,
      root: input.root,
      mode: input.mode,
    },
  });
  return saved as HomeRow;
}

async function removeWebhook(tx: Tx, deps: DocSyncDeps, row: HomeRow) {
  if (!row.webhookId) return;
  const provider = await homeProvider(tx, deps, row.connectionId);
  try {
    await provider.removeWebhook(row, row.webhookId);
  } catch (error) {
    if (!isGitProviderError(error, "not_found")) throw error;
  }
}

export async function removeHome(tx: Tx, deps: DocSyncDeps, actor: Actor, homeId: string): Promise<{ ok: true }> {
  await lockHomes(tx, actor.orgId);
  const row = await homeById(tx, homeId);
  const project = await requireHomeManage(tx, actor.userId, row);
  await removeWebhook(tx, deps, row);
  if (project)
    await writeProjectSettings(tx, project.id, {
      ...projectDocsSettings.parse(project.settings.docs ?? {}),
      enabled: false,
    });
  // Chỉ xoá liên kết và trạng thái sync qua FK; nội dung docs/doc_versions ở lại hub.
  await tx.delete(docHomes).where(eq(docHomes.id, row.id));
  await recordAudit(tx, { action: "doc.home_remove", targetType: "doc_home", targetId: row.id });
  return { ok: true };
}

export async function changeHomeState(
  tx: Tx,
  deps: DocSyncDeps,
  actor: Actor,
  homeId: string,
  action: "pause" | "resume" | "acceptBranch",
  branch?: string,
): Promise<HomeRow> {
  await lockHomes(tx, actor.orgId);
  const row = await homeById(tx, homeId);
  const project = await requireHomeManage(tx, actor.userId, row);
  if (action !== "pause") {
    if (row.mode === "off" || (project && !projectDocsSettings.parse(project.settings.docs ?? {}).enabled))
      throw new ConflictError("DOCSYNC_PAUSED", "Hãy bật đồng bộ tài liệu trong cài đặt trước khi tiếp tục.");
    const provider = await homeProvider(tx, deps, row.connectionId);
    const repo = await checkedRepo(provider, row);
    if (
      !repo ||
      (action === "acceptBranch" && branch !== repo.defaultBranch) ||
      (action === "resume" && row.branch !== repo.defaultBranch)
    )
      throw new ConflictError(
        "DOCSYNC_PAUSED",
        "Nhánh mặc định đã thay đổi. Hãy xác nhận nhánh mới trước khi tiếp tục.",
      );
    if (!(await provider.branchHead(row, branch ?? row.branch))) throw noAccess();
    await checkOverlap(tx, row, row.id);
    if (action === "acceptBranch" && row.branch !== branch) {
      if (row.prNumber) await provider.closePR(row, row.prNumber);
      await tx
        .update(docRepoFiles)
        .set({ state: "pending", updatedAt: new Date() })
        .where(and(eq(docRepoFiles.homeId, row.id), eq(docRepoFiles.state, "synced")));
      await tx
        .update(docSyncBatches)
        .set({ state: "failed", error: "Nhánh mặc định đã thay đổi.", updatedAt: new Date() })
        .where(and(eq(docSyncBatches.homeId, row.id), isNull(docSyncBatches.commitSha)));
    }
  }
  const [saved] = await tx
    .update(docHomes)
    .set({
      status: action === "pause" ? "paused" : "active",
      statusReason: action === "pause" ? "manual" : null,
      error: null,
      updatedAt: new Date(),
      ...(action === "acceptBranch" ? { branch: branch as string, lastCommit: null, prNumber: null, prUrl: null } : {}),
    })
    .where(eq(docHomes.id, row.id))
    .returning();
  if (action !== "pause" && deps.jobs) {
    await queuePull(deps.jobs, { orgId: actor.orgId, homeId }, { tx });
    await queuePush(deps.jobs, { orgId: actor.orgId, homeId }, { tx });
  }
  await recordAudit(tx, {
    action: `doc.home_${action}`,
    targetType: "doc_home",
    targetId: row.id,
    data: branch ? { branch } : {},
  });
  return saved as HomeRow;
}
