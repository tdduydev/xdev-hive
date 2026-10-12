export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Bảng LCS lớn nhất tính đầy đủ (ô); quá mức thì coi phần giữa là khác hẳn để không treo giao diện. */
const MAX_CELLS = 4_000_000;

const splitLines = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

/**
 * So dòng giữa hai bản (LCS). Dùng cho SKILL.md (vài trăm dòng) và tài liệu (tới vài nghìn dòng): bỏ phần đầu và
 * cuối giống nhau trước, vì đề xuất sửa thường chỉ đổi vài đoạn giữa, rồi mới dựng bảng LCS cho phần còn lại.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const same = (lines: string[]) => lines.map((text) => ({ kind: "same" as const, text }));
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  return [...same(a.slice(0, head)), ...middleDiff(midA, midB), ...same(a.slice(a.length - tail))];
}

function middleDiff(a: string[], b: string[]): DiffLine[] {
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }
  const width = b.length + 1;
  // Mảng phẳng có kiểu: bảng của tài liệu vài nghìn dòng vẫn chỉ vài MB.
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] as string });
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      out.push({ kind: "del", text: a[i++] as string });
    } else {
      out.push({ kind: "add", text: b[j++] as string });
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] as string });
  while (j < b.length) out.push({ kind: "add", text: b[j++] as string });
  return out;
}

/** Chỉ giữ dòng đổi và `context` dòng quanh mỗi chỗ đổi; `null` đánh dấu đoạn giống nhau đã bỏ. */
export function diffHunks(lines: DiffLine[], context = 1): (DiffLine | null)[] {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.length && out.at(-1) !== null) out.push(null);
  });
  if (out.at(-1) === null) out.pop();
  return out;
}

/** Số dòng thêm và bớt. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}
