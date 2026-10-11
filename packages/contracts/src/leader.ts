import { z } from "zod";
import { id, orgRoute } from "./common.ts";
import { projectSettingsPatch } from "./projects.ts";
import { cli } from "./worker-protocol.ts";

export const leaderRole = z.enum(["user", "leader", "system"]);
export const approvalStatus = z.enum(["pending", "approved", "rejected", "expired"]);

export const leaderAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task.create"),
    projectId: id,
    title: z.string().trim().min(1).max(200),
    body: z.string().max(50_000).default(""),
  }),
  z.object({ type: z.literal("run.dispatch"), taskId: id, cli: cli.optional() }),
  z.object({ type: z.literal("run.cancel"), runId: id }),
  z.object({
    type: z.literal("project.settings"),
    projectKey: z.string().min(1).max(100),
    patch: projectSettingsPatch,
  }),
]);
export type LeaderAction = z.output<typeof leaderAction>;

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
      .input(z.object({ status: approvalStatus.optional() }))
      .output(z.array(approval)),
    approve: orgRoute("POST", "/v1/leader/approvals/{id}/approve", "Duyệt đề xuất của leader", "leader")
      .input(z.object({ id }))
      .output(z.object({ approval, result: z.record(z.string(), z.unknown()).nullable() })),
    reject: orgRoute("POST", "/v1/leader/approvals/{id}/reject", "Từ chối đề xuất của leader", "leader")
      .input(z.object({ id, reason: z.string().trim().min(1).max(2000) }))
      .output(approval),
  },
};
