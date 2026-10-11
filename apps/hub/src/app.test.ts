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

describe("me khi chưa có đăng nhập", () => {
  it("GET /api/v1/me trả 401", async () => {
    expect((await app.request("/api/v1/me")).status).toBe(401);
  });
});
