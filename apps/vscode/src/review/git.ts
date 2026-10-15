import * as vscode from "vscode";
import { exec } from "@/lib/exec.ts";

export function remoteKey(value: string): string {
  return value
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec("git", args, { cwd });
  if (result.code !== 0) throw new Error("Không đọc được dữ liệu Git của phiên review.");
  return result.stdout;
}
export async function findRepo(urls: string[]): Promise<string | undefined> {
  if (!vscode.workspace.isTrusted) return;
  const roots = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
  const extension = vscode.extensions.getExtension<{
    getAPI(version: number): { repositories: { rootUri: vscode.Uri }[] };
  }>("vscode.git");
  if (extension) {
    try {
      for (const repo of (await extension.activate()).getAPI(1).repositories) roots.add(repo.rootUri.fsPath);
    } catch {
      /* Git CLI vẫn dùng được khi extension Git tắt. */
    }
  }
  for (const root of roots) {
    try {
      const remotes = await git(root, ["remote", "-v"]);
      if (
        remotes
          .split("\n")
          .some(
            (line) =>
              line.startsWith("origin\t") &&
              urls.some((url) => remoteKey(url) === remoteKey(line.split(/\s+/)[1] ?? "")),
          )
      )
        return root;
    } catch {
      /* Workspace có thể chứa thư mục không phải repo. */
    }
  }
}
export async function prepareRepo(root: string, headRef: string, baseRef: string, headSha: string): Promise<string> {
  if (
    !/^[0-9a-f]{40,64}$/.test(headSha) ||
    [headRef, baseRef].some((ref) => !ref || ref.startsWith("-") || /[\s:~^?*[\\]/.test(ref))
  )
    throw new Error("Tham chiếu Git không hợp lệ.");
  await git(root, ["fetch", "--no-tags", "origin", headRef]);
  await git(root, ["fetch", "--no-tags", "origin", baseRef]);
  await git(root, ["cat-file", "-e", `${headSha}^{commit}`]);
  return (await git(root, ["merge-base", headSha, "FETCH_HEAD"])).trim();
}
