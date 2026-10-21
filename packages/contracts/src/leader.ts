import { z } from "zod";
import { artifactPageErrors, artifactType } from "./artifacts.ts";
import { id, orgRoute } from "./common.ts";
import { projectSettingsPatch, taskTier } from "./projects.ts";
import { sdlcItemCreate } from "./sdlc.ts";
import { cli } from "./worker-protocol.ts";

export const leaderRole = z.enum(["user", "leader", "system"]);
export const approvalStatus = z.enum(["pending", "approved", "rejected", "expired"]);

/**
 * Cấp độ Leader gắn cho task hay run nó đề xuất, kèm lý do ngắn. Hub chọn model/effort theo cấp (định tuyến của dự án);
 * người duyệt sửa được cấp trước khi duyệt. Đề xuất cũ không có cấp: hub tự suy như run thường.
 */
const leveled = {
  tier: taskTier.optional(),
  tierReason: z.string().trim().max(500).optional(),
};

export const leaderAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task.create"),
    projectId: id,
    title: z.string().trim().min(1).max(200),
    body: z.string().max(50_000).default(""),
    ...leveled,
  }),
  z.object({ type: z.literal("run.dispatch"), taskId: id, cli: cli.optional(), ...leveled }),
  z.object({ type: z.literal("run.cancel"), runId: id }),
  z.object({
    type: z.literal("project.settings"),
    projectKey: z.string().min(1).max(100),
    patch: projectSettingsPatch,
  }),
  // Leader đề xuất mở hạng mục AI SDLC cho việc lớn (specs/011 US1-5); người duyệt đề xuất thành chủ hạng mục.
  z.object({ type: z.literal("sdlc.item.create"), item: sdlcItemCreate }),
]);
export type LeaderAction = z.output<typeof leaderAction>;

/**
 * Ý nghĩa từng cấp độ để Leader chọn nhất quán (tool MCP `leader_tiers` trả bảng này cùng model/effort của dự án).
 * Mặc định khớp `defaultRouting`: nhẹ sonnet + medium, vừa sonnet + high, nặng opus + high.
 */
export const LEADER_TIER_GUIDE = [
  { tier: "light", label: "Nhẹ", meaning: "Tài liệu, đổi chữ, sửa cấu hình nhỏ, thêm hoặc sửa test nhỏ." },
  { tier: "medium", label: "Vừa", meaning: "Một màn giao diện, CRUD kèm e2e, refactor gọn trong một module." },
  {
    tier: "heavy",
    label: "Nặng",
    meaning: "Nhiều module, giao thức, bảo mật, migration dữ liệu, hiệu năng, việc khó cần suy luận sâu.",
  },
] as const satisfies readonly { tier: z.output<typeof taskTier>; label: string; meaning: string }[];

/** Thẻ artifact trong tin nhắn (specs/012 C12, D10). */
export const chatArtifactRef = z.object({
  id,
  version: z.int().min(1),
  title: z.string(),
  type: artifactType,
  /** Artifact đang trong thùng rác: thẻ hiện "Artifact đã bị xoá". Xoá hẳn thì `artifact` của tin nhắn thành null. */
  deleted: z.boolean().default(false),
});
export type ChatArtifactRef = z.output<typeof chatArtifactRef>;

export const chatMessage = z.object({
  id,
  role: leaderRole,
  // Tin nhắn thẻ vẫn có `content` là tiêu đề artifact, để client chưa biết thẻ hiện được chữ.
  content: z.string(),
  runId: id.nullable(),
  createdAt: z.iso.datetime(),
  // Có mặc định vì hub trước specs/012 không trả hai trường này.
  artifact: chatArtifactRef.nullable().default(null),
  /** Tin "Nhờ Leader sửa" (C18): lỗi của trang, dữ liệu không tin cậy do trang viết. */
  pageErrors: artifactPageErrors.nullable().default(null),
});
export type ChatMessage = z.output<typeof chatMessage>;

export const approval = z.object({
  id,
  threadId: id,
  action: leaderAction,
  status: approvalStatus,
  expiresAt: z.iso.datetime(),
  decidedBy: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type Approval = z.output<typeof approval>;

const thread = z.object({
  id,
  projectId: id.nullable(),
  title: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ChatThread = z.output<typeof thread>;

/** Nút sub-agent trong cây (specs/028): dựng từ sự kiện `subagent` của run. */
export const treeSubagent = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  type: z.string(),
  description: z.string(),
  status: z.enum(["running", "completed", "failed", "killed", "unknown"]),
  depth: z.number().int(),
  tokens: z.number().int().nullable(),
  toolUses: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
});
export type TreeSubagent = z.output<typeof treeSubagent>;

export const treeRun = z.object({
  id,
  kind: z.string(),
  state: z.string(),
  attempt: z.number().int(),
  parentRunId: id.nullable(),
  machine: z.object({ id, name: z.string() }).nullable(),
  cli: z.string().nullable(),
  account: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  costUsd: z.number().nullable(),
  error: z.string().nullable(),
  /** null: CLI chưa báo gì về sub-agent; [] khi có báo mà không gọi sub-agent nào. */
  subagents: z.array(treeSubagent).nullable(),
  subagentsUnsupported: z.boolean(),
});
export type TreeRun = z.output<typeof treeRun>;

export const treeTask = z.object({
  id,
  key: z.string(),
  title: z.string(),
  status: z.string(),
  projectKey: z.string(),
  /** `leader`: Leader tạo trong phiên này; `user`: người tạo, Leader chỉ giao run. */
  createdBy: z.enum(["leader", "user"]),
  runs: z.array(treeRun),
});
export type TreeTask = z.output<typeof treeTask>;

/** Cây giao việc của một phiên Leader (specs/028): phiên → task → run (run con theo parentRunId) → sub-agent. */
export const delegationTree = z.object({
  thread: z.object({ id, title: z.string(), createdAt: z.iso.datetime() }),
  tasks: z.array(treeTask),
  /** Task và run có liên quan mà người xem không có quyền xem (FR-015). */
  hidden: z.number().int(),
  /** Còn run hay sub-agent đang chạy: client poll dày hơn. */
  active: z.boolean(),
});
export type DelegationTree = z.output<typeof delegationTree>;

export const leaderContract = {
  threads: {
    create: orgRoute("POST", "/v1/leader/threads", "Tạo cuộc trò chuyện với leader", "leader")
      .input(z.object({ projectId: id.nullable().optional(), title: z.string().trim().min(1).max(200) }))
      .output(thread),
    list: orgRoute("GET", "/v1/leader/threads", "Danh sách cuộc trò chuyện", "leader")
      .input(z.object({}))
      .output(z.array(thread)),
    get: orgRoute("GET", "/v1/leader/threads/{id}", "Lịch sử cuộc trò chuyện", "leader")
      .input(z.object({ id }))
      .output(z.object({ thread, messages: z.array(chatMessage) })),
    send: orgRoute("POST", "/v1/leader/threads/{id}/messages", "Gửi tin nhắn cho leader", "leader")
      .input(z.object({ id, content: z.string().trim().min(1).max(20_000), cli: cli.optional() }))
      .output(z.object({ message: chatMessage, runId: id.nullable() })),
  },
  approvals: {
    list: orgRoute("GET", "/v1/leader/approvals", "Đề xuất đang chờ duyệt", "leader")
      .input(z.object({ status: approvalStatus.optional(), threadId: id.optional() }))
      .output(z.array(approval)),
    approve: orgRoute("POST", "/v1/leader/approvals/{id}/approve", "Duyệt đề xuất của leader", "leader")
      // `tier`: người duyệt đổi cấp độ Leader đã chọn (chỉ với task.create và run.dispatch).
      .input(z.object({ id, tier: taskTier.optional() }))
      .output(z.object({ approval, result: z.record(z.string(), z.unknown()).nullable() })),
    reject: orgRoute("POST", "/v1/leader/approvals/{id}/reject", "Từ chối đề xuất của leader", "leader")
      .input(z.object({ id, reason: z.string().trim().min(1).max(2000) }))
      .output(approval),
  },
  tree: {
    get: orgRoute("GET", "/v1/leader/threads/{id}/tree", "Cây giao việc của cuộc trò chuyện với leader", "leader")
      .input(z.object({ id }))
      .output(delegationTree),
    links: orgRoute("GET", "/v1/leader/tree-links", "Các cuộc trò chuyện có giao task hay run này", "leader")
      .input(z.object({ taskId: id.optional(), runId: id.optional() }))
      .output(z.array(z.object({ threadId: id, title: z.string() }))),
  },
};
