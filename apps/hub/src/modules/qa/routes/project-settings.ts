import type { TestProjectSettings, TestProjectSettingsInput } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import { recordAudit } from "../../audit/index.ts";
import { ensureProjectInclude } from "../../docsync/index.ts";
import type { Tx } from "../../platform/index.ts";
import { qaProject } from "../access.ts";
import { type QaRouteDeps, qaApi } from "../deps.ts";
import { syncProjectLibrary } from "../doc-hooks.ts";
import { qaProjectSettings } from "../schema.ts";

export async function getProjectSettings(tx: Tx, userId: string, projectKey: string): Promise<TestProjectSettings> {
  const { settings } = await qaProject(tx, userId, projectKey, ["qa.read", "projects.settings"], {
    allowDisabled: true,
  });
  return settings;
}

export async function updateProjectSettings(
  tx: Tx,
  deps: Pick<QaRouteDeps, "jobs">,
  actor: { userId: string; orgId: string },
  input: TestProjectSettingsInput,
): Promise<TestProjectSettings> {
  const { project, settings: before } = await qaProject(tx, actor.userId, input.projectKey, "projects.settings", {
    allowDisabled: true,
  });
  const enabled = input.enabled ?? before.enabled;
  const tcDir = input.tcDir ?? before.tcDir;
  let includeResult = before.includeResult;
  // Chạy lại cả khi đổi thư mục lúc đang bật: include cũ không phủ thư mục mới. Include đã phủ thì hàm không đổi gì.
  const reread = enabled && (!before.enabled || tcDir !== before.tcDir);
  if (reread) includeResult = await ensureProjectInclude(tx, actor, project.id, tcDir, { jobs: deps.jobs });
  const row = { enabled, tcDir, includeResult, updatedBy: actor.userId, updatedAt: sql`now()` };
  await tx
    .insert(qaProjectSettings)
    .values({ ...row, projectId: project.id, orgId: sql`hive.ctx_org()` })
    .onConflictDoUpdate({ target: qaProjectSettings.projectId, set: row });
  // Hook lưu bỏ qua dự án chưa bật, nên file đã có trong thư mục chỉ vào thư viện khi đọc lại ở đây.
  if (reread) await syncProjectLibrary(tx, { projectId: project.id, projectKey: project.key, tcDir });
  const after = { enabled, tcDir, includeResult };
  await recordAudit(tx, {
    action: "qa.project_settings.update",
    targetType: "project",
    targetId: project.id,
    data: { before, after },
  });
  return after;
}

export function projectSettingsRoutes(deps: QaRouteDeps) {
  const api = qaApi(deps).projectSettings;
  return {
    get: api.get.handler(({ context, input }) => getProjectSettings(context.tx, context.user.id, input.projectKey)),
    update: api.update.handler(({ context, input }) =>
      updateProjectSettings(context.tx, deps, { userId: context.user.id, orgId: context.orgId }, input),
    ),
  };
}
