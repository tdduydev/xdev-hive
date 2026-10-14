import { SKILL_LEARNING_MAX_PER_RUN } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { costLabel, renderDigest, skillProposalPrompt, type TaskDigest } from "./digest.ts";
import { retriesOf, scoreOf } from "./select.ts";

const digest: TaskDigest = {
  taskKey: "HD-12",
  title: "Sửa làm tròn hoá đơn",
  body: "Tổng hoá đơn lệch một đồng khi chia nhóm",
  triggers: ["retries", "cost"],
  retries: 3,
  cost: "1.20 USD",
  attempts: [{ state: "failed", problems: ["Test hoá đơn lỗi: 100.01 != 100.00"] }],
  notes: ["Chuyển sang số nguyên đơn vị xu rồi chia dư vào dòng cuối."],
  commands: ["pnpm --filter hub test invoice"],
  runIds: ["r1", "r2"],
};

describe("tóm tắt run cho agent", () => {
  it("nêu lý do đáng học, lỗi, cách sửa và lệnh nhưng không có transcript", () => {
    const text = renderDigest(digest, 1);
    expect(text).toContain("### 1. HD-12");
    expect(text).toContain("thử lại nhiều lần; chi phí vượt p90 của dự án");
    expect(text).toContain("Test hoá đơn lỗi");
    expect(text).toContain("Chuyển sang số nguyên");
    expect(text).toContain("`pnpm --filter hub test invoice`");
  });

  it("cắt cứng mục dài để lời nhắc không phình", () => {
    const long = "x".repeat(5000);
    const text = renderDigest({ ...digest, body: long, notes: [long] }, 1);
    expect(text.length).toBeLessThan(1800);
  });
});

describe("lời nhắc", () => {
  const base = { projectKey: "hd", digests: [digest], existing: [], rejected: [], limit: 5 };

  it("giới hạn số đề xuất theo hạn mức còn lại và trần mỗi run", () => {
    expect(skillProposalPrompt(base)).toContain(`Tối đa ${SKILL_LEARNING_MAX_PER_RUN} đề xuất`);
    expect(skillProposalPrompt({ ...base, limit: 1 })).toContain("Tối đa 1 đề xuất");
  });

  it("liệt kê skill đang có và skill đã bị từ chối, cắt bớt khi quá dài", () => {
    const existing = Array.from({ length: 80 }, (_, i) => ({ name: `skill-${i}`, description: `mô tả ${i}` }));
    const text = skillProposalPrompt({ ...base, existing, rejected: [{ name: "da-tu-choi", description: "x" }] });
    expect(text).toContain("- skill-0:");
    expect(text).not.toContain("- skill-70:");
    expect(text).toContain("và 20 skill khác");
    expect(text).toContain("da-tu-choi");
  });

  it("dặn gọi tool nộp và chế độ chỉ đọc", () => {
    const text = skillProposalPrompt(base);
    expect(text).toContain("skill_proposal_submit");
    expect(text).toContain("không sửa file, không commit");
  });
});

describe("chọn ứng viên", () => {
  it("số lần thử lại lấy lớn hơn của lần thử hạ tầng và lần chạy lại task", () => {
    expect(retriesOf(1, 1)).toBe(0);
    expect(retriesOf(3, 1)).toBe(2);
    expect(retriesOf(1, 4)).toBe(3);
  });

  it("đánh dấu tay đứng trước, rồi tới nhiều lý do", () => {
    expect(scoreOf(["marked"], 0, 0)).toBeGreaterThan(scoreOf(["retries", "cost"], 9, 5));
    expect(scoreOf(["retries", "cost"], 2, 2)).toBeGreaterThan(scoreOf(["retries"], 2, 0));
  });

  it("chi phí hiển thị USD nếu có, không thì token", () => {
    expect(costLabel(1.234, 5)).toBe("1.23 USD");
    expect(costLabel(null, 85_000)).toBe("85k token");
    expect(costLabel(null, 0)).toBeNull();
  });
});
