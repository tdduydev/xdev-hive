import type { MergeQueueEntry } from "@xdev-hive/contracts";
import * as vscode from "vscode";
import { orgFromToken, workspaceProject } from "@/hub/index.ts";
import { t } from "@/lib/i18n.ts";
import { type Command, type Connection, HubTree, leaf, type Node } from "@/views/mine.ts";
import { supervisor } from "@/worker/index.ts";

interface QueueNode extends Node {
  entry?: MergeQueueEntry;
}

export class MergeQueueTree extends HubTree {
  constructor() {
    super("xdev-hive.mergeQueue");
  }

  protected async load(connection: Connection): Promise<Node[]> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (folder?.scheme !== "file") return [leaf("no-project", t("tree.project"), "message")];
    const id = await workspaceProject(folder.fsPath, {
      trusted: vscode.workspace.isTrusted,
      ...(supervisor?.binary ? { workerPath: supervisor.binary.path } : {}),
      hubUrl: connection.hubUrl,
    });
    if (!id || connection.signal.aborted) return [leaf("no-project", t("tree.project"), "message")];
    const { client, signal, session } = connection;
    const [entries, project, org] = await Promise.all([
      client.rpc.projects.mergeQueue({ id }, { signal }),
      client.rpc.projects.get({ id }, { signal }),
      client.rpc.orgs.get({ orgId: orgFromToken(session.accessToken) }, { signal }),
    ]);
    let canManage = org.role === "owner" || org.role === "admin";
    if (!canManage) {
      const members = await client.rpc.teamMembers.list({ teamId: project.teamId }, { signal });
      canManage = members.some(
        (member) => member.userId === session.account.id && ["admin", "member"].includes(member.role),
      );
    }
    return entries.map((entry): QueueNode => {
      const removable = canManage && ["queued", "updating", "waiting"].includes(entry.state);
      return {
        ...leaf(
          entry.id,
          `${entry.position ? `${entry.position}. ` : ""}PR #${entry.prNumber}`,
          removable ? "mergeQueue.removable" : "mergeQueue",
        ),
        description: t(`tree.${entry.state}`),
        tooltip: entry.note ?? undefined,
        entry,
      };
    });
  }

  commands(command: Command): void {
    command("xdevHive.mergeQueue.remove", async (node: QueueNode, connection) => {
      if (!this.owns(node, connection) || !node.entry || node.contextValue !== "mergeQueue.removable") return;
      const choice = await vscode.window.showWarningMessage(
        t("tree.confirmRemove", { number: node.entry.prNumber }),
        { modal: true },
        t("tree.remove"),
      );
      if (choice === t("tree.remove") && this.owns(node, connection))
        await connection.client.rpc.projects.removeMerge(
          { id: node.entry.projectId, entryId: node.entry.id },
          { signal: connection.signal },
        );
    });
  }
}
