import type { SdlcItemPhase } from "@xdev-hive/contracts";
import { cn } from "cn";
import { Check, Circle, CircleDot, SkipForward } from "lucide-react";
import { useText } from "./env.tsx";

/** Giai đoạn đang làm: giai đoạn đầu chưa xong; null khi mọi giai đoạn đã duyệt hoặc bỏ qua. */
export function currentPhase(phases: SdlcItemPhase[]): SdlcItemPhase | null {
  return phases.find((p) => p.status !== "approved" && p.status !== "skipped") ?? null;
}

/** Thanh giai đoạn của hạng mục: tên theo chế độ, loại chuẩn ở dòng phụ để đối chiếu với cột của bảng. */
export function PhaseStepper({ phases }: { phases: SdlcItemPhase[] }) {
  const t = useText();
  const current = currentPhase(phases);
  return (
    <ol aria-label={t.detail.stepperAria} className="flex gap-1 overflow-x-auto pb-1 max-sm:flex-col">
      {phases.map((phase) => {
        const isCurrent = phase.id === current?.id;
        const Icon =
          phase.status === "approved"
            ? Check
            : phase.status === "skipped"
              ? SkipForward
              : isCurrent
                ? CircleDot
                : Circle;
        return (
          <li
            key={phase.id}
            aria-current={isCurrent ? "step" : undefined}
            className={cn(
              "flex min-w-36 flex-1 items-start gap-2 rounded-lg border px-2.5 py-2 text-sm",
              isCurrent ? "border-ring bg-accent text-accent-foreground" : "border-border bg-card",
              phase.status === "skipped" && "opacity-60",
            )}
          >
            <Icon
              aria-hidden="true"
              className={cn("mt-0.5 size-4 shrink-0", phase.status === "approved" && "text-success")}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{phase.name}</span>
              <span className="text-xs text-muted-foreground">
                {t.phaseKind[phase.kind]} · {t.phaseStatus[phase.status]}
              </span>
              {phase.requiredTotal > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t.detail.docsApproved(phase.requiredApproved, phase.requiredTotal)}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
