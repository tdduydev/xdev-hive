import type { DocSuggestion } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  blockTemplate,
  embedKey,
  insertBlock,
  quoteFor,
  replaceBlock,
  setTextKind,
  suggestionsByBlock,
  textKindOf,
  toggleCheck,
  wrapSelection,
} from "./doc-editor.ts";

const DOC = "# PRD\n\n## Yêu cầu\n\n- R-1: Hoàn tiền\n- R-2: Phí\n\nĐoạn cuối. Câu hai.\n";

describe("khối", () => {
  it("chèn yêu cầu có mã kế tiếp sau khối đang sửa", () => {
    const req = blockTemplate("requirement", DOC);
    expect(req).toBe("- R-3: ");
    const out = insertBlock(DOC, 2, req);
    expect(out.index).toBe(3);
    expect(out.content).toBe("# PRD\n\n## Yêu cầu\n\n- R-1: Hoàn tiền\n- R-2: Phí\n\n- R-3:\n\nĐoạn cuối. Câu hai.\n");
  });

  it("thay khối, khối rỗng là xoá", () => {
    expect(replaceBlock(DOC, 3, "Mới.")).toBe("# PRD\n\n## Yêu cầu\n\n- R-1: Hoàn tiền\n- R-2: Phí\n\nMới.\n");
    expect(replaceBlock(DOC, 1, "  ")).toBe("# PRD\n\n- R-1: Hoàn tiền\n- R-2: Phí\n\nĐoạn cuối. Câu hai.\n");
  });

  it("đổi kiểu tiêu đề và đoạn", () => {
    expect(setTextKind("## Mục", "para")).toBe("Mục");
    expect(setTextKind("Mục", "h1")).toBe("# Mục");
    expect(textKindOf("## Mục")).toBe("h2");
    expect(textKindOf("Đoạn")).toBe("para");
    expect(textKindOf("- ý")).toBeNull();
  });

  it("bọc chữ đang chọn và đánh dấu checklist", () => {
    expect(wrapSelection("a bc d", 2, 4, "bold")).toEqual({ text: "a **bc** d", start: 4, end: 6 });
    expect(wrapSelection("a", 1, 1, "link").text).toBe("a[liên kết](https://)");
    expect(toggleCheck("- [ ] một\n- [x] hai", 0)).toBe("- [x] một\n- [x] hai");
    expect(toggleCheck("- [ ] một\n- [x] hai", 1)).toBe("- [ ] một\n- [ ] hai");
  });

  it("nhận ra khối nhúng tài liệu", () => {
    expect(embedKey("![[project/pay/money]]")).toBe("project/pay/money");
    expect(embedKey("![[x]] thêm")).toBeNull();
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
