import { describe, expect, it } from "vitest";
import {
  formatAgo,
  formatCacheHit,
  formatDay,
  formatDayTime,
  formatDuration,
  formatInt,
  formatPercent,
  formatUsd,
} from "@/lib/format.ts";

describe("formatDay", () => {
  it("ngày/tháng/năm", () => expect(formatDay("2026-10-11T12:00:00.000Z")).toBe("11/10/2026"));
  it("chuỗi hỏng thì gạch ngang", () => expect(formatDay("không phải ngày")).toBe("—"));
  it("giờ và ngày của mốc bắt đầu", () =>
    // Ghép giờ theo máy người xem nên chỉ kiểm dạng.
    expect(formatDayTime("2026-10-11T07:02:00.000Z")).toMatch(/^\d{2}:\d{2}, \d{2}\/10$/));
});

describe("số và tiền", () => {
  it("USD hai chữ số thập phân, dấu phẩy", () => expect(formatUsd(0.4234)).toBe("0,42 USD"));
  it("tỉ lệ làm tròn thành phần trăm nguyên", () => {
    expect(formatPercent(0.394)).toBe("39%");
    expect(formatPercent(1)).toBe("100%");
  });
  it("không báo USD thì gạch ngang", () => expect(formatUsd(null)).toBe("—"));
  it("số nguyên ngăn nghìn bằng dấu chấm", () => expect(formatInt(182400)).toBe("182.400"));
});

describe("formatCacheHit", () => {
  it("đọc cache chia tổng token vào, một chữ số thập phân", () => expect(formatCacheHit(9_730, 200, 70)).toBe("97,3%"));
  it("không có token vào thì gạch ngang", () => expect(formatCacheHit(0, 0, 0)).toBe("—"));
  it("cache trượt hoàn toàn là 0%", () => expect(formatCacheHit(0, 500, 20)).toBe("0,0%"));
});

describe("formatDuration", () => {
  it.each([
    [45_000, "45 giây"],
    [372_000, "6 phút 12 giây"],
    [360_000, "6 phút"],
    [3_900_000, "1 giờ 5 phút"],
    [7_200_000, "2 giờ"],
    [-5, "0 giây"],
  ])("%d ms → %s", (ms, text) => expect(formatDuration(ms)).toBe(text));
});

describe("formatAgo", () => {
  const now = Date.parse("2026-10-11T12:00:00.000Z");
  it.each([
    ["2026-10-11T11:59:30.000Z", "vừa xong"],
    ["2026-10-11T11:48:00.000Z", "12 phút trước"],
    ["2026-10-11T09:00:00.000Z", "3 giờ trước"],
    ["2026-10-10T08:00:00.000Z", "hôm qua"],
    ["2026-10-01T12:00:00.000Z", "01/10/2026"],
  ])("%s → %s", (iso, text) => expect(formatAgo(iso, now)).toBe(text));
});
