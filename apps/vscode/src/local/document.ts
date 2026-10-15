import * as vscode from "vscode";

export const DOC_SCHEME = "xdev-hive-local";
export const PACK_DOC = "context-pack.md";
export const reportDoc = (profile: string) => `optimize-report-${profile.replace(/[^\w.-]/g, "_")}.md`;

export const documentUri = (name: string) => vscode.Uri.parse(`${DOC_SCHEME}:/${name}`);

/** Tài liệu Markdown chỉ đọc: TextDocumentContentProvider không cho sửa, nên không cần tạo file tạm trên đĩa. */
export class DocumentStore implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path.replace(/^\//, "")) ?? "";
  }

  set(name: string, content: string): vscode.Uri {
    this.docs.set(name, content);
    const uri = documentUri(name);
    this.changed.fire(uri);
    return uri;
  }
}
