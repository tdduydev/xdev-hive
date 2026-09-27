// Reads host + project path from a git remote URL.
//   git@gitlab.fis.vn:group/sub/project.git       → gitlab.fis.vn, group/sub/project
//   ssh://git@gitlab.fis.vn:2222/group/project.git → gitlab.fis.vn, group/project
//   https://user@gitlab.fis.vn/group/project.git   → gitlab.fis.vn, group/project

export interface RemoteInfo {
  host: string;
  path: string;
  https: boolean;
}

export function parseRemoteUrl(url: string): RemoteInfo | null {
  const trimmed = url.trim();
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scp && !/^[a-z]+:\/\//i.test(trimmed)) return { host: scp[1]!.toLowerCase(), path: scp[2]!, https: false };
  try {
    const u = new URL(trimmed);
    if (!["http:", "https:", "ssh:", "git+ssh:"].includes(u.protocol)) return null;
    const path = decodeURIComponent(u.pathname).replace(/^\/+/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "");
    if (!path.includes("/")) return null;
    return { host: u.hostname.toLowerCase(), path, https: u.protocol.startsWith("http") };
  } catch {
    return null;
  }
}
