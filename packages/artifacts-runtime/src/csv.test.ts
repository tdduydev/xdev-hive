import { describe, expect, it } from "vitest";
import { CSV_MAX_ROWS, csvChartData, parseCsv } from "./csv.ts";

describe("parseCsv", () => {
  it("tách tiêu đề và dòng, chịu CRLF và dòng trống cuối", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4\r\n\r\n")).toEqual({
      header: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
      truncated: false,
    });
  });

  it("ô trong ngoặc kép giữ dấu phẩy, ngoặc kép đôi và xuống dòng", () => {
    const { rows } = parseCsv('a,b\n"x, y","say ""hi""\nthere"\n');
    expect(rows).toEqual([["x, y", 'say "hi"\nthere']]);
  });

  it("đoán dấu chấm phẩy và tab, bỏ BOM", () => {
    expect(parseCsv("﻿a;b\n1;2").header).toEqual(["a", "b"]);
    expect(parseCsv("a\tb\n1\t2").rows).toEqual([["1", "2"]]);
  });

  it("đệm dòng ngắn cho đủ cột và cắt khi quá nhiều dòng", () => {
    expect(parseCsv("a,b,c\n1").rows).toEqual([["1", "", ""]]);
    const big = `a\n${Array.from({ length: CSV_MAX_ROWS + 5 }, (_, i) => i).join("\n")}`;
    const parsed = parseCsv(big);
    expect(parsed.rows).toHaveLength(CSV_MAX_ROWS);
    expect(parsed.truncated).toBe(true);
  });

  it("nội dung rỗng", () => {
    expect(parseCsv("")).toEqual({ header: [], rows: [], truncated: false });
  });
});

describe("csvChartData", () => {
  it("cột đầu là nhãn, chỉ cột toàn số thành chuỗi vẽ", () => {
    const chart = csvChartData(parseCsv("Tháng,Thu,Ghi chú,Chi\nT1,10,ok,3\nT2,,no,4.5"));
    expect(chart?.labelKey).toBe("Tháng");
    expect(chart?.series).toEqual(["Thu", "Chi"]);
    expect(chart?.data).toEqual([
      { Tháng: "T1", Thu: 10, Chi: 3 },
      { Tháng: "T2", Thu: 0, Chi: 4.5 },
    ]);
  });

  it("không có cột số hoặc không có dòng thì null", () => {
    expect(csvChartData(parseCsv("a,b\nx,y"))).toBeNull();
    expect(csvChartData(parseCsv("a,b"))).toBeNull();
    expect(csvChartData(parseCsv("a\n1"))).toBeNull();
  });
});
