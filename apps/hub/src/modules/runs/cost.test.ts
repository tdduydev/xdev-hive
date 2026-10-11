import { describe, expect, it } from "vitest";
import { jobBudget, parseCostData } from "./cost.ts";

describe("jobBudget", () => {
  it("không đặt trần thì spec không có budget", () => {
    expect(jobBudget(undefined, 0)).toBeUndefined();
    expect(jobBudget({}, 0)).toBeUndefined();
  });

  it("trần USD là phần nhỏ hơn giữa perRunUsd và ngân sách task còn lại", () => {
    expect(jobBudget({ perRunUsd: 2, perTaskUsd: 5, maxTurns: 30, perRunTokens: 1000 }, 1)).toEqual({
      maxCostUsd: 2,
      maxTokens: 1000,
      maxTurns: 30,
    });
    expect(jobBudget({ perRunUsd: 2, perTaskUsd: 5 }, 4)?.maxCostUsd).toBeCloseTo(1, 9);
    expect(jobBudget({ perTaskUsd: 5 }, 0)).toEqual({ maxCostUsd: 5 });
  });

  it("ngân sách task đã hết thì trần gần 0 thay vì âm", () => {
    expect(jobBudget({ perTaskUsd: 1 }, 3)?.maxCostUsd).toBe(0.000001);
  });
});

describe("parseCostData", () => {
  it("nhận gói của worker Go, kể cả trường null", () => {
    const data = {
      inputTokens: 4,
      outputTokens: 78,
      cacheReadTokens: 29948,
      cacheWriteTokens: 9977,
      costUsd: 0.0873816,
      turns: 2,
      model: "claude-opus-5-5",
    };
    expect(parseCostData(data)).toEqual(data);
    expect(parseCostData({ ...data, costUsd: null, turns: null, model: null })).not.toBeNull();
  });

  it("bỏ gói sai dạng", () => {
    expect(parseCostData({ inputTokens: 1 })).toBeNull();
    expect(parseCostData({ inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });
});
