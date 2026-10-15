import type { CodeReviewComment, CodeReviewCommentThread, CodeReviewDetail } from "@xdev-hive/contracts";
import * as vscode from "vscode";
import type { HubClient } from "@/hub/index.ts";
import { t } from "@/lib/i18n.ts";
import { type DiffProvider, parseUri } from "@/review/diff-provider.ts";

export interface ReviewComment extends vscode.Comment {
  id: string;
  mine: boolean;
  syncFailed: boolean;
}
export function markdown(body: string): vscode.MarkdownString {
  const text = new vscode.MarkdownString(body);
  text.isTrusted = false;
  text.supportHtml = false;
  return text;
}
export function renderComment(comment: CodeReviewComment, outdated: boolean, userId?: string): ReviewComment {
  const mine = !comment.deletedAt && comment.origin === "hive" && comment.authorId === userId;
  const syncFailed = mine && comment.syncState === "failed";
  const state = comment.syncState;
  return {
    id: comment.id,
    mine: Boolean(mine),
    syncFailed: Boolean(syncFailed),
    body: markdown(comment.deletedAt ? t("review.deleted") : comment.body),
    mode: vscode.CommentMode.Preview,
    author: {
      name:
        comment.origin === "hive"
          ? (comment.authorName ?? "Hive")
          : `${comment.externalAuthor ?? "?"} · ${comment.origin === "github" ? "GitHub" : "GitLab"}`,
    },
    label: [outdated ? t("review.outdated") : "", state ? t(`review.${state === "failed" ? "failedSync" : state}`) : ""]
      .filter(Boolean)
      .join(" · "),
    contextValue: ["human", outdated ? "outdated" : "", mine ? "mine" : "", syncFailed ? "syncFailed" : ""]
      .filter(Boolean)
      .join("."),
  };
}

export class ReviewController implements vscode.Disposable {
  readonly controller = vscode.comments.createCommentController("xdev-hive.review", "xDev Hive");
  readonly threads = new Map<vscode.CommentThread, string>();
  private disposed = false;
  private readonly revisions = new Map<string, number>();
  private rendered: vscode.CommentThread[] = [];
  private readonly hub: HubClient;
  private readonly provider: DiffProvider;
  private readonly details: Map<string, CodeReviewDetail>;
  private readonly userId: () => Promise<string | undefined>;
  constructor(
    hub: HubClient,
    provider: DiffProvider,
    details: Map<string, CodeReviewDetail>,
    userId: () => Promise<string | undefined>,
  ) {
    this.hub = hub;
    this.provider = provider;
    this.details = details;
    this.userId = userId;
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) =>
        parseUri(document.uri) && provider.documents.has(document.uri.toString())
          ? [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)]
          : undefined,
    };
  }
  async refresh(reviewId: string): Promise<void> {
    const revision = (this.revisions.get(reviewId) ?? 0) + 1;
    this.revisions.set(reviewId, revision);
    const { threads } = await this.hub.rpc.codeReviews.comments.list({ reviewId });
    const user = await this.userId();
    if (this.disposed || this.revisions.get(reviewId) !== revision) return;
    const ids = new Set(threads.map((thread) => thread.id));
    this.rendered = this.rendered.filter((thread) => {
      if (parseUri(thread.uri)?.reviewId !== reviewId) return true;
      const id = this.threads.get(thread);
      if (id && ids.has(id)) return true;
      thread.dispose();
      this.threads.delete(thread);
      return false;
    });
    const detail = this.details.get(reviewId);
    if (!detail) return;
    for (const data of threads) this.addThread(reviewId, data, user);
    for (const gate of detail.gates)
      for (const reviewer of gate.reviewers)
        for (const finding of reviewer.findings) {
          const uri = this.uri(reviewId, "new", finding.file);
          if (!uri) continue;
          const thread = this.controller.createCommentThread(
            uri,
            new vscode.Range(Math.max(0, (finding.line ?? 1) - 1), 0, Math.max(0, (finding.line ?? 1) - 1), 0),
            [
              {
                body: markdown(finding.message),
                mode: vscode.CommentMode.Preview,
                author: { name: reviewer.cli },
                contextValue: "ai",
                label: `AI · ${t(`review.${finding.severity}`)}`,
              },
            ],
          );
          thread.canReply = false;
          this.rendered.push(thread);
        }
  }
  private uri(id: string, side: string, path: string): vscode.Uri | undefined {
    for (const key of [...this.provider.documents.keys()].reverse()) {
      const uri = vscode.Uri.parse(key);
      const ref = parseUri(uri);
      if (ref?.reviewId === id && ref.side === side && ref.path === path) return uri;
    }
  }
  private addThread(id: string, data: CodeReviewCommentThread, user?: string): void {
    const uri = this.uri(id, data.side, data.path);
    if (!uri) return;
    const line = data.line - 1;
    const previous = [...this.threads].find(([, threadId]) => threadId === data.id)?.[0];
    if (previous && previous.uri.toString() !== uri.toString()) {
      previous.dispose();
      this.threads.delete(previous);
      this.rendered = this.rendered.filter((thread) => thread !== previous);
    }
    const existing = [...this.threads].find(
      ([thread, threadId]) => threadId === data.id && thread.uri.toString() === uri.toString(),
    )?.[0];
    const comments = data.comments.map((c) => renderComment(c, data.outdated, user));
    // Giữ đối tượng luồng để lần hỏi lại không xoá phần trả lời đang soạn.
    const thread = existing ?? this.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), comments);
    if (existing) thread.comments = comments;
    thread.contextValue = `${data.resolved ? "resolved" : "open"}${data.outdated ? ".outdated" : ""}`;
    thread.label = [data.resolved ? t("review.resolved") : "", data.outdated ? t("review.outdated") : ""]
      .filter(Boolean)
      .join(" · ");
    thread.state = data.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    this.threads.set(thread, data.id);
    if (!existing) this.rendered.push(thread);
  }
  async submit(reply: vscode.CommentReply): Promise<void> {
    const ref = parseUri(reply.thread.uri);
    const detail = ref && this.details.get(ref.reviewId);
    const source = this.provider.documents.get(reply.thread.uri.toString());
    if (!ref || !detail || !source || !reply.text.trim() || !reply.thread.range) return;
    const threadId = this.threads.get(reply.thread);
    if (threadId) await this.hub.rpc.codeReviews.comments.reply({ threadId, body: reply.text });
    else
      await this.hub.rpc.codeReviews.comments.add({
        reviewId: ref.reviewId,
        path: ref.path,
        side: ref.side,
        headSha: source.headSha,
        line: reply.thread.range.start.line + 1,
        body: reply.text,
      });
    if (!threadId) reply.thread.dispose();
    await this.refresh(ref.reviewId);
  }
  async resolve(thread: vscode.CommentThread, resolved: boolean): Promise<void> {
    const threadId = this.threads.get(thread);
    const ref = parseUri(thread.uri);
    if (!threadId || !ref) return;
    await (resolved
      ? this.hub.rpc.codeReviews.comments.resolve({ threadId })
      : this.hub.rpc.codeReviews.comments.reopen({ threadId }));
    await this.refresh(ref.reviewId);
  }
  async change(comment: ReviewComment, remove: boolean): Promise<void> {
    if (!comment.mine) return;
    if (remove) await this.hub.rpc.codeReviews.comments.delete({ commentId: comment.id });
    else {
      const body = await vscode.window.showInputBox({
        prompt: t("review.body"),
        value: typeof comment.body === "string" ? comment.body : comment.body.value,
        validateInput: (value) => (value.trim() && value.length <= 20000 ? undefined : t("review.body")),
      });
      if (!body) return;
      await this.hub.rpc.codeReviews.comments.edit({ commentId: comment.id, body });
    }
    for (const id of this.details.keys()) await this.refresh(id);
  }
  async retry(comment: ReviewComment): Promise<void> {
    if (!comment.syncFailed) return;
    const response = await this.hub.request("/rpc/codeReviews/comments/retrySync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { commentId: comment.id } }),
    });
    if (!response.ok) throw new Error(t("review.failed"));
    for (const id of this.details.keys()) await this.refresh(id);
  }
  dispose(): void {
    this.disposed = true;
    for (const thread of this.rendered) thread.dispose();
    this.rendered = [];
    this.threads.clear();
    this.controller.dispose();
  }
}
