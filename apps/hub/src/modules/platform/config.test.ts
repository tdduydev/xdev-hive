import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig, loadDocStorageLimits, loadWordImportConfig } from "./config.ts";

describe("loadConfig: hạn mức kho tài liệu", () => {
  it("mặc định 50 MiB/file, 2 GiB/nhập, 5 GiB/tổ chức", () => {
    expect(loadConfig({}).docStorage).toEqual({
      assetMaxBytes: 50 * 1024 ** 2,
      importMaxBytes: 2 * 1024 ** 3,
      orgStorageBytes: 5 * 1024 ** 3,
    });
  });
  it("đọc riêng từng hạn mức", () => {
    expect(
      loadDocStorageLimits({
        HIVE_DOC_ASSET_MAX_BYTES: "1024",
        HIVE_DOC_IMPORT_MAX_BYTES: "2048",
        HIVE_DOC_ORG_STORAGE_BYTES: "4096",
      }),
    ).toEqual({ assetMaxBytes: 1024, importMaxBytes: 2048, orgStorageBytes: 4096 });
  });
  it.each(["HIVE_DOC_ASSET_MAX_BYTES", "HIVE_DOC_IMPORT_MAX_BYTES", "HIVE_DOC_ORG_STORAGE_BYTES"])(
    "từ chối %s sai",
    (name) => {
      for (const value of ["", "abc", "0", "-1", "1.5", "Infinity", "9007199254740992"])
        expect(() => loadConfig({ [name]: value })).toThrow(name);
    },
  );
});

describe("loadConfig: nhập Word", () => {
  it("mặc định theo plan.md mục 13", () => {
    expect(loadConfig({}).wordImport).toEqual({
      pandocPath: "pandoc",
      sofficePath: "soffice",
      docTimeoutMs: 120_000,
      maxBytes: 50 * 1024 ** 2,
      batchFiles: 100,
      batchBytes: 500 * 1024 ** 2,
      timeoutMs: 120_000,
      stagingDays: 30,
    });
  });
  it("đọc riêng từng biến", () => {
    expect(
      loadWordImportConfig({
        HIVE_PANDOC_PATH: "/opt/pandoc/bin/pandoc",
        HIVE_SOFFICE_PATH: "/usr/bin/soffice",
        HIVE_DOC_WORD_DOC_TIMEOUT_MS: "5000",
        HIVE_DOC_WORD_MAX_BYTES: "1024",
        HIVE_DOC_WORD_BATCH_FILES: "3",
        HIVE_DOC_WORD_BATCH_BYTES: "4096",
        HIVE_DOC_WORD_TIMEOUT_MS: "7000",
        HIVE_DOC_WORD_STAGING_DAYS: "7",
      }),
    ).toEqual({
      pandocPath: "/opt/pandoc/bin/pandoc",
      sofficePath: "/usr/bin/soffice",
      docTimeoutMs: 5000,
      maxBytes: 1024,
      batchFiles: 3,
      batchBytes: 4096,
      timeoutMs: 7000,
      stagingDays: 7,
    });
  });
  it("đường dẫn rỗng thì dùng mặc định", () => {
    expect(loadWordImportConfig({ HIVE_PANDOC_PATH: "", HIVE_SOFFICE_PATH: " " })).toMatchObject({
      pandocPath: "pandoc",
      sofficePath: "soffice",
    });
  });
  it.each([
    "HIVE_DOC_WORD_DOC_TIMEOUT_MS",
    "HIVE_DOC_WORD_MAX_BYTES",
    "HIVE_DOC_WORD_BATCH_FILES",
    "HIVE_DOC_WORD_BATCH_BYTES",
    "HIVE_DOC_WORD_TIMEOUT_MS",
    "HIVE_DOC_WORD_STAGING_DAYS",
  ])("từ chối %s sai", (name) => {
    for (const value of ["", "abc", "0", "-1", "1.5", "Infinity", "9007199254740992"])
      expect(() => loadConfig({ [name]: value })).toThrow(name);
  });
  it("một file không được lớn hơn cả lượt", () => {
    expect(() => loadConfig({ HIVE_DOC_WORD_MAX_BYTES: "2048", HIVE_DOC_WORD_BATCH_BYTES: "1024" })).toThrow(
      "HIVE_DOC_WORD_MAX_BYTES",
    );
  });
});

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
  it("tách vai trò theo service của compose", () => {
    expect(loadConfig({ HIVE_ROLES: "api" }).roles).toEqual(["api"]);
    expect(loadConfig({ HIVE_ROLES: " jobs " }).roles).toEqual(["jobs"]);
  });
});

describe("loadConfig: MCP qua http", () => {
  it("mặc định tắt", () => expect(loadConfig({}).mcpAllowHttp).toBe(false));
  it("chỉ bật khi HIVE_MCP_ALLOW_HTTP=1", () => {
    expect(loadConfig({ HIVE_MCP_ALLOW_HTTP: "1" }).mcpAllowHttp).toBe(true);
    expect(loadConfig({ HIVE_MCP_ALLOW_HTTP: "0" }).mcpAllowHttp).toBe(false);
  });
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

describe("loadConfig: SMTP nội bộ", () => {
  it("mặc định chặn và chỉ bật khi HIVE_NOTIFY_ALLOW_PRIVATE=1", () => {
    expect(loadConfig({}).notifyAllowPrivate).toBe(false);
    expect(loadConfig({ HIVE_NOTIFY_ALLOW_PRIVATE: "true" }).notifyAllowPrivate).toBe(false);
    expect(loadConfig({ HIVE_NOTIFY_ALLOW_PRIVATE: "1" }).notifyAllowPrivate).toBe(true);
  });
});

describe("loadConfig: kết nối ra của CI/CD", () => {
  it("mặc định tắt và chỉ bật khi HIVE_DELIVERY_OUTBOUND=1", () => {
    expect(loadConfig({}).deliveryOutbound).toBe(false);
    expect(loadConfig({ HIVE_DELIVERY_OUTBOUND: "true" }).deliveryOutbound).toBe(false);
    expect(loadConfig({ HIVE_DELIVERY_OUTBOUND: "1" }).deliveryOutbound).toBe(true);
  });
});

describe("loadConfig: Telegram long polling", () => {
  it("mặc định dùng webhook; chuẩn hoá UUID và bỏ ID trùng", () => {
    const id = "abcdef01-2345-6789-abcd-ef0123456789";
    expect(loadConfig({}).telegramPollingBotIds).toEqual([]);
    expect(loadConfig({ HIVE_TELEGRAM_POLL_BOT_IDS: ` ${id.toUpperCase()},,${id}` }).telegramPollingBotIds).toEqual([
      id,
    ]);
  });
  it("từ chối danh sách ID sai", () => {
    expect(() => loadConfig({ HIVE_TELEGRAM_POLL_BOT_IDS: "không-phải-uuid" })).toThrow(/HIVE_TELEGRAM_POLL_BOT_IDS/);
  });
});
