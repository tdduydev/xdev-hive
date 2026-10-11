import { describe, expect, it } from "vitest";
import { healthLabel } from "./health.ts";

describe("healthLabel", () => {
  it("đang tải", () => expect(healthLabel({ isPending: true })).toMatch(/Đang kết nối/));
  it("lỗi", () => expect(healthLabel({ isPending: false, error: new Error("x") })).toMatch(/Không kết nối/));
  it("có dữ liệu", () =>
    expect(
      healthLabel({ isPending: false, data: { status: "ok", version: "1.0.0", time: "2026-10-11T00:00:00Z" } }),
    ).toBe("Hub 1.0.0 đang chạy"));
});
