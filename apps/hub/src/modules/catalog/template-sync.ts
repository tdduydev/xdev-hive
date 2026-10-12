import type { InstructionTemplates, TemplatePreview, TemplateSyncResult } from "@xdev-hive/contracts";
import { asc, eq } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import {
  instructionFiles,
  loadPolicy,
  recordTemplateSync,
  type TemplateService,
  type TemplateVars,
} from "../governance/index.ts";
import { type Jobs, type MasterKey, NotFoundError, type Tx, withTenant } from "../platform/index.ts";
import { loadConnection, type ProviderFactory } from "../scm/index.ts";
import { findSystem } from "../tenancy/index.ts";
import { findProject } from "./projects.ts";
import { projects } from "./schema.ts";

export const TEMPLATE_SYNC_QUEUE = "catalog-template-sync";
/** Nhánh của PR cập nhật file hướng dẫn: PR đang mở thì commit tiếp vào đó thay vì mở PR mới. */
export const INSTRUCTIONS_BRANCH = "hive/update-agent-instructions";

export const templateSyncQueue = {
  name: TEMPLATE_SYNC_QUEUE,
  // Mỗi dự án so nội dung trước khi ghi, nên chạy lại sau lỗi tạm thời không mở thêm PR.
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 30 * 60,
  policy: "stately",
} as const;

export interface TemplateSyncDeps {
  pool: pg.Pool;
  masterKey: MasterKey;
  providerFactory: ProviderFactory;
  publicUrl: string;
  jobs?: Jobs | undefined;
  /** Nghỉ giữa hai PR trên cùng kết nối Git để không chạm hạn mức của GitHub/GitLab; test đặt 0. */
  pauseMs?: number;
}

const SAMPLE: TemplateVars = {
  projectKey: "payment-api",
  projectName: "payment-api",
  publicUrl: "https://hive.example",
  defaultBranch: "main",
  systemName: "Hệ thống mẫu",
};

/** Trang Chính sách agent: file hướng dẫn sinh cho một dự án (hoặc dự án mẫu) từ mẫu đang sửa. */
export function templateService(deps: Pick<TemplateSyncDeps, "publicUrl" | "jobs">): TemplateService {
  return {
    async preview(tx: Tx, templates: InstructionTemplates, key: string | undefined): Promise<TemplatePreview> {
      let vars: TemplateVars = { ...SAMPLE, publicUrl: deps.publicUrl };
      if (key) {
        const ref = await findProject(tx, key);
        if (!ref) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
        const [p] = await tx.select().from(projects).where(eq(projects.id, ref.id));
        if (!p) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
        vars = await varsOf(tx, p, deps.publicUrl);
      }
      return {
        project: { key: vars.projectKey, name: vars.projectName },
        files: instructionFiles(templates, vars),
      };
    },
    async requestSync(tx: Tx, orgId: string) {
      if (!deps.jobs) return;
      await deps.jobs.enqueue(TEMPLATE_SYNC_QUEUE, { orgId }, { tx, singletonKey: `sync:${orgId}` });
    },
  };
}

async function varsOf(tx: Tx, p: typeof projects.$inferSelect, publicUrl: string): Promise<TemplateVars> {
  const system = await findSystem(tx, p.systemId);
  return {
    projectKey: p.key,
    projectName: p.name,
    publicUrl,
    defaultBranch: p.defaultBranch ?? "main",
    systemName: system?.name ?? "",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mở (hoặc cập nhật) PR đưa file hướng dẫn theo mẫu hiện tại vào mọi dự án đang hoạt động. Dự án đã đúng mẫu thì bỏ
 * qua; lỗi ở một dự án (nhánh bị khoá, kết nối hết quyền) ghi vào kết quả và làm tiếp dự án khác. Gọi Git ngoài
 * transaction để không giữ kết nối database lúc chờ mạng.
 */
export async function syncInstructionTemplates(deps: TemplateSyncDeps, orgId: string): Promise<TemplateSyncResult> {
  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId }, fn);
  const plan = await tenant(async (tx) => {
    const policy = await loadPolicy(tx);
    const rows = await tx.select().from(projects).where(eq(projects.state, "active")).orderBy(asc(projects.key));
    const items = [];
    for (const p of rows) {
      if (!p.defaultBranch) continue;
      items.push({
        key: p.key,
        ref: { owner: p.repoOwner, name: p.repoName },
        base: p.defaultBranch,
        conn: await loadConnection(tx, deps.masterKey, p.scmConnectionId),
        files: instructionFiles(policy.templates, await varsOf(tx, p, deps.publicUrl)),
      });
    }
    return items;
  });
  const result: TemplateSyncResult = { at: new Date().toISOString(), opened: 0, unchanged: 0, failed: [] };
  for (const item of plan) {
    try {
      if (!item.conn) throw new Error("Kết nối Git của dự án không còn.");
      const provider = deps.providerFactory(item.conn);
      const head = await provider.branchHead(item.ref, item.base);
      if (!head) throw new Error(`Không thấy nhánh ${item.base}.`);
      const differs = async (sha: string) => {
        const current = await Promise.all(item.files.map((f) => provider.readFile(item.ref, f.path, sha)));
        return item.files.filter((f, i) => current[i] !== f.content);
      };
      const changed = await differs(head);
      // Nhánh chính đã đúng mẫu, hoặc PR lần trước đã mang đúng nội dung này: không commit thêm.
      const pending = changed.length ? await provider.branchHead(item.ref, INSTRUCTIONS_BRANCH) : null;
      if (!changed.length || (pending && !(await differs(pending)).length)) {
        result.unchanged++;
        continue;
      }
      await provider.commitFiles(item.ref, {
        branch: INSTRUCTIONS_BRANCH,
        fromBranch: item.base,
        message: "chore: cập nhật file hướng dẫn agent theo mẫu của tổ chức",
        files: changed,
      });
      await provider.openPR(item.ref, {
        head: INSTRUCTIONS_BRANCH,
        base: item.base,
        title: "Cập nhật file hướng dẫn agent (xDev Hive)",
        body: `Mẫu file hướng dẫn agent của tổ chức đã đổi (Chính sách agent trên xDev Hive). PR này cập nhật ${changed
          .map((f) => `\`${f.path}\``)
          .join(", ")} cho dự án \`${item.key}\`. Phần tự thêm trong file sẽ bị thay; xem kỹ trước khi merge.`,
      });
      result.opened++;
      if (deps.pauseMs !== 0) await sleep(deps.pauseMs ?? 2000);
    } catch (e) {
      result.failed.push({ project: item.key, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await tenant(async (tx) => {
    await recordTemplateSync(tx, result);
    await recordAudit(tx, {
      action: "policies.templates_synced",
      actorUserId: null,
      targetType: "org_policy",
      data: { opened: result.opened, unchanged: result.unchanged, failed: result.failed },
    });
  });
  return result;
}

export async function registerTemplateSyncWorker(jobs: Jobs, deps: TemplateSyncDeps): Promise<void> {
  await jobs.work<{ orgId: string }>(TEMPLATE_SYNC_QUEUE, async ({ data }) => {
    await syncInstructionTemplates(deps, data.orgId);
  });
}
