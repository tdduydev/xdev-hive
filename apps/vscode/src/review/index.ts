import type { CodeReviewDetail } from "@xdev-hive/contracts";
import * as vscode from "vscode";
import { auth } from "@/auth/index.ts";
import { createHubClient, poll } from "@/hub/index.ts";
import { config } from "@/lib/config.ts";
import { t } from "@/lib/i18n.ts";
import { type ReviewComment, ReviewController } from "@/review/controller.ts";
import { DiffProvider, openDiffs, parseUri } from "@/review/diff-provider.ts";
import { findRepo, prepareRepo } from "@/review/git.ts";
import { renderHtml, webviewOptions } from "@/webview-host/html.ts";
import { attachBridge } from "@/webview-host/index.ts";
import "@/review/strings.ts";

function isConflict(error: unknown): boolean {
  for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
    if (("status" in error && error.status === 409) || ("code" in error && error.code === "CONFLICT")) return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}

export async function decide(
  hub: ReturnType<typeof createHubClient>,
  detail: CodeReviewDetail,
  decision: "approve" | "changes",
  note?: string,
): Promise<void> {
  const latest = await hub.rpc.codeReviews.get({ id: detail.id });
  if (latest.pr.headSha !== detail.pr.headSha) throw new Error(t("review.stale"));
  try {
    await hub.rpc.codeReviews.decide({
      id: detail.id,
      headSha: detail.pr.headSha,
      decision,
      ...(note ? { note } : {}),
    });
  } catch (error) {
    if (isConflict(error)) throw new Error(t("review.stale"));
    throw error;
  }
}

export function register(ctx: vscode.ExtensionContext): void {
  const hub = createHubClient({ hubUrl: config.hubUrl, auth });
  const details = new Map<string, CodeReviewDetail>();
  const provider = new DiffProvider();
  const comments = new ReviewController(
    hub,
    provider,
    details,
    async () => (await vscode.authentication.getSession("xdev-hive", [], { silent: true }))?.account.id,
  );
  const active = () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const ref = uri && parseUri(uri);
    const detail = ref && details.get(ref.reviewId);
    const source = uri && provider.documents.get(uri.toString());
    return detail && source ? { ...detail, pr: { ...detail.pr, headSha: source.headSha } } : undefined;
  };
  const context = () =>
    void vscode.commands.executeCommand("setContext", "xdevHive.review.canDecide", Boolean(active()?.canDecide));
  const safe =
    <Args extends unknown[]>(action: (...args: Args) => Promise<unknown>) =>
    async (...args: Args) => {
      try {
        return await action(...args);
      } catch (error) {
        void vscode.window.showErrorMessage(
          error instanceof Error && error.message === t("review.stale") ? error.message : t("review.failed"),
        );
      }
    };
  const command = <Args extends unknown[]>(name: string, action: (...args: Args) => Promise<unknown>) =>
    vscode.commands.registerCommand(`xdevHive.review.${name}`, safe(action));
  const fallback = (id: string) => {
    const panel = vscode.window.createWebviewPanel(
      "xdev-hive.review",
      "xDev Hive",
      vscode.ViewColumn.Active,
      webviewOptions(ctx.extensionUri),
    );
    ctx.subscriptions.push(panel);
    // Transport thuộc riêng panel: không thay transport của các màn khác.
    const bridge = attachBridge(panel.webview, "review", {
      rpc: async (request, signal) => {
        let response: Response;
        try {
          response = await hub.request(request.path, {
            method: request.method,
            body: request.body,
            signal,
            headers: { "content-type": "application/json" },
          });
        } catch (error) {
          if (request.path === "/rpc/codeReviews/decide" && isConflict(error))
            return {
              status: 409,
              contentType: "application/json",
              body: JSON.stringify({
                json: { defined: false, code: "CONFLICT", status: 409, message: t("review.stale") },
              }),
            };
          throw error;
        }
        return {
          status: response.status,
          body: await response.text(),
          contentType: response.headers.get("content-type") ?? "application/json",
        };
      },
    });
    ctx.subscriptions.push(
      bridge,
      panel.onDidDispose(() => bridge.dispose()),
    );
    panel.webview.html = renderHtml(panel.webview, ctx.extensionUri, "review").replace(
      'data-screen="review"',
      `data-screen="review" data-review-id="${id}"`,
    );
  };
  ctx.subscriptions.push(
    provider,
    comments,
    vscode.workspace.registerTextDocumentContentProvider("hive-review", provider),
    vscode.window.onDidChangeActiveTextEditor(context),
    command("open", async (value: string | { id?: string; reviewId?: string }) => {
      const id = typeof value === "string" ? value : (value?.reviewId ?? value?.id);
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
      const detail = await hub.rpc.codeReviews.get({ id });
      const project = await hub.rpc.projects.get({ id: detail.project.id });
      const root = await findRepo(
        [project.repo.httpUrl, project.repo.sshUrl, project.repo.webUrl].filter((url): url is string => Boolean(url)),
      );
      if (!root) {
        fallback(id);
        return;
      }
      const files = await hub.rpc.codeReviews.files({ id });
      if (files.headSha !== detail.pr.headSha) throw new Error(t("review.stale"));
      let base: string;
      try {
        base = await prepareRepo(root, detail.pr.branch, detail.pr.baseBranch, detail.pr.headSha);
      } catch {
        fallback(id);
        return;
      }
      details.set(id, detail);
      const diffs: [vscode.Uri, vscode.Uri, vscode.Uri][] = files.files.map((file) => {
        const oldUri = provider.add(
          { reviewId: id, side: "old", path: file.path, sha: base },
          root,
          file.status === "added",
          file.previousPath ?? file.path,
          detail.pr.headSha,
        );
        const newUri = provider.add(
          { reviewId: id, side: "new", path: file.path, sha: detail.pr.headSha },
          root,
          file.status === "removed",
        );
        return [newUri, oldUri, newUri];
      });
      await openDiffs(detail.task?.title ?? detail.project.name, diffs);
      await comments.refresh(id);
      context();
    }),
    command("submitComment", (reply: vscode.CommentReply) => comments.submit(reply)),
    command("resolveThread", (thread: vscode.CommentThread) => comments.resolve(thread, true)),
    command("reopenThread", (thread: vscode.CommentThread) => comments.resolve(thread, false)),
    command("retrySync", (comment: ReviewComment) => comments.retry(comment)),
    command("editComment", (comment: ReviewComment) => comments.change(comment, false)),
    command("deleteComment", (comment: ReviewComment) => comments.change(comment, true)),
    ...(["approve", "requestChanges"] as const).map((name) =>
      command(name, async () => {
        const detail = active();
        if (!detail?.canDecide) return;
        const note =
          name === "requestChanges"
            ? await vscode.window.showInputBox({
                prompt: t("review.note"),
                validateInput: (value) => (value.trim() ? undefined : t("review.note")),
              })
            : undefined;
        if (name === "requestChanges" && !note?.trim()) return;
        await decide(hub, detail, name === "approve" ? "approve" : "changes", note);
        details.set(detail.id, await hub.rpc.codeReviews.get({ id: detail.id }));
        context();
      }),
    ),
    poll(
      async () => {
        for (const id of details.keys()) {
          await comments.refresh(id);
          // Giữ SHA đã xem; quyết định luôn đối chiếu với hub trước khi gửi.
        }
      },
      {
        intervalMs: 30_000,
        focused: () => vscode.window.state.focused,
        onDidChangeWindowState: vscode.window.onDidChangeWindowState,
      },
    ),
  );
  context();
}
