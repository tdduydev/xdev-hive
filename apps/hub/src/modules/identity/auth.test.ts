import { describe, expect, it } from "vitest";
import { mcpEnabled, mcpMode, mcpResource } from "./auth.ts";

describe("cổng MCP theo HIVE_PUBLIC_URL", () => {
  it("bật với HTTPS và localhost, tắt với http trên máy khác", () => {
    expect(mcpEnabled("https://hive.example.com")).toBe(true);
    expect(mcpEnabled("http://localhost:5173")).toBe(true);
    expect(mcpEnabled("http://127.0.0.1:3000")).toBe(true);
    expect(mcpEnabled("http://hive.noi-bo:3000")).toBe(false);
    expect(mcpEnabled("khong-phai-url")).toBe(false);
  });

  it("cờ cho phép http chỉ mở chế độ chỉ-run-token trên http không phải localhost", () => {
    expect(mcpMode("http://hive.noi-bo:3000", false)).toBe("off");
    expect(mcpMode("http://hive.noi-bo:3000", true)).toBe("run");
    expect(mcpMode("https://hive.example.com", true)).toBe("full");
    expect(mcpMode("http://localhost:3000", true)).toBe("full");
    expect(mcpMode("khong-phai-url", true)).toBe("off");
  });

  it("định danh tài nguyên không có dấu / thừa", () => {
    expect(mcpResource("https://hive.example.com/")).toBe("https://hive.example.com/mcp");
  });
});
