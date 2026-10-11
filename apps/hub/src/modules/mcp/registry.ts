import type { z } from "zod";
import type { Tx } from "../platform/index.ts";
import type { McpPrincipal } from "./principal.ts";

/** Tổ chức người dùng đang là thành viên hoạt động, dùng để chọn tổ chức cho lời gọi tool. */
export interface McpOrgMembership {
  id: string;
  slug: string;
  name: string;
}

export interface McpToolContext {
  /** Transaction withTenant của tổ chức đã chọn; tool và audit cùng commit hoặc cùng rollback. */
  tx: Tx;
  orgId: string;
  principal: McpPrincipal;
}

export interface McpTool<Input extends z.ZodObject = z.ZodObject, Prepared = undefined> {
  /** Tên duy nhất trên cổng, dạng `<nhóm>_<động từ>`; action audit là `mcp.<name>`. */
  name: string;
  title?: string | undefined;
  description: string;
  input: Input;
  /** Tool bổ sung chỉ cho các loại run này; loại run lấy từ database, không từ tham số client. */
  runKinds?: readonly string[] | undefined;
  /** Tool chỉ đọc; client MCP dùng gợi ý này để khỏi hỏi người dùng trước khi gọi. */
  readOnly?: boolean | undefined;
  /**
   * Chạy trước handler, ngoài transaction, sau khi đã chọn tổ chức. Dành cho việc chờ mạng (vd. gọi API embeddings)
   * để không giữ kết nối database trong lúc chờ; kết quả truyền vào handler.
   */
  prepare?: ((args: z.infer<Input>) => Promise<Prepared>) | undefined;
  handler: (args: z.infer<Input>, ctx: McpToolContext, prepared: Prepared) => Promise<unknown>;
}

/**
 * Danh sách tool của cổng MCP. Mỗi module tự đăng ký tool qua hàm `registerMcpTools(registry)` trong index.ts của
 * nó, nên module mcp không phải import vào bên trong module nào.
 */
export class McpToolRegistry {
  readonly #tools = new Map<string, McpTool<z.ZodObject, unknown>>();
  #memberships: ((tx: Tx, userId: string) => Promise<McpOrgMembership[]>) | undefined;

  register<Input extends z.ZodObject, Prepared = undefined>(tool: McpTool<Input, Prepared>): void {
    if (this.#tools.has(tool.name)) throw new Error(`Tool MCP "${tool.name}" đã được đăng ký.`);
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new Error(`Tên tool MCP không hợp lệ: "${tool.name}".`);
    if ("org" in tool.input.shape) throw new Error(`Tool MCP "${tool.name}" không được tự khai báo tham số org.`);
    this.#tools.set(tool.name, tool as unknown as McpTool<z.ZodObject, unknown>);
  }

  /**
   * Module tenancy cung cấp cách tra tư cách thành viên. Đảo phụ thuộc như vậy để mcp không import tenancy (tenancy
   * đã import mcp để đăng ký tool, import ngược sẽ thành vòng tròn).
   */
  provideMemberships(fn: (tx: Tx, userId: string) => Promise<McpOrgMembership[]>): void {
    this.#memberships = fn;
  }

  memberships(tx: Tx, userId: string): Promise<McpOrgMembership[]> {
    if (!this.#memberships) throw new Error("Chưa có module nào cung cấp danh sách tổ chức cho cổng MCP.");
    return this.#memberships(tx, userId);
  }

  list(principal?: McpPrincipal): McpTool<z.ZodObject, unknown>[] {
    const tools = [...this.#tools.values()];
    if (!principal || principal.kind === "user") return tools;
    return tools.filter(
      (tool) =>
        RUN_TOOLS.has(tool.name) || (principal.runKind !== undefined && tool.runKinds?.includes(principal.runKind)),
    );
  }
}

const RUN_TOOLS = new Set([
  "task_get",
  "task_update",
  "memory_search",
  "doc_get",
  "doc_list",
  "skill_get",
  "skill_list",
]);
