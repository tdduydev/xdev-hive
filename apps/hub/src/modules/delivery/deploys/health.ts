import type { Deploy, HealthCheck } from "@xdev-hive/contracts";
import type { FetchLike } from "../clients/jenkins.ts";
import { deliveryOutbound, OUTBOUND_DISABLED } from "../clients/outbound.ts";

// Kiểm health từ hub (FR-018, plan.md mục 7): gọi URL, so mã HTTP, so một giá trị trong JSON theo đường dẫn đơn giản,
// thử lại theo chu kỳ tới hết thời gian chờ. Không chạy mã nào từ cấu hình: biểu thức chỉ là chuỗi khoá và chỉ số.

export type HealthResult = NonNullable<Deploy["health"]>;

export interface HealthVersion {
  commit: string | null;
  tag: string | null;
}

export interface HealthOptions {
  /** Giá trị thay cho `{{commit}}`, `{{commit8}}`, `{{tag}}` trong `match.equals`. */
  version: HealthVersion;
  /** Test thay bằng máy chủ giả; mặc định là fetch toàn cục. */
  fetch?: FetchLike | undefined;
  /** Test đẩy đồng hồ giả để không phải chờ thật. */
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Huỷ lần triển khai thì dừng thử lại. */
  signal?: AbortSignal | undefined;
  /** Giới hạn mỗi lần gọi, để một lần treo không ăn hết thời gian chờ. */
  attemptTimeoutMs?: number | undefined;
}

const ATTEMPT_TIMEOUT_MS = 10_000;
// Endpoint health trả vài chục byte; chặn ở đây để URL trỏ nhầm vào một tệp lớn không làm hub giữ bộ nhớ.
const MAX_BODY_BYTES = 1024 * 1024;
const PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/;
const SEGMENT = /([A-Za-z_$][\w$]*)|\[(\d+)\]/g;
const SHOWN = 100;

export type JsonPathResult = { found: true; value: unknown } | { found: false };

/**
 * Đường dẫn dạng `version`, `status.ok`, `items[0].name`. Chỉ đi theo thuộc tính của chính object và phần tử mảng, nên
 * `constructor`, `__proto__`, `length` đều không tìm thấy.
 */
export function evaluateJsonPath(root: unknown, path: string): JsonPathResult {
  if (!PATH.test(path)) return { found: false };
  let current = root;
  for (const m of path.matchAll(SEGMENT)) {
    if (current === null || typeof current !== "object") return { found: false };
    if (m[1] !== undefined) {
      if (Array.isArray(current) || !Object.hasOwn(current, m[1])) return { found: false };
      current = (current as Record<string, unknown>)[m[1]];
    } else {
      const index = Number(m[2]);
      if (!Array.isArray(current) || index >= current.length) return { found: false };
      current = current[index];
    }
  }
  return { found: true, value: current };
}

const VARIABLE = /\{\{(commit8|commit|tag)\}\}/g;

/** Thay biến phiên bản; trả tên biến còn thiếu khi lần triển khai không có giá trị đó. */
function expected(template: string, version: HealthVersion): { value: string } | { missing: string } {
  const values = { commit: version.commit, commit8: version.commit?.slice(0, 8) ?? null, tag: version.tag };
  for (const m of template.matchAll(VARIABLE)) {
    const name = m[1] as keyof typeof values;
    if (!values[name]) return { missing: name };
  }
  return { value: template.replace(VARIABLE, (_, name: keyof typeof values) => values[name] ?? "") };
}

const show = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const shown = text.length > SHOWN ? `${text.slice(0, SHOWN)}…` : text;
  return typeof value === "string" ? `"${shown}"` : shown;
};

const equalsText = (value: unknown): string | null =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;

async function readLimited(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface Attempt {
  ok: boolean;
  status: number | null;
  message: string;
}

/** URL có thể mang token ở query; thông báo hiện cho người dùng nên chỉ nêu máy chủ. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "máy chủ health";
  }
};

async function attempt(
  check: HealthCheck,
  want: string | null,
  opts: HealthOptions,
  doFetch: FetchLike,
): Promise<Attempt> {
  const timeout = AbortSignal.timeout(opts.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    // `manual`: chuyển hướng không được theo, vì health đi tới đâu là do cấu hình quyết định, không phải do máy đích.
    res = await doFetch(check.url, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { accept: "application/json" },
    });
  } catch (e) {
    const timedOut = timeout.aborted;
    const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    return {
      ok: false,
      status: null,
      message: timedOut
        ? `Gọi ${hostOf(check.url)} quá thời gian chờ của một lần thử.`
        : `Không gọi được ${hostOf(check.url)} (${code}).`,
    };
  }

  const status = res.status;
  if (status !== check.expectStatus) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, status, message: `HTTP ${status}, mong đợi ${check.expectStatus}.` };
  }
  if (!check.match || want === null) {
    await res.body?.cancel().catch(() => {});
    return { ok: true, status, message: `Đạt: HTTP ${status}.` };
  }

  let text: string | null;
  try {
    text = await readLimited(res);
  } catch {
    return { ok: false, status, message: `HTTP ${status} nhưng không đọc hết được thân phản hồi.` };
  }
  if (text === null) return { ok: false, status, message: `HTTP ${status} nhưng thân phản hồi quá lớn để kiểm.` };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status, message: `HTTP ${status} nhưng thân phản hồi không phải JSON.` };
  }
  const found = evaluateJsonPath(body, check.match.path);
  if (!found.found) return { ok: false, status, message: `JSON không có trường ${check.match.path}.` };
  if (equalsText(found.value) !== want)
    return {
      ok: false,
      status,
      message: `${check.match.path} là ${show(found.value)}, mong đợi ${show(want)}.`,
    };
  return { ok: true, status, message: `Đạt: HTTP ${status}, ${check.match.path} = ${show(found.value)}.` };
}

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Gọi health tới khi đạt hoặc hết `timeoutSec`. Lần thử cuối rơi đúng lúc hết hạn, nên chu kỳ không chia hết thời gian
 * chờ vẫn có một lần kiểm ở cuối. Không bao giờ ném lỗi: mọi kết cục là một `HealthResult` để orchestrator lưu.
 */
export async function runHealthCheck(check: HealthCheck, opts: HealthOptions): Promise<HealthResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => realSleep(ms, opts.signal));
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const result = (r: Attempt): HealthResult => ({
    ok: r.ok,
    at: new Date(now()).toISOString(),
    status: r.status,
    message: r.message,
  });

  if (!deliveryOutbound()) return result({ ok: false, status: null, message: OUTBOUND_DISABLED });
  let want: string | null = null;
  if (check.match) {
    const resolved = expected(check.match.equals, opts.version);
    // Thiếu giá trị thì thử bao nhiêu lần cũng vậy: dừng ngay và nói rõ.
    if ("missing" in resolved)
      return result({
        ok: false,
        status: null,
        message: `Lần triển khai không có ${resolved.missing} để so với {{${resolved.missing}}} trong cấu hình health.`,
      });
    want = resolved.value;
  }

  const deadline = now() + check.timeoutSec * 1000;
  let tries = 0;
  for (;;) {
    tries++;
    const last = await attempt(check, want, opts, doFetch);
    if (last.ok) return result(last);
    if (opts.signal?.aborted) return result({ ...last, message: "Đã huỷ kiểm health." });
    const remaining = deadline - now();
    if (remaining <= 0)
      return result({
        ...last,
        message: `Không đạt sau ${check.timeoutSec} giây (${tries} lần thử). Lần cuối: ${last.message}`,
      });
    await sleep(Math.min(check.intervalSec * 1000, remaining));
    if (opts.signal?.aborted) return result({ ...last, message: "Đã huỷ kiểm health." });
  }
}
