import { z } from "zod";
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

export const chatMessage = z.object({
  id,
  role: leaderRole,
  content: z.string(),
  runId: id.nullable(),
  createdAt: z.iso.datetime(),
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
};
