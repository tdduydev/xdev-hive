import { describe, expect, it } from "vitest";
import { renderTemplate } from "./template.ts";

const input = {
  projectKey: "hoa-don-xuat-file",
  projectName: "Xuất file hoá đơn",
  publicUrl: "https://hive.xdev.asia/",
  defaultBranch: "main",
  systemName: "Hoá đơn",
};

describe("mẫu xdev-standard", () => {
  const files = renderTemplate(input);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));

  it("có đủ bốn file", () => {
    expect(files.map((f) => f.path)).toEqual(["AGENTS.md", "CLAUDE.md", ".mcp.json", "README.md"]);
  });

  it("AGENTS.md ghi project key", () => {
    expect(byPath["AGENTS.md"]).toContain("Hive project key: `hoa-don-xuat-file`");
  });

  it("CLAUDE.md chỉ trỏ tới AGENTS.md", () => {
    expect(byPath["CLAUDE.md"]).toBe("@AGENTS.md\n");
  });

  it(".mcp.json là JSON hợp lệ, trỏ tới /mcp của hub, token đọc từ biến môi trường", () => {
    const mcp = JSON.parse(byPath[".mcp.json"] ?? "");
    expect(mcp.mcpServers["xdev-hive"].url).toBe("https://hive.xdev.asia/mcp");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: so đúng chuỗi biến môi trường trong .mcp.json.
    expect(mcp.mcpServers["xdev-hive"].headers.Authorization).toBe("Bearer ${HIVE_MCP_TOKEN}");
  });

  it("cùng đầu vào cho cùng kết quả", () => {
    expect(renderTemplate(input)).toEqual(files);
  });

  it("snapshot", () => {
    expect(byPath).toMatchSnapshot();
  });
});
