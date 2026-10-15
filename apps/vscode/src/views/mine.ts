import type { Task } from "@xdev-hive/contracts";
import * as vscode from "vscode";
import { errorMessage, type HubClient } from "@/hub/index.ts";
import { addStrings, t } from "@/lib/i18n.ts";
import { redact } from "@/lib/redact.ts";

addStrings(
  {
    "tree.noHub": "Chưa cấu hình hub xDev Hive",
    "tree.signIn": "Kết nối xDev Hive để xem việc",
    "tree.empty": "Không có mục nào",
    "tree.project": "Chưa gắn dự án cho workspace",
    "tree.pending": "{count} mục đang chờ bạn",
    "tree.open": "Mở",
    "tree.cancel": "Huỷ",
    "tree.confirmCancel": "Huỷ việc {name}?",
    "tree.remove": "Bỏ khỏi hàng",
    "tree.confirmRemove": "Bỏ PR #{number} khỏi hàng merge?",
    "tree.approve": "Duyệt",
    "tree.confirmApprove": "Duyệt đề xuất của Leader: {name}?",
    "tree.reason": "Lý do từ chối đề xuất",
    "tree.reasonRequired": "Nhập lý do từ chối (tối đa 2.000 ký tự).",
    "tree.code": "Review code",
    "tree.docs": "Duyệt tài liệu",
    "tree.leader": "Đề xuất của Leader",
    "tree.questions": "Câu hỏi AI SDLC",
    "tree.todo": "Chưa làm",
    "tree.queued": "Đang xếp hàng",
    "tree.running": "Đang chạy",
    "tree.awaiting_plan": "Chờ duyệt kế hoạch",
    "tree.review": "Chờ review",
    "tree.done": "Hoàn tất",
    "tree.cancelled": "Đã huỷ",
    "tree.updating": "Đang cập nhật nhánh",
    "tree.waiting": "Đang chờ",
    "tree.merging": "Đang merge",
    "tree.merged": "Đã merge",
    "tree.failed": "Thất bại",
    "tree.removed": "Đã bỏ khỏi hàng",
    "tree.run": "Lượt chạy",
    "tree.runEnd": "Lượt chạy đã kết thúc",
    "tree.task.create": "Tạo việc",
    "tree.run.dispatch": "Giao việc cho agent",
    "tree.run.cancel": "Huỷ lượt chạy",
    "tree.project.settings": "Đổi cấu hình dự án",
    "tree.sdlc.item.create": "Tạo hạng mục AI SDLC",
  },
  {
    "tree.noHub": "xDev Hive hub is not configured",
    "tree.signIn": "Connect to xDev Hive to see your work",
    "tree.empty": "No items",
    "tree.project": "No project linked to this workspace",
    "tree.pending": "{count} items awaiting you",
    "tree.open": "Open",
    "tree.cancel": "Cancel",
    "tree.confirmCancel": "Cancel task {name}?",
    "tree.remove": "Remove from queue",
    "tree.confirmRemove": "Remove PR #{number} from the merge queue?",
    "tree.approve": "Approve",
    "tree.confirmApprove": "Approve Leader proposal: {name}?",
    "tree.reason": "Reason for rejecting the proposal",
    "tree.reasonRequired": "Enter a reason (up to 2,000 characters).",
    "tree.code": "Code reviews",
    "tree.docs": "Document reviews",
    "tree.leader": "Leader proposals",
    "tree.questions": "AI SDLC questions",
    "tree.todo": "To do",
    "tree.queued": "Queued",
    "tree.running": "Running",
    "tree.awaiting_plan": "Awaiting plan approval",
    "tree.review": "Awaiting review",
    "tree.done": "Done",
    "tree.cancelled": "Cancelled",
    "tree.updating": "Updating branch",
    "tree.waiting": "Waiting",
    "tree.merging": "Merging",
    "tree.merged": "Merged",
    "tree.failed": "Failed",
    "tree.removed": "Removed",
    "tree.run": "Run",
    "tree.runEnd": "Run finished",
    "tree.task.create": "Create task",
    "tree.run.dispatch": "Dispatch task",
    "tree.run.cancel": "Cancel run",
    "tree.project.settings": "Change project settings",
    "tree.sdlc.item.create": "Create AI SDLC item",
  },
);

export interface Connection {
  client: HubClient;
  hubUrl: string;
  session: vscode.AuthenticationSession;
  signal: AbortSignal;
}

export interface Node extends vscode.TreeItem {
  id: string;
  children?: Node[];
  task?: Task;
}

export function group(id: string, label: string, children: Node[]): Node {
  return {
    id,
    label,
    children,
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
    description: `${children.length}`,
  };
}

export function leaf(id: string, label: string, contextValue: string, command?: string, args?: unknown[]): Node {
  return {
    id,
    label: redact(label),
    contextValue,
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    ...(command ? { command: { command, title: t("tree.open"), arguments: args ?? [] } } : {}),
  };
}

export abstract class HubTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changes.event;
  readonly view: vscode.TreeView<Node>;
  protected rows: Node[] = [];
  private identity = "";

  constructor(id: string) {
    this.view = vscode.window.createTreeView(id, { treeDataProvider: this });
  }
  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }
  getChildren(node?: Node): Node[] {
    return node?.children ?? (node ? [] : this.rows);
  }
  protected abstract load(connection: Connection): Promise<Node[]>;

  async refresh(connection: Connection): Promise<void> {
    try {
      const rows = await this.load(connection);
      if (connection.signal.aborted) return;
      this.rows = rows;
      this.identity = `${connection.hubUrl}:${connection.session.id}`;
      if (rows.length) delete this.view.message;
      else this.view.message = t("tree.empty");
      this.changes.fire(undefined);
    } catch (error) {
      if (!connection.signal.aborted) this.reset(errorMessage(error));
      throw error;
    }
  }

  owns(node: Node, connection: Connection): boolean {
    const contains = (nodes: Node[]): boolean =>
      nodes.some((item) => item === node || (item.children && contains(item.children)));
    return (
      !connection.signal.aborted &&
      this.identity === `${connection.hubUrl}:${connection.session.id}` &&
      contains(this.rows)
    );
  }

  reset(message?: string): void {
    this.rows = [];
    this.identity = "";
    if (message === undefined) delete this.view.message;
    else this.view.message = message;
    this.view.badge = undefined;
    this.changes.fire(undefined);
  }

  dispose(): void {
    this.changes.dispose();
    this.view.dispose();
  }
}

export type Command = (name: string, action: (node: Node, connection: Connection) => Promise<unknown>) => void;

export class MineTree extends HubTree {
  constructor() {
    super("xdev-hive.mine");
  }

  protected async load({ client, signal }: Connection): Promise<Node[]> {
    const tasks = await client.rpc.tasks.list({ mine: true }, { signal });
    const statuses: Task["status"][] = ["todo", "queued", "running", "awaiting_plan", "review", "done", "cancelled"];
    return statuses.flatMap((status) => {
      const items = tasks
        .filter((task) => task.status === status)
        .map((task) => {
          const active = ["queued", "running", "awaiting_plan", "review"].includes(status);
          const node = leaf(
            task.id,
            `${task.key} · ${task.title}`,
            active ? "task.active" : "task",
            "xdevHive.task.open",
          );
          node.task = task;
          if (node.command) node.command.arguments = [node];
          return node;
        });
      return items.length ? [group(`status:${status}`, t(`tree.${status}`), items)] : [];
    });
  }

  commands(command: Command): void {
    command("xdevHive.task.open", async (node, connection) => {
      if (!this.owns(node, connection) || !node.task) return;
      const task = await connection.client.rpc.tasks.get({ id: node.task.id }, { signal: connection.signal });
      if (!this.owns(node, connection)) return;
      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: redact(`# ${task.key} · ${task.title}\n\n${t(`tree.${task.status}`)}\n\n${task.body}`),
      });
      await vscode.window.showTextDocument(document, { preview: true });
    });
    command("xdevHive.task.rerun", async (node, connection) => {
      if (!this.owns(node, connection) || !node.task || node.contextValue === "task.active") return;
      await connection.client.rpc.runs.start({ taskId: node.task.id }, { signal: connection.signal });
    });
    command("xdevHive.task.cancel", async (node, connection) => {
      if (!this.owns(node, connection) || !node.task || node.contextValue !== "task.active") return;
      const choice = await vscode.window.showWarningMessage(
        t("tree.confirmCancel", { name: node.task.key }),
        { modal: true },
        t("tree.cancel"),
      );
      if (choice === t("tree.cancel") && this.owns(node, connection))
        await connection.client.rpc.tasks.cancel({ id: node.task.id }, { signal: connection.signal });
    });
  }
}
