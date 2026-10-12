import { invoke, workspaceMeta } from "@/lib/tauri.ts";

/** Gọi tool đọc của hub bằng tài khoản đã liên kết (lệnh hub_tool, Rust chỉ cho tool đọc). */
export const hubTool = <T>(name: string, args: Record<string, unknown> = {}) => invoke<T>("hub_tool", { name, args });

export interface HubProject {
  key: string;
  name: string;
  state: string;
  repo: {
    kind: string;
    owner: string;
    name: string;
    httpUrl: string | null;
    sshUrl: string | null;
    webUrl: string | null;
  };
}
export interface HubDoc {
  key: string;
  title: string;
  version: number;
  updatedAt: string;
}
export interface HubSkill {
  name: string;
  description: string;
  scope: string;
  version: number;
}

/** So remote git với repo: bỏ giao thức, `git@`, thông tin đăng nhập, `.git`, chữ hoa để https và ssh khớp nhau. */
export function normalizeRepo(url: string): string {
  let u = url.trim().toLowerCase();
  u = u.replace(/^(https?|ssh):\/\//, "");
  u = u.replace(/^[^@/]+@/, "");
  u = u.replace(":", "/");
  return u.replace(/\/+$/, "").replace(/\.git$/, "");
}

/** Dự án trên hub có repo trùng remote `origin` của thư mục. */
export function matchProject(remote: string | null, projects: HubProject[]): HubProject | null {
  if (!remote) return null;
  const want = normalizeRepo(remote);
  return (
    projects.find((p) => [p.repo.httpUrl, p.repo.sshUrl, p.repo.webUrl].some((u) => u && normalizeRepo(u) === want)) ??
    null
  );
}

/** Project key trên hub của thư mục (remote origin khớp repo của dự án); null khi chưa liên kết, không khớp hay lỗi. */
export async function projectKeyOf(folder: string): Promise<string | null> {
  if (!folder.trim()) return null;
  try {
    const meta = await workspaceMeta(folder);
    const { projects } = await hubTool<{ projects: HubProject[] }>("project_list");
    return matchProject(meta.remote, projects)?.key ?? null;
  } catch {
    return null;
  }
}
