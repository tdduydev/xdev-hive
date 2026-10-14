import { describe, expect, it } from "vitest";
import { importTitle, parseItemFolder } from "./import.ts";

describe("tên thư mục", () => {
  it("lấy số và slug ở đoạn cuối, bỏ dấu / thừa", () => {
    expect(parseItemFolder("specs/009-hoan-tien/")).toEqual({
      dir: "specs/009-hoan-tien",
      number: 9,
      slug: "hoan-tien",
    });
    expect(parseItemFolder("012-a")).toEqual({ dir: "012-a", number: 12, slug: "a" });
  });

  it("không theo mẫu <số>-<slug> hay số 0 thì null", () => {
    for (const p of ["specs/hoan-tien", "specs/009-Hoan-Tien", "specs/009-", "specs/000-x", "specs/009-a--b"])
      expect(parseItemFolder(p)).toBeNull();
  });
});

describe("tiêu đề", () => {
  it("ưu tiên dòng # của spec.md và bỏ tiền tố của Spec Kit", () => {
    const files = new Map([
      ["specs/009-x/plan.md", "# Kế hoạch triển khai\n"],
      ["specs/009-x/spec.md", "intro\n# Feature Specification: Hoàn tiền\n## Phần\n"],
    ]);
    expect(importTitle(files, "x")).toBe("Hoàn tiền");
  });

  it("không có tiêu đề thì dùng slug", () => {
    expect(importTitle(new Map([["specs/009-hoan-tien/spec.md", "## chỉ có mục con\n"]]), "hoan-tien")).toBe(
      "hoan tien",
    );
    expect(importTitle(new Map(), "a")).toBe("Hạng mục a");
  });
});
