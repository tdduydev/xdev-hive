import type { AiReviewerResult, ReviewGate } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { aiGateComment, reviewFocus, reviewGuidance, reviewRubric } from "./prompt.ts";

type GateAi = NonNullable<ReviewGate["ai"]>;
const ai = (extra: Partial<GateAi> = {}): GateAi => ({ checks: ["Đúng yêu cầu"], passScore: 8, ...extra }) as GateAi;
const gate = (paths?: string[]) =>
  ({
    id: "ai",
    name: "Review AI",
    kind: "ai",
    ai: ai(),
    conditions: { docTypes: [], keywords: [], minChangedLines: null, skipFormattingOnly: false, paths },
  }) as unknown as ReviewGate;

const reviewer = (extra: Partial<AiReviewerResult> = {}): AiReviewerResult => ({
  cli: "claude",
  model: null,
  runId: null,
  state: "done",
  score: 9,
  passed: true,
  summary: "Ổn.",
  findings: [],
  checklist: [],
  error: null,
  ...extra,
});

describe("reviewRubric", () => {
  it("bỏ mục rỗng, gộp khoảng trắng, bỏ trùng không phân biệt hoa thường, giữ thứ tự", () => {
    expect(reviewRubric(ai({ checks: ["  Có  test ", "Đúng yêu cầu", "có test", " "] }))).toEqual([
      "Có test",
      "Đúng yêu cầu",
    ]);
  });
});

describe("reviewFocus", () => {
  it("lấy điều kiện đường dẫn của checkpoint; không có là cả diff", () => {
    expect(reviewFocus(gate(["src/**", " src/** ", "db/*.sql"]))).toEqual(["src/**", "db/*.sql"]);
    expect(reviewFocus(gate())).toEqual([]);
  });
});

describe("reviewGuidance", () => {
  it("nêu ngưỡng; avg ghi rõ tính trên điểm trung bình", () => {
    expect(reviewGuidance(ai())).toHaveLength(1);
    expect(reviewGuidance(ai())[0]).toContain("8/10");
    expect(reviewGuidance(ai())[0]).not.toContain("trung bình");
    expect(reviewGuidance(ai({ aggregate: "avg" }))[0]).toContain("điểm trung bình");
  });

  it("blockOn nêu đúng các mức chặn", () => {
    expect(reviewGuidance(ai({ blockOn: "critical" }))[1]).toContain("mức critical chặn");
    expect(reviewGuidance(ai({ blockOn: "major" }))[1]).toContain("mức critical hoặc major chặn");
  });
});

describe("aiGateComment", () => {
  const base = {
    gateName: "Review AI",
    workflowName: "Code cơ bản",
    round: 2,
    headSha: "abcdef1234567",
    passScore: 8,
    aggregate: "all" as const,
    status: "failed" as const,
    score: 7.5,
    note: "codex chấm 6/10, dưới ngưỡng 8.",
    link: "https://hive.example.com/knowledge/reviews?tab=code&id=1",
  };

  it("một bình luận cho cả checkpoint: kết luận, bảng reviewer, lý do, phát hiện, link", () => {
    const body = aiGateComment({
      ...base,
      reviewers: [
        reviewer({
          checklist: [
            { label: "Có test", passed: false, note: "Thiếu test lỗi" },
            { label: "Đúng yêu cầu", passed: true, note: null },
          ],
          findings: [{ file: "src/a.ts", line: 3, severity: "major", message: "Thiếu kiểm null" }],
        }),
        reviewer({ cli: "codex", model: "gpt-5", score: 6, passed: false, summary: null }),
        reviewer({ cli: "gemini", state: "error", score: null, passed: false, summary: null, error: "run bị huỷ" }),
      ],
    });
    expect(body).toContain("### Review AI “Review AI”: ❌ không đạt (7.5/10, ngưỡng 8 theo mọi reviewer)");
    expect(body).toContain("Quy trình Code cơ bản, vòng 2, commit `abcdef1`.");
    expect(body).toContain("| claude | 9/10 | đạt |");
    expect(body).toContain("| codex (gpt-5) | 6/10 | không đạt |");
    expect(body).toContain("| gemini | — | lỗi: run bị huỷ |");
    expect(body).toContain("**Lý do:** codex chấm 6/10");
    expect(body).toContain("- ☐ Có test: Thiếu test lỗi");
    expect(body).not.toContain("☐ Đúng yêu cầu");
    expect(body).toContain("- 🟠 lớn `src/a.ts:3`: Thiếu kiểm null");
    expect(body).toContain("[Mở phiên review trên Hive](https://hive.example.com/");
  });

  it("đạt thì không có lý do; tối đa 20 phát hiện; ô bảng không vỡ vì `|`", () => {
    const findings = Array.from({ length: 15 }, (_, i) => ({
      file: `f${i}.ts`,
      line: null,
      severity: "minor" as const,
      message: `m${i}`,
    }));
    const body = aiGateComment({
      ...base,
      status: "passed",
      score: 9,
      note: null,
      aggregate: "avg",
      link: null,
      reviewers: [reviewer({ findings }), reviewer({ cli: "codex", model: "a|b", findings })],
    });
    expect(body).toContain("✅ đạt (9/10, ngưỡng 8 theo điểm trung bình)");
    expect(body).not.toContain("Lý do");
    expect(body.match(/🟡 nhỏ/g)).toHaveLength(20);
    expect(body).toContain("… và 10 phát hiện khác");
    expect(body).toContain("| codex (a\\|b) |");
    expect(body).not.toContain("Mở phiên");
  });
});
