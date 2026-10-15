import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CodeReviewCommentThread } from "@xdev-hive/contracts";
import { describe, expect, it, vi } from "vitest";
import { CommentThread } from "./comment-thread.tsx";
import { codeReviewText } from "./text.ts";

const t = codeReviewText.vi;
const thread: CodeReviewCommentThread = {
  id: "thread-1",
  path: "src/refund.ts",
  line: 11,
  side: "new",
  headSha: "a".repeat(40),
  outdated: false,
  resolved: false,
  resolvedAt: null,
  resolvedBy: null,
  comments: [
    {
      id: "comment-1",
      threadId: "thread-1",
      authorId: "u1",
      authorName: "Lan",
      body: "**Cần test biên**",
      origin: "hive",
      externalAuthor: null,
      createdAt: "2026-10-15T00:00:00Z",
      editedAt: null,
      deletedAt: null,
    },
  ],
};

describe("CommentThread", () => {
  it("chặn HTML thô, URL script và vẫn dựng Markdown", () => {
    const body =
      '**Nội dung**\n\n<script>window.pwned = true</script>\n\n<img src=x onerror="alert(1)">\n\n[link](javascript:alert%281%29)';
    const { container } = render(
      <CommentThread thread={{ ...thread, comments: [{ ...thread.comments[0]!, body }] }} t={t} />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("Lan");
    expect(screen.getByText("Nội dung").tagName).toBe("STRONG");
    expect(container.querySelector("script, img, iframe, [onerror], a")).toBeNull();
  });

  it("sửa, xoá chỉ dành cho tác giả Hive; giữ chỗ bình luận đã xoá", async () => {
    const user = userEvent.setup({ delay: null });
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const props = { t, currentUserId: "u1", onEdit, onDelete };
    const view = render(<CommentThread thread={thread} {...props} />);
    await user.click(screen.getByRole("button", { name: t.editComment }));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Cần test thêm");
    await user.click(screen.getByRole("button", { name: t.saveComment }));
    expect(onEdit).toHaveBeenCalledWith("comment-1", "Cần test thêm");
    await user.click(screen.getByRole("button", { name: t.deleteComment }));
    expect(onDelete).toHaveBeenCalledWith("comment-1");
    for (const comment of [
      { ...thread.comments[0]!, authorId: "u2" },
      { ...thread.comments[0]!, origin: "github" as const, externalAuthor: "external" },
      { ...thread.comments[0]!, deletedAt: "2026-10-15T01:00:00Z" },
    ]) {
      view.rerender(<CommentThread thread={{ ...thread, comments: [comment] }} {...props} />);
      expect(screen.queryByRole("button", { name: t.editComment })).toBeNull();
      expect(screen.queryByRole("button", { name: t.deleteComment })).toBeNull();
    }
    expect(screen.getByText(t.deletedComment)).toBeTruthy();
    expect(screen.queryByText("Cần test biên")).toBeNull();
  });

  it("trả lời, xử lý và mở lại cả luồng đã cũ", async () => {
    const onReply = vi.fn();
    const onResolve = vi.fn();
    const user = userEvent.setup({ delay: null });
    const view = render(
      <CommentThread thread={{ ...thread, outdated: true }} t={t} onReply={onReply} onResolve={onResolve} />,
    );
    expect(screen.getByText(t.outdatedThread)).toBeTruthy();
    expect((screen.getByRole("button", { name: t.replyComment }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole("textbox"), "Đã bổ sung");
    await user.click(screen.getByRole("button", { name: t.replyComment }));
    expect(onReply).toHaveBeenCalledWith(thread.id, "Đã bổ sung");
    await user.click(screen.getByRole("button", { name: t.resolveThread }));
    expect(onResolve).toHaveBeenCalledWith(thread.id, true);
    view.rerender(<CommentThread thread={{ ...thread, resolved: true }} t={t} onResolve={onResolve} />);
    await user.click(screen.getByRole("button", { name: t.reopenThread }));
    expect(onResolve).toHaveBeenCalledWith(thread.id, false);
  });

  it("hiện nguồn, trạng thái, link an toàn; ẩn Thử lại tới khi host có retrySync", async () => {
    const external = {
      ...thread.comments[0]!,
      origin: "gitlab" as const,
      externalAuthor: "dev-lab",
      syncState: "failed" as const,
      providerUrl: "https://gitlab.example/a/-/merge_requests/1#note_1",
    };
    const view = render(<CommentThread thread={{ ...thread, comments: [external] }} t={t} />);
    expect(screen.getByText("GitLab")).toBeTruthy();
    expect(screen.getByText("dev-lab")).toBeTruthy();
    expect(screen.getByText(t.failedSync)).toBeTruthy();
    expect(screen.getByRole("link", { name: t.viewOnPr }).getAttribute("href")).toBe(external.providerUrl);
    expect(screen.queryByRole("button", { name: t.retry })).toBeNull();
    const onRetrySync = vi.fn();
    view.rerender(<CommentThread thread={{ ...thread, comments: [external] }} t={t} onRetrySync={onRetrySync} />);
    await userEvent.click(screen.getByRole("button", { name: t.retry }));
    expect(onRetrySync).toHaveBeenCalledWith(external.id);
    view.rerender(
      <CommentThread
        thread={{
          ...thread,
          comments: [{ ...external, origin: "github", syncState: "pending", providerUrl: "javascript:alert(1)" }],
        }}
        t={t}
      />,
    );
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText(t.pendingSync)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("giữ nội dung khi gửi lỗi và không gửi lặp khi đang chờ", async () => {
    let reject!: (error: Error) => void;
    const onReply = vi.fn(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    render(<CommentThread thread={thread} t={t} onReply={onReply} />);
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByRole("textbox"), "Giữ nội dung");
    await user.click(screen.getByRole("button", { name: t.replyComment }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
    expect(onReply).toHaveBeenCalledTimes(1);
    reject(new Error("Mất kết nối"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(t.commentFailed));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Giữ nội dung");
  });
});
