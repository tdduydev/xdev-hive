import type { CallToolResult } from "@modelcontextprotocol/server";
import { type ClientEventResult, type ClientSource, MCP_CLIENT_EVENT_META } from "@xdev-hive/contracts";
import {
  BadRequestError,
  type ClientEventMeta,
  ClientEventRejected,
  type ClientRequest,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../platform/index.ts";
import type { McpPrincipal } from "./principal.ts";

// Phần sự kiện client của cổng MCP (specs/027 US1), tách khỏi server.ts để test không cần database.

/** Kết quả của tool, kèm sự kiện client khi lời gọi có ghi mang khoá. */
export interface ToolOutput {
  value: unknown;
  event?: ClientEventResult | undefined;
}

/** Lỗi do handler ném vì trạng thái hiện tại: với lần ghi có khoá thì lưu thành lần từ chối, gửi lại nhận đúng lỗi đó. */
export function rejectionOf(error: unknown): ClientEventRejected | null {
  if (
    error instanceof ForbiddenError ||
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof BadRequestError
  ) {
    return new ClientEventRejected(error.code, error.message);
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Đối tượng của lần ghi cho lịch sử task (FR-006): task của run trước, rồi id trong tham số. */
export function targetOf(
  principal: McpPrincipal,
  args: Record<string, unknown>,
): Pick<ClientEventMeta, "targetType" | "targetId"> {
  if (principal.taskId) return { targetType: "task", targetId: principal.taskId };
  for (const [field, type] of [
    ["taskId", "task"],
    ["docId", "doc"],
    ["skillId", "skill"],
    ["artifactId", "artifact"],
  ] as const) {
    const id = args[field];
    if (typeof id === "string" && UUID.test(id)) return { targetType: type, targetId: id };
  }
  return {};
}

/** Agent trong run gọi qua runner, không khai nguồn thì vẫn biết là `worker-run`. */
export function sourceOf(principal: McpPrincipal, request: ClientRequest): ClientSource {
  if (request.source !== "unknown") return request.source;
  return principal.kind === "run" ? "worker-run" : "unknown";
}

export function toResult({ value, event }: ToolOutput): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(event ? { _meta: { [MCP_CLIENT_EVENT_META]: event } } : {}),
  };
}

/** Kết quả lỗi của lần ghi bị từ chối, kèm sự kiện để client biết không gửi lại. */
export function rejectedResult(event: ClientEventResult, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }], _meta: { [MCP_CLIENT_EVENT_META]: event } };
}
