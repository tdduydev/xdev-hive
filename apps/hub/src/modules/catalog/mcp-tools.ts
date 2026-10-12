import { projectRef } from "@xdev-hive/contracts";
import { z } from "zod";
import { type McpToolRegistry, mcpServersForProject } from "../mcp/index.ts";
import { NotFoundError } from "../platform/index.ts";
import { listProjects } from "./projects.ts";

/**
 * Tool chỉ đọc về dự án. App desktop dùng nó để nhận ra thư mục đang mở là dự án nào (so remote git với repo của dự
 * án), agent dùng để biết key dự án khi gọi tool khác.
 */
export function registerMcpTools(registry: McpToolRegistry): void {
  registry.register({
    name: "project_list",
    title: "Danh sách dự án",
    description: "Liệt kê dự án bạn thấy được trong tổ chức (đội mình có vai trò), kèm repo Git của từng dự án.",
    input: z.object({}),
    readOnly: true,
    handler: async (_args, { tx, principal }) => ({
      projects: (await listProjects(tx, principal.userId)).map((p) => ({
        key: p.key,
        name: p.name,
        state: p.state,
        repo: {
          kind: p.repo.kind,
          owner: p.repo.owner,
          name: p.repo.name,
          httpUrl: p.repo.httpUrl,
          sshUrl: p.repo.sshUrl,
          webUrl: p.repo.webUrl,
        },
      })),
    }),
  });

  registry.register({
    name: "mcp_server_list",
    title: "MCP server được phép",
    description:
      "Liệt kê MCP server ngoài mà tổ chức cho phép dùng với dự án, kèm cấu hình khởi chạy để cài vào CLI trên máy.",
    input: z.object({ project: projectRef.describe("Project key.") }),
    readOnly: true,
    // App desktop (màn Môi trường) so danh sách này với MCP server đã khai trong Claude Code, Codex trên máy.
    handler: async ({ project }, { tx, principal }) => {
      const found = (await listProjects(tx, principal.userId)).find((p) => p.key === project);
      if (!found) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
      return { servers: await mcpServersForProject(tx, found.id) };
    },
  });
}
