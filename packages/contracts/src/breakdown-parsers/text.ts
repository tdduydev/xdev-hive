/**
 * Phần chữ dùng chung giữa bộ đọc/ghi `hive-tasks` (breakdown.ts) và bộ đọc/ghi của các phương pháp khác (dialects.ts):
 * hai bên phải hiểu dòng dự án, tiêu đề trong body và khối chi tiết giống hệt nhau, nếu không đọc–ghi–đọc lệch.
 */

export const FENCE = /^[ \t]*(`{3,}|~{3,})/;
// Chi tiết của từng mục checklist nằm trong body dưới dòng này để bộ ghi đặt lại đúng dưới mục. Mã có chấm (`1.2`)
// là mục của OpenSpec, Kiro.
export const DETAIL_MARK = /^#### (T\d{3,4}|\d+(?:\.\d+)*)$/;
export const PROJECT_LINE =
  /^[ \t]*(?:[-*][ \t]+)?(?:\*\*|__)?(?:dự án|project)(?:\*\*|__)?[ \t]*:[ \t]*(?:\*\*|__)?[ \t]*`?(?:\[?@)?([A-Za-z0-9][\w.-]*)\]?`?[ \t]*(?:\*\*|__)?[ \t]*\.?[ \t]*$/iu;

/** Dòng Markdown đã chuẩn hoá (xuống dòng, NFC, tab đầu dòng thành bốn dấu cách); giữ nguyên số dòng. */
export function markdownLines(markdown: string): string[] {
  return markdown
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .split("\n")
    .map((l) => l.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "    ")));
}

/** Gộp dòng trống liền nhau, bỏ dòng trống và `---` ở hai đầu: body đọc lại sau khi ghi không đổi. */
export function normalizeBlock(lines: readonly string[]): string {
  const out: string[] = [];
  for (const l of lines.map((x) => x.trimEnd())) {
    if (l === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(l);
  }
  const rule = (l: string | undefined) => l === "" || (l !== undefined && /^(?:-{3,}|\*{3,}|_{3,})$/.test(l));
  while (out.length > 0 && rule(out[0])) out.shift();
  while (out.length > 0 && rule(out[out.length - 1])) out.pop();
  return out.join("\n");
}

/** Body của task tách thành phần mở đầu và khối chi tiết theo mã mục (`#### T003`). */
export function splitBody(body: string): { preamble: string[]; blocks: Map<string, string[]> } {
  const lines = body === "" ? [] : body.split("\n");
  const preamble: string[] = [];
  const blocks = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const l of lines) {
    const m = DETAIL_MARK.exec(l);
    if (m) {
      current = [];
      blocks.set(m[1] ?? "", current);
    } else (current ?? preamble).push(l);
  }
  for (const [id, block] of blocks) {
    const text = normalizeBlock(block);
    blocks.set(id, text === "" ? [] : text.split("\n"));
  }
  return { preamble, blocks };
}

/** Tiêu đề trong body phải sâu hơn tiêu đề phần (mặc định `##`), nếu không bộ đọc coi nó là phần mới. */
export function demote(lines: readonly string[], level = 2): string[] {
  let fence = false;
  const re = new RegExp(`^(#{1,${level}})([ \\t].*)$`);
  return lines.map((l) => {
    if (FENCE.test(l)) fence = !fence;
    const h = fence ? null : re.exec(l);
    return h ? `${"#".repeat(level + 1)}${h[2]}` : l;
  });
}

export function indent(lines: readonly string[]): string[] {
  return lines.map((l) => (l === "" ? "" : `  ${l}`));
}

export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

export function indentOf(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}
