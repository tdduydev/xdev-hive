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

describe("loadConfig: người tạo tổ chức", () => {
  it("tách danh sách email, bỏ khoảng trắng, chữ thường", () =>
    expect(loadConfig({ HIVE_ORG_CREATORS: " A@x.vn, ,b@y.vn" }).orgCreators).toEqual(["a@x.vn", "b@y.vn"]));
  it("không đặt thì rỗng", () => expect(loadConfig({}).orgCreators).toEqual([]));
});
