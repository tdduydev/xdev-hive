import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("mặc định cổng 3000", () => expect(loadConfig({}).port).toBe(3000));
  it("báo lỗi cổng sai", () => expect(() => loadConfig({ HIVE_PORT: "abc" })).toThrow(/HIVE_PORT/));
});

describe("loadConfig: đăng nhập", () => {
  it("đòi secret đủ dài khi bật đăng nhập", () =>
    expect(() => loadConfig({ HIVE_DATABASE_AUTH_URL: "postgres://x", HIVE_AUTH_SECRET: "ngan" })).toThrow(/32 ký tự/));
  it("đòi đủ cặp client id/secret", () =>
    expect(() => loadConfig({ HIVE_GITHUB_CLIENT_ID: "a" })).toThrow(/HIVE_GITHUB_CLIENT_SECRET/));
  it("không cấu hình GitHub thì bỏ qua", () => expect(loadConfig({}).github).toBeUndefined());
});

describe("loadConfig: khoá chủ và vai trò", () => {
  it("đọc HIVE_MASTER_KEY base64 32 byte", () => {
    expect(loadConfig({ HIVE_MASTER_KEY: randomBytes(32).toString("base64") }).masterKey?.key).toHaveLength(32);
  });
  it("báo lỗi khoá sai độ dài", () => expect(() => loadConfig({ HIVE_MASTER_KEY: "YWJj" })).toThrow(/32 byte/));
  it("mặc định chạy cả api và jobs", () => expect(loadConfig({}).roles).toEqual(["api", "jobs"]));
  it("từ chối vai trò lạ", () => expect(() => loadConfig({ HIVE_ROLES: "api,gw" })).toThrow(/gw/));
});
