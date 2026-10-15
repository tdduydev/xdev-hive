import { createHash } from "node:crypto";
import { docKey, matchGlob } from "@xdev-hive/contracts";

type HomePatterns = { include?: readonly string[]; exclude?: readonly string[] };
export type PathHome = HomePatterns &
  ({ scope: "project"; projectKey: string; root: string } | { scope: "org"; root?: string });

export type ManagedPaths = {
  sdlcRoot?: string;
  sdlcPaths?: readonly string[];
  skillRoots?: readonly string[];
  key?: string;
};

export const DEFAULT_INCLUDE = ["docs/**", "doc/**", "specs/**", "adr/**", "**/adr/**", "**/README.md", "*.md"];
export const DEFAULT_EXCLUDE = ["vendor/**", ".github/**", "**/CHANGELOG.md", "**/LICENSE*"];

const unsafeCharacters = (path: string) =>
  path.includes("\\") || [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function repoPath(path: string, root = false): string {
  const value = root ? path.replace(/\/+$/, "") : path;
  if (
    (!value && !root) ||
    /^[A-Za-z]:/.test(value) ||
    path.startsWith("/") ||
    unsafeCharacters(value) ||
    (value !== "" && value.split("/").some((part) => !part || part === "." || part === ".."))
  ) {
    throw new Error("Đường dẫn phải nằm trong repo và không chứa đoạn '.' hoặc '..'.");
  }
  return value;
}

const under = (path: string, root: string) => !root || path === root || path.startsWith(`${root}/`);
const slug = (part: string) =>
  part
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+/, "") || "doc";

function scopeFor(home: PathHome, path: string): { prefix: string; relative: string } | null {
  const root = repoPath(home.root ?? "", true);
  if (home.scope === "project") {
    if (!/^[a-z0-9-]+$/.test(home.projectKey)) throw new Error("Key dự án không hợp lệ.");
    return {
      prefix: `project/${home.projectKey}/`,
      relative: root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path,
    };
  }
  if (root && !path.startsWith(`${root}/`)) return null;
  const relative = root ? path.slice(root.length + 1) : path;
  if (relative.startsWith("org/")) return { prefix: "org/", relative: relative.slice(4) };
  const team = /^teams\/([a-z0-9-]+)\/(.+)$/.exec(relative);
  return team ? { prefix: `team/${team[1]}/`, relative: team[2] as string } : null;
}

function shorten(key: string, suffix: string): string {
  return key.slice(0, 200 - suffix.length).replace(/\/+$/, "") + suffix;
}

/** Key chỉ dùng khi nhập lần đầu; đổi tên sau đó phải giữ ánh xạ đã lưu. */
export function keyFromPath(path: string, home: PathHome, pinnedKey?: string): string | null {
  repoPath(path);
  if (!/\.md$/i.test(path) || isHardExcluded(path)) return null;
  const scope = scopeFor(home, path);
  if (!scope) return null;
  if (pinnedKey && docKey.safeParse(pinnedKey).success && pinnedKey.startsWith(scope.prefix)) {
    return /^(?:project\/[^/]+\/sdlc)(?:\/|$)/.test(pinnedKey) ? null : pinnedKey;
  }
  let key = scope.prefix + scope.relative.replace(/\.md$/i, "").split("/").map(slug).join("/");
  if (key.length > 200) {
    key = shorten(key, `-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`);
  }
  if (!docKey.safeParse(key).success) throw new Error("Không thể tạo key tài liệu hợp lệ từ đường dẫn.");
  return /^(?:project\/[^/]+\/sdlc)(?:\/|$)/.test(key) ? null : key;
}

export function pathFromKey(key: string, home: PathHome): string {
  if (!docKey.safeParse(key).success || /^(?:project\/[^/]+\/sdlc)(?:\/|$)/.test(key)) {
    throw new Error("Key tài liệu không hợp lệ hoặc do SDLC quản lý.");
  }
  const root = repoPath(home.root ?? "", true);
  let relative: string;
  if (home.scope === "project") {
    const prefix = `project/${home.projectKey}/`;
    if (!key.startsWith(prefix)) throw new Error("Key tài liệu không thuộc phạm vi nhà.");
    relative = key.slice(prefix.length);
  } else if (key.startsWith("org/")) relative = key;
  else if (key.startsWith("team/")) relative = `teams/${key.slice(5)}`;
  else throw new Error("Key tài liệu không thuộc phạm vi nhà.");
  const path = `${root ? `${root}/` : ""}${relative}.md`;
  if (isHardExcluded(path)) throw new Error("Đường dẫn tài liệu thuộc phần bị loại trừ.");
  return path;
}

export function uniqueKey(key: string, occupied: ReadonlySet<string>): string {
  if (!docKey.safeParse(key).success) throw new Error("Key tài liệu không hợp lệ.");
  if (!occupied.has(key)) return key;
  for (let n = 2; ; n++) {
    const candidate = shorten(key, `-${n}`);
    if (!docKey.safeParse(candidate).success) throw new Error("Phạm vi key quá dài để thêm hậu tố tránh trùng.");
    if (!occupied.has(candidate)) return candidate;
  }
}

export function isHardExcluded(path: string, managed: ManagedPaths = {}): boolean {
  try {
    repoPath(path);
  } catch {
    return true;
  }
  if (path.split("/").some((p) => [".git", ".hive", ".claude", "node_modules"].includes(p))) return true;
  if (/^(?:AGENTS|CLAUDE)\.md$/i.test(path.split("/").at(-1) ?? "")) return true;
  if (managed.key && /^project\/[^/]+\/sdlc(?:\/|$)/.test(managed.key)) return true;
  if (managed.sdlcPaths?.includes(path)) return true;
  const roots = [...(managed.skillRoots ?? []), ...(managed.sdlcRoot ? [managed.sdlcRoot] : [])];
  return roots.some((root) => under(path, repoPath(root, true)));
}

/** Mẫu nhập có thể lấy specs/README ngoài root; root chỉ quyết định nơi ghi tài liệu mới. */
export function matchesHome(path: string, home: PathHome, managed: ManagedPaths = {}): boolean {
  if (isHardExcluded(path, managed)) return false;
  if (home.scope === "org" && !scopeFor(home, path)) return false;
  const root = repoPath(home.root ?? "", true);
  const include =
    home.include ?? (home.scope === "project" ? [...DEFAULT_INCLUDE, ...(root ? [`${root}/**`] : ["**"])] : ["**"]);
  return (
    include.some((glob) => matchGlob(glob, path)) &&
    !(home.exclude ?? DEFAULT_EXCLUDE).some((glob) => matchGlob(glob, path))
  );
}

/** Hai root chỉ chồng nhau ở ranh giới thư mục, không phải tiền tố tên. */
export function overlaps(a: string, b: string): boolean {
  const left = repoPath(a, true);
  const right = repoPath(b, true);
  return under(left, right) || under(right, left);
}

export type RelativeTarget = { path: string; query: string; fragment: string };

export function resolveRelative(docPath: string, href: string): RelativeTarget | null {
  repoPath(docPath);
  if (href !== href.trim() || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) return null;
  const hash = href.indexOf("#");
  const fragment = hash < 0 ? "" : href.slice(hash);
  const beforeHash = hash < 0 ? href : href.slice(0, hash);
  const question = beforeHash.indexOf("?");
  const query = question < 0 ? "" : beforeHash.slice(question);
  let relative: string;
  try {
    relative = decodeURIComponent(question < 0 ? beforeHash : beforeHash.slice(0, question));
  } catch {
    return null;
  }
  if (relative.startsWith("/") || unsafeCharacters(relative) || /^[a-z][a-z0-9+.-]*:/i.test(relative)) return null;
  const parts = relative ? docPath.split("/").slice(0, -1) : docPath.split("/");
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  const path = parts.join("/");
  return path && !isHardExcluded(path) ? { path, query, fragment } : null;
}
