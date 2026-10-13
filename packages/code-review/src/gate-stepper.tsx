import type { CodeGateRun } from "@xdev-hive/contracts";
import { cn } from "cn";
import type { CodeReviewText } from "./text.ts";

type StepState = "done" | "current" | "failed" | "skipped" | "todo";

const STEP_STYLE: Record<StepState, string> = {
  done: "bg-success-soft text-success",
  current: "bg-warning-soft font-semibold text-warning",
  failed: "bg-destructive-soft font-semibold text-destructive",
  skipped: "border border-dashed border-input text-muted-foreground line-through",
  todo: "border border-border bg-card text-muted-foreground",
};
const STEP_MARK: Record<StepState, string> = { done: "✓", current: "●", failed: "✗", skipped: "↷", todo: "○" };

/** Checkpoint chưa tới lượt cũng là `waiting` (với `startedAt` null) nên chỉ checkpoint đang chờ của phiên mới là "current". */
export function stepOf(gate: CodeGateRun, currentGateId: string | null): StepState {
  if (gate.status === "passed") return "done";
  if (gate.status === "failed") return "failed";
  if (gate.status === "skipped") return "skipped";
  return gate.gateId === currentGateId ? "current" : "todo";
}

/** Các checkpoint của quy trình theo thứ tự chạy, đánh dấu bước đang chờ. */
export function GateStepper({
  gates,
  currentGateId,
  t,
}: {
  gates: CodeGateRun[];
  currentGateId: string | null;
  t: CodeReviewText;
}) {
  return (
    <ol aria-label={t.stepper} className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0 text-[0.8125rem]">
      {gates.map((g, i) => {
        const state = stepOf(g, currentGateId);
        return (
          <li key={g.gateId} className="inline-flex items-center gap-1.5">
            <span
              aria-current={state === "current" ? "step" : undefined}
              className={cn("inline-flex h-6 items-center gap-1 rounded-full px-2.5", STEP_STYLE[state])}
            >
              <span aria-hidden="true">{STEP_MARK[state]}</span>
              {g.name}
              <span className="sr-only">({t.stepState[state]})</span>
            </span>
            {i < gates.length - 1 && (
              <span aria-hidden="true" className="text-muted-foreground">
                →
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
