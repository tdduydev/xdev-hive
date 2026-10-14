import { type Project, parseRepoUrl } from "@xdev-hive/contracts";
import { invoke } from "@/lib/tauri.ts";

/**
 * Dự án của hub gắn với thư mục repo trên máy (`projects.json` của worker, ADR 0020), đọc và ghi qua `hive-worker
 * projects`. Mục có `projectId` rỗng là repo trên máy chưa có dự án trên hub (nhập từ app v1).
 */
export interface LocalProject {
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

/** Máy chủ và đường dẫn của URL repo, chữ thường, bỏ giao thức, tên đăng nhập, cổng và đuôi .git; null khi không đọc được. */
function repoKey(url: string | null | undefined): string | null {
  if (!url) return null;
  // parseRepoUrl từ chối URL có tên đăng nhập; token trong origin không làm đổi repo nên bỏ trước khi đọc.
  const plain = url.trim().replace(/^(https?|ssh):\/\/[^@/]+@/i, (_, scheme: string) => `${scheme}://`);
  const ssh = plain.replace(/^ssh:\/\/([^/:]+):\d+\//i, "ssh://$1/").replace(/^ssh:\/\//i, "ssh://git@");
  const parsed = parseRepoUrl(ssh) ?? parseRepoUrl(plain);
  if (!parsed) return null;
  return `${parsed.host.replace(/:\d+$/, "")}/${parsed.owner}/${parsed.name}`.toLowerCase();
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
