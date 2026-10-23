import { os as base, implement } from "@orpc/server";
import { type InstructionTemplates, policiesContract, type TemplatePreview } from "@xdev-hive/contracts";
import { recordAudit } from "../audit/index.ts";
import { BadRequestError, type RequestContext, type Tx } from "../platform/index.ts";
import { allowWith, type OrgDeps, orgMiddlewares, requireOrgRole } from "../tenancy/index.ts";
import { getAgentPolicy, loadPolicy, type PolicyGuard, saveAgentPolicy } from "./policies.ts";
import { mcpTemplateError } from "./templates.ts";

/**
 * Phần mẫu file cần dự án và kết nối Git (module catalog). Truyền vào từ app.ts thay vì import, vì catalog đọc chính
 * sách (mẫu, quyền mặc định của dự án mới) từ module này: import ngược sẽ thành vòng.
 */
export interface TemplateService {
  preview(tx: Tx, templates: InstructionTemplates, project: string | undefined): Promise<TemplatePreview>;
  /** Xếp job mở PR cập nhật file hướng dẫn ở mọi dự án đang hoạt động của tổ chức. */
  requestSync(tx: Tx, orgId: string): Promise<void>;
}

/**
 * Máy cá nhân chỉ nhận chính sách điều khiển từ xa trong `welcome` (specs/010 T027), nên đổi chính sách thì phải cho máy
 * nối lại. Truyền vào từ app.ts vì module terminal đọc chính sách từ module này.
 */
export interface RemotePolicyHook {
  /** Máy cần nhận chính sách mới; gọi trong transaction đang lưu chính sách. */
  machines(tx: Tx): Promise<string[]>;
  /** Gọi sau khi commit, để máy nối lại không đọc phải chính sách cũ. */
  refresh(machineIds: string[]): void;
}

/** Việc chạy sau khi transaction của `inOrg` đã commit; transaction hỏng thì không chạy. */
const afterCommit = base.$context<RequestContext>().middleware(async ({ next }) => {
  const tasks: Array<() => void> = [];
  const result = await next({ context: { afterCommit: (task: () => void) => void tasks.push(task) } });
  for (const task of tasks) task();
  return result;
});

export function policiesRouter(
  deps: OrgDeps & { templates: TemplateService; remote?: RemotePolicyHook; policyGuard?: PolicyGuard },
) {
  const m = orgMiddlewares(deps);
  const os = implement(policiesContract).$context<RequestContext>().use(m.authed).use(afterCommit).use(m.inOrg);
  // Sửa và xem mẫu cần quyền sửa chính sách; xem chính sách thì mọi thành viên (trang cấu hình dự án cần biết giới hạn).
  const requireWrite = (tx: Tx, userId: string) =>
    allowWith(tx, userId, "policies.write", () => requireOrgRole(tx, userId, "admin"));
  return {
    get: os.get.handler(({ context: { tx } }) => getAgentPolicy(tx)),

    update: os.update.handler(async ({ context: { tx, user, orgId, afterCommit }, input }) => {
      const invalid = mcpTemplateError(input.templates.mcp);
      if (invalid) throw new BadRequestError("POLICY_TEMPLATE_INVALID", invalid);
      const { policy, templatesChanged, remoteChanged } = await saveAgentPolicy(tx, user.id, input, deps.policyGuard);
      if (templatesChanged && policy.autoSyncTemplates) await deps.templates.requestSync(tx, orgId);
      const remote = deps.remote;
      if (remoteChanged && remote) {
        const machines = await remote.machines(tx);
        afterCommit(() => remote.refresh(machines));
      }
      return policy;
    }),

    preview: os.preview.handler(async ({ context: { tx, user }, input }) => {
      await requireWrite(tx, user.id);
      const templates = input.templates ?? (await loadPolicy(tx)).templates;
      return deps.templates.preview(tx, templates, input.project);
    }),

    syncTemplates: os.syncTemplates.handler(async ({ context: { tx, user, orgId } }) => {
      await requireWrite(tx, user.id);
      await deps.templates.requestSync(tx, orgId);
      await recordAudit(tx, { action: "policies.sync_templates", targetType: "org_policy" });
      return { queued: true };
    }),
  };
}
