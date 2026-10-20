// Client Argo CD thuần trên fetch (plan.md mục 6). Không đụng DB: bên gọi truyền địa chỉ và token của kết nối hạ tầng.
// Đường dẫn và dạng JSON theo tài liệu công khai của Argo CD (API `/api/v1/applications`) [Suy luận]; T007 chưa kiểm
// với Argo CD thật (cách xác thực, quyền `sync`, `rollback` của token).

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ArgoCdErrorCode =
  | "UNAUTHORIZED"
  // Argo CD trả 403 cả khi token thiếu quyền RBAC lẫn khi ứng dụng không tồn tại hoặc không thấy được [Suy luận].
  | "FORBIDDEN"
  | "NOT_FOUND"
  // Hết giờ, không nối được, 5xx, 429, hoặc phản hồi không đọc được.
  | "UNAVAILABLE"
  // Các lỗi 4xx còn lại: đang có thao tác khác, rollback khi bật autoSync, tham số sai. Thông điệp của Argo CD đi kèm.
  | "BAD_REQUEST";

export class ArgoCdError extends Error {
  override readonly name = "ArgoCdError";
  readonly code: ArgoCdErrorCode;
  readonly status: number | null;

  constructor(code: ArgoCdErrorCode, message: string, opts: { status?: number | null; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    this.status = opts.status ?? null;
  }

  /** Thử lại sau có thể được; các mã còn lại cần người sửa token, quyền hoặc tham số. */
  get retryable(): boolean {
    return this.code === "UNAVAILABLE";
  }
}

export interface ArgoCdConnection {
  /** Địa chỉ gốc, có thể kèm đường dẫn gốc khi Argo CD chạy sau proxy (`https://host/argocd`). */
  baseUrl: string;
  /** Token của account (gửi dạng Bearer). Chỉ nằm trong closure của client. */
  token: string;
  fetch?: FetchLike;
  /** Hạn cho mỗi lời gọi HTTP, mặc định 15 giây. */
  timeoutMs?: number;
}

export interface ArgoCdVersion {
  version: string;
  buildDate: string | null;
  gitCommit: string | null;
}

export interface ArgoHistoryEntry {
  id: number;
  revision: string;
  deployedAt: string | null;
  deployStartedAt: string | null;
}

export interface ArgoOperation {
  /** `Running`, `Succeeded`, `Failed`, `Error`, `Terminating`. */
  phase: string;
  message: string | null;
  /** Revision mà lần sync này đã áp dụng (có khi chưa có lúc đang chạy). */
  revision: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ArgoApplication {
  name: string;
  project: string | null;
  /** Namespace đích trong cụm Kubernetes. */
  destinationNamespace: string | null;
  source: { repoUrl: string; path: string | null; targetRevision: string | null } | null;
  /** `Synced`, `OutOfSync`, `Unknown`. */
  syncStatus: string;
  /** Revision của lần so sánh gần nhất (`status.sync.revision`). */
  revision: string | null;
  /** `Healthy`, `Progressing`, `Degraded`, `Suspended`, `Missing`, `Unknown`. */
  healthStatus: string;
  healthMessage: string | null;
  images: string[];
  /** Rollback bị Argo CD từ chối khi autoSync bật, nên bên gọi cần biết để cảnh báo. */
  autoSync: boolean;
  /** Thao tác sync gần nhất; `null` khi chưa từng sync. */
  operation: ArgoOperation | null;
  /** Lịch sử triển khai, mới nhất đứng đầu. */
  history: ArgoHistoryEntry[];
}

export interface ArgoApplicationList {
  /** Tối đa `limit`, xếp theo tên. */
  items: ArgoApplication[];
  /** Tổng số ứng dụng token này thấy được. */
  total: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_DETAIL = 300;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function toHistory(raw: unknown): ArgoHistoryEntry | null {
  const h = rec(raw);
  const id = h.id;
  if (typeof id !== "number" || !Number.isInteger(id)) return null;
  return {
    id,
    revision: str(h.revision) ?? "",
    deployedAt: str(h.deployedAt),
    deployStartedAt: str(h.deployStartedAt),
  };
}

function toOperation(raw: unknown): ArgoOperation | null {
  if (!isRecord(raw)) return null;
  const phase = str(raw.phase);
  if (phase === null) return null;
  // `syncResult.revision` có sau khi sync xong; lúc đang chạy chỉ có revision yêu cầu trong `operation.sync`.
  const revision = str(rec(raw.syncResult).revision) ?? str(rec(rec(raw.operation).sync).revision);
  return {
    phase,
    message: str(raw.message),
    revision,
    startedAt: str(raw.startedAt),
    finishedAt: str(raw.finishedAt),
  };
}

export function toApplication(raw: unknown): ArgoApplication {
  const app = rec(raw);
  const spec = rec(app.spec);
  const status = rec(app.status);
  const sync = rec(status.sync);
  const health = rec(status.health);
  // `spec.source` (một nguồn) hoặc `spec.sources[0]` (nhiều nguồn).
  const rawSource = isRecord(spec.source) ? spec.source : rec(arr(spec.sources)[0]);
  const repoUrl = str(rawSource.repoURL);

  const history = arr(status.history)
    .map(toHistory)
    .filter((h): h is ArgoHistoryEntry => h !== null)
    .sort((a, b) => b.id - a.id);

  return {
    name: str(rec(app.metadata).name) ?? "",
    project: str(spec.project),
    destinationNamespace: str(rec(spec.destination).namespace),
    source:
      repoUrl === null ? null : { repoUrl, path: str(rawSource.path), targetRevision: str(rawSource.targetRevision) },
    syncStatus: str(sync.status) ?? "Unknown",
    revision: str(sync.revision),
    healthStatus: str(health.status) ?? "Unknown",
    healthMessage: str(health.message),
    images: arr(rec(status.summary).images).filter((i): i is string => typeof i === "string"),
    // Có khối `automated` (kể cả rỗng) là autoSync bật.
    autoSync: isRecord(rec(spec.syncPolicy).automated),
    operation: toOperation(status.operationState),
    history,
  };
}

function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("baseUrl của Argo CD không phải URL hợp lệ");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new TypeError("baseUrl của Argo CD phải là http hoặc https");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Tên ứng dụng đi vào đường dẫn: mã hoá, và chặn tên rỗng hoặc chứa `/` (lỗi của người gọi, không phải của Argo CD). */
function appPath(name: string): string {
  if (name === "" || name.includes("/") || name === "." || name === "..") {
    throw new TypeError(`Tên ứng dụng Argo CD không hợp lệ: ${JSON.stringify(name)}`);
  }
  return `/api/v1/applications/${encodeURIComponent(name)}`;
}

export function createArgoCdClient(conn: ArgoCdConnection) {
  const root = parseBaseUrl(conn.baseUrl);
  const doFetch: FetchLike = conn.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = conn.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Chỉ nằm trong closure này: không đưa vào lỗi, không log, không để lộ ra ngoài client.
  const authorization = `Bearer ${conn.token}`;

  /** Thông điệp của Argo CD đi vào lỗi chỉ sau khi cắt ngắn và che token, phòng máy chủ lặp lại thứ nó nhận. */
  function scrub(text: string): string {
    const clean = conn.token === "" ? text : text.split(conn.token).join("***");
    return clean.length > MAX_ERROR_DETAIL ? `${clean.slice(0, MAX_ERROR_DETAIL)}…` : clean;
  }

  async function request(path: string, opts: { method?: "GET" | "POST"; json?: unknown } = {}): Promise<Response> {
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = { authorization, accept: "application/json" };
    if (opts.json !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await doFetch(`${root}${path}`, {
        method,
        headers,
        ...(opts.json === undefined ? {} : { body: JSON.stringify(opts.json) }),
        // 3xx là chuyển về đăng nhập SSO: phải thấy được, không đi theo.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw networkError(e, timeoutMs);
    }

    if (res.status >= 200 && res.status < 300) return res;
    if (res.status >= 300 && res.status < 400) {
      await drain(res);
      throw errorFor(401, "");
    }
    const text = await res.text().catch(() => "");
    throw errorFor(res.status, scrub(serverMessage(text)));
  }

  async function json(path: string, opts: { method?: "GET" | "POST"; json?: unknown } = {}): Promise<unknown> {
    return parseJson(await request(path, opts));
  }

  return {
    /** `GET /api/version` không đòi đăng nhập ở nhiều bản Argo CD [Suy luận]: chỉ chứng minh nối được, không chứng minh token. */
    async version(): Promise<ArgoCdVersion> {
      const v = rec(await json("/api/version"));
      return { version: str(v.Version) ?? "", buildDate: str(v.BuildDate), gitCommit: str(v.GitCommit) };
    },

    /** Argo CD không phân trang danh sách ứng dụng [Suy luận]: lấy hết, xếp theo tên rồi cắt `limit`. */
    async listApplications(limit: number): Promise<ArgoApplicationList> {
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit phải là số nguyên dương");
      const raw = rec(await json("/api/v1/applications"));
      const all = arr(raw.items)
        .map(toApplication)
        .sort((a, b) => a.name.localeCompare(b.name));
      return { items: all.slice(0, limit), total: all.length };
    },

    async getApplication(name: string): Promise<ArgoApplication> {
      return toApplication(await json(appPath(name)));
    },

    /** Bắt đầu sync; trả ứng dụng ngay sau khi nhận lệnh (kết quả theo dõi bằng `getApplication`). */
    async sync(name: string, revision?: string): Promise<ArgoApplication> {
      const body = revision === undefined ? {} : { revision };
      return toApplication(await json(`${appPath(name)}/sync`, { method: "POST", json: body }));
    },

    /** Argo CD từ chối khi autoSync đang bật (BAD_REQUEST); bên gọi kiểm `autoSync` trước để báo người dùng. */
    async rollback(name: string, historyId: number): Promise<ArgoApplication> {
      if (!Number.isInteger(historyId) || historyId < 0) throw new TypeError("historyId phải là số nguyên không âm");
      return toApplication(await json(`${appPath(name)}/rollback`, { method: "POST", json: { id: historyId } }));
    },
  };
}

export type ArgoCdClient = ReturnType<typeof createArgoCdClient>;

async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    // Đã đọc hoặc kết nối đứt: không còn gì để giải phóng.
  }
}

/** Argo CD trả lỗi dạng `{ "error": "...", "code": 7, "message": "..." }`; không phải JSON thì lấy nguyên văn. */
function serverMessage(text: string): string {
  try {
    const j: unknown = JSON.parse(text);
    if (isRecord(j)) return str(j.message) ?? str(j.error) ?? "";
  } catch {
    // Không phải JSON (proxy trả HTML): dùng nguyên văn.
  }
  return text.trim();
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ArgoCdError(
      "UNAVAILABLE",
      "Argo CD trả về nội dung không phải JSON (có thể là trang đăng nhập hoặc proxy chặn). Kiểm tra URL kết nối Argo CD.",
      { status: res.status, cause: e },
    );
  }
}

function networkError(e: unknown, timeoutMs: number): ArgoCdError {
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new ArgoCdError(
      "UNAVAILABLE",
      `Argo CD không trả lời trong ${Math.round(timeoutMs / 1000)} giây. Thử lại sau, hoặc kiểm tra mạng từ máy chủ Hive tới Argo CD.`,
      { cause: e },
    );
  }
  return new ArgoCdError(
    "UNAVAILABLE",
    "Không kết nối được tới Argo CD. Kiểm tra URL kết nối và mạng từ máy chủ Hive.",
    { cause: e },
  );
}

function errorFor(status: number, detail: string): ArgoCdError {
  if (status === 401) {
    return new ArgoCdError(
      "UNAUTHORIZED",
      "Argo CD từ chối token. Kiểm tra token trong kết nối Argo CD; token có thể đã hết hạn hoặc bị thu hồi.",
      { status },
    );
  }
  if (status === 403) {
    return new ArgoCdError(
      "FORBIDDEN",
      "Token Argo CD không đủ quyền cho thao tác này, hoặc ứng dụng không tồn tại. Nhờ quản trị Argo CD cấp quyền (get, sync, rollback) cho account.",
      { status },
    );
  }
  if (status === 404) {
    return new ArgoCdError("NOT_FOUND", "Argo CD không tìm thấy ứng dụng này. Kiểm tra tên ứng dụng.", { status });
  }
  if (status >= 500 || status === 429 || status === 408) {
    return new ArgoCdError("UNAVAILABLE", `Argo CD đang lỗi hoặc quá tải (HTTP ${status}). Thử lại sau.`, { status });
  }
  const why = detail === "" ? "" : `: ${detail}`;
  return new ArgoCdError("BAD_REQUEST", `Argo CD từ chối yêu cầu (HTTP ${status})${why}`, { status });
}
