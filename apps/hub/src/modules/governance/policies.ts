import {
  type AgentPolicy,
  type AgentPolicyInput,
  agentPolicyInput,
  DEFAULT_AGENT_POLICY,
  DEFAULT_ORG_SDLC_POLICY,
  type JobPolicy,
  type OrgSdlcPolicy,
  type ProjectBudget,
  type TemplateSyncResult,
} from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import type { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { ForbiddenError, type Tx } from "../platform/index.ts";
import { allowWith, effectivePermissions, requireOrgRole } from "../tenancy/index.ts";
import { agentPolicies } from "./schema.ts";
import { DEFAULT_TEMPLATES } from "./templates.ts";

export type Policy = z.output<typeof agentPolicyInput>;
type Cli = keyof Policy["allowedModels"];

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Chính sách đang áp của tổ chức trong transaction. Chưa lưu lần nào, hay bản lưu không còn khớp schema (sửa tay bằng
 * SQL), thì dùng mặc định: chính sách hỏng không được làm hub dừng giao run.
 */
export async function loadPolicy(tx: Tx): Promise<Policy> {
  const [row] = await tx.select().from(agentPolicies);
  if (!row) return DEFAULT_AGENT_POLICY;
  const parsed = agentPolicyInput.safeParse(row.policy);
  return parsed.success ? parsed.data : DEFAULT_AGENT_POLICY;
}

/** Mục `sdlc` của chính sách: tổ chức chưa lưu mục này (lưu trước khi có AI SDLC) thì dùng mặc định, không phải "tắt". */
export async function sdlcPolicyOf(tx: Tx): Promise<OrgSdlcPolicy> {
  return (await loadPolicy(tx)).sdlc ?? DEFAULT_ORG_SDLC_POLICY;
}

export async function getAgentPolicy(tx: Tx): Promise<AgentPolicy> {
  const [row] = await tx.select().from(agentPolicies);
  const parsed = row ? agentPolicyInput.safeParse(row.policy) : null;
  return {
    ...(parsed?.success ? parsed.data : DEFAULT_AGENT_POLICY),
    updatedAt: iso(row?.updatedAt ?? null),
    updatedBy: row?.updatedBy ?? null,
    templateSync: row?.templateSync ?? null,
    defaultTemplates: DEFAULT_TEMPLATES,
  };
}

const allowsFull = (p: Policy) => p.allowFullPermission || p.defaultPermissionMode === "full";

/**
 * Lưu chính sách. Quyền `policies.write` (owner, admin tổ chức); mở toàn quyền CLI cho dự án cần thêm
 * `policies.fullaccess`, mặc định chỉ owner có (DANGEROUS_PERMISSIONS). Trả về chính sách mới và cờ mẫu file đã đổi để
 * router quyết định có mở PR cập nhật không.
 */
export async function saveAgentPolicy(
  tx: Tx,
  userId: string,
  input: AgentPolicyInput,
): Promise<{ policy: AgentPolicy; templatesChanged: boolean }> {
  await allowWith(tx, userId, "policies.write", () => requireOrgRole(tx, userId, "admin"));
  const before = await loadPolicy(tx);
  // Client chưa biết mục `remote` không gửi nó; điền mặc định lúc đó sẽ bật lại TOTP mà tổ chức đã tắt.
  const next = agentPolicyInput.parse(input.remote === undefined ? { ...input, remote: before.remote } : input);
  if (allowsFull(next) && !allowsFull(before)) {
    const granted = await effectivePermissions(tx, userId);
    if (!granted.has("policies.fullaccess")) {
      throw new ForbiddenError(
        "POLICY_FULLACCESS_REQUIRED",
        "Cần quyền “Cho phép CLI toàn quyền” (mặc định chỉ owner) để mở toàn quyền cho dự án.",
      );
    }
  }
  const [row] = await tx
    .insert(agentPolicies)
    .values({ orgId: sql`hive.ctx_org()`, policy: next, updatedBy: userId, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: agentPolicies.orgId,
      set: { policy: next, updatedBy: userId, updatedAt: sql`now()` },
    })
    .returning();
  // Chỉ ghi mục đổi; chính sách không chứa secret nên ghi nguyên giá trị trước và sau.
  const changed = (Object.keys(next) as (keyof Policy)[]).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]),
  );
  await recordAudit(tx, {
    action: "policies.update",
    targetType: "org_policy",
    data: {
      changed,
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, next[k]])),
    },
  });
  return {
    policy: {
      ...next,
      updatedAt: iso(row?.updatedAt ?? null),
      updatedBy: userId,
      templateSync: row?.templateSync ?? null,
      defaultTemplates: DEFAULT_TEMPLATES,
    },
    templatesChanged: changed.includes("templates"),
  };
}

/** Ghi kết quả lần mở PR cập nhật file hướng dẫn (job đồng bộ mẫu gọi). */
export async function recordTemplateSync(tx: Tx, result: TemplateSyncResult): Promise<void> {
  await tx
    .insert(agentPolicies)
    .values({ orgId: sql`hive.ctx_org()`, policy: DEFAULT_AGENT_POLICY, templateSync: result })
    .onConflictDoUpdate({ target: agentPolicies.orgId, set: { templateSync: result } });
}

// ---- Áp chính sách khi giao run (hàm thuần, runs và catalog gọi) --------------------------------------------------

/**
 * Model thực dùng. Có danh sách: model ngoài danh sách về model đầu; run không chỉ định model thì CLI tự chọn, trừ khi
 * bật "không tự lên model đắt nhất" (lúc đó dùng model đầu). `notice` để ghi vào sự kiện của run.
 */
export function resolveModel(
  policy: Policy,
  cli: string,
  requested: string | null,
): { model: string | null; notice: string | null } {
  const allowed = policy.allowedModels[cli as Cli] ?? [];
  const first = allowed[0];
  if (!first) return { model: requested, notice: null };
  if (requested === null) {
    return policy.neverAutoUpgrade
      ? { model: first, notice: `Chính sách tổ chức: run không chỉ định model nên dùng ${first}.` }
      : { model: null, notice: null };
  }
  if (allowed.includes(requested)) return { model: requested, notice: null };
  return {
    model: first,
    notice: `Chính sách tổ chức không cho dùng ${requested} với ${cli}; run dùng ${first}.`,
  };
}

/** Quyền CLI thực dùng: tổ chức không cho toàn quyền thì `full` của dự án về `workspace`. */
export function resolvePermission(
  policy: Policy,
  mode: "workspace" | "full",
): { mode: "workspace" | "full"; notice: string | null } {
  if (mode === "full" && !policy.allowFullPermission) {
    return { mode: "workspace", notice: "Chính sách tổ chức không cho toàn quyền CLI; run chạy trong worktree." };
  }
  return { mode, notice: null };
}

/** Trần mỗi run của dự án, hạ về trần của tổ chức nếu cao hơn hoặc bỏ trống. */
export function clampBudget(policy: Policy, budget: ProjectBudget | undefined): ProjectBudget | undefined {
  const cap = policy.limits.perRunUsd;
  if (cap === null) return budget;
  const perRunUsd = budget?.perRunUsd === undefined ? cap : Math.min(budget.perRunUsd, cap);
  return { ...budget, perRunUsd };
}

/** Số run cùng lúc của máy theo chính sách. */
export function machineSlots(policy: Policy, capacity: number): number {
  const max = policy.limits.maxParallelPerMachine;
  return max === null ? capacity : Math.min(capacity, max);
}

export const jobPolicyOf = (policy: Policy): JobPolicy => ({
  hooks: policy.hooks,
  managedHooksOnly: policy.managedHooksOnly,
});
