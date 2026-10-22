/** Số dòng tối đa mà trình xem dựng; bảng lớn hơn bị cắt để trang không treo, người xem vẫn thấy thông báo. */
export const CSV_MAX_ROWS = 2000;
export const CSV_MAX_SERIES = 8;

export interface ParsedCsv {
  header: string[];
  rows: string[][];
  /** Có dòng bị bỏ vì vượt `CSV_MAX_ROWS`. */
  truncated: boolean;
}

/** Dấu phân cách đoán từ dòng đầu (không tính ngoặc kép): CSV xuất từ máy Việt Nam hay dùng `;`. */
function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t"]) {
    let count = 0;
    let quoted = false;
    for (const ch of first) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Bộ phân tích CSV (RFC 4180): ngoặc kép bao ô, `""` là một dấu ngoặc, xuống dòng nằm trong ô được giữ. Dòng đầu là tiêu
 * đề; dòng ngắn hơn tiêu đề được đệm ô rỗng để bảng không lệch cột.
 */
export function parseCsv(content: string): ParsedCsv {
  const text = content.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(text);
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let sawAny = false;
  const endCell = () => {
    record.push(cell);
    cell = "";
  };
  const endRecord = () => {
    endCell();
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    sawAny = true;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === "\n") endRecord();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRecord();
    } else cell += ch;
  }
  if (sawAny && (cell !== "" || record.length > 0)) endRecord();
  const [header = [], ...rest] = records;
  const width = Math.max(header.length, ...rest.map((r) => r.length), 0);
  const pad = (r: string[]) => (r.length < width ? [...r, ...Array<string>(width - r.length).fill("")] : r);
  const truncated = rest.length > CSV_MAX_ROWS;
  return { header: pad(header), rows: rest.slice(0, CSV_MAX_ROWS).map(pad), truncated };
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export interface CsvChartData {
  /** Tên cột nhãn (cột đầu). */
  labelKey: string;
  /** Cột số được vẽ (tối đa `CSV_MAX_SERIES`). */
  series: string[];
  /** Mỗi dòng: nhãn ở `labelKey`, giá trị số ở từng cột. */
  data: Record<string, string | number>[];
}

/**
 * Cột đầu làm nhãn trục; cột nào mọi ô có giá trị đều là số thì thành một chuỗi vẽ. `null` khi không có cột số để vẽ.
 * Ô rỗng của cột số thành 0 để đường không đứt giữa chừng.
 */
export function csvChartData({ header, rows }: ParsedCsv): CsvChartData | null {
  if (header.length < 2 || rows.length === 0) return null;
  const labelKey = header[0] || "#";
  const series: { key: string; index: number }[] = [];
  header.forEach((name, index) => {
    if (index === 0 || series.length >= CSV_MAX_SERIES) return;
    const cells = rows.map((r) => (r[index] ?? "").trim()).filter((c) => c !== "");
    if (cells.length > 0 && cells.every((c) => NUMBER.test(c))) series.push({ key: name || `Cột ${index + 1}`, index });
  });
  if (series.length === 0) return null;
  const data = rows.map((r) => {
    const row: Record<string, string | number> = { [labelKey]: r[0] ?? "" };
    for (const s of series) row[s.key] = Number((r[s.index] ?? "").trim() || 0);
    return row;
  });
  return { labelKey, series: series.map((s) => s.key), data };
}
