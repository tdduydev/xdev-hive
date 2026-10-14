import { describe, expect, it } from "vitest";
import { awaitingCount, countLabel, uniqueById } from "@/lib/code-reviews.ts";
import { NAV_GROUPS } from "@/lib/nav.ts";
import { validateReviewsSearch, validateWorkflowsSearch } from "@/lib/route-search.ts";

const ID = "4d4d4d4d-0000-4000-8000-000000000001";

describe("countLabel", () => {
  it("rút gọn số lớn để chip không giãn", () => {
    expect(countLabel(7)).toBe("7");
    expect(countLabel(99)).toBe("99");
    expect(countLabel(100)).toBe("99+");
  });
});

describe("uniqueById", () => {
  it("gộp các trang và giữ bản mới nhất của phiên trùng", () => {
    const rows = uniqueById([
      [
        { id: "a", n: 1 },
        { id: "b", n: 1 },
      ],
      [
        { id: "b", n: 2 },
        { id: "c", n: 1 },
      ],
    ]);
    expect(rows).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "c", n: 1 },
    ]);
  });
});

describe("awaitingCount", () => {
  it("chỉ đếm phiên đang chờ chính người dùng", () => {
    expect(awaitingCount([{ awaitingMe: true }, { awaitingMe: false }, { awaitingMe: true }])).toBe(2);
    expect(awaitingCount([])).toBe(0);
  });
});

describe("validateReviewsSearch", () => {
  it("giữ tab=code và id hợp lệ", () => {
    expect(validateReviewsSearch({ tab: "code", id: ID })).toEqual({ tab: "code", id: ID });
  });

  it("URL cũ chỉ có id vẫn mở tài liệu", () => {
    expect(validateReviewsSearch({ id: ID })).toEqual({ id: ID });
  });

  it("bỏ tab lạ và id không phải uuid", () => {
    expect(validateReviewsSearch({ tab: "docs", id: "x" })).toEqual({});
    expect(validateReviewsSearch({ tab: ["code"] })).toEqual({});
  });
});

describe("NAV_GROUPS", () => {
  it("mục Chờ tôi duyệt mang badge PR chờ duyệt", () => {
    const reviews = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === "reviews");
    expect(reviews?.badge).toBe("codeReviews");
  });
});

describe("validateWorkflowsSearch", () => {
  it("giữ khoá dự án hợp lệ", () => {
    expect(validateWorkflowsSearch({ duan: "payment-api" })).toEqual({ duan: "payment-api" });
  });

  it("bỏ giá trị không phải khoá dự án", () => {
    expect(validateWorkflowsSearch({ duan: "../x" })).toEqual({});
    expect(validateWorkflowsSearch({ duan: "A_B" })).toEqual({});
    expect(validateWorkflowsSearch({ duan: 7 })).toEqual({});
    expect(validateWorkflowsSearch({})).toEqual({});
  });
});
