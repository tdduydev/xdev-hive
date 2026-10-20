// Hậu xử lý Markdown sau pandoc (plan.md mục 3 bước 5). Hàm thuần: ảnh, link, front matter, thống kê, log cảnh báo.
import { createHash } from "node:crypto";
import { relativeFrom } from "../assets.ts";

/** `![alt](đích)`; đích không có dấu cách hay ngoặc, vì pandoc đặt tên ảnh `imageN.ext`. */
const IMAGE_LINK = /(!\[[^\]]*\]\()([^()\s]+)(\))/g;
// Ảnh đã đổi tên chỉ còn tên băm, đường dẫn tính lại ở `relinkImages`.
const HASHED_IMAGE_LINK = /(!\[[^\]]*\]\()([0-9a-f]{12}\.[a-z0-9]+)(\))/g;
// EMF/WMF trình duyệt không hiện được nên lúc chuyển đã thành link tải thường (Q10); vẫn nằm trong thư mục ảnh.
const HASHED_DOWNLOAD_LINK = /((?<!!)\[[^\]]*\]\()([0-9a-f]{12}\.(?:emf|wmf|emz|wmz))(\))/g;

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface MediaFile {
  /** Đường dẫn đúng như link trong Markdown pandoc ra (`m/media/image1.png`). */
  path: string;
  bytes: Uint8Array;
  /** Đuôi đã dò theo nội dung (`inspectFileType`); không có thì lấy từ `path`. */
  ext?: string;
}

export interface RenamedImage {
  /** `<12 ký tự đầu SHA-256>.<đuôi>`. */
  name: string;
  sha256: string;
  bytes: Uint8Array;
}

function extensionOf(file: MediaFile): string {
  const fromPath = file.path.includes(".") ? (file.path.split(".").at(-1) ?? "") : "";
  const ext = (file.ext ?? fromPath).toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext || "bin";
}

/**
 * Đổi tên ảnh theo nội dung (FR-010, FR-013) và thay link trong Markdown bằng tên mới. Cùng nội dung ra cùng tên nên
 * ảnh lặp (logo mẫu SRS) chỉ còn một file. Ảnh không có trong `media` (link ngoài, ảnh lạ) giữ nguyên.
 */
export function renameImages(
  markdown: string,
  media: readonly MediaFile[],
): { markdown: string; images: RenamedImage[] } {
  const byPath = new Map<string, string>();
  const images = new Map<string, RenamedImage>();
  for (const file of media) {
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    const name = `${sha256.slice(0, 12)}.${extensionOf(file)}`;
    byPath.set(file.path, name);
    if (!images.has(name)) images.set(name, { name, sha256, bytes: file.bytes });
  }
  return {
    markdown: markdown.replace(IMAGE_LINK, (all, open: string, target: string, close: string) => {
      const name = byPath.get(target);
      return name === undefined ? all : `${open}${name}${close}`;
    }),
    images: [...images.values()].sort((a, b) => text(a.name, b.name)),
  };
}

/**
 * Đổi tên ảnh đã băm thành đường dẫn tương đối từ tài liệu tới thư mục ảnh. Đường dẫn tài liệu đổi được ở xem trước
 * (plan.md mục 6) nên hàm này chạy lúc tạo, trên Markdown còn link là tên ảnh.
 * `assetsDir` là đường dẫn repo của thư mục ảnh, vd. `docs/assets`.
 */
export function relinkImages(markdown: string, docPath: string, assetsDir: string): string {
  const dir = assetsDir.replace(/\/+$/, "");
  const relink = (_all: string, open: string, name: string, close: string) =>
    `${open}${relativeFrom(docPath, `${dir}/${name}`)}${close}`;
  return markdown.replace(HASHED_IMAGE_LINK, relink).replace(HASHED_DOWNLOAD_LINK, relink);
}

export interface FrontMatterInput {
  title: string;
  /** Tên file Word gốc. */
  file: string;
  /** SHA-256 của file Word gốc. */
  sha256: string;
  confidential: boolean;
}

/**
 * Front matter của tài liệu sinh ra (FR-012). Không ghi thời điểm nhập để cùng file ra cùng byte (FR-013). Chuỗi viết
 * bằng JSON, vốn là YAML hợp lệ, nên không cần bộ ghi YAML. Kết thúc bằng một dòng trống: nối thẳng với thân tài liệu.
 * `confidential: true` theo quy ước của `splitFrontMatter` ở knowledge/doc-search.ts.
 */
export function frontMatter({ title, file, sha256, confidential }: FrontMatterInput): string {
  const lines = [
    "---",
    `title: ${JSON.stringify(title)}`,
    "word:",
    `  file: ${JSON.stringify(file)}`,
    `  sha256: ${JSON.stringify(sha256)}`,
    ...(confidential ? ["confidential: true"] : []),
    "---",
    "",
    "",
  ];
  return lines.join("\n");
}

export interface MarkdownStats {
  headings: number;
  tables: number;
  images: number;
}

const FRONT_MATTER = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}[ \t]+\S/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

/** Đếm tiêu đề ATX, bảng pipe (hàng phân cách có `|` ngay sau một hàng có `|`) và ảnh; bỏ qua khối code và front matter. */
export function countStats(markdown: string): MarkdownStats {
  const stats: MarkdownStats = { headings: 0, tables: 0, images: 0 };
  let fence: { char: string; length: number } | undefined;
  let previous = "";
  for (const line of markdown.replace(FRONT_MATTER, "").split(/\r?\n/)) {
    const marker = FENCE.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1]?.[0] === fence.char &&
        (marker[1]?.length ?? 0) >= fence.length &&
        line.trim() === marker[1]
      ) {
        fence = undefined;
      }
      previous = "";
      continue;
    }
    if (marker) {
      fence = { char: marker[1]?.[0] ?? "`", length: marker[1]?.length ?? 3 };
      previous = "";
      continue;
    }
    if (HEADING.test(line)) stats.headings++;
    if (line.includes("|") && TABLE_DELIMITER.test(line) && previous.includes("|")) stats.tables++;
    stats.images += line.match(IMAGE)?.length ?? 0;
    previous = line;
  }
  return stats;
}

/**
 * Mã cảnh báo cố định của bộ lọc (plan.md mục 3 bước 4), giao diện dịch sang tiếng Việt. Khai báo cục bộ vì kiểu dùng
 * chung chưa có trong contracts (T001); đồng bộ lại khi T001 vào.
 */
export const WORD_WARNING_CODES = [
  "nested_table",
  "equation",
  "footnote",
  "emf_image",
  "tracked_changes",
  "comments",
  "no_h1",
  "textbox",
] as const;
export type WordWarningCode = (typeof WORD_WARNING_CODES)[number];

export interface PandocWarning {
  code: WordWarningCode;
  /** Phần sau `<mã>:` trong thông điệp, rỗng nếu không có. */
  detail: string;
}

const WARNING_MESSAGE = new RegExp(`^(${WORD_WARNING_CODES.join("|")})(?::\\s*([\\s\\S]*))?$`);

/**
 * Lấy cảnh báo từ `--log=log.json` của pandoc: chỉ `ScriptingWarning` mà thông điệp bắt đầu bằng một mã cố định
 * (`pandoc.log.warn("nested_table: ...")` trong filter.lua). Pandoc không ghi log theo thứ tự tài liệu nên kết quả được
 * sắp theo mã rồi chi tiết. Log rỗng hoặc hỏng thì trả về rỗng: cảnh báo chỉ để báo, không làm hỏng việc chuyển.
 */
export function parsePandocLog(json: string): PandocWarning[] {
  let entries: unknown;
  try {
    entries = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const warnings: PandocWarning[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { type, message } = entry as { type?: unknown; message?: unknown };
    if (type !== "ScriptingWarning" || typeof message !== "string") continue;
    const match = WARNING_MESSAGE.exec(message.trim());
    if (match) warnings.push({ code: match[1] as WordWarningCode, detail: (match[2] ?? "").trim() });
  }
  return warnings.sort(
    (a, b) => WORD_WARNING_CODES.indexOf(a.code) - WORD_WARNING_CODES.indexOf(b.code) || text(a.detail, b.detail),
  );
}
