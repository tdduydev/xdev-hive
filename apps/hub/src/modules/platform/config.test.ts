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

describe("loadConfig: người tạo tổ chức", () => {
  it("tách danh sách email, bỏ khoảng trắng, chữ thường", () =>
    expect(loadConfig({ HIVE_ORG_CREATORS: " A@x.vn, ,b@y.vn" }).orgCreators).toEqual(["a@x.vn", "b@y.vn"]));
  it("không đặt thì rỗng", () => expect(loadConfig({}).orgCreators).toEqual([]));
});

describe("loadConfig: embeddings", () => {
  it("không đặt URL thì không có", () => expect(loadConfig({}).embeddings).toBeUndefined());
  it("mặc định mô hình text-embedding-3-small, bỏ / cuối URL", () =>
    expect(
      loadConfig({ HIVE_EMBEDDINGS_URL: "https://api.openai.com/v1/", HIVE_EMBEDDINGS_API_KEY: "k" }).embeddings,
    ).toEqual({
      url: "https://api.openai.com/v1",
      apiKey: "k",
      model: "text-embedding-3-small",
      dimensions: undefined,
    }));
  it("báo lỗi số chiều sai", () =>
    expect(() =>
      loadConfig({ HIVE_EMBEDDINGS_URL: "http://ollama:11434/v1", HIVE_EMBEDDINGS_DIMENSIONS: "-3" }),
    ).toThrow(/HIVE_EMBEDDINGS_DIMENSIONS/));
});

describe("loadConfig: thông báo máy offline", () => {
  it("mặc định chờ 300 giây; đọc thời gian cấu hình", () => {
    expect(loadConfig({}).machineOfflineNotifySec).toBe(300);
    expect(loadConfig({ HIVE_MACHINE_OFFLINE_NOTIFY_SEC: "120" }).machineOfflineNotifySec).toBe(120);
  });
  it.each(["", "abc", "0", "-1", "1.5", "Infinity"])("từ chối thời gian sai: %s", (value) => {
    expect(() => loadConfig({ HIVE_MACHINE_OFFLINE_NOTIFY_SEC: value })).toThrow(/HIVE_MACHINE_OFFLINE_NOTIFY_SEC/);
  });
});
