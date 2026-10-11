import { describe, expect, it } from "vitest";
import { mcpEnabled, mcpResource } from "./auth.ts";

describe("cổng MCP theo HIVE_PUBLIC_URL", () => {
  it("bật với HTTPS và localhost, tắt với http trên máy khác", () => {
    expect(mcpEnabled("https://hive.example.com")).toBe(true);
    expect(mcpEnabled("http://localhost:5173")).toBe(true);
    expect(mcpEnabled("http://127.0.0.1:3000")).toBe(true);
    expect(mcpEnabled("http://hive.noi-bo:3000")).toBe(false);
    expect(mcpEnabled("khong-phai-url")).toBe(false);
  });

  it("định danh tài nguyên không có dấu / thừa", () => {
    expect(mcpResource("https://hive.example.com/")).toBe("https://hive.example.com/mcp");
  });
});
