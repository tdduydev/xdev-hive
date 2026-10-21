import { describe, expect, it } from "vitest";
import {
  formatCriterionValue,
  formatPoints,
  formatScore,
  levelTone,
  statusTone,
  trendPoints,
} from "@/lib/token-score.ts";

describe("điểm token", () => {
  it("điểm làm tròn số nguyên, không có điểm là gạch ngang", () => {
    expect(formatScore(81.6)).toBe("82");
    expect(formatScore(null)).toBe("—");
    expect(formatScore(undefined)).toBe("—");
  });

  it("mức và trạng thái theo tông của Pill", () => {
    expect(levelTone("good")).toBe("ok");
    expect(levelTone("fair")).toBe("warn");
    expect(levelTone("low")).toBe("bad");
    expect(levelTone(null)).toBe("neutral");
    expect(statusTone("partial")).toBe("warn");
    expect(statusTone("unsupported")).toBe("neutral");
  });

  it("giá trị đo kèm đơn vị, % dính liền số", () => {
    expect(formatCriterionValue(42.25, "%")).toBe("42,3%");
    expect(formatCriterionValue(18000, "tokens")).toBe("18.000 tokens");
    expect(formatCriterionValue(3, undefined)).toBe("3");
    expect(formatCriterionValue(undefined, "%")).toBe("—");
    expect(formatPoints(7.5, 10)).toBe("7,5/10");
  });

  it("đường xu hướng theo thời gian thật, bỏ lần gửi không có điểm", () => {
    const points = trendPoints(
      [
        { reportedAt: "2026-10-01T00:00:00.000Z", score: 50, coverage: 80 },
        { reportedAt: "2026-10-02T00:00:00.000Z", score: null, coverage: 20 },
        { reportedAt: "2026-10-05T00:00:00.000Z", score: 100, coverage: 90 },
      ],
      100,
      50,
    );
    expect(points.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: 25 },
      { x: 100, y: 0 },
    ]);
    expect(trendPoints([{ reportedAt: "2026-10-01T00:00:00.000Z", score: 0, coverage: 50 }], 100, 50)).toEqual([
      { x: 50, y: 50, at: "2026-10-01T00:00:00.000Z", score: 0 },
    ]);
    expect(trendPoints([], 100, 50)).toEqual([]);
  });
});
