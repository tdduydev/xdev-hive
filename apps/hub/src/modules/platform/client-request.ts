import { CLIENT_EVENT_HEADERS, type ClientSource, clientSource, idempotencyKey } from "@xdev-hive/contracts";

/** Phần sự kiện client mà client tự khai trong header của lần ghi (specs/027 contracts/client-events.md). */
export interface ClientRequest {
  /** Khoá hợp lệ; thiếu là client cũ (FR-005). */
  key?: string | undefined;
  /** Có header khoá nhưng sai dạng: lớp API từ chối, không chạy lần ghi như client cũ. */
  invalidKey: boolean;
  source: ClientSource;
  /** Máy client khai; chưa kiểm, lớp API chỉ giữ khi máy là của người gọi. */
  machineId?: string | undefined;
  clientCreatedAt?: Date | undefined;
  /** `X-Hive-Client` hay `User-Agent`, để biết phiên bản nào còn gửi thiếu khoá. */
  client?: string | undefined;
}

export const INVALID_KEY_MESSAGE = "Khoá chống trùng (Idempotency-Key) gồm 16–64 ký tự chữ, số, `_` hoặc `-`.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Đọc header sự kiện client. Không ném lỗi: header lạ bị bỏ, khoá sai dạng thì báo qua `invalidKey`. */
export function readClientRequest(headers: Headers): ClientRequest {
  const rawKey = headers.get(CLIENT_EVENT_HEADERS.key)?.trim();
  const key = rawKey ? idempotencyKey.safeParse(rawKey) : undefined;
  const source = clientSource.safeParse(headers.get(CLIENT_EVENT_HEADERS.source)?.trim());
  const machine = headers.get(CLIENT_EVENT_HEADERS.machine)?.trim();
  const created = headers.get(CLIENT_EVENT_HEADERS.createdAt)?.trim();
  const createdAt = created ? new Date(created) : undefined;
  const client = (headers.get(CLIENT_EVENT_HEADERS.client) ?? headers.get("user-agent"))?.trim().slice(0, 100);
  return {
    key: key?.success ? key.data : undefined,
    invalidKey: key !== undefined && !key.success,
    source: source.success ? source.data : "unknown",
    machineId: machine && UUID.test(machine) ? machine.toLowerCase() : undefined,
    clientCreatedAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : undefined,
    client: client || undefined,
  };
}

/** Thêm khoá ở `_meta` của `tools/call` vào phần đã đọc từ header; header thắng nếu có cả hai. */
export function withMetaKey(request: ClientRequest, metaKey: unknown): ClientRequest {
  if (request.key || request.invalidKey || metaKey === undefined) return request;
  const key = idempotencyKey.safeParse(metaKey);
  return key.success ? { ...request, key: key.data } : { ...request, invalidKey: true };
}

// Bộ đếm theo ngày, trong tiến trình: đủ để log cảnh báo một lần mỗi phiên bản client mỗi ngày (FR-005) mà không thêm
// bảng. Hub khởi động lại thì đếm lại từ đầu.
const missingKeys = new Map<string, number>();
let missingKeysDay = "";

/** Lần ghi không có khoá: ghi cảnh báo `client_event.missing_key` lần đầu trong ngày của mỗi phiên bản client. */
export function noteMissingKey(kind: string, client: string | undefined, now = new Date()): void {
  const day = now.toISOString().slice(0, 10);
  if (day !== missingKeysDay) {
    missingKeys.clear();
    missingKeysDay = day;
  }
  const id = client ?? "unknown";
  const count = (missingKeys.get(id) ?? 0) + 1;
  missingKeys.set(id, count);
  if (count === 1) console.warn("client_event.missing_key", { kind, client: id, day });
}

/** Số lần ghi thiếu khoá hôm nay theo phiên bản client. */
export function missingKeyCounts(): Record<string, number> {
  return Object.fromEntries(missingKeys);
}
