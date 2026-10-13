import type { CodeGateRun } from "@xdev-hive/contracts";
import { formatScore } from "./format.ts";
import type { CodeReviewText } from "./text.ts";

type Tone = "ok" | "bad" | "warn" | "neutral";
const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-success-soft text-success",
  bad: "bg-destructive-soft text-destructive",
  warn: "bg-warning-soft text-warning",
  neutral: "bg-muted text-muted-foreground",
};
const TONE_MARK: Record<Tone, string> = { ok: "✓", bad: "✗", warn: "!", neutral: "…" };

function Row({ tone, state, text, meta }: { tone: Tone; state: string; text: string; meta?: string | null }) {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden="true"
        className={`inline-flex size-4.5 flex-none items-center justify-center rounded-full text-[0.6875rem] ${TONE_CLASS[tone]}`}
      >
        {TONE_MARK[tone]}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-words">
          <span className="sr-only">{state}: </span>
          {text}
        </span>
        {meta && <span className="break-words font-mono text-xs text-muted-foreground">{meta}</span>}
      </span>
    </li>
  );
}

const gateTone = (g: CodeGateRun): Tone =>
  g.status === "passed" ? "ok" : g.status === "failed" ? "bad" : g.status === "skipped" ? "neutral" : "warn";

/**
 * Những gì máy đã kiểm ngoài AI: quy tắc, lệnh (mã thoát, 200 dòng cuối đã che bí mật), trạng thái CI. Checkpoint chưa
 * tới lượt không hiện để người duyệt khỏi đọc dòng trống.
 */
export function MachineChecks({ gates, t }: { gates: CodeGateRun[]; t: CodeReviewText }) {
  const machine = gates.filter((g) => (g.kind === "rule" || g.kind === "ext") && g.startedAt !== null);
  if (!machine.length) return null;
  const rows = machine.flatMap((g) => [
    ...g.checklist.map((c) => ({
      key: `${g.gateId}:${c.label}`,
      tone: (c.passed ? "ok" : "bad") as Tone,
      state: c.passed ? t.checkState.passed : t.checkState.failed,
      text: c.label,
      meta: c.note,
    })),
    ...g.commands.map((c) => ({
      key: `${g.gateId}:cmd:${c.run}`,
      tone: (c.exit === 0 ? "ok" : "bad") as Tone,
      state: c.exit === 0 ? t.checkState.passed : t.checkState.failed,
      text: c.run,
      meta: t.commandMeta(c.exit, formatScore(t, c.durationMs / 1000)),
    })),
    ...(g.ci
      ? [
          {
            key: `${g.gateId}:ci`,
            tone: (g.ci.state === "success" ? "ok" : g.ci.state === "failure" ? "bad" : "warn") as Tone,
            state: t.ciState[g.ci.state],
            text: `${t.ci}: ${t.ciState[g.ci.state]}`,
            meta: g.ci.url,
          },
        ]
      : []),
    // Checkpoint chưa có dòng chi tiết nào nhưng đang chờ hoặc có ghi chú (vd. chờ máy chạy lệnh) vẫn phải nói ra.
    ...(!g.checklist.length && !g.commands.length && !g.ci
      ? [{ key: `${g.gateId}:status`, tone: gateTone(g), state: t.checkState[g.status], text: g.name, meta: g.note }]
      : []),
  ]);
  const passed = rows.filter((r) => r.tone === "ok").length;
  const tails = machine.flatMap((g) => g.commands.filter((c) => c.tail));
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="m-0 text-sm font-semibold">{t.machine}</h2>
        <span className="text-[0.8125rem] text-muted-foreground">{t.machineMeta(passed, rows.length - passed)}</span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2.5 px-4 py-2.5 text-sm">
        {rows.map((r) => (
          <Row key={r.key} tone={r.tone} state={r.state} text={r.text} meta={r.meta} />
        ))}
      </ul>
      {tails.map((c) => (
        <details key={c.run} className="border-t border-border">
          <summary className="cursor-pointer px-4 py-2.5 text-[0.8125rem] font-medium">{t.commandTail(c.run)}</summary>
          <pre className="m-0 max-h-80 overflow-auto px-4 pb-3 font-mono text-xs text-muted-foreground">{c.tail}</pre>
        </details>
      ))}
    </div>
  );
}
