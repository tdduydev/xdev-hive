/** Repo có sẵn được nhập bằng URL; hub tách ra máy chủ, owner (có thể là group lồng của GitLab) và tên repo. */
export interface ParsedRepoUrl {
  host: string;
  owner: string;
  name: string;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Chỉ nhận https và ssh, không kèm credential, query hay fragment: URL này sau đó được đưa cho máy clone, nên
 * `https://token@host/...` hay `file://` không được lọt vào. Trả null khi không hợp lệ.
 */
export function parseRepoUrl(input: string): ParsedRepoUrl | null {
  const raw = input.trim();
  let host: string;
  let path: string;
  const scp = /^git@([A-Za-z0-9.-]+):(.+)$/.exec(raw);
  if (scp) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "ssh:") return null;
    if (url.password || (url.username && !(url.protocol === "ssh:" && url.username === "git"))) return null;
    if (url.search || url.hash) return null;
    host = url.host;
    path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  }
  path = path.replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = path.split("/");
  if (parts.length < 2 || !host) return null;
  if (!parts.every((p) => SEGMENT.test(p) && p !== "." && p !== "..")) return null;
  const name = parts.pop() as string;
  return { host: host.toLowerCase(), owner: parts.join("/"), name };
}
