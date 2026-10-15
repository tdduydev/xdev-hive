import ExcelJS from "exceljs";
import { markdownTable } from "./markdown.ts";
import { ExtractError, type ExtractLimits, type ExtractOutput } from "./types.ts";
import { readZip, repack } from "./zip.ts";

const MAX_COLUMNS = 50;

export async function extractXlsx(bytes: Uint8Array, limits: ExtractLimits): Promise<ExtractOutput> {
  const buffer = await repack(await readZip(bytes, limits));
  const workbook = new ExcelJS.Workbook();
  // Đọc stream của exceljs lỗi 8/10 lần trong worker (research.md mục 6.5); đọc cả buffer, kích thước đã chặn ở readZip.
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new ExtractError("File Excel hỏng hoặc không đọc được.");
  }
  const warnings: string[] = [];
  const sheets = workbook.worksheets;
  if (sheets.length > limits.sheets) warnings.push(`Chỉ trích ${limits.sheets}/${sheets.length} sheet đầu.`);
  const parts: string[] = [];
  for (const sheet of sheets.slice(0, limits.sheets)) {
    const rows = Math.min(sheet.rowCount, limits.rowsPerSheet);
    const cols = Math.min(sheet.columnCount, MAX_COLUMNS);
    if (sheet.rowCount > rows) warnings.push(`Sheet "${sheet.name}": chỉ trích ${rows}/${sheet.rowCount} dòng đầu.`);
    if (sheet.columnCount > cols) warnings.push(`Sheet "${sheet.name}": chỉ trích ${cols} cột đầu.`);
    const table: string[][] = [];
    for (let r = 1; r <= rows; r++) {
      const row = sheet.getRow(r);
      table.push(Array.from({ length: cols }, (_, c) => row.getCell(c + 1).text ?? ""));
    }
    // Bỏ dòng trống ở cuối: rowCount tính cả dòng chỉ có định dạng.
    while (table.length && table.at(-1)?.every((v) => !v.trim())) table.pop();
    parts.push(`## ${sheet.name}\n\n${table.length ? markdownTable(table) : "_Sheet trống._"}`);
  }
  if (!parts.length) throw new ExtractError("File Excel không có sheet nào.");
  return { markdown: parts.join("\n\n"), warnings };
}
