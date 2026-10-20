import { open } from "node:fs/promises";
import { join } from "node:path";

// `request.formData()` của Node gom cả thân request vào bộ nhớ; một lượt nhập Word tới hàng trăm MB nên phải tách
// multipart theo luồng và ghi từng file thẳng ra thư mục tạm.

export interface MultipartLimits {
  /** Trần mỗi file. */
  fileBytes: number;
  /** Số file tối đa của lượt. */
  files: number;
  /** Tổng dung lượng các file của lượt. */
  totalBytes: number;
  /** Trần thân request, gồm cả ranh giới và các trường chữ; chặn client khai `content-length` sai hoặc gửi chunked. */
  bodyBytes: number;
}

export interface MultipartFile {
  field: string;
  /** Tên file, đã bỏ thư mục nếu client gửi kèm. */
  name: string;
  path: string;
  size: number;
}

export interface MultipartForm {
  fields: Map<string, string[]>;
  files: MultipartFile[];
}

export type MultipartErrorReason = "malformed" | "file_too_large" | "batch_too_large";

export class MultipartError extends Error {
  readonly reason: MultipartErrorReason;
  constructor(reason: MultipartErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

const HEADER_MAX_BYTES = 16 * 1024;
const FIELD_MAX_BYTES = 64 * 1024;
// Mỗi file đi kèm tối đa hai trường (relativePaths, lastModified); thêm chỗ cho homeId, mode, docKey...
const fieldsPerFile = 2;
const extraFields = 32;
const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

const malformed = () => new MultipartError("malformed", "Thân request phải là multipart/form-data hợp lệ.");

export function multipartBoundary(contentType: string | null): string | null {
  if (!contentType || !/^multipart\/form-data\s*(;|$)/i.test(contentType)) return null;
  const match = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(contentType);
  return match?.[1] ?? match?.[2] ?? null;
}

interface PartHeaders {
  field: string;
  filename: string | null;
}

function partHeaders(raw: string): PartHeaders {
  const disposition = raw
    .split("\r\n")
    .map((line) => /^content-disposition:\s*(.*)$/i.exec(line)?.[1])
    .find((value) => value !== undefined);
  if (!disposition || !/^form-data\s*(;|$)/i.test(disposition)) throw malformed();
  const param = (key: string) => {
    // Trình duyệt không thoát bằng `\` (tên file Windows cũ còn chứa `\`), nên lấy nguyên giữa hai dấu nháy.
    const quoted = new RegExp(`;\\s*${key}="([^"]*)"`, "i").exec(disposition);
    if (quoted) return quoted[1] ?? "";
    return new RegExp(`;\\s*${key}=([^;\\s]*)`, "i").exec(disposition)?.[1] ?? null;
  };
  const field = param("name");
  if (field === null) throw malformed();
  // RFC 7578: trình duyệt thay `"`, CR, LF trong tên file bằng mã phần trăm; client khác có thể gửi `filename*`.
  const extended = param("filename\\*");
  let filename = param("filename");
  if (extended !== null) {
    const value = /^utf-8''(.*)$/i.exec(extended)?.[1];
    if (value === undefined) throw malformed();
    try {
      filename = decodeURIComponent(value);
    } catch {
      throw malformed();
    }
  } else if (filename !== null) {
    filename = filename.replace(/%22/g, '"').replace(/%0D/gi, "\r").replace(/%0A/gi, "\n");
  }
  // Web gửi `files[]` như form PHP; desktop gửi `files`. Cùng một trường.
  return { field: field.replace(/\[\]$/, ""), filename: filename === null ? null : baseName(filename) };
}

const baseName = (name: string) => name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);

/**
 * Đọc multipart theo luồng: trường chữ giữ trong bộ nhớ (mỗi trường ≤ 64 KiB), file ghi vào `dir`. Vượt giới hạn thì
 * dừng đọc ngay, không chờ hết thân request. Bên gọi tự xoá `dir`.
 */
export async function parseMultipart(
  body: ReadableStream<Uint8Array>,
  boundary: string,
  limits: MultipartLimits,
  dir: string,
): Promise<MultipartForm> {
  // Coi như thân request bắt đầu bằng CRLF để ranh giới đầu tiên cũng có dạng `\r\n--boundary` như các ranh giới sau.
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const form: MultipartForm = { fields: new Map(), files: [] };
  const maxParts = limits.files * (1 + fieldsPerFile) + extraFields;
  let parts = 0;
  let totalFileBytes = 0;
  let bodyBytes = 0;
  let buffer: Buffer = Buffer.from(CRLF);
  let state: "preamble" | "boundary" | "headers" | "body" | "done" = "preamble";
  let current:
    | { kind: "field"; field: string; chunks: Buffer[]; size: number }
    | { kind: "file"; file: MultipartFile; handle: Awaited<ReturnType<typeof open>> }
    | { kind: "skip" }
    | null = null;

  const write = async (data: Buffer) => {
    if (!current || data.length === 0) return;
    if (current.kind === "field") {
      current.size += data.length;
      if (current.size > FIELD_MAX_BYTES) throw malformed();
      current.chunks.push(data);
    } else if (current.kind === "file") {
      current.file.size += data.length;
      totalFileBytes += data.length;
      if (current.file.size > limits.fileBytes)
        throw new MultipartError("file_too_large", `File ${current.file.name} vượt giới hạn dung lượng.`);
      if (totalFileBytes > limits.totalBytes)
        throw new MultipartError("batch_too_large", "Lượt nhập vượt giới hạn dung lượng.");
      await current.handle.write(data);
    }
  };
  const finish = async () => {
    if (current?.kind === "field") {
      const values = form.fields.get(current.field) ?? [];
      values.push(Buffer.concat(current.chunks).toString("utf8"));
      form.fields.set(current.field, values);
    } else if (current?.kind === "file") {
      await current.handle.close();
      form.files.push(current.file);
    }
    current = null;
  };
  const start = async (headers: PartHeaders) => {
    if (++parts > maxParts) throw new MultipartError("batch_too_large", "Lượt nhập có quá nhiều trường.");
    if (headers.filename === null) {
      current = { kind: "field", field: headers.field, chunks: [], size: 0 };
      return;
    }
    // Ô chọn file để trống vẫn gửi một phần có `filename=""`.
    if (headers.filename === "") {
      current = { kind: "skip" };
      return;
    }
    if (form.files.length >= limits.files)
      throw new MultipartError("batch_too_large", "Lượt nhập vượt giới hạn số file.");
    const path = join(dir, String(form.files.length));
    const file = { field: headers.field, name: headers.filename, path, size: 0 };
    current = { kind: "file", file, handle: await open(path, "wx") };
  };

  const reader = body.getReader();
  let ended = false;
  try {
    while (state !== "done") {
      const { value, done } = await reader.read();
      ended = done;
      if (value) {
        bodyBytes += value.length;
        if (bodyBytes > limits.bodyBytes)
          throw new MultipartError("batch_too_large", "Lượt nhập vượt giới hạn dung lượng.");
        buffer = buffer.length ? Buffer.concat([buffer, value]) : Buffer.from(value);
      }
      // Xử lý hết những gì đã có trong bộ đệm trước khi đọc tiếp.
      for (;;) {
        if (state === "preamble" || state === "body") {
          const at = buffer.indexOf(delimiter);
          if (at < 0) {
            // Giữ lại phần đuôi có thể là đầu của ranh giới bị cắt giữa hai chunk.
            const keep = Math.min(buffer.length, delimiter.length - 1);
            if (state === "body") await write(buffer.subarray(0, buffer.length - keep));
            buffer = Buffer.from(buffer.subarray(buffer.length - keep));
            break;
          }
          if (state === "body") {
            await write(buffer.subarray(0, at));
            await finish();
          }
          buffer = buffer.subarray(at + delimiter.length);
          state = "boundary";
        }
        if (state === "boundary") {
          if (buffer.length < 2) break;
          if (buffer[0] === 0x2d && buffer[1] === 0x2d) {
            state = "done";
            break;
          }
          // Cho phép khoảng trắng thừa sau ranh giới (RFC 2046, transport padding).
          const eol = buffer.indexOf(CRLF);
          if (eol < 0) {
            if (buffer.length > 256) throw malformed();
            break;
          }
          if (buffer.subarray(0, eol).toString("latin1").trim() !== "") throw malformed();
          buffer = buffer.subarray(eol + 2);
          state = "headers";
        }
        if (state === "headers") {
          const end = buffer.indexOf(HEADER_END);
          if (end < 0) {
            if (buffer.length > HEADER_MAX_BYTES) throw malformed();
            break;
          }
          if (end > HEADER_MAX_BYTES) throw malformed();
          await start(partHeaders(buffer.subarray(0, end).toString("utf8")));
          buffer = buffer.subarray(end + HEADER_END.length);
          state = "body";
        }
      }
      if (done) break;
    }
    if (state !== "done") throw malformed();
    // Đọc nốt phần sau ranh giới cuối (thường chỉ là CRLF) để kết nối trả lời được bình thường.
    while (!ended) {
      const { value, done } = await reader.read();
      ended = done;
      bodyBytes += value?.length ?? 0;
      if (bodyBytes > limits.bodyBytes)
        throw new MultipartError("batch_too_large", "Lượt nhập vượt giới hạn dung lượng.");
    }
    return form;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    // Lỗi giữa chừng một file thì file đó còn mở; `current` gán trong closure nên TS không theo dõi được kiểu ở đây.
    const pending = current as { handle?: { close(): Promise<void> } } | null;
    await pending?.handle?.close().catch(() => {});
  }
}
