import { describe, expect, it } from "vitest";
import {
  applySuggestion,
  blockKind,
  initialsOf,
  joinBlocks,
  mergeBlocks,
  nextRequirementId,
  normalizeDoc,
  occurrences,
  splitBlocks,
  wordDiff,
} from "./doc-text.ts";

const DOC = [
  "# Hoàn tiền một phần",
  "Mục tiêu: hoàn một phần.",
  "",
  "## Yêu cầu",
  "- R-1 Hoàn nhiều lần",
  "- R-2 Chặn vượt số tiền gốc",
  "",
  "```mermaid",
  "graph TD",
  "",
  "A --> B",
  "```",
  "| ID | Yêu cầu |",
  "| --- | --- |",
  "| R-3 | Lịch sử |",
  "",
  "![[project/pay/money]]",
  "",
  "> [!NOTE] Đầu vào cho agent",
  "",
  "- [ ] Tiêu chí 1",
].join("\n");

describe("khối Markdown", () => {
  it("tách khối: tiêu đề đứng riêng, khối code giữ dòng trống bên trong", () => {
    const blocks = splitBlocks(DOC);
    expect(blocks.map(blockKind)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "bullet",
      "mermaid",
      "table",
      "embed",
      "callout",
      "checklist",
    ]);
    expect(blocks[4]).toBe("```mermaid\ngraph TD\n\nA --> B\n```");
    expect(blockKind("```ts\nx\n```")).toBe("code");
    expect(blockKind("1. một")).toBe("ordered");
    expect(blockKind("> trích")).toBe("quote");
    expect(blockKind("---")).toBe("rule");
  });

  it("ghép lại theo dạng chuẩn và ổn định khi chuẩn hoá lần nữa", () => {
    const once = normalizeDoc(DOC);
    expect(normalizeDoc(once)).toBe(once);
    expect(joinBlocks(["a  ", "", "b"])).toBe("a\n\nb\n");
    expect(joinBlocks([])).toBe("");
  });

  it("mã yêu cầu kế tiếp", () => {
    expect(nextRequirementId(DOC)).toBe("R-4");
    expect(nextRequirementId("chưa có")).toBe("R-1");
  });
});

describe("đề xuất sửa", () => {
  it("thay đúng một chỗ, không còn hoặc lặp lại thì trả null", () => {
    const doc = "Tổng hoàn phải nhỏ hơn số tiền gốc.\n";
    expect(applySuggestion(doc, "phải nhỏ hơn", "không được vượt")).toBe("Tổng hoàn không được vượt số tiền gốc.\n");
    expect(applySuggestion(doc, "không có", "x")).toBeNull();
    expect(applySuggestion("a a", "a", "b")).toBeNull();
    expect(applySuggestion("Đoạn 1\n", "", "## Rủi ro")).toBe("Đoạn 1\n\n## Rủi ro\n");
    expect(occurrences("a a a", "a")).toBe(3);
    expect(occurrences("abc", "")).toBe(0);
  });

  it("khác biệt theo từ để hiện gạch bỏ và chèn trong câu", () => {
    expect(wordDiff("phải nhỏ hơn số tiền gốc", "không được vượt số tiền gốc")).toEqual([
      { kind: "del", text: "phải nhỏ hơn" },
      { kind: "ins", text: "không được vượt" },
      { kind: "eq", text: " số tiền gốc" },
    ]);
    expect(wordDiff("", "mới")).toEqual([{ kind: "ins", text: "mới" }]);
  });
});

describe("gộp ba phía theo khối", () => {
  const base = "# T\n\nĐoạn A\n\nĐoạn B\n\nĐoạn C\n";
  it("hai người sửa hai khối khác nhau thì giữ cả hai", () => {
    const mine = "# T\n\nĐoạn A của tôi\n\nĐoạn B\n\nĐoạn C\n";
    const theirs = "# T\n\nĐoạn A\n\nĐoạn B\n\nĐoạn C của Hà\n\nĐoạn D\n";
    expect(mergeBlocks(base, mine, theirs)).toEqual({
      content: "# T\n\nĐoạn A của tôi\n\nĐoạn B\n\nĐoạn C của Hà\n\nĐoạn D\n",
      conflicts: 0,
    });
  });

  it("cùng sửa một khối khác nhau thì giữ bản của mình và báo xung đột", () => {
    const r = mergeBlocks(base, "# T\n\nĐoạn A\n\nB tôi\n\nĐoạn C\n", "# T\n\nĐoạn A\n\nB Hà\n\nĐoạn C\n");
    expect(r).toEqual({ content: "# T\n\nĐoạn A\n\nB tôi\n\nĐoạn C\n", conflicts: 1 });
  });

  it("hai người sửa hai khối liền nhau thì gộp được cả hai", () => {
    const r = mergeBlocks(base, "# T\n\nĐoạn A\n\nB tôi\n\nĐoạn C\n", "# T\n\nĐoạn A\n\nĐoạn B\n\nC Hà\n");
    expect(r).toEqual({ content: "# T\n\nĐoạn A\n\nB tôi\n\nC Hà\n", conflicts: 0 });
  });

  it("người kia xoá một khối mình không đụng tới", () => {
    expect(mergeBlocks(base, base, "# T\n\nĐoạn A\n\nĐoạn C\n").content).toBe("# T\n\nĐoạn A\n\nĐoạn C\n");
  });
});

it("chữ viết tắt của tên", () => {
  expect(initialsOf("Nguyễn Văn Minh")).toBe("NM");
  expect(initialsOf("Trần Lan")).toBe("TL");
  expect(initialsOf("claude")).toBe("C");
  expect(initialsOf("")).toBe("?");
});
