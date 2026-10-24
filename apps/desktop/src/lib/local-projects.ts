import { type ParsedRepoUrl, type Project, parseRepoUrl } from "@xdev-hive/contracts";
import { shortPath } from "@/lib/folder.ts";
import type { GitGroups } from "@/lib/git-groups.ts";
import { invoke } from "@/lib/tauri.ts";

/**
 * Dự án của hub gắn với thư mục repo trên máy (`projects.json` của worker, ADR 0020), đọc và ghi qua `hive-worker
 * projects`. Mục có `projectId` rỗng là repo trên máy chưa có dự án trên hub (nhập từ app v1).
 */
export interface LocalProject {
  /** Id của mục trên máy này, không đổi khi gắn dự án hay dời thư mục; bí mật gán theo id này. Worker cũ chưa trả. */
  localId?: string | undefined;
  projectId: string;
  name: string;
  folder: string;
  fullPermission: boolean;
  /** Thư mục còn trên máy. */
  exists: boolean;
  isGit: boolean;
  /** URL remote origin, đã bỏ tên đăng nhập và mật khẩu. */
  origin?: string | undefined;
}

export interface LocalProjects {
  path: string;
  /** projects.json đã có: đã nhập danh sách của app v1 (hoặc đã gắn) ít nhất một lần. */
  exists: boolean;
  imported: number;
  projects: LocalProject[];
}

export const localProjects = () => invoke<LocalProjects>("local_projects");
export const importLegacyProjects = () => invoke<LocalProjects>("local_projects_import");
/** Gắn dự án với thư mục; có repoUrl thì worker từ chối khi remote origin của thư mục không khớp. */
export const bindProject = (id: string, folder: string, name: string, repoUrl: string | null) =>
  invoke<LocalProjects>("local_project_bind", { id, folder, name, repoUrl });
export const unbindProject = (id: string) => invoke<LocalProjects>("local_project_unbind", { id, folder: null });
/** Bỏ repo chưa có dự án trên hub khỏi danh sách; thư mục giữ nguyên. */
export const forgetFolder = (folder: string) => invoke<LocalProjects>("local_project_unbind", { id: null, folder });
export const setProjectFull = (id: string, full: boolean) =>
  invoke<LocalProjects>("local_project_set_full", { id, full });

/** Máy chủ (bỏ cổng), namespace và tên repo của URL, bỏ giao thức, tên đăng nhập và đuôi .git; null khi không đọc được. */
function parseOrigin(url: string | null | undefined): ParsedRepoUrl | null {
  if (!url) return null;
  // parseRepoUrl từ chối URL có tên đăng nhập; token trong origin không làm đổi repo nên bỏ trước khi đọc.
  const plain = url.trim().replace(/^(https?|ssh):\/\/[^@/]+@/i, (_, scheme: string) => `${scheme}://`);
  const ssh = plain.replace(/^ssh:\/\/([^/:]+):\d+\//i, "ssh://$1/").replace(/^ssh:\/\//i, "ssh://git@");
  const parsed = parseRepoUrl(ssh) ?? parseRepoUrl(plain);
  return parsed && { ...parsed, host: parsed.host.replace(/:\d+$/, "") };
}

/** Máy chủ và đường dẫn của URL repo, chữ thường; null khi không đọc được. */
function repoKey(url: string | null | undefined): string | null {
  const parsed = parseOrigin(url);
  return parsed && `${parsed.host}/${parsed.owner}/${parsed.name}`.toLowerCase();
}

/** Hai URL cùng một repo theo cách worker so (worker/internal/projects SameRepo). */
export function sameRepo(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = repoKey(a);
  return ka !== null && ka === repoKey(b);
}

/** URL của repo dự án trên hub để so với origin: httpUrl trước, sshUrl sau. */
export const projectRepoUrls = (p: Project): string[] =>
  [p.repo.httpUrl, p.repo.sshUrl].filter((u): u is string => !!u);

export const projectRepoLabel = (p: Project): string =>
  p.repo.webUrl ?? p.repo.httpUrl ?? `${p.repo.owner}/${p.repo.name}`;

export type BindingState = "unbound" | "bound" | "mismatch" | "missing";

/** Trạng thái gắn của dự án trên máy này: chưa gắn, đã gắn, remote không khớp, thư mục mất. */
export function bindingState(p: Project, local: LocalProject | undefined): BindingState {
  if (!local) return "unbound";
  if (!local.exists) return "missing";
  const urls = projectRepoUrls(p);
  if (!local.isGit || (urls.length > 0 && !urls.some((u) => sameRepo(local.origin, u)))) return "mismatch";
  return "bound";
}

/**
 * Ghép repo nhập từ app v1 (chưa gắn) với dự án hub: theo remote origin trước, rồi theo tên (key hoặc tên dự án, không
 * phân biệt hoa thường) khi đúng một dự án có tên đó. Bỏ dự án đã gắn trên máy và dự án đã ghép cho repo khác.
 */
export function matchLegacy(
  hub: Project[],
  local: LocalProject[],
): { folder: string; name: string; project: Project }[] {
  const taken = new Set(local.filter((l) => l.projectId).map((l) => l.projectId));
  const out: { folder: string; name: string; project: Project }[] = [];
  const unlinked = local.filter((l) => !l.projectId);
  const claim = (l: LocalProject, p: Project | undefined) => {
    if (!p || taken.has(p.id)) return false;
    taken.add(p.id);
    out.push({ folder: l.folder, name: l.name, project: p });
    return true;
  };
  const rest = unlinked.filter(
    (l) =>
      !claim(
        l,
        hub.find((p) => !taken.has(p.id) && projectRepoUrls(p).some((u) => sameRepo(l.origin, u))),
      ),
  );
  for (const l of rest) {
    const name = l.name.trim().toLowerCase();
    const named = hub.filter((p) => p.key.toLowerCase() === name || p.name.trim().toLowerCase() === name);
    if (named.length === 1) claim(l, named[0]);
  }
  return out;
}

/** Một mục của danh sách repo trên máy: repo cùng namespace trên một máy chủ Git, hoặc cùng thư mục cha khi không có remote. */
export interface RepoSection {
  key: string;
  title: string;
  /** Máy chủ Git, hoặc tên kết nối khi máy chủ đã kết nối ở Nhóm Git theo dõi; null khi gom theo thư mục cha. */
  host: string | null;
  repos: LocalProject[];
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** Thư mục cha, nhận cả đường dẫn Windows; bỏ dấu phân cách ở cuối. */
function parentFolder(folder: string): string {
  const path = folder.replace(/[\\/]+$/, "");
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? path : path.slice(0, cut) || path.slice(0, 1);
}

/** Tên máy chủ (chữ thường, không cổng) của địa chỉ web; null khi không đọc được. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Gom repo trên máy theo namespace của remote origin (group lồng của GitLab như `acme-ai/his`), không có remote thì
 * theo thư mục cha. Mục có repo của Nhóm Git theo dõi lấy tên theo đường dẫn nhóm trả về từ máy chủ, vì origin gõ tay có
 * thể khác chữ hoa. Mục theo remote đứng trước; mục và repo sắp theo tên.
 */
export function groupLocalRepos(
  entries: LocalProject[],
  tracked: Pick<GitGroups, "hosts" | "groups"> | null,
): RepoSection[] {
  const connection = new Map<string, string>();
  for (const h of tracked?.hosts ?? []) {
    const host = hostOf(h.url);
    if (host) connection.set(host, h.name);
  }
  const namespaces = new Map<string, string>();
  for (const g of tracked?.groups ?? [])
    for (const r of g.repos) {
      const namespace = r.path.slice(0, Math.max(r.path.lastIndexOf("/"), 0));
      for (const u of [r.httpUrl, r.sshUrl]) {
        const k = repoKey(u);
        if (k && namespace) namespaces.set(k, namespace);
      }
    }

  const sections = new Map<string, RepoSection>();
  for (const l of [...entries].sort((a, b) => byName(a.name, b.name) || byName(a.folder, b.folder))) {
    const o = parseOrigin(l.origin);
    const parent = parentFolder(l.folder);
    const key = o ? `git:${o.host}/${o.owner}`.toLowerCase() : `dir:${parent}`;
    let s = sections.get(key);
    if (!s) {
      const host = o ? (connection.get(o.host) ?? o.host) : null;
      s = { key, title: o ? o.owner : shortPath(parent), host, repos: [] };
      sections.set(key, s);
    }
    s.repos.push(l);
    const namespace = o && namespaces.get(repoKey(l.origin) ?? "");
    if (namespace) s.title = namespace;
  }
  return [...sections.values()].sort(
    (a, b) =>
      Number(a.host === null) - Number(b.host === null) ||
      byName(a.title, b.title) ||
      byName(a.host ?? "", b.host ?? ""),
  );
}

/** Lọc không phân biệt hoa thường: trùng tên mục hoặc máy chủ thì giữ cả mục, không thì giữ repo trùng tên, thư mục, remote. */
export function filterRepoSections(sections: RepoSection[], query: string): RepoSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  const has = (s: string | null | undefined) => !!s?.toLowerCase().includes(q);
  return sections.flatMap((s) => {
    if (has(s.title) || has(s.host)) return [s];
    const repos = s.repos.filter((r) => has(r.name) || has(r.folder) || has(r.origin));
    return repos.length > 0 ? [{ ...s, repos }] : [];
  });
}
