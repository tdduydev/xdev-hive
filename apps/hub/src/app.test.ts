import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
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
