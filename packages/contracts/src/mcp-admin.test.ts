import { describe, expect, it } from "vitest";
import { mcpServerKey, mcpServerKeyPattern, mcpServerRuleInput } from "./mcp-admin.ts";
import { hubToWorker, PROTOCOL_VERSION } from "./worker-protocol.ts";

describe("MCP server ngoài", () => {
  it("suy tên trong cấu hình CLI từ tên hiển thị", () => {
    expect(mcpServerKey("GitHub")).toBe("github");
    expect(mcpServerKey("Mọi server khác")).toBe("moi-server-khac");
    expect(mcpServerKey("  Đồ hoạ / Figma  ")).toBe("do-hoa-figma");
    expect(mcpServerKey("***")).toBe("server");
    for (const name of ["GitHub", "Mọi server khác", "x".repeat(200), "-_a_-"])
      expect(mcpServerKey(name)).toMatch(mcpServerKeyPattern);
  });

  it("nhận quy tắc chỉ có mẫu khớp và quy tắc kèm cấu hình khởi chạy", () => {
    expect(
      mcpServerRuleInput.parse({ name: "Shell", rule: "deny", matchType: "name", projectId: null, launch: null }),
    ).toMatchObject({ pattern: "" });
    const stdio = mcpServerRuleInput.parse({
      name: "Playwright",
      rule: "allow",
      matchType: "command",
      pattern: "npx @playwright/mcp",
      projectId: null,
      launch: { transport: "stdio", command: " npx ", args: ["-y", "@playwright/mcp"] },
    });
    expect(stdio.launch).toEqual({ transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp"] });
  });

  it(`từ chối \${BIẾN} vì Claude Code sẽ thay bằng biến môi trường của run (có run token)`, () => {
    for (const launch of [
      { transport: "stdio", command: "npx", args: ["--token", `\${HIVE_RUN_TOKEN}`] },
      { transport: "stdio", command: `\${HOME}/bin/server`, args: [] },
      { transport: "http", url: `https://mcp.example.com/\${HIVE_MCP_TOKEN}` },
    ]) {
      const result = mcpServerRuleInput.safeParse({
        name: "x",
        rule: "allow",
        matchType: "wildcard",
        projectId: null,
        launch,
      });
      expect(result.success).toBe(false);
    }
  });

  it("chỉ nhận URL http(s) cho server HTTP", () => {
    const parse = (url: string) =>
      mcpServerRuleInput.safeParse({
        name: "x",
        rule: "allow",
        matchType: "url",
        projectId: null,
        launch: { transport: "http", url },
      }).success;
    expect(parse("https://mcp.example.com/mcp")).toBe(true);
    expect(parse("file:///etc/passwd")).toBe(false);
  });

  it("job_offer mang danh sách server được phép; worker cũ không gửi trường này vẫn hợp lệ", () => {
    const offer = (mcpServers?: unknown) =>
      hubToWorker.safeParse({
        type: "job_offer",
        v: PROTOCOL_VERSION,
        id: "o1",
        runId: "run-1",
        attempt: 1,
        ttl: 30,
        spec: { cli: "claude", ...(mcpServers ? { mcpServers } : {}) },
      });
    expect(offer().success).toBe(true);
    expect(
      offer([
        { name: "github", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        { name: "context7", transport: "http", url: "https://mcp.context7.com/mcp" },
      ]).success,
    ).toBe(true);
    expect(offer([{ name: "Bad Name", transport: "http", url: "https://x.example" }]).success).toBe(false);
  });
});
