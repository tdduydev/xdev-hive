import { healthCheck } from "@xdev-hive/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeHttp, startFakeHttp } from "../testing/fake-http.ts";
import { evaluateJsonPath, type HealthOptions, runHealthCheck } from "./health.ts";

// Máy chủ giả chạy trong tiến trình trên 127.0.0.1. Đồng hồ giả: `sleep` chỉ đẩy giờ lên, nên thời gian chờ 3 phút chạy
// trong vài mili giây mà vẫn đếm đúng số lần thử.
let server: FakeHttp | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const clock = () => {
  const state = { t: Date.parse("2026-10-22T10:00:00Z"), sleeps: [] as number[] };
  return {
    state,
    now: () => state.t,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      state.t += ms;
    },
  };
};
const options = (c: ReturnType<typeof clock>, extra: Partial<HealthOptions> = {}): HealthOptions => ({
  version: { commit: COMMIT, tag: "v1.2.3" },
  now: c.now,
  sleep: c.sleep,
  ...extra,
});
const check = (url: string, extra: Record<string, unknown> = {}) => healthCheck.parse({ url, ...extra });

describe("evaluateJsonPath", () => {
  const body = { version: "1.0", status: { ok: true, n: 3 }, items: [{ name: "a" }, { name: "b" }], nothing: null };

  it("đọc khoá, khoá lồng và phần tử mảng", () => {
    expect(evaluateJsonPath(body, "version")).toEqual({ found: true, value: "1.0" });
    expect(evaluateJsonPath(body, "status.ok")).toEqual({ found: true, value: true });
    expect(evaluateJsonPath(body, "items[1].name")).toEqual({ found: true, value: "b" });
    expect(evaluateJsonPath(body, "nothing")).toEqual({ found: true, value: null });
  });

  it("không có thì found=false, kể cả khi đi qua kiểu không phải object", () => {
    for (const path of ["missing", "status.missing", "items[5]", "version.length", "nothing.x", "items.name"])
      expect(evaluateJsonPath(body, path).found, path).toBe(false);
  });

  it("không chạm vào thuộc tính của prototype", () => {
    for (const path of ["constructor", "__proto__", "toString", "items.length", "status.constructor.name"])
      expect(evaluateJsonPath(body, path).found, path).toBe(false);
  });

  it("từ chối biểu thức ngoài dạng đường dẫn đơn giản, không chạy mã", () => {
    for (const path of ["", "a b", "a;b", "a()", "a['b']", "a..b", "[0]", "a[-1]", "process.exit(1)", "a ? b : c"])
      expect(evaluateJsonPath({ a: 1 }, path).found, path).toBe(false);
  });
});

describe("runHealthCheck", () => {
  it("đạt ngay lần đầu khi mã HTTP đúng, không chờ", async () => {
    server = await startFakeHttp({ "GET /health": { status: 200, body: "ok" } });
    const c = clock();
    const result = await runHealthCheck(check(`${server.baseUrl}/health`), options(c));
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(result.message).toMatch(/Đạt/);
    expect(Date.parse(result.at)).toBe(c.state.t);
    expect(server.callsTo("GET /health")).toHaveLength(1);
    expect(c.state.sleeps).toEqual([]);
  });

  it("so mã HTTP mong đợi khác 200", async () => {
    server = await startFakeHttp({ "GET /health": { status: 204 } });
    const ok = await runHealthCheck(check(`${server.baseUrl}/health`, { expectStatus: 204 }), options(clock()));
    expect(ok).toMatchObject({ ok: true, status: 204 });
    const bad = await runHealthCheck(check(`${server.baseUrl}/health`, { timeoutSec: 10 }), options(clock()));
    expect(bad.ok).toBe(false);
  });

  it("thay {{commit8}} trong giá trị mong đợi và so với JSON", async () => {
    server = await startFakeHttp({ "GET /v": { json: { version: COMMIT.slice(0, 8) } } });
    const result = await runHealthCheck(
      check(`${server.baseUrl}/v`, { match: { path: "version", equals: "{{commit8}}" } }),
      options(clock()),
    );
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(result.message).toContain(COMMIT.slice(0, 8));
  });

  it("thay {{commit}} và {{tag}}", async () => {
    server = await startFakeHttp({ "GET /v": { json: { build: { commit: COMMIT, tag: "v1.2.3" } } } });
    const url = `${server.baseUrl}/v`;
    expect(
      (await runHealthCheck(check(url, { match: { path: "build.commit", equals: "{{commit}}" } }), options(clock())))
        .ok,
    ).toBe(true);
    expect(
      (await runHealthCheck(check(url, { match: { path: "build.tag", equals: "{{tag}}" } }), options(clock()))).ok,
    ).toBe(true);
  });

  it("so số và boolean theo chữ của chúng", async () => {
    server = await startFakeHttp({ "GET /v": { json: { build: 42, ready: true } } });
    const url = `${server.baseUrl}/v`;
    const equals = (path: string, value: string) =>
      runHealthCheck(check(url, { timeoutSec: 10, match: { path, equals: value } }), options(clock()));
    expect((await equals("build", "42")).ok).toBe(true);
    expect((await equals("ready", "true")).ok).toBe(true);
    expect((await equals("build", "43")).ok).toBe(false);
  });

  it("thử lại theo chu kỳ tới khi phiên bản khớp", async () => {
    server = await startFakeHttp({
      "GET /v": [
        { status: 503 },
        { json: { version: "old00000" } },
        { json: { version: "old00000" } },
        { json: { version: COMMIT.slice(0, 8) } },
      ],
    });
    const c = clock();
    const result = await runHealthCheck(
      check(`${server.baseUrl}/v`, { intervalSec: 7, match: { path: "version", equals: "{{commit8}}" } }),
      options(c),
    );
    expect(result.ok).toBe(true);
    expect(server.callsTo("GET /v")).toHaveLength(4);
    expect(c.state.sleeps).toEqual([7000, 7000, 7000]);
  });

  it("hết thời gian chờ thì báo lần cuối sai ở đâu, số lần thử đúng theo chu kỳ", async () => {
    server = await startFakeHttp({ "GET /v": { status: 503, body: "secret-body-do-not-echo" } });
    const c = clock();
    const result = await runHealthCheck(check(`${server.baseUrl}/v`, { timeoutSec: 30, intervalSec: 10 }), options(c));
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(result.message).toMatch(/30 giây/);
    expect(result.message).toMatch(/503/);
    expect(result.message).not.toContain("secret-body-do-not-echo");
    // 0, 10, 20, 30 giây.
    expect(server.callsTo("GET /v")).toHaveLength(4);
    expect(c.state.t - Date.parse("2026-10-22T10:00:00Z")).toBe(30_000);
  });

  it("mặc định chờ 3 phút", async () => {
    server = await startFakeHttp({ "GET /v": { status: 500 } });
    const c = clock();
    const cfg = check(`${server.baseUrl}/v`);
    expect(cfg.timeoutSec).toBe(180);
    await runHealthCheck(cfg, options(c));
    expect(c.state.t - Date.parse("2026-10-22T10:00:00Z")).toBe(180_000);
  });

  it("chu kỳ không chia hết thời gian chờ thì thử lần cuối đúng lúc hết hạn", async () => {
    server = await startFakeHttp({ "GET /v": { status: 500 } });
    const c = clock();
    await runHealthCheck(check(`${server.baseUrl}/v`, { timeoutSec: 25, intervalSec: 10 }), options(c));
    expect(c.state.sleeps).toEqual([10_000, 10_000, 5000]);
    expect(server.callsTo("GET /v")).toHaveLength(4);
  });

  it("không theo chuyển hướng: mã 302 là kết quả, không đi tiếp tới nơi khác", async () => {
    server = await startFakeHttp({
      "GET /v": { status: 302, headers: { location: "/elsewhere" } },
      "GET /elsewhere": { status: 200 },
    });
    const result = await runHealthCheck(check(`${server.baseUrl}/v`, { timeoutSec: 10 }), options(clock()));
    expect(result).toMatchObject({ ok: false, status: 302 });
    expect(server.callsTo("GET /elsewhere")).toHaveLength(0);
  });

  it("thân không phải JSON thì báo rõ, không ném lỗi", async () => {
    server = await startFakeHttp({ "GET /v": { body: "<html>không phải json</html>" } });
    const result = await runHealthCheck(
      check(`${server.baseUrl}/v`, { timeoutSec: 10, match: { path: "version", equals: "x" } }),
      options(clock()),
    );
    expect(result).toMatchObject({ ok: false, status: 200 });
    expect(result.message).toMatch(/JSON/);
  });

  it("thiếu trường trong JSON thì không khớp", async () => {
    server = await startFakeHttp({ "GET /v": { json: { other: 1 } } });
    const result = await runHealthCheck(
      check(`${server.baseUrl}/v`, { timeoutSec: 10, match: { path: "version", equals: "x" } }),
      options(clock()),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/version/);
  });

  it("lỗi mạng thì thử lại và báo mã lỗi, không lộ URL", async () => {
    const calls: string[] = [];
    const fetch: HealthOptions["fetch"] = async (input) => {
      calls.push(String(input));
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const result = await runHealthCheck(
      check("https://hive.example.com/health?token=do-not-leak", { timeoutSec: 10, intervalSec: 5 }),
      options(clock(), { fetch }),
    );
    expect(result).toMatchObject({ ok: false, status: null });
    expect(result.message).toMatch(/ECONNREFUSED/);
    expect(result.message).toContain("hive.example.com");
    expect(result.message).not.toContain("do-not-leak");
    expect(calls).toHaveLength(3);
  });

  it("mỗi lần gọi có giới hạn thời gian riêng", async () => {
    server = await startFakeHttp({ "GET /slow": { delayMs: 500, body: "late" } });
    const result = await runHealthCheck(
      check(`${server.baseUrl}/slow`, { timeoutSec: 10 }),
      options(clock(), { attemptTimeoutMs: 50 }),
    );
    expect(result).toMatchObject({ ok: false, status: null });
    expect(result.message).toMatch(/quá/);
  });

  it("thiếu giá trị để thay thì dừng ngay, không thử lại vô ích", async () => {
    server = await startFakeHttp({ "GET /v": { json: { version: "x" } } });
    const c = clock();
    const result = await runHealthCheck(
      check(`${server.baseUrl}/v`, { match: { path: "version", equals: "{{tag}}" } }),
      options(c, { version: { commit: COMMIT, tag: null } }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/tag/);
    expect(server.requests).toHaveLength(0);
    expect(c.state.sleeps).toEqual([]);
  });

  it("huỷ giữa chừng thì dừng thử lại", async () => {
    server = await startFakeHttp({ "GET /v": { status: 500 } });
    const controller = new AbortController();
    const c = clock();
    const result = await runHealthCheck(
      check(`${server.baseUrl}/v`),
      options(c, {
        signal: controller.signal,
        sleep: async (ms) => {
          await c.sleep(ms);
          controller.abort();
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/huỷ/);
    expect(server.callsTo("GET /v")).toHaveLength(1);
  });

  it("chỉ gửi GET, không mang thông tin đăng nhập nào", async () => {
    server = await startFakeHttp({ "GET /h": { status: 200 } });
    await runHealthCheck(check(`${server.baseUrl}/h`), options(clock()));
    const [req] = server.requests;
    expect(req?.method).toBe("GET");
    expect(req?.headers.authorization).toBeUndefined();
    expect(req?.headers.cookie).toBeUndefined();
  });
});
