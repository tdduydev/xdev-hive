const cell = (value: string) =>
  value
    .replace(/\r\n?|\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim();

/** Bảng GFM; dòng đầu là tiêu đề. Dòng ngắn được bù ô trống để bảng không vỡ. */
export function markdownTable(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? "")).join(" | ")} |`;
  const [head = [], ...body] = rows;
  return [line(head), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(line)].join("\n");
}

export function xmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}
