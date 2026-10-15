import { describe, expect, it } from "vitest";
import { MASK, redact } from "@/lib/redact.ts";

describe("redact", () => {
  it.each([
    ["hive_pat_org1_abcDEF123-_xyz", "PAT"],
    ["hwm_abcDEF123-_xyz", "token máy"],
    ["hwr_abcDEF123-_xyz", "mã đăng ký"],
  ])("che %s (%s)", (secret) => {
    const out = redact(`lỗi gọi hub với ${secret} thất bại`);
    expect(out).not.toContain(secret);
    expect(out).toContain(MASK);
  });

  it("che header Bearer và Authorization", () => {
    expect(redact("Authorization: Bearer abc.def-123")).toBe(`Authorization: Bearer ${MASK}`);
    expect(redact('{"authorization":"tok123"}')).not.toContain("tok123");
  });

  it("giữ nguyên chữ không có bí mật", () => {
    expect(redact("hub trả về 502")).toBe("hub trả về 502");
  });
});
