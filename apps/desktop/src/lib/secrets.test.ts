import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkSecretName,
  checkSecretValue,
  type DeleteResult,
  formatWhen,
  type GrantEntry,
  isMissingValue,
  SECRET_VALUE_MAX_BYTES,
  type SecretItem,
  type SecretsList,
  type StoreStatus,
  secretApprovals,
  secretApprove,
  secretAssign,
  secretCopy,
  secretDelete,
  secretReveal,
  secretSave,
  secretsFilterFromHash,
  secretsHash,
  secretsList,
  secretsLog,
  secretsLogClear,
  secretsPurge,
  secretsStatus,
  storeUsable,
} from "@/lib/secrets.ts";

// Cùng fixture với test của worker (worker/internal/secretstore/testdata/cli): đổi JSON của worker mà không đổi kiểu ở
// đây thì test này đỏ, kịp trước khi màn hiện sai.
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(resolve(process.cwd(), "../../worker/internal/secretstore/testdata/cli", name), "utf8")) as T;

interface Call {
  command: string;
  args?: Record<string, unknown> | undefined;
}

function fakeTauri(reply: (command: string) => unknown): Call[] {
  const calls: Call[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return reply(command) as T;
      },
    },
  };
  return calls;
}

describe("kiểu theo fixture của worker", () => {
  it("danh sách: tên, mô tả, dự án gắn, danh sách tên dành riêng", async () => {
    const list = fixture<SecretsList>("list.json");
    const calls = fakeTauri(() => list);
    const got = await secretsList();
    expect(got.secrets.map((s) => s.name)).toEqual(["DATABASE_URL", "SENTRY_DSN", "STRIPE_TEST_KEY"]);
    expect(got.secrets[0]?.projects.map((p) => p.localId)).toEqual(["1111111111111111", "2222222222222222"]);
    expect(got.secrets.map((s) => s.allProjects)).toEqual([false, true, false]);
    // Bí mật dùng chung liệt kê mọi dự án trên máy, dù danh mục không giữ gán riêng.
    expect(got.secrets[1]?.projects.map((p) => p.localId)).toEqual(["1111111111111111", "2222222222222222"]);
    expect(got.reserved.exact).toContain("PATH");
    expect(got.reserved.prefixes).toContain("HIVE_");
    expect(calls).toEqual([{ command: "secrets_list", args: undefined }]);
  });

  it("lọc theo dự án gửi đúng tên tham số", async () => {
    const calls = fakeTauri(() => fixture<SecretsList>("list.json"));
    await secretsList("1111111111111111");
    expect(calls[0]).toEqual({ command: "secrets_list", args: { project: "1111111111111111" } });
  });

  it("trạng thái kho không dùng được: kèm lý do tiếng Việt", async () => {
    fakeTauri(() => fixture<StoreStatus>("status.json"));
    const status = await secretsStatus();
    expect(status.available).toBe(false);
    expect(status.locked).toBeNull();
    expect(status.reason).toMatch(/Secret Service/);
    expect(storeUsable(status)).toBe(false);
  });

  it("nhật ký: tên đã xoá và giá trị lộ ra output đi theo từng tên", async () => {
    fakeTauri(() => fixture<{ entries: GrantEntry[] }>("log.json"));
    const { entries } = await secretsLog({ project: "3f9a1c0e7b2d4a55", limit: 50 });
    expect(entries[0]).toMatchObject({
      kind: "run",
      projectName: "shop-api",
      names: [{ name: "STRIPE_TEST_KEY", deleted: false, leaked: true }],
    });
  });

  it("mục lưu và kết quả xoá", async () => {
    const item = fixture<SecretItem>("item.json");
    const del = fixture<DeleteResult>("delete.json");
    const calls = fakeTauri((c) => (c === "secret_delete" ? del : item));
    expect((await secretSave({ name: "STRIPE_TEST_KEY", description: "", value: "x" })).projects).toEqual([]);
    expect(await secretDelete("STRIPE_TEST_KEY")).toEqual({ deleted: "STRIPE_TEST_KEY", inUse: false });
    expect(calls.map((c) => c.command)).toEqual(["secret_save", "secret_delete"]);
  });
});

describe("lệnh Tauri", () => {
  it("gửi đúng tên lệnh và tham số camelCase", async () => {
    const calls = fakeTauri(() => null);
    await secretAssign("DATABASE_URL", "1111", true);
    await secretSave({ name: "SENTRY_DSN", description: "", projects: [], allProjects: true });
    await secretsPurge({ all: true });
    await secretsPurge({ project: "1111" });
    await secretsLogClear();
    await secretApprovals();
    await secretApprove("a1", false);
    expect(calls).toEqual([
      { command: "secret_assign", args: { name: "DATABASE_URL", project: "1111", assigned: true } },
      { command: "secret_save", args: { name: "SENTRY_DSN", description: "", projects: [], allProjects: true } },
      { command: "secrets_purge", args: { all: true } },
      { command: "secrets_purge", args: { project: "1111" } },
      { command: "secrets_log_clear", args: undefined },
      { command: "secret_approvals", args: undefined },
      { command: "secret_approve", args: { id: "a1", allow: false } },
    ]);
  });

  it("sao chép chỉ gửi tên: giá trị không đi qua giao diện", async () => {
    const calls = fakeTauri(() => null);
    await secretCopy("DATABASE_URL");
    expect(calls).toEqual([{ command: "secret_copy", args: { name: "DATABASE_URL" } }]);
  });

  it("hiện giá trị chỉ lấy khi gọi, trả về chuỗi nguyên văn", async () => {
    const calls = fakeTauri(() => "gia-tri-gia-12345678");
    expect(await secretReveal("DATABASE_URL")).toBe("gia-tri-gia-12345678");
    expect(calls).toEqual([{ command: "secret_reveal", args: { name: "DATABASE_URL" } }]);
  });

  it("ngoài app Tauri thì từ chối bằng thông báo tiếng Việt", async () => {
    await expect(secretsStatus()).rejects.toThrow(/app xDev Hive/);
  });
});

describe("kiểm giá trị", () => {
  it("theo giới hạn của worker", () => {
    expect(checkSecretValue("1234567")).toBe("short");
    expect(checkSecretValue("12345678")).toBeNull();
    // 8 ký tự có dấu là đủ dù UTF-16 hay byte dài hơn.
    expect(checkSecretValue("ặặặặặặặặ")).toBeNull();
    expect(checkSecretValue("😀😀😀😀")).toBe("short");
    expect(checkSecretValue("a".repeat(SECRET_VALUE_MAX_BYTES))).toBeNull();
    expect(checkSecretValue("a".repeat(SECRET_VALUE_MAX_BYTES + 1))).toBe("long");
    expect(checkSecretValue("abcd\0efgh")).toBe("nul");
  });
});

describe("kiểm tên", () => {
  it("chuẩn hoá in hoa rồi kiểm cú pháp và tên dành riêng", () => {
    expect(checkSecretName("  stripe_key ")).toEqual({ name: "STRIPE_KEY", problem: null });
    expect(checkSecretName("").problem).toBe("empty");
    expect(checkSecretName("1abc").problem).toBe("syntax");
    expect(checkSecretName("có dấu").problem).toBe("syntax");
    expect(checkSecretName("a".repeat(65)).problem).toBe("syntax");
    expect(checkSecretName("path").problem).toBe("reserved");
    expect(checkSecretName("hive_token").problem).toBe("reserved");
    expect(checkSecretName("MY_ANTHROPIC_KEY").problem).toBeNull();
  });
});

describe("trạng thái", () => {
  it("kho khoá hay không có thì không dùng được; chưa biết thì cho dùng", () => {
    const ok: StoreStatus = { available: true, locked: false, backend: "keychain", reason: "" };
    expect(storeUsable(ok)).toBe(true);
    expect(storeUsable({ ...ok, locked: true })).toBe(false);
    expect(storeUsable({ ...ok, available: false })).toBe(false);
    expect(storeUsable(undefined)).toBe(true);
  });

  it("thiếu giá trị trong kho: chỉ khi worker báo rõ", () => {
    const item = fixture<SecretItem>("item.json");
    expect(isMissingValue(item)).toBe(false);
    expect(isMissingValue({ ...item, missingInStore: true })).toBe(true);
  });
});

describe("địa chỉ và ngày giờ", () => {
  it("địa chỉ lọc theo dự án đi và về nguyên vẹn", () => {
    expect(secretsHash()).toBe("#/secrets");
    expect(secretsHash("1111111111111111")).toBe("#/secrets/1111111111111111");
    expect(secretsFilterFromHash("#/secrets/1111111111111111")).toBe("1111111111111111");
    expect(secretsFilterFromHash("#/secrets")).toBe("");
    expect(secretsFilterFromHash("#/secrets/%E0%A4%A")).toBe("");
  });

  it("ngày giờ theo ngôn ngữ; chuỗi lạ giữ nguyên", () => {
    expect(formatWhen("2026-10-23T08:01:02Z", "en")).toMatch(/2026/);
    expect(formatWhen("hôm qua", "vi")).toBe("hôm qua");
  });
});
