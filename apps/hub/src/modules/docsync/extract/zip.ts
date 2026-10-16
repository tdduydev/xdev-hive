import JSZip from "jszip";
import { ExtractError, type ExtractLimits } from "./types.ts";

export type ZipEntries = Map<string, Uint8Array>;

const tooBig = () => new ExtractError("File nén giải ra quá lớn, có thể là zip bomb. Đã dừng trích.");

/**
 * Giải mọi entry và đếm byte thật khi giải, không tin kích thước ghi trong header (zip bomb ghi sai được). Thư viện
 * đọc docx/xlsx sau đó chỉ nhận lại đúng các byte đã đếm, nên không thể giải ra nhiều hơn giới hạn.
 */
export async function readZip(bytes: Uint8Array, limits: ExtractLimits): Promise<ZipEntries> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: false });
  } catch {
    throw new ExtractError("File hỏng hoặc không phải định dạng Office.");
  }
  const files = Object.values(zip.files).filter((f) => !f.dir);
  if (files.length > limits.zipEntries) throw tooBig();
  const entries: ZipEntries = new Map();
  let budget = limits.unzippedBytes;
  for (const file of files) {
    const data = await inflate(file, budget);
    budget -= data.byteLength;
    entries.set(file.name, data);
  }
  return entries;
}

// `internalStream` có ở runtime nhưng thiếu trong .d.ts; đây là cách duy nhất của jszip để giải từng phần và dừng giữa chừng.
type InternalStream = {
  on(event: "data", cb: (chunk: Uint8Array) => void): InternalStream;
  on(event: "error" | "end", cb: () => void): InternalStream;
  pause(): InternalStream;
  resume(): InternalStream;
};

function inflate(file: JSZip.JSZipObject, budget: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const parts: Uint8Array[] = [];
    let size = 0;
    let done = false;
    const stream = (file as unknown as { internalStream(type: "uint8array"): InternalStream }).internalStream(
      "uint8array",
    );
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      stream.pause();
      reject(error);
    };
    stream
      .on("data", (chunk) => {
        if (done) return;
        size += chunk.byteLength;
        if (size > budget) return fail(tooBig());
        parts.push(chunk);
      })
      .on("error", () => fail(new ExtractError("File nén bị hỏng, không đọc được.")))
      .on("end", () => {
        if (done) return;
        done = true;
        resolve(Buffer.concat(parts));
      })
      .resume();
  });
}

/** Đóng gói lại đúng các entry đã giải (không nén) để mammoth/exceljs đọc mà không tự giải lần nữa từ bản gốc. */
export async function repack(entries: ZipEntries): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, data] of entries) zip.file(name, data, { compression: "STORE" });
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

export function entryText(entries: ZipEntries, name: string): string | null {
  const data = entries.get(name);
  return data ? new TextDecoder().decode(data) : null;
}
