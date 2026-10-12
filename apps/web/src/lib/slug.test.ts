import { slug } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { SLUG_MAX, slugify } from "@/lib/slug.ts";

describe("slugify", () => {
  it.each([
    ["Thanh toán", "thanh-toan"],
    ["Đối soát", "doi-soat"],
    ["Acme Software xDev", "acme-software-xdev"],
    ["  --Hệ thống   CRM!! ", "he-thong-crm"],
    ["Cổng thanh toán 2", "cong-thanh-toan-2"],
    ["Nội bộ".normalize("NFD"), "noi-bo"],
  ])("%j → %s", (name, want) => expect(slugify(name)).toBe(want));

  it("không còn chữ nào thì rỗng", () => expect(slugify("!!! ")).toBe(""));

  it("cắt theo độ dài tối đa, không để gạch ngang ở cuối", () => {
    const got = slugify(`${"a".repeat(SLUG_MAX - 1)} bcd`);
    expect(got).toBe("a".repeat(SLUG_MAX - 1));
  });

  it("kết quả không rỗng luôn qua được schema slug của hợp đồng", () => {
    for (const name of ["Thanh toán", "Đối soát xDev", "Ứng dụng 9", "x".repeat(60), "ab"]) {
      expect(slug.safeParse(slugify(name)).success).toBe(true);
    }
  });
});
