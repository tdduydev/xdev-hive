import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpToolRegistry } from "./registry.ts";

const tool = (name: string, input: z.ZodObject = z.object({})) => ({
  name,
  description: "thử",
  input,
  handler: async () => null,
});

describe("McpToolRegistry", () => {
  it("giữ thứ tự đăng ký", () => {
    const r = new McpToolRegistry();
    r.register(tool("a_list"));
    r.register(tool("b_get"));
    expect(r.list().map((t) => t.name)).toEqual(["a_list", "b_get"]);
  });

  it("chặn tên trùng, tên sai dạng và tool tự khai báo org", () => {
    const r = new McpToolRegistry();
    r.register(tool("a_list"));
    expect(() => r.register(tool("a_list"))).toThrow(/đã được đăng ký/);
    expect(() => r.register(tool("A-List"))).toThrow(/không hợp lệ/);
    // Cổng tự thêm tham số org để chọn tổ chức; tool khai báo trùng sẽ làm lệch cách chọn đó.
    expect(() => r.register(tool("b_list", z.object({ org: z.string() })))).toThrow(/org/);
  });

  it("báo lỗi rõ khi chưa module nào cung cấp danh sách tổ chức", () => {
    expect(() => new McpToolRegistry().memberships({} as never, "u")).toThrow(/Chưa có module/);
  });
  it("tool bổ sung chỉ hiện cho đúng loại run, OAuth vẫn thấy đủ", () => {
    const registry = new McpToolRegistry();
    registry.register(tool("task_get"));
    registry.register(tool("memory_write"));
    registry.register({ ...tool("review_submit"), runKinds: ["review"] });
    registry.register({ ...tool("leader_reply"), runKinds: ["leader"] });
    registry.register({ ...tool("leader_propose"), runKinds: ["leader"] });
    const principal = { kind: "run" as const, userId: "u", scopes: [] };
    expect(registry.list(principal).map((t) => t.name)).toEqual(["task_get"]);
    expect(registry.list({ ...principal, runKind: "code" }).map((t) => t.name)).toEqual(["task_get"]);
    expect(registry.list({ ...principal, runKind: "review" }).map((t) => t.name)).toEqual([
      "task_get",
      "review_submit",
    ]);
    expect(registry.list({ ...principal, kind: "user" }).map((t) => t.name)).toEqual([
      "task_get",
      "memory_write",
      "review_submit",
    ]);
    expect(registry.list({ ...principal, runKind: "leader" }).map((t) => t.name)).toEqual([
      "leader_reply",
      "leader_propose",
    ]);
  });
});
