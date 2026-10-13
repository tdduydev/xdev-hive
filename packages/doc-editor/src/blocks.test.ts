import type { DocSuggestion } from "@xdev-hive/contracts";
import { applySuggestion } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { blockTemplate, quoteFor, suggestionsByBlock, suggestionsFromEdit } from "./blocks.ts";

const DOC = "# PRD\n\n## Yêu cầu\n\n- R-1: Hoàn tiền\n- R-2: Phí\n\nĐoạn cuối. Câu hai.\n";

describe("khối", () => {
  it("mẫu yêu cầu có mã kế tiếp", () => {
    expect(blockTemplate("requirement", DOC)).toBe("- R-3: ");
    expect(blockTemplate("requirement", "")).toBe("- R-1: ");
  });
});

describe("chế độ đề xuất", () => {
  const apply = (base: string, list: { before: string; after: string }[]) =>
    list.reduce<string | null>((c, v) => (c === null ? null : applySuggestion(c, v.before, v.after)), base);

  it("sửa một đoạn thành một đề xuất đúng đoạn gốc", () => {
    const edited = DOC.replace("Đoạn cuối. Câu hai.", "Đoạn cuối đã sửa.");
    expect(suggestionsFromEdit(DOC, edited)).toEqual([{ before: "Đoạn cuối. Câu hai.", after: "Đoạn cuối đã sửa." }]);
  });

  it("chèn hay xoá khối kèm khối kề làm mốc; áp lần lượt ra đúng bản đã sửa", () => {
    const inserted = DOC.replace("## Yêu cầu\n\n", "## Yêu cầu\n\nMở đầu mới.\n\n");
    const ins = suggestionsFromEdit(DOC, inserted);
    expect(ins).toEqual([{ before: "## Yêu cầu", after: "## Yêu cầu\n\nMở đầu mới." }]);
    const removed = "# PRD\n\n## Yêu cầu\n\nĐoạn cuối. Câu hai.\n";
    expect(suggestionsFromEdit(DOC, removed)).toEqual([
      { before: "## Yêu cầu\n\n- R-1: Hoàn tiền\n- R-2: Phí", after: "## Yêu cầu" },
    ]);
    const many = "# PRD mới\n\n## Yêu cầu\n\n- R-1: Hoàn tiền\n- R-2: Phí\n\nĐoạn cuối. Câu hai.\n\nThêm cuối.\n";
    const list = suggestionsFromEdit(DOC, many);
    expect(list).toHaveLength(2);
    expect(apply(DOC, list)).toBe(many);
  });

  it("khối lặp lại mở rộng mốc tới khi đoạn gốc chỉ có một chỗ", () => {
    const base = "# A\n\n- [ ] Tiêu chí\n\n# B\n\n- [ ] Tiêu chí\n";
    const edited = "# A\n\n- [ ] Tiêu chí\n\n# B\n\n- [x] Tiêu chí\n";
    const [only] = suggestionsFromEdit(base, edited);
    expect(only).toEqual({ before: "# B\n\n- [ ] Tiêu chí", after: "# B\n\n- [x] Tiêu chí" });
    expect(apply(base, [only as { before: string; after: string }])).toBe(edited);
  });

  it("tài liệu trống: đề xuất thêm mới", () => {
    expect(suggestionsFromEdit("", "Đoạn đầu.\n")).toEqual([{ before: "", after: "Đoạn đầu." }]);
    expect(suggestionsFromEdit(DOC, DOC)).toEqual([]);
  });
});

const sug = (before: string): DocSuggestion => ({
  id: crypto.randomUUID(),
  key: "k",
  before,
  after: "x",
  reason: null,
  author: { userId: null, runId: null, name: "AI" },
  status: "pending",
  stale: false,
  createdAt: "2026-10-12T00:00:00.000Z",
  decidedBy: null,
  decidedAt: null,
});

describe("neo đề xuất và bình luận", () => {
  it("đề xuất nằm dưới khối chứa đoạn gốc; thêm mới nằm cuối", () => {
    const blocks = ["# PRD", "Phí 2%.", "Kết"];
    const map = suggestionsByBlock(blocks, [sug("Phí 2%"), sug(""), sug("không có")]);
    expect(map.get(1)).toHaveLength(1);
    expect(map.get(2)).toHaveLength(1);
    expect(map.get(-1)).toHaveLength(1);
  });

  it("đoạn trích là chữ đang chọn, không thì câu đầu của khối", () => {
    expect(quoteFor("Đoạn cuối. Câu hai.", "Câu hai")).toBe("Câu hai");
    expect(quoteFor("Đoạn cuối. Câu hai.", "")).toBe("Đoạn cuối.");
    expect(quoteFor("## Yêu cầu", "")).toBe("Yêu cầu");
  });
});
