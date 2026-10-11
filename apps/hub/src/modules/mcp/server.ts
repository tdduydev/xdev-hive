import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type pg from "pg";
import { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, withTenant } from "../platform/index.ts";
import type { McpPrincipal } from "./principal.ts";
import type { McpOrgMembership, McpTool, McpToolRegistry } from "./registry.ts";

export interface McpServerDeps {
  pool: pg.Pool;
  registry: McpToolRegistry;
  version: string;
}

const ORG_PARAM = z
  .string()
  .min(1)
  .optional()
  .describe("Mã hoặc slug của tổ chức. Bắt buộc khi bạn thuộc nhiều tổ chức; xem danh sách bằng orgs_list.");

/** Lỗi trả về cho agent dưới dạng kết quả tool (isError), không phải lỗi giao thức. */
class McpToolError extends Error {}

const describe = (orgs: McpOrgMembership[]) => orgs.map((o) => `${o.slug} (${o.name})`).join(", ");

function pickOrg(orgs: McpOrgMembership[], requested: string | undefined): McpOrgMembership {
  if (requested) {
    const found = orgs.find((o) => o.id === requested || o.slug === requested);
    if (!found) throw new McpToolError(`Bạn không phải thành viên của tổ chức "${requested}".`);
    return found;
  }
  const [only, ...rest] = orgs;
  if (!only) throw new McpToolError("Bạn chưa thuộc tổ chức nào trên hub.");
  if (rest.length > 0)
    throw new McpToolError(`Bạn thuộc nhiều tổ chức, hãy truyền tham số org. Các tổ chức: ${describe(orgs)}.`);
  return only;
}

/**
 * Chạy một tool trong withTenant của tổ chức thuộc principal, rồi ghi audit trong cùng transaction. Lời gọi bị từ
 * chối trước khi chọn được tổ chức thì không có dòng audit, vì audit_log luôn thuộc một tổ chức.
 */
async function runTool(deps: McpServerDeps, principal: McpPrincipal, tool: McpTool, raw: Record<string, unknown>) {
  const { org, ...args } = raw as { org?: string } & Record<string, unknown>;
  const { pool, registry } = deps;
  let orgId: string;
  if (principal.kind === "run") {
    if (!principal.orgId) throw new McpToolError("Run token thiếu tổ chức.");
    if (org && org !== principal.orgId) throw new McpToolError("Run chỉ được làm việc trong tổ chức của nó.");
    orgId = principal.orgId;
  } else {
    // Chưa có tổ chức trong context: RLS chỉ cho thấy tư cách thành viên của chính người gọi.
    const orgs = await withTenant(pool, { userId: principal.userId }, (tx) =>
      registry.memberships(tx, principal.userId),
    );
    orgId = pickOrg(orgs, org).id;
  }
  return withTenant(pool, { userId: principal.userId, orgId }, async (tx) => {
    // Xét lại trong transaction sẽ chạy tool: RLS chỉ lọc theo tổ chức trong context, không theo tư cách thành viên,
    // và người dùng có thể vừa bị khoá giữa hai transaction.
    if (principal.kind === "user" && !(await registry.memberships(tx, principal.userId)).some((o) => o.id === orgId)) {
      throw new McpToolError("Bạn không còn là thành viên của tổ chức này.");
    }
    const result = await tool.handler(args, { tx, orgId, principal });
    await recordAudit(tx, {
      action: `mcp.${tool.name}`,
      targetType: "mcp_tool",
      targetId: tool.name,
      data: {
        args,
        via: principal.kind,
        clientId: principal.clientId ?? null,
        ...(principal.runId ? { runId: principal.runId } : {}),
      },
    });
    return result;
  });
}

function toResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function toError(error: unknown): CallToolResult {
  const known =
    error instanceof McpToolError ||
    error instanceof ForbiddenError ||
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof BadRequestError;
  if (!known) console.error("Tool MCP lỗi:", error);
  // Lỗi lạ có thể chứa chi tiết nội bộ (câu SQL, đường dẫn); agent chỉ cần biết là hỏng.
  const text = known ? error.message : "Lỗi nội bộ khi chạy tool. Thử lại sau hoặc báo quản trị hub.";
  return { isError: true, content: [{ type: "text", text }] };
}

/** Một McpServer cho một request: cổng chạy stateless nên mỗi request dựng server riêng, gắn sẵn principal. */
export function buildMcpServer(deps: McpServerDeps, principal: McpPrincipal): McpServer {
  const server = new McpServer({ name: "xdev-hive", version: deps.version });
  for (const tool of deps.registry.list()) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: tool.input.extend({ org: ORG_PARAM }),
        annotations: { readOnlyHint: tool.readOnly ?? false },
      },
      async (args) => {
        try {
          return toResult(await runTool(deps, principal, tool, args as Record<string, unknown>));
        } catch (error) {
          return toError(error);
        }
      },
    );
  }
  return server;
}
