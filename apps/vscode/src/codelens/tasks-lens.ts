import * as vscode from "vscode";
import type { HubStatus } from "@/codelens/hub-status.ts";
import { parseTasks, specOf, type TaskLine } from "@/codelens/tasks-md.ts";
import { t } from "@/lib/i18n.ts";
import "@/codelens/strings.ts";

export interface TasksLensDeps {
  enabled(): boolean;
  trusted(): boolean;
  status: HubStatus;
  /** Có tasks.md đang cần trạng thái hub; bên ngoài bắt đầu hỏi định kỳ. */
  watch(root: string, spec: string): void;
}

const KIND_KEY = { running: "codelens.running", queued: "codelens.queued", planning: "codelens.planning" } as const;

export class TasksLensProvider implements vscode.CodeLensProvider {
  private readonly deps: TasksLensDeps;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  // Parse lại chỉ khi nội dung đổi; VS Code gọi provider mỗi lần cuộn hay gõ.
  private readonly parsed = new Map<string, { version: number; tasks: TaskLine[] }>();

  constructor(deps: TasksLensDeps) {
    this.deps = deps;
  }

  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.deps.enabled()) return [];
    const { root, spec } = specOf(document.uri.fsPath);
    this.deps.watch(root, spec);
    const key = document.uri.toString();
    let entry = this.parsed.get(key);
    if (!entry || entry.version !== document.version) {
      entry = { version: document.version, tasks: parseTasks(document.getText()) };
      this.parsed.delete(key);
      this.parsed.set(key, entry);
      // Giữ vài tài liệu gần nhất, đủ cho các tasks.md đang mở.
      if (this.parsed.size > 16) this.parsed.delete(this.parsed.keys().next().value as string);
    }
    const lenses: vscode.CodeLens[] = [];
    for (const task of entry.tasks) {
      if (task.done) continue;
      const range = new vscode.Range(task.line, 0, task.line, 0);
      const status = this.deps.status.lookup(root, spec, task.code);
      if (status) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: t(KIND_KEY[status.kind], { id: status.runId.slice(0, 8) }),
            command: "xdevHive.run.openLog",
            arguments: [{ runId: status.runId }],
          }),
        );
        continue;
      }
      if (this.deps.trusted()) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: t("codelens.assign"),
            command: "xdevHive.codelens.assignTask",
            arguments: [{ uri: document.uri.toString(), code: task.code, spec, title: task.title }],
          }),
        );
      }
      if (this.deps.status.isSignedOut) {
        lenses.push(new vscode.CodeLens(range, { title: t("codelens.signIn"), command: "xdevHive.signIn" }));
      }
    }
    return lenses;
  }
}
