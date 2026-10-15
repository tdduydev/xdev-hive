import { createHash } from "node:crypto";
import { matchGlob, splitBlocks } from "@xdev-hive/contracts";
// T005 sở hữu package.json; thay bằng "yaml" sau khi task đó khai báo phụ thuộc trực tiếp.
import { parseDocument } from "../../../../../node_modules/.pnpm/node_modules/yaml/dist/index.js";

export type Eol = "lf" | "crlf";
export const hasBom = (content: string): boolean => content.startsWith("\uFEFF");
export const detectEol = (content: string): Eol => (/\r?\n/.exec(content)?.[0] === "\r\n" ? "crlf" : "lf");
export const toLf = (content: string): string => content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
export const fromLf = (content: string, eol: Eol, bom = false): string =>
  (bom ? "\uFEFF" : "") + (eol === "crlf" ? toLf(content).replace(/\n/g, "\r\n") : toLf(content));

/** So hash sau khi khôi phục EOL/BOM, vì repo so byte chứ không so văn bản chuẩn hoá. */
export const contentHash = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");

export type FrontMatter = {
  raw: string | null;
  body: string;
  title?: string;
  tags: string[];
  confidential: boolean;
  key?: string;
  warnings: string[];
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseFrontMatter(content: string): FrontMatter {
  const text = content.replace(/^\uFEFF/, "");
  const result: FrontMatter = { raw: null, body: content, tags: [], confidential: false, warnings: [] };
  if (!/^---[ \t]*\r?\n/.test(text)) return result;
  const match = /^---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(text);
  if (!match) {
    result.warnings.push("Front-matter thiếu dòng kết thúc.");
    return result;
  }
  result.raw = (hasBom(content) ? "\uFEFF" : "") + match[0];
  result.body = text.slice(match[0].length);
  try {
    const document = parseDocument(match[1] ?? "", { schema: "core", customTags: [], uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error("YAML");
    const data: unknown = document.toJS({ maxAliasCount: 50 });
    if (data === null) return result;
    if (!record(data)) throw new Error("YAML");
    if (typeof data.title === "string" && data.title.trim()) result.title = data.title.trim();
    if (Array.isArray(data.tags)) result.tags = data.tags.filter((tag): tag is string => typeof tag === "string");
    result.confidential = data.confidential === true;
    const key = record(data.hive) ? data.hive.key : data["hive.key"];
    if (typeof key === "string") result.key = key;
  } catch {
    // Lỗi của yaml có thể chứa chính dòng bí mật, nên chỉ đưa cảnh báo cố định vào báo cáo nhập.
    result.warnings.push("Front-matter YAML không hợp lệ hoặc có cấu trúc không được hỗ trợ.");
  }
  return result;
}

export function titleOf(content: string, path: string): string {
  const front = parseFrontMatter(content);
  const heading = splitBlocks(toLf(front.body))
    .map((block) => /^ {0,3}#[ \t]+(.+?)[ \t]*$/.exec(block.split("\n")[0] ?? "")?.[1])
    .find((title) => title !== undefined);
  return (
    front.title ??
    heading?.replace(/[ \t]+#+[ \t]*$/, "").trim() ??
    path.split("/").at(-1)?.replace(/\.md$/i, "") ??
    "Tài liệu"
  ).slice(0, 200);
}

export type LfsPointer = { oid: string; size: number };
const LFS_VERSION = "version https://git-lfs.github.com/spec/v1";

export function parseLfsPointer(content: string): LfsPointer | null {
  if (Buffer.byteLength(content) >= 200 || hasBom(content)) return null;
  const match =
    /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (0|[1-9][0-9]*)\n?$/.exec(
      toLf(content),
    );
  const size = Number(match?.[2]);
  return match?.[1] && Number.isSafeInteger(size) ? { oid: match[1], size } : null;
}

export const isLfsPointer = (content: string): boolean => parseLfsPointer(content) !== null;

export function lfsPointer(oid: string, size: number): string {
  if (!/^[a-f0-9]{64}$/.test(oid) || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("Mã SHA-256 hoặc kích thước đối tượng LFS không hợp lệ.");
  }
  return `${LFS_VERSION}\noid sha256:${oid}\nsize ${size}\n`;
}

export type LfsRule = { pattern: string; filter: string | null };

export function parseGitattributes(content: string): LfsRule[] {
  const rules: LfsRule[] = [];
  for (const line of toLf(content).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^("(?:[^"\\]|\\.)*"|\S+)\s+(.+)$/.exec(trimmed);
    if (!match?.[1] || !match[2]) continue;
    let pattern = match[1];
    if (pattern.startsWith('"')) {
      try {
        pattern = JSON.parse(pattern) as string;
      } catch {
        continue;
      }
    }
    // Bản đầu không hỗ trợ macro, phủ định, lớp ký tự hay C-escape dạng octal của Git.
    if (/^[![]/.test(pattern) || /[[\]\\]/.test(pattern) || pattern.endsWith("/")) continue;
    const filter = match[2]
      .split(/\s+/)
      .filter((attr) => /^(?:filter(?:=|$)|[-!]filter$)/.test(attr))
      .at(-1);
    if (!filter) continue;
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    else if (!pattern.includes("/")) pattern = `**/${pattern}`;
    rules.push({ pattern, filter: filter.startsWith("filter=") ? filter.slice(7) : null });
  }
  return rules;
}

export function isLfsPath(path: string, rules: readonly LfsRule[]): boolean {
  let lfs = false;
  for (const rule of rules) {
    // matchGlob mặc định khớp cả cây con; dấu kết thúc buộc mẫu gitattributes khớp đúng file.
    if (matchGlob(`${rule.pattern}\u0000`, `${path}\u0000`)) lfs = rule.filter === "lfs";
  }
  return lfs;
}
