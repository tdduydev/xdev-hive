import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { CheckIcon, MinusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import {
  type OptimizePlan,
  type OptimizePolicies,
  type OptimizeRun,
  optimizeAllApply,
  optimizeAllPreview,
  optimizeAllUndo,
  type PlanChange,
  type PlanStep,
  type RunStep,
  type StepGroup,
  withSelection,
} from "@/lib/optimize-all.ts";
import { errorText } from "@/lib/tauri.ts";
import { formatScore } from "@/lib/token-score.ts";

const text: Dict<{
  title: string;
  lead: string;
  loading: string;
  empty: string;
  groups: Record<StepGroup, string>;
  selectStep: (title: string) => string;
  needsConfirm: string;
  aggressiveHint: string;
  notUndoable: string;
  reasonLabel: string;
  noValue: string;
  removed: string;
  selected: (n: number, total: number) => string;
  apply: (n: number) => string;
  applying: string;
  cancel: string;
  close: string;
  retry: string;
  locked: string;
  resultTitle: string;
  resultLead: string;
  scoreBefore: string;
  scoreAfter: string;
  noScore: string;
  status: Record<RunStep["status"], string>;
  undo: string;
  undoing: string;
  undone: string;
  undoneNote: string;
  failedCount: (n: number) => string;
}> = {
  vi: {
    title: "Tối ưu cả máy",
    lead: "Xem trước mọi thay đổi sẽ làm. Chưa có gì được ghi: chỉ các dòng đã chọn mới chạy khi bạn bấm áp dụng, và cả lần chạy hoàn tác được bằng một nút.",
    loading: "Đang lập danh sách thay đổi…",
    empty: "Máy đã tối ưu, không có thay đổi nào cần làm.",
    groups: { cli: "Cấu hình CLI", tools: "Công cụ", context: "Ngữ cảnh", score: "Điểm" },
    selectStep: (title) => `Chọn: ${title}`,
    needsConfirm: "Cần bạn chọn tay: dòng này đổi mô hình hay mức tối ưu mạnh.",
    aggressiveHint: "Mức Mạnh: Claude dùng Sonnet cho subagent, chất lượng có thể thấp hơn.",
    notUndoable: "Không hoàn tác được: công cụ đã cài không gỡ.",
    reasonLabel: "Lý do",
    noValue: "(chưa có)",
    removed: "(xoá)",
    selected: (n, total) => `Đã chọn ${n}/${total} dòng`,
    apply: (n) => `Áp dụng ${n} dòng`,
    applying: "Đang áp dụng…",
    cancel: "Huỷ",
    close: "Đóng",
    retry: "Thử lại",
    locked: "Đang tối ưu ở cửa sổ khác. Đợi cửa sổ đó xong rồi thử lại.",
    resultTitle: "Kết quả",
    resultLead: "Kết quả từng dòng và điểm trước, sau khi tối ưu.",
    scoreBefore: "Điểm trước",
    scoreAfter: "Điểm sau",
    noScore: "—",
    status: { planned: "Chưa chạy", skipped: "Bỏ qua", ok: "Xong", failed: "Lỗi", undone: "Đã hoàn tác" },
    undo: "Hoàn tác lần này",
    undoing: "Đang hoàn tác…",
    undone: "Đã hoàn tác",
    undoneNote: "Đã đảo các bước thành công của lần này. Công cụ đã cài vẫn còn trên máy.",
    failedCount: (n) => `${n} dòng lỗi, các dòng khác vẫn chạy.`,
  },
  en: {
    title: "Optimize this machine",
    lead: "Review every change first. Nothing is written yet: only the rows you picked run when you apply, and the whole run can be undone with one button.",
    loading: "Building the list of changes…",
    empty: "This machine is already optimized, nothing to change.",
    groups: { cli: "CLI configuration", tools: "Tools", context: "Context", score: "Score" },
    selectStep: (title) => `Select: ${title}`,
    needsConfirm: "Needs your explicit pick: this row changes the model or uses the aggressive level.",
    aggressiveHint: "Aggressive level: Claude uses Sonnet for subagents, quality may be lower.",
    notUndoable: "Cannot be undone: installed tools are not removed.",
    reasonLabel: "Reason",
    noValue: "(none)",
    removed: "(removed)",
    selected: (n, total) => `${n} of ${total} rows selected`,
    apply: (n) => `Apply ${n} row${n === 1 ? "" : "s"}`,
    applying: "Applying…",
    cancel: "Cancel",
    close: "Close",
    retry: "Try again",
    locked: "Another window is optimizing. Wait for it to finish, then try again.",
    resultTitle: "Result",
    resultLead: "Result of each row and the score before and after optimizing.",
    scoreBefore: "Score before",
    scoreAfter: "Score after",
    noScore: "—",
    status: { planned: "Not run", skipped: "Skipped", ok: "Done", failed: "Failed", undone: "Undone" },
    undo: "Undo this run",
    undoing: "Undoing…",
    undone: "Undone",
    undoneNote: "The successful steps of this run were reversed. Installed tools stay on the machine.",
    failedCount: (n) => `${n} row${n === 1 ? "" : "s"} failed, the others still ran.`,
  },
};

const GROUP_ORDER: readonly StepGroup[] = ["cli", "tools", "context", "score"];

type Phase = "loading" | "ready" | "applying" | "done" | "undoing";
type Action = "preview" | "apply" | "undo";

/** Rust/sidecar báo khoá bận bằng message tiếng Việt (code `OPTIMIZE_LOCKED` bị bỏ khi qua `invoke`). */
const isLocked = (message: string) => /ở cửa sổ khác|OPTIMIZE_LOCKED/i.test(message);

const isAggressive = (step: PlanStep) => step.level === "aggressive";

interface Failure {
  action: Action;
  message: string;
  locked: boolean;
}

function fail(action: Action, e: unknown): Failure {
  const message = errorText(e);
  return { action, message, locked: isLocked(message) };
}

/**
 * Hộp "Tối ưu" của màn Token (specs/029 US2): xem trước kế hoạch của sidecar, chọn từng dòng, áp dụng một lần, rồi
 * hiện điểm trước/sau và nút hoàn tác. Chưa bấm áp dụng thì không có gì ghi xuống máy.
 */
export function OptimizePreviewDialog({
  open,
  onOpenChange,
  policy,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Chính sách dự án đưa cho bản xem trước (T018). */
  policy?: OptimizePolicies | null | undefined;
  /** Gọi sau khi áp dụng hay hoàn tác xong để thẻ điểm đọc lại số. */
  onDone?: (() => void) | undefined;
}) {
  const t = useT(text);
  const lang = useLang();
  const [phase, setPhase] = useState<Phase>("loading");
  const [plan, setPlan] = useState<OptimizePlan | null>(null);
  // Chọn theo vị trí dòng: nhiều dòng cùng `id` và `target` (vd. đổi mức rồi bật lại) vẫn phân biệt được.
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [run, setRun] = useState<OptimizeRun | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const latest = useRef(0);
  // Giữ chính sách ở ref: cha truyền object mới mỗi lần vẽ thì không được dựng lại kế hoạch và mất lựa chọn.
  const policyRef = useRef(policy);
  policyRef.current = policy;

  const preview = useCallback(async () => {
    const id = ++latest.current;
    setPhase("loading");
    setFailure(null);
    try {
      const next = await optimizeAllPreview(policyRef.current);
      if (id !== latest.current) return;
      setPlan(next);
      // Mặc định do sidecar đặt: dòng aggressive và đổi mô hình không chọn sẵn.
      setPicked(new Set(next.steps.flatMap((s, i) => (s.selected ? [i] : []))));
      setPhase("ready");
    } catch (e) {
      if (id !== latest.current) return;
      setPlan(null);
      setFailure(fail("preview", e));
      setPhase("ready");
    }
  }, []);

  // Mở hộp là dựng kế hoạch mới (kế hoạch cũ có thể đã lỗi thời); đóng hộp thì bỏ hết.
  useEffect(() => {
    if (!open) {
      latest.current++;
      setPhase("loading");
      setPlan(null);
      setPicked(new Set());
      setRun(null);
      setFailure(null);
      return;
    }
    void preview();
  }, [open, preview]);

  const apply = async () => {
    if (!plan) return;
    setPhase("applying");
    setFailure(null);
    try {
      const result = await optimizeAllApply(withSelection(plan, (_, i) => picked.has(i)));
      setRun(result);
      setPhase("done");
      onDone?.();
    } catch (e) {
      // Khoá bận hay lỗi khác đều giữ kế hoạch và lựa chọn để người dùng thử lại, không phải xem trước lại.
      setFailure(fail("apply", e));
      setPhase("ready");
    }
  };

  const undo = async () => {
    if (!run) return;
    setPhase("undoing");
    setFailure(null);
    try {
      setRun(await optimizeAllUndo(run.id));
      onDone?.();
    } catch (e) {
      setFailure(fail("undo", e));
    }
    setPhase("done");
  };

  const retry = () => {
    if (failure?.action === "apply") void apply();
    else if (failure?.action === "undo") void undo();
    else void preview();
  };

  const toggle = (index: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(index)) next.add(index);
      return next;
    });

  const busy = phase === "loading" || phase === "applying" || phase === "undoing";
  const fmt = (n: number | null) => (n === null ? t.noScore : formatScore(n, lang));
  const undoable = run !== null && run.undoneAt === null && run.steps.some((s) => s.status === "ok" && s.undoable);
  const failed = run?.steps.filter((s) => s.status === "failed").length ?? 0;

  return (
    <Dialog open={open} onOpenChange={(next) => (next || !busy) && onOpenChange(next)}>
      <DialogContent className="max-h-[85vh] gap-3.5 overflow-y-auto p-5 sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle className="text-[17px] font-semibold">{run ? t.resultTitle : t.title}</DialogTitle>
          <DialogDescription className="text-sm">{run ? t.resultLead : t.lead}</DialogDescription>
        </DialogHeader>

        {failure &&
          (failure.locked ? <Alert>{t.locked}</Alert> : <Alert variant="destructive">{failure.message}</Alert>)}
        {phase === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">
            {t.loading}
          </p>
        )}

        {plan && !run && phase !== "loading" && plan.steps.length === 0 && (
          <p className="text-sm text-muted-foreground">{t.empty}</p>
        )}
        {plan &&
          !run &&
          phase !== "loading" &&
          GROUP_ORDER.map((group) => {
            const rows = plan.steps.flatMap((step, index) => (step.group === group ? [{ step, index }] : []));
            if (rows.length === 0) return null;
            return (
              <section key={group} aria-label={t.groups[group]} className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold">{t.groups[group]}</h3>
                <ul className="flex flex-col divide-y rounded-md border">
                  {rows.map(({ step, index }) => (
                    <li key={`${step.id}:${step.target}:${index}`} className="flex flex-col gap-1.5 px-3 py-2">
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="mt-1"
                          aria-label={t.selectStep(step.title)}
                          checked={picked.has(index)}
                          disabled={busy}
                          onChange={() => toggle(index)}
                        />
                        <span className="min-w-0 flex-1 font-medium">{step.title}</span>
                      </label>
                      <StepDetail step={step} t={t} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

        {run && (
          <>
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <p className="flex items-baseline gap-1.5 text-sm">
                <span className="text-muted-foreground">{t.scoreBefore}</span>
                <span className="font-mono text-lg font-semibold">{fmt(run.scoreBefore)}</span>
              </p>
              <span aria-hidden="true" className="text-muted-foreground">
                →
              </span>
              <p className="flex items-baseline gap-1.5 text-sm">
                <span className="text-muted-foreground">{t.scoreAfter}</span>
                <span className="font-mono text-lg font-semibold">{fmt(run.scoreAfter)}</span>
              </p>
              {run.undoneAt !== null && <Pill tone="neutral">{t.undone}</Pill>}
            </div>
            {failed > 0 && run.undoneAt === null && <p className="text-sm text-destructive">{t.failedCount(failed)}</p>}
            {run.undoneAt !== null && <p className="text-sm text-muted-foreground">{t.undoneNote}</p>}
            <ul aria-label={t.resultTitle} className="flex flex-col divide-y rounded-md border">
              {run.steps.map((step, index) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: nhật ký chỉ đọc, thứ tự cố định
                  key={`${step.id}:${step.target}:${index}`}
                  className="flex flex-col gap-1 px-3 py-2"
                >
                  <div className="flex items-start gap-2 text-sm">
                    <StatusIcon status={step.status} />
                    <span className="min-w-0 flex-1">{step.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{t.status[step.status]}</span>
                  </div>
                  <p
                    className={
                      step.status === "failed" ? "pl-6 text-xs text-destructive" : "pl-6 text-xs text-muted-foreground"
                    }
                  >
                    {step.status === "failed" && step.error ? step.error : step.reason}
                  </p>
                  {!step.undoable && step.status === "ok" && (
                    <p className="pl-6 text-xs text-muted-foreground">{t.notUndoable}</p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {plan && !run && phase !== "loading" && plan.steps.length > 0 && (
            <p className="mr-auto text-xs text-muted-foreground">{t.selected(picked.size, plan.steps.length)}</p>
          )}
          {failure && (
            <Button variant="outline" onClick={retry} disabled={busy}>
              {t.retry}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {run ? t.close : t.cancel}
          </Button>
          {undoable && (
            <Button variant="outline" onClick={() => void undo()} disabled={busy}>
              {phase === "undoing" ? t.undoing : t.undo}
            </Button>
          )}
          {plan && !run && plan.steps.length > 0 && (
            <Button onClick={() => void apply()} disabled={busy || picked.size === 0}>
              {phase === "applying" ? t.applying : t.apply(picked.size)}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StepDetail({ step, t }: { step: PlanStep; t: (typeof text)["vi"] }) {
  return (
    <div className="flex flex-col gap-1 pl-6">
      {step.changes.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {step.changes.map((c, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: kế hoạch chỉ đọc, thứ tự cố định
              key={`${c.file}:${c.key}:${i}`}
              className="break-all font-mono text-xs text-muted-foreground"
            >
              {changeLine(c, t)}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {t.reasonLabel}: {step.reason}
      </p>
      {(step.requiresConfirm || isAggressive(step)) && (
        <p role="note" className="text-xs text-warning">
          {isAggressive(step) ? t.aggressiveHint : t.needsConfirm}
        </p>
      )}
      {!step.undoable && <p className="text-xs text-muted-foreground">{t.notUndoable}</p>}
    </div>
  );
}

function changeLine(c: PlanChange, t: (typeof text)["vi"]) {
  return `${c.file} · ${c.key}: ${c.before ?? t.noValue} → ${c.after ?? t.removed}`;
}

function StatusIcon({ status }: { status: RunStep["status"] }) {
  if (status === "ok") return <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />;
  if (status === "failed") return <XIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />;
  return <MinusIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
}
