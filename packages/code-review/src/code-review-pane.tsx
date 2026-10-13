import type { CodeReviewDetail, CodeReviewFiles, CodeReviewStatus } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { type ReactNode, useMemo } from "react";
import { AiResults } from "./ai-results.tsx";
import { DecisionForm, type DecisionSubmit, OverrideForm, StaleNotice } from "./decision-form.tsx";
import { FileDiff } from "./file-diff.tsx";
import { collectFindings } from "./findings.ts";
import { formatSla, shortSha } from "./format.ts";
import { GateStepper } from "./gate-stepper.tsx";
import { MachineChecks } from "./machine-checks.tsx";
import type { CodeReviewText } from "./text.ts";

/** Trang trong app chủ mà khung review liên kết tới; mỗi app tự dựng đường dẫn. PR là link ngoài nên không nằm ở đây. */
export type CodeReviewLink = { kind: "run"; id: string } | { kind: "task"; id: string; key: string };

export type CodeReviewLinkRenderer = (props: {
  to: CodeReviewLink;
  className?: string;
  children: ReactNode;
}) => ReactNode;

/** Trạng thái tải diff của app chủ (TanStack Query hay gì khác), để khung không phụ thuộc cách gọi hub. */
export type FilesState =
  | { status: "loading" }
  | { status: "error"; message: string; retry?: () => void }
  | { status: "ready"; data: CodeReviewFiles };

const defaultLink: CodeReviewLinkRenderer = ({ className, children }) => <span className={className}>{children}</span>;

const STATUS_TONE: Record<CodeReviewStatus, "ok" | "bad" | "warn" | "neutral" | "sel"> = {
  in_review: "warn",
  changes_requested: "bad",
  approved: "ok",
  merged: "ok",
  cancelled: "neutral",
  superseded: "neutral",
};

function Card({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="m-0 text-sm font-semibold">{title}</h2>
        {meta && <span className="text-[0.8125rem] text-muted-foreground">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * Khung review một PR (CodeReview.dc.html): tiêu đề và stepper, kết quả máy và AI, diff gắn phát hiện, các vòng, quyết
 * định. Chỉ vẽ: dữ liệu và các hành động (`onDecide`…) do app chủ cấp, nên web (cookie) và app desktop (token qua Rust)
 * dùng chung. `latestHeadSha` là đầu PR mới nhất app chủ biết; khác `detail.pr.headSha` thì chặn quyết định.
 */
export function CodeReviewPane({
  detail,
  files,
  latestHeadSha,
  now,
  t,
  pending = false,
  error,
  link = defaultLink,
  onDecide,
  onOverride,
  onEnqueue,
  onRecheck,
  onReload,
}: {
  detail: CodeReviewDetail;
  files: FilesState;
  latestHeadSha?: string | null;
  now: number;
  t: CodeReviewText;
  pending?: boolean;
  /** Lỗi của lần gửi quyết định gần nhất, đã dịch ra chữ. */
  error?: string | null;
  link?: CodeReviewLinkRenderer;
  onDecide: (input: DecisionSubmit) => void;
  onOverride?: (input: { headSha: string; passed: boolean; note: string }) => void;
  onEnqueue?: () => void;
  onRecheck?: () => void;
  onReload?: () => void;
}) {
  const findings = useMemo(() => collectFindings(detail.gates), [detail.gates]);
  const stale = !!latestHeadSha && latestHeadSha !== detail.pr.headSha;
  const open = detail.status === "in_review" && detail.gate !== null;
  const humanGate = open && detail.gate?.kind === "human";
  const changed = detail.changedFiles;

  return (
    <section aria-label={t.detail} className="flex flex-wrap items-start gap-4">
      <div className="flex min-w-0 flex-[3_1_560px] flex-col gap-4">
        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="neutral">{t.code}</Pill>
            <strong className="min-w-0 break-words text-base">{detail.task?.title ?? detail.workflow.name}</strong>
            <span className="font-mono text-[0.8125rem] text-muted-foreground">#{detail.pr.number}</span>
            <span className="flex-1" />
            <Pill tone={STATUS_TONE[detail.status]}>{t.statusText[detail.status]}</Pill>
            {detail.gate && detail.gate.sla !== "none" && (
              <Pill
                tone={detail.gate.sla === "overdue" ? "bad" : detail.gate.sla === "due-soon" ? "warn" : "ok"}
                dot={detail.gate.sla !== "on-time"}
              >
                {formatSla(t, detail.gate, now)}
              </Pill>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.8125rem] text-muted-foreground">
            <span className="font-mono">{detail.project.key}</span>
            {detail.task &&
              link({
                to: { kind: "task", id: detail.task.id, key: detail.task.key },
                className: "font-mono text-primary",
                children: detail.task.key,
              })}
            <span className="font-mono">
              {detail.pr.branch} → {detail.pr.baseBranch}
            </span>
            <span>{detail.requester ? t.byRequester(detail.requester.name) : t.byTeamRun}</span>
            <Pill tone="sel" small className="font-mono">
              {t.round} {detail.round}
            </Pill>
            <span className="font-mono text-foreground tabular-nums">{shortSha(detail.pr.headSha)}</span>
            {link({ to: { kind: "run", id: detail.runId }, className: "text-primary", children: t.openRun })}
            <a href={detail.pr.url} target="_blank" rel="noreferrer" className="text-primary">
              {t.openPr}
            </a>
          </div>
          {detail.runReasons.length > 0 && (
            <ul aria-label={t.runReasons} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {detail.runReasons.map((r) => (
                <li key={r}>
                  <Pill tone="warn" small>
                    {r}
                  </Pill>
                </li>
              ))}
            </ul>
          )}
          <GateStepper gates={detail.gates} currentGateId={open ? (detail.gate?.id ?? null) : null} t={t} />
          {!open && t.finalText[detail.status] && (
            <p className="m-0 text-[0.8125rem] text-muted-foreground">{t.finalText[detail.status]}</p>
          )}
        </div>

        {stale && !humanGate && <StaleNotice latestHeadSha={latestHeadSha} onReload={onReload} t={t} />}

        <MachineChecks gates={detail.gates} t={t} />

        <Card title={t.changes} meta={t.changesMeta(changed, detail.addedLines, detail.deletedLines)}>
          {files.status === "loading" && <p className="m-0 px-4 py-6 text-muted-foreground">{t.loadingFiles}</p>}
          {files.status === "error" && (
            <Alert variant="destructive" className="m-3 flex flex-wrap items-center justify-between gap-2 w-auto">
              {files.message}
              {files.retry && (
                <Button size="sm" variant="outline" onClick={files.retry}>
                  {t.retry}
                </Button>
              )}
            </Alert>
          )}
          {files.status === "ready" && (
            // `key` theo headSha: sang vòng mới thì chọn lại file đầu thay vì giữ file của vòng cũ.
            <FileDiff key={files.data.headSha} data={files.data} findings={findings} prUrl={detail.pr.url} t={t} />
          )}
        </Card>

        <Card title={t.rounds} meta={t.roundsMeta}>
          <ol className="m-0 flex list-none flex-col gap-3 px-4 py-2.5 text-sm">
            {detail.rounds.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
                <Pill tone={r.id === detail.id ? "sel" : "neutral"} small className="font-mono">
                  {t.round} {r.round}
                </Pill>
                <span className="font-mono tabular-nums">{shortSha(r.headSha)}</span>
                <span className="min-w-0 flex-[1_1_240px]">
                  {t.statusText[r.status]}
                  {r.id === detail.id && <span className="text-muted-foreground"> · {t.thisRound}</span>}
                </span>
                <time dateTime={r.createdAt} className="text-[0.8125rem] text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString(t.locale)}
                </time>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <aside className="flex min-w-0 flex-[2_1_380px] flex-col gap-4">
        <AiResults gates={detail.gates} t={t} />
        {humanGate && (
          <DecisionForm
            // Đổi vòng thì bỏ ghi chú đã gõ dở: nó viết cho commit cũ.
            key={detail.pr.headSha}
            detail={detail}
            latestHeadSha={latestHeadSha}
            pending={pending}
            error={error}
            onDecide={onDecide}
            onReload={onReload}
            t={t}
          />
        )}
        {open && !humanGate && detail.canOverride && onOverride && (
          <OverrideForm
            key={detail.pr.headSha}
            detail={detail}
            latestHeadSha={latestHeadSha}
            pending={pending}
            error={error}
            onOverride={onOverride}
            onRecheck={onRecheck}
            t={t}
          />
        )}
        {detail.status === "approved" && (
          <Card title={t.mergeTitle}>
            <div className="flex flex-col items-start gap-2 px-4 py-3.5 text-[0.8125rem] text-muted-foreground">
              <span>
                {detail.inMergeQueue ? t.inQueue : detail.mergeMode === "manual" ? t.mergeManual : t.mergeAuto}
              </span>
              {detail.canEnqueue && !detail.inMergeQueue && onEnqueue && (
                <Button disabled={pending} onClick={onEnqueue}>
                  {t.enqueue}
                </Button>
              )}
            </div>
          </Card>
        )}
      </aside>
    </section>
  );
}
