// Client Jenkins thuần trên fetch (plan.md mục 2). Không đụng DB, không biết người dùng Hive: bên gọi truyền user và API
// token của người bấm (thao tác ghi) hoặc của người theo dõi (đọc theo lịch).
// Mọi dạng JSON ở đây theo tài liệu công khai của Jenkins [Suy luận]; T007 đối chiếu với Jenkins acme.

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type JenkinsErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  // 403 do thiếu crumb CSRF: tách riêng để T007 biết Jenkins acme có đòi crumb khi POST bằng API token không.
  | "CRUMB_REQUIRED"
  | "NOT_FOUND"
  // Hết giờ, không nối được, 5xx, 429, hoặc phản hồi không đọc được.
  | "UNAVAILABLE"
  // Các lỗi 4xx còn lại (thường là tham số sai).
  | "BAD_REQUEST";

export class JenkinsError extends Error {
  override readonly name = "JenkinsError";
  readonly code: JenkinsErrorCode;
  readonly status: number | null;

  constructor(code: JenkinsErrorCode, message: string, opts: { status?: number | null; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    this.status = opts.status ?? null;
  }

  /** Thử lại sau có thể được; các mã còn lại cần người sửa token, quyền hoặc tham số. */
  get retryable(): boolean {
    return this.code === "UNAVAILABLE";
  }
}

export interface JenkinsConnection {
  /** Địa chỉ gốc, có thể kèm context path (`https://host/jenkins`). */
  baseUrl: string;
  user: string;
  token: string;
  fetch?: FetchLike;
  /** Hạn cho mỗi lời gọi HTTP, mặc định 15 giây. */
  timeoutMs?: number;
}

/** Đường dẫn job: chuỗi `a/b/c` (tách theo `/`) hoặc mảng đoạn khi một đoạn có chứa `/` (nhánh `feature/x`). */
export type JenkinsJobPath = string | readonly string[];

export type JenkinsResult = "SUCCESS" | "FAILURE" | "UNSTABLE" | "ABORTED" | "NOT_BUILT";
export type JenkinsParamValue = string | number | boolean;

export interface JenkinsUser {
  id: string;
  fullName: string;
  url: string;
}

export type JenkinsParamKind = "string" | "text" | "boolean" | "choice" | "password" | "other";

export interface JenkinsParamDef {
  name: string;
  /** Kiểu đã chuẩn hoá để dựng form; `type` giữ nguyên tên lớp của Jenkins. */
  kind: JenkinsParamKind;
  type: string;
  description: string;
  default: JenkinsParamValue | null;
  choices: string[] | null;
}

export interface JenkinsJob {
  name: string;
  fullName: string;
  url: string;
  buildable: boolean;
  parameters: JenkinsParamDef[];
}

export interface JenkinsCause {
  description: string;
  userId: string | null;
  userName: string | null;
}

export interface JenkinsBuild {
  number: number;
  url: string;
  /** `null` khi đang chạy. */
  result: JenkinsResult | null;
  building: boolean;
  /** Mili giây epoch. */
  startedAt: number;
  durationMs: number;
  causes: JenkinsCause[];
  commit: { sha: string; branch: string | null } | null;
  /** Tham số mật khẩu không có giá trị nên không nằm ở đây. */
  parameters: Record<string, JenkinsParamValue>;
}

export interface JenkinsStage {
  id: string;
  name: string;
  /** `SUCCESS`, `FAILED`, `IN_PROGRESS`, `PAUSED_PENDING_INPUT`, `NOT_EXECUTED`, `ABORTED`, `UNSTABLE`. */
  status: string;
  startedAt: number;
  durationMs: number;
  pausedMs: number;
  error: string | null;
}

export interface JenkinsStages {
  status: string;
  stages: JenkinsStage[];
}

export interface JenkinsLogChunk {
  text: string;
  /** Offset (byte) để xin đoạn kế tiếp. */
  next: number;
  /** Jenkins còn ghi thêm (build chưa xong). */
  more: boolean;
}

export interface JenkinsPendingInput {
  id: string;
  message: string;
  proceedText: string;
  inputs: Array<{ name: string; type: string; description: string }>;
}

export interface JenkinsTriggerResult {
  queueId: number;
  /** `null` khi còn trong hàng đợi lúc hết hạn chờ, hoặc khi bị huỷ. */
  number: number | null;
  url: string | null;
  cancelled: boolean;
}

export interface TriggerOptions {
  /** Hạn đợi build rời hàng đợi, mặc định 30 giây. */
  waitMs?: number;
  /** Khoảng cách giữa hai lần hỏi queue item, mặc định 1 giây. */
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_POLL_MS = 1_000;

const JOB_TREE =
  "name,fullName,url,buildable,property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]]";
const BUILD_FIELDS =
  "number,result,building,timestamp,duration,url,actions[causes[shortDescription,userId,userName],lastBuiltRevision[SHA1,branch[name]],parameters[name,value]]";
const QUEUE_TREE = "id,cancelled,why,executable[number,url]";
const ME_TREE = "id,fullName,absoluteUrl";

const RESULTS: ReadonlySet<string> = new Set(["SUCCESS", "FAILURE", "UNSTABLE", "ABORTED", "NOT_BUILT"]);

/** `a/b/c` → `/job/a/job/b/job/c`, mã hoá từng đoạn. Ném TypeError khi đường dẫn sai (lỗi của người gọi, không phải của Jenkins). */
export function jobUrlPath(path: JenkinsJobPath): string {
  const segments = typeof path === "string" ? path.replace(/^\/+|\/+$/g, "").split("/") : [...path];
  if (segments.length === 0 || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new TypeError(`Đường dẫn job Jenkins không hợp lệ: ${JSON.stringify(path)}`);
  }
  return segments.map((s) => `/job/${encodeURIComponent(s)}`).join("");
}

function assertPositiveInt(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${what} phải là số nguyên dương`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function paramValue(v: unknown): JenkinsParamValue | null {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;
}

function paramKind(type: string): JenkinsParamKind {
  switch (type) {
    case "StringParameterDefinition":
      return "string";
    case "TextParameterDefinition":
      return "text";
    case "BooleanParameterDefinition":
      return "boolean";
    case "ChoiceParameterDefinition":
      return "choice";
    case "PasswordParameterDefinition":
      return "password";
    default:
      return "other";
  }
}

/** `refs/remotes/origin/main`, `refs/heads/main`, `origin/main` → `main`. */
function branchName(raw: string): string {
  return raw
    .replace(/^refs\/remotes\/[^/]+\//, "")
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "");
}

function toBuild(raw: unknown): JenkinsBuild {
  const b = isRecord(raw) ? raw : {};
  const causes: JenkinsCause[] = [];
  const parameters: Record<string, JenkinsParamValue> = {};
  let commit: JenkinsBuild["commit"] = null;

  for (const action of arr(b.actions)) {
    if (!isRecord(action)) continue;
    for (const c of arr(action.causes)) {
      if (!isRecord(c)) continue;
      causes.push({ description: str(c.shortDescription) ?? "", userId: str(c.userId), userName: str(c.userName) });
    }
    for (const p of arr(action.parameters)) {
      if (!isRecord(p)) continue;
      const name = str(p.name);
      const value = paramValue(p.value);
      if (name !== null && value !== null) parameters[name] = value;
    }
    const rev = action.lastBuiltRevision;
    if (commit === null && isRecord(rev) && typeof rev.SHA1 === "string") {
      const first = arr(rev.branch)[0];
      const name = isRecord(first) ? str(first.name) : null;
      commit = { sha: rev.SHA1, branch: name === null ? null : branchName(name) };
    }
  }

  const result = typeof b.result === "string" && RESULTS.has(b.result) ? (b.result as JenkinsResult) : null;
  return {
    number: num(b.number),
    url: str(b.url) ?? "",
    result,
    building: b.building === true,
    startedAt: num(b.timestamp),
    durationMs: num(b.duration),
    causes,
    commit,
    parameters,
  };
}

function toParamDef(raw: unknown): JenkinsParamDef | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name);
  if (name === null) return null;
  const type = str(raw.type) ?? "";
  const def = isRecord(raw.defaultParameterValue) ? paramValue(raw.defaultParameterValue.value) : null;
  const choices = Array.isArray(raw.choices) ? raw.choices.filter((c): c is string => typeof c === "string") : null;
  return { name, kind: paramKind(type), type, description: str(raw.description) ?? "", default: def, choices };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LOGIN_REDIRECT = /login|securityRealm|oauth|oidc/i;

export function createJenkinsClient(conn: JenkinsConnection) {
  const root = parseBaseUrl(conn.baseUrl);
  const doFetch: FetchLike = conn.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = conn.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Chỉ nằm trong closure này: không đưa vào lỗi, không log, không để lộ ra ngoài client.
  const authorization = `Basic ${Buffer.from(`${conn.user}:${conn.token}`).toString("base64")}`;

  interface RequestOptions {
    method?: "GET" | "POST";
    query?: Record<string, string>;
    form?: URLSearchParams | undefined;
    /** 3xx là thành công (Jenkins trả 302 về trang build sau stop, abort). Chỉ cho POST. */
    redirectOk?: boolean;
    /** 404 là kết quả hợp lệ: trả Response để người gọi tự xử lý. */
    allow404?: boolean;
  }

  async function request(path: string, opts: RequestOptions = {}): Promise<Response> {
    const method = opts.method ?? "GET";
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
    const headers: Record<string, string> = { authorization, accept: "application/json, text/plain, */*" };
    if (opts.form) headers["content-type"] = "application/x-www-form-urlencoded";

    let res: Response;
    try {
      res = await doFetch(`${root}${path}${qs}`, {
        method,
        headers,
        ...(opts.form ? { body: opts.form.toString() } : {}),
        // 302 về trang đăng nhập phải thấy được, không đi theo.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw networkError(e, timeoutMs);
    }

    if (res.status >= 200 && res.status < 300) return res;
    if (res.status >= 300 && res.status < 400) {
      await drain(res);
      const location = res.headers.get("location") ?? "";
      if (opts.redirectOk && !LOGIN_REDIRECT.test(location)) return res;
      throw errorFor(401, "");
    }
    if (res.status === 404 && opts.allow404) {
      await drain(res);
      return res;
    }
    // Chỉ 403 cần đọc thân (để phân biệt thiếu crumb); các lỗi khác chỉ giải phóng kết nối.
    const body = res.status === 403 ? await res.text().catch(() => "") : "";
    if (res.status !== 403) await drain(res);
    throw errorFor(res.status, body);
  }

  async function getJson(path: string, tree?: string): Promise<unknown> {
    const res = await request(path, tree === undefined ? {} : { query: { tree } });
    return parseJson(res);
  }

  const buildPath = (job: JenkinsJobPath, n: number): string => {
    assertPositiveInt(n, "Số build");
    return `${jobUrlPath(job)}/${n}`;
  };

  async function post(path: string, form?: URLSearchParams): Promise<Response> {
    return request(path, { method: "POST", form, redirectOk: true });
  }

  return {
    /** Người dùng Jenkins ứng với token; dùng để kiểm token. */
    async me(): Promise<JenkinsUser> {
      const raw = await getJson("/me/api/json", ME_TREE);
      const r = isRecord(raw) ? raw : {};
      return { id: str(r.id) ?? "", fullName: str(r.fullName) ?? "", url: str(r.absoluteUrl) ?? "" };
    },

    async job(path: JenkinsJobPath): Promise<JenkinsJob> {
      const raw = await getJson(`${jobUrlPath(path)}/api/json`, JOB_TREE);
      const r = isRecord(raw) ? raw : {};
      const parameters: JenkinsParamDef[] = [];
      for (const prop of arr(r.property)) {
        if (!isRecord(prop)) continue;
        for (const def of arr(prop.parameterDefinitions)) {
          const p = toParamDef(def);
          if (p) parameters.push(p);
        }
      }
      return {
        name: str(r.name) ?? "",
        fullName: str(r.fullName) ?? "",
        url: str(r.url) ?? "",
        buildable: r.buildable === true,
        parameters,
      };
    },

    /** `limit` build mới nhất. Folder hoặc job chưa chạy lần nào thì mảng rỗng. */
    async builds(path: JenkinsJobPath, limit: number): Promise<JenkinsBuild[]> {
      assertPositiveInt(limit, "limit");
      const raw = await getJson(`${jobUrlPath(path)}/api/json`, `builds[${BUILD_FIELDS}]{0,${limit}}`);
      return arr(isRecord(raw) ? raw.builds : undefined).map(toBuild);
    },

    /** Đọc một build. Tên `getBuild` để không trùng với thao tác bấm build (`triggerBuild`). */
    async getBuild(path: JenkinsJobPath, n: number): Promise<JenkinsBuild> {
      return toBuild(await getJson(`${buildPath(path, n)}/api/json`, BUILD_FIELDS));
    },

    /** Giai đoạn pipeline; `null` khi không có plugin Stage View hoặc job không phải pipeline (404). */
    async stages(path: JenkinsJobPath, n: number): Promise<JenkinsStages | null> {
      const res = await request(`${buildPath(path, n)}/wfapi/describe`, { allow404: true });
      if (res.status === 404) return null;
      const r = await parseJson(res);
      const raw = isRecord(r) ? r : {};
      const stages: JenkinsStage[] = [];
      for (const s of arr(raw.stages)) {
        if (!isRecord(s)) continue;
        stages.push({
          id: str(s.id) ?? "",
          name: str(s.name) ?? "",
          status: str(s.status) ?? "",
          startedAt: num(s.startTimeMillis),
          durationMs: num(s.durationMillis),
          pausedMs: num(s.pauseDurationMillis),
          error: isRecord(s.error) ? str(s.error.message) : null,
        });
      }
      return { status: str(raw.status) ?? "", stages };
    },

    /** Log từ offset `start` (byte). */
    async log(path: JenkinsJobPath, n: number, start: number): Promise<JenkinsLogChunk> {
      if (!Number.isInteger(start) || start < 0) throw new TypeError("start phải là số nguyên không âm");
      const res = await request(`${buildPath(path, n)}/logText/progressiveText`, { query: { start: String(start) } });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const size = Number.parseInt(res.headers.get("x-text-size") ?? "", 10);
      return {
        text: new TextDecoder("utf-8").decode(bytes),
        next: Number.isFinite(size) && size >= 0 ? size : start + bytes.byteLength,
        more: res.headers.get("x-more-data") === "true",
      };
    },

    /** Bước `input` đang chờ. Build không phải pipeline (404) thì không có bước nào chờ. */
    async pendingInputs(path: JenkinsJobPath, n: number): Promise<JenkinsPendingInput[]> {
      const res = await request(`${buildPath(path, n)}/wfapi/pendingInputActions`, { allow404: true });
      if (res.status === 404) return [];
      const out: JenkinsPendingInput[] = [];
      for (const a of arr(await parseJson(res))) {
        if (!isRecord(a)) continue;
        const id = str(a.id);
        if (id === null) continue;
        out.push({
          id,
          message: str(a.message) ?? "",
          proceedText: str(a.proceedText) ?? "",
          inputs: arr(a.inputs).flatMap((i) =>
            isRecord(i) && typeof i.name === "string"
              ? [{ name: i.name, type: str(i.type) ?? "", description: str(i.description) ?? "" }]
              : [],
          ),
        });
      }
      return out;
    },

    /**
     * Bấm build. `params` có (kể cả `{}`) thì dùng `buildWithParameters`, không có thì `build`. Tham số gửi trong thân form
     * để không nằm trên URL (access log của nginx, Jenkins). Sau đó đợi queue item có số build tới `waitMs`; hết hạn thì
     * trả `number: null` (build vẫn nằm trong hàng đợi), không ném lỗi.
     */
    async triggerBuild(
      path: JenkinsJobPath,
      params?: Record<string, JenkinsParamValue>,
      opts: TriggerOptions = {},
    ): Promise<JenkinsTriggerResult> {
      const job = jobUrlPath(path);
      const res =
        params === undefined
          ? await post(`${job}/build`)
          : await post(
              `${job}/buildWithParameters`,
              new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])),
            );
      const queueId = queueIdFrom(res.headers.get("location"));

      const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
      const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
      const deadline = Date.now() + waitMs;
      for (;;) {
        const raw = await getJson(`/queue/item/${queueId}/api/json`, QUEUE_TREE);
        const item = isRecord(raw) ? raw : {};
        if (item.cancelled === true) return { queueId, number: null, url: null, cancelled: true };
        const exe = isRecord(item.executable) ? item.executable : null;
        if (exe && typeof exe.number === "number") {
          return { queueId, number: exe.number, url: str(exe.url), cancelled: false };
        }
        const left = deadline - Date.now();
        if (left <= 0) return { queueId, number: null, url: null, cancelled: false };
        await sleep(Math.min(pollMs, left));
      }
    },

    async stop(path: JenkinsJobPath, n: number): Promise<void> {
      await post(`${buildPath(path, n)}/stop`);
    },

    /** Proceed bước `input`. Tham số (nếu bước đòi) gửi dạng `json={"parameter":[…]}` [Unverified]. */
    async inputProceed(
      path: JenkinsJobPath,
      n: number,
      inputId: string,
      params?: Record<string, JenkinsParamValue>,
    ): Promise<void> {
      const entries = Object.entries(params ?? {});
      const form =
        entries.length === 0
          ? undefined
          : new URLSearchParams({
              json: JSON.stringify({ parameter: entries.map(([name, value]) => ({ name, value })) }),
            });
      await post(`${buildPath(path, n)}/input/${encodeURIComponent(inputId)}/proceed`, form);
    },

    async inputAbort(path: JenkinsJobPath, n: number, inputId: string): Promise<void> {
      await post(`${buildPath(path, n)}/input/${encodeURIComponent(inputId)}/abort`);
    },
  };
}

export type JenkinsClient = ReturnType<typeof createJenkinsClient>;

function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("baseUrl của Jenkins không phải URL hợp lệ");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new TypeError("baseUrl của Jenkins phải là http hoặc https");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Location của POST build: `…/queue/item/<id>/`. Jenkins dựng nó từ "Jenkins URL" trong cấu hình, có thể là tên nội bộ, nên chỉ lấy id. */
function queueIdFrom(location: string | null): number {
  const m = location === null ? null : /\/queue\/item\/(\d+)/.exec(location);
  if (m?.[1] === undefined) {
    throw new JenkinsError(
      "UNAVAILABLE",
      "Jenkins nhận lệnh build nhưng không trả về mục hàng đợi (thiếu Location). Kiểm tra trên Jenkins xem build đã chạy chưa.",
    );
  }
  return Number.parseInt(m[1], 10);
}

async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    // Đã đọc hoặc kết nối đứt: không còn gì để giải phóng.
  }
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new JenkinsError(
      "UNAVAILABLE",
      "Jenkins trả về nội dung không phải JSON (có thể là trang đăng nhập hoặc proxy chặn). Kiểm tra URL kết nối Jenkins.",
      { status: res.status, cause: e },
    );
  }
}

function networkError(e: unknown, timeoutMs: number): JenkinsError {
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new JenkinsError(
      "UNAVAILABLE",
      `Jenkins không trả lời trong ${Math.round(timeoutMs / 1000)} giây. Thử lại sau, hoặc kiểm tra mạng từ máy chủ Hive tới Jenkins.`,
      { cause: e },
    );
  }
  return new JenkinsError(
    "UNAVAILABLE",
    "Không kết nối được tới Jenkins. Kiểm tra URL kết nối và mạng từ máy chủ Hive.",
    { cause: e },
  );
}

function errorFor(status: number, body: string): JenkinsError {
  if (status === 401) {
    return new JenkinsError(
      "UNAUTHORIZED",
      "Jenkins từ chối đăng nhập. Kiểm tra user và API token Jenkins của bạn trong Cài đặt cá nhân → Token Jenkins; token có thể đã hết hạn hoặc bị thu hồi.",
      { status },
    );
  }
  if (status === 403) {
    if (/crumb/i.test(body)) {
      return new JenkinsError(
        "CRUMB_REQUIRED",
        'Jenkins đòi crumb CSRF cho thao tác ghi (403 "No valid crumb"). Jenkins này không nhận POST bằng API token mà thiếu crumb; báo quản trị Hive.',
        { status },
      );
    }
    return new JenkinsError(
      "FORBIDDEN",
      "Tài khoản Jenkins của bạn không đủ quyền cho thao tác này. Nhờ quản trị Jenkins cấp quyền trên job.",
      { status },
    );
  }
  if (status === 404) {
    return new JenkinsError("NOT_FOUND", "Jenkins không tìm thấy mục này. Kiểm tra đường dẫn job và số build.", {
      status,
    });
  }
  if (status >= 500 || status === 429 || status === 408) {
    return new JenkinsError("UNAVAILABLE", `Jenkins đang lỗi hoặc quá tải (HTTP ${status}). Thử lại sau.`, { status });
  }
  return new JenkinsError("BAD_REQUEST", `Jenkins từ chối yêu cầu (HTTP ${status}). Kiểm tra tên và giá trị tham số.`, {
    status,
  });
}
