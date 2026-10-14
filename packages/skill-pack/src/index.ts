import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bộ skill mặc định của Hive: bản sao thư mục `library/` của kho tdduydev/xdev-skills ở một commit ghim
 * (scripts/sync.ts). Hub đọc thẳng từ đĩa; gói chỉ chứa file chữ UTF-8 để gửi qua JSON cho worker và app desktop.
 */
export interface PackSkillMeta {
  name: string;
  description: string;
  /** Nhóm trong danh mục: ui, engineering, testing, security, tools, sdlc, hive. */
  group: string;
  /** Bật sẵn cho tổ chức chưa chỉnh gì. */
  defaultOn: boolean;
  /** SPDX của giấy phép (vd. `MIT`, `Apache-2.0`, `CC-BY-SA-4.0`). */
  license: string;
  /** Repo gốc của skill; null là skill viết riêng cho Hive. */
  upstream: { repo: string; commit: string; path: string; url: string } | null;
  /** sha256 của cả thư mục skill (treeHash): worker cache theo giá trị này, test kiểm bản sao không bị sửa tay. */
  hash: string;
  /** Tăng mỗi lần nội dung đổi (scripts/sync.ts): app desktop so số này để báo có bản mới như skill của hub. */
  version: number;
  files: number;
  bytes: number;
}

export interface SkillPackManifest {
  source: { repo: string; commit: string; path: string };
  skills: PackSkillMeta[];
}

export interface PackFile {
  path: string;
  text: string;
}

export const PACK_DIR = fileURLToPath(new URL("..", import.meta.url));

export function readManifest(dir = PACK_DIR): SkillPackManifest {
  return JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as SkillPackManifest;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const posix = (p: string) => p.split(sep).join("/");

/** Mọi file của skill, đường dẫn tương đối kiểu POSIX, SKILL.md đứng đầu. */
export function skillFiles(name: string, dir = PACK_DIR): PackFile[] {
  const root = join(dir, "skills", name);
  return walk(root)
    .map((f) => ({ path: posix(relative(root, f)), text: readFileSync(f, "utf8") }))
    .sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
}

export function skillText(name: string, dir = PACK_DIR): string {
  return readFileSync(join(dir, "skills", name, "SKILL.md"), "utf8");
}

/** Băm đường dẫn và nội dung theo thứ tự cố định; trùng cách tính của scripts/sync.ts. */
export function treeHash(skillDir: string): string {
  const h = createHash("sha256");
  for (const f of walk(skillDir).sort()) {
    h.update(posix(relative(skillDir, f)));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * name và description trong frontmatter, gồm cả description viết nhiều dòng (`description:` rồi các dòng thụt vào,
 * hoặc `>`/`|`) như skill của Vercel. Không cần thư viện YAML.
 */
export function parseFrontmatter(text: string): { name: string | null; description: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of (m?.[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv?.[1]) {
      key = kv[1];
      let v = (kv[2] ?? "").trim();
      if (/^".*"$/.test(v)) v = JSON.parse(v) as string;
      else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
      else if (/^[>|][-+]?$/.test(v)) v = "";
      fields[key] = v;
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] = `${fields[key] ?? ""} ${line.trim()}`.trim();
    }
  }
  return { name: fields.name || null, description: fields.description ?? "" };
}
