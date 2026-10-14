import { describe, expect, it } from "vitest";
import { clip, forChat, redactSecrets, stripCode } from "./sanitize.ts";

describe("redactSecrets", () => {
  it.each([
    ["token bot Telegram", "gửi 123456789:ABCdefGhIJKlmnOPQrstUVwxyz0123456789 nhé"],
    ["Slack bot token", "xoxb-1234567890-abcdefghij"],
    ["token máy của hub", "hwm_abcdefgh12345678"],
    ["token cá nhân", "hive_pat_abcdefgh12345678"],
    ["khoá kiểu sk-", "sk-abcdefghijklmnopqrstuvwxyz"],
    ["GitHub PAT", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitLab PAT", "glpat-abcdefghijklmnopqrst"],
    ["AWS key", "AKIAIOSFODNN7EXAMPLE"],
    ["Bearer", "Authorization: Bearer abcdefghijklmnop.qrstuvwxyz"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk"],
  ])("che %s", (_name, secret) => {
    const out = redactSecrets(`trước ${secret} sau`);
    expect(out).toContain("***");
    expect(out).not.toContain(secret.replace(/^Authorization: /, ""));
  });

  it("che giá trị sau password/token/api_key nhưng giữ tên trường", () => {
    expect(redactSecrets("password: hunter2hunter2")).toBe("password: ***");
    expect(redactSecrets('{"api_key":"abcd1234efgh"}')).toBe('{"api_key":"***"}');
    expect(redactSecrets("DB_TOKEN=abcdef123456")).toContain("***");
  });

  it("che khoá riêng PEM kể cả khi chưa đóng", () => {
    const out = redactSecrets("a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nxyz");
    expect(out).toBe("a\n***");
  });

  it("không đụng vào chữ thường", () => {
    const text = "Run PAY-12 thất bại ở bước kiểm tra, xem log trên web.";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("stripCode", () => {
  it("thay khối code bằng lời nhắc xem trên web, kể cả khối chưa đóng", () => {
    expect(stripCode("a\n```ts\nconst x = 1;\n```\nb")).toBe("a\n[đoạn code đã ẩn, xem trên web]\nb");
    expect(stripCode("a\n```\nchưa đóng\nvẫn code")).toBe("a\n[đoạn code đã ẩn, xem trên web]");
  });

  it("bỏ diff dán nguyên văn", () => {
    expect(stripCode("Kết quả:\ndiff --git a/x b/x\n+++ b/x\n+dòng mới")).toBe(
      "Kết quả:\n[đoạn code đã ẩn, xem trên web]",
    );
  });
});

describe("forChat", () => {
  it("bỏ code trước nên bí mật trong code mất theo, rồi cắt độ dài", () => {
    const out = forChat("Xong.\n```\nTOKEN=abcdefghijkl\n```\n" + "x".repeat(2000), 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toContain("[đoạn code đã ẩn");
    expect(out).not.toContain("abcdefghijkl");
    expect(out.endsWith("…")).toBe(true);
  });

  it("gọn dòng trống thừa", () => {
    expect(forChat("a\n\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("clip", () => {
  it("giữ nguyên chuỗi ngắn", () => {
    expect(clip("abc", 3)).toBe("abc");
    expect(clip("abcd", 3)).toBe("ab…");
  });
});
