import { defaultIssueIntake, issueIntakeSettings } from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import { decryptSecret, type MasterKey, withTenant } from "../platform/index.ts";
import type { WebhookTarget } from "../scm/index.ts";
import { webhookSecretContext } from "./projects.ts";
import { projects } from "./schema.ts";

/**
 * Tìm dự án nhận webhook khi chưa biết tổ chức: GitHub/GitLab gọi vào không có phiên người dùng. Transaction không có
 * tenant, chỉ đặt app.webhook_project_id; policy `projects_webhook_lookup` cho thấy đúng một dòng có id đó và chỉ để
 * đọc. Không dùng SECURITY DEFINER hay role bỏ qua RLS, giống fleet tra token máy bằng ctx_fleet_token. Biết id dự án
 * chưa đủ để làm gì: chữ ký vẫn phải khớp secret riêng của dự án.
 */
export async function findWebhookTarget(
  pool: pg.Pool,
  masterKey: MasterKey | undefined,
  projectId: string,
): Promise<WebhookTarget | null> {
  if (!masterKey) return null;
  const [row] = await withTenant(pool, {}, async (tx) => {
    await tx.execute(sql`select set_config('app.webhook_project_id', ${projectId}, true)`);
    return tx
      .select({
        orgId: projects.orgId,
        scmKind: projects.scmKind,
        state: projects.state,
        settings: projects.settings,
        webhookSecretEnc: projects.webhookSecretEnc,
      })
      .from(projects)
      .where(eq(projects.id, projectId));
  });
  // Dự án lưu trữ không còn nhận việc; repo có thể vẫn giữ webhook cũ.
  if (!row?.webhookSecretEnc || row.state === "archived") return null;
  // Settings lưu trước khi có issueIntake, hoặc hỏng, thì dùng mặc định (tắt) thay vì từ chối webhook.
  const intake = issueIntakeSettings.safeParse(row.settings.issueIntake);
  return {
    orgId: row.orgId,
    projectId,
    provider: row.scmKind,
    secret: decryptSecret(masterKey, row.webhookSecretEnc, webhookSecretContext(projectId)),
    intake: intake.success ? intake.data : { ...defaultIssueIntake },
  };
}
