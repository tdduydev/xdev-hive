import { describe, expect, it } from "vitest";
import { formatBuiltAt, shortVersion } from "@/lib/build-info.ts";

describe("thông tin build", () => {
  it("SHA đầy đủ rút còn 7 ký tự, semver giữ nguyên", () => {
    expect(shortVersion("185ec21a9b0c4f5e6d7a8b9c0d1e2f3a4b5c6d7e")).toBe("185ec21");
    expect(shortVersion("185ec21")).toBe("185ec21");
    expect(shortVersion("0.2.6")).toBe("0.2.6");
  });

  it("ngày build dạng ngày/tháng/năm giờ:phút; không có thì null", () => {
    const local = new Date(2026, 9, 13, 14, 5).toISOString();
    expect(formatBuiltAt(local)).toBe("13/10/2026 14:05");
    expect(formatBuiltAt(null)).toBeNull();
    expect(formatBuiltAt("không phải ngày")).toBeNull();
  });
});
