import { describe, expect, it } from "vitest";
import { exploreSummary } from "./summary.ts";

const run = (explore: { edited: boolean; turns: number; input: number; cacheRead: number } | null) => ({
  explore: explore && {
    edited: explore.edited,
    turns: explore.turns,
    inputTokens: explore.input,
    outputTokens: 0,
    cacheReadTokens: explore.cacheRead,
    cacheWriteTokens: 0,
  },
  turns: 10,
  tokensIn: 1000,
  tokensOut: 0,
  cacheRead: 10_000,
  cacheWrite: 0,
  costUsd: 1,
});

describe("exploreSummary", () => {
  it("null khi không run nào có số đo", () => {
    expect(exploreSummary([])).toBeNull();
    expect(exploreSummary([run(null)])).toBeNull();
  });

  it("chia chi phí theo trọng số giá, đếm run đã sửa", () => {
    const s = exploreSummary([
      run({ edited: true, turns: 4, input: 500, cacheRead: 5000 }),
      run({ edited: false, turns: 10, input: 1000, cacheRead: 10_000 }),
    ]);
    expect(s).toEqual({
      runs: 2,
      edited: 1,
      turns: 14,
      totalTurns: 20,
      tokens: 16_500,
      totalTokens: 22_000,
      costShare: 0.75,
      costUsd: 1.5,
    });
  });

  it("số khảo sát lớn hơn tổng của run (lần thử sau có số riêng) thì không vượt 100%", () => {
    const s = exploreSummary([run({ edited: false, turns: 12, input: 2000, cacheRead: 20_000 })]);
    expect(s?.costShare).toBe(1);
    expect(s?.costUsd).toBe(1);
    expect(s?.totalTurns).toBe(12);
  });
});
