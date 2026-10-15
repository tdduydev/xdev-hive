import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { detectMediaType, inspectFileType } from "./magic.ts";

const inspect = (filename: string, data: Uint8Array, declaredType?: string) =>
  inspectFileType(
    { size: data.length, read: async (offset, length) => data.subarray(offset, offset + length) },
    filename,
    declaredType,
  );
const samples = [
  ["image.PNG", "89504e470d0a1a0a", "image/png"],
  ["image.jpeg", "ffd8ffe000", "image/jpeg"],
  ["image.gif", Buffer.from("GIF89a").toString("hex"), "image/gif"],
  ["image.webp", Buffer.from("RIFFxxxxWEBP").toString("hex"), "image/webp"],
  ["file.pdf", Buffer.from("%PDF-1.7").toString("hex"), "application/pdf"],
  [
    "image.svg",
    Buffer.from('\uFEFF<?xml version="1.0"?>\n<!-- ảnh -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString(
      "hex",
    ),
    "image/svg+xml",
  ],
] as const;

describe("kiểm nội dung file", () => {
  it.each(samples)("nhận dạng %s", async (name, hex, type) => {
    expect(await inspect(name, Buffer.from(hex, "hex"), type)).toBe(type);
  });
  it.each(samples.filter((row) => row[2] !== "application/pdf"))("từ chối %s giả PDF", async (_name, hex) => {
    await expect(inspect("fake.pdf", Buffer.from(hex, "hex"))).rejects.toMatchObject({ code: "BLOB_TYPE_MISMATCH" });
  });
  it("không tin MIME do trình duyệt gửi, không nhận HTML chứa SVG là ảnh SVG", async () => {
    await expect(inspect("image.png", Buffer.from(samples[0][1], "hex"), "application/pdf")).rejects.toThrow(
      /không khớp/,
    );
    await expect(inspect("image.svg", Buffer.from("<html><svg></svg></html>"))).rejects.toThrow(/không khớp/);
    await expect(inspect("image.png", Buffer.from("not a png"))).rejects.toThrow(/không khớp/);
    await expect(inspect("file.exe", Buffer.from(samples[0][1], "hex"))).rejects.toThrow(/không khớp/);
  });
  it("nhận văn bản UTF-8, từ chối nhị phân giả văn bản, chấp nhận file rỗng", async () => {
    expect(await inspect("ghi-chu.md", Buffer.from("Tài liệu tiếng Việt"))).toBe("text/plain");
    expect(await inspect("empty.txt", Buffer.alloc(0))).toBe("text/plain");
    expect(await inspect("file.bin", Buffer.from([0, 255]))).toBe("application/octet-stream");
    await expect(inspect("text.csv", Buffer.from([0, 255]))).rejects.toThrow(/không khớp/);
    expect(detectMediaType(Buffer.alloc(0))).toBeNull();
  });
  it.each([
    ["docx", "word/document.xml", "wordprocessingml.document"],
    ["xlsx", "xl/workbook.xml", "spreadsheetml.sheet"],
    ["pptx", "ppt/presentation.xml", "presentationml.presentation"],
  ])("phân biệt %s qua central directory, kể cả entry được nén", async (ext, entry, mime) => {
    const zip = new JSZip().file("[Content_Types].xml", "<Types/>").file(entry, "<root/>");
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(await inspect(`file.${ext}`, bytes)).toBe(`application/vnd.openxmlformats-officedocument.${mime}`);
    await expect(inspect(`file.${ext === "docx" ? "xlsx" : "docx"}`, bytes)).rejects.toThrow(/không khớp/);
  });
  it("ZIP thường không được giả OOXML; central directory hỏng bị chặn", async () => {
    const bytes = await new JSZip().file("readme.txt", "word/document.xml").generateAsync({ type: "uint8array" });
    expect(await inspect("file.zip", bytes)).toBe("application/zip");
    await expect(inspect("file.docx", bytes)).rejects.toThrow(/không khớp/);
    await expect(inspect("file.zip", bytes.subarray(0, bytes.length - 4))).rejects.toThrow(/không khớp/);
    const malformed = Buffer.from(bytes);
    const end = malformed.length - 22;
    malformed.writeUInt32LE(end - 8, end + 16);
    malformed.writeUInt32LE(8, end + 12);
    await expect(
      inspectFileType(
        {
          size: malformed.length,
          read: async (offset, length) => {
            if (offset + length > malformed.length) throw new Error("Đọc vượt file.");
            return malformed.subarray(offset, offset + length);
          },
        },
        "file.zip",
      ),
    ).rejects.toMatchObject({ code: "BLOB_TYPE_MISMATCH" });
    expect(await inspect("file.zip", await new JSZip().generateAsync({ type: "uint8array" }))).toBe("application/zip");
  });
});
