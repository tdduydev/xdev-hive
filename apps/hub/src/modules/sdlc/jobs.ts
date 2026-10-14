import { sdlcItemRef } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { loadProject } from "../catalog/index.ts";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { loadConnection } from "../scm/index.ts";
import { advance, SDLC_QUEUE, type SdlcDeps, type SdlcJob } from "./phases.ts";
import { sdlcItems } from "./schema.ts";

export const sdlcQueue = {
  name: SDLC_QUEUE,
  // Job chỉ đi tiếp từ trạng thái đang lưu nên chạy lại sau lỗi tạm (Git, tạo run) là an toàn.
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 10 * 60,
};

export interface SdlcWorkerDeps extends SdlcDeps {
  pool: pg.Pool;
}

/** Link web của hạng mục (`/sdlc/<dự án>/<NNN>`), như link trong thông báo. */
export function itemUrl(publicUrl: string | undefined, projectKey: string, number: number): string {
  return `${(publicUrl ?? "").replace(/\/+$/, "")}/sdlc/${projectKey}/${sdlcItemRef(number)}`;
}

/**
 * Bình luận lên issue nguồn (US1-2) chạy sau commit: lỗi của GitHub/GitLab không làm mất hạng mục vừa tạo, pg-boss
 * thử lại. Không có khoá chủ hay kết nối Git thì bỏ qua.
 */
async function commentOnIssue(deps: SdlcWorkerDeps, job: Extract<SdlcJob, { kind: "issue-comment" }>): Promise<void> {
  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId: job.orgId }, fn);
  const pre = await tenant(async (tx) => {
    const [item] = await tx.select().from(sdlcItems).where(eq(sdlcItems.id, job.itemId));
    if (item?.source.kind !== "issue" || item.source.issueNumber === null) return null;
    const project = await loadProject(tx, item.projectId);
    if (!project || !deps.masterKey || !deps.providerFactory) return null;
    const conn = await loadConnection(tx, deps.masterKey, project.scmConnectionId);
    return conn ? { item, project, provider: deps.providerFactory(conn) } : null;
  });
  if (!pre) return;
  const { item, project, provider } = pre;
  const ref = sdlcItemRef(item.number);
  await provider.commentOnIssue(
    { owner: project.repoOwner, name: project.repoName },
    item.source.issueNumber ?? 0,
    `Đã tạo hạng mục AI SDLC ${ref} “${item.title}” (${item.mode.name}) trên xDev Hive: ${itemUrl(deps.publicUrl, project.key, item.number)}`,
  );
}

/** Xử lý một job của queue `sdlc`; tách ra để test gọi thẳng không cần pg-boss. */
export async function handleSdlcJob(deps: SdlcWorkerDeps, job: SdlcJob): Promise<void> {
  if (job.kind === "issue-comment") return commentOnIssue(deps, job);
  await withTenant(deps.pool, { orgId: job.orgId }, (tx) => advance(tx, job.itemId, deps));
}

export async function registerSdlcWorker(jobs: Jobs, deps: SdlcWorkerDeps): Promise<void> {
  const full = { ...deps, jobs };
  await jobs.work<SdlcJob>(SDLC_QUEUE, ({ data }) => handleSdlcJob(full, data));
}
