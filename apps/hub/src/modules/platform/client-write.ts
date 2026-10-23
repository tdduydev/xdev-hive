import { CLIENT_EVENT_HEADERS } from "@xdev-hive/contracts";
import type pg from "pg";
import { type ClientEventMeta, ClientEventRejected, withClientEvent } from "./client-events.ts";
import { INVALID_KEY_MESSAGE, noteMissingKey, readClientRequest } from "./client-request.ts";
import { type Tx, withTenant } from "./db.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./errors.ts";

/** Lỗi do lần ghi ném vì trạng thái hiện tại: với lần ghi có khoá thì lưu thành lần từ chối, gửi lại nhận đúng lỗi đó. */
export function rejectionOf(error: unknown): ClientEventRejected | null {
  if (
    error instanceof ForbiddenError ||
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof BadRequestError
  ) {
    return new ClientEventRejected(error.code, error.message);
  }
  return null;
}

export interface ClientWriteRequest {
  headers: Headers;
  /** Từ `ResponseHeadersPlugin`; thiếu (vd. gọi thẳng router trong test) thì không đặt header kết quả. */
  resHeaders?: Headers | undefined;
}

/**
 * Thủ tục oRPC có ghi (specs/027 FR-001): có `Idempotency-Key` thì chạy đúng một lần qua `withClientEvent` và trả
 * header `Hive-Client-Event`; không có khoá thì chạy như client cũ (FR-005). Tự mở transaction nên thủ tục dùng
 * middleware `orgMember`, không dùng `inOrg`.
 *
 * Máy client khai không được giữ ở đây: module gọi không import fleet, và client oRPC hiện chỉ là web và desktop.
 */
export async function runClientWrite<T>(
  pool: pg.Pool,
  tenant: { userId: string; orgId: string },
  request: ClientWriteRequest,
  kind: string,
  fn: (tx: Tx) => Promise<T>,
  target: Pick<ClientEventMeta, "targetType" | "targetId"> = {},
): Promise<T> {
  const client = readClientRequest(request.headers);
  // Chạy như client cũ khi khoá sai dạng thì lần gửi lại sẽ ghi thêm một lần nữa.
  if (client.invalidKey) throw new BadRequestError("IDEMPOTENCY_KEY_INVALID", INVALID_KEY_MESSAGE);
  if (!client.key) {
    noteMissingKey(kind, client.client);
    return withTenant(pool, tenant, fn);
  }
  let original: unknown;
  const { response, ...event } = await withClientEvent(
    pool,
    tenant,
    {
      key: client.key,
      source: client.source,
      kind,
      userId: tenant.userId,
      clientCreatedAt: client.clientCreatedAt,
      ...target,
    },
    async (tx) => {
      try {
        return await fn(tx);
      } catch (error) {
        const rejected = rejectionOf(error);
        if (!rejected) throw error;
        original = error;
        throw rejected;
      }
    },
  );
  request.resHeaders?.set(CLIENT_EVENT_HEADERS.result, asciiJson(event));
  // Lần đầu bị từ chối giữ đúng lỗi (và mã HTTP) như client cũ thấy; lần gửi lại chỉ còn mã đã lưu nên trả 409.
  if (event.code) throw original ?? new ConflictError(event.code, event.reason ?? "Hub không nhận lần ghi này.");
  return response as T;
}

// Giá trị header chỉ nhận ByteString; lý do từ chối tiếng Việt làm `Headers.set` ném lỗi. Escape `\uXXXX` vẫn là JSON
// hợp lệ nên client không phải giải mã thêm.
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
