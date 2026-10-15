import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SdlcItemDetail, SdlcStepRun } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useState } from "react";
import { useSdlcEnv, useText } from "./env.tsx";
import { formatWhen, type Tone } from "./format.ts";
import { currentPhase } from "./phase-stepper.tsx";

const stepTone: Record<SdlcStepRun["status"], Tone> = {
  queued: "warn",
  running: "sel",
  succeeded: "ok",
  failed: "bad",
  cancelled: "neutral",
};

/** Lần chạy mới nhất của mỗi bước (vòng lớn nhất, rồi tạo sau cùng). */
export function latestRuns(steps: SdlcStepRun[]): Map<string, SdlcStepRun> {
  const latest = new Map<string, SdlcStepRun>();
  for (const s of steps) {
    const key = `${s.phaseId}/${s.stepId}`;
    const prev = latest.get(key);
    if (!prev || s.round > prev.round || (s.round === prev.round && s.createdAt > prev.createdAt)) latest.set(key, s);
  }
  return latest;
}

/**
 * Bước agent của giai đoạn hiện tại (mỗi bước là một run `sdlc`): trạng thái, lý do chờ máy, và chạy lại kèm hướng dẫn.
 * Bước đang chạy không cho chạy chồng để không có hai bản nháp tranh nhau.
 */
export function StepsPanel({ item }: { item: SdlcItemDetail }) {
  const { api, lang, link, errorMessage } = useSdlcEnv();
  const t = useText().detail;
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const step = useMutation(
    api.sdlc.items.step.mutationOptions({
      onSuccess: () => {
        setOpen(null);
        setInstructions("");
        void queryClient.invalidateQueries({ queryKey: api.sdlc.key() });
      },
    }),
  );
  const phase = currentPhase(item.phases);
  const defs = item.mode.phases.find((p) => p.id === phase?.id)?.steps ?? [];
  const latest = latestRuns(item.steps);
  const busy = item.status !== "active";

  if (!phase || !defs.length) return <p className="text-sm text-muted-foreground">{t.noSteps}</p>;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {defs.map((def) => {
          const run = latest.get(`${phase.id}/${def.id}`);
          const running = run?.status === "queued" || run?.status === "running";
          const key = def.id;
          return (
            <li key={key} className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t.stepAction[def.action]}</span>
                <span className="font-mono text-xs text-muted-foreground">{def.id}</span>
                {run ? (
                  <Pill tone={stepTone[run.status]} small dot>
                    {t.stepStatus[run.status]}
                  </Pill>
                ) : (
                  <Pill small>{t.stepNever}</Pill>
                )}
                {run && <span className="text-xs text-muted-foreground">{t.round(run.round)}</span>}
                {run?.run &&
                  link({ to: { kind: "run", id: run.run.id }, className: "text-xs underline", children: t.openRun })}
                {run?.finishedAt && (
                  <span className="text-xs text-muted-foreground">{formatWhen(run.finishedAt, lang)}</span>
                )}
              </div>
              {run?.waitingReason && <p className="text-xs text-warning">{run.waitingReason}</p>}
              {run?.error && <p className="text-xs text-destructive">{run.error}</p>}
              {item.can.write && open !== key && (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={running || busy}
                  onClick={() => setOpen(key)}
                >
                  {run ? t.rerunStep : t.runStep}
                </Button>
              )}
              {open === key && (
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    step.mutate({
                      id: item.id,
                      phaseId: phase.id,
                      stepId: def.id,
                      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
                    });
                  }}
                >
                  <Textarea
                    rows={2}
                    aria-label={t.instructions}
                    placeholder={t.instructionsHint}
                    maxLength={4000}
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                  />
                  {step.isError && <p className="text-xs text-destructive">{errorMessage(step.error)}</p>}
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setOpen(null)}>
                      {t.cancel}
                    </Button>
                    <Button type="submit" size="sm" disabled={step.isPending}>
                      {run ? t.rerunStep : t.runStep}
                    </Button>
                  </div>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
