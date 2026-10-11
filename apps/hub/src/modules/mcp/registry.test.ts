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
});
