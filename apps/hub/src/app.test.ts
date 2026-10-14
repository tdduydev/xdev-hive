import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { healthOutput } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

const app = createApp({ config: { port: 0, version: "1.2.3" } });

describe("hub", () => {
  it("GET /api/v1/health trả trạng thái và phiên bản", async () => {
    const res = await app.request("/api/v1/health");
    expect(res.status).toBe(200);
    const body = healthOutput.parse(await res.json());
    expect(body).toMatchObject({ status: "ok", version: "1.2.3" });
    // Worker chỉ khai CLI có trong danh sách này (hub cũ không trả thì chỉ claude, codex, gemini).
    expect(body.clis).toEqual(["claude", "codex", "gemini", "antigravity"]);
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });

  it("health trả giờ dựng image để web hiện ngày build; chạy từ mã nguồn thì null", async () => {
    const built = createApp({ config: { port: 0, version: "abc1234", builtAt: "2026-10-13T07:05:00Z" } });
    expect(healthOutput.parse(await (await built.request("/api/v1/health")).json()).builtAt).toBe(
      "2026-10-13T07:05:00Z",
    );
    expect(healthOutput.parse(await (await app.request("/api/v1/health")).json()).builtAt).toBeNull();
  });

  it("đường dẫn lạ trả 404", async () => {
    expect((await app.request("/api/v1/khong-co")).status).toBe(404);
  });
});

describe("phục vụ web", () => {
  it("trả file tĩnh, SPA fallback và không nuốt API/RPC", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hive-web-"));
    try {
      await mkdir(join(dir, "assets"));
      await writeFile(join(dir, "index.html"), "<main>Hive</main>");
      await writeFile(join(dir, "assets", "app.js"), "ok");
      const web = createApp({ config: { port: 0, version: "1" }, webDist: dir });
      expect(await (await web.request("/")).text()).toContain("Hive");
      expect(await (await web.request("/assets/app.js")).text()).toBe("ok");
      expect(await (await web.request("/route/nested")).text()).toContain("Hive");
      expect((await web.request("/api/v1/missing")).status).toBe(404);
      expect((await web.request("/rpc/missing")).status).toBe(404);
      // Trang đồng ý MCP là route web, không phải endpoint MCP.
      expect(await (await web.request("/mcp/consent?client_id=x")).text()).toContain("Hive");
      expect((await web.request("/assets/app.js")).headers.get("cache-control")).toContain("immutable");
      expect((await web.request("/")).headers.get("cache-control") ?? "no-cache").toBe("no-cache");
      expect((await web.request("/%E0%A4%A")).status).toBe(404);
      expect(await (await web.request("/../../etc/passwd")).text()).toContain("Hive");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("nén file web", () => {
  it("nén JS theo Accept-Encoding, giữ bản nén của /assets/; file nhỏ và ảnh để nguyên", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hive-web-"));
    try {
      await mkdir(join(dir, "assets"));
      const js = `console.log(${JSON.stringify("Hive ".repeat(2000))});`;
      await writeFile(join(dir, "index.html"), "<main>Hive</main>");
      await writeFile(join(dir, "assets", "app.js"), js);
      await writeFile(join(dir, "assets", "small.js"), "ok");
      await writeFile(join(dir, "assets", "font.woff2"), "x".repeat(4000));
      const web = createApp({ config: { port: 0, version: "1" }, webDist: dir });
      const get = (path: string, encoding?: string) =>
        web.request(path, { headers: encoding ? { "accept-encoding": encoding } : {} });

      for (const [accept, encoding, decode] of [
        ["gzip, deflate, br, zstd", "br", brotliDecompressSync],
        ["gzip, deflate", "gzip", gunzipSync],
      ] as const) {
        for (let i = 0; i < 2; i++) {
          const res = await get("/assets/app.js", accept);
          expect(res.headers.get("content-encoding")).toBe(encoding);
          expect(res.headers.get("vary")).toBe("Accept-Encoding");
          expect(res.headers.get("cache-control")).toContain("immutable");
          const raw = Buffer.from(await res.arrayBuffer());
          expect(raw.length).toBeLessThan(js.length / 10);
          expect(decode(raw).toString()).toBe(js);
        }
      }
      const plain = await get("/assets/app.js");
      expect(plain.headers.get("content-encoding")).toBeNull();
      expect(await plain.text()).toBe(js);
      expect((await get("/assets/small.js", "br")).headers.get("content-encoding")).toBeNull();
      expect((await get("/assets/font.woff2", "br")).headers.get("content-encoding")).toBeNull();
      expect(await (await get("/route/nested", "br")).text()).toContain("Hive");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("me khi chưa có đăng nhập", () => {
  it("GET /api/v1/me trả 401", async () => {
    expect((await app.request("/api/v1/me")).status).toBe(401);
  });
});

describe("dự án và kết nối Git khi chưa đăng nhập", () => {
  it.each(["/api/v1/projects", "/api/v1/scm-connections"])("GET %s trả 401", async (path) => {
    expect((await app.request(path)).status).toBe(401);
  });
});

describe("review code khi chưa đăng nhập", () => {
  // 401 thay vì 404 chứng tỏ router codeReviews đã nối vào app.
  it.each([
    ["GET", "/api/v1/code-reviews"],
    ["GET", "/api/v1/code-reviews/count"],
    ["POST", "/api/v1/code-reviews/decide"],
    ["POST", "/api/v1/code-reviews/dry-run"],
  ])("%s %s trả 401", async (method, path) => {
    const res = await app.request(path, { method, ...(method === "POST" && { body: "{}" }) });
    expect(res.status).toBe(401);
  });
});

describe("AI SDLC khi chưa đăng nhập", () => {
  // Mỗi dòng một hàm đăng ký route của sdlc (router.ts gộp): 401 thay vì 404 chứng tỏ đã nối vào app.
  it.each([
    ["GET", "/api/v1/sdlc/modes"],
    ["GET", "/api/v1/sdlc/items"],
    ["POST", "/api/v1/sdlc/items/import"],
    ["POST", "/api/v1/sdlc/items/step"],
    ["POST", "/api/v1/sdlc/items/projects/add"],
    ["POST", "/api/v1/sdlc/contracts/create"],
    ["GET", "/api/v1/sdlc/auto-approvals"],
    ["GET", "/api/v1/sdlc/questions/count"],
    ["GET", "/api/v1/sdlc/breakdown"],
    ["POST", "/api/v1/sdlc/waves/run"],
    ["POST", "/api/v1/sdlc/overrides/create"],
    ["GET", "/api/v1/sdlc/trace"],
    ["POST", "/api/v1/sdlc/sync"],
  ])("%s %s trả 401", async (method, path) => {
    const res = await app.request(path, { method, ...(method === "POST" && { body: "{}" }) });
    expect(res.status).toBe(401);
  });
});

describe("API máy khi chưa có đăng nhập", () => {
  it("GET /api/v1/teams/{teamId}/machines trả 401", async () => {
    const res = await app.request("/api/v1/teams/00000000-0000-4000-8000-000000000000/machines");
    expect(res.status).toBe(401);
  });
});

describe("API tổ chức khi chưa có đăng nhập", () => {
  it("GET /api/v1/orgs/mine trả 401 kèm thông báo tiếng Việt", async () => {
    const res = await app.request("/api/v1/orgs/mine");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ message: "Chưa đăng nhập." });
  });
});
