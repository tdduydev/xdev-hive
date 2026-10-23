import { MCP_CLIENT_EVENT_META } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { ClientEventRejected, ConflictError, NotFoundError, rejectionOf } from "../platform/index.ts";
import { rejectedResult, sourceOf, targetOf, toResult } from "./client-event.ts";
import type { McpPrincipal } from "./principal.ts";

const KEY = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const TASK = "5b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const DOC = "6c2d3e4f-5061-4b7c-9d8e-0f1a2b3c4d5e";
const user: McpPrincipal = { kind: "user", userId: "u1", scopes: [] };
const run: McpPrincipal = { kind: "run", userId: "u1", orgId: "o1", runId: "r1", taskId: TASK, scopes: [] };
const event = { key: KEY, outcome: "accepted", receivedAt: "2026-10-23T08:00:00.000Z" } as const;

describe("kết quả tool có ghi", () => {
  it("gắn sự kiện client vào _meta khi lời gọi có khoá", () => {
    expect(toResult({ value: { ok: true }, event })).toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
      _meta: { [MCP_CLIENT_EVENT_META]: event },
    });
    expect(toResult({ value: { ok: true } })).toEqual({ content: [{ type: "text", text: '{"ok":true}' }] });
  });

  it("lần từ chối là kết quả lỗi kèm mã để client không gửi lại", () => {
    const rejected = { ...event, outcome: "rejected", code: "TASK_DONE", reason: "Task đã xong." } as const;
    expect(rejectedResult(rejected, "Task đã xong.")).toEqual({
      isError: true,
      content: [{ type: "text", text: "Task đã xong." }],
      _meta: { [MCP_CLIENT_EVENT_META]: rejected },
    });
  });
});

describe("lỗi nào thành lần từ chối", () => {
  it("lỗi nghiệp vụ giữ mã, lỗi lạ thì không", () => {
    const conflict = rejectionOf(new ConflictError("RUN_NOT_ACTIVE", "Run không còn chạy."));
    expect(conflict).toBeInstanceOf(ClientEventRejected);
    expect(conflict).toMatchObject({ code: "RUN_NOT_ACTIVE", message: "Run không còn chạy." });
    expect(rejectionOf(new NotFoundError("TASK_NOT_FOUND", "Không thấy task."))?.code).toBe("TASK_NOT_FOUND");
    expect(rejectionOf(new Error("connection reset"))).toBeNull();
  });
});

describe("đối tượng và nguồn của lần ghi", () => {
  it("task của run đứng trước id trong tham số", () => {
    expect(targetOf(run, { docId: DOC })).toEqual({ targetType: "task", targetId: TASK });
    expect(targetOf(user, { docId: DOC })).toEqual({ targetType: "doc", targetId: DOC });
    expect(targetOf(user, { taskId: "XD-12" })).toEqual({});
  });

  it("run không khai nguồn là worker-run", () => {
    expect(sourceOf(run, { invalidKey: false, source: "unknown" })).toBe("worker-run");
    expect(sourceOf(user, { invalidKey: false, source: "unknown" })).toBe("unknown");
    expect(sourceOf(user, { invalidKey: false, source: "mcp-local" })).toBe("mcp-local");
  });
});
