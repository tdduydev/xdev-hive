import {
  type BriefSaveInput,
  briefSaveInput,
  briefSubmitInput,
  DEFAULT_BRIEF_SETTINGS,
  type ProjectBrief,
} from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import { findProject } from "../catalog/index.ts";
import { ConflictError, type Tx } from "../platform/index.ts";
import { audit, authorColumns, authorize, authorView, type Principal, projectFor, readerFor } from "./access.ts";
import { projectBriefs } from "./schema.ts";

// Brief của dự án (ADR 0022): bản tóm tắt repo đưa vào prompt của mọi run để agent khỏi khảo sát lại cả repo.

type BriefRow = typeof projectBriefs.$inferSelect;

export function briefView(row: BriefRow, refreshRunId: string | null): ProjectBrief {
  return {
    projectId: row.projectId,
    content: row.content,
    version: row.version,
    commitSha: row.commitSha,
    source: row.source,
    updatedBy: authorView({ authorUserId: row.updatedByUserId, authorRunId: row.updatedByRunId }),
    updatedAt: row.updatedAt.toISOString(),
    headSha: row.headSha,
    commitsBehind: row.commitsBehind,
    refreshRunId,
  };
}

export async function loadBrief(tx: Tx, projectId: string): Promise<BriefRow | null> {
  const [row] = await tx.select().from(projectBriefs).where(eq(projectBriefs.projectId, projectId));
  return row ?? null;
}

/** Brief người gọi đọc được, theo key hoặc id dự án. */
export async function getBrief(tx: Tx, principal: Principal, project: string): Promise<BriefRow | null> {
  const p = await projectFor(tx, await readerFor(tx, principal), project);
  return loadBrief(tx, p.projectId);
}

/** Sửa tay. Thành viên đội như ghi memory: brief chỉ là gợi ý cho agent, code vẫn là nguồn đúng. */
export async function saveBrief(tx: Tx, principal: Principal, input: BriefSaveInput): Promise<BriefRow> {
  const data = briefSaveInput.parse(input);
  const reader = await readerFor(tx, principal);
  const p = await projectFor(tx, reader, data.project);
  await authorize(tx, reader, p, "write");
  const old = await lockBrief(tx, p.projectId);
  if ((old?.version ?? 0) !== data.baseVersion) {
    throw new ConflictError(
      "BRIEF_VERSION_CONFLICT",
      "Brief vừa được người khác hoặc agent cập nhật. Tải lại để xem bản mới rồi sửa tiếp.",
    );
  }
  // Giữ commit_sha cũ: người sửa chữ không đọc lại repo, mốc để tính độ cũ vẫn là lần agent đọc.
  const row = await upsert(tx, principal, p, old, { content: data.content, commitSha: old?.commitSha ?? null }, "user");
  await audit(tx, principal, "brief.save", { type: "project", id: p.projectId }, { version: row.version });
  return row;
}

/** Brief agent nộp trong run `brief`; module runs gọi khi run xong, với principal là run. */
export async function submitBrief(
  tx: Tx,
  principal: Principal & { kind: "run" },
  input: { content: string; commitSha: string },
): Promise<BriefRow> {
  const data = briefSubmitInput.parse(input);
  const project = await findProject(tx, principal.projectId);
  if (!project) throw new ConflictError("PROJECT_NOT_FOUND", "Dự án của run không còn.");
  const p = { teamId: project.teamId, projectId: project.id };
  const old = await lockBrief(tx, p.projectId);
  const row = await upsert(tx, principal, p, old, data, "agent");
  await audit(tx, principal, "brief.refresh", { type: "project", id: p.projectId }, { version: row.version });
  return row;
}

/** Ghi lại độ lệch worker vừa báo: nhánh chính tới đâu và đi trước commit của brief bao nhiêu commit. */
export async function recordBriefDrift(
  tx: Tx,
  projectId: string,
  drift: { briefSha: string; headSha: string; behind: number },
): Promise<void> {
  // Chỉ ghi khi brief vẫn là bản worker đã so: brief vừa được làm mới thì số cũ không còn đúng.
  await tx
    .update(projectBriefs)
    .set({ headSha: drift.headSha, commitsBehind: drift.behind })
    .where(sql`${projectBriefs.projectId} = ${projectId} and ${projectBriefs.commitSha} = ${drift.briefSha}`);
}

export type BriefStaleness = "missing" | "commits" | "age" | null;

/** Vì sao brief cần làm mới theo cài đặt của dự án; null là còn dùng được. */
export function briefStaleness(
  row: Pick<BriefRow, "commitSha" | "commitsBehind" | "updatedAt" | "source"> | null,
  settings: { refreshCommits: number; refreshDays: number } = DEFAULT_BRIEF_SETTINGS,
  now = new Date(),
): BriefStaleness {
  // Người viết tay khi agent chưa đọc repo lần nào: vẫn cần agent viết bản có commit để đo độ lệch.
  if (!row?.commitSha) return "missing";
  if ((row.commitsBehind ?? 0) >= settings.refreshCommits) return "commits";
  if (now.getTime() - row.updatedAt.getTime() >= settings.refreshDays * 86_400_000) return "age";
  return null;
}

async function lockBrief(tx: Tx, projectId: string): Promise<BriefRow | null> {
  // Brief chưa có thì không có dòng để khoá: khoá theo dự án để hai lần tạo đầu tiên không cùng lọt qua kiểm version.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge:brief:${projectId}`}, 0))`);
  const [row] = await tx.select().from(projectBriefs).where(eq(projectBriefs.projectId, projectId)).for("update");
  return row ?? null;
}

async function upsert(
  tx: Tx,
  principal: Principal,
  p: { teamId: string; projectId: string },
  old: BriefRow | null,
  values: { content: string; commitSha: string | null },
  source: "agent" | "user",
): Promise<BriefRow> {
  const by = authorColumns(principal);
  const set = {
    content: values.content,
    commitSha: values.commitSha,
    source,
    updatedByUserId: by.authorUserId,
    updatedByRunId: by.authorRunId,
    // Agent vừa đọc nhánh chính nên độ lệch về 0; người sửa chữ không đổi độ lệch.
    ...(source === "agent" ? { headSha: values.commitSha, commitsBehind: 0 } : {}),
    updatedAt: new Date(),
  };
  const [row] = old
    ? await tx
        .update(projectBriefs)
        .set({ ...set, version: old.version + 1 })
        .where(eq(projectBriefs.projectId, p.projectId))
        .returning()
    : await tx
        .insert(projectBriefs)
        .values({ orgId: sql`hive.ctx_org()`, teamId: p.teamId, projectId: p.projectId, ...set })
        .returning();
  if (!row) throw new Error("Không ghi được brief.");
  return row;
}
