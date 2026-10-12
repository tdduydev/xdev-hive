import { z } from "zod";
import { orgRoute } from "./common.ts";
import { runPermissionMode } from "./projects.ts";

/**
 * Chính sách agent của tổ chức (specs/002-agent-policies, Policies.dc.html): model được dùng, quyền CLI, hook bắt
 * buộc, file hướng dẫn agent và trần chung. Áp cho mọi run; dự án đặt chặt hơn được, lỏng hơn thì không. Mặc định giữ
 * nguyên hành vi trước khi có chính sách (không giới hạn gì), để tổ chức cũ không đổi cách chạy khi nâng cấp hub.
 */
export const hookEvent = z.enum(["PreToolUse", "PostToolUse", "Stop"]);
export type HookEvent = z.output<typeof hookEvent>;

export const policyHook = z.object({
  event: hookEvent,
  name: z.string().trim().min(1, "Đặt tên cho hook.").max(120),
  command: z.string().trim().min(1, "Nhập lệnh của hook.").max(2000),
  /** PreToolUse/PostToolUse: tên tool cần khớp (cú pháp matcher của Claude Code). Bỏ trống là mọi tool. */
  matcher: z.string().trim().max(200).optional(),
});
export type PolicyHook = z.output<typeof policyHook>;

const modelName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:@/[\]-]+$/, "Tên model chỉ gồm chữ, số và . _ : @ / [ ] -");
const modelList = z.array(modelName).max(20);

/** Model được dùng theo CLI. Danh sách rỗng là không giới hạn; có danh sách thì model ngoài danh sách về model đầu. */
export const allowedModels = z.object({ claude: modelList, codex: modelList, gemini: modelList });
export type AllowedModels = z.output<typeof allowedModels>;

const templateText = z.string().max(50_000).nullable();
/** Mẫu file hướng dẫn agent; null là mẫu chuẩn của hub. Biến: {{project.name}}, {{project.key}}, {{mcp.url}}. */
export const instructionTemplates = z.object({ agents: templateText, claude: templateText, mcp: templateText });
export type InstructionTemplates = z.output<typeof instructionTemplates>;

export const runLogRetentionDays = z.union([z.literal(30), z.literal(90), z.literal(365)]);

export const policyLimits = z.object({
  /** Trần USD mỗi run; dự án đặt cao hơn thì bị hạ về đây. null là không giới hạn. */
  perRunUsd: z.number().positive().max(100_000).nullable(),
  /** Trần USD mỗi ngày (UTC) của cả tổ chức: chạm trần thì run mới chờ tới ngày sau. */
  dailyUsd: z.number().positive().max(10_000_000).nullable(),
  /** Số run cùng lúc mỗi máy, thấp hơn sức chứa máy tự khai thì lấy số này. */
  maxParallelPerMachine: z.number().int().min(1).max(64).nullable(),
  /** Số ngày giữ log của run (luồng stdout/stderr); sự kiện trạng thái và kết quả vẫn giữ. */
  runLogRetentionDays: runLogRetentionDays,
});
export type PolicyLimits = z.output<typeof policyLimits>;

export const agentPolicyInput = z.object({
  allowedModels,
  /** Hub không để CLI tự chọn model: run không chỉ định model thì dùng model đầu trong danh sách của CLI đó. */
  neverAutoUpgrade: z.boolean(),
  /** Quyền CLI mặc định của dự án mới. */
  defaultPermissionMode: runPermissionMode,
  /** Tắt thì dự án không bật được `full`; run của dự án đang `full` chạy ở `workspace`. */
  allowFullPermission: z.boolean(),
  /** Mọi run code chạy trong container gVisor trên runner host, bất kể cấu hình dự án. */
  requireSandbox: z.boolean(),
  hooks: z.array(policyHook).max(30),
  /** Chỉ chạy hook của tổ chức: CLI không nạp hook và cấu hình trong repo. */
  managedHooksOnly: z.boolean(),
  templates: instructionTemplates,
  /** Mẫu đổi thì hub mở PR cập nhật file hướng dẫn ở mọi dự án đang hoạt động. */
  autoSyncTemplates: z.boolean(),
  limits: policyLimits,
});
export type AgentPolicyInput = z.input<typeof agentPolicyInput>;

export const templateSyncResult = z.object({
  at: z.iso.datetime(),
  opened: z.number().int(),
  unchanged: z.number().int(),
  failed: z.array(z.object({ project: z.string(), error: z.string() })),
});
export type TemplateSyncResult = z.output<typeof templateSyncResult>;

export const agentPolicy = agentPolicyInput.extend({
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
  /** Lần mở PR cập nhật file hướng dẫn gần nhất. */
  templateSync: templateSyncResult.nullable(),
  /** Mẫu chuẩn của hub, để trang chính sách hiện và khôi phục khi mẫu của tổ chức là null. */
  defaultTemplates: z.object({ agents: z.string(), claude: z.string(), mcp: z.string() }),
});
export type AgentPolicy = z.output<typeof agentPolicy>;

export const DEFAULT_AGENT_POLICY: z.output<typeof agentPolicyInput> = {
  allowedModels: { claude: [], codex: [], gemini: [] },
  neverAutoUpgrade: false,
  defaultPermissionMode: "workspace",
  allowFullPermission: true,
  requireSandbox: false,
  hooks: [],
  managedHooksOnly: false,
  templates: { agents: null, claude: null, mcp: null },
  autoSyncTemplates: false,
  limits: { perRunUsd: null, dailyUsd: null, maxParallelPerMachine: null, runLogRetentionDays: 365 },
};

/** Phần chính sách worker cần để chạy run: hook và việc bỏ cấu hình của repo. Ghi trong spec của job_offer. */
export const jobPolicy = z.object({
  hooks: z.array(policyHook),
  managedHooksOnly: z.boolean(),
});
export type JobPolicy = z.output<typeof jobPolicy>;

export const templatePreviewInput = z.object({
  /** Dự án để điền biến; bỏ trống thì dùng dự án mẫu. */
  project: z.string().trim().min(1).max(100).optional(),
  /** Mẫu đang sửa (chưa lưu); bỏ trống thì dùng mẫu đã lưu. */
  templates: instructionTemplates.optional(),
});

export const templatePreview = z.object({
  project: z.object({ key: z.string(), name: z.string() }),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});
export type TemplatePreview = z.output<typeof templatePreview>;

export const policiesContract = {
  get: orgRoute("GET", "/v1/policies", "Chính sách agent của tổ chức", "policies").output(agentPolicy),
  update: orgRoute("POST", "/v1/policies", "Lưu chính sách agent (quản trị tổ chức)", "policies")
    .input(agentPolicyInput)
    .output(agentPolicy),
  preview: orgRoute("POST", "/v1/policies/templates/preview", "Xem file hướng dẫn sinh từ mẫu", "policies")
    .input(templatePreviewInput)
    .output(templatePreview),
  syncTemplates: orgRoute(
    "POST",
    "/v1/policies/templates/sync",
    "Mở PR cập nhật file hướng dẫn ở mọi dự án đang hoạt động",
    "policies",
  ).output(z.object({ queued: z.boolean() })),
};
