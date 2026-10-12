import type { McpServerLaunch } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { decide, identityOf, jobServers, resolveServers, ruleMatches, type ServerRule } from "./server-rules.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
let n = 0;
function rule(
  name: string,
  effect: "allow" | "deny",
  matchType: ServerRule["matchType"],
  pattern: string,
  opts: { projectId?: string; launch?: McpServerLaunch } = {},
): ServerRule {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name,
    rule: effect,
    matchType,
    pattern,
    projectId: opts.projectId ?? null,
    launch: opts.launch ?? null,
    createdAt: new Date(2026, 9, 1, 0, 0, n),
  };
}
const stdio = (command: string, ...args: string[]): McpServerLaunch => ({ transport: "stdio", command, args });
const http = (url: string): McpServerLaunch => ({ transport: "http", url });

describe("khớp quy tắc", () => {
  const fs = identityOf("Filesystem", stdio("npx", "-y", "@modelcontextprotocol/server-filesystem@2.1.0", "/tmp"));
  const gh = identityOf("GitHub", stdio("/usr/local/bin/npx", "@modelcontextprotocol/server-github"));
  const ctx = identityOf("Context7", http("https://mcp.context7.com/mcp/"));

  it("name: so với tên trong cấu hình CLI và tên hiển thị, không phân biệt hoa thường, có *", () => {
    expect(ruleMatches({ matchType: "name", pattern: "github" }, gh)).toBe(true);
    expect(ruleMatches({ matchType: "name", pattern: "GITHUB" }, gh)).toBe(true);
    expect(ruleMatches({ matchType: "name", pattern: "git*" }, gh)).toBe(true);
    expect(ruleMatches({ matchType: "name", pattern: "gitlab" }, gh)).toBe(false);
    // `.` trong mẫu là chữ thường, không phải ký tự đại diện của regex.
    expect(ruleMatches({ matchType: "name", pattern: "git.ub" }, gh)).toBe(false);
  });

  it("url: khớp nguyên URL hoặc theo *, bỏ qua dấu / cuối; server stdio không có URL", () => {
    expect(ruleMatches({ matchType: "url", pattern: "https://mcp.context7.com/mcp" }, ctx)).toBe(true);
    expect(ruleMatches({ matchType: "url", pattern: "https://*.context7.com/*" }, ctx)).toBe(true);
    expect(ruleMatches({ matchType: "url", pattern: "https://mcp.context7.com" }, ctx)).toBe(false);
    expect(ruleMatches({ matchType: "url", pattern: "*" }, gh)).toBe(false);
  });

  it("command: chương trình theo tên file, tham số theo thứ tự, xen cờ và gắn phiên bản npm vẫn khớp", () => {
    const filesystem = { matchType: "command" as const, pattern: "npx @modelcontextprotocol/server-filesystem" };
    expect(ruleMatches(filesystem, fs)).toBe(true);
    expect(ruleMatches(filesystem, gh)).toBe(false);
    expect(ruleMatches({ matchType: "command", pattern: "npx @modelcontextprotocol/server-github" }, gh)).toBe(true);
    expect(ruleMatches({ matchType: "command", pattern: "/usr/local/bin/npx" }, gh)).toBe(true);
    expect(ruleMatches({ matchType: "command", pattern: "/opt/npx" }, gh)).toBe(false);
    expect(ruleMatches({ matchType: "command", pattern: "npx @modelcontextprotocol/*" }, fs)).toBe(true);
    expect(ruleMatches({ matchType: "command", pattern: "npx /tmp -y" }, fs)).toBe(false);
    expect(
      ruleMatches(
        { matchType: "command", pattern: "npx server-x" },
        identityOf("x", stdio("C:\\nodejs\\npx.cmd", "server-x")),
      ),
    ).toBe(true);
    expect(ruleMatches({ matchType: "command", pattern: "npx" }, ctx)).toBe(false);
  });

  it("wildcard: khớp mọi server", () => {
    for (const s of [fs, gh, ctx]) expect(ruleMatches({ matchType: "wildcard", pattern: "*" }, s)).toBe(true);
  });
});

describe("thứ tự ưu tiên", () => {
  const gh = identityOf("GitHub", stdio("npx", "@modelcontextprotocol/server-github"));

  it("chặn thắng cho phép giữa các quy tắc cụ thể, bất kể thứ tự tạo", () => {
    const allow = rule("GitHub", "allow", "name", "github");
    const deny = rule("Chặn npx", "deny", "command", "npx @modelcontextprotocol/*");
    expect(decide([allow, deny], gh)).toEqual({ allowed: false, by: deny });
    expect(decide([deny, allow], gh)).toEqual({ allowed: false, by: deny });
  });

  it("* chặn chỉ áp cho server không khớp quy tắc cụ thể nào", () => {
    const everything = rule("Mọi server khác", "deny", "wildcard", "*");
    const allow = rule("GitHub", "allow", "name", "github");
    expect(decide([everything, allow], gh)).toEqual({ allowed: true, by: allow });
    expect(decide([everything, allow], identityOf("Shell", stdio("bash")))).toEqual({
      allowed: false,
      by: everything,
    });
  });

  it("* cho phép bị * chặn đè; không quy tắc nào khớp thì chặn", () => {
    const allowAll = rule("Tất cả", "allow", "wildcard", "*");
    const denyAll = rule("Không gì cả", "deny", "wildcard", "*");
    expect(decide([allowAll], gh).allowed).toBe(true);
    expect(decide([allowAll, denyAll], gh)).toEqual({ allowed: false, by: denyAll });
    expect(decide([], gh)).toEqual({ allowed: false, by: null });
    expect(decide([rule("GitLab", "allow", "name", "gitlab")], gh)).toEqual({ allowed: false, by: null });
  });
});

describe("server phát xuống run", () => {
  const github = rule("GitHub", "allow", "name", "github", {
    launch: stdio("npx", "-y", "@modelcontextprotocol/server-github"),
  });
  const filesystem = rule("Filesystem", "allow", "command", "npx @modelcontextprotocol/server-filesystem", {
    launch: stdio("npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"),
    projectId: PROJECT,
  });
  const orgDenyFs = rule("Filesystem", "deny", "command", "npx @modelcontextprotocol/server-filesystem");
  const playwright = rule("Playwright", "allow", "command", "npx @playwright/mcp", {
    launch: stdio("npx", "@playwright/mcp@latest"),
    projectId: PROJECT,
  });
  const figma = rule("Figma", "allow", "url", "https://mcp.figma.com/*", {
    launch: http("https://mcp.figma.com/mcp"),
    projectId: OTHER,
  });
  const everythingElse = rule("Mọi server khác", "deny", "wildcard", "*");
  const all = [github, filesystem, orgDenyFs, playwright, figma, everythingElse];

  it("tổ chức chỉ thấy định nghĩa và quy tắc của tổ chức", () => {
    const out = resolveServers(all, null);
    expect(out.map((s) => [s.key, s.decision.allowed])).toEqual([["github", true]]);
  });

  it("dự án cộng quy tắc của mình nhưng không vượt quy tắc chặn của tổ chức", () => {
    const out = resolveServers(all, PROJECT);
    expect(out.map((s) => [s.key, s.decision.allowed, s.decision.by?.id])).toEqual([
      ["filesystem", false, orgDenyFs.id],
      ["github", true, github.id],
      ["playwright", true, playwright.id],
    ]);
    expect(jobServers(out)).toEqual([
      { name: "github", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      { name: "playwright", transport: "stdio", command: "npx", args: ["@playwright/mcp@latest"] },
    ]);
  });

  it("quy tắc chặn của dự án chỉ áp cho dự án đó", () => {
    const denyGithub = rule("GitHub", "deny", "name", "github", { projectId: OTHER });
    expect(resolveServers([...all, denyGithub], OTHER).map((s) => [s.key, s.decision.allowed])).toEqual([
      ["figma", true],
      ["github", false],
    ]);
    expect(resolveServers([...all, denyGithub], PROJECT).find((s) => s.key === "github")?.decision.allowed).toBe(true);
  });

  it("dòng chặn có cấu hình vẫn hiện trong xem trước nhưng không phát; dự án định nghĩa lại thì thay tổ chức", () => {
    const disabled = rule("Sentry", "deny", "name", "sentry", { launch: http("https://mcp.sentry.dev/mcp") });
    const orgCtx = rule("Context7", "allow", "name", "context7", { launch: http("https://org.example/mcp") });
    const projectCtx = rule("context7", "allow", "name", "context7", {
      launch: http("https://project.example/mcp"),
      projectId: PROJECT,
    });
    const out = resolveServers([disabled, orgCtx, projectCtx], PROJECT);
    expect(out.map((s) => [s.key, s.decision.allowed])).toEqual([
      ["context7", true],
      ["sentry", false],
    ]);
    expect(jobServers(out)).toEqual([{ name: "context7", transport: "http", url: "https://project.example/mcp" }]);
    expect(resolveServers([disabled, orgCtx, projectCtx], null)[0]?.launch).toEqual(http("https://org.example/mcp"));
  });

  it("không bao giờ phát server trùng tên cổng MCP của hub", () => {
    const hub = rule("xDev Hive", "allow", "wildcard", "*", { launch: http("https://evil.example/mcp") });
    expect(resolveServers([hub], null)).toEqual([]);
  });
});
