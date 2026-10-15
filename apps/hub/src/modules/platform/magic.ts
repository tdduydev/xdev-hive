import { extname } from "node:path";
import { BadRequestError } from "./errors.ts";

const OOXML = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;
const extensions: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  svg: "image/svg+xml",
  ...OOXML,
  txt: "text/plain",
  md: "text/plain",
  markdown: "text/plain",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
};

export interface BlobReader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function detectMediaType(input: Uint8Array): string | null {
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const starts = (hex: string) => b.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
  if (starts("89504e470d0a1a0a")) return "image/png";
  if (starts("ffd8ff")) return "image/jpeg";
  if (/^GIF8[79]a/.test(b.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (b.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (starts("504b0304") || starts("504b0506")) return "application/zip";
  const xml = b
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .replace(/^<\?xml\b[^?]*\?>\s*/i, "")
    .replace(/^(?:<!--[\s\S]*?-->\s*)*/, "")
    .replace(/^<!DOCTYPE\s+svg\b[^>]*>\s*/i, "");
  if (/^<svg(?:\s|>)/i.test(xml)) return "image/svg+xml";
  return null;
}

function mismatch(): never {
  throw new BadRequestError("BLOB_TYPE_MISMATCH", "Đuôi file, loại MIME và nội dung file không khớp.");
}

/** Chỉ đọc tên trong central directory; không giải nén dữ liệu do người dùng gửi. */
async function zipType(reader: BlobReader): Promise<string> {
  const tailOffset = Math.max(0, reader.size - 65_557);
  const tail = Buffer.from(await reader.read(tailOffset, reader.size - tailOffset));
  let end = tail.length - 22;
  for (; end >= 0; end--) {
    if (tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length) break;
  }
  if (end < 0) return mismatch();
  const count = tail.readUInt16LE(end + 10);
  const size = tail.readUInt32LE(end + 12);
  let offset = tail.readUInt32LE(end + 16);
  const stop = offset + size;
  // ZIP64 và archive nhiều volume cần bộ đọc riêng; không đoán chúng là OOXML.
  if (count === 0xffff || offset === 0xffffffff || tail.readUInt32LE(end + 4) !== 0 || stop > tailOffset + end)
    return mismatch();
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > stop) return mismatch();
    const header = Buffer.from(await reader.read(offset, 46));
    if (header.length !== 46 || header.readUInt32LE(0) !== 0x02014b50) return mismatch();
    const length = header.readUInt16LE(28);
    const next = offset + 46 + length + header.readUInt16LE(30) + header.readUInt16LE(32);
    if (next > stop) return mismatch();
    names.add(Buffer.from(await reader.read(offset + 46, length)).toString("utf8"));
    offset = next;
  }
  if (offset !== stop) return mismatch();
  if (names.has("[Content_Types].xml")) {
    if (names.has("word/document.xml")) return OOXML.docx;
    if (names.has("xl/workbook.xml")) return OOXML.xlsx;
    if (names.has("ppt/presentation.xml")) return OOXML.pptx;
  }
  return "application/zip";
}

export async function inspectFileType(reader: BlobReader, filename?: string, declaredType?: string): Promise<string> {
  const prefix = await reader.read(0, Math.min(reader.size, 8192));
  let detected = detectMediaType(prefix);
  if (detected === "application/zip") detected = await zipType(reader);
  const declared = declaredType?.split(";")[0]?.trim().toLowerCase();
  const expected = filename
    ? extensions[extname(filename).slice(1).toLowerCase()]
    : declared?.startsWith("text/") || declared === "application/json"
      ? declared
      : undefined;
  if (filename && !expected && detected) return mismatch();
  if (expected && detected !== expected) {
    if (!detected && (expected.startsWith("text/") || expected === "application/json")) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(prefix, { stream: prefix.length < reader.size });
      } catch {
        return mismatch();
      }
      if (prefix.includes(0)) return mismatch();
      detected = expected;
    } else return mismatch();
  }
  const mediaType = detected ?? "application/octet-stream";
  if (declared && declared !== "application/octet-stream" && declared !== mediaType) return mismatch();
  return mediaType;
}
