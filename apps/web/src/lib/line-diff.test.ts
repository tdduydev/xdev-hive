import { describe, expect, it } from "vitest";
import { diffBlocks, lineDiff } from "@/lib/line-diff.ts";

const kinds = (before: string, after: string) => lineDiff(before, after).map((l) => `${l.kind[0]}:${l.text}`);

describe("lineDiff", () => {
  it("hai bản giống nhau thì mọi dòng là không đổi", () => {
    expect(kinds("a\nb\n", "a\nb\n")).toEqual(["s:a", "s:b"]);
  });

  it("tài liệu mới: mọi dòng là dòng thêm, không có dòng rỗng thừa", () => {
    expect(kinds("", "# PRD\nR-1")).toEqual(["a:# PRD", "a:R-1"]);
  });

  it("chỉ đánh dấu dòng đổi, giữ dòng chung ở giữa (LCS chứ không cắt đầu cuối)", () => {
    expect(kinds("a\nb\nc\nd\ne", "a\nB\nc\nd\nE\nf")).toEqual([
      "s:a",
      "r:b",
      "a:B",
      "s:c",
      "s:d",
      "r:e",
      "a:E",
      "a:f",
    ]);
  });

  it("đánh số dòng theo từng bản", () => {
    const diff = lineDiff("x\ny\nz", "x\nnew\ny\nz");
    expect(diff.map((l) => [l.oldNo, l.newNo])).toEqual([
      [1, 1],
      [null, 2],
      [2, 3],
      [3, 4],
    ]);
  });

  it("xoá hết thì mọi dòng là dòng xoá", () => {
    expect(kinds("a\nb", "")).toEqual(["r:a", "r:b"]);
  });
});

describe("diffBlocks", () => {
  it("gộp đoạn không đổi dài thành khoảng trống, giữ ngữ cảnh quanh chỗ đổi", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const after = before.replace("l10", "L10");
    const blocks = diffBlocks(lineDiff(before, after), 2);
    expect(blocks.map((b) => (b.kind === "gap" ? `gap ${b.count}` : b.lines.map((l) => l.text).join(",")))).toEqual([
      "gap 7",
      "l8,l9,l10,L10,l11,l12",
      "gap 8",
    ]);
  });

  it("không có thay đổi thì chỉ một khoảng trống", () => {
    expect(diffBlocks(lineDiff("a\nb", "a\nb"))).toEqual([{ kind: "gap", count: 2 }]);
  });
});
