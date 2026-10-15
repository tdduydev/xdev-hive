import { describe, expect, it, vi } from "vitest";
import { secretKey, TokenStore } from "@/auth/store.ts";
import { secrets, token } from "@/auth/test-support.ts";

const hub = "https://hive.example";
describe("kho token hai tầng", () => {
  it("không có hive thì dùng SecretStorage", async () => {
    const secret = secrets();
    const run = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const store = new TokenStore(secret, run, () => "missing-hive");
    await store.write(hub, token);
    expect(await store.read(hub)).toBe(token);
    expect(secret.data.get(secretKey(hub))).toBe(token);
  });

  it("ưu tiên CLI; store chỉ đưa token qua stdin, ghi cả hai kho", async () => {
    const secret = secrets();
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify({ hubUrl: hub, token }), stderr: "" });
    const store = new TokenStore(secret, run, () => "hive");
    expect(await store.read(hub)).toBe(token);
    await store.write(hub, token);
    expect(run).toHaveBeenLastCalledWith("hive", ["auth", "store", "--json", "--hub", hub], {
      input: token,
      timeoutMs: 10_000,
    });
    expect(secret.data.get(secretKey(hub))).toBe(token);
    expect(run.mock.calls.every((call) => !JSON.stringify(call[1]).includes(token))).toBe(true);
  });

  it("đăng xuất riêng editor không gọi logout và không đọc lại keychain", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify({ hubUrl: hub, token }), stderr: "" });
    const secret = secrets();
    const store = new TokenStore(secret, run, () => "hive");
    await store.remove(hub);
    expect(await store.read(hub)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    await store.write(hub, token);
    expect(await store.read(hub)).toBe(token);
    await store.remove(hub, true);
    expect(run).toHaveBeenLastCalledWith("hive", ["auth", "logout", "--json", "--hub", hub], { timeoutMs: 10_000 });
  });

  it("CLI thoát 3 không dùng lại token cũ; lỗi ghi không bị nuốt", async () => {
    const secret = secrets();
    secret.data.set(secretKey(hub), token);
    const run = vi.fn().mockResolvedValue({ code: 3, stdout: "{}", stderr: token });
    const store = new TokenStore(secret, run, () => "hive");
    expect(await store.read(hub)).toBeUndefined();
    await expect(store.write(hub, token)).rejects.toThrow("thông tin đăng nhập");
    expect(secret.store).not.toHaveBeenCalled();
  });
  it("CLI cũ chưa có auth dùng kho editor, lỗi thực thi khác không bị nuốt", async () => {
    const secret = secrets();
    const run = vi.fn().mockResolvedValue({ code: 2, stdout: "", stderr: "" });
    const store = new TokenStore(secret, run, () => "hive");
    await store.write(hub, token);
    expect(await store.read(hub)).toBe(token);
    run.mockRejectedValue(new Error(`EACCES ${token}`));
    await expect(store.write(hub, token)).rejects.toThrow("thông tin đăng nhập");
    await expect(store.read(hub)).rejects.toThrow("thông tin đăng nhập");
  });
});
