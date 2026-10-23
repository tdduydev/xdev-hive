import { ORPCError } from "@orpc/client";
import {
  docRepoPath,
  WORD_IMPORT_DEFAULT_LIMITS,
  WORD_IMPORT_ERRORS,
  WORD_IMPORT_WARNINGS,
  type WordImportErrorCode,
  type WordImportFile,
  type WordImportFileState,
  type WordImportGetOutput,
  wordImportErrorCode,
} from "@xdev-hive/contracts";
import { hubErrorText } from "@/lib/hub-error.ts";
import { invoke } from "@/lib/tauri.ts";

/** Khớp `WordFile` và `WordPick` trong src-tauri/src/word_import.rs (camelCase). */
export interface PickedWordFile {
  index: number;
  name: string;
  relativeDir: string;
  relativePath: string;
  size: number;
  lastModified: number;
}

export interface WordPick {
  pickId: string;
  /** Thư mục đã chọn; null khi chọn từng file. */
  root: string | null;
  files: PickedWordFile[];
  /** Rust dừng duyệt thư mục khi quá nhiều file để một ổ đĩa lỡ chọn không treo app. */
  truncated: boolean;
}

export interface UploadInput {
  homeId: string;
  targetDir: string;
  confidential?: boolean;
}

/** Khớp `Progress` của Rust: `sent` là số byte của file `index` đã gửi. */
export interface UploadProgress {
  uploadId: string;
  index: number;
  name: string;
  sent: number;
  size: number;
}

/** Lỗi Rust trả khi tải lên (`UploadError`); `status` 0 là không tới được hub. */
export interface UploadFailure {
  status: number;
  code?: string;
  message: string;
}

/** Hộp thoại chọn file (`folder = false`) hoặc thư mục; huỷ thì null. Rust giữ đường dẫn thật, giao diện chỉ thấy chỉ số. */
export const pickWordFiles = (folder: boolean) => invoke<WordPick | null>("pick_word_files", { folder });

export const uploadWordFiles = (uploadId: string, pickId: string, indexes: number[], input: UploadInput) =>
  invoke<{ importId: string }>("hub_upload_word", { uploadId, pickId, indexes, input });

/** Nghe tiến độ tải lên; trả hàm bỏ nghe. Ngoài Tauri (không có API sự kiện) thì không có tiến độ chứ không lỗi. */
export async function onUploadProgress(handler: (progress: UploadProgress) => void): Promise<() => void> {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return () => {};
  return listen<UploadProgress>("word-import:progress", (event) => handler(event.payload));
}

export const LIMITS = WORD_IMPORT_DEFAULT_LIMITS;

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || Number.isInteger(value) ? String(value) : value.toFixed(1).replace(".", ",");
  return `${text} ${units[unit]}`;
}

/** Word tạo `~$tên.docx` làm file khoá khi đang mở tài liệu; không phải tài liệu nên bỏ khỏi danh sách. */
export const isLockFile = (name: string) => name.startsWith("~$");

/** Bỏ file khoá của Word (Rust đã lọc theo đuôi). Trả file giữ lại và số file bỏ. */
export function dropLockFiles(files: readonly PickedWordFile[]): { files: PickedWordFile[]; dropped: number } {
  const kept = files.filter((file) => !isLockFile(file.name));
  return { files: kept, dropped: files.length - kept.length };
}

/** Chặn sớm (FR-002). Hub vẫn kiểm lại và giới hạn thật do quản trị đặt, nên đây chỉ là mặc định. */
export function selectionIssues(files: readonly PickedWordFile[], limits = LIMITS): string[] {
  const issues: string[] = [];
  if (files.length > limits.batchFiles)
    issues.push(`Quá ${limits.batchFiles} file một lượt (đang chọn ${files.length}). Bỏ bớt hoặc chia làm nhiều lượt.`);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > limits.batchBytes)
    issues.push(
      `Tổng dung lượng ${formatBytes(total)} vượt ${formatBytes(limits.batchBytes)} một lượt. Bỏ bớt hoặc chia làm nhiều lượt.`,
    );
  const big = files.filter((file) => file.size > limits.fileBytes);
  for (const file of big.slice(0, 3))
    issues.push(
      `${file.name} (${formatBytes(file.size)}) vượt ${formatBytes(limits.fileBytes)} một file. Nén ảnh trong Word hoặc tách thành nhiều file.`,
    );
  if (big.length > 3)
    issues.push(`Và ${big.length - 3} file khác cũng vượt ${formatBytes(limits.fileBytes)} một file.`);
  const badDirs = [
    ...new Set(files.map((file) => file.relativeDir).filter((dir) => dir && !docRepoPath.safeParse(dir).success)),
  ];
  for (const dir of badDirs.slice(0, 3))
    issues.push(
      `Thư mục "${dir}" có ký tự hub không nhận (\\ : hoặc tên rỗng, "." , ".."). Đổi tên thư mục rồi chọn lại.`,
    );
  return issues;
}

/** `docs/srs` → `docs/srs/`; bỏ khoảng trắng, `./`, `/` đầu và đổi `\` thành `/`. Rỗng là gốc repo. */
export function normalizeTargetDir(input: string): string {
  const parts = input
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  return parts.length ? `${parts.join("/")}/` : "";
}

export function targetDirIssue(dir: string, root: string): string | null {
  const home = normalizeTargetDir(root);
  if (dir && !docRepoPath.safeParse(dir).success)
    return "Đường dẫn thư mục không hợp lệ. Dùng dạng docs/srs/, không có .. và không có dấu \\ hay :.";
  if (!dir.startsWith(home)) return `Thư mục đích phải nằm trong ${home || "gốc repo"} của nhà tài liệu này.`;
  return null;
}

function isFailure(error: unknown): error is UploadFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    "status" in error &&
    typeof error.status === "number"
  );
}

/**
 * Câu báo lỗi của lệnh tải lên. Mã nghiệp vụ lấy câu có cách sửa từ hợp đồng (FR-022); lỗi Rust có sẵn tiếng Việt trong
 * `message` (kể cả "Token không còn dùng được…" khi 401 và "không kết nối được hub" khi trạng thái 0).
 */
export function uploadErrorText(error: unknown): string {
  if (!isFailure(error)) return error instanceof Error ? error.message : String(error);
  if (error.code && error.code in WORD_IMPORT_ERRORS)
    return WORD_IMPORT_ERRORS[error.code as WordImportErrorCode].message;
  if (error.status === 413) return "Lượt tải lên quá lớn so với giới hạn của hub. Chia thành nhiều lượt nhỏ hơn.";
  return error.message || `Không tải lên được (mã ${error.status}). Thử lại hoặc báo quản trị hub.`;
}

/** Câu báo lỗi của `wordImports.*`: câu của hợp đồng theo `data.code` để web và desktop nói giống nhau. */
export function importErrorText(error: unknown): string {
  const code = error instanceof ORPCError && error.data ? wordImportErrorCode.safeParse(error.data.code) : null;
  return code?.success ? WORD_IMPORT_ERRORS[code.data].message : hubErrorText(error);
}

export function warningText(warning: WordImportFile["warnings"][number]): string {
  const base = WORD_IMPORT_WARNINGS[warning.code];
  const times = warning.count > 1 ? ` (${warning.count} chỗ)` : "";
  return `${base}${times}${warning.detail ? ` ${warning.detail}` : ""}`;
}

const ACTIVE_FILE: readonly WordImportFileState[] = ["queued", "converting"];
const ACTIVE_IMPORT: readonly WordImportGetOutput["import"]["state"][] = ["uploading", "converting", "committing"];

/** Còn việc hub đang làm thì hỏi lại; xong hết thì dừng để màn không gọi hub vô ích. */
export function stillWorking(data: WordImportGetOutput | undefined): boolean {
  if (!data) return false;
  return ACTIVE_IMPORT.includes(data.import.state) || data.files.some((file) => ACTIVE_FILE.includes(file.state));
}

/** File được tạo hoặc gửi duyệt khi bấm nút: đã sẵn sàng và chưa bị loại. */
export const isCommittable = (file: WordImportFile) => file.state === "ready" && !file.excluded;

/**
 * Viewer Markdown hiện chữ thô cho `<br>` trong ô bảng nên đổi thành ký hiệu xuống dòng. Ảnh không nhúng vào Markdown:
 * viewer chỉ tải ảnh `http(s)` còn CSP của app chỉ cho `data:`, nên ảnh hiện ở mục riêng (`referencedImages`).
 */
export function previewMarkdown(markdown: string): string {
  return markdown.replace(/<br\s*\/?>/gi, " ⏎ ");
}

const BASENAME = /[^/]+$/;
/** Ảnh mà Markdown thực sự nhắc tới (theo tên đã băm trong link), đúng thứ tự xuất hiện, để mục ảnh không hiện ảnh thừa. */
export function referencedImages<T extends { name: string }>(markdown: string, images: readonly T[]): T[] {
  const byName = new Map(images.map((image) => [image.name, image]));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
    const raw = BASENAME.exec((match[1] ?? "").split(/[?#]/)[0] ?? "")?.[0];
    if (!raw) continue;
    let name = raw;
    try {
      name = decodeURIComponent(raw);
    } catch {
      /* Tên không giải mã được thì so nguyên văn. */
    }
    const image = byName.get(name);
    if (image && !seen.has(name)) {
      seen.add(name);
      out.push(image);
    }
  }
  return out;
}
