import { and, eq, isNotNull } from "drizzle-orm";
import type pg from "pg";
import { decryptSecret, type MasterKey, withTenant } from "../platform/index.ts";
import { loadConnection, type ProviderFactory, type RepoRef, type ResolvedConnection } from "../scm/index.ts";
import { webhookSecretContext, webhookUrl } from "./projects.ts";
import { WEBHOOK_EVENTS } from "./saga.ts";
import { projectProvisionSteps, projects } from "./schema.ts";

export interface WebhookRefreshDeps {
  /** Pool của hive_app; mỗi tổ chức đọc trong tenant của nó. */
  pool: pg.Pool;
  masterKey: MasterKey;
  providerFactory: ProviderFactory;
  publicUrl: string;
}

export interface WebhookRefreshItem {
  /** Khoá dự án, để báo lỗi. */
  project: string;
  conn: ResolvedConnection | null;
  ref: RepoRef;
  url: string;
  secret: string;
}

export interface WebhookRefreshResult {
  updated: number;
  failed: Array<{ project: string; error: string }>;
}

/**
 * Đăng ký lại webhook cho mọi dự án GitLab, GitHub đang hoạt động của các tổ chức `orgIds`, để dự án tạo trước khi
 * WEBHOOK_EVENTS có pipeline, job cũng nhận sự kiện CI. `addWebhook` cập nhật webhook cùng URL nên chạy lại bao nhiêu
 * lần cũng không tạo thêm webhook. Chỉ dự án đã xong bước add-webhook: dự án tắt webhook lúc tạo thì giữ nguyên.
 *
 * Người gọi đưa danh sách tổ chức: job chạy không có tổ chức trong context, mà RLS chỉ cho đọc dự án trong một tổ chức.
 */
export async function refreshProjectWebhooks(
  deps: WebhookRefreshDeps,
  orgIds: readonly string[],
): Promise<WebhookRefreshResult> {
  const result: WebhookRefreshResult = { updated: 0, failed: [] };
  for (const orgId of orgIds) {
    const items = await withTenant(deps.pool, { orgId }, async (tx) => {
      const rows = await tx
        .select({ project: projects, step: projectProvisionSteps })
        .from(projects)
        .innerJoin(
          projectProvisionSteps,
          and(
            eq(projectProvisionSteps.projectId, projects.id),
            eq(projectProvisionSteps.kind, "add-webhook"),
            eq(projectProvisionSteps.state, "done"),
          ),
        )
        .where(and(eq(projects.state, "active"), isNotNull(projects.webhookSecretEnc)));
      const out: WebhookRefreshItem[] = [];
      for (const { project, step } of rows) {
        out.push({
          project: project.key,
          conn: await loadConnection(tx, deps.masterKey, project.scmConnectionId),
          ref: { owner: project.repoOwner, name: project.repoName },
          // Cùng URL saga đã đăng ký, để addWebhook tìm ra webhook cũ thay vì tạo thêm.
          url: String(step.result?.url ?? step.params.url ?? webhookUrl(deps.publicUrl, project.id)),
          secret: decryptSecret(deps.masterKey, project.webhookSecretEnc as string, webhookSecretContext(project.id)),
        });
      }
      return out;
    });
    const part = await applyWebhookRefresh(deps.providerFactory, items);
    result.updated += part.updated;
    result.failed.push(...part.failed);
  }
  return result;
}

/** Gọi GitLab, GitHub ngoài transaction. Lỗi ở một dự án (repo đã xoá, token hết quyền) ghi lại rồi làm tiếp dự án khác. */
export async function applyWebhookRefresh(
  providerFactory: ProviderFactory,
  items: readonly WebhookRefreshItem[],
): Promise<WebhookRefreshResult> {
  const result: WebhookRefreshResult = { updated: 0, failed: [] };
  for (const item of items) {
    try {
      if (!item.conn) throw new Error("Kết nối Git của dự án không còn.");
      await providerFactory(item.conn).addWebhook(item.ref, {
        url: item.url,
        secret: item.secret,
        events: [...WEBHOOK_EVENTS],
      });
      result.updated++;
    } catch (e) {
      result.failed.push({ project: item.project, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
