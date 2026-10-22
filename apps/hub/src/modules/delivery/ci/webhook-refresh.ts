import { auditByData, recordAudit } from "../../audit/index.ts";
import { refreshProjectWebhooks, type WebhookRefreshDeps } from "../../catalog/index.ts";
import { type Jobs, withTenant } from "../../platform/index.ts";
import type { DeliveryDeps } from "../deps.ts";
import { DELIVERY_WEBHOOK_REFRESH_QUEUE } from "../queues.ts";
import { deliveryActiveOrgs } from "./poll.ts";

// Dự án GitLab tạo trước spec 020 có webhook chưa gửi pipeline/job events. Hub khởi động thì đăng ký lại một lần cho
// mỗi tổ chức; dấu đã làm nằm trong audit của tổ chức, nên khởi động lại không gọi GitLab lần nữa.

/** Đổi khi WEBHOOK_EVENTS thêm loại sự kiện mới, để chạy lại cho mọi dự án. */
export const WEBHOOK_REFRESH_VERSION = "020-ci-events";
const REFRESHED_ACTION = "delivery.webhooks_refreshed";

export interface WebhookRefreshJob {
  version: string;
}

export interface WebhookRefreshOutcome {
  orgs: number;
  skipped: number;
  updated: number;
  failed: number;
}

export async function runWebhookRefresh(
  deps: WebhookRefreshDeps,
  input: { version: string; orgIds?: readonly string[] | undefined },
): Promise<WebhookRefreshOutcome> {
  const orgIds = input.orgIds ?? (await deliveryActiveOrgs(deps.pool));
  const out: WebhookRefreshOutcome = { orgs: orgIds.length, skipped: 0, updated: 0, failed: 0 };
  for (const orgId of orgIds) {
    const done = await withTenant(deps.pool, { orgId }, (tx) =>
      auditByData(tx, { actionLike: REFRESHED_ACTION, key: "version", value: input.version, limit: 1 }),
    );
    if (done.length) {
      out.skipped++;
      continue;
    }
    const result = await refreshProjectWebhooks(deps, [orgId]);
    out.updated += result.updated;
    out.failed += result.failed.length;
    if (result.failed.length) {
      // Không ghi dấu: lần khởi động sau thử lại các dự án còn lỗi. Chỉ in khoá dự án, không in URL hay secret.
      console.warn(
        `delivery-webhook-refresh: ${result.failed.length} dự án chưa đăng ký lại được webhook:`,
        result.failed.map((f) => f.project).join(", "),
      );
      continue;
    }
    await withTenant(deps.pool, { orgId }, (tx) =>
      recordAudit(tx, {
        action: REFRESHED_ACTION,
        actorUserId: null,
        targetType: "org",
        targetId: orgId,
        data: { version: input.version, updated: result.updated },
      }),
    );
  }
  return out;
}

export async function registerWebhookRefresh(jobs: Jobs, deps: DeliveryDeps): Promise<void> {
  const { pool, masterKey, providerFactory, publicUrl } = deps;
  if (!pool || !masterKey || !providerFactory || !publicUrl) return;
  await jobs.work<WebhookRefreshJob>(DELIVERY_WEBHOOK_REFRESH_QUEUE, async (job) => {
    await runWebhookRefresh({ pool, masterKey, providerFactory, publicUrl }, { version: job.data.version });
  });
  await jobs.enqueue(DELIVERY_WEBHOOK_REFRESH_QUEUE, { version: WEBHOOK_REFRESH_VERSION } satisfies WebhookRefreshJob, {
    singletonKey: WEBHOOK_REFRESH_VERSION,
  });
}
