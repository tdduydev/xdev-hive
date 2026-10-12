import { describe, expect, it } from "vitest";
import { csvCell, csvRow } from "./csv.ts";

describe("CSV", () => {
  it("escapes commas, quotes and newlines with CRLF records", () => {
    expect(csvRow(["a,b", 'a"b', "a\nb", "a\r\nb", ""])).toBe('"a,b","a""b","a\nb","a\r\nb",""\r\n');
  });
  it.each(["=SUM(1)", "+1", "-1", "@x", " \t=1", "\r\n+1"])("neutralizes %s", (value) => {
    expect(csvCell(value)).toBe(`"'${value}"`);
  });
  it("keeps ordinary text", () => expect(csvCell("Nhật ký")).toBe('"Nhật ký"'));
});
