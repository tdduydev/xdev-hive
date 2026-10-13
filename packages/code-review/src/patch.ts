export type PatchLine =
  | { kind: "hunk"; text: string }
  | { kind: "context" | "add" | "del"; oldNo: number | null; newNo: number | null; text: string };

/** Quá ngưỡng này thì không dựng DOM cho patch mà đưa link sang nhà cung cấp Git (một file đổi hàng chục nghìn dòng làm đơ tab). */
export const MAX_PATCH_LINES = 3000;

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Tách patch unified của một file thành từng dòng kèm số dòng cũ/mới. Phát hiện của AI gắn theo số dòng mới nên
 * dòng xoá không có `newNo`. Dòng "\ No newline at end of file" bỏ đi vì không phải nội dung.
 */
export function parsePatch(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    // Trước hunk đầu tiên (hoặc dòng cuối rỗng do split) không có số dòng để gắn.
    if (!out.length || raw.startsWith("\\")) continue;
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === "+") out.push({ kind: "add", oldNo: null, newNo: newNo++, text });
    else if (sign === "-") out.push({ kind: "del", oldNo: oldNo++, newNo: null, text });
    else if (sign === " ") out.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text });
  }
  return out;
}

/** Số dòng của patch mà không cần tách hết: dùng để quyết định có hiện diff hay không. */
export function patchLineCount(patch: string): number {
  let n = 1;
  for (let i = patch.indexOf("\n"); i !== -1; i = patch.indexOf("\n", i + 1)) n++;
  return n;
}
