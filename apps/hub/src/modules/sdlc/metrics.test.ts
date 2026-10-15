import { SDLC_PHASE_KINDS } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { aggregateMetrics, type MetricsData, mergeCoverage, quantiles } from "./metrics.ts";

const empty: MetricsData = {
  items: [],
  phases: [],
  questions: 0,
  reviews: [],
  humanGates: [],
  autoApprovals: [],
  coverage: [],
  prRounds: [],
  cost: null,
};

describe("quantiles", () => {
  it("nội suy như percentile_cont, không phụ thuộc thứ tự vào", () => {
    expect(quantiles([])).toEqual({ p50: null, p90: null, count: 0 });
    expect(quantiles([5])).toEqual({ p50: 5, p90: 5, count: 1 });
    expect(quantiles([10, 1, 4, 2, 3])).toEqual({ p50: 3, p90: 7.6, count: 5 });
    expect(quantiles([1, 2])).toEqual({ p50: 1.5, p90: 1.9, count: 2 });
  });
});

describe("mergeCoverage", () => {
  it("cân theo số requirement; không có hạng mục nào thì null", () => {
    expect(mergeCoverage([])).toBeNull();
    expect(
      mergeCoverage([
        { requirements: 3, planned: 100, done: 100, verified: 0 },
        { requirements: 1, planned: 0, done: 0, verified: 0 },
      ]),
    ).toEqual({ requirements: 4, planned: 75, done: 75, verified: 0 });
    expect(mergeCoverage([{ requirements: 0, planned: 0, done: 0, verified: 0 }])).toEqual({
      requirements: 0,
      planned: 0,
      done: 0,
      verified: 0,
    });
  });
});

describe("aggregateMetrics", () => {
  it("không có hạng mục: mọi loại giai đoạn có mặt, tỉ lệ null", () => {
    const m = aggregateMetrics(empty);
    expect(m.items).toBe(0);
    expect(m.leadTimeHours.map((l) => l.kind)).toEqual([...SDLC_PHASE_KINDS]);
    expect(m.leadTimeHours.every((l) => l.duration.count === 0)).toBe(true);
    expect(m).toMatchObject({
      returnRate: null,
      questionsPerItem: null,
      coverage: null,
      convergeRounds: null,
      codeReviewRoundsPerPr: null,
      costUsdPerItem: null,
      autoApproval: [],
    });
  });

  it("lead time theo loại, chờ cổng bỏ lượt tự duyệt, trả lại, tự duyệt và thu hồi theo chế độ và dự án", () => {
    const m = aggregateMetrics({
      ...empty,
      items: [
        { modeRef: "speckit", convergeRound: 2 },
        { modeRef: "speckit", convergeRound: 0 },
        { modeRef: "kiro-requirements", convergeRound: 1 },
        { modeRef: "speckit", convergeRound: 0 },
      ],
      phases: [
        { kind: "requirements", hours: 2 },
        { kind: "requirements", hours: 6 },
        { kind: "design", hours: 10 },
        { kind: "khác", hours: 99 },
      ],
      questions: 6,
      reviews: [
        { status: "approved" },
        { status: "changes_requested" },
        { status: "approved" },
        { status: "in_review" },
      ],
      humanGates: [
        { modeRef: "speckit", projectKey: "pay", status: "passed", auto: false, hours: 4 },
        { modeRef: "speckit", projectKey: "pay", status: "passed", auto: true, hours: 0 },
        { modeRef: "speckit", projectKey: "pay", status: "failed", auto: false, hours: 8 },
        { modeRef: "speckit", projectKey: "web", status: "waiting", auto: false, hours: null },
        { modeRef: "kiro-requirements", projectKey: "pay", status: "passed", auto: false, hours: 1 },
      ],
      autoApprovals: [
        { modeRef: "speckit", projectKey: "pay", revoked: true },
        { modeRef: "speckit", projectKey: "pay", revoked: false },
      ],
      coverage: [{ requirements: 2, planned: 100, done: 50, verified: 50 }],
      prRounds: [1, 3],
      cost: { usd: 3, items: 4 },
    });
    expect(m.items).toBe(4);
    expect(m.leadTimeHours.find((l) => l.kind === "requirements")?.duration).toEqual({ p50: 4, p90: 5.6, count: 2 });
    expect(m.leadTimeHours.find((l) => l.kind === "design")?.duration).toEqual({ p50: 10, p90: 10, count: 1 });
    expect(m.leadTimeHours.some((l) => (l.kind as string) === "khác")).toBe(false);
    expect(m.gateWaitHours).toEqual({ p50: 4, p90: 7.2, count: 3 });
    expect(m.returnRate).toBe(0.333);
    expect(m.questionsPerItem).toBe(1.5);
    expect(m.coverage).toEqual({ requirements: 2, planned: 100, done: 50, verified: 50 });
    expect(m.convergeRounds).toBe(1.5);
    expect(m.codeReviewRoundsPerPr).toBe(2);
    expect(m.costUsdPerItem).toBe(0.75);
    expect(m.autoApproval).toEqual([
      { modeRef: "kiro-requirements", projectKey: "pay", autoRate: 0, revokeRate: null },
      { modeRef: "speckit", projectKey: "pay", autoRate: 0.5, revokeRate: 0.5 },
    ]);
  });
});
