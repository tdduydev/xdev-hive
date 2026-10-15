import * as vscode from "vscode";
import { git } from "@/review/git.ts";
export type Side = "old" | "new";
export interface DocumentRef {
  reviewId: string;
  side: Side;
  path: string;
  sha: string;
}
export function reviewUri(ref: DocumentRef, headSha = ref.sha): vscode.Uri {
  return vscode.Uri.from({
    scheme: "hive-review",
    path: `/${ref.reviewId}/${ref.side}/${ref.path}`,
    query: new URLSearchParams({ sha: ref.sha, head: headSha }).toString(),
  });
}
export function parseUri(uri: vscode.Uri): DocumentRef | undefined {
  const match = /^\/([^/]+)\/(old|new)\/(.+)$/.exec(uri.path);
  const sha = new URLSearchParams(uri.query).get("sha");
  if (uri.scheme !== "hive-review" || !match || !sha || !/^[0-9a-f]{40,64}$/.test(sha)) return;
  const path = match[3] ?? "";
  if (path.includes("\\") || path.includes("\0") || path.split("/").some((p) => !p || p === "." || p === "..")) return;
  return { reviewId: match[1] ?? "", side: match[2] as Side, path, sha };
}
export class DiffProvider implements vscode.TextDocumentContentProvider {
  readonly documents = new Map<string, { root: string; empty: boolean; path: string; headSha: string }>();
  add(ref: DocumentRef, root: string, empty = false, path = ref.path, headSha = ref.sha): vscode.Uri {
    const uri = reviewUri(ref, headSha);
    this.documents.set(uri.toString(), { root, empty, path, headSha });
    return uri;
  }
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = parseUri(uri);
    const source = this.documents.get(uri.toString());
    if (!ref || !source) throw new Error("Không tìm thấy nội dung review.");
    return source.empty ? "" : git(source.root, ["show", `${ref.sha}:${source.path}`]);
  }
  dispose(): void {
    this.documents.clear();
  }
}
export async function openDiffs(title: string, files: [vscode.Uri, vscode.Uri, vscode.Uri][]): Promise<void> {
  try {
    await vscode.commands.executeCommand("vscode.changes", title, files);
  } catch {
    for (const [, oldUri, newUri] of files) await vscode.commands.executeCommand("vscode.diff", oldUri, newUri, title);
  }
}
