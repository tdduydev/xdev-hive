// Client API Kubernetes thuần trên node:https (plan.md mục 6). Dùng node:https thay vì fetch vì cụm RKE2 có CA riêng và
// không thêm phụ thuộc (undici chỉ là devDependency). Không đụng DB: bên gọi truyền địa chỉ, CA và token ServiceAccount.
// Đường dẫn và dạng JSON theo tài liệu công khai của Kubernetes [Suy luận]; T007 chưa kiểm quyền get/patch của
// ServiceAccount trên cụm thật.
import { request as httpsRequest } from "node:https";
import { deliveryOutbound, OUTBOUND_DISABLED } from "./outbound.ts";

export type KubeErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  // Hết giờ, không nối được, 5xx, 429, hoặc phản hồi không đọc được.
  | "UNAVAILABLE"
  // Chứng chỉ máy chủ không khớp CA của kết nối: thử lại không giúp, cần sửa CA hoặc URL.
  | "TLS_ERROR"
  // Các lỗi 4xx còn lại: xung đột phiên bản, dữ liệu patch không hợp lệ, container không có trong workload.
  | "BAD_REQUEST";

export class KubeError extends Error {
  override readonly name = "KubeError";
  readonly code: KubeErrorCode;
  readonly status: number | null;

  constructor(code: KubeErrorCode, message: string, opts: { status?: number | null; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    this.status = opts.status ?? null;
  }

  /** Thử lại sau có thể được; các mã còn lại cần người sửa token, quyền, CA hoặc tham số. */
  get retryable(): boolean {
    return this.code === "UNAVAILABLE";
  }
}

export interface KubeConnection {
  /** Địa chỉ API server (`https://10.0.0.1:6443`), có thể kèm đường dẫn gốc khi đi qua proxy. Chỉ nhận https. */
  baseUrl: string;
  /** Token ServiceAccount (gửi dạng Bearer). Chỉ nằm trong closure của client. */
  token: string;
  /** CA (PEM) của cụm. Thiếu thì dùng kho CA của hệ điều hành; luôn kiểm chứng chỉ, không có chế độ bỏ qua. */
  ca?: string;
  /** Hạn cho mỗi lời gọi, mặc định 15 giây. */
  timeoutMs?: number;
}

export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";

export interface KubeVersion {
  gitVersion: string;
  major: string;
  minor: string;
  platform: string | null;
}

export interface WorkloadContainer {
  name: string;
  image: string;
}

export interface Workload {
  kind: WorkloadKind;
  namespace: string;
  name: string;
  generation: number;
  containers: WorkloadContainer[];
  /** Trạng thái thô đã chuẩn hoá, đủ để `computeRollout` mà không cần gọi lại API. */
  rollout: RolloutStatus;
}

export interface RolloutStatus {
  /** `complete`: đã xong; `failed`: hết hạn tiến độ; `progressing`: còn đang cập nhật. */
  state: "progressing" | "complete" | "failed";
  /** Lý do ngắn bằng tiếng Việt, dùng làm dòng log. */
  message: string;
  /** `Progressing` có `reason=ProgressDeadlineExceeded` (chỉ Deployment). */
  deadlineExceeded: boolean;
  observedGeneration: number;
  generation: number;
  replicas: number;
  updatedReplicas: number;
  availableReplicas: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
// Phản hồi lớn hơn mức này là bất thường với một workload; cắt để không ngốn bộ nhớ hub.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_DETAIL = 300;

const PLURAL: Record<WorkloadKind, string> = {
  Deployment: "deployments",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
};

// Trong gói tên DNS của Kubernetes: chặn ký tự lạ đi vào đường dẫn.
const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const TLS_CODES: ReadonlySet<string> = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function int(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) ? v : 0;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function assertName(value: string, what: string): void {
  if (value.length > 253 || !NAME_RE.test(value)) throw new TypeError(`${what} không hợp lệ: ${JSON.stringify(value)}`);
}

function assertKind(kind: string): asserts kind is WorkloadKind {
  if (!Object.hasOwn(PLURAL, kind)) throw new TypeError(`Loại workload không hỗ trợ: ${JSON.stringify(kind)}`);
}

function workloadPath(ns: string, kind: WorkloadKind, name: string): string {
  assertKind(kind);
  assertName(ns, "Namespace");
  assertName(name, "Tên workload");
  return `/apis/apps/v1/namespaces/${ns}/${PLURAL[kind]}/${name}`;
}

/**
 * Cùng quy tắc `kubectl rollout status`: chỉ "xong" khi bản mới đã được controller thấy, mọi bản sao đã cập nhật, không
 * còn bản sao cũ chờ tắt, và các bản sao mới đều sẵn sàng.
 */
export function computeRollout(kind: WorkloadKind, raw: unknown): RolloutStatus {
  const w = rec(raw);
  const spec = rec(w.spec);
  const status = rec(w.status);
  const generation = int(rec(w.metadata).generation);
  const observedGeneration = int(status.observedGeneration);
  const desired = typeof spec.replicas === "number" ? int(spec.replicas) : kind === "DaemonSet" ? 0 : 1;

  const base = { generation, observedGeneration, deadlineExceeded: false };
  const progress = (
    message: string,
    counts: Pick<RolloutStatus, "replicas" | "updatedReplicas" | "availableReplicas">,
  ) => ({ ...base, ...counts, state: "progressing", message }) satisfies RolloutStatus;

  if (kind === "DaemonSet") {
    const replicas = int(status.desiredNumberScheduled);
    const updated = int(status.updatedNumberScheduled);
    const available = int(status.numberAvailable);
    const counts = { replicas, updatedReplicas: updated, availableReplicas: available };
    if (generation > observedGeneration) return progress("Đang chờ DaemonSet nhận cấu hình mới", counts);
    if (updated < replicas) return progress(`Đã cập nhật ${updated}/${replicas} máy`, counts);
    if (available < replicas) return progress(`${available}/${replicas} máy đã sẵn sàng`, counts);
    return { ...base, ...counts, state: "complete", message: "Đã cập nhật xong" };
  }

  const updated = int(status.updatedReplicas);
  const replicas = int(status.replicas);
  // StatefulSet báo `readyReplicas`; Deployment báo `availableReplicas`.
  const available = kind === "StatefulSet" ? int(status.readyReplicas) : int(status.availableReplicas);
  const counts = { replicas, updatedReplicas: updated, availableReplicas: available };

  if (generation > observedGeneration) return progress("Đang chờ controller nhận cấu hình mới", counts);

  if (kind === "Deployment") {
    const exceeded = arr(status.conditions).some((c) => {
      const cond = rec(c);
      return cond.type === "Progressing" && cond.reason === "ProgressDeadlineExceeded";
    });
    if (exceeded) {
      return {
        ...base,
        ...counts,
        state: "failed",
        deadlineExceeded: true,
        message: "Quá hạn tiến độ (ProgressDeadlineExceeded): bản mới không sẵn sàng kịp",
      };
    }
  }

  if (updated < desired) return progress(`Đã cập nhật ${updated}/${desired} bản sao`, counts);
  if (replicas > updated) return progress(`Đang chờ ${replicas - updated} bản sao cũ tắt`, counts);
  if (available < updated) return progress(`${available}/${updated} bản sao sẵn sàng`, counts);
  if (kind === "StatefulSet" && str(status.currentRevision) !== str(status.updateRevision)) {
    return progress("Đang chờ StatefulSet chuyển sang revision mới", counts);
  }
  return { ...base, ...counts, state: "complete", message: "Đã cập nhật xong" };
}

function toWorkload(kind: WorkloadKind, raw: unknown): Workload {
  const w = rec(raw);
  const meta = rec(w.metadata);
  const containers = arr(rec(rec(rec(w.spec).template).spec).containers).flatMap((c) => {
    const name = str(rec(c).name);
    const image = str(rec(c).image);
    return name === null || image === null ? [] : [{ name, image }];
  });
  return {
    kind,
    namespace: str(meta.namespace) ?? "",
    name: str(meta.name) ?? "",
    generation: int(meta.generation),
    containers,
    rollout: computeRollout(kind, raw),
  };
}

function parseBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("baseUrl của Kubernetes không phải URL hợp lệ");
  }
  // Token ServiceAccount không được đi qua kênh không mã hoá.
  if (url.protocol !== "https:") throw new TypeError("baseUrl của Kubernetes phải là https");
  return url;
}

interface RawResponse {
  status: number;
  body: string;
}

export function createKubeClient(conn: KubeConnection) {
  const base = parseBaseUrl(conn.baseUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  const timeoutMs = conn.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Chỉ nằm trong closure này: không đưa vào lỗi, không log, không để lộ ra ngoài client.
  const authorization = `Bearer ${conn.token}`;

  function scrub(text: string): string {
    const clean = conn.token === "" ? text : text.split(conn.token).join("***");
    return clean.length > MAX_ERROR_DETAIL ? `${clean.slice(0, MAX_ERROR_DETAIL)}…` : clean;
  }

  function send(method: "GET" | "PATCH", path: string, patch?: unknown): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const payload = patch === undefined ? undefined : JSON.stringify(patch);
      const headers: Record<string, string | number> = { authorization, accept: "application/json" };
      if (payload !== undefined) {
        headers["content-type"] = "application/strategic-merge-patch+json";
        headers["content-length"] = Buffer.byteLength(payload);
      }
      const req = httpsRequest(
        {
          protocol: base.protocol,
          hostname: base.hostname.replace(/^\[|\]$/g, ""),
          port: base.port === "" ? 443 : Number(base.port),
          path: `${prefix}${path}`,
          method,
          headers,
          ...(conn.ca === undefined ? {} : { ca: conn.ca }),
          rejectUnauthorized: true,
          // Mỗi lời gọi một kết nối: tần suất thấp, và không để socket treo giữ tiến trình hub.
          agent: false,
          signal: AbortSignal.timeout(timeoutMs),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
              req.destroy(new Error("Phản hồi Kubernetes quá lớn"));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  }

  async function call(method: "GET" | "PATCH", path: string, patch?: unknown): Promise<unknown> {
    if (!deliveryOutbound()) throw new KubeError("BAD_REQUEST", OUTBOUND_DISABLED);
    let res: RawResponse;
    try {
      res = await send(method, path, patch);
    } catch (e) {
      throw networkError(e, timeoutMs);
    }
    if (res.status < 200 || res.status >= 300) throw errorFor(res.status, scrub(serverMessage(res.body)));
    try {
      return JSON.parse(res.body);
    } catch (e) {
      throw new KubeError(
        "UNAVAILABLE",
        "Kubernetes trả về nội dung không phải JSON (có thể là proxy chặn). Kiểm tra URL kết nối Kubernetes.",
        { status: res.status, cause: e },
      );
    }
  }

  async function getWorkload(ns: string, kind: WorkloadKind, name: string): Promise<Workload> {
    return toWorkload(kind, await call("GET", workloadPath(ns, kind, name)));
  }

  return {
    /**
     * `/version` mở cho người chưa đăng nhập ở cấu hình mặc định (system:public-info-viewer) [Suy luận]: chỉ chứng minh
     * nối được và tin CA, không chứng minh token. Kiểm token bằng `getWorkload`.
     */
    async version(): Promise<KubeVersion> {
      const v = rec(await call("GET", "/version"));
      return {
        gitVersion: str(v.gitVersion) ?? "",
        major: str(v.major) ?? "",
        minor: str(v.minor) ?? "",
        platform: str(v.platform),
      };
    },

    getWorkload,

    /**
     * Đổi image của một container, giữ nguyên phần còn lại. Đọc trước để (1) báo rõ khi container không có, vì
     * strategic-merge-patch sẽ *thêm* một container thiếu trường thay vì từ chối, và (2) trả image cũ cho việc quay về.
     */
    async patchImage(
      ns: string,
      kind: WorkloadKind,
      name: string,
      container: string,
      image: string,
    ): Promise<{ previousImage: string; workload: Workload }> {
      if (container === "") throw new TypeError("Tên container rỗng");
      if (image === "" || /\s/.test(image)) throw new TypeError(`Image không hợp lệ: ${JSON.stringify(image)}`);
      const before = await getWorkload(ns, kind, name);
      const current = before.containers.find((c) => c.name === container);
      if (current === undefined) {
        const have = before.containers.map((c) => c.name).join(", ");
        throw new KubeError("BAD_REQUEST", `${kind} ${ns}/${name} không có container "${container}" (có: ${have}).`);
      }
      const patch = { spec: { template: { spec: { containers: [{ name: container, image }] } } } };
      const raw = await call("PATCH", workloadPath(ns, kind, name), patch);
      return { previousImage: current.image, workload: toWorkload(kind, raw) };
    },

    async rolloutStatus(ns: string, kind: WorkloadKind, name: string): Promise<RolloutStatus> {
      return (await getWorkload(ns, kind, name)).rollout;
    },
  };
}

export type KubeClient = ReturnType<typeof createKubeClient>;

/** Kubernetes trả lỗi dạng `Status`: `{ "kind": "Status", "message": "...", "reason": "...", "code": 403 }`. */
function serverMessage(text: string): string {
  try {
    const j: unknown = JSON.parse(text);
    if (isRecord(j)) return str(j.message) ?? "";
  } catch {
    // Không phải JSON (proxy trả HTML): dùng nguyên văn.
  }
  return text.trim();
}

function networkError(e: unknown, timeoutMs: number): KubeError {
  const err = e instanceof Error ? e : new Error(String(e));
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== undefined && TLS_CODES.has(code)) {
    return new KubeError(
      "TLS_ERROR",
      "Chứng chỉ của API Kubernetes không khớp CA đã khai báo. Kiểm tra CA của kết nối và địa chỉ (chứng chỉ phải có tên hoặc IP này).",
      { cause: e },
    );
  }
  if (err.name === "TimeoutError" || err.name === "AbortError") {
    return new KubeError(
      "UNAVAILABLE",
      `API Kubernetes không trả lời trong ${Math.round(timeoutMs / 1000)} giây. Thử lại sau, hoặc kiểm tra mạng từ máy chủ Hive tới cụm.`,
      { cause: e },
    );
  }
  return new KubeError(
    "UNAVAILABLE",
    "Không kết nối được tới API Kubernetes. Kiểm tra URL kết nối và mạng từ máy chủ Hive.",
    { cause: e },
  );
}

function errorFor(status: number, detail: string): KubeError {
  if (status === 401) {
    return new KubeError(
      "UNAUTHORIZED",
      "Kubernetes từ chối token. Kiểm tra token ServiceAccount trong kết nối; token có thể đã hết hạn hoặc bị thu hồi.",
      { status },
    );
  }
  if (status === 403) {
    return new KubeError(
      "FORBIDDEN",
      "ServiceAccount không đủ quyền cho thao tác này. Nhờ quản trị cụm cấp quyền get và patch cho workload ở namespace này.",
      { status },
    );
  }
  if (status === 404) {
    return new KubeError("NOT_FOUND", "Kubernetes không tìm thấy workload này. Kiểm tra namespace, loại và tên.", {
      status,
    });
  }
  if (status >= 500 || status === 429 || status === 408) {
    return new KubeError("UNAVAILABLE", `API Kubernetes đang lỗi hoặc quá tải (HTTP ${status}). Thử lại sau.`, {
      status,
    });
  }
  const why = detail === "" ? "" : `: ${detail}`;
  return new KubeError("BAD_REQUEST", `Kubernetes từ chối yêu cầu (HTTP ${status})${why}`, { status });
}
