import type { GitProviderKind } from "./types.ts";

export type GitProviderErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "invalid"
  | "position_invalid"
  | "unsupported";

export class GitProviderError extends Error {
  override readonly name = "GitProviderError";
  readonly code: GitProviderErrorCode;
  readonly status: number | null;
  /** Chỉ có khi nhà cung cấp cho biết lúc nào thử lại được (Retry-After hoặc lúc hạn mức đặt lại). */
  readonly retryAfterMs: number | null;
  readonly missingScopes: string[];

  constructor(
    code: GitProviderErrorCode,
    message: string,
    opts: { status?: number | null; retryAfterMs?: number | null; missingScopes?: string[]; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.missingScopes = opts.missingScopes ?? [];
  }

  /** Saga dùng để quyết định thử lại hay dừng hẳn. */
  get retryable(): boolean {
    return this.code === "rate_limited" || this.code === "unavailable";
  }
}

export function isGitProviderError(e: unknown, code?: GitProviderErrorCode): e is GitProviderError {
  return e instanceof GitProviderError && (code === undefined || e.code === code);
}

type HeaderBag = Headers | Record<string, string | number | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
  // Không dùng instanceof: Headers của gói undici và của fetch có sẵn trong Node là hai lớp khác nhau.
  if (typeof headers.get === "function") return (headers as Headers).get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : (headers as Record<string, string | number | undefined>)[key];
  return v === undefined ? undefined : String(v);
}

/** Retry-After là số giây hoặc ngày HTTP (RFC 9110 mục 10.2.3). */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function retryAfterMs(headers: HeaderBag, now: number): number | null {
  const fromHeader = parseRetryAfter(header(headers, "retry-after"), now);
  if (fromHeader !== null) return fromHeader;
  // Hết hạn mức chính không kèm Retry-After; chỉ có lúc đặt lại (epoch giây).
  // GitHub dùng x-ratelimit-reset, GitLab dùng ratelimit-reset.
  const reset = header(headers, "x-ratelimit-reset") ?? header(headers, "ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) return Math.max(0, Number(reset) * 1000 - now);
  return null;
}

const label: Record<GitProviderKind, string> = { github: "GitHub", gitlab: "GitLab" };

const messages: Record<GitProviderErrorCode, string> = {
  unauthorized: "token không hợp lệ hoặc đã hết hạn",
  forbidden: "không đủ quyền",
  not_found: "không tìm thấy",
  conflict: "xung đột với dữ liệu đang có",
  rate_limited: "vượt giới hạn số lần gọi, thử lại sau",
  unavailable: "dịch vụ tạm thời không phản hồi",
  invalid: "yêu cầu không hợp lệ",
  position_invalid: "dòng không thuộc phần thay đổi của PR",
  unsupported: "thao tác không được hỗ trợ",
};

/** Đổi phản hồi HTTP lỗi thành GitProviderError, dùng chung cho GitHub và GitLab. */
export function errorFromResponse(
  kind: GitProviderKind,
  status: number,
  headers: HeaderBag,
  detail?: string,
  now = Date.now(),
): GitProviderError {
  const wait = retryAfterMs(headers, now);
  // GitHub báo hết hạn mức bằng 403 (không phải 429), nhận ra qua remaining = 0 hoặc có Retry-After.
  const limited =
    status === 429 || (status === 403 && (header(headers, "x-ratelimit-remaining") === "0" || wait !== null));
  let code: GitProviderErrorCode;
  if (limited) code = "rate_limited";
  else if (status === 401) code = "unauthorized";
  else if (status === 403) code = "forbidden";
  else if (status === 404 || status === 410) code = "not_found";
  else if (status === 409) code = "conflict";
  else if (status === 400 || status === 405 || status === 422) code = "invalid";
  else if (status >= 500 || status === 408) code = "unavailable";
  else code = "invalid";
  const base = `${label[kind]}: ${messages[code]}`;
  return new GitProviderError(code, detail ? `${base} (${detail})` : base, {
    status,
    retryAfterMs: limited ? wait : null,
  });
}

export function networkError(kind: GitProviderKind, cause: unknown): GitProviderError {
  return new GitProviderError("unavailable", `${label[kind]}: không kết nối được`, { cause });
}
