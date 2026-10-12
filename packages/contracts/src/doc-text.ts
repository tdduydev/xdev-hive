/**
 * Xử lý văn bản Markdown của trình soạn tài liệu, dùng chung cho web (hiển thị, gộp khi lưu) và hub (áp đề xuất,
 * neo bình luận). Thuần hàm, không phụ thuộc DOM hay database.
 */

/** Khối cấp cao của Markdown: tiêu đề, đoạn, danh sách, bảng, khối code… Ngăn nhau bằng dòng trống. */
export function splitBlocks(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (cur.length) out.push(cur.join("\n"));
    cur = [];
  };
  for (const line of lines) {
    if (fence) {
      cur.push(line);
      if (line.trimStart().startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open?.[1]) {
      // Khối code luôn là một khối riêng, kể cả khi dính liền đoạn phía trên; dòng trống bên trong không cắt khối.
      flush();
      fence = open[1];
      cur.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // Tiêu đề luôn đứng riêng một khối để mục lục và neo bình luận theo mục ổn định.
    if (/^#{1,6}\s/.test(line)) {
      flush();
      out.push(line);
      continue;
    }
    cur.push(line);
  }
  flush();
  return out;
}

/** Ghép khối lại theo một dạng chuẩn: một dòng trống giữa các khối, kết thúc bằng xuống dòng. */
export function joinBlocks(blocks: string[]): string {
  const kept = blocks.map((b) => b.replace(/\s+$/, "")).filter((b) => b.trim());
  return kept.length ? `${kept.join("\n\n")}\n` : "";
}

export const normalizeDoc = (content: string) => joinBlocks(splitBlocks(content));

export type BlockKind =
  | "heading"
  | "paragraph"
  | "bullet"
  | "ordered"
  | "checklist"
  | "table"
  | "code"
  | "mermaid"
  | "callout"
  | "quote"
  | "embed"
  | "rule";

/** Tài liệu nhúng: một dòng `![[<key tài liệu>]]`, agent đọc Markdown vẫn hiểu là tham chiếu. */
export const EMBED_LINE = /^!\[\[([a-z0-9][a-z0-9/._-]*)\]\]$/;

export function blockKind(block: string): BlockKind {
  const first = block.split("\n")[0] ?? "";
  if (/^\s*(`{3,}|~{3,})\s*mermaid\b/i.test(first)) return "mermaid";
  if (/^\s*(`{3,}|~{3,})/.test(first)) return "code";
  if (/^#{1,6}\s/.test(first)) return "heading";
  if (EMBED_LINE.test(block.trim())) return "embed";
  if (/^\s*(?:---+|\*\*\*+)\s*$/.test(block)) return "rule";
  if (/^>\s*\[!(?:note|info|tip|warning|important|caution)\]/i.test(first)) return "callout";
  if (first.startsWith(">")) return "quote";
  if (/^\s*[-*+]\s+\[[ xX]\]\s/.test(first)) return "checklist";
  if (/^\s*[-*+]\s/.test(first)) return "bullet";
  if (/^\s*\d+[.)]\s/.test(first)) return "ordered";
  const second = block.split("\n")[1] ?? "";
  if (first.includes("|") && /^\s*\|?\s*:?-{3,}/.test(second)) return "table";
  return "paragraph";
}

/** Mã yêu cầu kế tiếp: lớn nhất trong tài liệu cộng một. */
export function nextRequirementId(content: string): string {
  let max = 0;
  for (const m of content.matchAll(/\bR-(\d{1,5})\b/g)) max = Math.max(max, Number(m[1]));
  return `R-${max + 1}`;
}

/** Số lần `needle` xuất hiện (không chồng nhau). */
export function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Áp đề xuất sửa: thay đoạn `before` (phải có đúng một chỗ) bằng `after`; `before` rỗng là thêm khối mới ở cuối.
 * Trả null khi đoạn gốc không còn hoặc lặp lại, để người nhận biết đề xuất đã cũ thay vì sửa nhầm chỗ.
 */
export function applySuggestion(content: string, before: string, after: string): string | null {
  if (!before) return joinBlocks([...splitBlocks(content), after]);
  if (occurrences(content, before) !== 1) return null;
  const at = content.indexOf(before);
  return content.slice(0, at) + after + content.slice(at + before.length);
}

export type DiffPart = { kind: "eq" | "del" | "ins"; text: string };

const tokens = (s: string) => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];

/** Khác biệt theo từ giữa hai đoạn ngắn (đề xuất sửa), để hiện gạch bỏ và chèn ngay trong câu. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  // Đoạn quá dài thì không đáng tốn O(n·m): hiện cả đoạn cũ bị bỏ và cả đoạn mới.
  if (a.length * b.length > 4_000_000) return compact([del(before), ins(after)]);
  const lcs = lcsTable(a, b);
  const out: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "eq", text: a[i++] as string });
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) out.push(del(a[i++] as string));
    else out.push(ins(b[j++] as string));
  }
  while (i < a.length) out.push(del(a[i++] as string));
  while (j < b.length) out.push(ins(b[j++] as string));
  return regroup(out);
}

/**
 * Gom một vùng thay đổi thành "bỏ cả cụm cũ, chèn cả cụm mới": khoảng trắng trùng nhau giữa hai từ đổi không tách vùng,
 * để người đọc thấy "~~phải nhỏ hơn~~ không được vượt" thay vì từng từ xen kẽ.
 */
function regroup(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  let k = 0;
  while (k < parts.length) {
    const p = parts[k] as DiffPart;
    if (p.kind === "eq") {
      out.push(p);
      k++;
      continue;
    }
    let gone = "";
    let added = "";
    while (k < parts.length) {
      const q = parts[k] as DiffPart;
      if (q.kind === "del") gone += q.text;
      else if (q.kind === "ins") added += q.text;
      else if (!q.text.trim() && parts[k + 1] && parts[k + 1]?.kind !== "eq") {
        gone += q.text;
        added += q.text;
      } else break;
      k++;
    }
    out.push(del(gone), ins(added));
  }
  return compact(out);
}

const del = (text: string): DiffPart => ({ kind: "del", text });
const ins = (text: string): DiffPart => ({ kind: "ins", text });

function compact(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const p of parts) {
    if (!p.text) continue;
    const last = out.at(-1);
    if (last && last.kind === p.kind) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

/** Bảng LCS từ cuối lên: lcs[i][j] là độ dài dãy con chung dài nhất của a[i..] và b[j..]. */
function lcsTable<T>(a: T[], b: T[]): Uint32Array[] {
  const t = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    const row = t[i] as Uint32Array;
    const next = t[i + 1] as Uint32Array;
    for (let j = b.length - 1; j >= 0; j--)
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
  }
  return t;
}

/** Cặp chỉ số khớp nhau theo LCS: base[i] = other[j], tăng dần theo cả hai. */
function matches<T>(base: T[], other: T[]): Map<number, number> {
  const t = lcsTable(base, other);
  const out = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < base.length && j < other.length) {
    if (base[i] === other[j]) out.set(i++, j++);
    else if ((t[i + 1]?.[j] ?? 0) >= (t[i]?.[j + 1] ?? 0)) i++;
    else j++;
  }
  return out;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);

/**
 * Gộp ba phía theo khối: `base` là bản cả hai cùng bắt đầu, `mine` là bản của mình, `theirs` là bản người khác vừa
 * lưu. Khối chỉ một bên sửa thì lấy bên đó; cả hai cùng sửa một chỗ khác nhau thì giữ bản của mình và đếm là xung đột.
 */
export function mergeBlocks(base: string, mine: string, theirs: string): { content: string; conflicts: number } {
  const o = splitBlocks(base);
  const a = splitBlocks(mine);
  const b = splitBlocks(theirs);
  const ma = matches(o, a);
  const mb = matches(o, b);
  const out: string[] = [];
  let conflicts = 0;
  let io = 0;
  let ia = 0;
  let ib = 0;
  const resolve = (oc: string[], ac: string[], bc: string[]) => {
    // Hai bên cùng chỉ sửa tại chỗ (không thêm, bớt khối): xét từng khối, để sửa hai khối liền nhau không thành xung đột.
    if (oc.length > 1 && ac.length === oc.length && bc.length === oc.length) {
      for (let k = 0; k < oc.length; k++) resolve([oc[k] as string], [ac[k] as string], [bc[k] as string]);
      return;
    }
    if (same(ac, oc)) out.push(...bc);
    else if (same(bc, oc) || same(ac, bc)) out.push(...ac);
    else {
      conflicts++;
      out.push(...ac);
    }
  };
  for (let i = 0; i < o.length; i++) {
    const ja = ma.get(i);
    const jb = mb.get(i);
    if (ja === undefined || jb === undefined) continue;
    resolve(o.slice(io, i), a.slice(ia, ja), b.slice(ib, jb));
    out.push(o[i] as string);
    io = i + 1;
    ia = ja + 1;
    ib = jb + 1;
  }
  resolve(o.slice(io), a.slice(ia), b.slice(ib));
  return { content: joinBlocks(out), conflicts };
}

/** Chữ viết tắt để hiện avatar: chữ đầu của từ đầu và từ cuối ("Nguyễn Văn Minh" → "NM"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}
