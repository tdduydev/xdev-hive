import type { CodeReviewCommentThread, CodeReviewFiles, PrFile } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { cn } from "cn";
import { useMemo, useState } from "react";
import { CommentComposer, CommentThread, type CommentThreadActions } from "./comment-thread.tsx";
import { SeverityPill } from "./finding-badge.tsx";
import { anchorFindings, type DiffFinding } from "./findings.ts";
import { providerName } from "./format.ts";
import { MAX_PATCH_LINES, type PatchLine, parsePatch, patchLineCount } from "./patch.ts";
import type { CodeReviewText } from "./text.ts";

export type CommentAnchor = { path: string; line: number; side: "old" | "new"; headSha: string };
export interface FileDiffComments extends CommentThreadActions {
  threads?: CodeReviewCommentThread[] | undefined;
  onAddComment?: ((anchor: CommentAnchor, body: string) => void | Promise<unknown>) | undefined;
}

const LINE_STYLE = {
  add: "bg-success-soft",
  del: "bg-destructive-soft",
  context: "",
  hunk: "bg-muted text-muted-foreground",
} as const;
const SIGN = { add: "+", del: "−", context: " " } as const;

function FindingNote({ f, t }: { f: DiffFinding; t: CodeReviewText }) {
  return (
    <div
      role="note"
      className={cn(
        "ml-14 mr-2 my-1 flex flex-col gap-0.5 rounded-md border px-2.5 py-1.5 font-sans text-[0.8125rem] whitespace-normal",
        f.severity === "critical" || f.severity === "major"
          ? "border-warning/40 bg-warning-soft text-warning"
          : "border-border bg-card text-foreground",
      )}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <SeverityPill severity={f.severity} t={t} />
        <span className="font-mono text-xs opacity-80">{f.by}</span>
      </span>
      <span>{f.message}</span>
    </div>
  );
}

/** Vùng thay thế patch: file quá lớn, nhị phân hoặc nhà cung cấp cắt mất patch → mở thẳng trên GitHub/GitLab. */
function Fallback({ title, text, prUrl, t }: { title: string; text: string; prUrl: string; t: CodeReviewText }) {
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-6">
      <strong>{title}</strong>
      <span className="text-muted-foreground">{text}</span>
      <a
        href={prUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-8 items-center rounded-lg border border-border px-2.5 text-sm font-medium hover:bg-muted"
      >
        {t.openOnProvider(providerName(prUrl))}
      </a>
    </div>
  );
}

function PatchView({
  file,
  findings,
  prUrl,
  t,
  headSha,
  threads,
  onAddComment,
  ...actions
}: FileDiffComments & {
  headSha: string;
  file: PrFile;
  findings: DiffFinding[];
  prUrl: string;
  t: CodeReviewText;
}) {
  const [adding, setAdding] = useState<{ line: number; side: "old" | "new" }>();
  const tooBig = file.patch !== null && patchLineCount(file.patch) > MAX_PATCH_LINES;
  const lines = useMemo<PatchLine[]>(
    () => (file.patch === null || file.truncated || tooBig ? [] : parsePatch(file.patch)),
    [file.patch, file.truncated, tooBig],
  );
  const anchored = useMemo(() => anchorFindings(lines, findings), [lines, findings]);

  const threadIndexes = new Map<string, number>();
  for (const thread of threads ?? []) {
    if (thread.outdated) continue;
    const index = lines.findIndex(
      (line) => line.kind !== "hunk" && (thread.side === "old" ? line.oldNo : line.newNo) === thread.line,
    );
    if (index >= 0) threadIndexes.set(thread.id, index);
  }
  const showThread = (thread: CodeReviewCommentThread) => (
    <CommentThread key={thread.id} thread={thread} t={t} {...actions} />
  );
  const looseThreads = threads?.filter((thread) => !threadIndexes.has(thread.id)).map(showThread);
  if (file.truncated || tooBig || file.patch === null)
    return (
      <>
        <Fallback title={t.bigTitle} text={file.truncated || tooBig ? t.bigText : t.binaryText} prUrl={prUrl} t={t} />
        {looseThreads}
      </>
    );

  return (
    <>
      {looseThreads}
      {anchored.loose.length > 0 && (
        <div className="border-b border-border py-2">
          <div className="px-3 text-xs font-medium text-muted-foreground">{t.fileFindings}</div>
          {anchored.loose.map((f) => (
            <FindingNote
              key={`${f.by}:${f.line}:${f.message}`}
              f={{ ...f, message: f.line ? `${t.atLine(f.file, f.line)}: ${f.message}` : f.message }}
              t={t}
            />
          ))}
        </div>
      )}
      <section
        // Vùng cuộn ngang của patch phải focus được bằng bàn phím.
        // biome-ignore lint/a11y/noNoninteractiveTabindex: lý do ở trên
        tabIndex={0}
        aria-label={t.patchOf(file.path)}
        className="max-h-[70vh] overflow-auto font-mono text-xs leading-5"
      >
        {lines.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: dòng của patch không có id riêng
          <div key={i}>
            {l.kind === "hunk" ? (
              <div className={cn("px-3", LINE_STYLE.hunk)}>{l.text}</div>
            ) : (
              <div className={cn("flex min-w-max", LINE_STYLE[l.kind])}>
                <span className="w-12 shrink-0 select-none pr-2 text-right text-muted-foreground">
                  {l.newNo ?? l.oldNo}
                </span>
                {onAddComment &&
                  (["old", "new"] as const).map((side) => {
                    const line = side === "old" ? l.oldNo : l.newNo;
                    return line === null ? null : (
                      <Button
                        key={side}
                        size="sm"
                        variant="ghost"
                        aria-label={t.commentAt(side, line)}
                        title={t.commentAt(side, line)}
                        className="h-5 px-1"
                        onClick={() => setAdding({ side, line })}
                      >
                        +
                      </Button>
                    );
                  })}
                <span className="px-1 whitespace-pre">
                  <span className="sr-only">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
                  <span aria-hidden="true">{SIGN[l.kind]}</span> {l.text}
                </span>
              </div>
            )}
            {threads?.filter((thread) => threadIndexes.get(thread.id) === i).map(showThread)}
            {adding &&
              l.kind !== "hunk" &&
              (adding.side === "old" ? l.oldNo : l.newNo) === adding.line &&
              onAddComment && (
                <div className="p-3 font-sans">
                  <CommentComposer
                    key={`${adding.side}:${adding.line}`}
                    t={t}
                    onCancel={() => setAdding(undefined)}
                    submit={async (body) => {
                      await onAddComment({ path: file.path, headSha, ...adding }, body);
                      setAdding(undefined);
                    }}
                  />
                </div>
              )}
            {anchored.byIndex.get(i)?.map((f, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: phát hiện không có id riêng
              <FindingNote key={j} f={f} t={t} />
            ))}
          </div>
        ))}
      </section>
    </>
  );
}

/**
 * Diff của PR theo từng file: danh sách file bên trái (cộng/trừ, số phát hiện AI), patch unified bên phải với phát
 * hiện gắn đúng dòng. Chỉ file đang chọn mới dựng DOM nên PR 100 file vẫn nhẹ (SC-007).
 */
export function FileDiff({
  data,
  findings,
  prUrl,
  t,
  threads,
  ...actions
}: FileDiffComments & {
  data: CodeReviewFiles;
  findings: DiffFinding[];
  prUrl: string;
  t: CodeReviewText;
}) {
  const [selected, setSelected] = useState(data.files[0]?.path ?? "");
  const file = data.files.find((f) => f.path === selected) ?? data.files[0];
  const byFile = useMemo(() => {
    const map = new Map<string, DiffFinding[]>();
    for (const f of findings) map.set(f.file, [...(map.get(f.file) ?? []), f]);
    return map;
  }, [findings]);

  const currentThreads = threads?.map((thread) => ({
    ...thread,
    outdated: thread.outdated || thread.headSha !== data.headSha,
  }));
  const missingThreads = currentThreads?.filter((thread) => !data.files.some((entry) => entry.path === thread.path));
  if (!file)
    return (
      <>
        <p className="px-4 py-6 text-muted-foreground">{t.noFiles}</p>
        {missingThreads?.map((thread) => (
          <CommentThread key={thread.id} thread={thread} t={t} {...actions} />
        ))}
      </>
    );
  return (
    <div className="flex flex-wrap items-stretch">
      {data.truncated && (
        <p className="basis-full border-b border-border bg-warning-soft px-4 py-2 text-[0.8125rem] text-warning">
          {t.filesTruncated(data.files.length)}
        </p>
      )}
      <nav
        aria-label={t.files}
        className="flex min-w-50 max-w-70 flex-[1_1_220px] flex-col gap-0.5 border-r border-border bg-muted p-2"
      >
        {data.files.map((f) => {
          const n = byFile.get(f.path)?.length ?? 0;
          return (
            <button
              key={f.path}
              type="button"
              aria-current={f.path === file.path ? "true" : undefined}
              onClick={() => setSelected(f.path)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-card",
                f.path === file.path && "bg-card shadow-sm",
              )}
            >
              <span className="flex-1 break-all font-mono text-xs">{f.path}</span>
              <span className="whitespace-nowrap font-mono text-[0.71875rem] tabular-nums">
                <span className="text-success">+{f.additions}</span>{" "}
                <span className="text-destructive">−{f.deletions}</span>
              </span>
              {n > 0 && (
                <Pill tone="warn" small title={t.findsHere(n)} aria-label={t.findsHere(n)}>
                  {n}
                </Pill>
              )}
            </button>
          );
        })}
      </nav>
      <div className="min-w-0 flex-[999_1_320px]">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 font-mono text-xs">
          <span className="break-all">{file.path}</span>
          <Pill small>{t.fileStatus[file.status]}</Pill>
          {file.previousPath && <span className="text-muted-foreground">{t.renamedFrom(file.previousPath)}</span>}
        </div>
        <PatchView
          key={file.path}
          file={file}
          findings={byFile.get(file.path) ?? []}
          prUrl={prUrl}
          t={t}
          headSha={data.headSha}
          threads={currentThreads?.filter((thread) => thread.path === file.path)}
          {...actions}
        />
        {missingThreads?.map((thread) => (
          <CommentThread key={thread.id} thread={thread} t={t} {...actions} />
        ))}
      </div>
    </div>
  );
}
