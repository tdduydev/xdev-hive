import type { Approval, SdlcQuestion } from "@xdev-hive/contracts";
import * as vscode from "vscode";
import { t } from "@/lib/i18n.ts";
import { redact } from "@/lib/redact.ts";
import { type Command, type Connection, group, HubTree, leaf, type Node } from "@/views/mine.ts";

interface ApprovalNode extends Node {
  approval?: Approval;
  question?: SdlcQuestion;
}

// Các danh sách có con trỏ phải đọc hết: badge và cây không được bỏ sót mục sau trang đầu.
export async function allPages<T>(
  load: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await load(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error(t("tree.empty"));
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}

export class ApprovalsTree extends HubTree {
  constructor() {
    super("xdev-hive.approvals");
  }

  protected async load({ client, signal }: Connection): Promise<Node[]> {
    const options = { signal };
    const [code, docs, proposals, questions, count, questionCount] = await Promise.all([
      allPages((cursor) => client.rpc.codeReviews.list({ scope: "mine", limit: 100, cursor }, options)),
      allPages((cursor) => client.rpc.reviews.list({ scope: "mine", limit: 100, cursor }, options)),
      client.rpc.leader.approvals.list({ status: "pending" }, options),
      allPages((cursor) =>
        client.rpc.sdlc.questions.list({ scope: "mine", openOnly: true, limit: 100, cursor }, options),
      ),
      client.rpc.codeReviews.count(undefined, options),
      client.rpc.sdlc.questions.count(undefined, options),
    ]);
    if (signal.aborted) return [];
    const pending = proposals.filter((proposal) => proposal.status === "pending");
    const total = count.awaitingMe + pending.length + questionCount.open;
    this.view.badge = total ? { value: total, tooltip: t("tree.pending", { count: total }) } : undefined;
    return [
      group(
        "code",
        t("tree.code"),
        code.map((review) =>
          leaf(
            review.id,
            `${review.project.key} #${review.pr.number} · ${review.task?.title ?? review.workflow.name}`,
            "approval.codeReview",
            "xdevHive.review.open",
            [review.id],
          ),
        ),
      ),
      group(
        "docs",
        t("tree.docs"),
        docs.map((review) =>
          leaf(review.id, review.docTitle, "approval.docReview", "xdevHive.docReview.open", [review.id]),
        ),
      ),
      group(
        "leader",
        t("tree.leader"),
        pending.map((approval): ApprovalNode => {
          const label = "title" in approval.action ? approval.action.title : t(`tree.${approval.action.type}`);
          const node: ApprovalNode = {
            ...leaf(approval.id, label, "approval.leader", "xdevHive.approval.open"),
            approval,
          };
          if (node.command) node.command.arguments = [node];
          return node;
        }),
      ),
      group(
        "questions",
        t("tree.questions"),
        questions.map((question): ApprovalNode => {
          const node: ApprovalNode = {
            ...leaf(
              question.id,
              `${question.item.ref} · ${question.text}`,
              "approval.question",
              "xdevHive.question.open",
            ),
            question,
          };
          if (node.command) node.command.arguments = [node];
          return node;
        }),
      ),
    ];
  }

  commands(command: Command): void {
    command("xdevHive.question.open", async (node: ApprovalNode, connection) => {
      if (!this.owns(node, connection) || !node.question) return;
      const question = node.question;
      const content = `# ${question.item.ref} · ${question.item.title}\n\n${question.text}\n\n${question.context ?? ""}\n\n${question.options.map((option) => `- ${option}`).join("\n")}`;
      const document = await vscode.workspace.openTextDocument({ language: "markdown", content: redact(content) });
      await vscode.window.showTextDocument(document, { preview: true });
    });
    command("xdevHive.approval.open", async (node: ApprovalNode, connection) => {
      if (!this.owns(node, connection) || !node.approval) return;
      const document = await vscode.workspace.openTextDocument({
        language: "json",
        content: redact(JSON.stringify(node.approval.action, null, 2)),
      });
      await vscode.window.showTextDocument(document, { preview: true });
    });
    command("xdevHive.approval.approve", async (node: ApprovalNode, connection) => {
      if (!this.owns(node, connection) || !node.approval) return;
      const choice = await vscode.window.showWarningMessage(
        t("tree.confirmApprove", { name: String(node.label) }),
        { modal: true },
        t("tree.approve"),
      );
      if (choice === t("tree.approve") && this.owns(node, connection))
        await connection.client.rpc.leader.approvals.approve({ id: node.approval.id }, { signal: connection.signal });
    });
    command("xdevHive.approval.reject", async (node: ApprovalNode, connection) => {
      if (!this.owns(node, connection) || !node.approval) return;
      const reason = await vscode.window.showInputBox({
        title: t("tree.reason"),
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim().length > 0 && value.trim().length <= 2000 ? undefined : t("tree.reasonRequired"),
      });
      if (reason?.trim() && reason.trim().length <= 2000 && this.owns(node, connection))
        await connection.client.rpc.leader.approvals.reject(
          { id: node.approval.id, reason: reason.trim() },
          { signal: connection.signal },
        );
    });
  }
}
