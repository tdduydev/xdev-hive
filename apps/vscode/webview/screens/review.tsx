import { CodeReviewPane, codeReviewText } from "@xdev-hive/code-review";
import type { CodeReviewCommentThread, CodeReviewDetail, CodeReviewFiles } from "@xdev-hive/contracts";
import { useCallback, useEffect, useState } from "react";
import { bridge, hub } from "@/bridge.ts";

export function ReviewScreen() {
  const id = document.body.dataset.reviewId ?? "";
  const t = codeReviewText[document.documentElement.lang === "en" ? "en" : "vi"];
  const [data, setData] = useState<{
    detail: CodeReviewDetail;
    files: CodeReviewFiles;
    threads: CodeReviewCommentThread[];
  }>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [latestHead, setLatestHead] = useState<string>();
  const [userId, setUserId] = useState<string>();
  const failed =
    document.documentElement.lang === "en"
      ? "The review action failed. Please retry."
      : "Không thực hiện được thao tác review. Vui lòng thử lại.";
  const stale =
    document.documentElement.lang === "en"
      ? "The PR has new commits. Reload before deciding."
      : "PR đã có commit mới, tải lại trước khi duyệt";
  const load = useCallback(async () => {
    const [detail, files, comments] = await Promise.all([
      hub.codeReviews.get({ id }),
      hub.codeReviews.files({ id }),
      hub.codeReviews.comments.list({ reviewId: id }),
    ]);
    setData({ detail, files, threads: comments.threads });
    setLatestHead(files.headSha);
  }, [id]);
  useEffect(() => {
    let disposed = false;
    void load().catch(() => {
      if (!disposed) setError(failed);
    });
    void hub.me
      .get()
      .then((me) => {
        if (!disposed) setUserId(me.id);
      })
      .catch(() => {});
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void Promise.all([hub.codeReviews.get({ id }), hub.codeReviews.comments.list({ reviewId: id })])
        .then(([detail, comments]) => {
          if (!disposed) {
            setLatestHead(detail.pr.headSha);
            setData((old) => old && { ...old, threads: comments.threads });
          }
        })
        .catch(() => {});
    }, 30_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [id, failed, load]);
  const action = async (run: () => Promise<unknown>) => {
    setPending(true);
    setError(undefined);
    try {
      await run();
      await load();
    } catch (cause) {
      setError(cause instanceof Error && cause.message === stale ? stale : failed);
      throw cause;
    } finally {
      setPending(false);
    }
  };
  if (!data)
    return (
      <div role="status">
        {error ?? (document.documentElement.lang === "en" ? "Loading review…" : "Đang tải phiên review…")}
      </div>
    );
  return (
    <CodeReviewPane
      detail={data.detail}
      files={{ status: "ready", data: data.files }}
      latestHeadSha={latestHead ?? null}
      now={Date.now()}
      t={t}
      pending={pending}
      error={error ?? null}
      onReload={() => {
        void load().catch(() => setError(failed));
      }}
      onDecide={(input) => {
        void action(async () => {
          const latest = await hub.codeReviews.get({ id });
          if (latest.pr.headSha !== input.headSha) {
            setLatestHead(latest.pr.headSha);
            throw new Error(stale);
          }
          try {
            await hub.codeReviews.decide({ id, ...input });
          } catch (cause) {
            if (cause && typeof cause === "object" && "code" in cause && cause.code === "CONFLICT")
              throw new Error(stale);
            throw cause;
          }
        }).catch(() => {});
      }}
      comments={{
        onRetrySync: (commentId) =>
          action(async () => {
            const response = await bridge.fetch(
              new Request("https://hive.invalid/rpc/codeReviews/comments/retrySync", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ json: { commentId } }),
              }),
            );
            if (!response.ok) throw new Error(failed);
          }),
        threads: data.threads,
        currentUserId: userId,
        onAddComment: (anchor, body) => action(() => hub.codeReviews.comments.add({ reviewId: id, ...anchor, body })),
        onReply: (threadId, body) => action(() => hub.codeReviews.comments.reply({ threadId, body })),
        onEdit: (commentId, body) => action(() => hub.codeReviews.comments.edit({ commentId, body })),
        onDelete: (commentId) => action(() => hub.codeReviews.comments.delete({ commentId })),
        onResolve: (threadId, resolved) =>
          action(() =>
            resolved ? hub.codeReviews.comments.resolve({ threadId }) : hub.codeReviews.comments.reopen({ threadId }),
          ),
      }}
    />
  );
}
