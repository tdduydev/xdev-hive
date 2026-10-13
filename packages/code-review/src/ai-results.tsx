import type { AiReviewerResult, CodeGateRun } from "@xdev-hive/contracts";
import { Pill } from "@xdev-hive/ui/pill";
import { SeverityPill } from "./finding-badge.tsx";
import { bySeverity, type DiffFinding } from "./findings.ts";
import { formatScore } from "./format.ts";
import type { CodeReviewText } from "./text.ts";

const mark = (ok: boolean) => (ok ? "✓" : "✗");

function ReviewerBlock({ r, t }: { r: AiReviewerResult; t: CodeReviewText }) {
  const findings = r.findings.map<DiffFinding>((f) => ({ ...f, by: r.cli })).sort(bySeverity);
  return (
    <section className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="sel" className="font-mono">
          {r.cli}
        </Pill>
        {r.model && <span className="font-mono text-xs text-muted-foreground">{r.model}</span>}
        <span className="flex-1" />
        {r.state === "done" ? (
          <>
            {r.passed !== null && (
              <Pill tone={r.passed ? "ok" : "bad"} small>
                {r.passed ? t.reviewerPassed : t.reviewerFailed}
              </Pill>
            )}
            <strong className="font-mono tabular-nums">{t.scoreOf(formatScore(t, r.score))}</strong>
          </>
        ) : (
          <Pill tone={r.state === "error" ? "bad" : "warn"} small dot>
            {t.reviewerState[r.state]}
          </Pill>
        )}
      </div>
      {r.error && <p className="m-0 text-[0.8125rem] text-destructive">{r.error}</p>}
      {r.summary && <p className="m-0 text-sm">{r.summary}</p>}
      {r.checklist.length > 0 && (
        <ul aria-label={t.rubric} className="m-0 flex list-none flex-col gap-1.5 p-0 text-[0.8125rem]">
          {r.checklist.map((c) => (
            <li key={c.label} className="flex items-start gap-2">
              <span
                aria-hidden="true"
                className={`inline-flex size-4.5 flex-none items-center justify-center rounded-full text-[0.6875rem] ${c.passed ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}
              >
                {mark(c.passed)}
              </span>
              <span className="flex flex-col">
                <span>
                  <span className="sr-only">{c.passed ? t.reviewerPassed : t.reviewerFailed}: </span>
                  {c.label}
                </span>
                {c.note && <span className="text-muted-foreground">{c.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {r.state === "done" && (
        <ul aria-label={t.findings} className="m-0 flex list-none flex-col gap-1.5 p-0 text-[0.8125rem]">
          {findings.length === 0 && <li className="text-muted-foreground">{t.noFindings}</li>}
          {findings.map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: phát hiện không có id riêng
            <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <SeverityPill severity={f.severity} t={t} />
              <span className="break-all font-mono text-xs text-muted-foreground">{t.atLine(f.file, f.line)}</span>
              <span className="min-w-0 flex-[1_1_200px]">{f.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Kết quả các checkpoint AI: mỗi reviewer một khối (điểm, tóm tắt, rubric, phát hiện). */
export function AiResults({ gates, t }: { gates: CodeGateRun[]; t: CodeReviewText }) {
  const ai = gates.filter((g) => g.kind === "ai");
  if (!ai.length) return null;
  return (
    <>
      {ai.map((g) => (
        <div key={g.gateId} className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="m-0 text-sm font-semibold">
              {t.ai}
              {ai.length > 1 && <span className="font-normal text-muted-foreground"> · {g.name}</span>}
            </h2>
            {g.score !== null && (
              <Pill tone={g.status === "failed" ? "bad" : g.status === "passed" ? "ok" : "neutral"}>
                {t.avg} {t.scoreOf(formatScore(t, g.score))}
              </Pill>
            )}
          </div>
          {g.reviewers.length === 0 && <p className="m-0 px-4 py-3 text-sm text-muted-foreground">{t.aiPending}</p>}
          {g.reviewers.map((r) => (
            <ReviewerBlock key={`${r.cli}-${r.runId ?? r.model ?? ""}`} r={r} t={t} />
          ))}
          {g.note && <p className="m-0 px-4 py-2.5 text-[0.8125rem] text-muted-foreground">{g.note}</p>}
        </div>
      ))}
    </>
  );
}
