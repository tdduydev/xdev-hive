export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
  /** Số dòng ở bản cũ; null với dòng thêm. */
  oldNo: number | null;
  /** Số dòng ở bản mới; null với dòng xoá. */
  newNo: number | null;
}

export type DiffBlock = { kind: "lines"; lines: DiffLine[] } | { kind: "gap"; count: number };

/*
 * Bảng LCS tốn n×m ô; quá ngưỡng này thì phần giữa hiện thành khối xoá rồi khối thêm, để tài liệu rất dài không làm
 * treo tab của người duyệt. Hai bản thường chỉ khác vài đoạn nên sau khi bỏ phần đầu và cuối giống nhau, phần giữa nhỏ.
 */
const MAX_CELLS = 2_000_000;

function lines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** Diff theo dòng giữa hai bản (LCS), giữ số dòng của cả hai bên. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "same", text: a[i] ?? "", oldNo: i + 1, newNo: i + 1 });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  for (const line of middle(midA, midB)) {
    out.push({
      ...line,
      oldNo: line.oldNo === null ? null : line.oldNo + start,
      newNo: line.newNo === null ? null : line.newNo + start,
    });
  }
  for (let i = 0; i < a.length - endA; i++) {
    out.push({ kind: "same", text: a[endA + i] ?? "", oldNo: endA + i + 1, newNo: endB + i + 1 });
  }
  return out;
}

function middle(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    return [
      ...a.map((text, i) => ({ kind: "removed" as const, text, oldNo: i + 1, newNo: null })),
      ...b.map((text, j) => ({ kind: "added" as const, text, oldNo: null, newNo: j + 1 })),
    ];
  }
  // lcs[i][j]: độ dài LCS của a[i..] và b[j..], trải phẳng để khỏi tạo n mảng con.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "", oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
      out.push({ kind: "removed", text: a[i] ?? "", oldNo: i + 1, newNo: null });
      i++;
    } else {
      out.push({ kind: "added", text: b[j] ?? "", oldNo: null, newNo: j + 1 });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: "removed", text: a[i] ?? "", oldNo: i + 1, newNo: null });
  for (; j < m; j++) out.push({ kind: "added", text: b[j] ?? "", oldNo: null, newNo: j + 1 });
  return out;
}

/**
 * Gom diff thành các khối quanh chỗ đổi, mỗi bên giữ `context` dòng không đổi; đoạn không đổi dài hơn thì thành một
 * khoảng "N dòng không đổi". Người duyệt chỉ cần thấy chỗ đổi và vài dòng xung quanh để hiểu ngữ cảnh.
 */
export function diffBlocks(diff: readonly DiffLine[], context = 3): DiffBlock[] {
  const changed = diff.map((line) => line.kind !== "same");
  if (!changed.includes(true)) return diff.length ? [{ kind: "gap", count: diff.length }] : [];
  const keep = diff.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++)
      if (changed[k]) return true;
    return false;
  });
  const blocks: DiffBlock[] = [];
  for (const [i, line] of diff.entries()) {
    const last = blocks.at(-1);
    if (keep[i]) {
      if (last?.kind === "lines") last.lines.push(line);
      else blocks.push({ kind: "lines", lines: [line] });
    } else if (last?.kind === "gap") last.count++;
    else blocks.push({ kind: "gap", count: 1 });
  }
  return blocks;
}
