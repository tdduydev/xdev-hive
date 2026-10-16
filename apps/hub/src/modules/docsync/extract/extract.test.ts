import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.ts";
import { extractInThread, extractKind } from "./extract.ts";
import { runExtract } from "./run.ts";
import { EXTRACT_LIMITS, type ExtractKind } from "./types.ts";

const fixture = (name: string) => readFile(new URL(`../fixtures/extract/${name}`, import.meta.url));
const kindOf = (name: string) => extractKind(name) as ExtractKind;
const extract = async (name: string, limits = EXTRACT_LIMITS) =>
  extractInThread(kindOf(name), await fixture(name), limits);

describe("trích từng loại file", () => {
  it("docx: tiêu đề thành heading Markdown", async () => {
    const { markdown } = await extract("sample.docx");
    expect(markdown).toContain("# Quy trình phát hành");
    expect(markdown).toContain("## Kiểm tra trước khi phát hành");
    expect(markdown).toContain("ghi chú phát hành & changelog");
  });

  it("xlsx: mỗi sheet một bảng, sheet trống vẫn ghi, ký tự | được thoát", async () => {
    const { markdown, warnings } = await extract("sample.xlsx");
    expect(markdown).toContain("## Kế hoạch\n\n| Hạng mục | Người làm | Hạn |");
    expect(markdown).toContain("Làm \\| kiểm");
    expect(markdown).toContain("## Trống\n\n_Sheet trống._");
    expect(warnings).toEqual([]);
  });

  it("xlsx: cắt theo số dòng và báo cảnh báo", async () => {
    const { markdown, warnings } = await extract("sample.xlsx", { ...EXTRACT_LIMITS, rowsPerSheet: 5 });
    expect(markdown).toContain("| 4 | 40 |");
    expect(markdown).not.toContain("| 5 | 50 |");
    expect(warnings.join("\n")).toMatch(/Nhiều dòng/);
  });

  it("xlsx: cắt theo số sheet", async () => {
    const { markdown, warnings } = await extract("sample.xlsx", { ...EXTRACT_LIMITS, sheets: 1 });
    expect(markdown).not.toContain("## Trống");
    expect(warnings).toHaveLength(1);
  });

  it("pptx: slide theo số thứ tự, kèm ghi chú, bỏ số trang trong ghi chú", async () => {
    const { markdown } = await extract("sample.pptx");
    expect(markdown.indexOf("Mục tiêu 1")).toBeLessThan(markdown.indexOf("Kết thúc"));
    expect(markdown).toContain("Hub <-> repo");
    expect(markdown).toContain("**Ghi chú:**\n\nNhắc đội nền tảng chuẩn bị máy chủ.");
    expect(markdown).not.toMatch(/^2$/m);
  });

  it("pdf: mỗi trang một mục", async () => {
    const { markdown } = await extract("sample.pdf");
    expect(markdown).toBe("## Trang 1\n\nBao cao quy 3\nDoanh thu tang 12%\n\n## Trang 2\n\nTrang hai");
  });

  it("pdf: chỉ có hình thì báo không có chữ", async () => {
    await expect(extract("scanned.pdf")).rejects.toThrow("Không có chữ để trích");
  });

  it("pdf có mật khẩu báo lỗi rõ ràng", async () => {
    await expect(extract("encrypted.pdf")).rejects.toThrow("PDF có mật khẩu, không trích được.");
  });

  it("csv: đoán dấu ;, giữ ô có ngoặc kép", async () => {
    const { markdown } = await extract("sample.csv");
    expect(markdown).toContain("| An | Quản trị | Có ; trong ô |");
  });

  it("csv: dòng tiêu đề không tính vào giới hạn", () => {
    const { rows, more } = parseCsv("a,b\n1,2\n3,4\n5,6\n", 3);
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(more).toBe(true);
  });

  it("csv không phải UTF-8 bị từ chối", async () => {
    await expect(extractInThread("csv", new Uint8Array([0x41, 0xff, 0x0a]), EXTRACT_LIMITS)).rejects.toThrow(
      "File CSV không phải UTF-8.",
    );
  });

  it.each([
    ["broken.docx", "File hỏng hoặc không phải định dạng Office."],
    ["broken.pdf", "File PDF hỏng hoặc không đọc được."],
    ["renamed.xlsx", "Nội dung file không đúng định dạng .xlsx."],
  ])("file hỏng %s báo lỗi", async (name, message) => {
    await expect(extract(name)).rejects.toThrow(message);
  });

  it("zip bomb dừng khi số byte giải ra vượt giới hạn", async () => {
    await expect(extract("bomb.docx", { ...EXTRACT_LIMITS, unzippedBytes: 8 * 1024 ** 2 })).rejects.toThrow(/zip bomb/);
  });

  it("đuôi không hỗ trợ không có loại trích", () => {
    expect(extractKind("a/b.DOCX")).toBe("docx");
    expect(extractKind("a/b.doc")).toBeNull();
    expect(extractKind("README")).toBeNull();
  });
});

describe("luồng trích riêng", () => {
  it("trả kết quả từ worker_threads", async () => {
    const reply = await runExtract("pptx", await fixture("sample.pptx"));
    expect(reply).toMatchObject({ ok: true, warnings: [] });
  });

  it("zip bomb và PDF có mật khẩu chỉ thành lỗi của bản trích", async () => {
    const limits = { ...EXTRACT_LIMITS, unzippedBytes: 8 * 1024 ** 2 };
    expect(await runExtract("docx", await fixture("bomb.docx"), { limits })).toEqual({
      ok: false,
      message: "File nén giải ra quá lớn, có thể là zip bomb. Đã dừng trích.",
    });
    expect(await runExtract("pdf", await fixture("encrypted.pdf"))).toEqual({
      ok: false,
      message: "PDF có mật khẩu, không trích được.",
    });
  });

  it("zip bomb dưới giới hạn giải nén vẫn bị cắt theo giờ", async () => {
    // 64 MiB < 200 MiB mặc định nên giải hết; mammoth đọc 64 MiB byte 0 rất lâu, chỉ giới hạn giờ dừng được.
    const reply = await runExtract("docx", await fixture("bomb.docx"), { timeoutMs: 1_000 });
    expect(reply).toEqual({ ok: false, message: "Trích nội dung quá lâu (quá 1 giây), đã dừng." });
  });

  it("quá giờ thì cắt luồng", async () => {
    const started = Date.now();
    const reply = await runExtract("csv", new Uint8Array([0x61]), { timeoutMs: 300, probe: "hang" });
    expect(reply).toEqual({ ok: false, message: "Trích nội dung quá lâu (quá 0 giây), đã dừng." });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("hết heap thì luồng chết, hub vẫn chạy", async () => {
    const reply = await runExtract("csv", new Uint8Array([0x61]), { memoryMb: 32, probe: "oom" });
    expect(reply).toEqual({ ok: false, message: "Trích nội dung vượt giới hạn bộ nhớ 32 MB, đã dừng." });
    // Sau khi luồng chết, luồng mới vẫn trích được.
    expect((await runExtract("csv", Buffer.from("a,b\n1,2\n"))).ok).toBe(true);
  }, 30_000);
});
