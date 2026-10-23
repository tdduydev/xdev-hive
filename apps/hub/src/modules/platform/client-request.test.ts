import { afterEach, describe, expect, it, vi } from "vitest";
import { missingKeyCounts, noteMissingKey, readClientRequest, withMetaKey } from "./client-request.ts";

const KEY = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const MACHINE = "5B1C2D3E-4F50-4a6b-8c7d-9e0f1a2b3c4d";

describe("đọc header sự kiện client", () => {
  it("đọc đủ khoá, nguồn, máy, giờ tạo và client", () => {
    const request = readClientRequest(
      new Headers({
        "Idempotency-Key": KEY,
        "X-Hive-Source": "mcp-local",
        "X-Hive-Machine": MACHINE,
        "X-Hive-Created-At": "2026-10-20T08:00:00.000Z",
        "X-Hive-Client": "hive-cli/1.4.0",
      }),
    );
    expect(request).toEqual({
      key: KEY,
      invalidKey: false,
      source: "mcp-local",
      machineId: MACHINE.toLowerCase(),
      clientCreatedAt: new Date("2026-10-20T08:00:00.000Z"),
      client: "hive-cli/1.4.0",
    });
  });

  it("client cũ không gửi gì thì không có khoá, nguồn unknown, lấy User-Agent", () => {
    const request = readClientRequest(new Headers({ "User-Agent": "claude-code/2.1" }));
    expect(request).toEqual({
      key: undefined,
      invalidKey: false,
      source: "unknown",
      machineId: undefined,
      clientCreatedAt: undefined,
      client: "claude-code/2.1",
    });
  });

  it("khoá sai dạng thì báo invalidKey, header lạ thì bỏ", () => {
    const request = readClientRequest(
      new Headers({
        "Idempotency-Key": "short",
        "X-Hive-Source": "toaster",
        "X-Hive-Machine": "my-laptop",
        "X-Hive-Created-At": "yesterday",
        "X-Hive-Client": "x".repeat(300),
      }),
    );
    expect(request.key).toBeUndefined();
    expect(request.invalidKey).toBe(true);
    expect(request.source).toBe("unknown");
    expect(request.machineId).toBeUndefined();
    expect(request.clientCreatedAt).toBeUndefined();
    expect(request.client).toHaveLength(100);
  });

  it("khoá trong _meta dùng khi không có header, header thắng nếu có cả hai", () => {
    const bare = readClientRequest(new Headers());
    expect(withMetaKey(bare, KEY).key).toBe(KEY);
    expect(withMetaKey(bare, 42).invalidKey).toBe(true);
    expect(withMetaKey(bare, undefined)).toBe(bare);
    const header = readClientRequest(new Headers({ "Idempotency-Key": KEY }));
    expect(withMetaKey(header, "khac-khoa-0123456789").key).toBe(KEY);
  });
});

describe("đếm lần ghi thiếu khoá", () => {
  afterEach(() => vi.restoreAllMocks());

  it("cảnh báo một lần mỗi client mỗi ngày", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const day = new Date("2026-10-21T01:00:00Z");
    noteMissingKey("task_update", "claude-code/2.1", day);
    noteMissingKey("doc_propose", "claude-code/2.1", day);
    noteMissingKey("task_update", undefined, day);
    expect(missingKeyCounts()).toEqual({ "claude-code/2.1": 2, unknown: 1 });
    expect(warn).toHaveBeenCalledTimes(2);

    noteMissingKey("task_update", "claude-code/2.1", new Date("2026-10-22T01:00:00Z"));
    expect(missingKeyCounts()).toEqual({ "claude-code/2.1": 1 });
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
