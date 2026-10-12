/** Quote every field for RFC 4180 and neutralize formulas, including whitespace-prefixed spreadsheet input. */
export function csvCell(value: string): string {
  const safe = /^[\s\uFEFF]*[=+@-]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function csvRow(values: readonly string[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}
