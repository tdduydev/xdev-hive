import { blockKind, type DocSuggestion, joinBlocks, nextRequirementId, splitBlocks } from "@xdev-hive/contracts";

/** Khối chèn được từ menu `/` và thanh công cụ; nội dung mẫu là Markdown để agent đọc tài liệu vẫn hiểu. */
export type BlockTemplate =
  | "h1"
  | "h2"
  | "para"
  | "bullet"
  | "ordered"
  | "checklist"
  | "table"
  | "requirement"
  | "code"
  | "mermaid"
  | "callout"
  | "embed";

export function blockTemplate(kind: BlockTemplate, content: string): string {
  switch (kind) {
    case "h1":
      return "# Tiêu đề";
    case "h2":
      return "## Mục mới";
    case "para":
      return "Đoạn văn mới.";
    case "bullet":
      return "- Ý thứ nhất\n- Ý thứ hai";
    case "ordered":
      return "1. Bước một\n2. Bước hai";
    case "checklist":
      return "- [ ] Tiêu chí chấp nhận";
    case "table":
      return "| ID | Yêu cầu | Ưu tiên |\n| --- | --- | --- |\n| R-1 |  | P0 |";
    case "requirement":
      return `- ${nextRequirementId(content)}: `;
    case "code":
      return "```ts\n\n```";
    case "mermaid":
      return "```mermaid\nflowchart LR\n  A[Bắt đầu] --> B[Kết thúc]\n```";
    case "callout":
      return "> [!note]\n> Ghi chú";
    case "embed":
      return "![[org/khac/tai-lieu]]";
  }
}

/** Chèn khối sau khối thứ `index` (-1 là đầu tài liệu). Trả nội dung mới và vị trí khối vừa chèn. */
export function insertBlock(content: string, index: number, block: string): { content: string; index: number } {
  const blocks = splitBlocks(content);
  const at = Math.min(Math.max(index + 1, 0), blocks.length);
  blocks.splice(at, 0, block);
  return { content: joinBlocks(blocks), index: at };
}

/** Thay khối thứ `index`; khối rỗng thì xoá. */
export function replaceBlock(content: string, index: number, block: string): string {
  const blocks = splitBlocks(content);
  if (index < 0 || index >= blocks.length) return joinBlocks([...blocks, block]);
  blocks.splice(index, 1, ...(block.trim() ? [block] : []));
  return joinBlocks(blocks);
}

/** Đổi kiểu khối văn bản giữa tiêu đề và đoạn (ô chọn kiểu khối trên thanh công cụ). */
export function setTextKind(block: string, kind: "h1" | "h2" | "h3" | "para"): string {
  const body = block.replace(/^#{1,6}\s+/, "");
  if (kind === "para") return body;
  return `${"#".repeat(Number(kind.slice(1)))} ${body}`;
}

export function textKindOf(block: string): "h1" | "h2" | "h3" | "para" | null {
  const m = /^(#{1,3})\s/.exec(block);
  if (m) return `h${m[1]?.length}` as "h1" | "h2" | "h3";
  return blockKind(block) === "paragraph" ? "para" : null;
}

/** Bọc đoạn đang chọn bằng ký hiệu Markdown (đậm, nghiêng, gạch, code, liên kết). */
export function wrapSelection(
  text: string,
  start: number,
  end: number,
  mark: "bold" | "italic" | "strike" | "code" | "link",
): { text: string; start: number; end: number } {
  const [open, close] =
    mark === "bold"
      ? ["**", "**"]
      : mark === "italic"
        ? ["*", "*"]
        : mark === "strike"
          ? ["~~", "~~"]
          : mark === "code"
            ? ["`", "`"]
            : ["[", "](https://)"];
  const picked = text.slice(start, end) || (mark === "link" ? "liên kết" : "chữ");
  return {
    text: text.slice(0, start) + open + picked + close + text.slice(end),
    start: start + open.length,
    end: start + open.length + picked.length,
  };
}

/** Đánh dấu một ô checklist (dòng thứ `line` của khối). */
export function toggleCheck(block: string, line: number): string {
  return block
    .split("\n")
    .map((l, i) => (i === line ? l.replace(/\[([ xX])\]/, (_, c: string) => (c.trim() ? "[ ]" : "[x]")) : l))
    .join("\n");
}

/** Khối mà đề xuất sửa trỏ vào: khối đầu tiên chứa đoạn gốc; đề xuất thêm mới (gốc rỗng) xếp sau khối cuối. */
export function suggestionsByBlock(blocks: string[], suggestions: DocSuggestion[]): Map<number, DocSuggestion[]> {
  const out = new Map<number, DocSuggestion[]>();
  for (const s of suggestions) {
    let at = s.before ? blocks.findIndex((b) => b.includes(s.before)) : blocks.length - 1;
    // Đoạn gốc trải qua nhiều khối: neo vào khối chứa phần đầu.
    if (at === -1 && s.before) {
      const head = s.before.split("\n\n")[0] ?? "";
      at = head ? blocks.findIndex((b) => b.includes(head)) : -1;
    }
    const list = out.get(at) ?? [];
    list.push(s);
    out.set(at, list);
  }
  return out;
}

/** Đoạn trích để mở luồng bình luận: chữ đang chọn trong khối, không thì câu đầu của khối. */
export function quoteFor(block: string, selected: string): string {
  const pick = selected.trim();
  if (pick && block.includes(pick)) return pick.slice(0, 500);
  const plain = block.replace(/^#{1,6}\s+|^[-*+]\s+(\[[ xX]\]\s+)?|^\d+[.)]\s+|^>\s*/gm, "").trim();
  const first = plain.split(/(?<=[.!?])\s|\n/)[0] ?? plain;
  return (block.includes(first) ? first : (block.split("\n")[0] ?? block)).slice(0, 500);
}

/** Tài liệu nhúng trong khối `![[key]]`. */
export function embedKey(block: string): string | null {
  return /^!\[\[([a-z0-9][a-z0-9/._-]*)\]\]$/.exec(block.trim())?.[1] ?? null;
}
