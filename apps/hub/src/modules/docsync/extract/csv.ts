import { markdownTable } from "./markdown.ts";
import { ExtractError, type ExtractLimits, type ExtractOutput } from "./types.ts";

const MAX_COLUMNS = 50;

/** Tách CSV theo RFC 4180 (ngoặc kép, xuống dòng trong ô). Dấu phân cách đoán từ dòng đầu: `,`, `;` hoặc tab. */
export function parseCsv(text: string, maxRows: number): { rows: string[][]; more: boolean } {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const sep = [",", ";", "\t"].reduce((best, s) =>
    firstLine.split(s).length > firstLine.split(best).length ? s : best,
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), more: true };
    } else field += ch;
  }
  if (field !== "" || row.length) rows.push([...row, field]);
  return { rows: rows.slice(0, maxRows), more: rows.length > maxRows };
}

export function extractCsv(bytes: Uint8Array, limits: ExtractLimits): ExtractOutput {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    throw new ExtractError("File CSV không phải UTF-8.");
  }
  if (text.includes("\0")) throw new ExtractError("File CSV hỏng hoặc là file nhị phân.");
  // Dòng tiêu đề không tính vào giới hạn dòng dữ liệu.
  const { rows, more } = parseCsv(text, limits.rowsPerSheet + 1);
  const data = rows.filter((r) => r.some((v) => v.trim()));
  if (!data.length) throw new ExtractError("Không có chữ để trích.");
  const warnings = more ? [`Chỉ trích ${limits.rowsPerSheet} dòng đầu.`] : [];
  if (data.some((r) => r.length > MAX_COLUMNS)) warnings.push(`Chỉ trích ${MAX_COLUMNS} cột đầu.`);
  return { markdown: markdownTable(data.map((r) => r.slice(0, MAX_COLUMNS))), warnings };
}
