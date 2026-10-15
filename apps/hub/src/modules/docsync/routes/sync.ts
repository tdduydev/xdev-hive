import { desc, eq, sql } from "drizzle-orm";
import { findProject } from "../../catalog/index.ts";
import { ConflictError, NotFoundError, type Tx } from "../../platform/index.ts";
import { allowWith, requireOrgRole, requireTeamRole, teamRoleOf } from "../../tenancy/index.ts";
import { type HomeRow, homeById, homeView } from "../homes.ts";
import { requestPushNow } from "../push.ts";
import { docRepoFiles, docSyncBatches } from "../schema.ts";
import { type DocSyncRouteDeps, docSyncApi } from "./common.ts";

const STATUS_BATCHES = 20;

// Cùng luật với `projectAccess` của homes.ts (hàm nội bộ, sở hữu bởi T011): nhà dự án theo đội của dự án, nhà tổ
// chức theo vai trò tổ chức. Nhà dự án người ngoài đội không thấy nên trả 404 như dự án.
async function projectTeam(tx: Tx, userId: string, home: HomeRow): Promise<string> {
  const found = home.projectId ? await findProject(tx, home.projectId) : null;
  if (!found || !(await teamRoleOf(tx, userId, found.teamId)))
    throw new NotFoundError("DOCSYNC_HOME_NOT_FOUND", "Không tìm thấy nhà tài liệu trong tổ chức.");
  return found.teamId;
}

export async function requireHomeRead(tx: Tx, userId: string, home: HomeRow): Promise<void> {
  await requireOrgRole(tx, userId, "member");
  if (home.projectId) await projectTeam(tx, userId, home);
}

export async function requireHomeManage(tx: Tx, userId: string, home: HomeRow): Promise<void> {
  if (!home.projectId) {
    await requireOrgRole(tx, userId, "admin");
    return;
  }
  const teamId = await projectTeam(tx, userId, home);
  await allowWith(tx, userId, "projects.settings", () => requireTeamRole(tx, userId, teamId, "admin"), teamId);
}

async function homeStatus(tx: Tx, deps: DocSyncRouteDeps, userId: string, homeId: string) {
  const home = await homeById(tx, homeId);
  await requireHomeRead(tx, userId, home);
  const states = await tx
    .select({ state: docRepoFiles.state, n: sql<number>`count(*)::int` })
    .from(docRepoFiles)
    .where(eq(docRepoFiles.homeId, home.id))
    .groupBy(docRepoFiles.state);
  const count = (state: string) => states.find((s) => s.state === state)?.n ?? 0;
  const batches = await tx
    .select()
    .from(docSyncBatches)
    .where(eq(docSyncBatches.homeId, home.id))
    .orderBy(desc(docSyncBatches.createdAt))
    .limit(STATUS_BATCHES);
  return {
    home: homeView(home, deps),
    counts: {
      synced: count("synced"),
      pending: count("pending"),
      conflict: count("conflict"),
      failed: count("failed"),
      deletedInRepo: count("deleted_in_repo"),
      blockedSecret: count("blocked_secret"),
      excluded: count("excluded"),
    },
    batches: batches.map((b) => ({
      id: b.id,
      state: b.state as "queued" | "pushing" | "done" | "failed",
      mode: b.mode as "pr" | "direct",
      commitSha: b.commitSha,
      // Nhà chỉ giữ URL của PR đang mở; lô của PR cũ không còn link.
      prUrl: b.prNumber !== null && b.prNumber === home.prNumber ? home.prUrl : null,
      error: b.error,
    })),
  };
}

export function syncRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docHomes;
  return {
    syncNow: api.syncNow.handler(async ({ context, input }) => {
      const home = await homeById(context.tx, input.homeId);
      await requireHomeManage(context.tx, context.user.id, home);
      if (home.mode === "off" || home.status !== "active")
        throw new ConflictError("DOCSYNC_PAUSED", "Đồng bộ đang tạm dừng. Hãy tiếp tục trước khi thử lại.");
      return { queued: await requestPushNow(context.tx, deps.jobs, home) };
    }),
    status: api.status.handler(({ context, input }) => homeStatus(context.tx, deps, context.user.id, input.homeId)),
  };
}
