import { type DocSuggestion, nextRequirementId, occurrences, splitBlocks } from "@xdev-hive/contracts";

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

/** Khối của bản nháp kèm vị trí trong chữ gốc, để đoạn gốc của đề xuất cắt đúng từ bản nháp. */
function locateBlocks(content: string): { text: string; start: number; end: number }[] {
  let at = 0;
  return splitBlocks(content).map((text) => {
    const start = Math.max(content.indexOf(text, at), at);
    at = start + text.length;
    return { text, start, end: at };
  });
}

/** Các cụm khối khác nhau giữa hai danh sách (LCS theo khối): [đầu, cuối) ở bên cũ và bên mới. */
function blockHunks(a: string[], b: string[]): { a: [number, number]; b: [number, number] }[] {
  const n = a.length;
  const m = b.length;
  const lcs = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => lcs[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * (m + 1) + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const out: { a: [number, number]; b: [number, number] }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const start: [number, number] = [i, j];
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) {
      if (j < m && (i >= n || at(i, j + 1) >= at(i + 1, j))) j++;
      else i++;
    }
    out.push({ a: [start[0], i], b: [start[1], j] });
  }
  return out;
}

/**
 * Chỗ sửa trong chế độ đề xuất thành các đề xuất theo khối. `before` luôn cắt nguyên văn từ bản nháp và chỉ có một chỗ
 * (hub áp đề xuất bằng cách thay đúng một chỗ); chèn hoặc xoá thuần kèm một khối kề làm mốc.
 */
export function suggestionsFromEdit(base: string, edited: string): { before: string; after: string }[] {
  const a = locateBlocks(base);
  const b = splitBlocks(edited);
  return blockHunks(
    a.map((x) => x.text.trim()),
    b.map((x) => x.trim()),
  ).map((h) => {
    let [from, to] = h.a;
    const added = b.slice(h.b[0], h.b[1]);
    if (from === to || !added.length) {
      if (from > 0) from--;
      else if (to < a.length) to++;
    }
    const cut = (f: number, t: number) => base.slice(a[f]?.start ?? 0, a[t - 1]?.end ?? 0);
    while (from < to && occurrences(base, cut(from, to)) > 1 && (from > 0 || to < a.length)) {
      if (from > 0) from--;
      else to++;
    }
    const after = [
      ...a.slice(from, h.a[0]).map((x) => x.text),
      ...added,
      ...a.slice(h.a[1], to).map((x) => x.text),
    ].join("\n\n");
    return { before: from < to ? cut(from, to) : "", after };
  });
}
