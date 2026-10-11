/**
 * Ai đang gọi cổng MCP. Hai nguồn token (OAuth của người dùng, run token của agent trong run) đổi về cùng một dạng
 * để tool không phải biết token đến từ đâu.
 */
export interface McpPrincipal {
  kind: "user" | "run";
  userId: string;
  /** Run token gắn sẵn một tổ chức; người dùng OAuth thì chọn tổ chức theo từng lời gọi. */
  orgId?: string | undefined;
  runId?: string | undefined;
  runKind?: string | undefined;
  /** Task của run và lần thử token được cấp cho; tool dựa vào hai trường này để chỉ sửa đúng task của run. */
  taskId?: string | undefined;
  attempt?: number | undefined;
  /** Client OAuth đã xin token (hoặc định danh của run); ghi vào audit để biết lời gọi đến từ CLI nào. */
  clientId?: string | undefined;
  scopes: string[];
}

/**
 * Kiểm run token (JWT hub cấp cùng lease, `aud=/mcp`). Trả null nếu token không phải run token hoặc không hợp lệ,
 * để cổng thử tiếp đường OAuth. Module runs sẽ cài bản thật.
 */
export interface RunTokenVerifier {
  verify(token: string): Promise<McpPrincipal | null>;
}

/** Chưa có module runs: không nhận run token nào. */
export const noRunTokens: RunTokenVerifier = { verify: async () => null };
