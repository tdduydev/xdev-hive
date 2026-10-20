import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildOle, encryptedOoxml, oleDoc } from "../../../test/ole-fixture.ts";
import { detectMediaType, inspectFileType, inspectWordFile } from "./magic.ts";

const inspect = (filename: string, data: Uint8Array, declaredType?: string) =>
  inspectFileType(
    { size: data.length, read: async (offset, length) => data.subarray(offset, offset + length) },
    filename,
    declaredType,
  );
const reader = (data: Uint8Array) => ({
  size: data.length,
  read: async (offset: number, length: number) => data.subarray(offset, offset + length),
});
const ODT = "application/vnd.oasis.opendocument.text";
const odt = (mimetype = ODT, compression: "STORE" | "DEFLATE" = "STORE") =>
  new JSZip()
    .file("mimetype", mimetype, { compression })
    .file("content.xml", "<office:document-content/>")
    .file("META-INF/manifest.xml", "<manifest/>")
    .generateAsync({ type: "uint8array", compression: "DEFLATE" });
const docx = () =>
  new JSZip()
    .file("[Content_Types].xml", "<Types/>")
    .file("word/document.xml", "<w:document/>")
    .generateAsync({ type: "uint8array" });
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
  it("nhận .odt qua entry mimetype không nén; ODF khác hoặc mimetype bị nén chỉ là ZIP", async () => {
    expect(await inspect("bao-cao.odt", await odt())).toBe(ODT);
    expect(await inspect("bao-cao.zip", await odt("application/vnd.oasis.opendocument.spreadsheet"))).toBe(
      "application/zip",
    );
    await expect(inspect("bang.odt", await odt("application/vnd.oasis.opendocument.spreadsheet"))).rejects.toThrow(
      /không khớp/,
    );
    await expect(inspect("bao-cao.odt", await odt(ODT, "DEFLATE"))).rejects.toThrow(/không khớp/);
    await expect(inspect("bao-cao.docx", await odt())).rejects.toThrow(/không khớp/);
  });

  it("nhận .doc Word 97-2003; file có mật khẩu báo BLOB_ENCRYPTED", async () => {
    expect(await inspect("cu.doc", oleDoc())).toBe("application/msword");
    await expect(inspect("mat-khau.docx", encryptedOoxml())).rejects.toMatchObject({ code: "BLOB_ENCRYPTED" });
    await expect(inspect("mat-khau.xlsx", encryptedOoxml())).rejects.toMatchObject({ code: "BLOB_ENCRYPTED" });
    // Word đổi đuôi khác vẫn được đính kèm như file lạ, như trước khi nhận dạng .doc.
    expect(await inspect("cu.bin", oleDoc())).toBe("application/octet-stream");
    // RTF lưu tên .doc và Excel 97 đổi đuôi .doc: đính kèm được như trước, nhưng không phải Word.
    expect(await inspect("rtf.doc", Buffer.from("{\\rtf1\\ansi hello}"))).toBe("application/octet-stream");
    const xls = buildOle([{ name: "Workbook", data: Buffer.alloc(4096) }]);
    expect(await inspect("bang.doc", xls)).toBe("application/octet-stream");
  });

  it("nhập Word kiểm chặt: đuôi khớp nội dung, có mật khẩu, OLE hỏng", async () => {
    expect(await inspectWordFile(reader(await docx()), "A.DOCX")).toBe("docx");
    expect(await inspectWordFile(reader(oleDoc()), "cu.doc")).toBe("doc");
    expect(await inspectWordFile(reader(await odt()), "moi.odt")).toBe("odt");
    for (const [name, data] of [
      ["doi-duoi.docx", oleDoc()],
      ["doi-duoi.doc", await docx()],
      ["rtf.doc", Buffer.from("{\\rtf1}")],
      ["bang.doc", buildOle([{ name: "Workbook", data: Buffer.alloc(4096) }])],
      ["hong.doc", oleDoc().subarray(0, 1024)],
      ["anh.pdf", Buffer.from("%PDF-1.7")],
    ] as const) {
      await expect(inspectWordFile(reader(data), name), name).rejects.toMatchObject({ code: "BLOB_TYPE_MISMATCH" });
    }
    await expect(inspectWordFile(reader(encryptedOoxml()), "a.docx")).rejects.toMatchObject({ code: "BLOB_ENCRYPTED" });
    await expect(inspectWordFile(reader(oleDoc({ encrypted: true })), "a.doc")).rejects.toMatchObject({
      code: "BLOB_ENCRYPTED",
    });
  });
});
