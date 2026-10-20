import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeHttp, startFakeHttp } from "../testing/fake-http.ts";
import { ArgoCdError, type ArgoCdErrorCode, createArgoCdClient } from "./argocd.ts";

const TOKEN = "argo-secret-token-9876";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/argocd/${name}`, import.meta.url), "utf8"));
}

async function errorOf(p: Promise<unknown>): Promise<ArgoCdError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ArgoCdError);
    return e as ArgoCdError;
  }
  throw new Error("đáng lẽ phải ném ArgoCdError");
}

async function codeOf(p: Promise<unknown>): Promise<ArgoCdErrorCode> {
  return (await errorOf(p)).code;
}

describe("ArgoCdClient", () => {
  let fake: FakeHttp;
  let client: ReturnType<typeof createArgoCdClient>;

  beforeEach(async () => {
    fake = await startFakeHttp();
    client = createArgoCdClient({ baseUrl: fake.baseUrl, token: TOKEN });
  });
  afterEach(async () => {
    await fake.close();
  });

  describe("xác thực và địa chỉ", () => {
    it("gửi Bearer token và Accept json", async () => {
      fake.route("GET /api/version", { json: fixture("version.json") });
      await client.version();
      expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(fake.requests[0]?.headers.accept).toBe("application/json");
    });

    it("giữ đường dẫn gốc khi Argo CD chạy sau proxy, bỏ dấu / cuối", async () => {
      fake.route("GET /argocd/api/version", { json: fixture("version.json") });
      const c = createArgoCdClient({ baseUrl: `${fake.baseUrl}/argocd/`, token: TOKEN });
      await expect(c.version()).resolves.toMatchObject({ version: "v2.14.2+ab12cd3" });
    });

    it("từ chối baseUrl không phải http(s)", () => {
      expect(() => createArgoCdClient({ baseUrl: "ftp://x", token: TOKEN })).toThrow(TypeError);
      expect(() => createArgoCdClient({ baseUrl: "không phải url", token: TOKEN })).toThrow(TypeError);
    });

    it("dùng fetch được truyền vào", async () => {
      let seen = "";
      const c = createArgoCdClient({
        baseUrl: "https://argocd.example.invalid",
        token: TOKEN,
        fetch: async (input) => {
          seen = String(input);
          return Response.json(fixture("version.json"));
        },
      });
      await c.version();
      expect(seen).toBe("https://argocd.example.invalid/api/version");
    });
  });

  describe("version", () => {
    it("đọc phiên bản, ngày build, commit", async () => {
      fake.route("GET /api/version", { json: fixture("version.json") });
      await expect(client.version()).resolves.toEqual({
        version: "v2.14.2+ab12cd3",
        buildDate: "2026-02-14T10:12:03Z",
        gitCommit: "ab12cd3ef4567890ab12cd3ef4567890ab12cd3e",
      });
    });
  });

  describe("listApplications", () => {
    beforeEach(() => {
      fake.route("GET /api/v1/applications", { json: fixture("applications.json") });
    });

    it("xếp theo tên và báo tổng", async () => {
      const list = await client.listApplications(10);
      expect(list.total).toBe(3);
      expect(list.items.map((a) => a.name)).toEqual(["his-api", "his-lis", "his-portal"]);
    });

    it("cắt theo limit nhưng vẫn báo tổng", async () => {
      const list = await client.listApplications(2);
      expect(list.items.map((a) => a.name)).toEqual(["his-api", "his-lis"]);
      expect(list.total).toBe(3);
    });

    it("đọc sync, health, autoSync, ảnh; thiếu trường thì có mặc định", async () => {
      const { items } = await client.listApplications(10);
      const portal = items.find((a) => a.name === "his-portal");
      expect(portal).toMatchObject({
        syncStatus: "Synced",
        healthStatus: "Healthy",
        revision: "9f8e7d6c5b4a39281706f5e4d3c2b1a099887766",
        images: ["registry.example.invalid/his/portal:1.8.3"],
        // Khối `automated` rỗng vẫn là autoSync bật.
        autoSync: true,
        destinationNamespace: "his-portal",
      });
      const lis = items.find((a) => a.name === "his-lis");
      expect(lis).toMatchObject({ syncStatus: "Unknown", healthStatus: "Missing", images: [], autoSync: false });
      expect(lis?.source).toBeNull();
      expect(lis?.revision).toBeNull();
    });

    it("items null (không có ứng dụng) là danh sách rỗng", async () => {
      fake.route("GET /api/v1/applications", { json: { items: null } });
      await expect(client.listApplications(5)).resolves.toEqual({ items: [], total: 0 });
    });

    it("limit sai là lỗi của người gọi", async () => {
      await expect(client.listApplications(0)).rejects.toThrow(TypeError);
      await expect(client.listApplications(1.5)).rejects.toThrow(TypeError);
    });
  });

  describe("getApplication", () => {
    it("đọc đủ: sync, health, revision, ảnh, autoSync, lịch sử mới nhất đứng đầu, thao tác gần nhất", async () => {
      fake.route("GET /api/v1/applications/his-portal", { json: fixture("application-synced.json") });
      const app = await client.getApplication("his-portal");
      expect(app).toMatchObject({
        name: "his-portal",
        project: "ehospital",
        destinationNamespace: "his-portal",
        source: {
          repoUrl: "https://gitlab.example.invalid/ehospital/deploy.git",
          path: "charts/his-portal",
          targetRevision: "main",
        },
        syncStatus: "Synced",
        revision: "9f8e7d6c5b4a39281706f5e4d3c2b1a099887766",
        healthStatus: "Healthy",
        healthMessage: null,
        autoSync: true,
        images: ["registry.example.invalid/his/portal:1.8.3", "registry.example.invalid/his/sidecar:0.4.1"],
        operation: {
          phase: "Succeeded",
          message: "successfully synced (all tasks run)",
          revision: "9f8e7d6c5b4a39281706f5e4d3c2b1a099887766",
          finishedAt: "2026-10-15T14:05:12Z",
        },
      });
      expect(app.history.map((h) => h.id)).toEqual([2, 1, 0]);
      expect(app.history[1]).toEqual({
        id: 1,
        revision: "2222222222222222222222222222222222222222",
        deployedAt: "2026-10-12T09:30:00Z",
        deployStartedAt: "2026-10-12T09:29:40Z",
      });
    });

    it("đang sync: operation Running, nguồn lấy từ sources[0], autoSync tắt", async () => {
      fake.route("GET /api/v1/applications/his-portal", { json: fixture("application-syncing.json") });
      const app = await client.getApplication("his-portal");
      expect(app.operation).toMatchObject({
        phase: "Running",
        finishedAt: null,
        revision: "9f8e7d6c5b4a39281706f5e4d3c2b1a099887766",
      });
      expect(app.source?.path).toBe("charts/his-portal");
      expect(app.autoSync).toBe(false);
      expect(app.healthStatus).toBe("Progressing");
      expect(app.healthMessage).toContain("Waiting for rollout");
      expect(app.history).toEqual([]);
    });

    it("sync thất bại: phase Failed kèm lời nhắn", async () => {
      fake.route("GET /api/v1/applications/his-api", { json: fixture("application-failed.json") });
      const app = await client.getApplication("his-api");
      expect(app.operation).toMatchObject({ phase: "Failed", message: "one or more objects failed to apply" });
      expect(app.revision).toBeNull();
    });

    it("mã hoá tên và chặn tên làm hỏng đường dẫn", async () => {
      fake.route("GET /api/v1/applications/a%20b", { json: fixture("application-synced.json") });
      await client.getApplication("a b");
      expect(fake.callsTo("GET /api/v1/applications/a%20b")).toHaveLength(1);
      await expect(client.getApplication("")).rejects.toThrow(TypeError);
      await expect(client.getApplication("a/b")).rejects.toThrow(TypeError);
      await expect(client.getApplication("..")).rejects.toThrow(TypeError);
    });
  });

  describe("sync", () => {
    it("POST thân rỗng khi không chỉ định revision", async () => {
      fake.route("POST /api/v1/applications/his-portal/sync", { json: fixture("application-syncing.json") });
      const app = await client.sync("his-portal");
      const [req] = fake.callsTo("POST /api/v1/applications/his-portal/sync");
      expect(JSON.parse(req?.body ?? "")).toEqual({});
      expect(req?.headers["content-type"]).toBe("application/json");
      expect(app.operation?.phase).toBe("Running");
    });

    it("gửi revision khi có", async () => {
      fake.route("POST /api/v1/applications/his-portal/sync", { json: fixture("application-syncing.json") });
      await client.sync("his-portal", "abc123");
      const [req] = fake.callsTo("POST /api/v1/applications/his-portal/sync");
      expect(JSON.parse(req?.body ?? "")).toEqual({ revision: "abc123" });
    });

    it("token thiếu quyền sync: FORBIDDEN, không lộ lời nhắn của máy chủ", async () => {
      fake.route("POST /api/v1/applications/his-portal/sync", {
        status: 403,
        json: fixture("error-permission-denied.json"),
      });
      const err = await errorOf(client.sync("his-portal"));
      expect(err.code).toBe("FORBIDDEN");
      expect(err.status).toBe(403);
      expect(err.message).not.toContain("jenkins-deployer");
    });
  });

  describe("rollback", () => {
    it("POST id của lịch sử", async () => {
      fake.route("POST /api/v1/applications/his-portal/rollback", { json: fixture("application-syncing.json") });
      await client.rollback("his-portal", 1);
      const [req] = fake.callsTo("POST /api/v1/applications/his-portal/rollback");
      expect(JSON.parse(req?.body ?? "")).toEqual({ id: 1 });
    });

    it("id 0 hợp lệ (lần triển khai đầu)", async () => {
      fake.route("POST /api/v1/applications/his-portal/rollback", { json: fixture("application-syncing.json") });
      await expect(client.rollback("his-portal", 0)).resolves.toBeDefined();
    });

    it("autoSync bật: BAD_REQUEST kèm lời nhắn của Argo CD để người dùng biết phải tắt autoSync", async () => {
      fake.route("POST /api/v1/applications/his-portal/rollback", {
        status: 400,
        json: fixture("error-rollback-autosync.json"),
      });
      const err = await errorOf(client.rollback("his-portal", 1));
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("auto-sync is enabled");
    });

    it("id sai là lỗi của người gọi", async () => {
      await expect(client.rollback("his-portal", -1)).rejects.toThrow(TypeError);
      await expect(client.rollback("his-portal", 1.5)).rejects.toThrow(TypeError);
    });
  });

  describe("lỗi", () => {
    it("401 → UNAUTHORIZED", async () => {
      fake.route("GET /api/v1/applications/x", { status: 401, json: { error: "invalid session", code: 16 } });
      expect(await codeOf(client.getApplication("x"))).toBe("UNAUTHORIZED");
    });

    it("302 về trang đăng nhập SSO → UNAUTHORIZED, không đi theo", async () => {
      fake.route("GET /api/v1/applications/x", { status: 302, headers: { location: "/auth/login" } });
      expect(await codeOf(client.getApplication("x"))).toBe("UNAUTHORIZED");
      expect(fake.requests).toHaveLength(1);
    });

    it("404 → NOT_FOUND", async () => {
      fake.route("GET /api/v1/applications/x", { status: 404, json: { error: "not found", code: 5 } });
      expect(await codeOf(client.getApplication("x"))).toBe("NOT_FOUND");
    });

    it.each([500, 502, 503, 429])("%i → UNAVAILABLE, thử lại được", async (status) => {
      fake.route("GET /api/v1/applications/x", { status, body: "x" });
      const err = await errorOf(client.getApplication("x"));
      expect(err.code).toBe("UNAVAILABLE");
      expect(err.retryable).toBe(true);
    });

    it("lỗi do người dùng không thử lại được", async () => {
      fake.route("GET /api/v1/applications/x", { status: 403, body: "" });
      expect((await errorOf(client.getApplication("x"))).retryable).toBe(false);
    });

    it("phản hồi không phải JSON (trang đăng nhập, proxy) → UNAVAILABLE", async () => {
      fake.route("GET /api/version", { body: "<html>login</html>", headers: { "content-type": "text/html" } });
      expect(await codeOf(client.version())).toBe("UNAVAILABLE");
    });

    it("hết giờ → UNAVAILABLE", async () => {
      fake.route("GET /api/version", { json: fixture("version.json"), delayMs: 400 });
      const c = createArgoCdClient({ baseUrl: fake.baseUrl, token: TOKEN, timeoutMs: 50 });
      const err = await errorOf(c.version());
      expect(err.code).toBe("UNAVAILABLE");
      expect(err.message).toContain("không trả lời");
    });

    it("không nối được → UNAVAILABLE", async () => {
      const c = createArgoCdClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN, timeoutMs: 2000 });
      expect(await codeOf(c.version())).toBe("UNAVAILABLE");
    });

    it("máy chủ lặp lại token trong lời nhắn thì token bị che", async () => {
      fake.route("POST /api/v1/applications/x/sync", {
        status: 400,
        json: { message: `bad request for ${TOKEN}` },
      });
      const err = await errorOf(client.sync("x"));
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("***");
      expect(err.message).not.toContain(TOKEN);
    });

    it("lỗi không chứa token", async () => {
      for (const status of [401, 403, 404, 500, 400]) {
        fake.route("GET /api/v1/applications/x", { status, body: "" });
        const err = await errorOf(client.getApplication("x"));
        expect(`${err.message} ${String(err.cause ?? "")}`).not.toContain(TOKEN);
      }
    });
  });
});
