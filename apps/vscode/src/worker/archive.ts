import { gunzipSync, inflateRawSync } from "node:zlib";

const LIMIT = 200 * 1024 * 1024;

// Chỉ lấy hai tên cố định vào bộ nhớ, không giải đường dẫn từ archive xuống ổ đĩa.
export function extract(archive: Buffer, windows: boolean): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const wanted = new Set(windows ? ["hive-worker.exe", "hive.exe"] : ["hive-worker", "hive"]);
  if (windows) {
    let end = archive.length - 22;
    while (end >= Math.max(0, archive.length - 65557) && archive.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50) throw new Error("File ZIP không hợp lệ");
    let offset = archive.readUInt32LE(end + 16);
    const count = archive.readUInt16LE(end + 10);
    for (let i = 0; i < count; i++) {
      if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("Mục ZIP không hợp lệ");
      const method = archive.readUInt16LE(offset + 10);
      const size = archive.readUInt32LE(offset + 20);
      const nameLength = archive.readUInt16LE(offset + 28);
      const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString();
      if (wanted.has(name)) {
        const local = archive.readUInt32LE(offset + 42);
        if (archive.readUInt32LE(local) !== 0x04034b50) throw new Error("Mục ZIP không hợp lệ");
        const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
        if (start + size > archive.length || size > LIMIT) throw new Error("Mục ZIP quá lớn hoặc bị cắt");
        const data = archive.subarray(start, start + size);
        if (method !== 0 && method !== 8) throw new Error("Kiểu nén ZIP không hỗ trợ");
        result.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: LIMIT }));
      }
      offset += 46 + nameLength + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
    }
  } else {
    const tar = gunzipSync(archive, { maxOutputLength: LIMIT });
    for (let offset = 0; offset + 512 <= tar.length; ) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((b) => b === 0)) break;
      const name = header.subarray(0, 100).toString().split("\0")[0] ?? "";
      const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0/g, "").trim(), 8);
      if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) {
        throw new Error("Mục TAR không hợp lệ");
      }
      if (wanted.has(name) && (header[156] === 0 || header[156] === 48)) {
        result.set(name, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  }
  if (!result.get(windows ? "hive-worker.exe" : "hive-worker")?.length) {
    throw new Error("Gói phát hành thiếu hive-worker");
  }
  return result;
}
