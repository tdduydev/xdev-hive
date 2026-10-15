import type { CodeReviewCommentThread } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Markdown } from "@xdev-hive/ui/markdown";
import { Pill } from "@xdev-hive/ui/pill";
import { useState } from "react";
import type { CodeReviewText } from "./text.ts";

type ActionResult = void | Promise<unknown>;

export interface CommentThreadActions {
  currentUserId?: string | undefined;
  onReply?: ((threadId: string, body: string) => ActionResult) | undefined;
  onEdit?: ((commentId: string, body: string) => ActionResult) | undefined;
  onDelete?: ((commentId: string) => ActionResult) | undefined;
  onResolve?: ((threadId: string, resolved: boolean) => ActionResult) | undefined;
  onRetrySync?: ((commentId: string) => ActionResult) | undefined;
}

export function CommentComposer({
  t,
  submit,
  initial = "",
  label = t.addComment,
  onCancel,
}: {
  t: CodeReviewText;
  submit: (body: string) => ActionResult;
  initial?: string;
  label?: string;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <form
      className="grid gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!body.trim() || pending) return;
        setPending(true);
        setFailed(false);
        try {
          await submit(body.trim());
          setBody("");
        } catch {
          setFailed(true);
        } finally {
          setPending(false);
        }
      }}
    >
      <textarea
        aria-label={t.commentBody}
        maxLength={20000}
        required
        disabled={pending}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        className="w-full rounded-md border border-border bg-card p-2 text-foreground"
      />
      {failed && <p role="alert">{t.commentFailed}</p>}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={pending || !body.trim()}>
          {pending ? t.sending : label}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
            {t.cancelComment}
          </Button>
        )}
      </div>
    </form>
  );
}

export function CommentThread({
  thread,
  t,
  ...actions
}: CommentThreadActions & {
  thread: CodeReviewCommentThread;
  t: CodeReviewText;
}) {
  const [editing, setEditing] = useState<string>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = async (action: () => ActionResult) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      await action();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      aria-label={`${t.comments}: ${thread.path}:${thread.line} (${t.commentSide[thread.side]})`}
      className="m-2 grid gap-2 rounded-md border border-border bg-card p-3 font-sans text-sm text-foreground whitespace-normal"
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-xs">
          {thread.path}:{thread.line} ({t.commentSide[thread.side]})
        </span>
        {thread.outdated && <Pill small>{t.outdatedThread}</Pill>}
        {thread.resolved && <Pill small>{t.resolvedThread}</Pill>}
        {actions.onResolve && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => void run(() => actions.onResolve?.(thread.id, !thread.resolved))}
          >
            {thread.resolved ? t.reopenThread : t.resolveThread}
          </Button>
        )}
      </header>
      {failed && <p role="alert">{t.commentFailed}</p>}
      {thread.comments.map((comment) => {
        const own = !!actions.currentUserId && comment.authorId === actions.currentUserId && comment.origin === "hive";
        const providerUrl =
          comment.providerUrl && /^https?:\/\//i.test(comment.providerUrl) ? comment.providerUrl : null;
        return (
          <div key={comment.id} className="grid gap-1 border-t border-border pt-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <strong>
                {comment.origin === "hive"
                  ? (comment.authorName ?? t.unknownAuthor)
                  : (comment.externalAuthor ?? t.unknownAuthor)}
              </strong>
              {comment.origin !== "hive" && <Pill small>{comment.origin === "github" ? "GitHub" : "GitLab"}</Pill>}
              <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString(t.locale)}</time>
              {comment.syncState === "pending" && <Pill small>{t.pendingSync}</Pill>}
              {comment.syncState === "failed" && (
                <Pill small tone="bad">
                  {t.failedSync}
                </Pill>
              )}
              {providerUrl && (
                <a href={providerUrl} target="_blank" rel="noreferrer noopener">
                  {t.viewOnPr}
                </a>
              )}
              {comment.syncState === "failed" && actions.onRetrySync && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => void run(() => actions.onRetrySync?.(comment.id))}
                >
                  {t.retry}
                </Button>
              )}
            </div>
            {comment.deletedAt ? (
              <p className="text-muted-foreground">{t.deletedComment}</p>
            ) : own && editing === comment.id && actions.onEdit ? (
              <CommentComposer
                key={comment.id}
                t={t}
                initial={comment.body}
                label={t.saveComment}
                onCancel={() => setEditing(undefined)}
                submit={async (body) => {
                  await actions.onEdit?.(comment.id, body);
                  setEditing(undefined);
                }}
              />
            ) : (
              <Markdown content={comment.body} lang={t.locale === "en-US" ? "en" : "vi"} />
            )}
            {own && !comment.deletedAt && editing !== comment.id && (
              <div className="flex gap-2">
                {actions.onEdit && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(comment.id)}>
                    {t.editComment}
                  </Button>
                )}
                {actions.onDelete && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => void run(() => actions.onDelete?.(comment.id))}
                  >
                    {t.deleteComment}
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {actions.onReply && (
        <CommentComposer t={t} label={t.replyComment} submit={(body) => actions.onReply?.(thread.id, body)} />
      )}
    </section>
  );
}
